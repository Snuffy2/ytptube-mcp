/** Trusted release-candidate contracts shared by the read-only build and promotion jobs. */
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const CANDIDATE_PATHS = ["package.json", "package-lock.json"];
const MAX_TGZ_BYTES = 8 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 1_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const RUNTIME_MODULES = ["client", "config", "index", "redact", "server"];
const EXPECTED_DIST_ENTRIES = RUNTIME_MODULES.flatMap((name) => [
  `package/dist/${name}.d.ts`,
  `package/dist/${name}.js`,
  `package/dist/${name}.js.map`,
]);
const EXPECTED_TARBALL_ENTRIES = ["package/LICENSE.md", "package/README.md", ...EXPECTED_DIST_ENTRIES, "package/package.json"].sort();
const MANIFEST_VERSION = 1;

/** Return the package version from a GitHub release tag. */
export function versionFromTag(tag) {
  if (!/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(tag)) throw new Error("Release tag must be semantic version.");
  return tag.replace(/^v/, "");
}

/** Validate fields binding candidate work to protected default-branch history. */
export function assertReleaseEvent({ defaultBranch, eventSha, prerelease, tag, target }) {
  if (!/^[0-9a-f]{40}$/i.test(eventSha)) throw new Error("Release event SHA must be a full Git object ID.");
  if (target !== defaultBranch) throw new Error("Release must target the default branch.");
  const version = versionFromTag(tag);
  if (Boolean(prerelease) !== version.includes("-")) throw new Error("Release prerelease state disagrees with its tag.");
  return version;
}

/** Build the only permitted package and lockfile transformations. */
export function expectedMetadata(packageJson, packageLock, tag) {
  const version = versionFromTag(tag);
  const expectedPackage = structuredClone(packageJson);
  const expectedLock = structuredClone(packageLock);
  expectedPackage.version = version;
  expectedLock.version = version;
  if (!expectedLock.packages?.[""]) throw new Error("Package lock lacks root package metadata.");
  expectedLock.packages[""].version = version;
  return { packageJson: expectedPackage, packageLock: expectedLock };
}

/** Reject candidate tree changes beyond deterministic package metadata. */
export function assertCandidatePaths(paths) {
  const actual = [...paths].sort();
  const expected = [...CANDIDATE_PATHS].sort();
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) throw new Error("Release candidate changes paths beyond package metadata.");
}

function parseOctal(buffer) {
  const text = buffer.toString("utf8").replace(/\0.*$/, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function hashes(bytes) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

function equalJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/** Read and validate a complete npm tarball before returning its metadata. */
export async function validateNpmTarball(tarball, trustedPackage) {
  const stat = lstatSync(tarball);
  if (!stat.isFile() || stat.size > MAX_TGZ_BYTES) throw new Error("Tarball is not a bounded regular file.");
  const chunks = [];
  let compressed = 0;
  let expanded = 0;
  await new Promise((resolve, reject) => {
    const source = createReadStream(tarball);
    const gunzip = createGunzip();
    source.on("data", (chunk) => {
      compressed += chunk.length;
      if (compressed > MAX_TGZ_BYTES) source.destroy(new Error("Tarball exceeds size limits."));
    }).on("error", reject);
    gunzip.on("data", (chunk) => {
      expanded += chunk.length;
      if (expanded > MAX_EXPANDED_BYTES) gunzip.destroy(new Error("Tarball exceeds size limits."));
      else chunks.push(chunk);
    }).on("error", reject).on("end", resolve);
    source.pipe(gunzip);
  });
  const bytes = Buffer.concat(chunks);
  if (compressed > MAX_TGZ_BYTES || bytes.length > MAX_EXPANDED_BYTES) throw new Error("Tarball exceeds size limits.");
  const entries = new Map();
  let ended = false;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (!bytes.subarray(offset).every((byte) => byte === 0)) throw new Error("Tarball has trailing data.");
      ended = true;
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = parseOctal(header.subarray(124, 136));
    const type = header[156];
    if (!name.startsWith("package/") || name === "package/" || name.includes("..") || !Number.isSafeInteger(size) || size < 0 || ![0, 48].includes(type) || size > MAX_ENTRY_BYTES || entries.has(name) || entries.size >= MAX_ENTRIES) throw new Error("Tarball contains an unsafe entry.");
    const start = offset + 512;
    const end = start + size;
    if (end > bytes.length) throw new Error("Tarball entry is truncated.");
    entries.set(name, bytes.subarray(start, end));
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!ended) throw new Error("Tarball is missing its end marker.");
  const packageBytes = entries.get("package/package.json");
  if (!packageBytes) throw new Error("Tarball lacks package.json.");
  const metadata = JSON.parse(packageBytes.toString("utf8"));
  if (!equalJson(metadata, trustedPackage)) throw new Error("Tarball package metadata differs from the trusted candidate.");
  if (!equalJson([...entries.keys()].sort(), EXPECTED_TARBALL_ENTRIES)) throw new Error("Tarball runtime entries do not match the trusted release contract.");
  if (!equalJson(trustedPackage.files, ["dist"])) throw new Error("Trusted package does not declare the expected runtime files.");
  const bin = typeof trustedPackage.bin === "string" ? { [trustedPackage.name]: trustedPackage.bin } : trustedPackage.bin;
  if (!bin || typeof bin !== "object" || !Object.values(bin).every((target) => typeof target === "string" && /^dist\/[A-Za-z0-9_-]+\.js$/.test(target) && entries.has(`package/${target}`))) throw new Error("Tarball does not contain its declared executable.");
  return { ...hashes(readFileSync(tarball)), entries: [...entries.keys()].sort(), metadata, size: stat.size };
}

/** Create an immutable description of the exact package artifact produced by the read-only job. */
export async function createCandidateManifest({ tarball, sourceSha, sourceTree, tag, tagObject, packageJson, packageLock }) {
  if (![sourceSha, sourceTree, tagObject].every((value) => /^[0-9a-f]{40}$/i.test(value))) throw new Error("Candidate provenance must use full Git object IDs.");
  const version = versionFromTag(tag);
  const artifact = await validateNpmTarball(tarball, packageJson);
  return { manifestVersion: MANIFEST_VERSION, sourceSha, sourceTree, tag, tagObject, version, packageJson, packageLock, artifact: { file: basename(tarball), ...artifact } };
}

/** Read a service-provided artifact directory and reject every unbound or extra file. */
export async function readCandidateArtifact(directory) {
  const names = readdirSync(directory).sort();
  if (names.length !== 2 || names[0] !== "candidate.json" || names[1] !== "candidate.tgz") throw new Error("Candidate artifact has unexpected files.");
  for (const name of names) {
    const stat = lstatSync(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Candidate artifact contains a non-regular file.");
    if (name === "candidate.json" && stat.size > MAX_MANIFEST_BYTES) throw new Error("Candidate artifact manifest is too large.");
  }
  const manifest = JSON.parse(readFileSync(join(directory, "candidate.json"), "utf8"));
  if (manifest.manifestVersion !== MANIFEST_VERSION || manifest.artifact?.file !== "candidate.tgz") throw new Error("Candidate artifact manifest is invalid.");
  const version = versionFromTag(manifest.tag);
  if (manifest.version !== version || ![manifest.sourceSha, manifest.sourceTree, manifest.tagObject].every((value) => /^[0-9a-f]{40}$/i.test(value))) throw new Error("Candidate artifact provenance is invalid.");
  const artifact = await validateNpmTarball(join(directory, "candidate.tgz"), manifest.packageJson);
  for (const key of ["sha256", "integrity", "size", "entries"]) if (!equalJson(artifact[key], manifest.artifact[key])) throw new Error(`Candidate tarball ${key} does not match its manifest.`);
  return { manifest, artifact };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  if (command === "create-manifest") {
    const manifest = await createCandidateManifest({ tarball: argument("--tarball"), sourceSha: argument("--source-sha"), sourceTree: argument("--source-tree"), tag: argument("--tag"), tagObject: argument("--tag-object"), packageJson: JSON.parse(readFileSync(argument("--package-json"), "utf8")), packageLock: JSON.parse(readFileSync(argument("--package-lock"), "utf8")) });
    writeFileSync(argument("--output"), `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "verify-artifact") {
    const { manifest } = await readCandidateArtifact(argument("--directory"));
    if (manifest.sourceSha !== argument("--source-sha") || manifest.tag !== argument("--tag")) throw new Error("Candidate artifact is bound to another release event.");
    return;
  }
  throw new Error("Unknown release-candidate command.");
}

if (process.argv[1] === new URL(import.meta.url).pathname) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
