// @effect-diagnostics nodeBuiltinImport:off
import { findBinary } from "@ff-labs/fff-node";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type EmbeddedFile,
  FFF_LIBRARY_PATH_GLOBAL_KEY,
  clearMaterializedFffLibraryPath,
  fffLibraryFilename,
  fffNativeRootDir,
  fffProcessDirName,
  findEmbeddedFffLibrary,
  isProcessAlive,
  materializeFffLibrary,
  parseFffProcessDirName,
  prepareStandaloneFffLibrary,
  prepareStandaloneNativeLibrary,
  removeFffProcessDirectory,
  sweepStaleFffProcessDirectories,
} from "./standaloneFffNative.ts";

const fakeEmbeddedFile = (name: string, contents: string): EmbeddedFile =>
  Object.assign(new Blob([contents]), { name }) as EmbeddedFile;

const tempDirectory = (prefix: string): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));

const embeddedLibrary = (contents: string) => [
  fakeEmbeddedFile("standalone-client/apps/web/dist/index.js", "web"),
  fakeEmbeddedFile(
    "standalone-client/node_modules/@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so",
    contents,
  ),
];

const modeOf = (path: string): number => NodeFS.lstatSync(path).mode & 0o777;

describe("fffNativeLibraryFilenames", () => {
  it("maps supported standalone targets to their native library filename", () => {
    assert.equal(fffLibraryFilename("darwin", "arm64"), "libfff_c.dylib");
    assert.equal(fffLibraryFilename("linux", "x64"), "libfff_c.so");
    assert.equal(fffLibraryFilename("linux", "arm64"), null);
    assert.equal(fffLibraryFilename("win32", "x64"), null);
  });
});

describe("fffNativeRootDir", () => {
  it("lives under the explicit server base directory, never a home default", () => {
    assert.equal(
      fffNativeRootDir("/data/t3-base"),
      NodePath.join("/data/t3-base", "userdata", "fff-native"),
    );
  });
});

describe("findEmbeddedFffLibrary", () => {
  it("finds the embedded library by filename regardless of its bundled directory", () => {
    const library = fakeEmbeddedFile(
      "standalone-client/node_modules/.pnpm/@ff-labs+fff-bin-linux-x64-gnu@0.9.4/node_modules/@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so",
      "library-bytes",
    );
    const files = [fakeEmbeddedFile("standalone-client/apps/web/dist/index.js", "web"), library];

    assert.equal(
      findEmbeddedFffLibrary(files, "libfff_c.so"),
      library,
      "basename match must win over unrelated assets",
    );
    assert.equal(findEmbeddedFffLibrary(files, "libfff_c.dylib"), null);
  });
});

describe("materializeFffLibrary", () => {
  it("materializes each process into its own private directory with private modes", () => {
    const rootDir = NodePath.join(tempDirectory("t3-fff-root-"), "nested", "fff-native");
    const contents = new TextEncoder().encode("native-library-v1");

    const libraryPath = materializeFffLibrary({
      contents,
      rootDir,
      filename: "libfff_c.so",
      processDirName: fffProcessDirName(),
    });

    assert.equal(NodeFS.readFileSync(libraryPath).equals(contents), true);
    assert.equal(NodeFS.statSync(rootDir).mode & 0o777, 0o700);
    assert.equal(NodeFS.statSync(NodePath.dirname(libraryPath)).mode & 0o777, 0o700);
    assert.equal(modeOf(libraryPath), 0o600);
    assert.equal(
      NodeFS.readdirSync(rootDir).length,
      1,
      "the process directory is the only root entry",
    );
  });

  it("keeps concurrent old and new binaries on separate, mutually untouched files", () => {
    const rootDir = tempDirectory("t3-fff-versions-");
    const oldBytes = new TextEncoder().encode("native-library-v1");
    const newBytes = new TextEncoder().encode("native-library-v2-with-longer-abi");

    const oldPath = materializeFffLibrary({
      contents: oldBytes,
      rootDir,
      filename: "libfff_c.so",
      processDirName: "proc-101-aaaaaa",
    });
    const newPath = materializeFffLibrary({
      contents: newBytes,
      rootDir,
      filename: "libfff_c.so",
      processDirName: "proc-202-bbbbbb",
    });

    assert.notEqual(oldPath, newPath);
    assert.equal(NodeFS.readFileSync(oldPath).equals(oldBytes), true, "old binary keeps its ABI");
    assert.equal(NodeFS.readFileSync(newPath).equals(newBytes), true, "new binary gets its ABI");
    assert.equal(NodeFS.readdirSync(rootDir).length, 2);
  });

  it("reuses an already-valid library in the same process directory", () => {
    const rootDir = tempDirectory("t3-fff-reuse-");
    const contents = new TextEncoder().encode("native-library-v1");
    const processDirName = "proc-303-cccccc";

    const first = materializeFffLibrary({
      contents,
      rootDir,
      filename: "libfff_c.so",
      processDirName,
    });
    const firstInode = NodeFS.statSync(first).ino;
    const second = materializeFffLibrary({
      contents,
      rootDir,
      filename: "libfff_c.so",
      processDirName,
    });

    assert.equal(second, first);
    assert.equal(NodeFS.statSync(first).ino, firstInode, "reuse must not rewrite the file");
  });

  it("enforces private modes on pre-existing permissive directories and libraries", () => {
    const rootDir = tempDirectory("t3-fff-permissive-");
    const processDir = NodePath.join(rootDir, "proc-404-dddddd");
    NodeFS.mkdirSync(processDir, { recursive: true, mode: 0o777 });
    NodeFS.chmodSync(rootDir, 0o777);
    NodeFS.chmodSync(processDir, 0o777);
    const contents = new TextEncoder().encode("native-library-v1");
    const libraryPath = NodePath.join(processDir, "libfff_c.so");
    NodeFS.writeFileSync(libraryPath, contents, { mode: 0o644 });

    const result = materializeFffLibrary({
      contents,
      rootDir,
      filename: "libfff_c.so",
      processDirName: "proc-404-dddddd",
    });

    assert.equal(result, libraryPath, "content-valid files are reused, not rewritten");
    assert.equal(modeOf(rootDir), 0o700);
    assert.equal(modeOf(processDir), 0o700);
    assert.equal(modeOf(libraryPath), 0o600);
  });

  it("replaces a symlinked library path without following it", () => {
    const outside = NodePath.join(tempDirectory("t3-fff-outside-"), "victim.txt");
    NodeFS.writeFileSync(outside, "do not touch");
    const rootDir = tempDirectory("t3-fff-symlink-");
    const processDirName = "proc-505-eeeeee";
    NodeFS.mkdirSync(NodePath.join(rootDir, processDirName), { recursive: true });
    NodeFS.symlinkSync(outside, NodePath.join(rootDir, processDirName, "libfff_c.so"));

    const contents = new TextEncoder().encode("native-library");
    const libraryPath = materializeFffLibrary({
      contents,
      rootDir,
      filename: "libfff_c.so",
      processDirName,
    });

    assert.equal(NodeFS.readFileSync(libraryPath).equals(contents), true);
    assert.equal(
      NodeFS.readFileSync(outside, "utf8"),
      "do not touch",
      "symlink target is untouched",
    );
  });

  it("refuses a symlinked root directory", () => {
    const outside = tempDirectory("t3-fff-outside-");
    const parent = tempDirectory("t3-fff-parent-");
    const rootDir = NodePath.join(parent, "fff-native");
    NodeFS.symlinkSync(outside, rootDir);

    assert.throws(
      () =>
        materializeFffLibrary({
          contents: new TextEncoder().encode("native-library"),
          rootDir,
          filename: "libfff_c.so",
        }),
      /not a real directory/u,
    );
  });
});

describe("sweepStaleFffProcessDirectories", () => {
  it("parses owner pids only from well-formed process directories", () => {
    assert.equal(parseFffProcessDirName("proc-1234-abcdef"), 1234);
    assert.equal(parseFffProcessDirName("proc-0-abcdef"), null);
    assert.equal(parseFffProcessDirName("proc-1234-zzzzzz"), null);
    assert.equal(parseFffProcessDirName("proc-1234"), null);
    assert.equal(parseFffProcessDirName("proc-1234-abcde"), null);
    assert.equal(parseFffProcessDirName("not-a-process-dir"), null);
  });

  it("ignores missing roots", () => {
    assert.equal(
      sweepStaleFffProcessDirectories({
        rootDir: NodePath.join(tempDirectory("t3-fff-x-"), "nope"),
      }),
      0,
    );
  });

  it("removes dead owners and never touches live owners or the current process", () => {
    const rootDir = tempDirectory("t3-fff-sweep-");
    const deadDir = NodePath.join(rootDir, "proc-111-abcdef");
    const liveDir = NodePath.join(rootDir, "proc-222-abcdef");
    const ownDir = NodePath.join(rootDir, `proc-${process.pid}-abcdef`);
    for (const dir of [deadDir, liveDir, ownDir]) {
      NodeFS.mkdirSync(dir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(dir, "libfff_c.so"), "bytes");
    }
    NodeFS.mkdirSync(NodePath.join(rootDir, "not-a-process-dir"), { recursive: true });

    const removed = sweepStaleFffProcessDirectories({
      rootDir,
      currentPid: process.pid,
      isProcessAlive: (pid) => pid === 222,
    });

    assert.equal(removed, 1);
    assert.equal(NodeFS.existsSync(deadDir), false, "dead owner is swept");
    assert.equal(NodeFS.existsSync(liveDir), true, "live owner is never touched");
    assert.equal(NodeFS.existsSync(ownDir), true, "current process directory is never touched");
    assert.equal(NodeFS.existsSync(NodePath.join(rootDir, "not-a-process-dir")), true);
  });

  it("treats a real spawned process as alive and a finished one as dead", async () => {
    assert.equal(isProcessAlive(999_999_999), false);
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      assert.equal(isProcessAlive(child.pid ?? 0), true, "spawned pid is alive");
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    assert.equal(isProcessAlive(child.pid ?? 0), false, "killed pid is dead");
  });
});

describe("removeFffProcessDirectory", () => {
  it("removes the directory and tolerates missing paths", () => {
    const dir = NodePath.join(tempDirectory("t3-fff-cleanup-"), "proc-606-ffffff");
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "libfff_c.so"), "bytes");

    removeFffProcessDirectory(dir);
    removeFffProcessDirectory(dir);
    removeFffProcessDirectory(null);

    assert.equal(NodeFS.existsSync(dir), false);
  });
});

describe("prepareStandaloneFffLibrary", () => {
  it("skips materialization outside a compiled binary", () =>
    Effect.gen(function* () {
      const baseDir = tempDirectory("t3-fff-home-");
      const preparation = yield* Effect.promise(() =>
        prepareStandaloneFffLibrary({ platform: "linux", arch: "x64", baseDir, embeddedFiles: [] }),
      );
      assert.deepEqual(preparation, { status: "not-standalone" });
      assert.equal(NodeFS.existsSync(fffNativeRootDir(baseDir)), false);
    }));

  it("reports a failed build when embedded assets lack the native library", () =>
    Effect.gen(function* () {
      const preparation = yield* Effect.promise(() =>
        prepareStandaloneFffLibrary({
          platform: "linux",
          arch: "x64",
          baseDir: tempDirectory("t3-fff-home-"),
          embeddedFiles: [fakeEmbeddedFile("standalone-client/apps/web/dist/index.js", "web")],
        }),
      );
      assert.equal(preparation.status, "failed");
      assert.include(preparation.status === "failed" ? preparation.reason : "", "libfff_c.so");
    }));

  it("materializes embedded bytes under the explicit base directory, ignoring inherited env", () =>
    Effect.gen(function* () {
      const baseDir = tempDirectory("t3-fff-home-");
      const hijackTarget = NodePath.join(tempDirectory("t3-fff-hijack-"), "libfff_c.so");
      NodeFS.writeFileSync(hijackTarget, "attacker-controlled-bytes");
      const unusableHome = NodePath.join(tempDirectory("t3-fff-unusable-"), "home.txt");
      NodeFS.writeFileSync(unusableHome, "this path is a file, not a directory");
      const hooks: Array<string> = [];
      const previousT3Home = process.env.T3CODE_HOME;
      const previousFffOverride = process.env.FFF_BINARY_PATH;
      process.env.T3CODE_HOME = unusableHome;
      process.env.FFF_BINARY_PATH = hijackTarget;
      try {
        const preparation = yield* Effect.promise(() =>
          prepareStandaloneFffLibrary({
            platform: "linux",
            arch: "x64",
            baseDir,
            embeddedFiles: embeddedLibrary("embedded-library-bytes"),
            processDirName: "proc-707-aaaaaa",
            setLibraryPathHook: (libraryPath) => hooks.push(libraryPath),
          }),
        );
        const libraryPath = preparation.status === "ready" ? preparation.libraryPath : null;

        assert.equal(
          libraryPath,
          NodePath.join(baseDir, "userdata", "fff-native", "proc-707-aaaaaa", "libfff_c.so"),
        );
        assert.equal(NodeFS.readFileSync(libraryPath ?? "", "utf8"), "embedded-library-bytes");
        assert.deepEqual(hooks, [libraryPath]);
        assert.equal(
          NodeFS.readFileSync(hijackTarget, "utf8"),
          "attacker-controlled-bytes",
          "inherited FFF_BINARY_PATH must never be followed",
        );
        assert.equal(
          NodeFS.readdirSync(baseDir).filter((name) => name !== "userdata").length,
          0,
          "a bad T3CODE_HOME is never consulted when an explicit base directory is supplied",
        );
      } finally {
        if (previousT3Home === undefined) delete process.env.T3CODE_HOME;
        else process.env.T3CODE_HOME = previousT3Home;
        if (previousFffOverride === undefined) delete process.env.FFF_BINARY_PATH;
        else process.env.FFF_BINARY_PATH = previousFffOverride;
      }
    }));

  it("fails on a symlinked root before sweeping, leaving the target untouched", () =>
    Effect.gen(function* () {
      const target = tempDirectory("t3-fff-outside-");
      const staleTargetDir = NodePath.join(target, "proc-111-abcdef");
      NodeFS.mkdirSync(staleTargetDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(staleTargetDir, "libfff_c.so"), "do-not-delete");
      const baseDir = tempDirectory("t3-fff-base-");
      const rootDir = fffNativeRootDir(baseDir);
      NodeFS.mkdirSync(NodePath.dirname(rootDir), { recursive: true });
      NodeFS.symlinkSync(target, rootDir);

      const preparation = yield* Effect.promise(() =>
        prepareStandaloneFffLibrary({
          platform: "linux",
          arch: "x64",
          baseDir,
          embeddedFiles: embeddedLibrary("embedded-library-bytes"),
          processDirName: "proc-808-bbbbbb",
          isProcessAlive: () => false,
          setLibraryPathHook: () => {},
        }),
      );

      assert.equal(preparation.status, "failed");
      assert.include(
        preparation.status === "failed" ? preparation.reason : "",
        "not a real directory",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(staleTargetDir, "libfff_c.so"), "utf8"),
        "do-not-delete",
        "the dead-looking proc directory in the symlink target must survive",
      );
      assert.deepEqual(NodeFS.readdirSync(target), ["proc-111-abcdef"]);
    }));

  it("sweeps a dead owner's directory while preparing but keeps a live owner's", () =>
    Effect.gen(function* () {
      const baseDir = tempDirectory("t3-fff-home-");
      const rootDir = fffNativeRootDir(baseDir);
      const deadDir = NodePath.join(rootDir, "proc-111-abcdef");
      NodeFS.mkdirSync(deadDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(deadDir, "libfff_c.so"), "stale");

      const preparation = yield* Effect.promise(() =>
        prepareStandaloneFffLibrary({
          platform: "linux",
          arch: "x64",
          baseDir,
          embeddedFiles: embeddedLibrary("fresh-bytes"),
          processId: process.pid,
          isProcessAlive: (pid) => pid === 222,
          processDirName: "proc-808-bbbbbb",
          setLibraryPathHook: () => {},
        }),
      );

      assert.equal(preparation.status, "ready");
      assert.equal(NodeFS.existsSync(deadDir), false, "dead owner swept on start");
      assert.equal(NodeFS.existsSync(NodePath.join(rootDir, "proc-808-bbbbbb")), true);
    }));
});

describe("prepareStandaloneNativeLibrary", () => {
  it("does not create materialized state outside compiled binaries", () =>
    Effect.gen(function* () {
      const baseDir = tempDirectory("t3-fff-server-");
      yield* prepareStandaloneNativeLibrary(baseDir);
      assert.equal(
        NodeFS.existsSync(fffNativeRootDir(baseDir)),
        false,
        "non-standalone server runs must not touch the base directory",
      );
    }));
});

describe("patched fff resolver hook", () => {
  it("serves the materialized path through the private global and ignores inherited env", () => {
    const marker = NodePath.join(tempDirectory("t3-fff-hook-"), "materialized.so");
    NodeFS.writeFileSync(marker, "materialized");
    const hijack = NodePath.join(tempDirectory("t3-fff-hook-"), "hijack.so");
    NodeFS.writeFileSync(hijack, "env-controlled");
    const normalResolution = findBinary();
    try {
      process.env.FFF_BINARY_PATH = hijack;
      clearMaterializedFffLibraryPath();

      assert.notEqual(
        findBinary(),
        hijack,
        "the patched resolver must not trust inherited FFF_BINARY_PATH",
      );

      (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(FFF_LIBRARY_PATH_GLOBAL_KEY)] =
        marker;
      assert.equal(findBinary(), marker, "the materializer's private hook wins");
    } finally {
      clearMaterializedFffLibraryPath();
      delete process.env.FFF_BINARY_PATH;
    }
    assert.equal(
      findBinary(),
      normalResolution,
      "clearing the hook restores ordinary npm/dev resolution",
    );
  });
});
