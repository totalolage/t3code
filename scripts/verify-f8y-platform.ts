#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - This verifier deliberately uses Node's filesystem and child-process APIs at a CLI boundary.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { extractFile } from "@electron/asar";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

import {
  parseAndroidVersionCode,
  parseF8yPlatformVersion,
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

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));

export type F8yPlatform = "mac" | "linux" | "android";

export interface MacPlatformOptions {
  readonly platform: "mac";
  readonly version: string;
  readonly artifact: string;
}

export interface LinuxPlatformOptions {
  readonly platform: "linux";
  readonly version: string;
  readonly artifact: string;
  readonly unpackedDirectory: string;
}

export interface AndroidPlatformOptions {
  readonly platform: "android";
  readonly version: string;
  readonly artifact: string;
  readonly androidBuildTools: string;
  readonly previousApk?: string;
}

export type F8yPlatformOptions = MacPlatformOptions | LinuxPlatformOptions | AndroidPlatformOptions;

export interface CommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export type CommandRunner = (
  command: CommandInput,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface F8yPlatformVerificationResult {
  readonly platform: F8yPlatform;
  readonly version: string;
  readonly artifact: string;
  readonly summary: string;
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export const defaultRunner: CommandRunner = async (input) => {
  const options = {
    encoding: "utf8" as const,
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    shell: false as const,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  };
  const result = await execFile(input.command, [...input.args], options);
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const PLATFORM_FLAGS = [
  "--platform",
  "--version",
  "--artifact",
  "--unpacked-directory",
  "--android-build-tools",
  "--previous-apk",
] as const;

type PlatformFlag = (typeof PLATFORM_FLAGS)[number];

const PLATFORM_FLAG_SET = new Set<string>(PLATFORM_FLAGS);

export function parsePlatformArguments(argv: readonly string[]): F8yPlatformOptions {
  const values = new Map<PlatformFlag, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !PLATFORM_FLAG_SET.has(flag)) {
      throw new Error(
        `Unknown argument '${flag ?? ""}'. Expected --platform PLATFORM --version VERSION --artifact PATH.`,
      );
    }

    const typedFlag = flag as PlatformFlag;
    if (values.has(typedFlag)) {
      throw new Error(`Duplicate '${typedFlag}' argument.`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for '${typedFlag}'.`);
    }

    values.set(typedFlag, value);
    index += 1;
  }

  const platformValue = values.get("--platform");
  if (platformValue === undefined) {
    throw new Error("Missing required '--platform PLATFORM' argument.");
  }
  if (platformValue !== "mac" && platformValue !== "linux" && platformValue !== "android") {
    throw new Error("Platform must be one of: mac, linux, android.");
  }

  const version = requireArgument(values, "--version", "VERSION");
  parseF8yPlatformVersion(version);
  const artifact = requireArgument(values, "--artifact", "PATH");
  validateArtifactExtension(artifact, platformValue);

  if (platformValue === "mac") {
    rejectPlatformArguments(values, [
      "--unpacked-directory",
      "--android-build-tools",
      "--previous-apk",
    ]);
    return { platform: "mac", version, artifact };
  }

  if (platformValue === "linux") {
    rejectPlatformArguments(values, ["--android-build-tools", "--previous-apk"]);
    return {
      platform: "linux",
      version,
      artifact,
      unpackedDirectory: requireArgument(values, "--unpacked-directory", "PATH"),
    };
  }

  rejectPlatformArguments(values, ["--unpacked-directory"]);
  const previousApk = values.get("--previous-apk");
  return {
    platform: "android",
    version,
    artifact,
    androidBuildTools: requireArgument(values, "--android-build-tools", "PATH"),
    ...(previousApk === undefined ? {} : { previousApk }),
  };
}

function requireArgument(
  values: ReadonlyMap<PlatformFlag, string>,
  flag: PlatformFlag,
  label: string,
): string {
  const value = values.get(flag);
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required '${flag} ${label}' argument.`);
  }
  return value;
}

function rejectPlatformArguments(
  values: ReadonlyMap<PlatformFlag, string>,
  flags: readonly PlatformFlag[],
): void {
  for (const flag of flags) {
    if (values.has(flag)) {
      throw new Error(`Argument '${flag}' is not valid for this platform.`);
    }
  }
}

export async function verifyF8yPlatform(
  options: F8yPlatformOptions,
  runner: CommandRunner = defaultRunner,
): Promise<F8yPlatformVerificationResult> {
  const normalized = await normalizePlatformOptions(options);
  if (normalized.platform === "mac") {
    await verifyMacArtifact(normalized, runner);
    return {
      platform: normalized.platform,
      version: normalized.version,
      artifact: normalized.artifact,
      summary: `Verified macOS f8y artifact ${normalized.artifact}: arm64, ad-hoc signed, and without updater metadata.`,
    };
  }

  if (normalized.platform === "android") {
    await verifyAndroidArtifact(normalized, runner);
    return {
      platform: normalized.platform,
      version: normalized.version,
      artifact: normalized.artifact,
      summary: `Verified Android f8y artifact ${normalized.artifact}: one pinned signer and a strictly increasing versionCode.`,
    };
  }

  const linuxPayload = await verifyLinuxArtifact(normalized, runner);
  return {
    platform: normalized.platform,
    version: normalized.version,
    artifact: normalized.artifact,
    summary:
      linuxPayload.kind === "archive"
        ? `Verified Linux f8y artifact ${normalized.artifact}: compared the extracted builder payload only (t3code, resources/app-update.yml, and the complete resources/app.asar bytes), not the other Electron runtime files.`
        : `Verified Linux f8y artifact ${normalized.artifact}: compared the extracted builder payload only (t3code, resources/app-update.yml, and every regular file under resources/app), not the other Electron runtime files.`,
  };
}

export async function runPlatformCli(
  argv: readonly string[],
  runner: CommandRunner = defaultRunner,
): Promise<F8yPlatformVerificationResult> {
  return verifyF8yPlatform(parsePlatformArguments(argv), runner);
}

interface NormalizedMacOptions {
  readonly platform: "mac";
  readonly version: string;
  readonly artifact: string;
}

interface NormalizedLinuxOptions {
  readonly platform: "linux";
  readonly version: string;
  readonly artifact: string;
  readonly unpackedDirectory: string;
}

interface NormalizedAndroidOptions {
  readonly platform: "android";
  readonly version: string;
  readonly artifact: string;
  readonly androidBuildTools: string;
  readonly previousApk?: string;
}

type NormalizedPlatformOptions =
  | NormalizedMacOptions
  | NormalizedLinuxOptions
  | NormalizedAndroidOptions;

async function normalizePlatformOptions(
  options: F8yPlatformOptions,
): Promise<NormalizedPlatformOptions> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("F8y platform options must be an object.");
  }

  if (
    options.platform !== "mac" &&
    options.platform !== "linux" &&
    options.platform !== "android"
  ) {
    throw new Error("Platform must be one of: mac, linux, android.");
  }
  if (typeof options.version !== "string") {
    throw new TypeError("F8y platform version must be a string.");
  }
  parseF8yPlatformVersion(options.version);
  if (typeof options.artifact !== "string" || options.artifact.length === 0) {
    throw new Error("F8y platform artifact must be a non-empty path.");
  }

  const artifact = NodePath.resolve(options.artifact);
  validateArtifactExtension(artifact, options.platform);
  await requireRegularNonEmptyFile(artifact, "F8y platform artifact");

  if (options.platform === "mac") {
    if (
      hasOption(options, "unpackedDirectory") ||
      hasOption(options, "androidBuildTools") ||
      hasOption(options, "previousApk")
    ) {
      throw new Error("mac platform options contain an argument for another platform.");
    }
    return { platform: "mac", version: options.version, artifact };
  }

  if (options.platform === "linux") {
    if (typeof options.unpackedDirectory !== "string" || options.unpackedDirectory.length === 0) {
      throw new Error("Linux platform options require a non-empty unpackedDirectory path.");
    }
    if (hasOption(options, "androidBuildTools") || hasOption(options, "previousApk")) {
      throw new Error("linux platform options contain an argument for another platform.");
    }
    const unpackedDirectory = NodePath.resolve(options.unpackedDirectory);
    await requireDirectory(unpackedDirectory, "Linux unpacked builder directory");
    return { platform: "linux", version: options.version, artifact, unpackedDirectory };
  }

  if (typeof options.androidBuildTools !== "string" || options.androidBuildTools.length === 0) {
    throw new Error("Android platform options require an androidBuildTools path.");
  }
  if (hasOption(options, "unpackedDirectory")) {
    throw new Error("android platform options contain an argument for another platform.");
  }

  let previousApk: string | undefined;
  if (options.previousApk !== undefined) {
    if (typeof options.previousApk !== "string" || options.previousApk.length === 0) {
      throw new Error("Android previousApk must be a non-empty APK path when provided.");
    }
    previousApk = NodePath.resolve(options.previousApk);
    validateArtifactExtension(previousApk, "android");
    await requireRegularNonEmptyFile(previousApk, "Previous Android APK");
  }
  return {
    platform: "android",
    version: options.version,
    artifact,
    androidBuildTools: NodePath.resolve(options.androidBuildTools),
    ...(previousApk === undefined ? {} : { previousApk }),
  };
}

function hasOption<T extends object, K extends PropertyKey>(options: T, key: K): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

function validateArtifactExtension(artifact: string, platform: F8yPlatform): void {
  const extension = NodePath.extname(artifact).toLowerCase();
  const expected = platform === "mac" ? ".dmg" : platform === "linux" ? ".appimage" : ".apk";
  if (extension !== expected) {
    throw new Error(`${platform} artifact must use the ${expected} extension: '${artifact}'.`);
  }
}

async function requireRegularNonEmptyFile(filePath: string, label: string): Promise<NodeFS.Stats> {
  const stats = await requireRegularFile(filePath, label);
  if (stats.size <= 0) {
    throw new Error(`${label} must be non-empty: '${filePath}'.`);
  }
  return stats;
}

async function requireRegularFile(filePath: string, label: string): Promise<NodeFS.Stats> {
  let stats: NodeFS.Stats;
  try {
    stats = await NodeFSP.lstat(filePath);
  } catch (cause) {
    throw new Error(`${label} does not exist: '${filePath}'.`, { cause });
  }
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file: '${filePath}'.`);
  }
  if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
    throw new Error(`${label} has an invalid byte size: '${filePath}'.`);
  }
  return stats;
}

async function requireDirectory(directory: string, label: string): Promise<NodeFS.Stats> {
  let stats: NodeFS.Stats;
  try {
    stats = await NodeFSP.lstat(directory);
  } catch (cause) {
    throw new Error(`${label} does not exist: '${directory}'.`, { cause });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a real directory: '${directory}'.`);
  }
  return stats;
}

async function verifyAndroidArtifact(
  options: NormalizedAndroidOptions,
  runner: CommandRunner,
): Promise<void> {
  const apksigner = NodePath.join(options.androidBuildTools, "apksigner");
  const aapt = NodePath.join(options.androidBuildTools, "aapt");

  const signer = await runner({
    command: apksigner,
    args: ["verify", "--verbose", "--print-certs", options.artifact],
  });
  const signerDigest = validateAndroidSigner(signer.stdout);

  const badging = await runner({
    command: aapt,
    args: ["dump", "badging", options.artifact],
  });
  const versionCode = validateAndroidBadging(badging.stdout, options.version);

  if (options.previousApk !== undefined) {
    const previousSigner = await runner({
      command: apksigner,
      args: ["verify", "--verbose", "--print-certs", options.previousApk],
    });
    if (validateAndroidSigner(previousSigner.stdout) !== signerDigest) {
      throw new Error("Android APK signer certificate differs from the previous release APK.");
    }

    const previousBadging = await runner({
      command: aapt,
      args: ["dump", "badging", options.previousApk],
    });
    const previousVersionCode = parseAndroidVersionCode(previousBadging.stdout);
    if (previousVersionCode >= versionCode) {
      throw new Error("Android APK versionCode must be greater than the previous release APK.");
    }
  }
}

async function verifyMacArtifact(
  options: NormalizedMacOptions,
  runner: CommandRunner,
): Promise<void> {
  await runner({ command: "hdiutil", args: ["verify", options.artifact] });

  const temporaryDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "f8y-platform-"));
  const mountpoint = NodePath.join(temporaryDirectory, "mountpoint");
  let attached = false;
  let operationError: unknown;

  try {
    await NodeFSP.mkdir(mountpoint);
    await runner({
      command: "hdiutil",
      args: ["attach", "-readonly", "-nobrowse", "-mountpoint", mountpoint, options.artifact],
    });
    attached = true;
    await inspectMacMount(mountpoint, temporaryDirectory, options.version, runner);
  } catch (cause) {
    operationError = cause;
  }

  let detachError: unknown;
  if (attached) {
    try {
      await runner({ command: "hdiutil", args: ["detach", mountpoint] });
    } catch (cause) {
      detachError = cause;
    }
  }

  if (detachError !== undefined) {
    const message = `Could not detach macOS artifact mount '${mountpoint}'; temporary directory was left in place to avoid recursively cleaning a mounted filesystem.`;
    if (operationError === undefined) {
      throw new Error(message, { cause: detachError });
    }
    throw new AggregateError([operationError, detachError], message);
  }

  let cleanupError: unknown;
  try {
    await NodeFSP.rm(temporaryDirectory, { force: true, recursive: true });
  } catch (cause) {
    cleanupError = cause;
  }

  if (operationError !== undefined) {
    if (cleanupError === undefined) throw operationError;
    throw new AggregateError([operationError, cleanupError], "macOS artifact verification failed.");
  }
  if (cleanupError !== undefined) {
    throw new Error(
      `Could not clean up macOS artifact verification directory '${temporaryDirectory}'.`,
      {
        cause: cleanupError,
      },
    );
  }
}

async function inspectMacMount(
  mountpoint: string,
  temporaryDirectory: string,
  version: string,
  runner: CommandRunner,
): Promise<void> {
  const entries = await NodeFSP.readdir(mountpoint, { withFileTypes: true });
  const appEntries = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (appEntries.length !== 1) {
    throw new Error(
      `macOS disk image must contain exactly one top-level .app directory; found ${String(appEntries.length)}.`,
    );
  }

  const appEntry = appEntries[0];
  if (appEntry === undefined) {
    throw new Error("macOS disk image did not contain an application directory.");
  }
  const appPath = NodePath.join(mountpoint, appEntry.name);
  await requireDirectory(appPath, "macOS application bundle");

  const contentsPath = NodePath.join(appPath, "Contents");
  const resourcesPath = NodePath.join(contentsPath, "Resources");
  await requireDirectory(contentsPath, "macOS application Contents directory");
  await requireDirectory(resourcesPath, "macOS application Resources directory");
  await assertPathAbsent(
    NodePath.join(resourcesPath, "app-update.yml"),
    "macOS application Resources/app-update.yml",
  );

  const infoPlistPath = NodePath.join(contentsPath, "Info.plist");
  await requireRegularNonEmptyFile(infoPlistPath, "macOS Info.plist");
  const infoPlistResult = await runner({
    command: "plutil",
    args: ["-convert", "json", "-o", "-", infoPlistPath],
  });
  const executableName = validateMacInfoPlist(
    parseJsonOutput(infoPlistResult.stdout, "macOS Info.plist JSON"),
    version,
  );

  const executablePath = NodePath.join(contentsPath, "MacOS", executableName);
  await requireRegularNonEmptyFile(executablePath, "macOS application executable");
  const architectures = await runner({ command: "lipo", args: ["-archs", executablePath] });
  validateArm64Architectures(architectures.stdout);

  await runner({ command: "codesign", args: ["--verify", "--deep", "--strict", appPath] });
  const signature = await runner({
    command: "codesign",
    args: ["--display", "--verbose=4", appPath],
  });
  validateMacSignature(`${signature.stdout}\n${signature.stderr}`);

  const entitlements = await runner({
    command: "codesign",
    args: ["--display", "--entitlements", ":-", appPath],
  });
  if (entitlements.stdout.trim().length === 0) {
    validateMacEntitlements({});
    return;
  }

  const entitlementsPath = NodePath.join(temporaryDirectory, "entitlements.plist");
  await NodeFSP.writeFile(entitlementsPath, entitlements.stdout, "utf8");
  const entitlementsJson = await runner({
    command: "plutil",
    args: ["-convert", "json", "-o", "-", entitlementsPath],
  });
  validateMacEntitlements(parseJsonOutput(entitlementsJson.stdout, "macOS entitlements JSON"));
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  try {
    await NodeFSP.lstat(path);
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") return;
    throw new Error(`Unable to verify that ${label} is absent: '${path}'.`, { cause });
  }
  throw new Error(`${label} must be absent: '${path}'.`);
}

function parseJsonOutput(output: string, label: string): unknown {
  try {
    return JSON.parse(output) as unknown;
  } catch (cause) {
    throw new Error(`${label} was not valid JSON.`, { cause });
  }
}

interface LinuxPayload {
  readonly kind: "archive" | "directory";
  readonly root: string;
  readonly executablePath: string;
  readonly updaterPath: string;
  readonly appPath: string;
  readonly appFiles?: ReadonlyMap<string, DirectoryFile>;
}

async function verifyLinuxArtifact(
  options: NormalizedLinuxOptions,
  runner: CommandRunner,
): Promise<LinuxPayload> {
  // The AppImage runtime is used only for its extraction mode. Electron is not
  // launched, and the command is injected so tests can model the future CI step.
  const temporaryDirectory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "f8y-platform-"));
  try {
    await runner({
      command: options.artifact,
      args: ["--appimage-extract"],
      cwd: temporaryDirectory,
    });

    const extractedRoot = NodePath.join(temporaryDirectory, "squashfs-root");
    await requireDirectory(extractedRoot, "extracted AppImage squashfs-root");
    const extractedPayload = await inspectLinuxPayload(
      extractedRoot,
      "extracted AppImage",
      options.version,
    );
    const suppliedPayload = await inspectLinuxPayload(
      options.unpackedDirectory,
      "supplied Linux builder directory",
      options.version,
    );

    await compareFileContents(
      extractedPayload.executablePath,
      suppliedPayload.executablePath,
      "Linux t3code executable",
    );
    await compareFileContents(
      extractedPayload.updaterPath,
      suppliedPayload.updaterPath,
      "Linux resources/app-update.yml",
    );

    if (extractedPayload.kind !== suppliedPayload.kind) {
      throw new Error(
        "Linux builder payload packaging is ambiguous: extracted and supplied resources use different app packaging modes.",
      );
    }

    if (extractedPayload.kind === "archive" && suppliedPayload.kind === "archive") {
      await compareFileContents(
        extractedPayload.appPath,
        suppliedPayload.appPath,
        "Linux resources/app.asar",
      );
    } else if (
      extractedPayload.kind === "directory" &&
      suppliedPayload.kind === "directory" &&
      extractedPayload.appFiles !== undefined &&
      suppliedPayload.appFiles !== undefined
    ) {
      await compareDirectoryContents(extractedPayload.appFiles, suppliedPayload.appFiles);
    }

    return extractedPayload;
  } finally {
    await NodeFSP.rm(temporaryDirectory, { force: true, recursive: true });
  }
}

async function inspectLinuxPayload(
  root: string,
  label: string,
  version: string,
): Promise<LinuxPayload> {
  await requireDirectory(root, `${label} root`);
  const executablePath = NodePath.join(root, "t3code");
  await requireRegularNonEmptyFile(executablePath, `${label} t3code executable`);
  validateElfX64(await readPrefix(executablePath, 64));

  const resourcesPath = NodePath.join(root, "resources");
  await requireDirectory(resourcesPath, `${label} resources directory`);
  const updaterPath = NodePath.join(resourcesPath, "app-update.yml");
  await requireRegularNonEmptyFile(updaterPath, `${label} resources/app-update.yml`);
  await validateLinuxUpdaterFile(updaterPath, label);

  const archivePath = NodePath.join(resourcesPath, "app.asar");
  const directoryPath = NodePath.join(resourcesPath, "app");
  const archiveStats = await lstatIfPresent(archivePath);
  const directoryStats = await lstatIfPresent(directoryPath);

  if (archiveStats !== undefined && directoryStats !== undefined) {
    throw new Error(
      `${label} contains both resources/app.asar and resources/app; packaging is ambiguous.`,
    );
  }
  if (archiveStats === undefined && directoryStats === undefined) {
    throw new Error(`${label} contains neither resources/app.asar nor resources/app.`);
  }

  if (archiveStats !== undefined) {
    await requireRegularNonEmptyFile(archivePath, `${label} resources/app.asar`);
    validateArchivePackage(archivePath, version, label);
    return {
      kind: "archive",
      root,
      executablePath,
      updaterPath,
      appPath: archivePath,
    };
  }

  await requireDirectory(directoryPath, `${label} resources/app directory`);
  const packagePath = NodePath.join(directoryPath, "package.json");
  await requireRegularNonEmptyFile(packagePath, `${label} resources/app/package.json`);
  validateLinuxPackage(
    parseJsonOutput(await NodeFSP.readFile(packagePath, "utf8"), `${label} package.json`),
    version,
  );
  const appFiles = await collectDirectoryFiles(directoryPath, `${label} resources/app`);
  return {
    kind: "directory",
    root,
    executablePath,
    updaterPath,
    appPath: directoryPath,
    appFiles,
  };
}

async function validateLinuxUpdaterFile(path: string, label: string): Promise<void> {
  let source: string;
  try {
    source = await NodeFSP.readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`Unable to read ${label} resources/app-update.yml.`, { cause });
  }

  try {
    validateLinuxUpdater(decodeYaml(source));
  } catch (cause) {
    throw new Error(`Invalid ${label} resources/app-update.yml.`, { cause });
  }
}

function validateArchivePackage(archivePath: string, version: string, label: string): void {
  let packageSource: Buffer;
  try {
    packageSource = extractFile(archivePath, "package.json");
  } catch (cause) {
    throw new Error(`Unable to extract ${label} resources/app.asar package.json.`, { cause });
  }
  validateLinuxPackage(
    parseJsonOutput(packageSource.toString("utf8"), `${label} app.asar package.json`),
    version,
  );
}

interface DirectoryFile {
  readonly path: string;
  readonly size: number;
}

async function collectDirectoryFiles(
  root: string,
  label: string,
): Promise<ReadonlyMap<string, DirectoryFile>> {
  const files = new Map<string, DirectoryFile>();
  const pending: Array<{ readonly absolutePath: string; readonly relativePath: string }> = [
    { absolutePath: root, relativePath: "" },
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const entries = await NodeFSP.readdir(current.absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      assertSafeFileName(entry.name, `${label} filename`);
      const relativePath =
        current.relativePath.length === 0 ? entry.name : `${current.relativePath}/${entry.name}`;
      const absolutePath = NodePath.join(current.absolutePath, entry.name);
      const stats = await NodeFSP.lstat(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`${label} must not contain symlinks: '${relativePath}'.`);
      }
      if (stats.isDirectory()) {
        pending.push({ absolutePath, relativePath });
        continue;
      }
      if (!stats.isFile() || !Number.isSafeInteger(stats.size)) {
        throw new Error(`${label} contains a non-regular file: '${relativePath}'.`);
      }
      files.set(relativePath, { path: absolutePath, size: stats.size });
    }
  }

  return files;
}

function assertSafeFileName(name: string, label: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\u0000")
  ) {
    throw new Error(`${label} contains a traversal or invalid name: '${name}'.`);
  }
}

async function compareDirectoryContents(
  extracted: ReadonlyMap<string, DirectoryFile>,
  supplied: ReadonlyMap<string, DirectoryFile>,
): Promise<void> {
  const extractedPaths = [...extracted.keys()].sort();
  const suppliedPaths = [...supplied.keys()].sort();
  if (extractedPaths.length !== suppliedPaths.length) {
    throw new Error("Linux resources/app regular-file path sets do not match.");
  }
  for (let index = 0; index < extractedPaths.length; index += 1) {
    const extractedPath = extractedPaths[index];
    const suppliedPath = suppliedPaths[index];
    if (
      extractedPath === undefined ||
      suppliedPath === undefined ||
      extractedPath !== suppliedPath
    ) {
      throw new Error("Linux resources/app regular-file path sets do not match.");
    }
    const extractedFile = extracted.get(extractedPath);
    const suppliedFile = supplied.get(suppliedPath);
    if (extractedFile === undefined || suppliedFile === undefined) {
      throw new Error(`Linux resources/app comparison lost file '${extractedPath}'.`);
    }
    await compareFileContents(
      extractedFile.path,
      suppliedFile.path,
      `Linux resources/app/${extractedPath}`,
    );
  }
}

async function compareFileContents(left: string, right: string, label: string): Promise<void> {
  const [leftDigest, rightDigest] = await Promise.all([
    hashRegularFile(left, `${label} extracted counterpart`),
    hashRegularFile(right, `${label} supplied counterpart`),
  ]);
  if (leftDigest.size !== rightDigest.size || leftDigest.sha256 !== rightDigest.sha256) {
    throw new Error(`${label} does not match between the extracted and supplied builder payloads.`);
  }
}

interface FileDigest {
  readonly size: number;
  readonly sha256: string;
}

async function hashRegularFile(path: string, label: string): Promise<FileDigest> {
  const stats = await requireRegularFile(path, label);
  const hash = NodeCrypto.createHash("sha256");
  const stream = NodeFS.createReadStream(path, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      hash.update(chunk);
    }
  } catch (cause) {
    throw new Error(`Unable to hash ${label}: '${path}'.`, { cause });
  } finally {
    stream.destroy();
  }
  return { size: stats.size, sha256: hash.digest("hex") };
}

async function readPrefix(path: string, length: number): Promise<Uint8Array> {
  const handle = await NodeFSP.open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function lstatIfPresent(path: string): Promise<NodeFS.Stats | undefined> {
  try {
    return await NodeFSP.lstat(path);
  } catch (cause) {
    if (isErrnoException(cause) && cause.code === "ENOENT") return undefined;
    throw new Error(`Unable to inspect Linux payload path '${path}'.`, { cause });
  }
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function isMainModule(): boolean {
  const entrypoint = NodeProcess.argv[1];
  return (
    entrypoint !== undefined &&
    NodePath.resolve(entrypoint) === NodeURL.fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  void runPlatformCli(NodeProcess.argv.slice(2))
    .then((result) => {
      NodeProcess.stdout.write(`${result.summary}\n`);
    })
    .catch((cause: unknown) => {
      NodeProcess.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
      NodeProcess.exit(1);
    });
}
