import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { assertReleaseEvent, createCandidateManifest, expectedMetadata, readCandidateArtifact, validateNpmTarball, versionFromTag } from "../.github/scripts/release-candidate.mjs";
import { promoteCandidate, verifyRemotePromotion, verifyRemoteReleaseSource } from "../.github/scripts/promote-release-candidate.mjs";

function command(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeTarball(path: string, packageJson: object, extra: Array<[string, string | Buffer]> = [], omit: string[] = []) {
  const files: Array<[string, string | Buffer]> = [
    ["package/package.json", `${JSON.stringify(packageJson, null, 2)}\n`],
    ["package/LICENSE.md", "MIT\n"],
    ["package/README.md", "# Test\n"],
    ...["client", "config", "index", "redact", "server"].flatMap((name) => [[`package/dist/${name}.d.ts`, "export {};\n"], [`package/dist/${name}.js`, "export {};\n"], [`package/dist/${name}.js.map`, "{}\n"]] as Array<[string, string]>),
    ...extra,
  ].filter(([name]) => !omit.includes(name));
  const chunks: Buffer[] = [];
  for (const [name, body] of files) {
    const content = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write("0000644\0", 100);
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  writeFileSync(path, gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)])));
}

async function candidateDirectory(root: string, sourceSha: string, sourceTree: string, tagObject: string, packageJson: object, packageLock: object, tag = "v1.2.3") {
  const directory = join(root, "artifact");
  mkdirSync(directory);
  const tarball = join(directory, "candidate.tgz");
  writeTarball(tarball, packageJson);
  const manifest = await createCandidateManifest({ tarball, sourceSha, sourceTree, tag, tagObject, packageJson, packageLock });
  writeFileSync(join(directory, "candidate.json"), `${JSON.stringify(manifest)}\n`);
  return directory;
}

const originalCwd = process.cwd();
afterEach(() => process.chdir(originalCwd));

describe("release candidate contract", () => {
  it("accepts stable and prerelease events while rejecting a wrong release target", () => {
    expect(versionFromTag("v1.2.3-rc.1")).toBe("1.2.3-rc.1");
    expect(assertReleaseEvent({ defaultBranch: "main", eventSha: "a".repeat(40), prerelease: true, tag: "v1.2.3-rc.1", target: "main" })).toBe("1.2.3-rc.1");
    expect(() => assertReleaseEvent({ defaultBranch: "main", eventSha: "a".repeat(40), prerelease: false, tag: "v1.2.3-rc.1", target: "main" })).toThrow("prerelease");
    expect(() => assertReleaseEvent({ defaultBranch: "main", eventSha: "a".repeat(40), prerelease: false, tag: "v1.2.3", target: "feature" })).toThrow("default branch");
  });

  it("rejects invalid release tags", () => {
    expect(() => versionFromTag("latest")).toThrow("semantic");
  });

  it("rejects a tarball that differs from the trusted candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "ytptube-artifact-"));
    const metadata = { name: "ytptube-mcp", version: "1.2.3", files: ["dist"], bin: { "ytptube-mcp": "dist/index.js" } };
    const lock = { version: "1.2.3", packages: { "": { version: "1.2.3" } } };
    const directory = await candidateDirectory(root, "a".repeat(40), "b".repeat(40), "c".repeat(40), metadata, lock);
    await expect(readCandidateArtifact(directory)).resolves.toBeDefined();
    writeTarball(join(directory, "candidate.tgz"), { ...metadata, scripts: { postinstall: "unsafe" } });
    await expect(readCandidateArtifact(directory)).rejects.toThrow("metadata");
  });

  it("rejects compressed and expanded size attacks plus unsafe tar paths and artifact files", async () => {
    const root = mkdtempSync(join(tmpdir(), "ytptube-bounds-"));
    const metadata = { name: "ytptube-mcp", version: "1.2.3", files: ["dist"], bin: { "ytptube-mcp": "dist/index.js" } };
    const compressed = join(root, "compressed.tgz");
    writeFileSync(compressed, randomBytes(8 * 1024 * 1024 + 1));
    await expect(validateNpmTarball(compressed, metadata)).rejects.toThrow("bounded");
    const expanded = join(root, "expanded.tgz");
    writeFileSync(expanded, gzipSync(Buffer.alloc(33 * 1024 * 1024)));
    await expect(validateNpmTarball(expanded, metadata)).rejects.toThrow("size limits");
    for (const [label, extra] of [["traversal", [["package/../evil.js", "x"]]], ["duplicate", [["package/dist/index.js", "x"]]], ["config", [["package/tsconfig.json", "{}"]]], ["runtime", [["package/dist/evil.js", "{}"]]]] as const) {
      const path = join(root, `${label}.tgz`);
      writeTarball(path, metadata, extra as Array<[string, string | Buffer]>);
      await expect(validateNpmTarball(path, metadata)).rejects.toThrow(label === "runtime" || label === "config" ? "runtime entries" : "unsafe");
    }
    const missing = join(root, "missing.tgz");
    writeTarball(missing, metadata, [], ["package/dist/server.js.map"]);
    await expect(validateNpmTarball(missing, metadata)).rejects.toThrow("runtime entries");
    const artifact = join(root, "artifact");
    mkdirSync(artifact);
    writeFileSync(join(artifact, "candidate.json"), "{}\n");
    symlinkSync("candidate.json", join(artifact, "candidate.tgz"));
    await expect(readCandidateArtifact(artifact)).rejects.toThrow("non-regular");
  });
});

describe("release workflow promotion", () => {
  async function setup(tag = "v1.2.3") {
    const root = mkdtempSync(join(tmpdir(), "ytptube-promotion-"));
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    command(root, "init", "--bare", "--quiet", remote);
    command(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
    command(root, "init", "--quiet", "--initial-branch=main", source);
    command(source, "config", "user.name", "Test");
    command(source, "config", "user.email", "test@example.test");
    const packageJson = { name: "ytptube-mcp", version: "0.1.2", files: ["dist"], bin: { "ytptube-mcp": "dist/index.js" } };
    const packageLock = { name: "ytptube-mcp", version: "0.1.2", lockfileVersion: 3, packages: { "": { name: "ytptube-mcp", version: "0.1.2" } } };
    writeFileSync(join(source, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
    writeFileSync(join(source, "package-lock.json"), `${JSON.stringify(packageLock, null, 2)}\n`);
    writeFileSync(join(source, "README.md"), "# Test\n");
    command(source, "add", ".");
    command(source, "commit", "--quiet", "-m", "source");
    const sourceSha = command(source, "rev-parse", "HEAD");
    command(source, "tag", "-a", tag, "-m", "release");
    const tagObject = command(source, "rev-parse", `refs/tags/${tag}`);
    command(source, "remote", "add", "origin", remote);
    command(source, "push", "--quiet", "origin", "main", "--tags");
    const sourceTree = command(source, "rev-parse", "HEAD^{tree}");
    const expected = expectedMetadata(packageJson, packageLock, tag);
    const artifact = await candidateDirectory(root, sourceSha, sourceTree, tagObject, expected.packageJson, expected.packageLock, tag);
    const checkout = join(root, "checkout");
    command(root, "clone", "--quiet", remote, checkout);
    command(checkout, "checkout", "--quiet", sourceSha);
    return { artifact, checkout, remote, root, source, sourceSha, tag };
  }

  it("promotes branch and tag together, then recognizes an exact retry", async () => {
    const context = await setup();
    process.chdir(context.checkout);
    await expect(promoteCandidate({ directory: context.artifact, sourceSha: context.sourceSha, defaultBranch: "main", prerelease: false, tag: "v1.2.3" })).resolves.toMatchObject({ status: "promoted" });
    const promoted = command(context.root, "--git-dir", context.remote, "rev-parse", "refs/heads/main");
    expect(command(context.root, "--git-dir", context.remote, "rev-parse", "refs/tags/v1.2.3^{commit}")).toBe(promoted);
    const retry = join(context.root, "retry");
    command(context.root, "clone", "--quiet", context.remote, retry);
    command(retry, "checkout", "--quiet", context.sourceSha);
    process.chdir(retry);
    await expect(promoteCandidate({ directory: context.artifact, sourceSha: context.sourceSha, defaultBranch: "main", prerelease: false, tag: "v1.2.3" })).resolves.toMatchObject({ status: "already-promoted", candidateSha: promoted });
  });

  it("does not partially update when the remote rejects the tag or the branch is stale", async () => {
    const rejected = await setup();
    const hook = join(rejected.remote, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\nwhile read old new ref; do case $ref in refs/tags/*) exit 1;; esac; done\nexit 0\n");
    chmodSync(hook, 0o755);
    process.chdir(rejected.checkout);
    await expect(promoteCandidate({ directory: rejected.artifact, sourceSha: rejected.sourceSha, defaultBranch: "main", prerelease: false, tag: "v1.2.3" })).rejects.toThrow();
    expect(command(rejected.root, "--git-dir", rejected.remote, "rev-parse", "refs/heads/main")).toBe(rejected.sourceSha);
    expect(command(rejected.root, "--git-dir", rejected.remote, "rev-parse", "refs/tags/v1.2.3^{commit}")).toBe(rejected.sourceSha);

    const stale = await setup();
    writeFileSync(join(stale.source, "later.txt"), "later\n");
    command(stale.source, "add", "later.txt");
    command(stale.source, "commit", "--quiet", "-m", "later");
    command(stale.source, "push", "--quiet", "origin", "main");
    process.chdir(stale.checkout);
    await expect(promoteCandidate({ directory: stale.artifact, sourceSha: stale.sourceSha, defaultBranch: "main", prerelease: false, tag: "v1.2.3" })).rejects.toThrow("changed before promotion");
    expect(command(stale.root, "--git-dir", stale.remote, "rev-parse", "refs/tags/v1.2.3^{commit}")).toBe(stale.sourceSha);
  });

  it("rejects an artifact replayed for another source or release event before changing Git", async () => {
    const context = await setup();
    process.chdir(context.checkout);
    await expect(promoteCandidate({ directory: context.artifact, sourceSha: "d".repeat(40), defaultBranch: "main", prerelease: false, tag: "v1.2.3" })).rejects.toThrow("another release event");
    await expect(promoteCandidate({ directory: context.artifact, sourceSha: context.sourceSha, defaultBranch: "main", prerelease: true, tag: "v1.2.3" })).rejects.toThrow("prerelease");
    expect(command(context.root, "--git-dir", context.remote, "rev-parse", "refs/heads/main")).toBe(context.sourceSha);
  });

  it("keeps prereleases off the default branch and rejects a tag moved after promotion", async () => {
    const prerelease = await setup("v1.2.3-rc.1");
    process.chdir(prerelease.checkout);
    await expect(promoteCandidate({ directory: prerelease.artifact, sourceSha: prerelease.sourceSha, defaultBranch: "main", prerelease: true, tag: prerelease.tag })).resolves.toBe("prerelease-noop");
    expect(command(prerelease.root, "--git-dir", prerelease.remote, "rev-parse", "refs/heads/main")).toBe(prerelease.sourceSha);
    const prereleaseTagObject = command(prerelease.root, "--git-dir", prerelease.remote, "rev-parse", `refs/tags/${prerelease.tag}`);
    expect(() => verifyRemoteReleaseSource({ defaultBranch: "main", tag: prerelease.tag, sourceSha: prerelease.sourceSha, tagObject: prereleaseTagObject })).not.toThrow();
    writeFileSync(join(prerelease.source, "later.txt"), "later\n");
    command(prerelease.source, "add", "later.txt");
    command(prerelease.source, "commit", "--quiet", "-m", "later");
    command(prerelease.source, "push", "--quiet", "origin", "main");
    expect(() => verifyRemoteReleaseSource({ defaultBranch: "main", tag: prerelease.tag, sourceSha: prerelease.sourceSha, tagObject: prereleaseTagObject })).toThrow("moved before prerelease");

    const moved = await setup();
    process.chdir(moved.checkout);
    const result = await promoteCandidate({ directory: moved.artifact, sourceSha: moved.sourceSha, defaultBranch: "main", prerelease: false, tag: "v1.2.3" });
    if (result === "prerelease-noop") throw new Error("stable release unexpectedly skipped promotion");
    command(moved.source, "tag", "--force", "v1.2.3", moved.sourceSha);
    command(moved.source, "push", "--quiet", "--force", "origin", "refs/tags/v1.2.3");
    expect(() => verifyRemotePromotion({ defaultBranch: "main", tag: "v1.2.3", candidateSha: result.candidateSha })).toThrow("no longer names");
  });

  it("binds the executable promotion path to the candidate artifact, rather than a rebuilt package", () => {
    const workflow = readFileSync(join(originalCwd, ".github/workflows/release.yml"), "utf8");
    expect(workflow).toMatch(/CANDIDATE_ARTIFACT: release-candidate-\$\{\{ github\.run_id \}\}/);
    expect(workflow).toMatch(/promote-release-candidate\.mjs/);
    expect(workflow).toMatch(/npm publish \.\/release-artifact\/candidate\.tgz --ignore-scripts --tag "\$npm_tag"/);
    expect(workflow).toMatch(/promote-release-candidate\.mjs verify-remote/);
    expect(workflow).toMatch(/promote-release-candidate\.mjs verify-source/);
    expect(workflow).toMatch(/grep -q 'E404'/);
    expect(workflow).not.toMatch(/npm publish\s*$/m);
  });
});
