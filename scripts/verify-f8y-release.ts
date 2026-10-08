#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";

const MAX_ANDROID_RUN_NUMBER = 2_100_000_000;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-f8y\.(\d{8})\.([1-9]\d*)(?![\s\S])/u;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})(?![\s\S])/u;

const decodeYaml = Schema.decodeUnknownSync(fromYaml(Schema.Unknown));

interface ReleaseEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

interface FileDigests {
  readonly sha256: string;
  readonly sha512: string;
}

interface F8yManifest {
  readonly size: number;
  readonly sha512: string;
  readonly fileSha512: string;
  readonly blockMapSize?: number;
}

function compareFileNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidF8yVersion(version: string): boolean {
  const match = VERSION_PATTERN.exec(version);
  if (!match) return false;

  const date = match[4];
  const run = match[5];
  if (date === undefined || run === undefined) return false;

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const runNumber = Number(run);

  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    Number.isSafeInteger(runNumber) &&
    runNumber >= 1 &&
    runNumber <= MAX_ANDROID_RUN_NUMBER
  );
}

function isValidTimestamp(value: string): boolean {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8];
  if (zone === undefined) return false;

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }

  return true;
}

function validateVersion(version: unknown): asserts version is string {
  if (typeof version !== "string" || !isValidF8yVersion(version)) {
    throw new Error(
      `Invalid f8y release version '${String(version)}'; expected canonical X.Y.Z-f8y.YYYYMMDD.RUN.`,
    );
  }
}

function requiredPrimaryFileNames(version: string): readonly string[] {
  return [
    `T3-Code-${version}-arm64.dmg`,
    `T3-Code-${version}-x86_64.AppImage`,
    `T3-Code-${version}-android.apk`,
    `t3-${version}-darwin-arm64`,
    `t3-${version}-linux-x64`,
    "f8y-linux.yml",
  ].sort(compareFileNames);
}

function checksumSidecarNames(primaryNames: readonly string[]): readonly string[] {
  return primaryNames
    .filter(
      (name) =>
        name.endsWith(".dmg") ||
        name.endsWith(".AppImage") ||
        name.endsWith("-darwin-arm64") ||
        name.endsWith("-linux-x64"),
    )
    .map((name) => `${name}.sha256`)
    .sort(compareFileNames);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function readDirectoryEntries(directory: string, primaryNames: readonly string[]) {
  const resolvedDirectory = NodePath.resolve(directory);
  let directoryStats: NodeFS.Stats;
  try {
    directoryStats = await NodeFSP.lstat(resolvedDirectory);
  } catch (cause) {
    throw new Error(`Unable to inspect f8y release directory '${resolvedDirectory}'.`, { cause });
  }

  if (directoryStats.isSymbolicLink()) {
    throw new Error(`F8y release directory must not be a symlink: '${resolvedDirectory}'.`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(`F8y release path is not a directory: '${resolvedDirectory}'.`);
  }

  let names: string[];
  try {
    names = await NodeFSP.readdir(resolvedDirectory);
  } catch (cause) {
    throw new Error(`Unable to list f8y release directory '${resolvedDirectory}'.`, { cause });
  }
  names.sort(compareFileNames);

  const allowedNameSet = new Set([...primaryNames, ...checksumSidecarNames(primaryNames)]);
  const entries = new Map<string, ReleaseEntry>();

  for (const name of names) {
    const entryPath = NodePath.join(resolvedDirectory, name);
    let stats: NodeFS.Stats;
    try {
      stats = await NodeFSP.lstat(entryPath);
    } catch (cause) {
      throw new Error(`Unable to inspect f8y release entry '${name}'.`, { cause });
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`F8y release entry '${name}' must not be a symlink.`);
    }
    if (!stats.isFile()) {
      throw new Error(`F8y release entry '${name}' must be a regular file.`);
    }
    if (!allowedNameSet.has(name)) {
      throw new Error(`Unexpected f8y release entry '${name}'.`);
    }
    if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new Error(`F8y release entry '${name}' has an invalid byte size.`);
    }
    if (stats.size === 0) {
      throw new Error(`F8y release file '${name}' must not be empty.`);
    }

    entries.set(name, { name, path: entryPath, size: stats.size });
  }

  for (const name of primaryNames) {
    if (!entries.has(name)) {
      throw new Error(`Missing required f8y release file '${name}'.`);
    }
  }

  return { directory: resolvedDirectory, entries };
}

async function readAt(filePath: string, position: number, length: number): Promise<Buffer> {
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    let bytesReadTotal = 0;
    while (bytesReadTotal < length) {
      const { bytesRead } = await handle.read(
        buffer,
        bytesReadTotal,
        length - bytesReadTotal,
        position + bytesReadTotal,
      );
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
    }
    return buffer.subarray(0, bytesReadTotal);
  } finally {
    await handle.close();
  }
}

async function validateDmg(entry: ReleaseEntry): Promise<void> {
  const trailerOffset = entry.size - 512;
  if (entry.size < 512) {
    throw new Error(`Invalid DMG '${entry.name}': it must be at least 512 bytes.`);
  }

  const signature = await readAt(entry.path, trailerOffset, 4);
  if (signature.length !== 4 || !signature.equals(Buffer.from("koly", "ascii"))) {
    throw new Error(`Invalid DMG '${entry.name}': missing koly trailer signature.`);
  }
}

async function readElfHeader(entry: ReleaseEntry): Promise<Buffer> {
  const minimumHeaderSize = 64;
  if (entry.size < minimumHeaderSize) {
    throw new Error(`Invalid ELF executable '${entry.name}': header is truncated.`);
  }

  const header = await readAt(entry.path, 0, minimumHeaderSize);
  if (header.length !== minimumHeaderSize) {
    throw new Error(`Invalid ELF executable '${entry.name}': header is truncated.`);
  }
  if (
    header[0] !== 0x7f ||
    header[1] !== 0x45 ||
    header[2] !== 0x4c ||
    header[3] !== 0x46 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    header.readUInt16LE(18) !== 62
  ) {
    throw new Error(
      `Invalid ELF executable '${entry.name}': expected a little-endian ELF64 x86_64 header.`,
    );
  }
  return header;
}

async function validateLinuxElf(entry: ReleaseEntry): Promise<void> {
  await readElfHeader(entry);
}

async function validateAppImage(entry: ReleaseEntry): Promise<void> {
  const header = await readElfHeader(entry);
  if (header[8] !== 0x41 || header[9] !== 0x49 || (header[10] !== 1 && header[10] !== 2)) {
    throw new Error(
      `Invalid AppImage '${entry.name}': expected the AI marker and AppImage type 1 or 2.`,
    );
  }
}

async function validateApk(entry: ReleaseEntry): Promise<void> {
  if (entry.size < 30) {
    throw new Error(`Invalid APK '${entry.name}': local ZIP header is truncated.`);
  }
  const header = await readAt(entry.path, 0, 4);
  if (
    header.length !== 4 ||
    header[0] !== 0x50 ||
    header[1] !== 0x4b ||
    header[2] !== 0x03 ||
    header[3] !== 0x04
  ) {
    throw new Error(`Invalid APK '${entry.name}': expected a local ZIP header.`);
  }
}

async function validateBlockMapSize(entry: ReleaseEntry, blockMapSize: number): Promise<void> {
  if (blockMapSize > entry.size - 4) {
    throw new Error(
      `Invalid AppImage '${entry.name}': blockMapSize must not exceed the file size minus its four-byte trailer.`,
    );
  }

  const trailer = await readAt(entry.path, entry.size - 4, 4);
  if (trailer.length !== 4 || trailer.readUInt32BE(0) !== blockMapSize) {
    throw new Error(
      `Invalid AppImage '${entry.name}': blockMapSize does not match the four-byte trailer.`,
    );
  }
}

async function validateMacCli(entry: ReleaseEntry): Promise<void> {
  const minimumHeaderSize = 32;
  if (entry.size < minimumHeaderSize) {
    throw new Error(`Invalid macOS CLI '${entry.name}': Mach-O header is truncated.`);
  }
  const header = await readAt(entry.path, 0, minimumHeaderSize);
  if (
    header.length !== minimumHeaderSize ||
    header[0] !== 0xcf ||
    header[1] !== 0xfa ||
    header[2] !== 0xed ||
    header[3] !== 0xfe ||
    header.readUInt32LE(4) !== 0x0100000c
  ) {
    throw new Error(
      `Invalid macOS CLI '${entry.name}': expected a thin little-endian Mach-O64 arm64 header.`,
    );
  }
}

async function validateHeaders(
  entries: ReadonlyMap<string, ReleaseEntry>,
  primaryNames: readonly string[],
  appImageName: string,
): Promise<void> {
  for (const name of primaryNames) {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(`Missing required f8y release file '${name}'.`);
    }

    if (name.endsWith(".dmg")) {
      await validateDmg(entry);
    } else if (name === appImageName) {
      await validateAppImage(entry);
    } else if (name.endsWith(".apk")) {
      await validateApk(entry);
    } else if (name.endsWith("-darwin-arm64")) {
      await validateMacCli(entry);
    } else if (name.endsWith("-linux-x64")) {
      await validateLinuxElf(entry);
    }
  }
}

function isCanonicalSha512(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==)(?![\s\S])/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 64 && decoded.toString("base64") === value;
}

function validateManifest(
  value: unknown,
  expectedVersion: string,
  expectedAppImageName: string,
): F8yManifest {
  if (!isRecord(value)) {
    throw new Error("Invalid f8y update manifest: top-level value must be a mapping.");
  }

  const requiredKeys = ["version", "files", "path", "sha512"] as const;
  const allowedKeys = new Set<string>([...requiredKeys, "releaseDate"]);
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpectedKey !== undefined) {
    throw new Error(`Invalid f8y update manifest: unsupported metadata field '${unexpectedKey}'.`);
  }
  for (const key of requiredKeys) {
    if (!hasOwn(value, key)) {
      throw new Error(`Invalid f8y update manifest: missing required field '${key}'.`);
    }
  }

  if (value.version !== expectedVersion) {
    throw new Error(
      `Invalid f8y update manifest: version must exactly equal '${expectedVersion}'.`,
    );
  }
  if (typeof value.version !== "string") {
    throw new Error("Invalid f8y update manifest: version must be a string.");
  }
  if (value.path !== expectedAppImageName) {
    throw new Error(
      `Invalid f8y update manifest: path must exactly equal '${expectedAppImageName}'.`,
    );
  }
  if (typeof value.path !== "string") {
    throw new Error("Invalid f8y update manifest: path must be a string.");
  }
  if (!isCanonicalSha512(value.sha512)) {
    throw new Error(
      "Invalid f8y update manifest: top-level sha512 must be canonical base64 SHA-512.",
    );
  }

  if (hasOwn(value, "releaseDate")) {
    if (typeof value.releaseDate !== "string" || !isValidTimestamp(value.releaseDate)) {
      throw new Error("Invalid f8y update manifest: releaseDate must be a valid timestamp string.");
    }
  }

  if (!Array.isArray(value.files) || value.files.length !== 1) {
    throw new Error("Invalid f8y update manifest: files must contain exactly one mapping.");
  }
  const file = value.files[0];
  if (!isRecord(file)) {
    throw new Error("Invalid f8y update manifest: files must contain one mapping.");
  }

  const requiredFileKeys = ["url", "sha512", "size"] as const;
  const fileKeySet = new Set<string>([...requiredFileKeys, "blockMapSize"]);
  const unexpectedFileKey = Object.keys(file).find((key) => !fileKeySet.has(key));
  if (unexpectedFileKey !== undefined) {
    throw new Error(
      `Invalid f8y update manifest: unsupported file metadata field '${unexpectedFileKey}'.`,
    );
  }
  for (const key of requiredFileKeys) {
    if (!hasOwn(file, key)) {
      throw new Error(`Invalid f8y update manifest: file entry is missing '${key}'.`);
    }
  }
  if (file.url !== expectedAppImageName) {
    throw new Error(
      `Invalid f8y update manifest: file url must exactly equal '${expectedAppImageName}'.`,
    );
  }
  if (typeof file.url !== "string") {
    throw new Error("Invalid f8y update manifest: file url must be a string.");
  }
  if (!isCanonicalSha512(file.sha512)) {
    throw new Error("Invalid f8y update manifest: file sha512 must be canonical base64 SHA-512.");
  }
  if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error("Invalid f8y update manifest: file size must be an integer byte count.");
  }

  let blockMapSize: number | undefined;
  if (hasOwn(file, "blockMapSize")) {
    const candidate = file.blockMapSize;
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0) {
      throw new Error("Invalid f8y update manifest: blockMapSize must be a positive safe integer.");
    }
    blockMapSize = candidate;
  }

  const manifest = { size: file.size, sha512: value.sha512, fileSha512: file.sha512 };
  return blockMapSize === undefined ? manifest : { ...manifest, blockMapSize };
}

async function hashFile(entry: ReleaseEntry): Promise<FileDigests> {
  const sha256 = NodeCrypto.createHash("sha256");
  const sha512 = NodeCrypto.createHash("sha512");
  const stream = NodeFS.createReadStream(entry.path, { highWaterMark: 64 * 1024 });

  try {
    for await (const chunk of stream) {
      sha256.update(chunk);
      sha512.update(chunk);
    }
  } catch (cause) {
    throw new Error(`Unable to hash f8y release file '${entry.name}'.`, { cause });
  } finally {
    stream.destroy();
  }

  return { sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

async function readTextFile(entry: ReleaseEntry, description: string): Promise<string> {
  try {
    return await NodeFSP.readFile(entry.path, "utf8");
  } catch (cause) {
    throw new Error(`Unable to read ${description} '${entry.name}'.`, { cause });
  }
}

export async function verifyF8yRelease({
  version,
  directory,
}: {
  version: string;
  directory: string;
}): Promise<{ files: readonly string[] }> {
  validateVersion(version);
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("F8y release directory must be a non-empty path.");
  }

  const primaryNames = requiredPrimaryFileNames(version);
  const appImageName = `T3-Code-${version}-x86_64.AppImage`;
  const { directory: resolvedDirectory, entries } = await readDirectoryEntries(
    directory,
    primaryNames,
  );

  await validateHeaders(entries, primaryNames, appImageName);

  const manifestEntry = entries.get("f8y-linux.yml");
  if (manifestEntry === undefined) {
    throw new Error("Missing required f8y release file 'f8y-linux.yml'.");
  }
  const manifestSource = await readTextFile(manifestEntry, "f8y update manifest");
  let decodedManifest: unknown;
  try {
    decodedManifest = decodeYaml(manifestSource);
  } catch (cause) {
    throw new Error(`Invalid f8y update manifest '${manifestEntry.name}': malformed YAML.`, {
      cause,
    });
  }
  const manifest = validateManifest(decodedManifest, version, appImageName);
  const appImageEntry = entries.get(appImageName);
  if (appImageEntry === undefined) {
    throw new Error(`Missing required f8y release file '${appImageName}'.`);
  }
  if (manifest.blockMapSize !== undefined) {
    await validateBlockMapSize(appImageEntry, manifest.blockMapSize);
  }

  const digests = new Map<string, FileDigests>();
  for (const name of primaryNames) {
    const entry = entries.get(name);
    if (entry === undefined) {
      throw new Error(`Missing required f8y release file '${name}'.`);
    }
    digests.set(name, await hashFile(entry));
  }

  const appImageDigest = digests.get(appImageName);
  if (appImageDigest === undefined) {
    throw new Error(`Missing digest for required f8y release file '${appImageName}'.`);
  }
  if (manifest.size !== appImageEntry.size) {
    throw new Error("Invalid f8y update manifest: file size does not match the AppImage.");
  }
  if (manifest.sha512 !== appImageDigest.sha512) {
    throw new Error("Invalid f8y update manifest: sha512 does not match the AppImage.");
  }
  if (manifest.fileSha512 !== appImageDigest.sha512) {
    throw new Error("Invalid f8y update manifest: file sha512 does not match the AppImage.");
  }

  const sidecarNames = checksumSidecarNames(primaryNames);
  for (const sidecarName of sidecarNames) {
    const artifactName = sidecarName.slice(0, -".sha256".length);
    const digest = digests.get(artifactName);
    if (digest === undefined) {
      throw new Error(`Missing digest for required f8y release file '${artifactName}'.`);
    }
    const expectedSidecar = `${digest.sha256}  ${artifactName}\n`;
    const existingSidecar = entries.get(sidecarName);
    if (existingSidecar !== undefined) {
      const existingSource = await readTextFile(
        existingSidecar,
        `checksum sidecar '${sidecarName}'`,
      );
      if (existingSource !== expectedSidecar) {
        throw new Error(`Checksum sidecar '${sidecarName}' does not match its artifact bytes.`);
      }
      continue;
    }

    try {
      await NodeFSP.writeFile(NodePath.join(resolvedDirectory, sidecarName), expectedSidecar, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (cause) {
      throw new Error(`Unable to write checksum sidecar '${sidecarName}'.`, { cause });
    }
  }

  return { files: [...primaryNames, ...sidecarNames].sort(compareFileNames) };
}

interface CliOptions {
  readonly version: string;
  readonly directory: string;
}

function parseCliArgs(args: readonly string[]): CliOptions {
  let version: string | undefined;
  let directory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--version" && flag !== "--directory") {
      throw new Error(
        `Unknown argument '${flag ?? ""}'. Expected --version VERSION --directory DIR.`,
      );
    }

    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for '${flag}'.`);
    }
    index += 1;

    if (flag === "--version") {
      if (version !== undefined) throw new Error("Duplicate '--version' argument.");
      version = value;
    } else {
      if (directory !== undefined) throw new Error("Duplicate '--directory' argument.");
      directory = value;
    }
  }

  if (version === undefined) throw new Error("Missing required '--version VERSION' argument.");
  if (directory === undefined) throw new Error("Missing required '--directory DIR' argument.");
  return { version, directory };
}

async function runCli(): Promise<void> {
  await verifyF8yRelease(parseCliArgs(process.argv.slice(2)));
}

if (import.meta.main) {
  void runCli().catch((cause: unknown) => {
    process.stderr.write(`${errorMessage(cause)}\n`);
    process.exitCode = 1;
  });
}
