// @effect-diagnostics nodeBuiltinImport:off - Resolve installed runtime layouts on the host.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const STANDALONE_RUNTIME_RELATIVE_PATH = NodeProcess.platform === "win32" ? "t3.exe" : "t3";

export type ServiceRuntimeFormat = "node-entry" | "standalone-executable";

export interface ServiceRuntimeFiles {
  readonly versionDir: string;
  readonly nodeEntryPath: string;
  readonly standaloneExecutablePath: string;
  readonly sentinelPath: string;
}

export type InstalledServiceRuntime =
  | {
      readonly format: "node-entry";
      readonly versionDir: string;
      readonly executablePath: string;
    }
  | {
      readonly format: "standalone-executable";
      readonly versionDir: string;
      readonly executablePath: string;
    };

export function serviceRuntimeFiles(baseDir: string, version: string): ServiceRuntimeFiles {
  return serviceRuntimeFilesInDirectory(NodePath.join(baseDir, "runtime", "versions", version));
}

export function serviceRuntimeFilesInDirectory(versionDir: string): ServiceRuntimeFiles {
  return {
    versionDir,
    nodeEntryPath: NodePath.join(versionDir, "node_modules", "t3", "dist", "bin.mjs"),
    standaloneExecutablePath: NodePath.join(versionDir, STANDALONE_RUNTIME_RELATIVE_PATH),
    sentinelPath: NodePath.join(versionDir, ".install-complete"),
  };
}

/** Resolve a complete native archive layout or a cached legacy Node entry. */
export async function resolveInstalledServiceRuntime(
  baseDir: string,
  version: string,
): Promise<InstalledServiceRuntime | undefined> {
  const files = serviceRuntimeFiles(baseDir, version);
  try {
    const sentinel = await NodeFSP.readFile(files.sentinelPath, "utf8");
    if (sentinel.trim() !== version) return undefined;

    const isFile = async (filePath: string): Promise<boolean> => {
      try {
        return (await NodeFSP.stat(filePath)).isFile();
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw cause;
      }
    };
    const [nodeEntryExists, standaloneEntryExists] = await Promise.all([
      isFile(files.nodeEntryPath),
      isFile(files.standaloneExecutablePath),
    ]);
    if (nodeEntryExists === standaloneEntryExists) return undefined;
    if (nodeEntryExists) {
      return {
        format: "node-entry",
        versionDir: files.versionDir,
        executablePath: files.nodeEntryPath,
      };
    }
    await NodeFSP.access(files.standaloneExecutablePath, NodeFS.constants.X_OK);
    return {
      format: "standalone-executable",
      versionDir: files.versionDir,
      executablePath: files.standaloneExecutablePath,
    };
  } catch {
    return undefined;
  }
}
