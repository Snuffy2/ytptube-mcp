import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";

type WorkflowValue =
  string | WorkflowValue[] | { [key: string]: WorkflowValue } | null;
type Job = Record<string, WorkflowValue>;
type Step = Record<string, string | Record<string, string>>;

function yamlValue(node: {
  children?: { children?: unknown[]; type?: string; value?: string }[];
  type?: string;
  value?: string;
}): WorkflowValue {
  if (
    [
      "plain",
      "quoteDouble",
      "quoteSingle",
      "blockFolded",
      "blockLiteral",
    ].includes(node.type ?? "")
  )
    return node.value ?? "";
  if (node.type === "mapping")
    return Object.fromEntries(
      (node.children ?? []).map((item) => {
        const [key, value] = item.children ?? [];
        return [yamlValue(key).toString(), yamlValue(value)];
      }),
    );
  if (node.type === "sequence")
    return (node.children ?? []).map((item) => yamlValue(item));
  for (const child of node.children ?? []) {
    const value = yamlValue(child);
    if (value !== null) return value;
  }
  return null;
}

async function workflow(path: string) {
  const parsed = await prettier.__debug.parse(
    readFileSync(resolve(path), "utf8"),
    {
      parser: "yaml",
    },
  );
  return yamlValue(parsed.ast) as { jobs: Record<string, Job> };
}

function steps(job: Job) {
  return job.steps as Step[];
}

function action(step: Step) {
  return step.uses?.toString().split("@")[0];
}

function isCheckout(step: Step) {
  return action(step) === "actions/checkout";
}

function authorizationStep(job: Job) {
  const step = steps(job).find((candidate) =>
    candidate.run?.toString().includes("dependabot-auto-merge.mjs"),
  );
  expect(step).toBeDefined();
  return step!;
}

function authorizationJob(workflow: { jobs: Record<string, Job> }) {
  const entry = Object.entries(workflow.jobs).find(([, job]) =>
    steps(job).some((step) =>
      step.run?.toString().includes("dependabot-auto-merge.mjs"),
    ),
  );
  expect(entry).toBeDefined();
  return entry!;
}

function trustedCheckoutBefore(job: Job) {
  const jobSteps = steps(job);
  const authorizationIndex = jobSteps.indexOf(authorizationStep(job));
  const checkout = jobSteps.slice(0, authorizationIndex).find((step) => {
    const inputs = step.with as Record<string, string>;
    return (
      isCheckout(step) &&
      inputs?.ref === "${{ github.event.pull_request.base.sha }}"
    );
  });
  expect(checkout).toBeDefined();
  expect(
    (checkout!.with as Record<string, string>)["persist-credentials"],
  ).toBe("false");
  return checkout!;
}

function requiresEligibleDependabot(condition: WorkflowValue) {
  const value = String(condition);
  for (const term of [
    "repository.fork == false",
    "pull_request.user.login == 'dependabot[bot]'",
    "pull_request.head.repo.full_name == github.repository",
    "pull_request.base.ref == github.event.repository.default_branch",
  ])
    expect(value).toContain(term);
}

function requiresDependabotAuthorization(
  condition: WorkflowValue,
  requiresPullRequestEvent = true,
) {
  const value = String(condition);
  if (requiresPullRequestEvent)
    expect(value).toContain("event_name == 'pull_request'");
  expect(value).toContain("pull_request.user.login == 'dependabot[bot]'");
  expect(value).not.toContain("repository.fork");
  expect(value).not.toContain("pull_request.head.repo.full_name");
  expect(value).not.toContain("pull_request.base.ref");
}

function assertsAuthoritativeDataflow(job: Job) {
  const run = authorizationStep(job).run!.toString();
  expect(run).toMatch(/pulls.*files/);
  expect(run).toMatch(/pulls.*commits/);
  expect(run).toContain("compare/");
  expect(run).toContain("dependabot-auto-merge.mjs");
}

function permissions(job: Job) {
  return job.permissions as Record<string, string> | undefined;
}

function isWriteJob(job: Job) {
  const value = permissions(job);
  return value?.contents === "write" || value?.["pull-requests"] === "write";
}

describe("Dependabot workflow trust contracts", () => {
  it("uses trusted read-only authorization with authoritative PR evidence", async () => {
    const autoMerge = await workflow(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    const ci = await workflow(".github/workflows/ci.yml");
    const [, dedicatedAuthorization] = authorizationJob(autoMerge);
    const [, ciAuthorization] = authorizationJob(ci);
    for (const job of [dedicatedAuthorization, ciAuthorization]) {
      expect(permissions(job)).toMatchObject({
        contents: "read",
        "pull-requests": "read",
      });
      trustedCheckoutBefore(job);
      assertsAuthoritativeDataflow(job);
    }
    requiresDependabotAuthorization(dedicatedAuthorization.if, false);
    requiresDependabotAuthorization(authorizationStep(ciAuthorization).if);
  });

  it("keeps write capabilities dependent on successful authorization and checkout-free", async () => {
    const autoMerge = await workflow(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    const [authorizationName] = authorizationJob(autoMerge);
    const writeJobs = Object.values(autoMerge.jobs).filter(isWriteJob);
    const enable = writeJobs.find(
      (job) => job.needs === authorizationName && job.if === undefined,
    );
    expect(enable).toBeDefined();
    for (const job of writeJobs)
      expect(steps(job).some(isCheckout)).toBe(false);
  });

  it("uses cancellation-safe cleanup under the same eligibility guard", async () => {
    const autoMerge = await workflow(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    const cleanup = Object.values(autoMerge.jobs).find(
      (job) =>
        isWriteJob(job) &&
        String(job.if).includes("failure()") &&
        String(job.if).includes("!cancelled()"),
    );
    expect(cleanup).toBeDefined();
    requiresEligibleDependabot(cleanup!.if);
  });

  it("blocks every Dependabot-authored PR from head checkout unless authorization succeeds", async () => {
    const ci = await workflow(".github/workflows/ci.yml");
    const [, job] = authorizationJob(ci);
    const jobSteps = steps(job);
    const authorization = authorizationStep(job);
    const authorizationIndex = jobSteps.indexOf(authorization);
    const headCheckoutIndex = jobSteps.findIndex(
      (step) => isCheckout(step) && !(step.with as Record<string, string>)?.ref,
    );
    expect(headCheckoutIndex).toBeGreaterThan(authorizationIndex);
    expect(jobSteps[headCheckoutIndex].if).toBeUndefined();
    requiresDependabotAuthorization(trustedCheckoutBefore(job).if);
    requiresDependabotAuthorization(authorization.if);
  });
});
