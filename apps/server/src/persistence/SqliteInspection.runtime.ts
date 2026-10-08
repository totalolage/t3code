import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { layerFromPath } from "./Sqlite.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import { assertSqliteDatabaseCompatible } from "./SqliteCompatibility.ts";
import { makeRuntimeSqliteLayer, openRuntimeSqliteReadOnly } from "./RuntimeSqliteClient.ts";
import { inspectSqliteDatabase, SqliteInspectionError } from "./SqliteInspection.ts";
import { readAntigravityUsage } from "../usage/antigravityUsageReader.ts";
import { readOpenCodeUsage } from "../usage/opencodeUsageReader.ts";

type Action =
  | "inspect"
  | "marker-rows"
  | "assert"
  | "open"
  | "readonly-write"
  | "readonly-open"
  | "seed"
  | "seed-cancel"
  | "usage";

type RuntimeInfo = {
  readonly kind: "node" | "bun";
  readonly version: string;
  readonly executable: string;
};

type SerializedError = {
  readonly tag: string;
  readonly message: string;
  readonly reasonTag: string;
  readonly nativeCode: string;
  readonly sqliteCode: string;
  readonly nativeMessage: string;
};

type HelperResult =
  | {
      readonly ok: true;
      readonly action: Action;
      readonly runtime: RuntimeInfo;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly action: Action;
      readonly runtime: RuntimeInfo;
      readonly error: SerializedError;
    };

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const runtime: RuntimeInfo = {
  kind: process.versions.bun === undefined ? "node" : "bun",
  version: process.versions.bun ?? process.versions.node,
  executable: process.execPath,
};

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const sqliteCodeFromCause = (
  reason: Readonly<Record<string, unknown>> | undefined,
  nativeCause: Readonly<Record<string, unknown>> | undefined,
) => {
  const stringCode = stringValue(nativeCause?.code) ?? stringValue(reason?.code);
  if (stringCode === "SQLITE_READONLY") return stringCode;

  const numericCode = numberValue(nativeCause?.errcode) ?? numberValue(nativeCause?.errno);
  return numericCode === 8 ? "SQLITE_READONLY" : (stringCode ?? "UnknownSqliteCode");
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

const equalOptionalBytes = (
  left: Option.Option<Uint8Array>,
  right: Option.Option<Uint8Array>,
): boolean =>
  Option.isNone(left)
    ? Option.isNone(right)
    : Option.isSome(right) && equalBytes(left.value, right.value);

const serializeError = (error: unknown): SerializedError => {
  const outer = recordOf(error);
  const reason = recordOf(outer?.reason) ?? recordOf(outer?.cause);
  const nativeCause = recordOf(reason?.cause);
  const rawNativeCause = reason?.cause;

  return {
    tag: stringValue(outer?._tag) ?? (error instanceof Error ? error.name : "UnknownError"),
    message:
      stringValue(outer?.message) ?? (error instanceof Error ? error.message : String(error)),
    reasonTag: stringValue(reason?._tag) ?? "UnknownReason",
    nativeCode: stringValue(nativeCause?.code) ?? stringValue(reason?.code) ?? "UnknownCode",
    sqliteCode: sqliteCodeFromCause(reason, nativeCause),
    nativeMessage:
      stringValue(nativeCause?.message) ??
      (rawNativeCause instanceof Error
        ? rawNativeCause.message
        : error instanceof Error
          ? (error.stack ?? error.message)
          : "UnknownNativeError"),
  };
};

class RuntimeUsageInspectionError extends Schema.TaggedError<RuntimeUsageInspectionError>()(
  "RuntimeUsageInspectionError",
  { root: Schema.String, cause: Schema.Defect() },
) {}

const runtimeSuccess = (action: Action, value: unknown): HelperResult => ({
  ok: true,
  action,
  runtime,
  value: value === undefined ? null : value,
});

const runtimeFailure = (action: Action, error: unknown): HelperResult => ({
  ok: false,
  action,
  runtime,
  error: serializeError(error),
});

const withRuntimeResult = <A, E, R>(action: Action, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => runtimeFailure(action, error),
      onSuccess: (value) => runtimeSuccess(action, value),
    }),
  );

const markerRows = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: number; readonly value: string }>`
      SELECT id, value
      FROM runtime_probe_marker
      ORDER BY id
    `;
  }).pipe(
    Effect.scoped,
    Effect.provide(makeRuntimeSqliteLayer({ filename: dbPath, readonly: true })),
  );

const readonlyWrite = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO runtime_probe_marker (id, value)
      VALUES (2, 'readonly-wrapper-probe')
    `;
    return null;
  }).pipe(
    Effect.scoped,
    Effect.provide(makeRuntimeSqliteLayer({ filename: dbPath, readonly: true })),
  );

const readonlyOpen = (dbPath: string) =>
  Effect.tryPromise({
    try: async () => {
      const database = await openRuntimeSqliteReadOnly(dbPath);
      database.close();
      return null;
    },
    catch: (cause) =>
      new SqliteInspectionError({
        dbPath,
        reason: "could not open the database in read-only mode",
        cause,
      }),
  });

const openDatabase = (dbPath: string) =>
  Effect.void.pipe(
    Effect.scoped,
    Effect.provide(layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.as(null),
  );

const seedDatabase = (dbPath: string) =>
  Effect.gen(function* () {
    yield* initializeV2Database(dbPath);
    yield* openDatabase(dbPath);
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const migrationRows = yield* sql<{ readonly id: number | null }>`
        SELECT MAX(migration_id) AS id FROM effect_sql_migrations
      `;
      const projects = yield* sql<{ readonly project_id: string; readonly title: string }>`
        SELECT project_id, title FROM projection_projects
        WHERE project_id IN ('runtime-seed-project', 'runtime-destination-only')
        ORDER BY project_id
      `;
      return {
        latestMigrationId: migrationRows[0]?.id ?? null,
        projects: projects.map((project) => ({
          projectId: project.project_id,
          title: project.title,
        })),
      };
    }).pipe(
      Effect.scoped,
      Effect.provide(makeRuntimeSqliteLayer({ filename: dbPath, readonly: true })),
    );
  });

const openFileDescriptorCount = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  filename: string,
) =>
  Effect.gen(function* () {
    const descriptors = yield* fileSystem.readDirectory("/proc/self/fd").pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError(
        (cause) =>
          new SqliteInspectionError({
            dbPath: filename,
            reason: "could not read the process file-descriptor directory",
            cause,
          }),
      ),
    );
    if (descriptors === null) return null;

    const realFilename = yield* fileSystem.realPath(filename).pipe(
      Effect.mapError(
        (cause) =>
          new SqliteInspectionError({
            dbPath: filename,
            reason: "could not resolve the database path for the descriptor probe",
            cause,
          }),
      ),
    );
    const matches = yield* Effect.forEach(descriptors, (descriptor) =>
      fileSystem.readLink(path.join("/proc/self/fd", descriptor)).pipe(
        Effect.map((target) => target === realFilename),
        Effect.catchIf(
          (cause) => cause.reason._tag === "NotFound",
          () => Effect.succeed(false),
        ),
        Effect.mapError(
          (cause) =>
            new SqliteInspectionError({
              dbPath: filename,
              reason: "could not read a process file-descriptor target",
              cause,
            }),
        ),
      ),
    );
    return matches.filter(Boolean).length;
  });

const seedAndInterruptBeforePublish = (dbPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const linkReached = yield* Deferred.make<{
      readonly fromPath: string;
      readonly toPath: string;
    }>();
    const sourcePath = path.join(path.dirname(dbPath), "state.sqlite");
    const readOptionalFile = (filename: string) =>
      fileSystem.exists(filename).pipe(
        Effect.flatMap((exists) =>
          exists
            ? fileSystem.readFile(filename).pipe(Effect.map(Option.some))
            : Effect.succeed(Option.none<Uint8Array>()),
        ),
        Effect.mapError(
          (cause) =>
            new SqliteInspectionError({
              dbPath: filename,
              reason: "could not read a file for the interrupted migration probe",
              cause,
            }),
        ),
      );
    const readSourceSnapshot = () =>
      Effect.gen(function* () {
        const main = yield* fileSystem.readFile(sourcePath).pipe(
          Effect.mapError(
            (cause) =>
              new SqliteInspectionError({
                dbPath: sourcePath,
                reason: "could not read the source database for the interrupted migration probe",
                cause,
              }),
          ),
        );
        const wal = yield* readOptionalFile(`${sourcePath}-wal`);
        return { main, wal };
      });
    const sourceBefore = yield* readSourceSnapshot();
    const blockedLinkFileSystem: FileSystem.FileSystem = {
      ...fileSystem,
      link: (fromPath, toPath) =>
        Deferred.succeed(linkReached, { fromPath, toPath }).pipe(Effect.andThen(Effect.never)),
    };
    const seedFiber = yield* Effect.forkChild(
      initializeV2Database(dbPath).pipe(
        Effect.provideService(FileSystem.FileSystem, blockedLinkFileSystem),
      ),
    );

    return yield* Effect.gen(function* () {
      const link = yield* Deferred.await(linkReached).pipe(Effect.timeoutOption("15 seconds"));
      if (Option.isNone(link)) {
        yield* Fiber.interrupt(seedFiber);
        const exit = yield* Fiber.await(seedFiber);
        return {
          linkReached: false,
          interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
          snapshotExistsAtBoundary: false,
          sourceOpenDescriptorsAtBoundary: null,
          temporaryDirectoryRemoved: (yield* fileSystem.readDirectory(path.dirname(dbPath))).every(
            (entry) => !entry.startsWith(".v2-import-"),
          ),
          destinationExistsAfterInterrupt: yield* fileSystem.exists(dbPath),
          sourceUnchanged: yield* readSourceSnapshot().pipe(
            Effect.map(
              (sourceAfter) =>
                equalBytes(sourceBefore.main, sourceAfter.main) &&
                equalOptionalBytes(sourceBefore.wal, sourceAfter.wal),
            ),
          ),
          sourceOpenDescriptorsAfterInterrupt: yield* openFileDescriptorCount(
            fileSystem,
            path,
            sourcePath,
          ),
        };
      }

      const { fromPath, toPath } = link.value;
      const snapshotDirectory = path.dirname(fromPath);
      const boundary = {
        snapshotExists: yield* fileSystem.exists(fromPath),
        destinationExists: yield* fileSystem.exists(toPath),
        sourceOpenDescriptors: yield* openFileDescriptorCount(fileSystem, path, sourcePath),
      };
      yield* Fiber.interrupt(seedFiber);
      const exit = yield* Fiber.await(seedFiber);
      const sourceAfter = yield* readSourceSnapshot();
      return {
        linkReached: true,
        snapshotPath: fromPath,
        destinationPath: toPath,
        snapshotExistsAtBoundary: boundary.snapshotExists,
        destinationExistsAtBoundary: boundary.destinationExists,
        sourceOpenDescriptorsAtBoundary: boundary.sourceOpenDescriptors,
        interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
        snapshotDirectoryRemoved: !(yield* fileSystem.exists(snapshotDirectory)),
        destinationExistsAfterInterrupt: yield* fileSystem.exists(toPath),
        sourceUnchanged:
          equalBytes(sourceBefore.main, sourceAfter.main) &&
          equalOptionalBytes(sourceBefore.wal, sourceAfter.wal),
        sourceOpenDescriptorsAfterInterrupt: yield* openFileDescriptorCount(
          fileSystem,
          path,
          sourcePath,
        ),
      };
    }).pipe(Effect.ensuring(Fiber.interrupt(seedFiber)));
  });

const readUsage = (root: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* Effect.tryPromise({
      try: async () => ({
        openCode: await readOpenCodeUsage(path.join(root, "opencode"), 0),
        antigravity: await readAntigravityUsage(path.join(root, "antigravity"), 0),
      }),
      catch: (cause) => new RuntimeUsageInspectionError({ root, cause }),
    });
  });

const dispatch = (dbPath: string, action: Action) => {
  switch (action) {
    case "inspect":
      return withRuntimeResult(action, inspectSqliteDatabase(dbPath));
    case "marker-rows":
      return withRuntimeResult(action, markerRows(dbPath));
    case "assert":
      return withRuntimeResult(action, assertSqliteDatabaseCompatible(dbPath));
    case "open":
      return withRuntimeResult(action, openDatabase(dbPath));
    case "readonly-write":
      return withRuntimeResult(action, readonlyWrite(dbPath));
    case "readonly-open":
      return withRuntimeResult(action, readonlyOpen(dbPath));
    case "seed":
      return withRuntimeResult(action, seedDatabase(dbPath));
    case "seed-cancel":
      return withRuntimeResult(action, seedAndInterruptBeforePublish(dbPath));
    case "usage":
      return withRuntimeResult(action, readUsage(dbPath));
  }
};

const args = process.argv.slice(2);
const dbPath = args[0];
const action = args[1];

if (
  dbPath === undefined ||
  (action !== "inspect" &&
    action !== "marker-rows" &&
    action !== "assert" &&
    action !== "open" &&
    action !== "readonly-write" &&
    action !== "readonly-open" &&
    action !== "seed" &&
    action !== "seed-cancel" &&
    action !== "usage")
) {
  process.stderr.write(
    "Usage: SqliteInspection.runtime.ts <database-path> <inspect|marker-rows|assert|open|readonly-write|readonly-open|seed|seed-cancel|usage>\n",
  );
  process.exitCode = 2;
} else {
  const result = dispatch(dbPath, action).pipe(Effect.provide(NodeServices.layer));
  Effect.runPromise(result)
    .then((output) => {
      process.stdout.write(`${encodeJson(output)}\n`);
    })
    .catch((error: unknown) => {
      process.stdout.write(`${encodeJson(runtimeFailure(action, error))}\n`);
      process.exitCode = 1;
    });
}
