// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { FileFinder } from "@ff-labs/fff-node";

import { prepareStandaloneFffLibrary } from "./standaloneFffNative.ts";

const PROBE_INDEX_TIMEOUT_MS = 10_000;

export interface StandaloneFffProbeResult {
  readonly ok: boolean;
  /** The materialized native library, or null when resolution fell back to node_modules. */
  readonly libraryPath: string | null;
  readonly error?: string;
}

function failure(
  result: { readonly ok: false; readonly error: string },
  libraryPath: string | null,
): StandaloneFffProbeResult {
  return { ok: false, libraryPath, error: result.error };
}

/**
 * End-to-end proof that this build can initialize and use FileFinder: the
 * compiled binary materializes its embedded native library into a disposable
 * base directory, this probe then lists and greps a throwaway workspace.
 * Release CI runs it against the actual compiled artifact.
 */
export const runStandaloneFffProbe = async (host: {
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
}): Promise<StandaloneFffProbeResult> => {
  // Deliberately disposable: the preflight must not depend on (or litter) any
  // real home directory, including hosts where the default home is unusable.
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fff-preflight-base-"));
  try {
    return await probe(host, baseDir);
  } finally {
    NodeFS.rmSync(baseDir, { recursive: true, force: true });
  }
};

const probe = async (
  host: {
    readonly platform: NodeJS.Platform;
    readonly arch: NodeJS.Architecture;
  },
  baseDir: string,
): Promise<StandaloneFffProbeResult> => {
  const preparation = await prepareStandaloneFffLibrary({ ...host, baseDir });
  if (preparation.status === "failed") {
    return { ok: false, libraryPath: null, error: preparation.reason };
  }
  const libraryPath = preparation.status === "ready" ? preparation.libraryPath : null;

  const workspace = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fff-probe-"));
  let finder: FileFinder | null = null;
  try {
    NodeFS.mkdirSync(NodePath.join(workspace, "src"));
    NodeFS.writeFileSync(
      NodePath.join(workspace, "README.md"),
      "# t3 standalone native library preflight\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(workspace, "src", "probe.ts"),
      "export const fffProbeMarker = 't3-fff-preflight';\n",
    );

    const created = FileFinder.create({
      basePath: workspace,
      disableMmapCache: true,
      disableContentIndexing: false,
      aiMode: false,
      enableFsRootScanning: false,
      enableHomeDirScanning: false,
    });
    if (!created.ok) {
      return failure(created, libraryPath);
    }
    finder = created.value;

    const ready = await finder.waitForIndexReady(PROBE_INDEX_TIMEOUT_MS);
    if (!ready.ok || !ready.value) {
      return {
        ok: false,
        libraryPath,
        error: ready.ok ? "The FileFinder index did not become ready in time." : ready.error,
      };
    }

    const search = finder.mixedSearch("README", { pageSize: 5 });
    if (!search.ok) {
      return failure(search, libraryPath);
    }
    const listedReadme = search.value.items.some(
      (item) => item.item.relativePath.replaceAll("\\", "/") === "README.md",
    );
    if (!listedReadme) {
      return { ok: false, libraryPath, error: "FileFinder.mixedSearch did not list README.md." };
    }

    const grep = finder.grep("fffProbeMarker", {
      mode: "plain",
      pageSize: 5,
      timeBudgetMs: 2_000,
    });
    if (!grep.ok) {
      return failure(grep, libraryPath);
    }
    const greppedProbe = grep.value.items.some((match) =>
      match.relativePath.replaceAll("\\", "/").endsWith("src/probe.ts"),
    );
    if (!greppedProbe) {
      return {
        ok: false,
        libraryPath,
        error: "FileFinder.grep did not find the marker in src/probe.ts.",
      };
    }

    return { ok: true, libraryPath };
  } catch (cause) {
    return {
      ok: false,
      libraryPath,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    try {
      finder?.destroy();
    } catch {
      // The probe result matters more than destroy failures.
    }
    NodeFS.rmSync(workspace, { recursive: true, force: true });
  }
};
