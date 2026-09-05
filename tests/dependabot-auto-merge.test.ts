import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorizeDependabotUpdate } from "../.github/scripts/dependabot-auto-merge.mjs";

const dependabotSha = "1".repeat(40);
const firstBaseSha = "2".repeat(40);
const firstUpdateSha = "3".repeat(40);
const currentBaseSha = "4".repeat(40);
const headSha = "5".repeat(40);

function pullRequestEvent(action = "synchronize") {
  return {
    action,
    repository: {
      default_branch: "main",
      fork: false,
      full_name: "Snuffy2/ytptube-mcp",
    },
    pull_request: {
      base: { ref: "main", sha: currentBaseSha },
      head: {
        ref: "dependabot/npm_and_yarn/qs-6.16.0",
        repo: { full_name: "Snuffy2/ytptube-mcp" },
        sha: headSha,
      },
      user: { login: "dependabot[bot]" },
    },
  };
}

function dependabotCommit(sha = headSha) {
  return {
    author: { login: "dependabot[bot]" },
    commit: { verification: { verified: true } },
    parents: [],
    sha,
  };
}

function updateCommit(sha: string, previous: string, base: string) {
  return {
    author: { login: "Snuffy2" },
    commit: { verification: { verified: true } },
    committer: { login: "web-flow" },
    parents: [{ sha: previous }, { sha: base }],
    sha,
  };
}

describe("Dependabot auto-merge authorization", () => {
  it("checks out the trusted helper before executing it", () => {
    const workflow = readFileSync(
      new URL(
        "../.github/workflows/dependabot-auto-merge.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const authorizationJob = workflow.slice(
      workflow.indexOf("authorize-dependency-update:"),
      workflow.indexOf("enable-auto-merge:"),
    );
    const checkout = authorizationJob.indexOf("uses: actions/checkout@v7");
    const helper = authorizationJob.indexOf(
      "node .github/scripts/dependabot-auto-merge.mjs",
    );

    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(checkout).toBeLessThan(helper);
    expect(authorizationJob.slice(checkout, helper)).toContain(
      "persist-credentials: false",
    );
    expect(authorizationJob.slice(checkout, helper)).toContain(
      "ref: ${{ github.event.pull_request.base.sha }}",
    );
  });

  it("authorizes an update created by Dependabot", () => {
    const event = pullRequestEvent("opened");
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [dependabotCommit()],
        event,
      }),
    ).toBe("npm");
  });

  it("authorizes repeated GitHub Update branch merges", () => {
    expect(
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
          updateCommit(headSha, firstUpdateSha, currentBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toBe("npm");
  });

  it("keeps the GitHub Actions file allowlist", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref =
      "dependabot/github_actions/actions/checkout-7";
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: [".github/workflows/ci.yml"],
        commits: [dependabotCommit()],
        event,
      }),
    ).toBe("github-actions");
  });

  it("rejects a direct maintainer edit before an Update branch merge", () => {
    const maintainerSha = "6".repeat(40);
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json"],
        commits: [
          dependabotCommit(dependabotSha),
          {
            author: { login: "Snuffy2" },
            parents: [{ sha: dependabotSha }],
            sha: maintainerSha,
          },
          updateCommit(headSha, maintainerSha, currentBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toThrow("non-Dependabot edit");
  });

  it("rejects a merge that is not from the current base branch", () => {
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(headSha, dependabotSha, firstBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toThrow("current base branch");
  });

  it("rejects an unsigned lookalike Update branch history", () => {
    const commit = updateCommit(headSha, dependabotSha, currentBaseSha);
    commit.commit.verification.verified = false;
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package-lock.json"],
        commits: [dependabotCommit(dependabotSha), commit],
        event: pullRequestEvent(),
      }),
    ).toThrow("non-Dependabot edit");
  });

  it("rejects files outside the ecosystem allowlist", () => {
    expect(() =>
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["src/index.ts"],
        commits: [dependabotCommit()],
        event: pullRequestEvent("opened"),
      }),
    ).toThrow("changed files were");
  });
});
