import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const forkMigrationNames = [
  "OrchestrationEvents",
  "OrchestrationCommandReceipts",
  "CheckpointDiffBlobs",
  "ProviderSessionRuntime",
  "Projections",
  "ProjectionThreadSessionRuntimeModeColumns",
  "ProjectionThreadMessageAttachments",
  "ProjectionThreadActivitySequence",
  "ProviderSessionRuntimeMode",
  "ProjectionThreadsRuntimeMode",
  "OrchestrationThreadCreatedRuntimeMode",
  "ProjectionThreadsInteractionMode",
  "ProjectionThreadProposedPlans",
  "ProjectionThreadProposedPlanImplementation",
  "ProjectionTurnsSourceProposedPlan",
  "CanonicalizeModelSelections",
  "ProjectionThreadsArchivedAt",
  "ProjectionThreadsArchivedAtIndex",
  "ProjectionSnapshotLookupIndexes",
  "AuthAccessManagement",
  "AuthSessionClientMetadata",
  "AuthSessionLastConnectedAt",
  "ProjectionThreadShellSummary",
  "BackfillProjectionThreadShellSummary",
  "CleanupInvalidProjectionPendingApprovals",
  "CanonicalizeModelSelectionOptions",
  "ProviderSessionRuntimeInstanceId",
  "ProjectionThreadSessionInstanceId",
  "ProjectionThreadDetailOrderingIndexes",
  "ProjectionThreadShellArchiveIndexes",
  "AuthAuthorizationScopes",
  "AuthPairingProofKeyThumbprint",
  "ProjectionThreadsSettled",
  "PendingInteractions",
  "QueuedProviderTurnStarts",
  "ProjectionThreadsSnoozed",
  "ProjectionThreadTitleRegeneration",
  "ProjectionThreadsPinned",
  "ProjectionTurnsKeysetIndex",
  "ProjectionThreadsPinOrderKey",
  "ProjectionProjectsDefaultThreadEnvMode",
  "ProjectionProjectFaviconPath",
  "AuthSessionClientConnection",
  "ProjectionThreadLinkedPullRequest",
  "ProjectionThreadsUnsettledAt",
  "ProjectionThreadsHiddenAt",
] as const;

const upstreamMigrationNames = [
  "ClearAutomaticProjectModelDefaults",
  "ProjectionProjectsAutoPull",
  "RepairAutomaticSettlementTimestamps",
  "ProjectionProjectIcon",
  "ProjectionThreadBranchPullRequest",
] as const;

const expectedMigrationHistory = [...forkMigrationNames, ...upstreamMigrationNames].map(
  (name, index) => ({ migrationId: index + 1, name }),
);

layer("MigrationUpgrade", (it) => {
  it.effect("preserves fork history and durable rows while applying upstream migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 46 });

      const forkHistory = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(forkHistory, expectedMigrationHistory.slice(0, 46));

      yield* sql`
        INSERT INTO pending_interactions (
          thread_id,
          request_id,
          kind,
          status,
          summary,
          can_approve,
          questions_json,
          response_action,
          response_command_id,
          created_at,
          updated_at,
          resolved_at
        )
        VALUES (
          'thread-durable',
          'request-durable',
          'user-input',
          'pending',
          'Keep this request pending',
          0,
          '[]',
          NULL,
          NULL,
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO pending_interaction_responses (
          auth_session_id,
          idempotency_key,
          thread_id,
          request_id,
          action,
          semantic_hash,
          command_id,
          command_created_at,
          dispatched_at
        )
        VALUES (
          'session-durable',
          'idempotency-durable',
          'thread-durable',
          'request-durable',
          'answer',
          'semantic-durable',
          'command-durable',
          '2026-09-01T00:01:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO queued_provider_turn_starts (event_sequence, thread_id, message_id)
        VALUES (123, 'thread-durable', 'message-durable')
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          created_at,
          updated_at,
          deleted_at,
          hidden_at
        )
        VALUES (
          'thread-durable',
          'project-durable',
          'Hidden durable thread',
          NULL,
          '2026-09-01T00:00:00.000Z',
          '2026-09-01T00:00:00.000Z',
          NULL,
          '2026-09-01T00:02:00.000Z'
        )
      `;

      yield* runMigrations();

      const upgradedHistory = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(upgradedHistory, expectedMigrationHistory);
      assert.deepStrictEqual(upgradedHistory.slice(0, 46), forkHistory);

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(projectColumns.some((column) => column.name === "auto_pull"));
      assert.ok(projectColumns.some((column) => column.name === "project_icon_json"));

      const pendingRows = yield* sql<{
        readonly threadId: string;
        readonly requestId: string;
        readonly status: string;
      }>`
        SELECT
          thread_id AS "threadId",
          request_id AS "requestId",
          status
        FROM pending_interactions
      `;
      assert.deepStrictEqual(pendingRows, [
        { threadId: "thread-durable", requestId: "request-durable", status: "pending" },
      ]);

      const responseRows = yield* sql<{
        readonly threadId: string;
        readonly requestId: string;
        readonly commandId: string;
      }>`
        SELECT
          thread_id AS "threadId",
          request_id AS "requestId",
          command_id AS "commandId"
        FROM pending_interaction_responses
      `;
      assert.deepStrictEqual(responseRows, [
        {
          threadId: "thread-durable",
          requestId: "request-durable",
          commandId: "command-durable",
        },
      ]);

      const queuedRows = yield* sql<{
        readonly eventSequence: number;
        readonly threadId: string;
        readonly messageId: string;
      }>`
        SELECT
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          message_id AS "messageId"
        FROM queued_provider_turn_starts
      `;
      assert.deepStrictEqual(queuedRows, [
        { eventSequence: 123, threadId: "thread-durable", messageId: "message-durable" },
      ]);

      const hiddenRows = yield* sql<{
        readonly threadId: string;
        readonly hiddenAt: string | null;
      }>`
        SELECT thread_id AS "threadId", hidden_at AS "hiddenAt"
        FROM projection_threads
        WHERE thread_id = 'thread-durable'
      `;
      assert.deepStrictEqual(hiddenRows, [
        { threadId: "thread-durable", hiddenAt: "2026-09-01T00:02:00.000Z" },
      ]);

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(threadColumns.some((column) => column.name === "hidden_at"));
      assert.ok(threadColumns.some((column) => column.name === "branch_pull_request_json"));
    }),
  );

  it.effect("creates the fork and upstream schema on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();

      const migrations = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, expectedMigrationHistory);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'pending_interactions',
            'pending_interaction_responses',
            'queued_provider_turn_starts'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(tables, [
        { name: "pending_interaction_responses" },
        { name: "pending_interactions" },
        { name: "queued_provider_turn_starts" },
      ]);

      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(threadColumns.some((column) => column.name === "hidden_at"));
      assert.ok(threadColumns.some((column) => column.name === "branch_pull_request_json"));

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.ok(projectColumns.some((column) => column.name === "auto_pull"));
      assert.ok(projectColumns.some((column) => column.name === "project_icon_json"));
    }),
  );
});
