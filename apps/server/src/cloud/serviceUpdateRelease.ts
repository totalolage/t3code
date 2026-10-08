import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";

const MAX_RELEASES = 100;
const MAX_CHECKSUMS_BYTES = 128 * 1024;
const MAX_RUN_NUMBER = "2100000000";
const CHECKSUM_ASSET_SUFFIX = ".sha256";

const F8Y_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-f8y\.(\d{8})\.([1-9]\d*)(?![\s\S])/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export type ServiceUpdateReleaseErrorCode =
  | "invalid-repository"
  | "invalid-current-version"
  | "invalid-target-version"
  | "target-not-found"
  | "invalid-release-response"
  | "conflicting-release"
  | "invalid-release-url"
  | "invalid-checksums"
  | "invalid-digest"
  | "checksum-mismatch";

export class ServiceUpdateReleaseError extends Error {
  readonly code: ServiceUpdateReleaseErrorCode;

  constructor(code: ServiceUpdateReleaseErrorCode, message: string) {
    super(message);
    this.name = "ServiceUpdateReleaseError";
    this.code = code;
  }
}

export interface ServiceUpdateReleaseDescriptor {
  readonly version: string;
  readonly tag: string;
  readonly binaryName: string;
  readonly binaryUrl: string;
  readonly checksumsUrl: string;
}

export interface SelectServiceUpdateReleaseInput {
  readonly currentVersion: string;
  readonly repository: string;
  readonly platform: string;
  readonly architecture: string;
  readonly releases: unknown;
}

interface ParsedVersionCore {
  readonly major: string;
  readonly minor: string;
  readonly patch: string;
}

interface ParsedF8yVersion extends ParsedVersionCore {
  readonly kind: "f8y";
  readonly version: string;
  readonly date: string;
  readonly run: string;
}

interface ParsedPlainVersion extends ParsedVersionCore {
  readonly kind: "plain";
  readonly version: string;
}

type ParsedCurrentVersion = ParsedF8yVersion | ParsedPlainVersion;

interface GitHubReleaseAsset {
  readonly name: string;
  readonly url: string;
}

interface GitHubRelease {
  readonly tag: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: ReadonlyArray<GitHubReleaseAsset>;
}

interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

interface SelectedRelease {
  readonly parsed: ParsedF8yVersion;
  readonly descriptor: ServiceUpdateReleaseDescriptor;
}

function fail(code: ServiceUpdateReleaseErrorCode, message: string): never {
  throw new ServiceUpdateReleaseError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function compareDecimalStrings(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isValidGregorianDate(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1]!;
}

function parseF8yVersion(value: string): ParsedF8yVersion | undefined {
  const match = F8Y_VERSION_PATTERN.exec(value);
  if (match === null) return undefined;

  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  const date = match[4];
  const run = match[5];
  if (
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    date === undefined ||
    run === undefined ||
    !isValidGregorianDate(date) ||
    compareDecimalStrings(run, MAX_RUN_NUMBER) > 0
  ) {
    return undefined;
  }

  return { kind: "f8y", version: value, major, minor, patch, date, run };
}

function parsePlainVersion(value: string): ParsedPlainVersion | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/u.exec(value);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { kind: "plain", version: value, major, minor, patch };
}

export const isServiceUpdateTargetVersion = (value: unknown): value is string =>
  typeof value === "string" && parseF8yVersion(value) !== undefined;

function parseCurrentVersion(value: unknown): ParsedCurrentVersion {
  if (typeof value !== "string") {
    return fail(
      "invalid-current-version",
      `Invalid current version ${display(value)}; expected canonical MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-f8y.YYYYMMDD.RUN.`,
    );
  }

  const parsed = parseF8yVersion(value) ?? parsePlainVersion(value);
  return (
    parsed ??
    fail(
      "invalid-current-version",
      `Invalid current version ${display(value)}; expected canonical MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-f8y.YYYYMMDD.RUN.`,
    )
  );
}

function compareVersionCore(left: ParsedVersionCore, right: ParsedVersionCore): number {
  for (const [leftPart, rightPart] of [
    [left.major, right.major],
    [left.minor, right.minor],
    [left.patch, right.patch],
  ] as const) {
    const coreComparison = compareDecimalStrings(leftPart, rightPart);
    if (coreComparison !== 0) return coreComparison;
  }
  return 0;
}

function compareF8yVersions(left: ParsedF8yVersion, right: ParsedF8yVersion): number {
  const coreComparison = compareVersionCore(left, right);
  if (coreComparison !== 0) return coreComparison;
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  return compareDecimalStrings(left.run, right.run);
}

function compareF8yReleaseToCurrent(
  release: ParsedF8yVersion,
  current: ParsedCurrentVersion,
): number {
  const coreComparison = compareVersionCore(release, current);
  if (coreComparison !== 0) return coreComparison;
  if (current.kind === "plain") return 1;
  return compareF8yVersions(release, current);
}

function parseConfiguredRepository(value: unknown): GitHubRepository | null {
  if (typeof value !== "string") {
    return fail("invalid-repository", "The configured GitHub repository must be owner/repo.");
  }
  if (value === "") return null;

  const segments = value.split("/");
  if (segments.length !== 2) {
    return fail(
      "invalid-repository",
      `Invalid GitHub repository ${display(value)}; expected exact owner/repo.`,
    );
  }

  const owner = segments[0];
  const repo = segments[1];
  if (
    owner === undefined ||
    repo === undefined ||
    owner === "" ||
    repo === "" ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repo)
  ) {
    return fail(
      "invalid-repository",
      `Invalid GitHub repository ${display(value)}; expected exact owner/repo.`,
    );
  }

  return { owner, repo };
}

function parseGitHubReleases(value: unknown): ReadonlyArray<GitHubRelease> {
  if (!Array.isArray(value)) {
    return fail("invalid-release-response", "GitHub releases response must be an array.");
  }
  if (value.length > MAX_RELEASES) {
    return fail(
      "invalid-release-response",
      `GitHub releases response contains ${value.length} entries; at most ${MAX_RELEASES} are allowed.`,
    );
  }

  return Array.from(value, (release, releaseIndex) => {
    if (!isRecord(release)) {
      return fail(
        "invalid-release-response",
        `GitHub release at index ${releaseIndex} must be an object.`,
      );
    }

    const tag = release["tag_name"];
    const draft = release["draft"];
    const prerelease = release["prerelease"];
    const assets = release["assets"];
    if (typeof tag !== "string" || typeof draft !== "boolean" || typeof prerelease !== "boolean") {
      return fail(
        "invalid-release-response",
        `GitHub release at index ${releaseIndex} has invalid tag_name, draft, or prerelease fields.`,
      );
    }
    if (!Array.isArray(assets)) {
      return fail(
        "invalid-release-response",
        `GitHub release at index ${releaseIndex} must contain an assets array.`,
      );
    }

    return {
      tag,
      draft,
      prerelease,
      assets: Array.from(assets, (asset, assetIndex) => {
        if (!isRecord(asset)) {
          return fail(
            "invalid-release-response",
            `GitHub asset ${releaseIndex}/${assetIndex} must be an object.`,
          );
        }
        const name = asset["name"];
        const url = asset["browser_download_url"];
        if (typeof name !== "string" || typeof url !== "string") {
          return fail(
            "invalid-release-response",
            `GitHub asset ${releaseIndex}/${assetIndex} has invalid name or browser_download_url fields.`,
          );
        }
        return { name, url };
      }),
    };
  });
}

function expectedAssetUrl(repository: GitHubRepository, tag: string, assetName: string): string {
  return [repository.owner, repository.repo, "releases", "download", tag, assetName]
    .map((segment) => encodeURIComponent(segment))
    .reduce((url, segment) => `${url}/${segment}`, "https://github.com");
}

function validateAssetUrl(value: string, expected: string, assetName: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(
      "invalid-release-url",
      `Invalid URL for release asset ${JSON.stringify(assetName)}.`,
    );
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    value.includes("?") ||
    value.includes("#") ||
    value !== expected
  ) {
    return fail(
      "invalid-release-url",
      `Release asset ${JSON.stringify(assetName)} must use the configured GitHub download URL.`,
    );
  }

  return value;
}

interface ReleaseAssets {
  readonly binaryName: string;
  readonly binaryAsset: GitHubReleaseAsset;
  readonly checksumAsset: GitHubReleaseAsset;
}

function releaseAssetsForVersion(
  release: GitHubRelease,
  parsed: ParsedF8yVersion,
  platformAsset: string,
): ReleaseAssets | undefined {
  const binaryName = `t3-${parsed.version}-${platformAsset}`;
  const checksumName = `${binaryName}${CHECKSUM_ASSET_SUFFIX}`;
  const binaryAssets = release.assets.filter((asset) => asset.name === binaryName);
  const checksumAssets = release.assets.filter((asset) => asset.name === checksumName);
  if (binaryAssets.length === 0 || checksumAssets.length === 0) return undefined;
  if (binaryAssets.length !== 1 || checksumAssets.length !== 1) {
    return fail(
      "conflicting-release",
      `Release ${JSON.stringify(release.tag)} must contain exactly one ${JSON.stringify(binaryName)} asset and one ${JSON.stringify(checksumName)} asset.`,
    );
  }
  return {
    binaryName,
    binaryAsset: binaryAssets[0]!,
    checksumAsset: checksumAssets[0]!,
  };
}

function descriptorForRelease(
  release: GitHubRelease,
  parsed: ParsedF8yVersion,
  repository: GitHubRepository,
  assets: ReleaseAssets,
): ServiceUpdateReleaseDescriptor {
  return Object.freeze({
    version: parsed.version,
    tag: release.tag,
    binaryName: assets.binaryName,
    binaryUrl: validateAssetUrl(
      assets.binaryAsset.url,
      expectedAssetUrl(repository, release.tag, assets.binaryName),
      assets.binaryName,
    ),
    checksumsUrl: validateAssetUrl(
      assets.checksumAsset.url,
      expectedAssetUrl(repository, release.tag, assets.checksumAsset.name),
      assets.checksumAsset.name,
    ),
  });
}

function sameDescriptor(
  left: ServiceUpdateReleaseDescriptor,
  right: ServiceUpdateReleaseDescriptor,
): boolean {
  return (
    left.version === right.version &&
    left.tag === right.tag &&
    left.binaryName === right.binaryName &&
    left.binaryUrl === right.binaryUrl &&
    left.checksumsUrl === right.checksumsUrl
  );
}

export function selectServiceUpdateRelease(
  input: SelectServiceUpdateReleaseInput,
): ServiceUpdateReleaseDescriptor | null {
  const repository = parseConfiguredRepository(input.repository);
  if (repository === null) return null;
  if (input.platform !== "linux" || input.architecture !== "x64") return null;

  const current = parseCurrentVersion(input.currentVersion);
  const releases = parseGitHubReleases(input.releases);
  const selectedByVersion = new Map<string, SelectedRelease>();

  for (const release of releases) {
    if (release.draft) continue;

    const parsed = release.tag.startsWith("v") ? parseF8yVersion(release.tag.slice(1)) : undefined;
    if (parsed === undefined || compareF8yReleaseToCurrent(parsed, current) <= 0) continue;

    const assets = releaseAssetsForVersion(
      release,
      parsed,
      `${input.platform}-${input.architecture}`,
    );
    if (assets === undefined) continue;
    const previous = selectedByVersion.get(parsed.version);
    if (
      previous !== undefined &&
      (previous.descriptor.binaryUrl !== assets.binaryAsset.url ||
        previous.descriptor.checksumsUrl !== assets.checksumAsset.url)
    ) {
      return fail(
        "conflicting-release",
        `Conflicting GitHub release entries claim the same f8y version ${JSON.stringify(parsed.version)}.`,
      );
    }
    const descriptor = descriptorForRelease(release, parsed, repository, assets);
    if (previous !== undefined && !sameDescriptor(previous.descriptor, descriptor)) {
      return fail(
        "conflicting-release",
        `Conflicting GitHub release entries claim the same f8y version ${JSON.stringify(parsed.version)}.`,
      );
    }
    selectedByVersion.set(parsed.version, { parsed, descriptor });
  }

  let selected: SelectedRelease | undefined;
  for (const candidate of selectedByVersion.values()) {
    if (selected === undefined || compareF8yVersions(candidate.parsed, selected.parsed) > 0) {
      selected = candidate;
    }
  }
  return selected?.descriptor ?? null;
}

export function resolveServiceUpdateReleaseByVersion(input: {
  readonly repository: string;
  readonly targetVersion: string;
  readonly release: unknown;
}): ServiceUpdateReleaseDescriptor {
  const repository = parseConfiguredRepository(input.repository);
  if (repository === null) {
    return fail("invalid-repository", "An exact-version update requires a configured owner/repo.");
  }

  const parsedTarget = parseF8yVersion(input.targetVersion);
  if (parsedTarget === undefined) {
    return fail(
      "invalid-target-version",
      "The requested F8Y target must be canonical MAJOR.MINOR.PATCH-f8y.YYYYMMDD.RUN.",
    );
  }

  const [release] = parseGitHubReleases([input.release]);
  if (release === undefined || release.draft || release.tag !== `v${parsedTarget.version}`) {
    return fail(
      "target-not-found",
      `The requested F8Y release ${JSON.stringify(parsedTarget.version)} is not published under its exact tag.`,
    );
  }

  const assets = releaseAssetsForVersion(release, parsedTarget, "linux-x64");
  if (assets === undefined) {
    return fail(
      "target-not-found",
      `The requested F8Y release ${JSON.stringify(parsedTarget.version)} does not contain its Linux x64 binary and checksum sidecar.`,
    );
  }
  return descriptorForRelease(release, parsedTarget, repository, assets);
}

export function parseServiceUpdateChecksum(contents: string): string {
  if (typeof contents !== "string") {
    return fail("invalid-checksums", "The release checksum sidecar must be a string.");
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_CHECKSUMS_BYTES) {
    return fail(
      "invalid-checksums",
      `The release checksum sidecar exceeds the ${MAX_CHECKSUMS_BYTES}-byte limit.`,
    );
  }
  const digest = contents.trim().split(/\s+/u)[0]?.toLowerCase();
  if (digest === undefined || !DIGEST_PATTERN.test(digest)) {
    return fail(
      "invalid-checksums",
      "The release checksum sidecar must begin with a 64-character SHA-256 digest.",
    );
  }
  return digest;
}

export function verifyServiceUpdateChecksum(
  chunks: Iterable<Uint8Array>,
  expectedDigest: string,
): void {
  if (typeof expectedDigest !== "string" || !DIGEST_PATTERN.test(expectedDigest)) {
    fail(
      "invalid-digest",
      "Expected SHA-256 digest must be exactly 64 lowercase hexadecimal characters.",
    );
  }

  const hash = sha256.create();
  try {
    for (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) {
        fail("invalid-digest", "Release binary chunks must be Uint8Array values.");
      }
      hash.update(chunk);
    }
    const actualDigest = bytesToHex(hash.digest());
    if (actualDigest !== expectedDigest) {
      fail(
        "checksum-mismatch",
        `Release binary SHA-256 mismatch: expected ${expectedDigest}, got ${actualDigest}.`,
      );
    }
  } catch (cause) {
    if (cause instanceof ServiceUpdateReleaseError) throw cause;
    return fail("checksum-mismatch", "Could not hash the release binary stream.");
  }
}
