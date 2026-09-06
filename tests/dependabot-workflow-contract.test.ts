import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as prettier from "prettier";
import { describe, expect, it } from "vitest";

type WorkflowValue =
  string | WorkflowValue[] | { [key: string]: WorkflowValue } | null;

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
  if (node.type === "mapping") {
    return Object.fromEntries(
      (node.children ?? []).map((item) => {
        const [key, value] = item.children ?? [];
        return [yamlValue(key).toString(), yamlValue(value)];
      }),
    );
  }
  if (node.type === "sequence")
    return (node.children ?? []).map((item) => yamlValue(item));
  for (const child of node.children ?? []) {
    const value = yamlValue(child);
    if (value !== null) return value;
  }
  return null;
}

async function workflow(path: string) {
  const source = readFileSync(resolve(path), "utf8");
  const parsed = await prettier.__debug.parse(source, { parser: "yaml" });
  return yamlValue(parsed.ast) as {
    jobs: Record<string, Record<string, WorkflowValue>>;
  };
}

function steps(job: Record<string, WorkflowValue>) {
  return job.steps as Record<string, string>[];
}

function authorizationStep(job: Record<string, WorkflowValue>) {
  const step = steps(job).find((candidate) =>
    candidate.run?.includes("dependabot-auto-merge.mjs"),
  );
  expect(step).toBeDefined();
  return step!;
}

function trustedCheckoutBefore(job: Record<string, WorkflowValue>) {
  const jobSteps = steps(job);
  const authorizationIndex = jobSteps.indexOf(authorizationStep(job));
  const checkout = jobSteps
    .slice(0, authorizationIndex)
    .find(
      (candidate) =>
        candidate.uses?.startsWith("actions/checkout@") &&
        (candidate.with as Record<string, string>)?.ref ===
          "${{ github.event.pull_request.base.sha }}",
    );
  expect(checkout).toBeDefined();
  expect(
    (checkout!.with as Record<string, string>)["persist-credentials"],
  ).toBe("false");
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

function assertsAuthoritativeDataflow(job: Record<string, WorkflowValue>) {
  const run = authorizationStep(job).run!;
  expect(run).toMatch(/pulls.*files/);
  expect(run).toMatch(/pulls.*commits/);
  expect(run).toContain("compare/");
  expect(run).toContain("dependabot-auto-merge.mjs");
}

describe("Dependabot workflow trust contracts", () => {
  it("uses trusted read-only authorization with PR files, commits, and ancestry evidence", async () => {
    const autoMerge = await workflow(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    const ci = await workflow(".github/workflows/ci.yml");
    const authorization = autoMerge.jobs["authorize-dependency-update"];
    const node = ci.jobs.node;
    expect(authorization.permissions).toMatchObject({
      contents: "read",
      "pull-requests": "read",
    });
    expect(node.permissions).toMatchObject({
      contents: "read",
      "pull-requests": "read",
    });
    requiresEligibleDependabot(authorization.if);
    trustedCheckoutBefore(authorization);
    requiresEligibleDependabot(steps(node)[0].if);
    requiresEligibleDependabot(authorizationStep(node).if);
    trustedCheckoutBefore(node);
    assertsAuthoritativeDataflow(authorization);
    assertsAuthoritativeDataflow(node);
  });

  it("keeps write jobs dependent on successful authorization and checkout-free", async () => {
    const autoMerge = await workflow(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    const enable = autoMerge.jobs["enable-auto-merge"];
    expect(enable.needs).toBe("authorize-dependency-update");
    expect(enable.if).toBeUndefined();
    expect(enable.permissions).toMatchObject({
      contents: "write",
      "pull-requests": "write",
    });
    for (const job of Object.values(autoMerge.jobs)) {
      const permissions = job.permissions as Record<string, string> | undefined;
      if (
        permissions?.contents === "write" ||
        permissions?.["pull-requests"] === "write"
      )
        expect(
          steps(job).some((step) => step.uses?.startsWith("actions/checkout@")),
        ).toBe(false);
    }
  });

  it("uses cancellation-safe cleanup under the same eligibility guard", async () => {
    const autoMerge = await workflow(
      ".github/workflows/dependabot-auto-merge.yml",
    );
    const cleanup = autoMerge.jobs["disable-auto-merge"];
    expect(String(cleanup.if)).toContain("failure()");
    expect(String(cleanup.if)).toContain("!cancelled()");
    requiresEligibleDependabot(cleanup.if);
  });

  it("authorizes Dependabot PRs before CI checks out their head", async () => {
    const ci = await workflow(".github/workflows/ci.yml");
    const node = ci.jobs.node;
    expect(node.permissions).toMatchObject({
      contents: "read",
      "pull-requests": "read",
    });
    trustedCheckoutBefore(node);
    const jobSteps = steps(node);
    const authorizationIndex = jobSteps.indexOf(authorizationStep(node));
    const headCheckoutIndex = jobSteps.findIndex(
      (step) =>
        step.uses?.startsWith("actions/checkout@") &&
        !(step.with as Record<string, string>)?.ref,
    );
    expect(headCheckoutIndex).toBeGreaterThan(authorizationIndex);
  });
});
