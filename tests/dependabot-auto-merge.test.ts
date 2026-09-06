import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizeDependabotUpdate } from "../.github/scripts/dependabot-auto-merge.mjs";

const dependabotSha = "1".repeat(40);
const firstBaseSha = "2".repeat(40);
const firstUpdateSha = "3".repeat(40);
const currentBaseSha = "4".repeat(40);
const headSha = "5".repeat(40);
const temporaryDirectories: string[] = [];

function pullRequestEvent(headRef: string, action = "reopened") {
  return {
    action,
    repository: {
      default_branch: "main",
      fork: false,
      full_name: "example/repository",
    },
    pull_request: {
      base: { ref: "main", sha: currentBaseSha },
      head: {
        ref: headRef,
        repo: { full_name: "example/repository" },
        sha: headSha,
      },
      user: { login: "dependabot[bot]" },
    },
  };
}

function dependabotCommit(sha = headSha, verified = true) {
  return {
    author: { login: "dependabot[bot]" },
    commit: { verification: { verified } },
    parents: [],
    sha,
  };
}

function updateCommit(sha: string, previous: string, base: string) {
  return {
    author: { login: "maintainer" },
    commit: { verification: { verified: true } },
    committer: { login: "web-flow" },
    parents: [{ sha: previous }, { sha: base }],
    sha,
  };
}

function ancestryProof(parentSha: string, status = "ahead") {
  return {
    ahead_by: status === "identical" ? 0 : 1,
    base_commit: parentSha,
    base_sha: currentBaseSha,
    behind_by: 0,
    head_commit: currentBaseSha,
    merge_base_commit: parentSha,
    parent_sha: parentSha,
    status,
  };
}

function updateChain() {
  return [
    dependabotCommit(dependabotSha),
    updateCommit(firstUpdateSha, dependabotSha, firstBaseSha),
    updateCommit(headSha, firstUpdateSha, currentBaseSha),
  ];
}

function updateChainProofs() {
  return [
    ancestryProof(firstBaseSha),
    ancestryProof(currentBaseSha, "identical"),
  ];
}

function trustedBaseWith(...paths: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "dependabot-authorizer-"));
  temporaryDirectories.push(directory);
  for (const path of paths) {
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  }
  return directory;
}

function authorize({
  actor = "dependabot[bot]",
  ancestryProofs = [],
  changedFiles = ["package-lock.json"],
  commits = [dependabotCommit()],
  event = pullRequestEvent("dependabot/npm_and_yarn/vitest-4.1.11"),
  trustedBaseDirectory = trustedBaseWith("package.json", "package-lock.json"),
}: {
  actor?: string;
  ancestryProofs?: object[];
  changedFiles?: string[];
  commits?: object[];
  event?: ReturnType<typeof pullRequestEvent>;
  trustedBaseDirectory?: string;
} = {}) {
  return authorizeDependabotUpdate({
    actor,
    ancestryProofs,
    changedFiles,
    commits,
    event,
    trustedBaseDirectory,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { force: true, recursive: true });
});

describe("Dependabot auto-merge authorization", () => {
  it("authorizes a reopened direct update from verified exact history", () => {
    expect(authorize()).toBe("npm");
  });

  it("authorizes a reopened GitHub Update branch chain", () => {
    expect(
      authorize({
        ancestryProofs: updateChainProofs(),
        commits: updateChain(),
      }),
    ).toBe("npm");
  });

  it("rejects a reopened chain containing a non-web-flow merge", () => {
    const commits = updateChain();
    commits[1].committer.login = "maintainer";
    expect(() =>
      authorize({ ancestryProofs: updateChainProofs(), commits }),
    ).toThrow();
  });

  it("does not use the triggering actor or action as authorization inputs", () => {
    for (const [actor, action] of [
      ["dependabot[bot]", "opened"],
      ["maintainer", "synchronize"],
      ["any-user", "reopened"],
    ])
      expect(
        authorize({
          actor,
          event: pullRequestEvent(
            "dependabot/npm_and_yarn/vitest-4.1.11",
            action,
          ),
        }),
      ).toBe("npm");
  });

  it("accepts a genuine older base ancestor for an intermediate merge", () => {
    expect(
      authorize({
        ancestryProofs: updateChainProofs(),
        commits: updateChain(),
      }),
    ).toBe("npm");
  });

  it("rejects absent, arbitrary, diverged, and mismatched ancestry evidence", () => {
    const invalidProofSets = [
      [],
      [{}, ancestryProof(currentBaseSha, "identical")],
      [ancestryProof(firstBaseSha), ancestryProof("9".repeat(40))],
      [
        ancestryProof(firstBaseSha, "diverged"),
        ancestryProof(currentBaseSha, "identical"),
      ],
      [
        { ...ancestryProof(firstBaseSha), head_commit: "8".repeat(40) },
        ancestryProof(currentBaseSha, "identical"),
      ],
    ];
    for (const ancestryProofs of invalidProofSets)
      expect(() =>
        authorize({ ancestryProofs, commits: updateChain() }),
      ).toThrow();
  });

  it("requires the latest merge parent and latest commit to equal the event state", () => {
    const staleParentChain = updateChain();
    staleParentChain[2] = updateCommit(headSha, firstUpdateSha, firstBaseSha);
    for (const commits of [staleParentChain, [dependabotCommit(dependabotSha)]])
      expect(() =>
        authorize({ ancestryProofs: updateChainProofs(), commits }),
      ).toThrow();
  });

  it("rejects unverified history, invalid provenance, and dependency-scope changes", () => {
    const untrustedEvent = pullRequestEvent(
      "dependabot/npm_and_yarn/vitest-4.1.11",
    );
    untrustedEvent.pull_request.head.repo.full_name = "fork/repository";
    for (const input of [
      { commits: [dependabotCommit(headSha, false)] },
      { event: untrustedEvent },
      { changedFiles: ["README.md"] },
    ])
      expect(() => authorize(input)).toThrow();
  });

  it("keeps ecosystem scope rooted in trusted base contents", () => {
    expect(
      authorize({
        changedFiles: ["uv.lock"],
        event: pullRequestEvent("dependabot/uv/pytest-9.0.0"),
        trustedBaseDirectory: trustedBaseWith("uv.lock"),
      }),
    ).toBe("uv");
    expect(() =>
      authorize({
        changedFiles: ["action.yml"],
        event: pullRequestEvent("dependabot/github_actions/example/action"),
        trustedBaseDirectory: trustedBaseWith(".github/workflows/ci.yml"),
      }),
    ).toThrow();
  });
});
