// @effect-diagnostics nodeBuiltinImport:off - This controller owns disposable native subprocess fixtures.
import * as NodeSqlite from "node:sqlite";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import { layerConfig as SqlitePersistenceLayerConfig, layerFromPath } from "./Sqlite.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as RuntimeSqliteClient from "./RuntimeSqliteClient.ts";

type RuntimeKind = "node" | "bun";
const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type RuntimeSpec = {
  readonly kind: RuntimeKind;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly expectedVersion?: string;
  readonly expectedExecutable?: string;
};

type HelperProcess = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

type DurableSnapshot = {
  readonly main: Buffer;
  readonly wal: Buffer | undefined;
};

const helperPath = NodeURL.fileURLToPath(import.meta.resolve("./SqliteInspection.runtime.ts"));

const explicitNodeExecutable = process.env.T3CODE_TEST_NODE_EXECUTABLE?.trim();
const nodeExecutable = explicitNodeExecutable
  ? NodePath.resolve(explicitNodeExecutable)
  : process.execPath;
if (explicitNodeExecutable !== undefined) {
  try {
    NodeFS.accessSync(nodeExecutable, NodeFS.constants.X_OK);
  } catch {
    throw new Error(`[sqlite-runtime] Explicit Node executable is unavailable: ${nodeExecutable}`);
  }
}

const explicitBunExecutable = process.env.T3CODE_TEST_BUN_EXECUTABLE?.trim();
const bunExecutableCandidates = explicitBunExecutable
  ? [NodePath.resolve(explicitBunExecutable)]
  : (["/home/dev/.bun/bin/bun1.3.14", "/home/dev/.bun/bin/bun"] as const);

const bunAvailability = (() => {
  for (const executable of bunExecutableCandidates) {
    try {
      NodeFS.accessSync(executable, NodeFS.constants.X_OK);
      return { available: true as const, executable };
    } catch {
      // Try the next known local Bun installation path.
    }
  }

  return {
    available: false as const,
    reason: bunExecutableCandidates.map((executable) => `${executable}: unavailable`).join(", "),
  };
})();

if (!bunAvailability.available) {
  if (explicitBunExecutable !== undefined) {
    throw new Error(
      `[sqlite-runtime] Explicit Bun executable is unavailable: ${bunAvailability.reason}`,
    );
  }
  process.stderr.write(
    `[sqlite-runtime] Bun skipped because no known executable is available: ${bunAvailability.reason}\n`,
  );
} else if (bunAvailability.executable !== bunExecutableCandidates[0]) {
  process.stderr.write(
    `[sqlite-runtime] ${bunExecutableCandidates[0]} is unavailable; using ${bunAvailability.executable}\n`,
  );
}

const runtimeSpecs: ReadonlyArray<RuntimeSpec> = [
  {
    kind: "node",
    executable: nodeExecutable,
    args: ["--experimental-strip-types"],
    expectedVersion: explicitNodeExecutable === undefined ? process.versions.node : "26.8.2",
    expectedExecutable: nodeExecutable,
  },
  ...(bunAvailability.available
    ? [
        {
          kind: "bun" as const,
          executable: bunAvailability.executable,
          args: [],
          ...(explicitBunExecutable !== undefined
            ? { expectedVersion: "1.3.14", expectedExecutable: bunAvailability.executable }
            : {}),
        },
      ]
    : []),
];

const HelperRuntimeSchema = Schema.Struct({
  kind: Schema.Literals(["node", "bun"]),
  version: Schema.String,
  executable: Schema.String,
});

const HelperErrorSchema = Schema.Struct({
  tag: Schema.String,
  message: Schema.String,
  reasonTag: Schema.String,
  nativeCode: Schema.String,
  sqliteCode: Schema.String,
  nativeMessage: Schema.String,
});

const HelperResultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    action: Schema.String,
    runtime: HelperRuntimeSchema,
    value: Schema.Unknown,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    action: Schema.String,
    runtime: HelperRuntimeSchema,
    error: HelperErrorSchema,
  }),
]);

type HelperResult = Schema.Schema.Type<typeof HelperResultSchema>;

const decodeHelperResult = Schema.decodeUnknownSync(Schema.fromJsonString(HelperResultSchema));

const ExistingObservationSchema = Schema.TaggedStruct("Existing", {
  dbPath: Schema.String,
  schema: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      name: Schema.String,
      tbl_name: Schema.String,
      sql: Schema.NullOr(Schema.String),
    }),
  ),
  migrationJournal: Schema.Union([
    Schema.TaggedStruct("Absent", {}),
    Schema.TaggedStruct("Present", {
      tableInfo: Schema.Array(Schema.Unknown),
      rows: Schema.Array(
        Schema.Struct({
          migration_id: Schema.Int,
          name: Schema.String,
          created_at: Schema.String,
        }),
      ),
    }),
  ]),
});

const MarkerRowsSchema = Schema.Array(
  Schema.Struct({
    id: Schema.Int,
    value: Schema.String,
  }),
);

const SeedObservationSchema = Schema.Struct({
  latestMigrationId: Schema.NullOr(Schema.Int),
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      title: Schema.String,
    }),
  ),
});

const SeedCancellationObservationSchema = Schema.Struct({
  linkReached: Schema.Boolean,
  snapshotPath: Schema.optional(Schema.String),
  destinationPath: Schema.optional(Schema.String),
  snapshotExistsAtBoundary: Schema.Boolean,
  destinationExistsAtBoundary: Schema.optional(Schema.Boolean),
  sourceOpenDescriptorsAtBoundary: Schema.NullOr(Schema.Int),
  interrupted: Schema.Boolean,
  snapshotDirectoryRemoved: Schema.optional(Schema.Boolean),
  temporaryDirectoryRemoved: Schema.optional(Schema.Boolean),
  destinationExistsAfterInterrupt: Schema.Boolean,
  sourceUnchanged: Schema.Boolean,
  sourceOpenDescriptorsAfterInterrupt: Schema.NullOr(Schema.Int),
});

const RuntimeUsageRecordSchema = Schema.Struct({
  provider: Schema.String,
  timestampMs: Schema.Number,
  model: Schema.String,
  sessionId: Schema.String,
  totals: Schema.Struct({
    uncachedInputTokens: Schema.Number,
    cachedInputTokens: Schema.Number,
    cacheCreationTokens: Schema.Number,
    outputTokens: Schema.Number,
    reasoningTokens: Schema.Number,
  }),
  reportedCostUsd: Schema.NullOr(Schema.Number),
  speed: Schema.String,
  dedupeKey: Schema.NullOr(Schema.String),
});

const RuntimeUsageObservationSchema = Schema.Struct({
  openCode: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({ path: Schema.String, records: Schema.Array(RuntimeUsageRecordSchema) }),
    ),
    missing: Schema.Boolean,
    error: Schema.Boolean,
  }),
  antigravity: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        root: Schema.String,
        path: Schema.String,
        records: Schema.Array(RuntimeUsageRecordSchema),
      }),
    ),
    errors: Schema.Array(Schema.String),
  }),
});

const decodeExistingObservationValue = Schema.decodeUnknownSync(ExistingObservationSchema);
const decodeMarkerRowsValue = Schema.decodeUnknownSync(MarkerRowsSchema);
const decodeSeedObservationValue = Schema.decodeUnknownSync(SeedObservationSchema);
const decodeSeedCancellationObservationValue = Schema.decodeUnknownSync(
  SeedCancellationObservationSchema,
);
const decodeRuntimeUsageObservationValue = Schema.decodeUnknownSync(RuntimeUsageObservationSchema);

const protoNumber = (field: number, value: number): number[] => {
  const varint = (input: number) => {
    const bytes: number[] = [];
    do {
      const byte = input % 128;
      input = Math.floor(input / 128);
      bytes.push(byte + (input > 0 ? 128 : 0));
    } while (input > 0);
    return bytes;
  };
  return [...varint(field * 8), ...varint(value)];
};

const protoBytes = (field: number, value: readonly number[]): number[] => {
  const tag = protoNumber(field, value.length);
  tag[0] = tag[0]! + 2;
  return [...tag, ...value];
};

const protoText = (field: number, value: string): number[] =>
  protoBytes(field, [...Buffer.from(value)]);

const createNativePrefix = (dbPath: string, toMigrationInclusive: number) =>
  runMigrations({ toMigrationInclusive }).pipe(
    Effect.scoped,
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
  );

const openWalFixtureWriter = (dbPath: string): NodeSqlite.DatabaseSync => {
  const writer = new NodeSqlite.DatabaseSync(dbPath);
  writer.exec(`
    CREATE TABLE runtime_probe_marker (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA wal_autocheckpoint = 0");
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.exec("BEGIN IMMEDIATE");
  writer
    .prepare("INSERT INTO runtime_probe_marker (id, value) VALUES (?, ?)")
    .run(1, "wal-only-marker");
  const updated = writer
    .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?")
    .run("PendingInteractions", 1);
  assert.equal(Number(updated.changes), 1, "the prefix-1 journal row was not updated");
  writer.exec("COMMIT");

  const walPath = `${dbPath}-wal`;
  assert.equal(NodeFS.existsSync(walPath), true, "the WAL-only fixture did not create a WAL");
  assert.ok(NodeFS.readFileSync(walPath).byteLength > 0, "the WAL-only fixture WAL is empty");
  return writer;
};

const openCompatibleSeedFixtureWriter = (dbPath: string): NodeSqlite.DatabaseSync => {
  const writer = new NodeSqlite.DatabaseSync(dbPath);
  writer.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
  `);
  writer
    .prepare(
      "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "runtime-seed-project",
      "Seeded from V1",
      "/tmp/runtime-seed-project",
      "[]",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.exec("BEGIN IMMEDIATE");
  writer
    .prepare("UPDATE projection_projects SET title = ? WHERE project_id = ?")
    .run("Committed WAL marker", "runtime-seed-project");
  writer.exec("COMMIT");
  const walPath = `${dbPath}-wal`;
  assert.equal(
    NodeFS.existsSync(walPath),
    true,
    "the compatible seed fixture did not create a WAL",
  );
  assert.ok(
    NodeFS.readFileSync(walPath).byteLength > 0,
    "the compatible seed fixture WAL is empty",
  );
  return writer;
};

const readDurableSnapshot = (dbPath: string): DurableSnapshot => ({
  main: Buffer.from(NodeFS.readFileSync(dbPath)),
  wal: NodeFS.existsSync(`${dbPath}-wal`)
    ? Buffer.from(NodeFS.readFileSync(`${dbPath}-wal`))
    : undefined,
});

const assertDurableSnapshotUnchanged = (
  label: string,
  before: DurableSnapshot,
  after: DurableSnapshot,
) => {
  assert.equal(after.main.equals(before.main), true, `${label}: main bytes changed`);
  assert.equal(
    before.wal === undefined ? after.wal === undefined : after.wal?.equals(before.wal) === true,
    true,
    `${label}: WAL bytes changed`,
  );
};

const copyResidualFixture = (sourcePath: string, targetPath: string) => {
  NodeFS.copyFileSync(sourcePath, targetPath);
  NodeFS.copyFileSync(`${sourcePath}-wal`, `${targetPath}-wal`);
  assert.equal(
    NodeFS.existsSync(`${targetPath}-shm`),
    false,
    `${targetPath}: residual copy unexpectedly has a shared-memory sidecar`,
  );
};

const copyMainOnlyFixture = (sourcePath: string, targetPath: string) => {
  NodeFS.copyFileSync(sourcePath, targetPath);
  assert.equal(
    NodeFS.existsSync(`${targetPath}-wal`),
    false,
    `${targetPath}: main-only control unexpectedly has a WAL sidecar`,
  );
  assert.equal(
    NodeFS.existsSync(`${targetPath}-shm`),
    false,
    `${targetPath}: main-only control unexpectedly has a shared-memory sidecar`,
  );
};

const runHelper = (runtime: RuntimeSpec, dbPath: string, action: string) =>
  Effect.promise(
    () =>
      new Promise<HelperProcess>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const child = NodeChildProcess.spawn(
          runtime.executable,
          [...runtime.args, helperPath, dbPath, action],
          {
            cwd: NodePath.dirname(helperPath),
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", (code) => {
          resolve({ exitCode: code ?? -1, stdout, stderr });
        });
      }),
  );

const decodeHelperOutput = (
  runtime: RuntimeSpec,
  action: string,
  result: HelperProcess,
): HelperResult => {
  const label = `[${runtime.kind}/${action}]`;
  assert.equal(
    result.exitCode,
    0,
    `${label} exited with ${result.exitCode}; stdout=${result.stdout}; stderr=${result.stderr}`,
  );
  const stdout = result.stdout.trim();
  assert.ok(stdout.length > 0, `${label} produced no serialized result`);
  const jsonLine = stdout.split(/\r?\n/).at(-1) ?? "";
  const decoded = decodeHelperResult(jsonLine);
  assert.equal(decoded.action, action, `${label} reported the wrong action`);
  assert.equal(decoded.runtime.kind, runtime.kind, `${label} selected the wrong runtime`);
  assert.ok(decoded.runtime.version.length > 0, `${label} omitted its runtime version`);
  if (runtime.expectedVersion !== undefined) {
    assert.equal(decoded.runtime.version, runtime.expectedVersion, `${label} runtime version`);
  }
  if (runtime.expectedExecutable !== undefined) {
    assert.equal(decoded.runtime.executable, runtime.expectedExecutable, `${label} executable`);
  }
  return decoded;
};

const runHelperAndDecode = (runtime: RuntimeSpec, dbPath: string, action: string) =>
  Effect.gen(function* () {
    const processResult = yield* runHelper(runtime, dbPath, action);
    return decodeHelperOutput(runtime, action, processResult);
  });

const assertCompatibilityFailure = (runtime: RuntimeSpec, action: string, result: HelperResult) => {
  const label = `[${runtime.kind}/${action}]`;
  assert.equal(result.ok, false, `${label} unexpectedly succeeded`);
  if (result.ok) return;
  assert.equal(result.error.tag, "SqliteCompatibilityError", `${label} error tag`);
  assert.ok(result.error.message.includes("No source migrations"), `${label} error message`);
  assert.ok(
    result.error.message.includes(
      "Keep this database unchanged. Use the original compatible application or select a separate native database/home. Do not edit the migration journal or attempt in-place repair.",
    ),
    `${label} actionable guidance`,
  );
};

const assertInspectionFailure = (runtime: RuntimeSpec, action: string, result: HelperResult) => {
  const label = `[${runtime.kind}/${action}]`;
  assert.equal(result.ok, false, `${label} unexpectedly succeeded`);
  if (result.ok) return;
  assert.equal(result.error.tag, "SqliteInspectionError", `${label} error tag`);
  assert.ok(result.error.message.includes("No target migrations"), `${label} error message`);
};

const assertReadonlyWriteFailure = (runtime: RuntimeSpec, result: HelperResult) => {
  const label = `[${runtime.kind}/readonly-write]`;
  assert.equal(result.ok, false, `${label} unexpectedly succeeded`);
  if (result.ok) return;
  assert.equal(result.error.tag, "SqlError", `${label} error tag`);
  assert.equal(result.error.sqliteCode, "SQLITE_READONLY", `${label} SQLite error code`);
  assert.notEqual(result.error.reasonTag, "ConstraintError", `${label} constraint error`);
  assert.ok(
    result.error.nativeMessage.toUpperCase().includes("READONLY"),
    `${label} native error message`,
  );
};

const decodeExistingObservation = (runtime: RuntimeSpec, result: HelperResult) => {
  const label = `[${runtime.kind}/inspect]`;
  assert.equal(result.ok, true, `${label} unexpectedly failed`);
  if (!result.ok) return undefined;
  return decodeExistingObservationValue(result.value);
};

const decodeMarkerRows = (runtime: RuntimeSpec, action: string, result: HelperResult) => {
  const label = `[${runtime.kind}/${action}]`;
  assert.equal(result.ok, true, `${label} unexpectedly failed`);
  if (!result.ok) return [];
  return decodeMarkerRowsValue(result.value);
};

const decodeSeedObservation = (runtime: RuntimeSpec, result: HelperResult) => {
  const label = `[${runtime.kind}/seed]`;
  assert.equal(result.ok, true, `${label} unexpectedly failed: ${JSON.stringify(result)}`);
  if (!result.ok) return undefined;
  return decodeSeedObservationValue(result.value);
};

const decodeSeedCancellationObservation = (runtime: RuntimeSpec, result: HelperResult) => {
  const label = `[${runtime.kind}/seed-cancel]`;
  assert.equal(result.ok, true, `${label} unexpectedly failed: ${JSON.stringify(result)}`);
  if (!result.ok) return undefined;
  return decodeSeedCancellationObservationValue(result.value);
};

const exerciseWalOnlyResidual = (runtime: RuntimeSpec) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: `t3-sqlite-runtime-${runtime.kind}-`,
    });
    const sourcePath = NodePath.join(root, "source.sqlite");
    yield* createNativePrefix(sourcePath, 1);

    const writer = yield* Effect.acquireRelease(
      Effect.sync(() => openWalFixtureWriter(sourcePath)),
      (database) => Effect.sync(() => database.close()),
    );
    void writer;

    const inspectPath = NodePath.join(root, "inspect.sqlite");
    yield* Effect.sync(() => copyResidualFixture(sourcePath, inspectPath));
    const inspection = yield* runHelperAndDecode(runtime, inspectPath, "inspect");
    const observation = decodeExistingObservation(runtime, inspection);
    assert.ok(observation !== undefined, `[${runtime.kind}/inspect] missing observation`);
    if (observation === undefined) return;
    assert.equal(observation.migrationJournal._tag, "Present", `[${runtime.kind}/inspect] journal`);
    if (observation.migrationJournal._tag !== "Present") return;
    assert.equal(
      observation.migrationJournal.rows.length,
      1,
      `[${runtime.kind}/inspect] row count`,
    );
    assert.equal(
      observation.migrationJournal.rows[0]?.name,
      "PendingInteractions",
      `[${runtime.kind}/inspect] WAL-only journal name`,
    );
    assert.equal(
      observation.schema.some((row) => row.name === "runtime_probe_marker"),
      true,
      `[${runtime.kind}/inspect] marker table visibility`,
    );

    const markerPath = NodePath.join(root, "marker-rows.sqlite");
    yield* Effect.sync(() => copyResidualFixture(sourcePath, markerPath));
    const markerResult = yield* runHelperAndDecode(runtime, markerPath, "marker-rows");
    assert.deepEqual(
      decodeMarkerRows(runtime, "marker-rows", markerResult),
      [{ id: 1, value: "wal-only-marker" }],
      `[${runtime.kind}/marker-rows] WAL-only marker visibility`,
    );

    for (const action of ["assert", "open"] as const) {
      const actionPath = NodePath.join(root, `${action}.sqlite`);
      yield* Effect.sync(() => copyResidualFixture(sourcePath, actionPath));
      const before = yield* Effect.sync(() => readDurableSnapshot(actionPath));
      const result = yield* runHelperAndDecode(runtime, actionPath, action);
      assertCompatibilityFailure(runtime, action, result);
      const after = yield* Effect.sync(() => readDurableSnapshot(actionPath));
      assertDurableSnapshotUnchanged(`[${runtime.kind}/${action}]`, before, after);
    }

    const readonlyWritePath = NodePath.join(root, "readonly-write.sqlite");
    yield* Effect.sync(() => copyResidualFixture(sourcePath, readonlyWritePath));
    const beforeReadonlyWrite = yield* Effect.sync(() => readDurableSnapshot(readonlyWritePath));
    const readonlyWrite = yield* runHelperAndDecode(runtime, readonlyWritePath, "readonly-write");
    assertReadonlyWriteFailure(runtime, readonlyWrite);
    const afterReadonlyWrite = yield* Effect.sync(() => readDurableSnapshot(readonlyWritePath));
    assertDurableSnapshotUnchanged(
      `[${runtime.kind}/readonly-write]`,
      beforeReadonlyWrite,
      afterReadonlyWrite,
    );
    const markerAfterReadonlyWrite = yield* runHelperAndDecode(
      runtime,
      readonlyWritePath,
      "marker-rows",
    );
    assert.deepEqual(
      decodeMarkerRows(runtime, "marker-rows-after-readonly-write", markerAfterReadonlyWrite),
      [{ id: 1, value: "wal-only-marker" }],
      `[${runtime.kind}/readonly-write] marker data changed`,
    );

    const mainOnlyPath = NodePath.join(root, "main-only.sqlite");
    yield* Effect.sync(() => copyMainOnlyFixture(sourcePath, mainOnlyPath));
    const mainOnlyMarkers = yield* runHelperAndDecode(runtime, mainOnlyPath, "marker-rows");
    assert.deepEqual(
      decodeMarkerRows(runtime, "main-only", mainOnlyMarkers),
      [],
      `[${runtime.kind}/main-only] marker row was present without the WAL`,
    );
  });

const exerciseFreshRuntime = (runtime: RuntimeSpec) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: `t3-sqlite-fresh-${runtime.kind}-` });
    const dbPath = NodePath.join(root, "nested", "state.sqlite");

    assert.equal(
      NodeFS.existsSync(dbPath),
      false,
      `[${runtime.kind}/fresh-open] path already exists`,
    );
    const created = yield* runHelperAndDecode(runtime, dbPath, "open");
    assert.equal(created.ok, true, `[${runtime.kind}/fresh-open] creation failed`);
    assert.equal(NodeFS.existsSync(dbPath), true, `[${runtime.kind}/fresh-open] file missing`);

    const inspection = yield* runHelperAndDecode(runtime, dbPath, "inspect");
    const observation = decodeExistingObservation(runtime, inspection);
    assert.ok(observation !== undefined, `[${runtime.kind}/fresh-inspect] missing observation`);
    if (observation === undefined) return;
    assert.equal(
      observation.migrationJournal._tag,
      "Present",
      `[${runtime.kind}/fresh-inspect] journal`,
    );
    if (observation.migrationJournal._tag !== "Present") return;
    assert.equal(
      observation.migrationJournal.rows.length,
      migrationManifest.length,
      `[${runtime.kind}/fresh-inspect] migration count`,
    );

    const reopened = yield* runHelperAndDecode(runtime, dbPath, "open");
    assert.equal(reopened.ok, true, `[${runtime.kind}/reopen] reopen failed`);
  });

const exerciseMissingAndMalformed = (runtime: RuntimeSpec) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: `t3-sqlite-invalid-${runtime.kind}-`,
    });

    const missingPath = NodePath.join(root, "missing.sqlite");
    const missingInspection = yield* runHelperAndDecode(runtime, missingPath, "inspect");
    assert.equal(
      missingInspection.ok,
      true,
      `[${runtime.kind}/missing-inspect] unexpectedly failed`,
    );
    if (!missingInspection.ok) return;
    assert.deepEqual(
      missingInspection.value,
      { _tag: "Missing", dbPath: missingPath },
      `[${runtime.kind}/missing-inspect] observation`,
    );

    const missingAssertion = yield* runHelperAndDecode(runtime, missingPath, "assert");
    assert.equal(missingAssertion.ok, true, `[${runtime.kind}/missing-assert] unexpectedly failed`);
    assert.equal(
      NodeFS.existsSync(missingPath),
      false,
      `[${runtime.kind}/missing-assert] inspection created the database`,
    );

    const missingReadonlyOpen = yield* runHelperAndDecode(runtime, missingPath, "readonly-open");
    assert.equal(
      missingReadonlyOpen.ok,
      false,
      `[${runtime.kind}/missing-readonly-open] unexpectedly opened a missing database`,
    );
    assert.equal(
      NodeFS.existsSync(missingPath),
      false,
      `[${runtime.kind}/missing-readonly-open] created the database`,
    );

    const malformedPath = NodePath.join(root, "malformed.sqlite");
    yield* fs.writeFile(
      malformedPath,
      new Uint8Array([0x6e, 0x6f, 0x74, 0x2d, 0x73, 0x71, 0x6c, 0x69, 0x74, 0x65]),
    );

    for (const action of ["inspect", "assert", "open"] as const) {
      const before = yield* Effect.sync(() => readDurableSnapshot(malformedPath));
      const result = yield* runHelperAndDecode(runtime, malformedPath, action);
      assertInspectionFailure(runtime, action, result);
      const after = yield* Effect.sync(() => readDurableSnapshot(malformedPath));
      assertDurableSnapshotUnchanged(`[${runtime.kind}/${action}]`, before, after);
    }
  });

const exerciseCompatibleSeed = (runtime: RuntimeSpec) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: `t3-sqlite-seed-${runtime.kind}-` });
    const sourcePath = NodePath.join(root, "state.sqlite");
    const destinationPath = NodePath.join(root, "statev2.sqlite");
    yield* createNativePrefix(sourcePath, 52);

    const writer = yield* Effect.acquireRelease(
      Effect.sync(() => openCompatibleSeedFixtureWriter(sourcePath)),
      (database) => Effect.sync(() => database.close()),
    );
    void writer;
    const before = yield* Effect.sync(() => readDurableSnapshot(sourcePath));

    const first = yield* runHelperAndDecode(runtime, destinationPath, "seed");
    assert.deepEqual(
      NodeFS.readdirSync(root).filter((entry) => entry.startsWith(".v2-import-")),
      [],
      `[${runtime.kind}/seed] left a snapshot temporary directory`,
    );
    const firstObservation = decodeSeedObservation(runtime, first);
    assert.ok(firstObservation !== undefined, `[${runtime.kind}/seed] missing first observation`);
    if (firstObservation === undefined) return;
    assert.equal(firstObservation.latestMigrationId, migrationManifest.length);
    assert.deepEqual(firstObservation.projects, [
      { projectId: "runtime-seed-project", title: "Committed WAL marker" },
    ]);

    const seeded = new NodeSqlite.DatabaseSync(destinationPath);
    try {
      seeded
        .prepare(
          "INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "runtime-destination-only",
          "Destination only",
          "/tmp/runtime-destination-only",
          "[]",
          "2026-01-02T00:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
        );
    } finally {
      seeded.close();
    }

    const second = yield* runHelperAndDecode(runtime, destinationPath, "seed");
    assert.deepEqual(
      NodeFS.readdirSync(root).filter((entry) => entry.startsWith(".v2-import-")),
      [],
      `[${runtime.kind}/reopen] left a snapshot temporary directory`,
    );
    const secondObservation = decodeSeedObservation(runtime, second);
    assert.ok(secondObservation !== undefined, `[${runtime.kind}/seed] missing reopen observation`);
    if (secondObservation === undefined) return;
    assert.equal(secondObservation.latestMigrationId, migrationManifest.length);
    assert.deepEqual(secondObservation.projects, [
      { projectId: "runtime-destination-only", title: "Destination only" },
      { projectId: "runtime-seed-project", title: "Committed WAL marker" },
    ]);
    assertDurableSnapshotUnchanged(
      `[${runtime.kind}/seed] source bytes changed`,
      before,
      yield* Effect.sync(() => readDurableSnapshot(sourcePath)),
    );
  });

const exerciseIncompatibleSeed = (runtime: RuntimeSpec) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: `t3-sqlite-incompatible-seed-${runtime.kind}-`,
    });
    const sourcePath = NodePath.join(root, "state.sqlite");
    const destinationPath = NodePath.join(root, "statev2.sqlite");
    yield* createNativePrefix(sourcePath, 1);

    const writer = yield* Effect.acquireRelease(
      Effect.sync(() => openWalFixtureWriter(sourcePath)),
      (database) => Effect.sync(() => database.close()),
    );
    void writer;
    const before = yield* Effect.sync(() => readDurableSnapshot(sourcePath));
    const result = yield* runHelperAndDecode(runtime, destinationPath, "seed");
    assertCompatibilityFailure(runtime, "seed", result);
    assert.deepEqual(
      NodeFS.readdirSync(root).filter((entry) => entry.startsWith(".v2-import-")),
      [],
      `[${runtime.kind}/seed] incompatible source created a snapshot temporary directory`,
    );
    assert.equal(NodeFS.existsSync(destinationPath), false, `[${runtime.kind}/seed] created V2`);
    assertDurableSnapshotUnchanged(
      `[${runtime.kind}/seed] incompatible source bytes changed`,
      before,
      yield* Effect.sync(() => readDurableSnapshot(sourcePath)),
    );
  });

const exerciseCancelledSeed = (runtime: RuntimeSpec) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: `t3-sqlite-seed-cancel-${runtime.kind}-`,
    });
    const sourcePath = NodePath.join(root, "state.sqlite");
    const destinationPath = NodePath.join(root, "statev2.sqlite");
    yield* createNativePrefix(sourcePath, 52);

    const writer = yield* Effect.acquireRelease(
      Effect.sync(() => openCompatibleSeedFixtureWriter(sourcePath)),
      (database) => Effect.sync(() => database.close()),
    );
    void writer;
    const before = yield* Effect.sync(() => readDurableSnapshot(sourcePath));
    const result = yield* runHelperAndDecode(runtime, destinationPath, "seed-cancel");
    const observation = decodeSeedCancellationObservation(runtime, result);
    assert.ok(observation !== undefined, `[${runtime.kind}/seed-cancel] missing observation`);
    if (observation === undefined) return;
    const hostPlatform = yield* HostProcessPlatform;

    assert.equal(observation.linkReached, true, `[${runtime.kind}/seed-cancel] link stage`);
    assert.equal(
      observation.snapshotExistsAtBoundary,
      true,
      `[${runtime.kind}/seed-cancel] snapshot`,
    );
    assert.equal(
      observation.destinationExistsAtBoundary,
      false,
      `[${runtime.kind}/seed-cancel] early publish`,
    );
    assert.ok(
      observation.snapshotPath?.startsWith(NodePath.join(root, ".v2-import-")),
      `[${runtime.kind}/seed-cancel] snapshot path escaped the scoped import directory`,
    );
    assert.equal(observation.destinationPath, destinationPath);
    assert.equal(observation.interrupted, true, `[${runtime.kind}/seed-cancel] fiber exit`);
    assert.equal(
      observation.snapshotDirectoryRemoved,
      true,
      `[${runtime.kind}/seed-cancel] temp cleanup`,
    );
    assert.equal(
      observation.destinationExistsAfterInterrupt,
      false,
      `[${runtime.kind}/seed-cancel] destination`,
    );
    assert.equal(observation.sourceUnchanged, true, `[${runtime.kind}/seed-cancel] source bytes`);
    assertDurableSnapshotUnchanged(
      `[${runtime.kind}/seed-cancel] source main/WAL bytes changed`,
      before,
      yield* Effect.sync(() => readDurableSnapshot(sourcePath)),
    );
    if (hostPlatform === "linux") {
      assert.notEqual(
        observation.sourceOpenDescriptorsAtBoundary,
        null,
        `[${runtime.kind}/seed-cancel] source descriptor probe unavailable on Linux`,
      );
      assert.equal(
        observation.sourceOpenDescriptorsAtBoundary,
        0,
        `[${runtime.kind}/seed-cancel] source connection open before publish boundary`,
      );
      assert.equal(
        observation.sourceOpenDescriptorsAfterInterrupt,
        0,
        `[${runtime.kind}/seed-cancel] source connection leaked after cancellation`,
      );
    }
  });

const exerciseUsageReaders = (runtime: RuntimeSpec) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: `t3-sqlite-usage-${runtime.kind}-`,
    });
    const openCodeRoot = NodePath.join(root, "opencode");
    const antigravityRoot = NodePath.join(root, "antigravity");
    NodeFS.mkdirSync(openCodeRoot);
    NodeFS.mkdirSync(antigravityRoot);
    const openCodePath = NodePath.join(openCodeRoot, "opencode.db");
    const openCodeDb = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(openCodePath)),
      (database) => Effect.sync(() => database.close()),
    );
    openCodeDb.exec(
      "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)",
    );
    const insertOpenCode = openCodeDb.prepare("INSERT INTO message VALUES (?, ?, ?)");
    const firstMessage = {
      id: "runtime-usage-0",
      sessionID: "runtime-opencode-session",
      role: "assistant",
      modelID: "claude-sonnet-4-5",
      time: { created: 1780000000000 },
      cost: 0.25,
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } },
    };
    openCodeDb.exec("BEGIN");
    for (let index = 0; index < 257; index++) {
      const message = {
        ...firstMessage,
        id: `runtime-usage-${index}`,
        time: { created: 1780000000000 + index },
      };
      insertOpenCode.run(message.id, message.sessionID, encodeJsonValue(message));
    }
    openCodeDb.exec("COMMIT");
    const legacyDirectory = NodePath.join(
      openCodeRoot,
      "storage",
      "message",
      firstMessage.sessionID,
    );
    NodeFS.mkdirSync(legacyDirectory, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(legacyDirectory, `${firstMessage.id}.json`),
      encodeJsonValue(firstMessage),
    );

    const antigravityPath = NodePath.join(antigravityRoot, "session-1.db");
    const antigravityDb = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(antigravityPath)),
      (database) => Effect.sync(() => database.close()),
    );
    antigravityDb.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    antigravityDb.exec("CREATE TABLE gen_metadata (idx INTEGER, data BLOB)");
    const usage = [
      ...protoNumber(2, 12),
      ...protoNumber(3, 7),
      ...protoText(11, "runtime-response"),
    ];
    const stamp = protoNumber(1, 1780000000);
    const generation = protoBytes(1, [
      ...protoBytes(4, usage),
      ...protoText(19, "Gemini 3 Pro"),
      ...protoBytes(9, protoBytes(4, stamp)),
    ]);
    antigravityDb
      .prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)")
      .run(0, new Uint8Array(generation));

    const beforeOpenCode = readDurableSnapshot(openCodePath);
    const beforeAntigravity = readDurableSnapshot(antigravityPath);
    const result = yield* runHelperAndDecode(runtime, root, "usage");
    assert.equal(result.ok, true, `[${runtime.kind}/usage] read failed`);
    if (!result.ok) return;
    const observation = decodeRuntimeUsageObservationValue(result.value);

    assert.equal(observation.openCode.missing, false);
    assert.equal(observation.openCode.error, false);
    const openCodeRecords = observation.openCode.files.flatMap((file) => file.records);
    assert.equal(openCodeRecords.length, 257, `[${runtime.kind}/usage] streamed row count`);
    assert.equal(new Set(openCodeRecords.map((record) => record.dedupeKey)).size, 257);
    assert.deepEqual(openCodeRecords[0], {
      provider: "opencode",
      timestampMs: 1780000000000,
      model: "claude-sonnet-4-5",
      sessionId: "runtime-opencode-session",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 30,
        cacheCreationTokens: 10,
        outputTokens: 25,
        reasoningTokens: 5,
      },
      reportedCostUsd: 0.25,
      speed: "standard",
      dedupeKey: "opencode:runtime-usage-0",
    });
    assert.equal(openCodeRecords.at(-1)?.timestampMs, 1780000000256);

    assert.deepEqual(observation.antigravity.errors, []);
    assert.deepEqual(
      observation.antigravity.files.flatMap((file) => file.records),
      [
        {
          provider: "antigravity",
          timestampMs: 1780000000000,
          model: "gemini-3-pro",
          sessionId: "session-1",
          totals: {
            uncachedInputTokens: 12,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 7,
            reasoningTokens: 0,
          },
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: "antigravity:11:runtime-response",
        },
      ],
    );
    assertDurableSnapshotUnchanged(
      `[${runtime.kind}/usage] OpenCode source changed`,
      beforeOpenCode,
      readDurableSnapshot(openCodePath),
    );
    assertDurableSnapshotUnchanged(
      `[${runtime.kind}/usage] Antigravity source changed`,
      beforeAntigravity,
      readDurableSnapshot(antigravityPath),
    );
  });

afterEach(() => {
  vi.restoreAllMocks();
});

it.effect.each(runtimeSpecs)(
  "$kind observes WAL-only state through real runtime wrappers",
  (runtime) =>
    exerciseWalOnlyResidual(runtime).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(runtimeSpecs)("$kind creates and reopens a native database", (runtime) =>
  exerciseFreshRuntime(runtime).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(runtimeSpecs)("$kind reports missing and malformed databases", (runtime) =>
  exerciseMissingAndMalformed(runtime).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(runtimeSpecs)(
  "$kind seeds WAL state, migrates V1 and preserves existing V2",
  (runtime) =>
    exerciseCompatibleSeed(runtime).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(runtimeSpecs)("$kind rejects incompatible V1 before seeding", (runtime) =>
  exerciseIncompatibleSeed(runtime).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(runtimeSpecs)(
  "$kind removes a canceled legacy snapshot before publication",
  (runtime) =>
    exerciseCancelledSeed(runtime).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(runtimeSpecs)("$kind streams readonly OpenCode and Antigravity usage", (runtime) =>
  exerciseUsageReaders(runtime).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("layerConfig supplies its configured dbPath without starting the server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-layer-config-" });
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), root)),
    );

    yield* createNativePrefix(config.dbPath, 0);
    yield* Effect.void.pipe(
      Effect.scoped,
      Effect.provide(SqlitePersistenceLayerConfig.pipe(Layer.provide(ServerConfig.layer(config)))),
    );

    const rows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeSqliteClient.layer({ filename: config.dbPath, readonly: true })),
    );
    assert.equal(rows.length, migrationManifest.length, "layerConfig did not use its dbPath");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects before constructing a writable runtime client", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-gate-spy-" });
    const dbPath = NodePath.join(root, "rejected.sqlite");
    yield* createNativePrefix(dbPath, 1);
    yield* Effect.sync(() => {
      const writer = new NodeSqlite.DatabaseSync(dbPath);
      writer
        .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?")
        .run("PendingInteractions", 1);
      writer.close();
    });

    const calls: Array<RuntimeSqliteClient.RuntimeSqliteLayerConfig> = [];
    const original = RuntimeSqliteClient.makeRuntimeSqliteLayer;
    vi.spyOn(RuntimeSqliteClient, "makeRuntimeSqliteLayer").mockImplementation((config) => {
      calls.push(config);
      return original(config);
    });

    const result = yield* Effect.void.pipe(
      Effect.scoped,
      Effect.provide(layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
      Effect.match({
        onFailure: (error) => ({ _tag: "Failure", error }) as const,
        onSuccess: () => ({ _tag: "Success" }) as const,
      }),
    );
    assert.equal(result._tag, "Failure", "rejected database unexpectedly opened");
    if (result._tag !== "Failure") return;
    assert.equal(result.error._tag, "SqliteCompatibilityError", "gate error tag");

    const rejectedPathCalls = calls.filter((config) => config.filename === dbPath);
    assert.ok(rejectedPathCalls.length > 0, "inspection did not use the runtime wrapper");
    assert.equal(
      rejectedPathCalls.some((config) => config.readonly !== true),
      false,
      "rejected database requested a writable/default runtime client",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
