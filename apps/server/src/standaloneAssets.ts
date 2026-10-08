// @effect-diagnostics nodeBuiltinImport:off - standalone assets are a Node filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { embeddedWebAssets } from "./standaloneAssetManifest.ts";

export type StandaloneAssetManifest = Readonly<Record<string, string>>;

const standaloneWebDirectoryPrefix = "t3-standalone-web-";
const materializedDirectories = new Set<string>();
let cleanupRegistered = false;
let resolvedStandaloneStaticDir: string | undefined;

const cleanupMaterializedDirectories = (): void => {
  for (const directory of materializedDirectories) {
    try {
      NodeFS.rmSync(directory, { force: true, recursive: true });
    } catch {
      // Process-exit cleanup is best effort and must not mask shutdown.
    }
  }
  materializedDirectories.clear();
};

const trackMaterializedDirectory = (directory: string): void => {
  materializedDirectories.add(directory);
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", cleanupMaterializedDirectories);
};

const invalidAssetPath = (assetPath: string): never => {
  throw new Error(
    `Invalid standalone web asset path ${JSON.stringify(assetPath)}: paths must be relative and cannot contain traversal segments.`,
  );
};

const safeRelativeAssetPath = (assetPath: string): string => {
  if (assetPath.length === 0 || assetPath.includes("\0")) {
    return invalidAssetPath(assetPath);
  }

  const slashPath = assetPath.replaceAll("\\", "/");
  if (
    NodePath.posix.isAbsolute(slashPath) ||
    NodePath.win32.isAbsolute(assetPath) ||
    slashPath.split("/").some((segment) => segment === "..")
  ) {
    return invalidAssetPath(assetPath);
  }

  const normalizedPath = NodePath.posix.normalize(slashPath);
  if (normalizedPath === "." || normalizedPath === ".." || normalizedPath.startsWith("../")) {
    return invalidAssetPath(assetPath);
  }
  return normalizedPath;
};

const prepareManifest = (
  manifest: StandaloneAssetManifest,
): ReadonlyArray<readonly [relativePath: string, sourcePath: string]> | undefined => {
  const entries = Object.entries(manifest);
  if (entries.length === 0) return undefined;
  if (!Object.hasOwn(manifest, "index.html")) {
    throw new Error("Standalone web asset manifest must include index.html.");
  }

  const prepared: Array<readonly [relativePath: string, sourcePath: string]> = [];
  const destinationPaths = new Set<string>();
  for (const [assetPath, sourcePath] of entries) {
    const relativePath = safeRelativeAssetPath(assetPath);
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      throw new Error(`Standalone web asset ${JSON.stringify(assetPath)} has no file path.`);
    }
    if (destinationPaths.has(relativePath)) {
      throw new Error(`Standalone web asset manifest contains duplicate path ${relativePath}.`);
    }
    destinationPaths.add(relativePath);
    prepared.push([relativePath, sourcePath]);
  }
  return prepared;
};

const isWithinDirectory = (directory: string, candidate: string): boolean => {
  const directoryPrefix = directory.endsWith(NodePath.sep)
    ? directory
    : `${directory}${NodePath.sep}`;
  return candidate === directory || candidate.startsWith(directoryPrefix);
};

/**
 * Copies an embedded web build into a disposable directory.
 *
 * The manifest is an argument so tests can use ordinary fixture files without
 * changing the builder-owned manifest module.
 */
export const materializeStandaloneWebAssets = (
  manifest: StandaloneAssetManifest,
): string | undefined => {
  const prepared = prepareManifest(manifest);
  if (prepared === undefined) return undefined;

  let directory: string | undefined;
  try {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), standaloneWebDirectoryPrefix));
    trackMaterializedDirectory(directory);

    for (const [relativePath, sourcePath] of prepared) {
      const destination = NodePath.resolve(directory, relativePath);
      if (!isWithinDirectory(directory, destination)) {
        return invalidAssetPath(relativePath);
      }
      NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true });
      NodeFS.writeFileSync(destination, NodeFS.readFileSync(sourcePath));
    }

    return directory;
  } catch (error) {
    if (directory !== undefined) {
      materializedDirectories.delete(directory);
      try {
        NodeFS.rmSync(directory, { force: true, recursive: true });
      } catch {
        // Preserve the original materialization failure.
      }
    }
    throw error;
  }
};

/**
 * Returns the lazily materialized standalone web root, when this build embeds
 * one. Successful resolution is memoized for the lifetime of the process.
 */
export const resolveStandaloneStaticDir = (): string | undefined => {
  if (resolvedStandaloneStaticDir !== undefined) return resolvedStandaloneStaticDir;
  if (Object.keys(embeddedWebAssets).length === 0) return undefined;

  const directory = materializeStandaloneWebAssets(embeddedWebAssets);
  if (directory !== undefined) resolvedStandaloneStaticDir = directory;
  return directory;
};
