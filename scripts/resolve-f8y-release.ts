#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off - This CLI validates immutable release metadata with Node's filesystem and date APIs.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

export interface F8yReleaseInput {
  readonly sourceVersion: string;
  readonly timestamp: string;
  readonly runNumber: string;
  readonly sha: string;
}

export interface F8yRelease {
  readonly version: string;
  readonly tag: string;
  readonly versionCode: number;
  readonly sha: string;
}

const SOURCE_VERSION_PATTERN =
  /^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const TIMESTAMP_PATTERN =
  /^(?<year>[0-9]{4})-(?<month>[0-9]{2})-(?<day>[0-9]{2})T(?<hour>[0-9]{2}):(?<minute>[0-9]{2}):(?<second>[0-9]{2})(?:\.[0-9]+)?(?<timezone>Z|[+-][0-9]{2}:[0-9]{2})$/u;
const CANONICAL_RUN_NUMBER_PATTERN = /^[1-9][0-9]*$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const MAX_VERSION_CODE = 2_100_000_000;

const DEFAULT_REPOSITORY_ROOT = NodePath.resolve(
  NodeURL.fileURLToPath(new URL("..", import.meta.url)),
);

/** Resolve the release identity without consulting the clock or process environment. */
export function resolveF8yRelease(input: F8yReleaseInput): F8yRelease {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("Release metadata must be an object.");
  }

  const sourceVersion = requireString(input.sourceVersion, "sourceVersion");
  const timestamp = requireString(input.timestamp, "timestamp");
  const runNumber = requireString(input.runNumber, "runNumber");
  const sha = requireString(input.sha, "sha");

  const stableVersion = parseSourceVersion(sourceVersion);
  const utcDay = parseTimestampToUtcDay(timestamp);
  const versionCode = parseRunNumber(runNumber);
  const normalizedSha = parseSha(sha);
  const version = `${stableVersion}-f8y.${utcDay}.${runNumber}`;

  return {
    version,
    tag: `v${version}`,
    versionCode,
    sha: normalizedSha,
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
  return value;
}

function parseSourceVersion(sourceVersion: string): string {
  const match = SOURCE_VERSION_PATTERN.exec(sourceVersion);
  if (match === null || match[0] !== sourceVersion || match.groups === undefined) {
    throw new Error("sourceVersion must be a strict SemVer with a canonical numeric core.");
  }

  const { major, minor, patch, prerelease } = match.groups;
  if (prerelease !== undefined) {
    for (const identifier of prerelease.split(".")) {
      if (/^[0-9]+$/u.test(identifier) && identifier.startsWith("0") && identifier !== "0") {
        throw new Error("sourceVersion numeric prerelease identifiers cannot have leading zeros.");
      }
    }
  }

  return `${major}.${minor}.${patch}`;
}

function parseTimestampToUtcDay(timestamp: string): string {
  const match = TIMESTAMP_PATTERN.exec(timestamp);
  if (match === null || match[0] !== timestamp || match.groups === undefined) {
    throw new Error("timestamp must be an RFC3339 timestamp with an explicit timezone.");
  }

  const {
    year: yearText,
    month: monthText,
    day: dayText,
    hour: hourText,
    minute: minuteText,
    second: secondText,
    timezone,
  } = match.groups;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (year > 9999 || !isValidGregorianDate(year, month, day)) {
    throw new Error("timestamp must contain a valid Gregorian calendar date.");
  }
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error("timestamp must contain a valid time and cannot use a leap second.");
  }
  if (timezone === undefined) {
    throw new Error("timestamp must contain an explicit timezone.");
  }
  if (timezone !== "Z") {
    const offsetHour = Number(timezone.slice(1, 3));
    const offsetMinute = Number(timezone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      throw new Error("timestamp must contain a valid RFC3339 timezone offset.");
    }
  }

  // The calendar and wall-clock fields are checked above before Date can normalize them.
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("timestamp could not be converted to an instant.");
  }

  const utcDate = new Date(milliseconds);
  const utcYear = utcDate.getUTCFullYear();
  if (!Number.isInteger(utcYear) || utcYear < 1 || utcYear > 9999) {
    throw new Error("timestamp resolves to a UTC year outside 0001..9999.");
  }

  const utcMonth = utcDate.getUTCMonth() + 1;
  const utcDay = utcDate.getUTCDate();
  return `${String(utcYear).padStart(4, "0")}${String(utcMonth).padStart(2, "0")}${String(utcDay).padStart(2, "0")}`;
}

function isValidGregorianDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }

  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = daysInMonth[month - 1];
  return maximumDay !== undefined && day <= maximumDay;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function parseRunNumber(runNumber: string): number {
  if (!CANONICAL_RUN_NUMBER_PATTERN.test(runNumber)) {
    throw new Error("runNumber must be a canonical decimal from 1 to 2100000000.");
  }

  const versionCode = Number(runNumber);
  if (!Number.isSafeInteger(versionCode) || versionCode > MAX_VERSION_CODE) {
    throw new Error("runNumber must be a canonical decimal from 1 to 2100000000.");
  }
  return versionCode;
}

function parseSha(sha: string): string {
  if (sha.length !== 40 || !SHA_PATTERN.test(sha)) {
    throw new Error("sha must be exactly 40 hexadecimal characters.");
  }
  return sha.toLowerCase();
}

interface CliOptions {
  readonly timestamp: string;
  readonly runNumber: string;
  readonly sha: string;
  readonly githubOutput: string;
  readonly root: string | undefined;
}

function parseCliArgs(args: ReadonlyArray<string>): CliOptions {
  let timestamp: string | undefined;
  let runNumber: string | undefined;
  let sha: string | undefined;
  let githubOutput: string | undefined;
  let root: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    switch (flag) {
      case "--timestamp":
        if (timestamp !== undefined) throw new Error("Duplicate --timestamp flag.");
        timestamp = readFlagValue(args, index, flag);
        index += 1;
        break;
      case "--run-number":
        if (runNumber !== undefined) throw new Error("Duplicate --run-number flag.");
        runNumber = readFlagValue(args, index, flag);
        index += 1;
        break;
      case "--sha":
        if (sha !== undefined) throw new Error("Duplicate --sha flag.");
        sha = readFlagValue(args, index, flag);
        index += 1;
        break;
      case "--github-output":
        if (githubOutput !== undefined) throw new Error("Duplicate --github-output flag.");
        githubOutput = readFlagValue(args, index, flag);
        index += 1;
        break;
      case "--root":
        if (root !== undefined) throw new Error("Duplicate --root flag.");
        root = readFlagValue(args, index, flag);
        index += 1;
        break;
      default:
        if (flag !== undefined && flag.startsWith("--")) {
          throw new Error("Unknown command-line flag.");
        }
        throw new Error("Unexpected positional command-line argument.");
    }
  }

  if (timestamp === undefined) throw new Error("Missing required --timestamp flag.");
  if (runNumber === undefined) throw new Error("Missing required --run-number flag.");
  if (sha === undefined) throw new Error("Missing required --sha flag.");
  if (githubOutput === undefined) throw new Error("Missing required --github-output flag.");

  return { timestamp, runNumber, sha, githubOutput, root };
}

function readFlagValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(`${flag} requires a non-empty value.`);
  }
  return value;
}

function readDesktopPackageVersion(root: string): string {
  const packageJsonPath = NodePath.join(root, "apps/desktop/package.json");
  let packageJsonSource: string;
  try {
    packageJsonSource = NodeFS.readFileSync(packageJsonPath, "utf8");
  } catch {
    throw new Error("Unable to read apps/desktop/package.json.");
  }

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageJsonSource) as unknown;
  } catch {
    throw new Error("Unable to parse apps/desktop/package.json.");
  }

  if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
    throw new Error("apps/desktop/package.json must contain a string version.");
  }
  return packageJson.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeGithubOutput(result: F8yRelease): string {
  return (
    [
      `version=${result.version}`,
      `tag=${result.tag}`,
      `versionCode=${result.versionCode}`,
      `sha=${result.sha}`,
    ].join("\n") + "\n"
  );
}

function runCli(args: ReadonlyArray<string>): void {
  const options = parseCliArgs(args);
  const root = NodePath.resolve(options.root ?? DEFAULT_REPOSITORY_ROOT);
  const sourceVersion = readDesktopPackageVersion(root);
  const result = resolveF8yRelease({
    sourceVersion,
    timestamp: options.timestamp,
    runNumber: options.runNumber,
    sha: options.sha,
  });

  NodeFS.appendFileSync(options.githubOutput, serializeGithubOutput(result), "utf8");
  NodeProcess.stdout.write(`${JSON.stringify(result)}\n`);
}

function isMainModule(): boolean {
  const entrypoint = NodeProcess.argv[1];
  return (
    entrypoint !== undefined &&
    NodePath.resolve(entrypoint) === NodeURL.fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  try {
    runCli(NodeProcess.argv.slice(2));
  } catch (error: unknown) {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    NodeProcess.exit(1);
  }
}
