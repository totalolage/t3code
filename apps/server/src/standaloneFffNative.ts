// @effect-diagnostics nodeBuiltinImport:off
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

/**
 * Private hook shared with the patched @ff-labs/fff-node resolver. The symbol
 * description is part of the contract with patches/@ff-labs__fff-node@0.9.4.patch;
 * only the standalone materializer below ever assigns it, so ordinary npm,
 * dev-workspace, and desktop resolution stay untouched. Deliberately not an
 * environment variable: inherited env must never select what fff dlopens.
 */
export const FFF_LIBRARY_PATH_GLOBAL_KEY = "t3code.fff.materializedLibraryPath";
const fffLibraryPathKey = Symbol.for(FFF_LIBRARY_PATH_GLOBAL_KEY);

export function setMaterializedFffLibraryPath(libraryPath: string): void {
  (globalThis as unknown as Record<symbol, unknown>)[fffLibraryPathKey] = libraryPath;
}

export function clearMaterializedFffLibraryPath(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[fffLibraryPathKey];
}

export interface EmbeddedFile extends Blob {
  readonly name: string;
}

function runtimeEmbeddedFiles(): ReadonlyArray<EmbeddedFile> {
  return typeof Bun === "undefined"
    ? []
    : (Bun.embeddedFiles as unknown as ReadonlyArray<EmbeddedFile>);
}

export function fffLibraryFilename(platform: string, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "libfff_c.dylib";
  if (platform === "linux" && arch === "x64") return "libfff_c.so";
  return null;
}

/**
 * Each standalone process owns a private directory for its lifetime, so a
 * newer binary never replaces the library an older, still-running process
 * lazily dlopens: <baseDir>/userdata/fff-native/proc-<pid>-<random>/libfff_c.so.
 */
const FFF_PROCESS_DIR_PATTERN = /^proc-(\d+)-[0-9a-f]{6,}$/;

export function fffNativeRootDir(baseDir: string): string {
  return NodePath.join(baseDir, "userdata", "fff-native");
}

export function fffProcessDirName(pid: number = process.pid): string {
  return `proc-${pid}-${NodeCrypto.randomBytes(6).toString("hex")}`;
}

export function parseFffProcessDirName(name: string): number | null {
  const match = FFF_PROCESS_DIR_PATTERN.exec(name);
  if (!match) return null;
  const pid = Number.parseInt(match[1] as string, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes directories of owners that no longer exist (crash, SIGKILL). Live
 * processes — including concurrently running old or new binary versions — are
 * never touched, so shared-library deletion races cannot happen.
 */
export function sweepStaleFffProcessDirectories(input: {
  readonly rootDir: string;
  readonly currentPid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
}): number {
  const currentPid = input.currentPid ?? process.pid;
  const isAlive = input.isProcessAlive ?? isProcessAlive;
  let entries: NodeFS.Dirent[];
  try {
    entries = NodeFS.readdirSync(input.rootDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const ownerPid = parseFffProcessDirName(entry.name);
    if (ownerPid === null || ownerPid === currentPid || isAlive(ownerPid)) continue;
    NodeFS.rmSync(NodePath.join(input.rootDir, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

const FS_NOFOLLOW = NodeFS.constants.O_NOFOLLOW ?? 0;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

function assertPrivateDirectory(dirPath: string): void {
  const stats = NodeFS.lstatSync(dirPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Native library directory is not a real directory: ${dirPath}`);
  }
  if (stats.mode & 0o077) {
    NodeFS.chmodSync(dirPath, PRIVATE_DIR_MODE);
    if (NodeFS.lstatSync(dirPath).mode & 0o077) {
      throw new Error(`Native library directory could not be made private: ${dirPath}`);
    }
  }
}

function isPrivateLibraryCurrent(targetPath: string, contents: Uint8Array): boolean {
  let fd: number;
  try {
    fd = NodeFS.openSync(targetPath, NodeFS.constants.O_RDONLY | FS_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const stats = NodeFS.fstatSync(fd);
    if (!stats.isFile() || stats.size !== contents.byteLength) return false;
    if (stats.mode & 0o077) NodeFS.fchmodSync(fd, PRIVATE_FILE_MODE);
    const actual = Buffer.allocUnsafe(contents.byteLength);
    let read = 0;
    while (read < actual.length) {
      const bytes = NodeFS.readSync(fd, actual, read, actual.length - read, read);
      if (bytes <= 0) return false;
      read += bytes;
    }
    return actual.equals(contents);
  } catch {
    return false;
  } finally {
    NodeFS.closeSync(fd);
  }
}

/**
 * Creates the directory if missing and lstat-validates it. Must run before any
 * directory listing: readdir follows symlinks, so sweeping an unvalidated root
 * could touch another directory's contents.
 */
function ensurePrivateDirectory(dirPath: string): void {
  NodeFS.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  assertPrivateDirectory(dirPath);
}

export function materializeFffLibrary(input: {
  readonly contents: Uint8Array;
  readonly rootDir: string;
  readonly filename: string;
  readonly processDirName?: string;
}): string {
  ensurePrivateDirectory(input.rootDir);
  const processDirName = input.processDirName ?? fffProcessDirName();
  const processDir = NodePath.join(input.rootDir, processDirName);
  ensurePrivateDirectory(processDir);
  const targetPath = NodePath.join(processDir, input.filename);
  if (isPrivateLibraryCurrent(targetPath, input.contents)) {
    return targetPath;
  }
  // Write-then-rename inside the process-private directory is atomic and never
  // writes through whatever may sit at the target path; O_NOFOLLOW and O_EXCL
  // keep symlinks and concurrent writers out of the temp file.
  const tempPath = `${targetPath}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  const fd = NodeFS.openSync(
    tempPath,
    NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT | NodeFS.constants.O_EXCL | FS_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    NodeFS.writeFileSync(fd, input.contents);
    NodeFS.fchmodSync(fd, PRIVATE_FILE_MODE);
    const stats = NodeFS.fstatSync(fd);
    if (!stats.isFile() || stats.size !== input.contents.byteLength) {
      throw new Error(`Materialized native library failed validation: ${tempPath}`);
    }
  } finally {
    NodeFS.closeSync(fd);
  }
  try {
    NodeFS.renameSync(tempPath, targetPath);
  } catch (error) {
    NodeFS.rmSync(tempPath, { force: true });
    throw error;
  }
  if (!isPrivateLibraryCurrent(targetPath, input.contents)) {
    throw new Error(`Materialized native library failed validation: ${targetPath}`);
  }
  return targetPath;
}

export function removeFffProcessDirectory(directory: string | null): void {
  if (directory === null) return;
  try {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort: the next start sweeps directories of dead owners.
  }
}

let gracefulCleanupDir: string | null = null;
let gracefulCleanupRegistered = false;

function registerGracefulCleanup(directory: string): void {
  gracefulCleanupDir = directory;
  if (gracefulCleanupRegistered) return;
  gracefulCleanupRegistered = true;
  process.on("exit", () => {
    removeFffProcessDirectory(gracefulCleanupDir);
  });
}

export function findEmbeddedFffLibrary(
  files: ReadonlyArray<EmbeddedFile>,
  filename: string,
): EmbeddedFile | null {
  const suffix = `/${filename}`;
  return files.find((file) => file.name.replaceAll("\\", "/").endsWith(suffix)) ?? null;
}

export type StandaloneFffLibraryStatus =
  | { readonly status: "ready"; readonly libraryPath: string }
  | { readonly status: "not-standalone" }
  | { readonly status: "failed"; readonly reason: string };

export const prepareStandaloneFffLibrary = async (input: {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  /** Effective server base directory (already resolved through --base-dir/T3CODE_HOME precedence). */
  readonly baseDir: string;
  readonly embeddedFiles?: ReadonlyArray<EmbeddedFile>;
  readonly processId?: number;
  readonly processDirName?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly setLibraryPathHook?: (libraryPath: string) => void;
}): Promise<StandaloneFffLibraryStatus> => {
  const filename = fffLibraryFilename(input.platform, input.arch);
  if (!filename) {
    return {
      status: "failed",
      reason: `No fff native library exists for ${input.platform}-${input.arch}.`,
    };
  }

  const embeddedFiles = input.embeddedFiles ?? runtimeEmbeddedFiles();
  if (embeddedFiles.length === 0) {
    return { status: "not-standalone" };
  }
  const embedded = findEmbeddedFffLibrary(embeddedFiles, filename);
  if (!embedded) {
    return {
      status: "failed",
      reason: `The compiled binary is missing the embedded ${filename} asset.`,
    };
  }

  try {
    const contents = new Uint8Array(await embedded.arrayBuffer());
    const rootDir = fffNativeRootDir(input.baseDir);
    // Validate and secure the root before sweeping: readdir follows symlinks.
    ensurePrivateDirectory(rootDir);
    sweepStaleFffProcessDirectories({
      rootDir,
      ...(input.processId === undefined ? {} : { currentPid: input.processId }),
      ...(input.isProcessAlive === undefined ? {} : { isProcessAlive: input.isProcessAlive }),
    });
    const processDirName = input.processDirName ?? fffProcessDirName(input.processId);
    const libraryPath = materializeFffLibrary({ contents, rootDir, filename, processDirName });
    (input.setLibraryPathHook ?? setMaterializedFffLibraryPath)(libraryPath);
    registerGracefulCleanup(NodePath.join(rootDir, processDirName));
    return { status: "ready", libraryPath };
  } catch (cause) {
    return {
      status: "failed",
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

/**
 * Runs once per server start, after resolveServerConfig produced the effective
 * base directory. No-op outside compiled binaries; failures only disable
 * workspace search, never the server itself.
 */
export const prepareStandaloneNativeLibrary = Effect.fn("standaloneFffNative.prepare")(function* (
  baseDir: string,
) {
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const preparation = yield* Effect.promise(() =>
    prepareStandaloneFffLibrary({ platform, arch, baseDir }),
  );
  if (preparation.status === "failed") {
    yield* Effect.logWarning(
      `Workspace search is unavailable in this build: ${preparation.reason}`,
    );
  }
});
