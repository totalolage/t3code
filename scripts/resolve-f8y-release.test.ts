// @effect-diagnostics nodeBuiltinImport:off - CLI tests use Node's disposable filesystem and child-process APIs.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveF8yRelease } from "./resolve-f8y-release.ts";

const CLI_PATH = NodeURL.fileURLToPath(new URL("./resolve-f8y-release.ts", import.meta.url));
const FIXTURE_PARENT = "/tmp/opencode/rewrite-f8y-releases/metadata";
const VALID_SHA = "a".repeat(40);
const UPPERCASE_SHA = VALID_SHA.toUpperCase();
const BASE_INPUT = {
  sourceVersion: "1.2.3",
  timestamp: "2026-09-12T12:34:56Z",
  runNumber: "17",
  sha: VALID_SHA,
} as const;

const temporaryFixtureRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryFixtureRoots) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
  temporaryFixtureRoots.clear();
});

describe("resolveF8yRelease", () => {
  it.each([
    ["a stable version", "1.2.3", "1.2.3-f8y.20260912.17"],
    ["valid prerelease and build metadata", "9.9.9-rc.4+build.007", "9.9.9-f8y.20260912.17"],
    [
      "large canonical numeric core fields",
      "12345678901234567890.20.30-alpha.0+build.1",
      "12345678901234567890.20.30-f8y.20260912.17",
    ],
  ] as const)(
    "strips only valid SemVer metadata from %s",
    (_description, sourceVersion, version) => {
      const result = resolveF8yRelease({ ...BASE_INPUT, sourceVersion });

      expect(result).toEqual({
        version,
        tag: `v${version}`,
        versionCode: 17,
        sha: VALID_SHA,
      });
    },
  );

  it.each([
    [
      "positive offset crossing into the previous UTC date",
      "2024-01-01T00:30:00+01:00",
      "20231231",
    ],
    ["negative offset crossing into the next UTC date", "2024-12-31T23:30:00-01:00", "20250101"],
    ["RFC3339 year zero crossing into the first UTC year", "0000-12-31T23:30:00-01:00", "00010101"],
    ["an RFC3339 fractional second", "2024-06-15T23:59:59.123456789+00:00", "20240615"],
  ] as const)("derives the deterministic UTC day for %s", (_description, timestamp, day) => {
    expect(resolveF8yRelease({ ...BASE_INPUT, timestamp }).version).toBe(`1.2.3-f8y.${day}.17`);
  });

  it.each(["2024-02-29T12:00:00Z", "2000-02-29T12:00:00Z"] as const)(
    "accepts a valid Gregorian leap day: %s",
    (timestamp) => {
      expect(() => resolveF8yRelease({ ...BASE_INPUT, timestamp })).not.toThrow();
    },
  );

  it.each([
    ["a non-leap-year February 29", "2023-02-29T12:00:00Z"],
    ["a century that is not divisible by 400", "1900-02-29T12:00:00Z"],
    ["an impossible April 31", "2024-04-31T12:00:00Z"],
    ["an impossible month", "2024-13-01T12:00:00Z"],
    ["an impossible day", "2024-01-00T12:00:00Z"],
    ["an hour outside RFC3339", "2024-01-01T24:00:00Z"],
    ["a minute outside RFC3339", "2024-01-01T00:60:00Z"],
    ["a leap second", "2024-01-01T00:00:60Z"],
    ["a missing timezone", "2024-01-01T00:00:00"],
    ["a timezone without a colon", "2024-01-01T00:00:00+0000"],
    ["a lowercase UTC designator", "2024-01-01T00:00:00z"],
    ["an offset hour outside RFC3339", "2024-01-01T00:00:00+24:00"],
    ["an offset minute outside RFC3339", "2024-01-01T00:00:00+01:60"],
    ["a UTC year below the output range", "0001-01-01T00:00:00+01:00"],
    ["a UTC year above the output range", "9999-12-31T23:59:59-01:00"],
  ] as const)("rejects %s", (_description, timestamp) => {
    expect(() => resolveF8yRelease({ ...BASE_INPUT, timestamp })).toThrow();
  });

  it.each([
    ["a leading-zero major", "01.2.3"],
    ["a leading-zero minor", "1.02.3"],
    ["a leading-zero patch", "1.2.03"],
    ["a numeric prerelease with leading zeros", "1.2.3-01"],
    ["a numeric prerelease component with leading zeros", "1.2.3-alpha.01"],
    ["a missing patch", "1.2"],
    ["an empty prerelease", "1.2.3-"],
    ["an empty build", "1.2.3+"],
    ["an empty prerelease identifier", "1.2.3-alpha..1"],
    ["an empty build identifier", "1.2.3+build..1"],
    ["a second build separator", "1.2.3-alpha+build+more"],
    ["an unsupported identifier character", "1.2.3-alpha_1"],
    ["a trailing newline", "1.2.3\n"],
  ] as const)("rejects malformed source SemVer: %s", (_description, sourceVersion) => {
    expect(() => resolveF8yRelease({ ...BASE_INPUT, sourceVersion })).toThrow();
  });

  it.each([
    ["the minimum run", "1", 1],
    ["the maximum run", "2100000000", 2_100_000_000],
  ] as const)(
    "accepts %s without changing its canonical text",
    (_description, runNumber, versionCode) => {
      const result = resolveF8yRelease({ ...BASE_INPUT, runNumber });

      expect(result.version).toBe(`1.2.3-f8y.20260912.${runNumber}`);
      expect(result.versionCode).toBe(versionCode);
    },
  );

  it.each([
    ["zero", "0"],
    ["above the maximum", "2100000001"],
    ["a leading zero", "017"],
    ["a plus sign", "+17"],
    ["a minus sign", "-1"],
    ["a decimal", "17.0"],
    ["scientific notation", "1e2"],
    ["surrounding whitespace", " 17"],
    ["a trailing newline", "17\n"],
    ["an empty value", ""],
  ] as const)("rejects run number with %s", (_description, runNumber) => {
    expect(() => resolveF8yRelease({ ...BASE_INPUT, runNumber })).toThrow();
  });

  it("normalizes an uppercase SHA after validating its exact length", () => {
    expect(resolveF8yRelease({ ...BASE_INPUT, sha: UPPERCASE_SHA }).sha).toBe(VALID_SHA);
  });

  it.each([
    ["a short value", VALID_SHA.slice(0, 39)],
    ["a long value", `${VALID_SHA}a`],
    ["a non-hex character", "g".repeat(40)],
    ["a newline injection", `${VALID_SHA.slice(0, 39)}\n`],
    ["a delimiter injection", `${VALID_SHA.slice(0, 39)};`],
  ] as const)("rejects SHA with %s", (_description, sha) => {
    expect(() => resolveF8yRelease({ ...BASE_INPUT, sha })).toThrow();
  });

  it("is deterministic for identical inputs and does not mutate them", () => {
    const input = { ...BASE_INPUT };
    const first = resolveF8yRelease(input);
    const second = resolveF8yRelease(input);

    expect(second).toEqual(first);
    expect(input).toEqual(BASE_INPUT);
  });
});

describe("resolve-f8y-release CLI", () => {
  it("reads only the fixture desktop version, appends GitHub output, and prints JSON", () => {
    const root = makeFixtureRoot("8.9.10-rc.4+build.007");
    NodeFS.writeFileSync(
      NodePath.join(root, "package.json"),
      JSON.stringify({ version: "99.99.99" }),
    );
    const outputPath = NodePath.join(root, "github-output");
    NodeFS.writeFileSync(outputPath, "existing=1\n");

    const completed = runCli(
      [
        "--timestamp",
        BASE_INPUT.timestamp,
        "--run-number",
        BASE_INPUT.runNumber,
        "--sha",
        UPPERCASE_SHA,
        "--github-output",
        outputPath,
        "--root",
        root,
      ],
      NodeOS.tmpdir(),
    );
    const expected = {
      version: "8.9.10-f8y.20260912.17",
      tag: "v8.9.10-f8y.20260912.17",
      versionCode: 17,
      sha: VALID_SHA,
    };

    expect(completed.status).toBe(0);
    expect(JSON.parse(completed.stdout)).toEqual(expected);
    expect(NodeFS.readFileSync(outputPath, "utf8")).toBe(
      `existing=1\nversion=${expected.version}\ntag=${expected.tag}\nversionCode=17\nsha=${VALID_SHA}\n`,
    );
  });

  it("leaves an existing GitHub output unchanged when validation fails", () => {
    const root = makeFixtureRoot("8.9.10");
    const outputPath = NodePath.join(root, "github-output");
    const original = "existing=1\n";
    NodeFS.writeFileSync(outputPath, original);

    const completed = runCli(
      [
        "--timestamp",
        "2024-02-30T12:00:00Z",
        "--run-number",
        BASE_INPUT.runNumber,
        "--sha",
        VALID_SHA,
        "--github-output",
        outputPath,
        "--root",
        root,
      ],
      NodeOS.tmpdir(),
    );

    expect(completed.status).not.toBe(0);
    expect(NodeFS.readFileSync(outputPath, "utf8")).toBe(original);
  });

  it("resolves the default repository root from import.meta.url, not cwd", () => {
    const fixture = makeFixtureRoot("unused");
    const outputPath = NodePath.join(fixture, "github-output");
    const sourceVersion = readDesktopPackageVersionFromImportMetaUrl();
    const versionCore = deriveCanonicalNumericCore(sourceVersion);
    const expectedVersion = `${versionCore}-f8y.20260912.17`;

    const completed = runCli(
      [
        "--timestamp",
        BASE_INPUT.timestamp,
        "--run-number",
        BASE_INPUT.runNumber,
        "--sha",
        VALID_SHA,
        "--github-output",
        outputPath,
      ],
      NodeOS.tmpdir(),
    );

    expect(completed.status).toBe(0);
    expect(JSON.parse(completed.stdout)).toEqual({
      version: expectedVersion,
      tag: `v${expectedVersion}`,
      versionCode: 17,
      sha: VALID_SHA,
    });
  });

  it("rejects a missing required flag before touching output", () => {
    const root = makeFixtureRoot("8.9.10");
    const outputPath = NodePath.join(root, "github-output");
    const original = "existing=1\n";
    NodeFS.writeFileSync(outputPath, original);
    const completed = runCli(
      [
        "--timestamp",
        BASE_INPUT.timestamp,
        "--run-number",
        BASE_INPUT.runNumber,
        "--github-output",
        outputPath,
        "--root",
        root,
      ],
      NodeOS.tmpdir(),
    );

    expect(completed.status).not.toBe(0);
    expect(NodeFS.readFileSync(outputPath, "utf8")).toBe(original);
  });

  it("rejects a missing flag value before touching output", () => {
    const root = makeFixtureRoot("8.9.10");
    const outputPath = NodePath.join(root, "github-output");
    const original = "existing=1\n";
    NodeFS.writeFileSync(outputPath, original);
    const completed = runCli(
      [
        "--timestamp",
        BASE_INPUT.timestamp,
        "--run-number",
        BASE_INPUT.runNumber,
        "--sha",
        VALID_SHA,
        "--github-output",
      ],
      NodeOS.tmpdir(),
    );

    expect(completed.status).not.toBe(0);
    expect(NodeFS.readFileSync(outputPath, "utf8")).toBe(original);
  });

  it.each([
    ["an unknown flag", ["--unknown", "value"]],
    ["a duplicate flag", ["--sha", VALID_SHA]],
    ["a positional argument", ["extra"]],
    ["an equals-form flag", [`--timestamp=${BASE_INPUT.timestamp}`]],
  ] as const)("rejects %s without touching output", (_description, extraArgs) => {
    const root = makeFixtureRoot("8.9.10");
    const outputPath = NodePath.join(root, "github-output");
    const original = "existing=1\n";
    NodeFS.writeFileSync(outputPath, original);
    const completed = runCli([...validCliArgs(outputPath, root), ...extraArgs], NodeOS.tmpdir());

    expect(completed.status).not.toBe(0);
    expect(NodeFS.readFileSync(outputPath, "utf8")).toBe(original);
  });
});

function makeFixtureRoot(desktopVersion: string): string {
  NodeFS.mkdirSync(FIXTURE_PARENT, { recursive: true });
  const root = NodeFS.mkdtempSync(NodePath.join(FIXTURE_PARENT, "cli-"));
  temporaryFixtureRoots.add(root);
  const desktopDirectory = NodePath.join(root, "apps", "desktop");
  NodeFS.mkdirSync(desktopDirectory, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(desktopDirectory, "package.json"),
    `${JSON.stringify({ name: "fixture-desktop", version: desktopVersion })}\n`,
  );
  return root;
}

function validCliArgs(outputPath: string, root: string): ReadonlyArray<string> {
  return [
    "--timestamp",
    BASE_INPUT.timestamp,
    "--run-number",
    BASE_INPUT.runNumber,
    "--sha",
    VALID_SHA,
    "--github-output",
    outputPath,
    "--root",
    root,
  ];
}

function readDesktopPackageVersionFromImportMetaUrl(): string {
  const packageJson: unknown = JSON.parse(
    NodeFS.readFileSync(new URL("../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  if (!isRecord(packageJson) || typeof packageJson.version !== "string") {
    throw new Error("The desktop package fixture must contain a string version.");
  }
  return packageJson.version;
}

function deriveCanonicalNumericCore(sourceVersion: string): string {
  const match = /^(?<core>(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?=$|[-+])/u.exec(
    sourceVersion,
  );
  const core = match?.groups?.core;
  if (typeof core !== "string") {
    throw new Error("The desktop package version must have a canonical numeric core.");
  }
  return core;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runCli(args: ReadonlyArray<string>, cwd: string) {
  return NodeChildProcess.spawnSync(NodeProcess.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
  });
}
