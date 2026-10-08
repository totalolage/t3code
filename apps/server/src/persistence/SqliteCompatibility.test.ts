import * as NodeServices from "@effect/platform-node/NodeServices";
import { DATABASE_INCOMPATIBLE_EXIT_CODE, DesktopBackendTerminalFailure } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import type { SqlError } from "effect/sql/SqlError";
import { Command } from "effect/cli";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { layerFromPath } from "./Sqlite.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import type { SqliteMigrationLineageError } from "./ForkSqliteMigration.ts";
import OrchestrationV2Preview from "./Migrations/055_OrchestrationV2.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import { assertSqliteDatabaseCompatible, SqliteCompatibilityError } from "./SqliteCompatibility.ts";
import {
  createDeployedForkV1Schema,
  createNativeWebhookJournal,
  createPriorPort60Journal,
  nativeWebhookFixtureIds,
  nativeMcpAppFixtureIds,
  priorPort60FixtureIds,
} from "./testkit/DeployedForkV1Fixture.ts";
import {
  inspectSqliteDatabase,
  SqliteInspectionError,
  type SqliteInspectionObservation,
} from "./SqliteInspection.ts";

type FixtureError = Migrator.MigrationError | SqlError | SqliteMigrationLineageError;

type FixtureMutation = (
  sql: SqlClient.SqlClient,
) => Effect.Effect<void, FixtureError, SqlClient.SqlClient>;

type DurableSnapshot = {
  readonly main: Uint8Array | undefined;
  readonly wal: Uint8Array | undefined;
  readonly shm: Uint8Array | undefined;
};

type ErrorTag = "SqliteCompatibilityError" | "SqliteInspectionError";

const latestMigrationId = migrationManifest.at(-1)?.[0] ?? 0;
const decodeDesktopBackendTerminalFailure = Schema.decodeUnknownSync(DesktopBackendTerminalFailure);
const isSqliteCompatibilityError = Schema.is(SqliteCompatibilityError);

const useNativeFile = (dbPath: string, mutation: FixtureMutation) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* mutation(sql);
  }).pipe(Effect.scoped, Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));

const createMigratedFixture = (
  dbPath: string,
  toMigrationInclusive: number,
  mutation: FixtureMutation = () => Effect.void,
) =>
  useNativeFile(dbPath, (sql) =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive });
      yield* mutation(sql);
    }),
  );

type OfficialV2Preview =
  | { readonly v2MigrationId: 53 }
  | {
      readonly v2MigrationId: 54;
      readonly includePullRequestFilesViewed: boolean;
      readonly includeIndexCleanup: boolean;
    };

const createOfficialV2PreviewFixture = (dbPath: string, preview: OfficialV2Preview) =>
  createMigratedFixture(dbPath, 52, (sql) =>
    Effect.gen(function* () {
      if (preview.v2MigrationId === 53) {
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({ "53_OrchestrationV2": OrchestrationV2Preview }),
        });
      } else {
        yield* Migrator.make({})({
          loader: Migrator.fromRecord({
            ...(preview.includePullRequestFilesViewed
              ? { "53_PullRequestFilesViewed": PullRequestFilesViewed }
              : {}),
            "54_OrchestrationV2": OrchestrationV2Preview,
            ...(preview.includeIndexCleanup
              ? { "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes }
              : {}),
          }),
        });
      }
      yield* sql`
        INSERT INTO orchestration_v2_legacy_imports
          (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count)
        VALUES ('preview-thread', '2026-09-15', '2026-09-15', '2026-09-16', 42)
      `;
    }),
  );

const createRawFixture = (dbPath: string, mutation: FixtureMutation) =>
  useNativeFile(dbPath, mutation);

const applyMigrationNameOverrides =
  (overrides: ReadonlyArray<readonly [number, string]>): FixtureMutation =>
  (sql) =>
    Effect.gen(function* () {
      for (const [migrationId, name] of overrides) {
        yield* sql`
        UPDATE effect_sql_migrations
        SET name = ${name}
        WHERE migration_id = ${migrationId}
      `;
      }
    });

const readOptionalFile = (fs: FileSystem.FileSystem, filePath: string) =>
  fs.readFile(filePath).pipe(
    Effect.map((bytes) => bytes.slice()),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.void.pipe(Effect.as(undefined as Uint8Array | undefined))
          : Effect.fail(cause),
    }),
  );

const readDurableSnapshot = (dbPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      main: yield* readOptionalFile(fs, dbPath),
      wal: yield* readOptionalFile(fs, `${dbPath}-wal`),
      shm: yield* readOptionalFile(fs, `${dbPath}-shm`),
    } satisfies DurableSnapshot;
  });

const bytesEqual = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean => {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
};

/**
 * SQLite may create an empty WAL for coordination. Durable main/WAL bytes are
 * required to remain equal; shared-memory bytes are recorded but intentionally
 * not compared because they are transient coordination state.
 */
const assertDurableSnapshotUnchanged = (
  label: string,
  before: DurableSnapshot,
  after: DurableSnapshot,
): void => {
  assert.ok(bytesEqual(before.main, after.main), `${label}: main database bytes changed`);

  if (bytesEqual(before.wal, after.wal)) return;

  const emptyWalCreated =
    before.wal === undefined && after.wal !== undefined && after.wal.length === 0;
  assert.ok(emptyWalCreated, `${label}: WAL bytes changed`);
};

const assertPreflightRefusalUnchanged = (
  label: string,
  before: DurableSnapshot,
  after: DurableSnapshot,
): void => {
  assert.ok(bytesEqual(before.main, after.main), `${label}: main database bytes changed`);
  assert.ok(bytesEqual(before.wal, after.wal), `${label}: WAL bytes changed`);
};

const inspectAttempt = (dbPath: string) =>
  inspectSqliteDatabase(dbPath).pipe(
    Effect.match({
      onFailure: (error) => ({ _tag: "Failure", error }) as const,
      onSuccess: (observation) => ({ _tag: "Success", observation }) as const,
    }),
  );

const assertAttempt = (dbPath: string) =>
  assertSqliteDatabaseCompatible(dbPath).pipe(
    Effect.match({
      onFailure: (error) => ({ _tag: "Failure", error }) as const,
      onSuccess: () => ({ _tag: "Success" }) as const,
    }),
  );

const errorTagOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : undefined;

const assertFullOpenAttempt = (dbPath: string) =>
  Effect.void.pipe(
    Effect.scoped,
    Effect.provide(layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.exit,
    Effect.map((exit) =>
      Exit.isFailure(exit)
        ? ({ _tag: "Failure", error: Cause.squash(exit.cause) } as const)
        : ({ _tag: "Success" } as const),
    ),
  );

const openAndReadMigrationState = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journal = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
    const webhookDeliveries = yield* sql`
      SELECT * FROM scheduled_task_webhook_deliveries
      WHERE delivery_id = ${nativeWebhookFixtureIds.deliveryId}
    `;
    const relayDeliveries = yield* sql`
      SELECT * FROM scheduled_task_webhook_relay_deliveries
      WHERE relay_delivery_id = ${nativeWebhookFixtureIds.relayDeliveryId}
    `;
    const mcpAppModelContexts = yield* sql`
      SELECT * FROM mcp_app_model_context
      WHERE thread_id = ${nativeMcpAppFixtureIds.threadId}
        AND item_id = ${nativeMcpAppFixtureIds.itemId}
    `;
    const pendingInteractions = yield* sql`
      SELECT * FROM pending_interactions
      WHERE thread_id = ${priorPort60FixtureIds.pendingThreadId}
        AND request_id = ${priorPort60FixtureIds.pendingRequestId}
    `;
    const pendingResponses = yield* sql`
      SELECT * FROM pending_interaction_responses
      WHERE auth_session_id = ${priorPort60FixtureIds.responseSessionId}
        AND idempotency_key = 'key:prior-port-60'
    `;
    return {
      journal,
      webhookDeliveries,
      relayDeliveries,
      mcpAppModelContexts,
      pendingInteractions,
      pendingResponses,
    };
  }).pipe(
    Effect.scoped,
    Effect.provide(layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
  );

const assertRejectedFixture = (input: {
  readonly dbPath: string;
  readonly inspection: "readable" | "malformed";
  readonly errorTag: ErrorTag;
}) =>
  Effect.gen(function* () {
    const beforeObservationSnapshot = yield* readDurableSnapshot(input.dbPath);
    const inspectionBefore = yield* inspectAttempt(input.dbPath);
    const afterObservationSnapshot = yield* readDurableSnapshot(input.dbPath);
    assertDurableSnapshotUnchanged(
      `${input.dbPath} after observation`,
      beforeObservationSnapshot,
      afterObservationSnapshot,
    );

    let observationBefore: SqliteInspectionObservation | undefined;
    if (input.inspection === "readable") {
      assert.equal(inspectionBefore._tag, "Success");
      if (inspectionBefore._tag !== "Success") return;
      observationBefore = inspectionBefore.observation;
    } else {
      assert.equal(inspectionBefore._tag, "Failure");
      if (inspectionBefore._tag !== "Failure") return;
      assert.equal(inspectionBefore.error._tag, input.errorTag);
    }

    const beforeAssertionSnapshot = yield* readDurableSnapshot(input.dbPath);
    const assertion = yield* assertAttempt(input.dbPath);
    assert.equal(assertion._tag, "Failure");
    if (assertion._tag !== "Failure") return;
    assert.equal(assertion.error._tag, input.errorTag);
    const afterAssertionSnapshot = yield* readDurableSnapshot(input.dbPath);
    assertDurableSnapshotUnchanged(
      `${input.dbPath} after assertion`,
      beforeAssertionSnapshot,
      afterAssertionSnapshot,
    );

    if (observationBefore !== undefined) {
      const inspectionAfter = yield* inspectAttempt(input.dbPath);
      assert.equal(inspectionAfter._tag, "Success");
      if (inspectionAfter._tag !== "Success") return;
      assert.deepStrictEqual(inspectionAfter.observation, observationBefore);
    }

    const beforeFullOpenSnapshot = yield* readDurableSnapshot(input.dbPath);
    const fullOpen = yield* assertFullOpenAttempt(input.dbPath);
    assert.equal(fullOpen._tag, "Failure");
    if (fullOpen._tag !== "Failure") return;
    const fullOpenErrorTag = errorTagOf(fullOpen.error);
    assert.ok(
      fullOpenErrorTag === "SqliteCompatibilityError" ||
        fullOpenErrorTag === "SqliteInspectionError",
      `unexpected full-open error: ${fullOpenErrorTag}`,
    );
    assert.equal(fullOpenErrorTag, input.errorTag);
    const afterFullOpenSnapshot = yield* readDurableSnapshot(input.dbPath);
    assertPreflightRefusalUnchanged(
      `${input.dbPath} after full open`,
      beforeFullOpenSnapshot,
      afterFullOpenSnapshot,
    );
  });

it.layer(NodeServices.layer)("SQLite compatibility guard", (it) => {
  it.effect("accepts missing, empty, native prefixes, and current native reopen", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-accept-" });

      const missingPath = path.join(root, "missing.sqlite");
      yield* assertSqliteDatabaseCompatible(missingPath);
      const missingExists = yield* fs.stat(missingPath).pipe(
        Effect.match({
          onFailure: (cause) => cause.reason._tag !== "NotFound",
          onSuccess: () => true,
        }),
      );
      assert.equal(missingExists, false);

      const zeroBytePath = path.join(root, "zero-byte.sqlite");
      yield* fs.writeFile(zeroBytePath, new Uint8Array());
      yield* assertSqliteDatabaseCompatible(zeroBytePath);
      assert.equal((yield* fs.readFile(zeroBytePath)).length, 0);

      const prefixes = [0, 1, 5, 32, 52, latestMigrationId];
      for (const prefix of prefixes) {
        const dbPath = path.join(root, `prefix-${prefix}.sqlite`);
        yield* createMigratedFixture(dbPath, prefix);

        const observation = yield* inspectSqliteDatabase(dbPath);
        assert.equal(observation._tag, "Existing");
        if (observation._tag !== "Existing") return;
        assert.equal(observation.migrationJournal._tag, "Present");
        if (observation.migrationJournal._tag !== "Present") return;
        assert.equal(observation.migrationJournal.rows.length, prefix);
        yield* assertSqliteDatabaseCompatible(dbPath);
      }

      const currentPath = path.join(root, "current-native.sqlite");
      yield* createMigratedFixture(currentPath, latestMigrationId);
      yield* Effect.void.pipe(
        Effect.scoped,
        Effect.provide(layerFromPath(currentPath).pipe(Layer.provide(NodeServices.layer))),
      );
    }),
  );

  it.effect("accepts exact official V2 previews before normalizing them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-sqlite-compat-preview-accept-",
      });
      const previews: ReadonlyArray<OfficialV2Preview> = [
        { v2MigrationId: 53 },
        { v2MigrationId: 54, includePullRequestFilesViewed: false, includeIndexCleanup: false },
        { v2MigrationId: 54, includePullRequestFilesViewed: true, includeIndexCleanup: false },
        { v2MigrationId: 54, includePullRequestFilesViewed: false, includeIndexCleanup: true },
        { v2MigrationId: 54, includePullRequestFilesViewed: true, includeIndexCleanup: true },
      ];

      for (const [index, preview] of previews.entries()) {
        const dbPath = path.join(root, `preview-${index}.sqlite`);
        yield* createOfficialV2PreviewFixture(dbPath, preview);

        const before = yield* inspectSqliteDatabase(dbPath);
        assert.equal(before._tag, "Existing");
        if (before._tag !== "Existing") return;
        assert.equal(before.migrationJournal._tag, "Present");
        if (before.migrationJournal._tag !== "Present") return;
        const expectedPreviewJournal =
          preview.v2MigrationId === 53
            ? [...migrationManifest.slice(0, 52), [53, "OrchestrationV2"] as const]
            : [
                ...migrationManifest.slice(0, 52),
                ...(preview.includePullRequestFilesViewed
                  ? ([[53, "PullRequestFilesViewed"]] as const)
                  : []),
                [54, "OrchestrationV2"] as const,
                ...(preview.includeIndexCleanup
                  ? ([[55, "RemoveRedundantProjectionIndexes"]] as const)
                  : []),
              ];
        assert.deepStrictEqual(
          before.migrationJournal.rows.map(({ migration_id, name }) => [migration_id, name]),
          expectedPreviewJournal.map(([migrationId, name]) => [migrationId, name]),
        );

        const durableBefore = yield* readDurableSnapshot(dbPath);
        yield* assertSqliteDatabaseCompatible(dbPath);
        const durableAfter = yield* readDurableSnapshot(dbPath);
        assertDurableSnapshotUnchanged(
          `${dbPath} after preview preflight`,
          durableBefore,
          durableAfter,
        );
        const afterPreflight = yield* inspectSqliteDatabase(dbPath);
        assert.deepStrictEqual(
          afterPreflight,
          before,
          "preflight changed the preview journal or schema",
        );

        const opened = yield* assertFullOpenAttempt(dbPath);
        assert.equal(opened._tag, "Success");
        if (opened._tag !== "Success") return;

        const normalized = yield* inspectSqliteDatabase(dbPath);
        assert.equal(normalized._tag, "Existing");
        if (normalized._tag !== "Existing") return;
        assert.equal(normalized.migrationJournal._tag, "Present");
        if (normalized.migrationJournal._tag !== "Present") return;
        assert.deepStrictEqual(
          normalized.migrationJournal.rows.map(
            ({ migration_id, name }) => [migration_id, name] as const,
          ),
          migrationManifest,
          `accepted preview at ${dbPath} did not normalize to the official manifest`,
        );

        const importState = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            readonly thread_id: string;
            readonly imported_message_count: number;
          }>`SELECT thread_id, imported_message_count FROM orchestration_v2_legacy_imports`;
        }).pipe(
          Effect.scoped,
          Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
        );
        assert.deepStrictEqual(importState, [
          { thread_id: "preview-thread", imported_message_count: 42 },
        ]);
      }
    }),
  );

  it.effect(
    "rejects official-looking previews with a bad prefix or suffix before normalization",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-sqlite-compat-preview-reject-",
        });

        const badPrefixPath = path.join(root, "bad-prefix.sqlite");
        yield* createOfficialV2PreviewFixture(badPrefixPath, { v2MigrationId: 53 });
        yield* createRawFixture(
          badPrefixPath,
          (sql) => sql`
        UPDATE effect_sql_migrations SET name = 'UnknownEarlierMigration' WHERE migration_id = 1
      `,
        );
        yield* assertRejectedFixture({
          dbPath: badPrefixPath,
          inspection: "readable",
          errorTag: "SqliteCompatibilityError",
        });

        const badSuffixPath = path.join(root, "bad-suffix.sqlite");
        yield* createOfficialV2PreviewFixture(badSuffixPath, { v2MigrationId: 53 });
        yield* createRawFixture(
          badSuffixPath,
          (sql) => sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (54, 'UnknownLaterMigration', '2026-09-16T00:00:00.000Z')
      `,
        );
        yield* assertRejectedFixture({
          dbPath: badSuffixPath,
          inspection: "readable",
          errorTag: "SqliteCompatibilityError",
        });
      }),
  );

  it.effect("upgrades official native prefixes 51, 52, and 53 through the guarded open", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-native-prefix-" });
      const now = "2026-01-01T00:00:00.000Z";
      const expectedThread = {
        threadId: "sentinel-thread",
        projectId: "project-1",
        title: "Sentinel thread",
        modelSelectionJson: '{"instanceId":"codex","model":"gpt-5.4"}',
        runtimeMode: "full-access",
        createdAt: now,
        updatedAt: now,
      };
      const expectedViewedFile = {
        provider: "github",
        host: "github.com",
        repository: "owner/repository",
        number: 42,
        viewer: "viewer-1",
        path: "src/index.ts",
        revision: "revision-1",
        viewed_at: now,
      };
      const prefixes = [51, 52, 53] as const;

      const openAndRead = (dbPath: string) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const journal = yield* sql<{
            readonly migration_id: number;
            readonly name: string;
            readonly created_at: string;
          }>`
            SELECT migration_id, name, created_at
            FROM effect_sql_migrations
            ORDER BY migration_id
          `;
          const threads = yield* sql<{
            readonly threadId: string;
            readonly projectId: string;
            readonly title: string;
            readonly modelSelectionJson: string;
            readonly runtimeMode: string;
            readonly createdAt: string;
            readonly updatedAt: string;
          }>`
            SELECT
              thread_id AS "threadId",
              project_id AS "projectId",
              title,
              model_selection_json AS "modelSelectionJson",
              runtime_mode AS "runtimeMode",
              created_at AS "createdAt",
              updated_at AS "updatedAt"
            FROM projection_threads
            WHERE thread_id = 'sentinel-thread'
          `;
          const viewedFiles = yield* sql<{
            readonly provider: string;
            readonly host: string;
            readonly repository: string;
            readonly number: number;
            readonly viewer: string;
            readonly path: string;
            readonly revision: string | null;
            readonly viewed_at: string;
          }>`
            SELECT provider, host, repository, number, viewer, path, revision, viewed_at
            FROM pull_request_files_viewed
            ORDER BY provider, host, repository, number, viewer, path
          `;
          const events = yield* sql<{
            readonly eventId: string;
            readonly threadId: string;
          }>`
            SELECT event_id AS "eventId", thread_id AS "threadId"
            FROM orchestration_v2_events
            ORDER BY sequence
          `;
          const v2Threads = yield* sql<{
            readonly threadId: string;
            readonly projectId: string;
          }>`
            SELECT thread_id AS "threadId", project_id AS "projectId"
            FROM orchestration_v2_projection_threads
            ORDER BY thread_id
          `;
          return { journal, threads, viewedFiles, events, v2Threads };
        }).pipe(
          Effect.scoped,
          Effect.provide(layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
        );

      for (const prefix of prefixes) {
        const dbPath = path.join(root, `prefix-${prefix}.sqlite`);
        yield* createMigratedFixture(dbPath, prefix, (sql) =>
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO projection_threads (
                thread_id, project_id, title, model_selection_json, runtime_mode,
                created_at, updated_at
              ) VALUES (
                'sentinel-thread', 'project-1', 'Sentinel thread',
                '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', ${now}, ${now}
              )
            `;
            if (prefix === 53) {
              yield* sql`
                INSERT INTO pull_request_files_viewed (
                  provider, host, repository, number, viewer, path, revision, viewed_at
                ) VALUES (
                  'github', 'github.com', 'owner/repository', 42,
                  'viewer-1', 'src/index.ts', 'revision-1', ${now}
                )
              `;
            }
          }),
        );

        const beforeOpen = yield* inspectSqliteDatabase(dbPath);
        assert.equal(beforeOpen._tag, "Existing");
        if (beforeOpen._tag !== "Existing") return;
        assert.equal(beforeOpen.migrationJournal._tag, "Present");
        if (beforeOpen.migrationJournal._tag !== "Present") return;
        assert.equal(beforeOpen.migrationJournal.rows.length, prefix);
        assert.deepStrictEqual(
          beforeOpen.migrationJournal.rows.map(({ migration_id, name }) => [migration_id, name]),
          migrationManifest.slice(0, prefix).map(([migrationId, name]) => [migrationId, name]),
        );

        const firstOpen = yield* openAndRead(dbPath);
        assert.deepStrictEqual(
          firstOpen.journal.map(({ migration_id, name }) => [migration_id, name]),
          migrationManifest.map(([migrationId, name]) => [migrationId, name]),
        );
        assert.deepStrictEqual(
          firstOpen.journal.slice(0, prefix),
          beforeOpen.migrationJournal.rows,
          "the applied native prefix, including timestamps, changed during the guarded open",
        );
        assert.deepStrictEqual(firstOpen.threads, [expectedThread]);
        assert.deepStrictEqual(firstOpen.viewedFiles, prefix === 53 ? [expectedViewedFile] : []);
        assert.deepStrictEqual(firstOpen.events, []);
        assert.deepStrictEqual(firstOpen.v2Threads, []);

        yield* assertSqliteDatabaseCompatible(dbPath);
        const secondOpen = yield* openAndRead(dbPath);
        assert.deepStrictEqual(secondOpen, firstOpen);
      }
    }),
  );

  it.effect("accepts the native site-local migration 41 journal alias", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-local-41-" });
      const dbPath = path.join(root, "site-local-41.sqlite");
      yield* createMigratedFixture(
        dbPath,
        41,
        applyMigrationNameOverrides([[41, "ThreadSummaryTimeline"]]),
      );

      const before = yield* readDurableSnapshot(dbPath);
      const attempt = yield* assertAttempt(dbPath);
      assert.deepStrictEqual(attempt, { _tag: "Success" });
      const after = yield* readDurableSnapshot(dbPath);
      assertDurableSnapshotUnchanged(`${dbPath} after compatible preflight`, before, after);
    }),
  );

  it.effect("accepts the source-backed shipped fork 51-entry journal", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-fork-accept-" });
      const dbPath = path.join(root, "fork-v1.sqlite");
      yield* createRawFixture(dbPath, () => createDeployedForkV1Schema());

      const before = yield* readDurableSnapshot(dbPath);
      const attempt = yield* assertAttempt(dbPath);
      assert.deepStrictEqual(attempt, { _tag: "Success" });
      const after = yield* readDurableSnapshot(dbPath);
      assertDurableSnapshotUnchanged(`${dbPath} after compatible preflight`, before, after);
      const observation = yield* inspectSqliteDatabase(dbPath);
      assert.equal(observation._tag, "Existing");
      if (observation._tag !== "Existing") return;
      assert.equal(observation.migrationJournal._tag, "Present");
      if (observation.migrationJournal._tag !== "Present") return;
      assert.equal(observation.migrationJournal.rows.length, 51);
      assert.deepStrictEqual(
        observation.migrationJournal.rows
          .slice(33)
          .map(({ migration_id, name }) => [migration_id, name]),
        [
          [34, "PendingInteractions"],
          [35, "QueuedProviderTurnStarts"],
          [36, "ProjectionThreadsSnoozed"],
          [37, "ProjectionThreadTitleRegeneration"],
          [38, "ProjectionThreadsPinned"],
          [39, "ProjectionTurnsKeysetIndex"],
          [40, "ProjectionThreadsPinOrderKey"],
          [41, "ProjectionProjectsDefaultThreadEnvMode"],
          [42, "ProjectionProjectFaviconPath"],
          [43, "AuthSessionClientConnection"],
          [44, "ProjectionThreadLinkedPullRequest"],
          [45, "ProjectionThreadsUnsettledAt"],
          [46, "ProjectionThreadsHiddenAt"],
          [47, "ClearAutomaticProjectModelDefaults"],
          [48, "ProjectionProjectsAutoPull"],
          [49, "RepairAutomaticSettlementTimestamps"],
          [50, "ProjectionProjectIcon"],
          [51, "ProjectionThreadBranchPullRequest"],
        ],
      );
    }),
  );

  it.effect("accepts native U57 through U59 webhook prefixes read-only", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-sqlite-compat-webhook-accept-",
      });

      const fixtures = [
        { name: "u57", includeRelayMigration: false, includeMcpAppContextMigration: false },
        { name: "u57-u58", includeRelayMigration: true, includeMcpAppContextMigration: false },
        { name: "u57-u58-u59", includeRelayMigration: true, includeMcpAppContextMigration: true },
      ] as const;
      for (const fixture of fixtures) {
        const dbPath = path.join(root, `${fixture.name}.sqlite`);
        yield* createRawFixture(dbPath, () =>
          createNativeWebhookJournal({
            includeRelayMigration: fixture.includeRelayMigration,
            includeMcpAppContextMigration: fixture.includeMcpAppContextMigration,
          }),
        );

        const before = yield* inspectSqliteDatabase(dbPath);
        assert.equal(before._tag, "Existing");
        if (before._tag !== "Existing") return;
        assert.equal(before.migrationJournal._tag, "Present");
        if (before.migrationJournal._tag !== "Present") return;
        assert.equal(
          before.migrationJournal.rows.length,
          fixture.includeMcpAppContextMigration ? 59 : fixture.includeRelayMigration ? 58 : 57,
        );

        const durableBefore = yield* readDurableSnapshot(dbPath);
        yield* assertSqliteDatabaseCompatible(dbPath);
        assertDurableSnapshotUnchanged(
          `${dbPath} after native collision preflight`,
          durableBefore,
          yield* readDurableSnapshot(dbPath),
        );
      }
    }),
  );

  it.effect("accepts the tested prior port 60 journal read-only", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-port60-" });
      const dbPath = path.join(root, "prior-port-60.sqlite");
      yield* createRawFixture(dbPath, () => createPriorPort60Journal());

      const before = yield* inspectSqliteDatabase(dbPath);
      assert.equal(before._tag, "Existing");
      if (before._tag !== "Existing") return;
      assert.equal(before.migrationJournal._tag, "Present");
      if (before.migrationJournal._tag !== "Present") return;
      assert.equal(before.migrationJournal.rows.length, 60);
      const durableBefore = yield* readDurableSnapshot(dbPath);
      yield* assertSqliteDatabaseCompatible(dbPath);
      assertDurableSnapshotUnchanged(
        `${dbPath} after prior port preflight`,
        durableBefore,
        yield* readDurableSnapshot(dbPath),
      );
    }),
  );

  it.effect("opens the accepted webhook and prior-port lineages through the production layer", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-sqlite-compat-open-lineages-",
      });
      const fixtures = [
        {
          name: "u57",
          expectedPrefixLength: 57,
          create: (dbPath: string) =>
            createRawFixture(dbPath, () =>
              createNativeWebhookJournal({ includeRelayMigration: false }),
            ),
          expectedRelayCount: 0,
          expectedPriorPortRows: 0,
          expectedMcpAppContextRows: 0,
        },
        {
          name: "u57-u58",
          expectedPrefixLength: 58,
          create: (dbPath: string) =>
            createRawFixture(dbPath, () =>
              createNativeWebhookJournal({ includeRelayMigration: true }),
            ),
          expectedRelayCount: 1,
          expectedPriorPortRows: 0,
          expectedMcpAppContextRows: 0,
        },
        {
          name: "u57-u58-u59",
          expectedPrefixLength: 59,
          create: (dbPath: string) =>
            createRawFixture(dbPath, () =>
              createNativeWebhookJournal({
                includeRelayMigration: true,
                includeMcpAppContextMigration: true,
              }),
            ),
          expectedRelayCount: 1,
          expectedPriorPortRows: 0,
          expectedMcpAppContextRows: 1,
        },
        {
          name: "port60",
          expectedPrefixLength: 60,
          create: (dbPath: string) => createRawFixture(dbPath, () => createPriorPort60Journal()),
          expectedRelayCount: 0,
          expectedPriorPortRows: 1,
          expectedMcpAppContextRows: 0,
        },
      ] as const;

      for (const fixture of fixtures) {
        const dbPath = path.join(root, `${fixture.name}.sqlite`);
        yield* fixture.create(dbPath);
        const before = yield* inspectSqliteDatabase(dbPath);
        assert.equal(before._tag, "Existing");
        if (before._tag !== "Existing") return;
        assert.equal(before.migrationJournal._tag, "Present");
        if (before.migrationJournal._tag !== "Present") return;
        assert.equal(before.migrationJournal.rows.length, fixture.expectedPrefixLength);

        const opened = yield* openAndReadMigrationState(dbPath);
        assert.deepStrictEqual(
          opened.journal.slice(0, fixture.expectedPrefixLength),
          before.migrationJournal.rows,
          `${fixture.name}: the accepted source journal was rewritten`,
        );
        assert.deepStrictEqual(
          opened.journal.map(({ migration_id, name }) => [migration_id, name]),
          [
            ...before.migrationJournal.rows.map(({ migration_id, name }) => [migration_id, name]),
            ...migrationManifest.filter(
              ([migrationId]) => migrationId > fixture.expectedPrefixLength,
            ),
          ],
          `${fixture.name}: startup did not record the canonical port suffix`,
        );
        assert.equal(opened.webhookDeliveries.length, fixture.name === "port60" ? 0 : 1);
        assert.equal(opened.relayDeliveries.length, fixture.expectedRelayCount);
        assert.equal(opened.mcpAppModelContexts.length, fixture.expectedMcpAppContextRows);
        if (fixture.name === "u57-u58-u59") {
          assert.deepStrictEqual(opened.mcpAppModelContexts, [
            {
              thread_id: nativeMcpAppFixtureIds.threadId,
              item_id: nativeMcpAppFixtureIds.itemId,
              server: "fixture-server",
              tool: "fixture-tool",
              text: "Native MCP context fixture",
              updated_at: "2026-10-07T00:00:00.000Z",
            },
          ]);
        }
        assert.equal(opened.pendingInteractions.length, fixture.expectedPriorPortRows);
        assert.equal(opened.pendingResponses.length, fixture.expectedPriorPortRows);

        const reopened = yield* openAndReadMigrationState(dbPath);
        assert.deepStrictEqual(reopened, opened, `${fixture.name}: startup was not idempotent`);
      }
    }),
  );

  it.effect("reopens native webhook history with the accepted site-local migration 41 alias", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-sqlite-compat-native-local-41-",
      });
      const dbPath = path.join(root, "native-local-41.sqlite");
      yield* createRawFixture(dbPath, (sql) =>
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 56 });
          yield* applyMigrationNameOverrides([[41, "ThreadSummaryTimeline"]])(sql);
          yield* createNativeWebhookJournal({ includeRelayMigration: true });
          yield* runMigrations();
        }),
      );

      const before = yield* inspectSqliteDatabase(dbPath);
      assert.equal(before._tag, "Existing");
      if (before._tag !== "Existing") return;
      assert.equal(before.migrationJournal._tag, "Present");
      if (before.migrationJournal._tag !== "Present") return;
      assert.equal(before.migrationJournal.rows[40]?.name, "ThreadSummaryTimeline");
      assert.deepStrictEqual(
        before.migrationJournal.rows
          .slice(56)
          .map(({ migration_id, name }) => [migration_id, name]),
        [
          [57, "ScheduledTaskWebhooks"],
          [58, "WebhookRelayDeliveries"],
          ...migrationManifest
            .filter(([migrationId]) => migrationId > 58)
            .map(([migrationId, name]) => [migrationId, name]),
        ],
      );

      const opened = yield* openAndReadMigrationState(dbPath);
      assert.deepStrictEqual(
        opened.journal.slice(0, 58),
        before.migrationJournal.rows.slice(0, 58),
        "the source native webhook prefix or site-local migration name changed",
      );
      assert.equal(opened.webhookDeliveries.length, 1);
      assert.equal(opened.relayDeliveries.length, 1);
      assert.equal(opened.pendingInteractions.length, 0);
      assert.equal(opened.pendingResponses.length, 0);
      assert.deepStrictEqual(
        yield* openAndReadMigrationState(dbPath),
        opened,
        "the native-plus-port lineage was not idempotent on production reopen",
      );
    }),
  );

  it.effect("rolls back a failed production open and succeeds on retry", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-sqlite-compat-open-retry-",
      });
      const dbPath = path.join(root, "u57-u58-u59-blocked.sqlite");
      yield* createRawFixture(dbPath, () =>
        createNativeWebhookJournal({
          includeRelayMigration: true,
          includeMcpAppContextMigration: true,
        }),
      );
      yield* createRawFixture(
        dbPath,
        (sql) => sql`CREATE TABLE orchestration_http_create_operations (blocker TEXT)`,
      );

      const beforeFailure = yield* inspectSqliteDatabase(dbPath);
      assert.equal(beforeFailure._tag, "Existing");
      if (beforeFailure._tag !== "Existing") return;
      assert.equal(beforeFailure.migrationJournal._tag, "Present");
      if (beforeFailure.migrationJournal._tag !== "Present") return;
      const beforeJournal = beforeFailure.migrationJournal.rows;
      const failedOpen = yield* assertFullOpenAttempt(dbPath);
      assert.equal(failedOpen._tag, "Failure");

      const afterFailure = yield* inspectSqliteDatabase(dbPath);
      assert.equal(afterFailure._tag, "Existing");
      if (afterFailure._tag !== "Existing") return;
      assert.equal(afterFailure.migrationJournal._tag, "Present");
      if (afterFailure.migrationJournal._tag !== "Present") return;
      assert.deepStrictEqual(
        afterFailure.schema,
        beforeFailure.schema,
        "a failed startup committed migration schema changes",
      );
      assert.deepStrictEqual(
        afterFailure.migrationJournal.rows,
        beforeJournal,
        "a failed startup committed migration-journal changes",
      );

      yield* createRawFixture(
        dbPath,
        (sql) => sql`DROP TABLE orchestration_http_create_operations`,
      );
      const reopened = yield* openAndReadMigrationState(dbPath);
      assert.deepStrictEqual(
        reopened.journal.map(({ migration_id, name }) => [migration_id, name]),
        [
          ...beforeJournal.map(({ migration_id, name }) => [migration_id, name]),
          ...migrationManifest.filter(([migrationId]) => migrationId > beforeJournal.length),
        ],
      );
      assert.equal(reopened.webhookDeliveries.length, 1);
      assert.equal(reopened.relayDeliveries.length, 1);
      assert.deepStrictEqual(reopened.mcpAppModelContexts, [
        {
          thread_id: nativeMcpAppFixtureIds.threadId,
          item_id: nativeMcpAppFixtureIds.itemId,
          server: "fixture-server",
          tool: "fixture-tool",
          text: "Native MCP context fixture",
          updated_at: "2026-10-07T00:00:00.000Z",
        },
      ]);
      assert.deepStrictEqual(
        reopened.journal.slice(58).map(({ migration_id, name }) => [migration_id, name]),
        [
          [59, "McpAppModelContext"],
          ...migrationManifest
            .filter(([migrationId]) => migrationId > 59)
            .map(([migrationId, name]) => [migrationId, name]),
        ],
      );
      assert.deepStrictEqual(yield* assertFullOpenAttempt(dbPath), { _tag: "Success" });
    }),
  );

  it.effect("refuses malformed native webhook schema and mixed webhook journals read-only", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-sqlite-compat-webhook-reject-",
      });

      const malformedPath = path.join(root, "malformed-u57-u58.sqlite");
      yield* createRawFixture(malformedPath, () =>
        createNativeWebhookJournal({ includeRelayMigration: true }),
      );
      yield* createRawFixture(
        malformedPath,
        (sql) => sql`DROP INDEX idx_scheduled_task_webhook_relay_deliveries_seen`,
      );
      yield* assertRejectedFixture({
        dbPath: malformedPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const malformedMcpPath = path.join(root, "malformed-native-u59-mcp-context.sqlite");
      yield* createRawFixture(malformedMcpPath, () =>
        createNativeWebhookJournal({
          includeRelayMigration: true,
          includeMcpAppContextMigration: true,
        }),
      );
      yield* createRawFixture(malformedMcpPath, (sql) => sql`DROP TABLE mcp_app_model_context`);
      yield* assertRejectedFixture({
        dbPath: malformedMcpPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const mixedMcpPath = path.join(root, "mixed-native-u59-port-59.sqlite");
      yield* createRawFixture(mixedMcpPath, () =>
        createNativeWebhookJournal({
          includeRelayMigration: true,
          includeMcpAppContextMigration: true,
        }),
      );
      yield* createRawFixture(
        mixedMcpPath,
        (sql) =>
          sql`UPDATE effect_sql_migrations SET name = 'ServiceUpdateQueuedRuns' WHERE migration_id = 59`,
      );
      yield* assertRejectedFixture({
        dbPath: mixedMcpPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const mixedPath = path.join(root, "mixed-u57-port.sqlite");
      yield* createRawFixture(mixedPath, () =>
        createNativeWebhookJournal({ includeRelayMigration: true }),
      );
      yield* createRawFixture(
        mixedPath,
        (sql) =>
          sql`UPDATE effect_sql_migrations SET name = 'PendingInteractionResponses' WHERE migration_id = 57`,
      );
      yield* assertRejectedFixture({
        dbPath: mixedPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });
    }),
  );

  it.effect("rejects legacy and malformed journals without durable changes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-journal-" });

      const forkPath = path.join(root, "fork-invalid-name.sqlite");
      yield* createRawFixture(forkPath, () => createDeployedForkV1Schema());
      yield* createRawFixture(
        forkPath,
        (sql) =>
          sql`UPDATE effect_sql_migrations SET name = 'UnknownForkMigration' WHERE migration_id = 51`,
      );
      yield* assertRejectedFixture({
        dbPath: forkPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const unknownSiteLocal41Path = path.join(root, "unknown-site-local-41.sqlite");
      yield* createMigratedFixture(
        unknownSiteLocal41Path,
        latestMigrationId,
        applyMigrationNameOverrides([[41, "UnknownSiteLocalMigration"]]),
      );
      yield* assertRejectedFixture({
        dbPath: unknownSiteLocal41Path,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const mixedPath = path.join(root, "mixed-fork-name.sqlite");
      yield* createMigratedFixture(
        mixedPath,
        latestMigrationId,
        applyMigrationNameOverrides([[34, "PendingInteractions"]]),
      );
      yield* assertRejectedFixture({
        dbPath: mixedPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const higherPath = path.join(root, "unknown-higher.sqlite");
      yield* createMigratedFixture(higherPath, latestMigrationId, (sql) => {
        const higherId = latestMigrationId + 1;
        return sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (${higherId}, 'UnknownFutureMigration', '2026-09-12T00:00:00.000Z')
        `;
      });
      yield* assertRejectedFixture({
        dbPath: higherPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const gapEntry = migrationManifest[4];
      assert.ok(gapEntry !== undefined);
      if (gapEntry === undefined) return;
      const gapPath = path.join(root, "missing-earlier-row.sqlite");
      yield* createMigratedFixture(gapPath, latestMigrationId, (sql) => {
        const gapId = gapEntry[0];
        return sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${gapId}`;
      });
      yield* assertRejectedFixture({
        dbPath: gapPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const wrongColumnsPath = path.join(root, "wrong-journal-columns.sqlite");
      yield* createRawFixture(
        wrongColumnsPath,
        (sql) =>
          sql`
          CREATE TABLE effect_sql_migrations (
            migration_id INTEGER NOT NULL,
            name TEXT NOT NULL
          )
        `,
      );
      yield* assertRejectedFixture({
        dbPath: wrongColumnsPath,
        inspection: "malformed",
        errorTag: "SqliteInspectionError",
      });

      const duplicatePath = path.join(root, "duplicate-journal-ids.sqlite");
      yield* createRawFixture(duplicatePath, (sql) =>
        Effect.gen(function* () {
          yield* sql`
            CREATE TABLE effect_sql_migrations (
              migration_id INTEGER NOT NULL,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
          `;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES
              (1, 'OrchestrationEvents', '2026-09-12T00:00:00.000Z'),
              (1, 'OrchestrationEvents', '2026-09-12T00:00:01.000Z')
          `;
        }),
      );
      yield* assertRejectedFixture({
        dbPath: duplicatePath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const textIdPath = path.join(root, "text-journal-id.sqlite");
      yield* createRawFixture(textIdPath, (sql) =>
        Effect.gen(function* () {
          yield* sql`
            CREATE TABLE effect_sql_migrations (
              migration_id TEXT NOT NULL,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
          `;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES ('1', 'OrchestrationEvents', '2026-09-12T00:00:00.000Z')
          `;
        }),
      );
      yield* assertRejectedFixture({
        dbPath: textIdPath,
        inspection: "malformed",
        errorTag: "SqliteInspectionError",
      });

      const fractionIdPath = path.join(root, "fraction-journal-id.sqlite");
      yield* createRawFixture(fractionIdPath, (sql) =>
        Effect.gen(function* () {
          yield* sql`
            CREATE TABLE effect_sql_migrations (
              migration_id REAL NOT NULL,
              name TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
          `;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES (1.5, 'OrchestrationEvents', '2026-09-12T00:00:00.000Z')
          `;
        }),
      );
      yield* assertRejectedFixture({
        dbPath: fractionIdPath,
        inspection: "malformed",
        errorTag: "SqliteInspectionError",
      });

      const emptyTimestampPath = path.join(root, "empty-timestamp.sqlite");
      yield* createMigratedFixture(emptyTimestampPath, latestMigrationId, (sql) => {
        const firstId = migrationManifest[0]?.[0];
        assert.ok(firstId !== undefined);
        if (firstId === undefined) return Effect.void;
        return sql`
          UPDATE effect_sql_migrations
          SET created_at = ''
          WHERE migration_id = ${firstId}
        `;
      });
      yield* assertRejectedFixture({
        dbPath: emptyTimestampPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });
    }),
  );

  it.effect("preserves compatible native databases with additional user tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-native-user-tables-" });
      for (const preview of [false, true]) {
        const dbPath = path.join(root, preview ? "preview.sqlite" : "native.sqlite");
        if (preview) {
          yield* createOfficialV2PreviewFixture(dbPath, { v2MigrationId: 53 });
        } else {
          yield* createMigratedFixture(dbPath, latestMigrationId);
        }
        yield* createRawFixture(dbPath, (sql) => sql`CREATE TABLE user_notes (note TEXT NOT NULL)`);
        const before = yield* readDurableSnapshot(dbPath);
        yield* assertSqliteDatabaseCompatible(dbPath);
        assertDurableSnapshotUnchanged(dbPath, before, yield* readDurableSnapshot(dbPath));
      }
    }),
  );

  it.effect("rejects unjournaled and corrupt databases without durable changes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-schema-" });

      const unjournaledPath = path.join(root, "nonempty-without-journal.sqlite");
      yield* createRawFixture(
        unjournaledPath,
        (sql) => sql`CREATE TABLE noninternal_schema (id INTEGER PRIMARY KEY)`,
      );
      yield* assertRejectedFixture({
        dbPath: unjournaledPath,
        inspection: "readable",
        errorTag: "SqliteCompatibilityError",
      });

      const corruptPath = path.join(root, "corrupt.sqlite");
      yield* fs.writeFile(
        corruptPath,
        new Uint8Array([0x6e, 0x6f, 0x74, 0x2d, 0x73, 0x71, 0x6c, 0x69, 0x74, 0x65]),
      );
      yield* assertRejectedFixture({
        dbPath: corruptPath,
        inspection: "malformed",
        errorTag: "SqliteInspectionError",
      });
    }),
  );

  it.effect("preserves the database incompatibility exit code through the layer and CLI", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sqlite-compat-exit-" });
      const dbPath = path.join(root, "fork.sqlite");

      yield* createRawFixture(dbPath, () => createDeployedForkV1Schema());
      yield* createRawFixture(
        dbPath,
        (sql) =>
          sql`UPDATE effect_sql_migrations SET name = 'UnknownForkMigration' WHERE migration_id = 51`,
      );

      const terminalFailure = {
        _tag: "DatabaseIncompatible",
      } satisfies DesktopBackendTerminalFailure;
      assert.deepStrictEqual(decodeDesktopBackendTerminalFailure(terminalFailure), terminalFailure);

      const before = yield* readDurableSnapshot(dbPath);
      const databaseGuardCommand = Command.make("database-guard", {}, () =>
        Effect.void.pipe(
          Effect.scoped,
          Effect.provide(layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
        ),
      );
      const cliExit = yield* Effect.exit(
        Command.runWith(databaseGuardCommand, { version: "test", renderErrors: false })([]).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );

      assert.equal(cliExit._tag, "Failure");
      if (cliExit._tag !== "Failure") return;
      const failure = Cause.squash(cliExit.cause);
      assert.equal(isSqliteCompatibilityError(failure), true);
      if (!isSqliteCompatibilityError(failure)) return;
      assert.equal(failure[Runtime.errorExitCode], DATABASE_INCOMPATIBLE_EXIT_CODE);

      const exitCodes: Array<number> = [];
      Runtime.defaultTeardown(cliExit, (code) => exitCodes.push(code));
      assert.deepStrictEqual(exitCodes, [DATABASE_INCOMPATIBLE_EXIT_CODE]);

      const after = yield* readDurableSnapshot(dbPath);
      assertDurableSnapshotUnchanged(`${dbPath} after CLI-wrapped layer`, before, after);

      const ordinaryErrorExitCodes: Array<number> = [];
      Runtime.defaultTeardown(
        Exit.fail(
          new SqliteInspectionError({
            dbPath: "ordinary.sqlite",
            reason: "ordinary failure",
            cause: "test",
          }),
        ),
        (code) => ordinaryErrorExitCodes.push(code),
      );
      assert.deepStrictEqual(ordinaryErrorExitCodes, [1]);

      const interruptionExitCodes: Array<number> = [];
      Runtime.defaultTeardown(Exit.interrupt(123), (code) => interruptionExitCodes.push(code));
      assert.deepStrictEqual(interruptionExitCodes, [130]);
    }),
  );
});
