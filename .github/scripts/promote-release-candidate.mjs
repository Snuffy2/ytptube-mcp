/** Reconstruct and atomically promote a candidate verified by the current workflow run. */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  assertCandidatePaths,
  assertReleaseEvent,
  expectedMetadata,
  readCandidateArtifact,
} from "./release-candidate.mjs";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

function remoteRefs(branch, tag) {
  const output = git([
    "ls-remote",
    "--heads",
    "--tags",
    "origin",
    `refs/heads/${branch}`,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  return Object.fromEntries(
    output
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t").reverse()),
  );
}

function assertCandidateCommit(commit, sourceSha, expected) {
  if (
    git(["rev-list", "--parents", "-n1", commit])
      .split(" ")
      .slice(1)
      .join(" ") !== sourceSha
  )
    throw new Error(
      "Existing promotion does not descend directly from the release source.",
    );
  assertCandidatePaths(
    git(["diff-tree", "--no-commit-id", "--name-only", "-r", sourceSha, commit])
      .split("\n")
      .filter(Boolean),
  );
  for (const [path, content] of Object.entries(expected))
    if (
      git(["show", `${commit}:${path}`]) !==
      `${JSON.stringify(content, null, 2)}\n`.trimEnd()
    )
      throw new Error(
        "Existing promotion does not contain deterministic candidate metadata.",
      );
}

function expectedCandidateMetadata(tag) {
  return expectedMetadata(
    JSON.parse(readFileSync("package.json", "utf8")),
    JSON.parse(readFileSync("package-lock.json", "utf8")),
    tag,
  );
}

function assertAlreadyPromotedCandidate({
  refs,
  defaultBranch,
  tag,
  sourceSha,
  expected,
}) {
  const tagRef = `refs/tags/${tag}`;
  const candidateSha = refs[`refs/heads/${defaultBranch}`];
  const tagObject = refs[tagRef];
  const tagCommit = refs[`${tagRef}^{}`] ?? tagObject;
  if (!candidateSha || !tagObject || !tagCommit)
    throw new Error("Release branch or tag disappeared before promotion.");
  if (candidateSha !== tagCommit || tagObject !== candidateSha)
    throw new Error("Release branch or tag changed before promotion.");
  git(["fetch", "--no-tags", "origin", candidateSha]);
  assertCandidateCommit(candidateSha, sourceSha, {
    "package.json": expected.packageJson,
    "package-lock.json": expected.packageLock,
  });
  return candidateSha;
}

/** Bind a release run either to its source refs or to its exact prior promotion. */
export function verifyReleasePreflight({
  defaultBranch,
  prerelease,
  sourceSha,
  tag,
}) {
  if (git(["rev-parse", "HEAD"]) !== sourceSha)
    throw new Error("Checkout does not match the trusted release source.");
  const expected = expectedCandidateMetadata(tag);
  const refs = remoteRefs(defaultBranch, tag);
  const tagRef = `refs/tags/${tag}`;
  const tagCommit = refs[`${tagRef}^{}`] ?? refs[tagRef];
  if (
    refs[`refs/heads/${defaultBranch}`] === sourceSha &&
    tagCommit === sourceSha
  )
    return { status: "source" };
  if (prerelease)
    throw new Error(
      "Release branch or tag changed before prerelease publishing.",
    );
  return {
    status: "already-promoted",
    candidateSha: assertAlreadyPromotedCandidate({
      refs,
      defaultBranch,
      tag,
      sourceSha,
      expected,
    }),
  };
}

/** Require the default branch and both forms of the release tag to name one candidate commit. */
export function assertFinalRefs(refs, branch, tag, candidateSha) {
  const tagRef = `refs/tags/${tag}`;
  const tagCommit = refs[`${tagRef}^{}`] ?? refs[tagRef];
  if (
    refs[`refs/heads/${branch}`] !== candidateSha ||
    refs[tagRef] !== candidateSha ||
    tagCommit !== candidateSha
  )
    throw new Error(
      "Release branch or tag no longer names the promoted candidate.",
    );
}

/** Revalidate the promotion immediately before a separate privileged publish. */
export function verifyRemotePromotion({ defaultBranch, tag, candidateSha }) {
  if (!/^[0-9a-f]{40}$/i.test(candidateSha))
    throw new Error("Candidate SHA must be a full Git object ID.");
  assertFinalRefs(
    remoteRefs(defaultBranch, tag),
    defaultBranch,
    tag,
    candidateSha,
  );
}

/** Revalidate the initial default-branch tag identity before publishing a prerelease. */
export function verifyRemoteReleaseSource({
  defaultBranch,
  tag,
  sourceSha,
  tagObject,
}) {
  if (![sourceSha, tagObject].every((value) => /^[0-9a-f]{40}$/i.test(value)))
    throw new Error("Release source provenance must use full Git object IDs.");
  const refs = remoteRefs(defaultBranch, tag);
  const tagRef = `refs/tags/${tag}`;
  if (
    refs[`refs/heads/${defaultBranch}`] !== sourceSha ||
    refs[tagRef] !== tagObject ||
    (refs[`${tagRef}^{}`] ?? refs[tagRef]) !== sourceSha
  )
    throw new Error(
      "Release source branch or tag moved before prerelease publishing.",
    );
}

/** Promote or safely recognize the exact candidate described by the current-run artifact. */
export async function promoteCandidate({
  directory,
  sourceSha,
  defaultBranch,
  prerelease,
  tag,
}) {
  const { manifest } = await readCandidateArtifact(directory);
  const version = assertReleaseEvent({
    defaultBranch,
    eventSha: sourceSha,
    prerelease,
    tag,
    target: defaultBranch,
  });
  if (
    manifest.sourceSha !== sourceSha ||
    manifest.tag !== tag ||
    manifest.version !== version
  )
    throw new Error("Candidate artifact is bound to another release event.");
  if (
    git(["rev-parse", "HEAD"]) !== sourceSha ||
    git(["rev-parse", `${sourceSha}^{tree}`]) !== manifest.sourceTree
  )
    throw new Error("Checkout does not match the trusted release source.");
  const expected = expectedCandidateMetadata(tag);
  if (
    JSON.stringify(expected.packageJson) !==
      JSON.stringify(manifest.packageJson) ||
    JSON.stringify(expected.packageLock) !==
      JSON.stringify(manifest.packageLock)
  )
    throw new Error(
      "Candidate metadata is not the deterministic release transformation.",
    );
  if (prerelease) return "prerelease-noop";
  const refs = remoteRefs(defaultBranch, tag);
  const currentHead = refs[`refs/heads/${defaultBranch}`];
  const currentTagObject = refs[`refs/tags/${tag}`];
  const currentTagCommit = refs[`refs/tags/${tag}^{}`] ?? currentTagObject;
  if (
    currentHead !== sourceSha ||
    currentTagObject !== manifest.tagObject ||
    currentTagCommit !== sourceSha
  ) {
    return {
      status: "already-promoted",
      candidateSha: assertAlreadyPromotedCandidate({
        refs,
        defaultBranch,
        tag,
        sourceSha,
        expected,
      }),
    };
  }
  writeFileSync(
    "package.json",
    `${JSON.stringify(expected.packageJson, null, 2)}\n`,
  );
  writeFileSync(
    "package-lock.json",
    `${JSON.stringify(expected.packageLock, null, 2)}\n`,
  );
  assertCandidatePaths(
    git(["diff", "--name-only", sourceSha]).split("\n").filter(Boolean),
  );
  git(["config", "user.name", "github-actions[bot]"]);
  git([
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  git(["add", "package.json", "package-lock.json"]);
  git(["commit", "-m", `chore: set package version ${version} [skip ci]`]);
  const candidateSha = git(["rev-parse", "HEAD"]);
  git(["tag", "--force", tag, candidateSha]);
  git([
    "push",
    "--atomic",
    `--force-with-lease=refs/heads/${defaultBranch}:${sourceSha}`,
    `--force-with-lease=refs/tags/${tag}:${manifest.tagObject}`,
    "origin",
    `HEAD:refs/heads/${defaultBranch}`,
    `refs/tags/${tag}:refs/tags/${tag}`,
  ]);
  const after = remoteRefs(defaultBranch, tag);
  assertFinalRefs(after, defaultBranch, tag, candidateSha);
  return { status: "promoted", candidateSha };
}

async function main() {
  const command = process.argv[2] ?? "promote";
  if (command === "verify-remote") {
    verifyRemotePromotion({
      defaultBranch: required("DEFAULT_BRANCH"),
      tag: required("RELEASE_TAG"),
      candidateSha: required("CANDIDATE_SHA"),
    });
    return;
  }
  if (command === "verify-source") {
    verifyRemoteReleaseSource({
      defaultBranch: required("DEFAULT_BRANCH"),
      tag: required("RELEASE_TAG"),
      sourceSha: required("SOURCE_SHA"),
      tagObject: required("TAG_OBJECT"),
    });
    return;
  }
  if (command === "verify-preflight") {
    verifyReleasePreflight({
      defaultBranch: required("DEFAULT_BRANCH"),
      prerelease: required("IS_PRERELEASE") === "true",
      sourceSha: required("SOURCE_SHA"),
      tag: required("RELEASE_TAG"),
    });
    return;
  }
  if (command !== "promote") throw new Error("Unknown promotion command.");
  const result = await promoteCandidate({
    directory: required("CANDIDATE_DIRECTORY"),
    sourceSha: required("SOURCE_SHA"),
    defaultBranch: required("DEFAULT_BRANCH"),
    prerelease: required("IS_PRERELEASE") === "true",
    tag: required("RELEASE_TAG"),
  });
  if (result === "prerelease-noop") {
    console.log(result);
    return;
  }
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `candidate_sha=${result.candidateSha}\n`,
    );
  console.log(result.status);
}

if (process.argv[1] === new URL(import.meta.url).pathname)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
