// @effect-diagnostics nodeBuiltinImport:off - These tests use disposable real files at the verifier boundary.

import { createPackage } from "@electron/asar";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const osMockState = vi.hoisted(() => ({ tmpdir: "" }));
vi.mock("node:os", async () => ({
  ...(await vi.importActual<typeof import("node:os")>("node:os")),
  tmpdir: () => osMockState.tmpdir,
}));

import {
  parseF8yPlatformVersion,
  normalizeCertificateSha256,
  validateAndroidBadging,
  validateAndroidSigner,
  validateArm64Architectures,
  validateElfX64,
  validateLinuxPackage,
  validateLinuxUpdater,
  validateMacEntitlements,
  validateMacInfoPlist,
  validateMacSignature,
} from "./lib/f8y-platform-metadata.ts";
import {
  parsePlatformArguments,
  runPlatformCli,
  verifyF8yPlatform,
  type CommandInput,
  type CommandRunner,
} from "./verify-f8y-platform.ts";

const fixtureBase = "/tmp/opencode/rewrite-f8y-releases/platform";
let fixtureParent = "";
const validVersion = "1.2.3-f8y.20260912.7";
const nextVersion = "1.2.3-f8y.20260912.8";
const previousVersion = "1.2.3-f8y.20260912.6";
const expectedCertificate = "ab".repeat(32);
const alternateCertificate = "cd".repeat(32);
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  await NodeFSP.mkdir(fixtureBase, { recursive: true });
  fixtureParent = await NodeFSP.mkdtemp(NodePath.join(fixtureBase, "platform-test-"));
  osMockState.tmpdir = fixtureParent;
});

afterEach(async () => {
  const trackedDirectories = temporaryDirectories.splice(0);
  await Promise.all(
    trackedDirectories.map((directory) => NodeFSP.rm(directory, { force: true, recursive: true })),
  );

  const entries = await NodeFSP.readdir(fixtureParent, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      NodeFSP.rm(NodePath.join(fixtureParent, entry.name), { force: true, recursive: true }),
    ),
  );
});

afterAll(async () => {
  await NodeFSP.rm(fixtureParent, { force: true, recursive: true });
});

async function makeFixtureDirectory(prefix = "fixture-"): Promise<string> {
  const directory = await NodeFSP.mkdtemp(NodePath.join(fixtureParent, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSyntheticArtifact(
  directory: string,
  extension: string,
  basename = "artifact",
): Promise<string> {
  const artifact = NodePath.join(directory, `${basename}${extension}`);
  await NodeFSP.writeFile(artifact, "synthetic regular artifact\n", "utf8");
  return artifact;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

async function verifierTemporaryDirectories(): Promise<string[]> {
  const entries = await NodeFSP.readdir(fixtureParent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("f8y-platform-"))
    .map((entry) => NodePath.join(fixtureParent, entry.name));
}

function makeElfContents(marker = 0x41): Buffer {
  const contents = Buffer.alloc(64, marker);
  contents.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  contents.writeUInt16LE(2, 16);
  contents.writeUInt16LE(62, 18);
  contents.writeUInt32LE(1, 20);
  contents.writeUInt16LE(64, 40);
  return contents;
}

function makeValidUpdater(overrides: Readonly<Record<string, string>> = {}): string {
  const lines = [
    `provider: ${overrides.provider ?? "github"}`,
    `owner: ${overrides.owner ?? "totalolage"}`,
    `repo: ${overrides.repo ?? "t3code"}`,
    `channel: ${overrides.channel ?? "f8y"}`,
  ];
  for (const key of ["host", "protocol", "updaterCacheDirName"] as const) {
    const value = overrides[key];
    if (value !== undefined) lines.push(`${key}: ${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function makeValidPackage(version = validVersion): string {
  return `${JSON.stringify({ name: "dev.f8y.t3code", version })}\n`;
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  await NodeFSP.mkdir(destination, { recursive: true });
  const entries = await NodeFSP.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    await NodeFSP.cp(NodePath.join(source, entry.name), NodePath.join(destination, entry.name), {
      recursive: true,
    });
  }
}

describe("f8y platform metadata", () => {
  describe("version parsing", () => {
    it("accepts canonical versions, leap days, and numeric boundaries", () => {
      expect(parseF8yPlatformVersion(validVersion)).toEqual({
        version: validVersion,
        versionCode: 7,
      });
      expect(parseF8yPlatformVersion("1.2.3-f8y.20240229.1").versionCode).toBe(1);
      expect(parseF8yPlatformVersion("1.2.3-f8y.20000229.2100000000").versionCode).toBe(
        2_100_000_000,
      );
      expect(parseF8yPlatformVersion("1.2.3-f8y.00010101.1").versionCode).toBe(1);
      expect(parseF8yPlatformVersion("1.2.3-f8y.99991231.1").versionCode).toBe(1);
    });

    it("rejects malformed, trailing-newline, leading-zero, impossible-date, and overflowing runs", () => {
      const invalidVersions = [
        "1.2.3",
        "01.2.3-f8y.20260912.1",
        "1.02.3-f8y.20260912.1",
        "1.2.03-f8y.20260912.1",
        "1.2.3-f8y.20260912.01",
        "1.2.3-f8y.20260912.0",
        "1.2.3-f8y.20260912.2100000001",
        "1.2.3-f8y.20260912.9007199254740992",
        "1.2.3-f8y.19000229.1",
        "1.2.3-f8y.20260230.1",
        "1.2.3-f8y.20261301.1",
        "1.2.3-f8y.00000229.1",
        `${validVersion}\n`,
        `v${validVersion}`,
      ];

      for (const version of invalidVersions) {
        expect(() => parseF8yPlatformVersion(version), version).toThrow();
      }
    });
  });

  describe("certificate fingerprints", () => {
    it("normalizes plain and colon-separated SHA-256 fingerprints", () => {
      expect(normalizeCertificateSha256(expectedCertificate.toUpperCase())).toBe(
        expectedCertificate,
      );
      expect(normalizeCertificateSha256("AB:".repeat(31) + "AB")).toBe(expectedCertificate);
      expect(normalizeCertificateSha256("CD:".repeat(31) + "CD")).toBe(alternateCertificate);
    });

    it("rejects malformed fingerprints without trimming or guessing", () => {
      for (const value of [
        "",
        "ab".repeat(31),
        "ab".repeat(33),
        "gg".repeat(32),
        `${expectedCertificate}\n`,
        ` ${expectedCertificate}`,
        "ab:".repeat(32),
        "ab:".repeat(30) + "ab",
        "ab:cd".repeat(16),
      ]) {
        expect(() => normalizeCertificateSha256(value), value).toThrow();
      }
    });
  });

  describe("macOS metadata", () => {
    it("requires the f8y bundle id and release short version but not an exact CFBundleVersion", () => {
      expect(
        validateMacInfoPlist(
          {
            CFBundleIdentifier: "dev.f8y.t3code",
            CFBundleShortVersionString: validVersion,
            CFBundleVersion: "unrelated-build-number",
            CFBundleExecutable: "t3code",
          },
          validVersion,
        ),
      ).toBe("t3code");

      for (const value of [
        {},
        { CFBundleIdentifier: "dev.f8y.t3code" },
        { CFBundleShortVersionString: validVersion },
        { CFBundleIdentifier: "dev.other.t3code", CFBundleShortVersionString: validVersion },
        { CFBundleIdentifier: "dev.f8y.t3code", CFBundleShortVersionString: nextVersion },
      ]) {
        expect(() => validateMacInfoPlist(value, validVersion), JSON.stringify(value)).toThrow();
      }
    });

    it("rejects missing, empty, and traversal-shaped executable names", () => {
      const executableValues: unknown[] = [
        undefined,
        "",
        ".",
        "..",
        "MacOS/t3code",
        "MacOS\\t3code",
      ];
      for (const executable of executableValues) {
        const plist = {
          CFBundleIdentifier: "dev.f8y.t3code",
          CFBundleShortVersionString: validVersion,
          ...(executable === undefined ? {} : { CFBundleExecutable: executable }),
        };
        expect(() => validateMacInfoPlist(plist, validVersion), String(executable)).toThrow();
      }
    });

    it("accepts exactly one ad-hoc signature line and rejects missing, duplicate, or other signatures", () => {
      expect(validateMacSignature("Executable=/tmp/t3code\nSignature=adhoc\n")).toBeUndefined();

      for (const output of [
        "Executable=/tmp/t3code\n",
        "Signature=adhoc\nSignature=adhoc\n",
        "Signature=adhoc\nSignature=CMS\n",
        "Signature=CMS\n",
        "Signature=adhoc\nSignature=adhoc-extra\n",
      ]) {
        expect(() => validateMacSignature(output), output).toThrow();
      }
    });

    it("accepts only a single arm64 architecture and rejects x64 and fat outputs", () => {
      expect(validateArm64Architectures("arm64\n")).toBeUndefined();
      for (const output of ["x86_64\n", "arm64 x86_64\n", "arm64\narm64\n"]) {
        expect(() => validateArm64Architectures(output), output).toThrow();
      }
    });

    it("rejects associated domains even when the entitlement value is empty", () => {
      expect(validateMacEntitlements({})).toBeUndefined();
      expect(() =>
        validateMacEntitlements({ "com.apple.developer.associated-domains": [] }),
      ).toThrow();
      expect(() =>
        validateMacEntitlements({ "com.apple.developer.associated-domains": "" }),
      ).toThrow();
    });
  });

  describe("Linux metadata", () => {
    it("requires the package version and rejects a missing or mismatched version", () => {
      expect(validateLinuxPackage({ version: validVersion }, validVersion)).toBeUndefined();
      expect(() => validateLinuxPackage({}, validVersion)).toThrow();
      expect(() => validateLinuxPackage({ version: nextVersion }, validVersion)).toThrow();
    });

    it("requires every updater field to be present and exact", () => {
      const updater = {
        provider: "github",
        owner: "totalolage",
        repo: "t3code",
        channel: "f8y",
      };
      expect(validateLinuxUpdater(updater)).toBeUndefined();

      for (const field of Object.keys(updater)) {
        const missing: Record<string, unknown> = { ...updater };
        delete missing[field];
        expect(() => validateLinuxUpdater(missing), `missing ${field}`).toThrow();

        const mismatched: Record<string, unknown> = { ...updater, [field]: "wrong" };
        expect(() => validateLinuxUpdater(mismatched), `wrong ${field}`).toThrow();
      }
    });

    it("allows only the explicit GitHub HTTPS overrides and ignores a harmless cache name", () => {
      const updater = {
        provider: "github",
        owner: "totalolage",
        repo: "t3code",
        channel: "f8y",
      };
      expect(
        validateLinuxUpdater({
          ...updater,
          host: "github.com",
          protocol: "https",
          updaterCacheDirName: "f8y-cache",
        }),
      ).toBeUndefined();
      expect(() => validateLinuxUpdater({ ...updater, host: "mirror.example" })).toThrow();
      expect(() => validateLinuxUpdater({ ...updater, protocol: "http" })).toThrow();
      expect(() => validateLinuxUpdater({ ...updater, host: null })).toThrow();
      expect(() => validateLinuxUpdater({ ...updater, protocol: null })).toThrow();
    });

    it("requires a complete little-endian ELF64 x86_64 header", () => {
      expect(validateElfX64(makeElfContents())).toBeUndefined();

      const cases: ReadonlyArray<{
        readonly label: string;
        readonly mutate: (bytes: Buffer) => void;
      }> = [
        { label: "truncated", mutate: (bytes) => bytes.subarray(0, 63) },
        {
          label: "wrong class",
          mutate: (bytes) => {
            bytes[4] = 1;
          },
        },
        {
          label: "wrong endian",
          mutate: (bytes) => {
            bytes[5] = 2;
          },
        },
        {
          label: "wrong machine",
          mutate: (bytes) => {
            bytes.writeUInt16LE(3, 18);
          },
        },
      ];

      for (const testCase of cases) {
        const bytes = Buffer.from(makeElfContents());
        if (testCase.label === "truncated") {
          expect(() => validateElfX64(bytes.subarray(0, 63)), testCase.label).toThrow();
        } else {
          testCase.mutate(bytes);
          expect(() => validateElfX64(bytes), testCase.label).toThrow();
        }
      }
    });

    it("rejects malformed and duplicate updater YAML fields at the artifact boundary", async () => {
      const malformed = await makeLinuxFixture({ packaging: "directory" });
      await NodeFSP.writeFile(
        NodePath.join(malformed.builder, "resources/app-update.yml"),
        "provider: [unterminated\n",
        "utf8",
      );
      const malformedRunner = makeLinuxExtractionRunner(malformed);
      await expect(verifyF8yPlatform(malformed.options, malformedRunner.runner)).rejects.toThrow();

      const duplicate = await makeLinuxFixture({ packaging: "directory" });
      await NodeFSP.writeFile(
        NodePath.join(duplicate.builder, "resources/app-update.yml"),
        "provider: github\nprovider: github\nowner: totalolage\nrepo: t3code\nchannel: f8y\n",
        "utf8",
      );
      const duplicateRunner = makeLinuxExtractionRunner(duplicate);
      await expect(verifyF8yPlatform(duplicate.options, duplicateRunner.runner)).rejects.toThrow();
    });
  });

  describe("Android metadata", () => {
    it("uses the first SHA-256 digest reported by apksigner", () => {
      const output =
        "Verifies\nNumber of signers: 1\nSigner #1 certificate SHA-256 digest: " +
        expectedCertificate.toUpperCase() +
        "\n";
      expect(validateAndroidSigner(output)).toBe(expectedCertificate);
      expect(
        validateAndroidSigner(
          `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${"AB:".repeat(31)}AB\n`,
        ),
      ).toBe(expectedCertificate);
      expect(
        validateAndroidSigner(
          `Number of signers: 2\nSigner #1 certificate SHA-256 digest: ${alternateCertificate}\nSigner #2 certificate SHA-256 digest: ${expectedCertificate}\n`,
        ),
      ).toBe(alternateCertificate);
    });

    it("rejects missing or malformed SHA-256 digests", () => {
      const cases = [
        `Number of signers: 1\n`,
        `Number of signers: 1\nSigner #1 certificate SHA-256 digest: not-a-sha256\n`,
      ];

      for (const output of cases) {
        expect(() => validateAndroidSigner(output), output).toThrow();
      }
    });

    it("requires one package line with exactly one quoted canonical identity and version", () => {
      const packageLine = `package: name='dev.f8y.t3code' versionCode='7' versionName='${validVersion}'`;
      expect(validateAndroidBadging(packageLine, validVersion)).toBe(7);

      const cases = [
        "",
        `${packageLine}\n${packageLine}`,
        "package: versionCode='7' versionName='" + validVersion + "'",
        "package: name='dev.f8y.t3code' versionName='" + validVersion + "'",
        "package: name='dev.f8y.t3code' versionCode='7'",
        `package: name='dev.f8y.t3code' versionCode='7' versionName='${validVersion}' name='dev.f8y.t3code'`,
        `package: name=dev.f8y.t3code versionCode='7' versionName='${validVersion}'`,
        `package: name='dev.f8y.t3code' versionCode=7 versionName='${validVersion}'`,
        `package: name='dev.f8y.t3code' versionCode='7' versionName=${validVersion}`,
      ];

      for (const output of cases) {
        expect(() => validateAndroidBadging(output, validVersion), output).toThrow();
      }
    });

    it("rejects wrong package identity, version, and versionCode", () => {
      const cases = [
        `package: name='dev.other.t3code' versionCode='7' versionName='${validVersion}'`,
        `package: name='dev.f8y.t3code' versionCode='7' versionName='${nextVersion}'`,
        `package: name='dev.f8y.t3code' versionCode='8' versionName='${validVersion}'`,
      ];

      for (let index = 0; index < cases.length; index += 1) {
        const output = cases[index];
        if (output === undefined) continue;
        expect(() => validateAndroidBadging(output, validVersion), output).toThrow();
      }
    });
  });
});

describe("f8y platform CLI parsing", () => {
  const macArgs = ["--platform", "mac", "--version", validVersion, "--artifact", "artifact.dmg"];
  const linuxArgs = [
    "--platform",
    "linux",
    "--version",
    validVersion,
    "--artifact",
    "artifact.appimage",
    "--unpacked-directory",
    "builder",
  ];
  const androidArgs = [
    "--platform",
    "android",
    "--version",
    validVersion,
    "--artifact",
    "artifact.apk",
    "--android-build-tools",
    "build-tools",
    "--previous-apk",
    "previous.apk",
  ];

  it("parses valid macOS, Linux, and Android argument sets", () => {
    expect(parsePlatformArguments(macArgs)).toEqual({
      platform: "mac",
      version: validVersion,
      artifact: "artifact.dmg",
    });
    expect(parsePlatformArguments(linuxArgs)).toEqual({
      platform: "linux",
      version: validVersion,
      artifact: "artifact.appimage",
      unpackedDirectory: "builder",
    });
    expect(parsePlatformArguments(androidArgs)).toEqual({
      platform: "android",
      version: validVersion,
      artifact: "artifact.apk",
      androidBuildTools: "build-tools",
      previousApk: "previous.apk",
    });
  });

  it("rejects missing, unknown, duplicate, and wrong-platform arguments before the runner", async () => {
    const cases: ReadonlyArray<{ readonly label: string; readonly args: readonly string[] }> = [
      { label: "no arguments", args: [] },
      {
        label: "missing platform",
        args: ["--version", validVersion, "--artifact", "artifact.dmg"],
      },
      { label: "missing version", args: ["--platform", "mac", "--artifact", "artifact.dmg"] },
      { label: "missing artifact", args: ["--platform", "mac", "--version", validVersion] },
      { label: "missing value", args: ["--platform"] },
      { label: "unknown argument", args: [...macArgs, "--unknown"] },
      { label: "duplicate platform", args: [...macArgs, "--platform", "mac"] },
      { label: "duplicate version", args: [...macArgs, "--version", validVersion] },
      { label: "duplicate artifact", args: [...macArgs, "--artifact", "artifact.dmg"] },
      {
        label: "wrong platform",
        args: ["--platform", "windows", "--version", validVersion, "--artifact", "artifact.dmg"],
      },
      { label: "mac receives Linux flag", args: [...macArgs, "--unpacked-directory", "builder"] },
      {
        label: "Linux receives Android flag",
        args: [...linuxArgs, "--android-build-tools", "build-tools"],
      },
      {
        label: "Android receives Linux flag",
        args: [...androidArgs, "--unpacked-directory", "builder"],
      },
      {
        label: "mac receives previous APK",
        args: [...macArgs, "--previous-apk", "previous.apk"],
      },
      {
        label: "duplicate previous APK",
        args: [...androidArgs, "--previous-apk", "again.apk"],
      },
      {
        label: "removed certificate argument",
        args: [...androidArgs, "--expected-certificate-sha256", expectedCertificate],
      },
    ];

    for (const testCase of cases) {
      const calls: CommandInput[] = [];
      const runner: CommandRunner = async (input) => {
        calls.push(input);
        throw new Error("runner must not be reached for invalid CLI input");
      };
      await expect(runPlatformCli(testCase.args, runner), testCase.label).rejects.toThrow();
      expect(calls, testCase.label).toHaveLength(0);
    }
  });
});

interface MacFixture {
  readonly directory: string;
  readonly artifact: string;
  readonly options: {
    readonly platform: "mac";
    readonly version: string;
    readonly artifact: string;
  };
}

interface MacRunnerOptions {
  readonly appCount?: number;
  readonly includeUpdater?: boolean;
  readonly infoVersion?: string;
  readonly entitlements?: Readonly<Record<string, unknown>>;
  readonly failAttach?: boolean;
  readonly failDetach?: boolean;
  readonly failCodesignVerify?: boolean;
}

async function makeMacFixture(): Promise<MacFixture> {
  const directory = await makeFixtureDirectory("mac-");
  const artifact = await writeSyntheticArtifact(directory, ".dmg");
  return {
    directory,
    artifact,
    options: { platform: "mac", version: validVersion, artifact },
  };
}

async function writeMacApp(
  mountpoint: string,
  name: string,
  options: Pick<MacRunnerOptions, "includeUpdater"> = {},
): Promise<void> {
  const appPath = NodePath.join(mountpoint, name);
  const contents = NodePath.join(appPath, "Contents");
  await NodeFSP.mkdir(NodePath.join(contents, "MacOS"), { recursive: true });
  await NodeFSP.mkdir(NodePath.join(contents, "Resources"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(contents, "Info.plist"), "synthetic plist\n", "utf8");
  await NodeFSP.writeFile(
    NodePath.join(contents, "MacOS", "t3code"),
    "synthetic executable\n",
    "utf8",
  );
  if (options.includeUpdater === true) {
    await NodeFSP.writeFile(
      NodePath.join(contents, "Resources", "app-update.yml"),
      makeValidUpdater(),
      "utf8",
    );
  }
}

function makeMacRunner(
  fixture: MacFixture,
  options: MacRunnerOptions = {},
): { readonly calls: CommandInput[]; readonly runner: CommandRunner } {
  const calls: CommandInput[] = [];
  const appCount = options.appCount ?? 1;
  const runner: CommandRunner = async (input) => {
    calls.push({
      command: input.command,
      args: [...input.args],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });

    if (input.command === "hdiutil" && input.args[0] === "verify") {
      expect(input.args).toEqual(["verify", fixture.artifact]);
      return { stdout: "", stderr: "" };
    }

    if (input.command === "hdiutil" && input.args[0] === "attach") {
      expect(input.args).toEqual([
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        input.args[4],
        fixture.artifact,
      ]);
      if (options.failAttach === true) throw new Error("synthetic attach failure");
      const mountpoint = input.args[4];
      if (mountpoint === undefined) throw new Error("missing synthetic mountpoint");
      await NodeFSP.mkdir(mountpoint, { recursive: true });
      for (let index = 0; index < appCount; index += 1) {
        await writeMacApp(mountpoint, `T3 Code ${index + 1}.app`, options);
      }
      return { stdout: "", stderr: "" };
    }

    if (input.command === "hdiutil" && input.args[0] === "detach") {
      if (options.failDetach === true) throw new Error("synthetic detach failure");
      return { stdout: "", stderr: "" };
    }

    if (input.command === "plutil" && input.args[0] === "-convert") {
      const inspectedPath = input.args[input.args.length - 1];
      if (inspectedPath === undefined) throw new Error("missing plutil path");
      if (inspectedPath.endsWith("Info.plist")) {
        return {
          stdout: JSON.stringify({
            CFBundleIdentifier: "dev.f8y.t3code",
            CFBundleShortVersionString: options.infoVersion ?? validVersion,
            CFBundleVersion: "not-the-release-version",
            CFBundleExecutable: "t3code",
          }),
          stderr: "",
        };
      }
      if (inspectedPath.endsWith("entitlements.plist")) {
        return { stdout: JSON.stringify(options.entitlements ?? {}), stderr: "" };
      }
      throw new Error(`unexpected plutil path ${inspectedPath}`);
    }

    if (input.command === "lipo") {
      expect(input.args[0]).toBe("-archs");
      return { stdout: "arm64\n", stderr: "" };
    }

    if (input.command === "codesign" && input.args[0] === "--verify") {
      expect(input.args).toEqual(["--verify", "--deep", "--strict", input.args[3]]);
      if (options.failCodesignVerify === true)
        throw new Error("synthetic codesign verification failure");
      return { stdout: "", stderr: "" };
    }

    if (
      input.command === "codesign" &&
      input.args[0] === "--display" &&
      input.args[1] === "--verbose=4"
    ) {
      return { stdout: "Executable=/tmp/t3code\nSignature=adhoc\n", stderr: "" };
    }

    if (
      input.command === "codesign" &&
      input.args[0] === "--display" &&
      input.args[1] === "--entitlements"
    ) {
      expect(input.args).toEqual(["--display", "--entitlements", ":-", input.args[3]]);
      return { stdout: "<plist>synthetic entitlements</plist>\n", stderr: "" };
    }

    throw new Error(`unexpected macOS runner command ${input.command} ${input.args.join(" ")}`);
  };
  return { calls, runner };
}

describe("f8y platform macOS orchestration", () => {
  it("verifies before attaching read-only and no-browse, inspects the bundle, then detaches and cleans up", async () => {
    const fixture = await makeMacFixture();
    const { calls, runner } = makeMacRunner(fixture);
    await expect(verifyF8yPlatform(fixture.options, runner)).resolves.toMatchObject({
      platform: "mac",
      version: validVersion,
      artifact: fixture.artifact,
    });

    const verifyIndex = calls.findIndex(
      (call) => call.command === "hdiutil" && call.args[0] === "verify",
    );
    const attachIndex = calls.findIndex(
      (call) => call.command === "hdiutil" && call.args[0] === "attach",
    );
    expect(verifyIndex).toBe(0);
    expect(attachIndex).toBeGreaterThan(verifyIndex);
    expect(calls[attachIndex]?.command).toBe("hdiutil");
    expect(calls[attachIndex]?.args.slice(0, 4)).toEqual([
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
    ]);

    expect(calls).toContainEqual({
      command: "codesign",
      args: ["--verify", "--deep", "--strict", expect.any(String)],
    });
    expect(calls).toContainEqual({
      command: "codesign",
      args: ["--display", "--verbose=4", expect.any(String)],
    });
    expect(calls).toContainEqual({
      command: "codesign",
      args: ["--display", "--entitlements", ":-", expect.any(String)],
    });
    expect(calls.at(-1)).toMatchObject({
      command: "hdiutil",
      args: ["detach", expect.any(String)],
    });
    expect(await verifierTemporaryDirectories()).toEqual([]);
  });

  it("detaches and cleans up after codesign, metadata, updater, bundle-count, or entitlement failures", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly options: MacRunnerOptions;
    }> = [
      { label: "codesign failure", options: { failCodesignVerify: true } },
      { label: "wrong version", options: { infoVersion: nextVersion } },
      { label: "updater present", options: { includeUpdater: true } },
      { label: "missing app", options: { appCount: 0 } },
      { label: "duplicate app", options: { appCount: 2 } },
      {
        label: "forbidden entitlement",
        options: { entitlements: { "com.apple.developer.associated-domains": [] } },
      },
    ];

    for (const testCase of cases) {
      const fixture = await makeMacFixture();
      const { calls, runner } = makeMacRunner(fixture, testCase.options);
      await expect(verifyF8yPlatform(fixture.options, runner), testCase.label).rejects.toThrow();
      expect(
        calls.some((call) => call.command === "hdiutil" && call.args[0] === "detach"),
        testCase.label,
      ).toBe(true);
      expect(await verifierTemporaryDirectories(), testCase.label).toEqual([]);
    }
  });

  it("cleans up without detaching when attach fails", async () => {
    const fixture = await makeMacFixture();
    const { calls, runner } = makeMacRunner(fixture, { failAttach: true });
    await expect(verifyF8yPlatform(fixture.options, runner)).rejects.toThrow("attach failure");
    expect(calls.some((call) => call.command === "hdiutil" && call.args[0] === "detach")).toBe(
      false,
    );
    expect(await verifierTemporaryDirectories()).toEqual([]);
  });

  it("leaves the mount temporary directory intact when detach fails, then permits safe test cleanup", async () => {
    const fixture = await makeMacFixture();
    const { calls, runner } = makeMacRunner(fixture, { failDetach: true });
    await expect(verifyF8yPlatform(fixture.options, runner)).rejects.toThrow("Could not detach");

    const detach = calls.find((call) => call.command === "hdiutil" && call.args[0] === "detach");
    const mountpoint = detach?.args[1];
    expect(mountpoint).toBeDefined();
    if (mountpoint === undefined) return;
    const temporaryDirectory = NodePath.dirname(mountpoint);
    expect(await pathExists(temporaryDirectory)).toBe(true);
    await NodeFSP.rm(temporaryDirectory, { force: true, recursive: true });
    expect(await pathExists(temporaryDirectory)).toBe(false);
  });
});

type LinuxPackaging = "directory" | "archive";

interface LinuxFixture {
  readonly directory: string;
  readonly builder: string;
  readonly artifact: string;
  readonly options: {
    readonly platform: "linux";
    readonly version: string;
    readonly artifact: string;
    readonly unpackedDirectory: string;
  };
  readonly packaging: LinuxPackaging;
}

async function populateLinuxRoot(
  root: string,
  packaging: LinuxPackaging,
  options: {
    readonly packageVersion?: string;
    readonly updater?: string;
    readonly appMain?: string;
  } = {},
): Promise<void> {
  await NodeFSP.mkdir(NodePath.join(root, "resources"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, "t3code"), makeElfContents(), { mode: 0o755 });
  await NodeFSP.writeFile(
    NodePath.join(root, "resources", "app-update.yml"),
    options.updater ?? makeValidUpdater(),
    "utf8",
  );

  const appSource = NodePath.join(root, "app-source");
  await NodeFSP.mkdir(NodePath.join(appSource, "nested"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(appSource, "package.json"),
    makeValidPackage(options.packageVersion ?? validVersion),
    "utf8",
  );
  await NodeFSP.writeFile(
    NodePath.join(appSource, "main.js"),
    options.appMain ?? "synthetic app\n",
    "utf8",
  );
  await NodeFSP.writeFile(NodePath.join(appSource, "nested", "data.txt"), "nested data\n", "utf8");

  if (packaging === "directory") {
    await NodeFSP.cp(appSource, NodePath.join(root, "resources", "app"), { recursive: true });
  } else {
    await createPackage(appSource, NodePath.join(root, "resources", "app.asar"));
  }
  await NodeFSP.rm(appSource, { force: true, recursive: true });
}

async function makeLinuxFixture(options: {
  readonly packaging: LinuxPackaging;
  readonly packageVersion?: string;
  readonly updater?: string;
  readonly appMain?: string;
}): Promise<LinuxFixture> {
  const directory = await makeFixtureDirectory("linux-");
  const builder = NodePath.join(directory, "builder");
  await NodeFSP.mkdir(builder, { recursive: true });
  await populateLinuxRoot(builder, options.packaging, options);
  const artifact = await writeSyntheticArtifact(directory, ".appimage");
  return {
    directory,
    builder,
    artifact,
    packaging: options.packaging,
    options: {
      platform: "linux",
      version: validVersion,
      artifact,
      unpackedDirectory: builder,
    },
  };
}

interface LinuxRunnerOptions {
  readonly rejectExtraction?: boolean;
  readonly mutateExtracted?: (root: string) => Promise<void>;
}

function makeLinuxExtractionRunner(
  fixture: LinuxFixture,
  options: LinuxRunnerOptions = {},
): { readonly calls: CommandInput[]; readonly runner: CommandRunner } {
  const calls: CommandInput[] = [];
  const runner: CommandRunner = async (input) => {
    calls.push({
      command: input.command,
      args: [...input.args],
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    });
    if (
      input.command !== fixture.artifact ||
      input.args.length !== 1 ||
      input.args[0] !== "--appimage-extract" ||
      input.cwd === undefined
    ) {
      throw new Error("Linux runner received a command other than AppImage extraction");
    }
    expect(input.cwd).not.toBe(fixture.builder);
    expect(input.cwd.startsWith(`${fixtureParent}${NodePath.sep}`)).toBe(true);
    if (options.rejectExtraction === true) throw new Error("synthetic extraction failure");

    const extractedRoot = NodePath.join(input.cwd, "squashfs-root");
    await copyDirectoryContents(fixture.builder, extractedRoot);
    if (options.mutateExtracted !== undefined) await options.mutateExtracted(extractedRoot);
    return { stdout: "", stderr: "" };
  };
  return { calls, runner };
}

describe("f8y platform Linux orchestration", () => {
  it("uses only the injected AppImage extraction command with an isolated cwd and validates a directory payload", async () => {
    const fixture = await makeLinuxFixture({ packaging: "directory" });
    const { calls, runner } = makeLinuxExtractionRunner(fixture);
    await expect(verifyF8yPlatform(fixture.options, runner)).resolves.toMatchObject({
      platform: "linux",
      version: validVersion,
      artifact: fixture.artifact,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: fixture.artifact,
      args: ["--appimage-extract"],
      cwd: expect.stringContaining(`${fixtureParent}${NodePath.sep}f8y-platform-`),
    });
    expect(await verifierTemporaryDirectories()).toEqual([]);
  });

  it("validates a real synthetic ASAR payload", async () => {
    const fixture = await makeLinuxFixture({ packaging: "archive" });
    const { calls, runner } = makeLinuxExtractionRunner(fixture);
    await expect(verifyF8yPlatform(fixture.options, runner)).resolves.toMatchObject({
      platform: "linux",
      version: validVersion,
    });
    expect(calls).toHaveLength(1);
    expect(await verifierTemporaryDirectories()).toEqual([]);
  });

  it("rejects mismatched binary, updater, app contents, and regular-file path sets", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly mutateExtracted: (root: string) => Promise<void>;
    }> = [
      {
        label: "binary",
        mutateExtracted: async (root) => {
          await NodeFSP.writeFile(NodePath.join(root, "t3code"), makeElfContents(0x42));
        },
      },
      {
        label: "updater",
        mutateExtracted: async (root) => {
          await NodeFSP.writeFile(
            NodePath.join(root, "resources", "app-update.yml"),
            `${makeValidUpdater()}# extracted-only comment\n`,
            "utf8",
          );
        },
      },
      {
        label: "app contents",
        mutateExtracted: async (root) => {
          await NodeFSP.writeFile(
            NodePath.join(root, "resources/app/main.js"),
            "different app\n",
            "utf8",
          );
        },
      },
      {
        label: "app file set",
        mutateExtracted: async (root) => {
          await NodeFSP.writeFile(
            NodePath.join(root, "resources/app/extra.txt"),
            "unexpected\n",
            "utf8",
          );
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = await makeLinuxFixture({ packaging: "directory" });
      const { runner } = makeLinuxExtractionRunner(fixture, {
        mutateExtracted: testCase.mutateExtracted,
      });
      await expect(verifyF8yPlatform(fixture.options, runner), testCase.label).rejects.toThrow();
      expect(await verifierTemporaryDirectories(), testCase.label).toEqual([]);
    }
  });

  it("rejects wrong package versions, updater channels, and ambiguous or absent app packaging", async () => {
    const metadataCases: ReadonlyArray<{
      readonly label: string;
      readonly fixture: Promise<LinuxFixture>;
    }> = [
      {
        label: "package version",
        fixture: makeLinuxFixture({ packaging: "directory", packageVersion: nextVersion }),
      },
      {
        label: "updater channel",
        fixture: makeLinuxFixture({
          packaging: "directory",
          updater: makeValidUpdater({ channel: "latest" }),
        }),
      },
      {
        label: "custom updater host",
        fixture: makeLinuxFixture({
          packaging: "directory",
          updater: makeValidUpdater({ host: "mirror.example" }),
        }),
      },
      {
        label: "HTTP updater protocol",
        fixture: makeLinuxFixture({
          packaging: "directory",
          updater: makeValidUpdater({ protocol: "http" }),
        }),
      },
    ];

    for (const testCase of metadataCases) {
      const fixture = await testCase.fixture;
      const { runner } = makeLinuxExtractionRunner(fixture);
      await expect(verifyF8yPlatform(fixture.options, runner), testCase.label).rejects.toThrow();
      expect(await verifierTemporaryDirectories(), testCase.label).toEqual([]);
    }

    const both = await makeLinuxFixture({ packaging: "directory" });
    const appSource = NodePath.join(both.directory, "both-app-source");
    await NodeFSP.mkdir(appSource, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(appSource, "package.json"), makeValidPackage(), "utf8");
    await createPackage(appSource, NodePath.join(both.builder, "resources", "app.asar"));
    await NodeFSP.rm(appSource, { force: true, recursive: true });
    const bothRunner = makeLinuxExtractionRunner(both);
    await expect(
      verifyF8yPlatform(both.options, bothRunner.runner),
      "both packaging modes",
    ).rejects.toThrow();
    expect(await verifierTemporaryDirectories()).toEqual([]);

    const neither = await makeLinuxFixture({ packaging: "directory" });
    await NodeFSP.rm(NodePath.join(neither.builder, "resources", "app"), {
      force: true,
      recursive: true,
    });
    const neitherRunner = makeLinuxExtractionRunner(neither);
    await expect(
      verifyF8yPlatform(neither.options, neitherRunner.runner),
      "neither packaging mode",
    ).rejects.toThrow();
    expect(await verifierTemporaryDirectories()).toEqual([]);
  });

  it("rejects archive content mismatches while retaining a valid archive package manifest", async () => {
    const fixture = await makeLinuxFixture({ packaging: "archive" });
    const alternateSource = NodePath.join(fixture.directory, "alternate-app-source");
    await NodeFSP.mkdir(NodePath.join(alternateSource, "nested"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(alternateSource, "package.json"),
      makeValidPackage(),
      "utf8",
    );
    await NodeFSP.writeFile(
      NodePath.join(alternateSource, "main.js"),
      "different archive app\n",
      "utf8",
    );
    await NodeFSP.writeFile(
      NodePath.join(alternateSource, "nested", "data.txt"),
      "nested data\n",
      "utf8",
    );
    const alternateArchive = NodePath.join(fixture.directory, "alternate.asar");
    await createPackage(alternateSource, alternateArchive);
    await NodeFSP.rm(alternateSource, { force: true, recursive: true });

    const { runner } = makeLinuxExtractionRunner(fixture, {
      mutateExtracted: async (root) => {
        await NodeFSP.cp(alternateArchive, NodePath.join(root, "resources", "app.asar"));
      },
    });
    await expect(verifyF8yPlatform(fixture.options, runner)).rejects.toThrow();
    expect(await verifierTemporaryDirectories()).toEqual([]);
  });

  it("cleans extraction failures and never launches Electron or another command", async () => {
    const fixture = await makeLinuxFixture({ packaging: "directory" });
    const { calls, runner } = makeLinuxExtractionRunner(fixture, { rejectExtraction: true });
    await expect(verifyF8yPlatform(fixture.options, runner)).rejects.toThrow("extraction failure");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(fixture.artifact);
    expect(await verifierTemporaryDirectories()).toEqual([]);
  });
});

describe("f8y platform Android orchestration", () => {
  async function makeAndroidFixture(): Promise<{
    readonly directory: string;
    readonly artifact: string;
    readonly buildTools: string;
    readonly options: {
      readonly platform: "android";
      readonly version: string;
      readonly artifact: string;
      readonly androidBuildTools: string;
    };
  }> {
    const directory = await makeFixtureDirectory("android-");
    const artifact = await writeSyntheticArtifact(directory, ".apk");
    const buildTools = NodePath.join(directory, "android-build-tools");
    await NodeFSP.mkdir(buildTools, { recursive: true });
    return {
      directory,
      artifact,
      buildTools,
      options: {
        platform: "android",
        version: validVersion,
        artifact,
        androidBuildTools: buildTools,
      },
    };
  }

  function makeAndroidRunner(
    fixture: Awaited<ReturnType<typeof makeAndroidFixture>>,
    options: {
      readonly signerOutput?: string;
      readonly badgingOutput?: string;
      readonly previousApk?: string;
      readonly previousSignerOutput?: string;
      readonly previousBadgingOutput?: string;
      readonly reject?: boolean;
    } = {},
  ): { readonly calls: CommandInput[]; readonly runner: CommandRunner } {
    const calls: CommandInput[] = [];
    const runner: CommandRunner = async (input) => {
      calls.push({
        command: input.command,
        args: [...input.args],
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
      if (options.reject === true) throw new Error("synthetic runner rejection");
      if (input.command === NodePath.join(fixture.buildTools, "apksigner")) {
        const previousApk = options.previousApk;
        return {
          stdout:
            (previousApk !== undefined && input.args.at(-1) === previousApk
              ? (options.previousSignerOutput ??
                `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${expectedCertificate}\n`)
              : options.signerOutput) ??
            `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${expectedCertificate}\n`,
          stderr: "",
        };
      }
      if (input.command === NodePath.join(fixture.buildTools, "aapt")) {
        const previousApk = options.previousApk;
        return {
          stdout:
            (previousApk !== undefined && input.args.at(-1) === previousApk
              ? (options.previousBadgingOutput ??
                `package: name='dev.f8y.t3code' versionCode='6' versionName='${previousVersion}'\n`)
              : options.badgingOutput) ??
            `package: name='dev.f8y.t3code' versionCode='7' versionName='${validVersion}'\n`,
          stderr: "",
        };
      }
      throw new Error(`unexpected Android command ${input.command}`);
    };
    return { calls, runner };
  }

  it("runs explicit apksigner and aapt paths with exact arguments and accepts a valid artifact", async () => {
    const fixture = await makeAndroidFixture();
    const { calls, runner } = makeAndroidRunner(fixture);
    await expect(verifyF8yPlatform(fixture.options, runner)).resolves.toMatchObject({
      platform: "android",
      version: validVersion,
      artifact: fixture.artifact,
    });
    expect(calls).toEqual([
      {
        command: NodePath.join(fixture.buildTools, "apksigner"),
        args: ["verify", "--verbose", "--print-certs", fixture.artifact],
      },
      {
        command: NodePath.join(fixture.buildTools, "aapt"),
        args: ["dump", "badging", fixture.artifact],
      },
    ]);
  });

  it("propagates runner failures and rejects malformed signer output before badging", async () => {
    const rejected = await makeAndroidFixture();
    const rejectedRunner = makeAndroidRunner(rejected, { reject: true });
    await expect(verifyF8yPlatform(rejected.options, rejectedRunner.runner)).rejects.toThrow(
      "runner rejection",
    );
    expect(rejectedRunner.calls).toHaveLength(1);

    const badSigner = await makeAndroidFixture();
    const badSignerRunner = makeAndroidRunner(badSigner, {
      signerOutput: "Number of signers: 2\n",
    });
    await expect(verifyF8yPlatform(badSigner.options, badSignerRunner.runner)).rejects.toThrow();
    expect(badSignerRunner.calls).toHaveLength(1);
    expect(badSignerRunner.calls[0]?.command).toBe(
      NodePath.join(badSigner.buildTools, "apksigner"),
    );
  });

  it("compares the previous APK signer and increasing versionCode when provided", async () => {
    const fixture = await makeAndroidFixture();
    const previousApk = await writeSyntheticArtifact(fixture.directory, ".apk", "previous");
    const options = { ...fixture.options, previousApk };
    const { calls, runner } = makeAndroidRunner(fixture, { previousApk });
    await expect(verifyF8yPlatform(options, runner)).resolves.toMatchObject({
      platform: "android",
    });
    expect(calls.map((call) => call.args.at(-1))).toEqual([
      fixture.artifact,
      fixture.artifact,
      previousApk,
      previousApk,
    ]);
  });

  it("rejects a previous APK signed by a different certificate", async () => {
    const fixture = await makeAndroidFixture();
    const previousApk = await writeSyntheticArtifact(fixture.directory, ".apk", "previous");
    const options = { ...fixture.options, previousApk };
    const { calls, runner } = makeAndroidRunner(fixture, {
      previousApk,
      previousSignerOutput: `Number of signers: 1\nSigner #1 certificate SHA-256 digest: ${alternateCertificate}\n`,
    });
    await expect(verifyF8yPlatform(options, runner)).rejects.toThrow(
      "differs from the previous release APK",
    );
    expect(calls).toHaveLength(3);
  });

  it("rejects a previous APK whose versionCode is equal or newer", async () => {
    const fixture = await makeAndroidFixture();
    const previousApk = await writeSyntheticArtifact(fixture.directory, ".apk", "previous");
    for (const previousCode of ["7", "8"]) {
      const options = { ...fixture.options, previousApk };
      const { calls, runner } = makeAndroidRunner(fixture, {
        previousApk,
        previousBadgingOutput: `package: name='dev.f8y.t3code' versionCode='${previousCode}' versionName='1.2.3-f8y.20260912.${previousCode}'\n`,
      });
      await expect(verifyF8yPlatform(options, runner)).rejects.toThrow(
        "greater than the previous release APK",
      );
      expect(calls).toHaveLength(4);
    }
  });
});
