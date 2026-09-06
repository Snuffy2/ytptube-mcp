import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeDependabotUpdate } from "../.github/scripts/dependabot-auto-merge.mjs";

const dependabotSha = "1".repeat(40);
const firstBaseSha = "2".repeat(40);
const firstUpdateSha = "3".repeat(40);
const currentBaseSha = "4".repeat(40);
const headSha = "5".repeat(40);
const temporaryDirectories: string[] = [];

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

function trustedBaseWith(path: string) {
  const directory = mkdtempSync(join(tmpdir(), "dependabot-authorizer-"));
  temporaryDirectories.push(directory);
  const file = join(directory, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "fixture\n");
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("Dependabot auto-merge authorization", () => {
  it("authorizes a verified direct uv lockfile update", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref = "dependabot/uv/pytest-9.0.0";
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["uv.lock"],
        commits: [dependabotCommit()],
        event,
      }),
    ).toBe("uv");
  });

  it("rejects uv updates that change another file", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref = "dependabot/uv/pytest-9.0.0";
    expect(() =>
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["pyproject.toml", "uv.lock"],
        commits: [dependabotCommit()],
        event,
      }),
    ).toThrow();
  });

  it("authorizes a verified direct npm update with its lockfile", () => {
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [dependabotCommit()],
        event: pullRequestEvent("opened"),
      }),
    ).toBe("npm");
  });

  it("requires npm updates to include the manifest and lockfile together", () => {
    expect(() =>
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["package-lock.json"],
        commits: [dependabotCommit()],
        event: pullRequestEvent("opened"),
      }),
    ).toThrow();
  });

  it("authorizes a verified GitHub Update branch chain", () => {
    expect(
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
          updateCommit(headSha, firstUpdateSha, currentBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toBe("npm");
  });

  it("rejects an unverified direct Dependabot history", () => {
    const commit = dependabotCommit();
    commit.commit.verification.verified = false;
    expect(() =>
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [commit],
        event: pullRequestEvent("opened"),
      }),
    ).toThrow();
  });

  it("rejects a direct maintainer edit before an Update branch merge", () => {
    const maintainerSha = "6".repeat(40);
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json", "package-lock.json"],
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
    ).toThrow();
  });

  it("rejects an Update branch merge that does not use the current base", () => {
    expect(() =>
      authorizeDependabotUpdate({
        actor: "Snuffy2",
        changedFiles: ["package.json", "package-lock.json"],
        commits: [
          dependabotCommit(dependabotSha),
          updateCommit(headSha, dependabotSha, firstBaseSha),
        ],
        event: pullRequestEvent(),
      }),
    ).toThrow();
  });

  it("allows existing trusted top-level GitHub Actions files", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref =
      "dependabot/github_actions/actions/checkout-7";
    expect(
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: [".github/workflows/ci.yml"],
        commits: [dependabotCommit()],
        event,
        trustedBaseDirectory: trustedBaseWith(".github/workflows/ci.yml"),
      }),
    ).toBe("github-actions");
  });

  it("rejects action manifests absent from the trusted base", () => {
    const event = pullRequestEvent("opened");
    event.pull_request.head.ref = "dependabot/github_actions/example/action";
    expect(() =>
      authorizeDependabotUpdate({
        actor: "dependabot[bot]",
        changedFiles: ["action.yml"],
        commits: [dependabotCommit()],
        event,
        trustedBaseDirectory: trustedBaseWith(".github/workflows/ci.yml"),
      }),
    ).toThrow();
  });
});
