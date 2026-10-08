#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - the smoke fixture checks the bundled Node boundaries.

import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import * as NodePath from "node:path";

import { FileFinder } from "@ff-labs/fff-node";
import { embeddedFiles } from "bun";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { layerFromPath } from "../../src/persistence/Sqlite.ts";
import { resolveStandaloneStaticDir } from "../../src/standaloneAssets.ts";

const NEEDLE = "needle-standalone-proof";
const NEEDLE_FILE_NAME = `${NEEDLE}.txt`;
const SQLITE_VALUE = "standalone-runtime-smoke";

const StandaloneRuntimeSmokeStage = Schema.Literals([
  "arguments",
  "native-create",
  "native-ready",
  "native-search",
  "web-index",
]);
type StandaloneRuntimeSmokeStage = typeof StandaloneRuntimeSmokeStage.Type;

class StandaloneRuntimeSmokeError extends Schema.TaggedError<StandaloneRuntimeSmokeError>()(
  "StandaloneRuntimeSmokeError",
  {
    stage: StandaloneRuntimeSmokeStage,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Standalone runtime smoke failed during ${this.stage}.`;
  }
}

const findEmbeddedNativeLibrary = (): string => {
  const extension =
    NodeProcess.platform === "linux"
      ? ".so"
      : NodeProcess.platform === "darwin"
        ? ".dylib"
        : undefined;
  NodeAssert.ok(
    extension !== undefined,
    `Unsupported native smoke platform: ${NodeProcess.platform}`,
  );
  const embeddedFileNames = embeddedFiles.flatMap((file) =>
    "name" in file && typeof file.name === "string" ? [file.name] : [],
  );
  const nativeEmbeddedFileName = embeddedFileNames.find(
    (fileName) =>
      (fileName.startsWith("libfff_c") || fileName.includes("libfff_c")) &&
      fileName.endsWith(extension),
  );
  NodeAssert.ok(
    nativeEmbeddedFileName !== undefined,
    `Embedded native FFF library was not found for ${NodeProcess.platform}: ${embeddedFileNames.join(
      ", ",
    )}`,
  );
  return nativeEmbeddedFileName;
};

const parseRoot = (argv: ReadonlyArray<string>): string => {
  const root = argv[2];
  if (root === undefined) {
    throw new StandaloneRuntimeSmokeError({
      stage: "arguments",
      cause: "Usage: standaloneRuntimeSmoke <absolute-disposable-root>",
    });
  }
  if (!NodePath.isAbsolute(root)) {
    throw new StandaloneRuntimeSmokeError({
      stage: "arguments",
      cause: `The disposable root must be absolute: ${root}`,
    });
  }
  return root;
};

const prepareWorkspace = Effect.fn("prepareStandaloneRuntimeSmokeWorkspace")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = path.join(root, "workspace", "nested");
  const needlePath = path.join(workspace, NEEDLE_FILE_NAME);

  yield* fs.makeDirectory(workspace, { recursive: true });
  yield* fs.writeFileString(needlePath, `${NEEDLE}\n`);

  return {
    workspace,
    needlePath,
  };
});

const runNativeSearch = Effect.fn("runStandaloneRuntimeSmokeNativeSearch")(function* (
  root: string,
  workspace: string,
  needlePath: string,
) {
  const path = yield* Path.Path;
  const expectedRelativePath = path.relative(workspace, needlePath).replaceAll("\\", "/");

  return yield* Effect.tryPromise({
    try: async () => {
      const nativeEmbeddedFileName = findEmbeddedNativeLibrary();
      let finder: FileFinder | undefined;
      try {
        const created = FileFinder.create({
          basePath: workspace,
          frecencyDbPath: path.join(root, "frecency.mdb"),
          historyDbPath: path.join(root, "history.mdb"),
          disableMmapCache: true,
          disableContentIndexing: true,
          disableWatch: true,
        });
        if (!created.ok) {
          throw new StandaloneRuntimeSmokeError({
            stage: "native-create",
            cause: created.error,
          });
        }
        finder = created.value;

        const ready = await finder.waitForIndexReady(15000);
        if (!ready.ok) {
          throw new StandaloneRuntimeSmokeError({
            stage: "native-ready",
            cause: ready.error,
          });
        }
        NodeAssert.equal(ready.value, true, "FileFinder index did not become ready.");

        const search = finder.fileSearch(NEEDLE);
        if (!search.ok) {
          throw new StandaloneRuntimeSmokeError({
            stage: "native-search",
            cause: search.error,
          });
        }
        NodeAssert.ok(
          search.value.items.some(
            (item) => item.relativePath.replaceAll("\\", "/") === expectedRelativePath,
          ),
          `FileFinder did not return ${expectedRelativePath}.`,
        );
        return nativeEmbeddedFileName;
      } finally {
        finder?.destroy();
      }
    },
    catch: (cause) => new StandaloneRuntimeSmokeError({ stage: "native-search", cause }),
  });
});

const readStandaloneWebIndex = Effect.fn("readStandaloneRuntimeSmokeWebIndex")(function* () {
  return yield* Effect.try({
    try: () => {
      const staticDir = resolveStandaloneStaticDir();
      NodeAssert.ok(staticDir !== undefined, "Standalone web assets were not embedded.");
      const indexPath = NodePath.join(staticDir, "index.html");
      NodeAssert.ok(NodePath.isAbsolute(indexPath), "Standalone index path must be absolute.");

      NodeAssert.ok(NodeFS.existsSync(indexPath), `Standalone index does not exist: ${indexPath}`);
      const indexBytes = NodeFS.readFileSync(indexPath);
      NodeAssert.ok(indexBytes.byteLength > 0, "Standalone index.html is empty.");

      return NodeCrypto.createHash("sha256").update(indexBytes).digest("hex");
    },
    catch: (cause) => new StandaloneRuntimeSmokeError({ stage: "web-index", cause }),
  });
});

const runSqliteSmoke = Effect.fn("runStandaloneRuntimeSmokeSqlite")(function* (
  root: string,
  value: string,
) {
  const path = yield* Path.Path;
  const databasePath = path.join(root, "db", "state.sqlite");
  const persistence = layerFromPath(databasePath).pipe(Layer.provide(NodeServices.layer));

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE IF NOT EXISTS standalone_smoke (value TEXT NOT NULL)`;
    yield* sql`DELETE FROM standalone_smoke`;
    yield* sql`INSERT INTO standalone_smoke (value) VALUES (${value})`;
    const rows = yield* sql<{ value: string }>`SELECT value FROM standalone_smoke`;
    NodeAssert.equal(rows[0]?.value, value, "SQLite smoke value did not round-trip.");
  }).pipe(Effect.provide(persistence));
});

const runStandaloneRuntimeSmoke = Effect.fn("runStandaloneRuntimeSmoke")(function* (root: string) {
  const { workspace, needlePath } = yield* prepareWorkspace(root);
  const nativeEmbeddedFileName = yield* runNativeSearch(root, workspace, needlePath);
  const webIndexSha256 = yield* readStandaloneWebIndex();
  yield* runSqliteSmoke(root, SQLITE_VALUE);

  return {
    nativeSearch: true,
    sqlite: true,
    webIndexSha256,
    nativeEmbeddedFileName,
  } as const;
});

if (import.meta.main) {
  const root = parseRoot(NodeProcess.argv);
  runStandaloneRuntimeSmoke(root).pipe(
    Effect.flatMap((result) => Console.log(JSON.stringify(result))),
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
