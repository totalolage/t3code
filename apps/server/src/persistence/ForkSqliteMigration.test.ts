import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import {
  createNativeWebhookJournal,
  createPriorPort60Journal,
  createDeployedForkV1Schema,
  deployedForkV1FixtureIds,
  nativeWebhookFixtureIds,
  nativeMcpAppFixtureIds,
  priorPort60FixtureIds,
  seedDeployedForkV1CutoverRows,
} from "./testkit/DeployedForkV1Fixture.ts";
import { markQueuedRunsForUpdate } from "../orchestration-v2/ServiceUpdateQueuedRuns.ts";

const seedPendingRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-10-05T00:00:00.000Z";
  yield* sql`
    INSERT INTO pending_interactions (
      thread_id, request_id, kind, status, summary, can_approve, questions_json,
      response_action, response_command_id, created_at, updated_at, resolved_at
    ) VALUES (
      ${deployedForkV1FixtureIds.threadId}, 'request:fork-v1', 'approval', 'responding',
      'Fork pending approval', 1, '[]', 'approve', 'command:fork-v1', ${now}, ${now}, NULL
    )
  `;
  yield* sql`
    INSERT INTO pending_interaction_responses (
      auth_session_id, idempotency_key, thread_id, request_id, action,
      semantic_hash, command_id, command_created_at, dispatched_at
    ) VALUES (
      ${deployedForkV1FixtureIds.authSessionId}, 'key:fork-v1',
      ${deployedForkV1FixtureIds.threadId}, 'request:fork-v1', 'approve',
      'semantic-hash', 'command:fork-v1', ${now}, NULL
    )
  `;
  yield* sql`
    INSERT INTO queued_provider_turn_starts (event_sequence, thread_id, message_id)
    VALUES (8101, ${deployedForkV1FixtureIds.threadId}, ${deployedForkV1FixtureIds.messageIds[0]})
  `;
});

it.effect("bridges F51 through native 63 and preserves fork rows and journal history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createDeployedForkV1Schema();

    const threadColumnsBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
    const messageColumnsBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
    const tablesBefore = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'projection_thread_pull_requests'
      `;
    assert.notInclude(
      threadColumnsBefore.map(({ name }) => name),
      "active_order_key",
    );
    assert.notInclude(
      messageColumnsBefore.map(({ name }) => name),
      "context_json",
    );
    assert.deepStrictEqual(tablesBefore, []);
    assert.include(
      threadColumnsBefore.map(({ name }) => name),
      "hidden_at",
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_schema
          WHERE type = 'table'
            AND name IN ('pending_interactions', 'pending_interaction_responses', 'queued_provider_turn_starts')
          ORDER BY name
        `,
      [
        { name: "pending_interaction_responses" },
        { name: "pending_interactions" },
        { name: "queued_provider_turn_starts" },
      ],
    );

    yield* seedDeployedForkV1CutoverRows("/tmp/fork-project");
    yield* seedPendingRows;

    const forkJournalBefore = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`
        SELECT migration_id, name, created_at FROM effect_sql_migrations
        WHERE migration_id BETWEEN 34 AND 51 ORDER BY migration_id
      `;
    const pendingBefore = yield* sql`
        SELECT * FROM pending_interactions WHERE request_id = 'request:fork-v1'
      `;
    const responsesBefore = yield* sql`
        SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:fork-v1'
      `;
    const queuedBefore = yield* sql`
        SELECT * FROM queued_provider_turn_starts WHERE event_sequence = 8101
      `;

    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > 51),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM pending_interactions WHERE request_id = 'request:fork-v1'`,
      pendingBefore,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:fork-v1'`,
      responsesBefore,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM queued_provider_turn_starts WHERE event_sequence = 8101`,
      queuedBefore,
    );
    assert.deepStrictEqual(
      yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
          SELECT migration_id, name, created_at FROM effect_sql_migrations
          WHERE migration_id BETWEEN 34 AND 51 ORDER BY migration_id
        `,
      forkJournalBefore,
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations
          WHERE migration_id = 57
        `,
      [{ migration_id: 57, name: "PendingInteractionResponses" }],
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (61, 62)
        ORDER BY migration_id
      `,
      [
        { migration_id: 61, name: "ScheduledTaskWebhooks" },
        { migration_id: 62, name: "WebhookRelayDeliveries" },
      ],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM pending_interactions WHERE request_id = 'request:fork-v1'`,
      pendingBefore,
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:fork-v1'`,
      responsesBefore,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("upgrades the prior port 60 journal without rewriting its history or pending data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createPriorPort60Journal();

    const journalBefore = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
    const pendingBefore = yield* sql`
      SELECT * FROM pending_interactions WHERE request_id = ${priorPort60FixtureIds.pendingRequestId}
    `;
    const responsesBefore = yield* sql`
      SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:prior-port-60'
    `;

    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > 60),
    );
    assert.deepStrictEqual(
      yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`SELECT migration_id, name, created_at FROM effect_sql_migrations WHERE migration_id <= 60 ORDER BY migration_id`,
      journalBefore,
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT * FROM pending_interactions WHERE request_id = ${priorPort60FixtureIds.pendingRequestId}
      `,
      pendingBefore,
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:prior-port-60'
      `,
      responsesBefore,
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect.each([
  { name: "U57", includeRelayMigration: false, includeMcpAppContextMigration: false },
  { name: "U57/U58", includeRelayMigration: true, includeMcpAppContextMigration: false },
  { name: "U57/U58/U59", includeRelayMigration: true, includeMcpAppContextMigration: true },
])("bridges the native $name journal without rerunning upstream DDL", (fixture) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { includeRelayMigration, includeMcpAppContextMigration } = fixture;
    yield* createNativeWebhookJournal({
      includeRelayMigration,
      includeMcpAppContextMigration,
    });

    const nativePrefixLength = includeMcpAppContextMigration ? 59 : includeRelayMigration ? 58 : 57;
    const journalBefore = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
    const deliveryBefore = yield* sql`
          SELECT * FROM scheduled_task_webhook_deliveries
          WHERE delivery_id = ${nativeWebhookFixtureIds.deliveryId}
        `;
    const relayBefore = includeRelayMigration
      ? yield* sql`
              SELECT * FROM scheduled_task_webhook_relay_deliveries
              WHERE relay_delivery_id = ${nativeWebhookFixtureIds.relayDeliveryId}
            `
      : [];
    const mcpContextBefore = includeMcpAppContextMigration
      ? yield* sql`
              SELECT * FROM mcp_app_model_context
              WHERE thread_id = ${nativeMcpAppFixtureIds.threadId}
                AND item_id = ${nativeMcpAppFixtureIds.itemId}
            `
      : [];

    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > nativePrefixLength),
    );
    assert.deepStrictEqual(
      yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
            SELECT migration_id, name, created_at FROM effect_sql_migrations
            WHERE migration_id <= ${nativePrefixLength} ORDER BY migration_id
          `,
      journalBefore,
      "the recorded upstream prefix changed",
    );
    assert.deepStrictEqual(
      yield* sql`
            SELECT * FROM scheduled_task_webhook_deliveries
            WHERE delivery_id = ${nativeWebhookFixtureIds.deliveryId}
          `,
      deliveryBefore,
    );
    if (includeRelayMigration) {
      assert.deepStrictEqual(
        yield* sql`
              SELECT * FROM scheduled_task_webhook_relay_deliveries
              WHERE relay_delivery_id = ${nativeWebhookFixtureIds.relayDeliveryId}
            `,
        relayBefore,
      );
    }
    assert.deepStrictEqual(
      yield* sql`
            SELECT * FROM mcp_app_model_context
            WHERE thread_id = ${nativeMcpAppFixtureIds.threadId}
              AND item_id = ${nativeMcpAppFixtureIds.itemId}
          `,
      mcpContextBefore,
      "the native MCP app context row changed during upgrade",
    );

    const runColumns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(orchestration_v2_projection_runs)
        `;
    assert.include(
      runColumns.map(({ name }) => name),
      "accepted_sequence",
    );
    assert.include(
      runColumns.map(({ name }) => name),
      "service_update_resume_after_update",
    );
    const queuedThreadId = ThreadId.make("thread:native-u59-queue-bridge");
    yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_instance_id,
            provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES (
            'run:native-u59-queue-bridge', ${queuedThreadId}, 1, 'codex', 'codex', NULL,
            'queued', '2026-10-07T00:00:00.000Z', NULL, '{}'
          )
        `;
    yield* markQueuedRunsForUpdate(sql, { threadId: queuedThreadId });
    assert.deepStrictEqual(
      yield* sql<{ readonly service_update_resume_after_update: number }>`
            SELECT service_update_resume_after_update
            FROM orchestration_v2_projection_runs
            WHERE run_id = 'run:native-u59-queue-bridge'
          `,
      [{ service_update_resume_after_update: 1 }],
      "the port service-update queued-run migration was not applied",
    );
    assert.deepStrictEqual(yield* runMigrations(), []);

    const suffix = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations
          WHERE migration_id BETWEEN 57 AND 63 ORDER BY migration_id
        `;
    assert.deepStrictEqual(
      suffix.map(({ migration_id, name }) => [migration_id, name]),
      [
        [57, "ScheduledTaskWebhooks"],
        [58, includeRelayMigration ? "WebhookRelayDeliveries" : "RunAcceptanceSequence"],
        [59, includeMcpAppContextMigration ? "McpAppModelContext" : "ServiceUpdateQueuedRuns"],
        [60, "OrchestrationHttpCreateOperations"],
        [61, "ScheduledTaskWebhooks"],
        [62, "WebhookRelayDeliveries"],
        [63, "McpAppModelContext"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("refuses an unrecognized mixed 57–59 journal before migration writes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createNativeWebhookJournal({ includeRelayMigration: true });
    yield* sql`
      UPDATE effect_sql_migrations
      SET name = 'PendingInteractionResponses'
      WHERE migration_id = 57
    `;
    const journalBefore = yield* sql`
      SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
    `;

    const failed = yield* Effect.exit(runMigrations());
    assert.isTrue(Exit.isFailure(failed));
    assert.deepStrictEqual(
      yield* sql`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`,
      journalBefore,
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly name: string }>`PRAGMA table_info(pending_interactions)`,
      [],
      "the migration runner wrote port schema before rejecting the mixed journal",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "rolls back skipped port migrations when a later migration fails, then retries once",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createNativeWebhookJournal({ includeRelayMigration: true });
      const journalBefore = yield* sql`
      SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
    `;
      const deliveryBefore = yield* sql`
      SELECT * FROM scheduled_task_webhook_deliveries
      WHERE delivery_id = ${nativeWebhookFixtureIds.deliveryId}
    `;
      const relayBefore = yield* sql`
      SELECT * FROM scheduled_task_webhook_relay_deliveries
      WHERE relay_delivery_id = ${nativeWebhookFixtureIds.relayDeliveryId}
    `;

      yield* sql`CREATE TABLE orchestration_http_create_operations (blocker TEXT)`;
      const failed = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(failed));
      assert.deepStrictEqual(
        yield* sql`
        SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id
      `,
        journalBefore,
      );
      assert.deepStrictEqual(
        yield* sql<{ readonly name: string }>`PRAGMA table_info(pending_interactions)`,
        [],
        "the skipped port 57 body escaped the failed transaction",
      );
      assert.notInclude(
        (yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_runs)
      `).map(({ name }) => name),
        "accepted_sequence",
      );
      assert.deepStrictEqual(
        yield* sql`
        SELECT * FROM scheduled_task_webhook_deliveries
        WHERE delivery_id = ${nativeWebhookFixtureIds.deliveryId}
      `,
        deliveryBefore,
      );
      assert.deepStrictEqual(
        yield* sql`
        SELECT * FROM scheduled_task_webhook_relay_deliveries
        WHERE relay_delivery_id = ${nativeWebhookFixtureIds.relayDeliveryId}
      `,
        relayBefore,
      );

      yield* sql`DROP TABLE orchestration_http_create_operations`;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > 58),
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rolls back a failed F57 schema reconciliation and retries after repair", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createDeployedForkV1Schema();
    yield* seedDeployedForkV1CutoverRows("/tmp/fork-project");
    yield* seedPendingRows;
    yield* sql`DROP INDEX idx_pending_interaction_responses_command`;

    const failed = yield* Effect.exit(runMigrations());
    assert.isTrue(Exit.isFailure(failed));
    assert.deepStrictEqual(
      yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id DESC LIMIT 1
        `,
      [{ migration_id: 51, name: "ProjectionThreadBranchPullRequest" }],
    );
    const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
    assert.notInclude(
      threadColumns.map(({ name }) => name),
      "active_order_key",
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name = 'orchestration_v2_legacy_imports'
        `,
      [],
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM pending_interactions WHERE request_id = 'request:fork-v1'
        `,
      [{ count: 1 }],
    );

    yield* sql`
        CREATE UNIQUE INDEX idx_pending_interaction_responses_command
        ON pending_interaction_responses(command_id)
      `;
    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > 51),
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM pending_interaction_responses WHERE idempotency_key = 'key:fork-v1'
        `,
      [{ count: 1 }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rejects a partial response key and retries after restoring full uniqueness", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createDeployedForkV1Schema();
    yield* seedDeployedForkV1CutoverRows("/tmp/fork-project");
    yield* seedPendingRows;

    const forkJournalBefore = yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`
      SELECT migration_id, name, created_at FROM effect_sql_migrations
      WHERE migration_id BETWEEN 34 AND 51 ORDER BY migration_id
    `;
    const responseBefore = yield* sql<{
      readonly auth_session_id: string;
      readonly idempotency_key: string;
      readonly thread_id: string;
      readonly request_id: string;
      readonly action: string;
      readonly semantic_hash: string;
      readonly command_id: string;
      readonly command_created_at: string;
      readonly dispatched_at: string | null;
    }>`
      SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:fork-v1'
    `;
    assert.lengthOf(responseBefore, 1);

    yield* sql`DROP TABLE pending_interaction_responses`;
    yield* sql`
      CREATE TABLE pending_interaction_responses (
        auth_session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
        thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
        request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
        action TEXT NOT NULL CHECK (action IN ('answer', 'approve', 'decline', 'cancel')),
        semantic_hash TEXT NOT NULL,
        command_id TEXT NOT NULL,
        command_created_at TEXT NOT NULL,
        dispatched_at TEXT,
        PRIMARY KEY (auth_session_id, idempotency_key),
        FOREIGN KEY (thread_id, request_id)
          REFERENCES pending_interactions(thread_id, request_id) ON DELETE CASCADE
      )
    `;
    const response = responseBefore[0];
    assert.isDefined(response);
    yield* sql`
      INSERT INTO pending_interaction_responses (
        auth_session_id, idempotency_key, thread_id, request_id, action,
        semantic_hash, command_id, command_created_at, dispatched_at
      ) VALUES (
        ${response.auth_session_id}, ${response.idempotency_key}, ${response.thread_id},
        ${response.request_id}, ${response.action}, ${response.semantic_hash},
        ${response.command_id}, ${response.command_created_at}, ${response.dispatched_at}
      )
    `;
    yield* sql`
      CREATE UNIQUE INDEX idx_pending_interaction_responses_command
      ON pending_interaction_responses(command_id)
    `;
    yield* sql`
      CREATE UNIQUE INDEX idx_pending_interaction_responses_thread_request_partial
      ON pending_interaction_responses(thread_id, request_id)
      WHERE action = 'approve'
    `;
    const responseIndexes = yield* sql<{
      readonly name: string;
      readonly unique: number;
      readonly partial: number;
    }>`PRAGMA index_list(pending_interaction_responses)`;
    assert.isTrue(
      responseIndexes.some(
        (index) =>
          index.name === "idx_pending_interaction_responses_thread_request_partial" &&
          index.unique === 1 &&
          index.partial === 1,
      ),
    );

    const failed = yield* Effect.exit(runMigrations());
    assert.isTrue(Exit.isFailure(failed));
    assert.deepStrictEqual(
      yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations
        ORDER BY migration_id DESC LIMIT 1
      `,
      [{ migration_id: 51, name: "ProjectionThreadBranchPullRequest" }],
    );
    const threadColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_threads)
    `;
    const messageColumns = yield* sql<{ readonly name: string }>`
      PRAGMA table_info(projection_thread_messages)
    `;
    assert.notInclude(
      threadColumns.map(({ name }) => name),
      "active_order_key",
    );
    assert.notInclude(
      messageColumns.map(({ name }) => name),
      "context_json",
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'orchestration_v2_legacy_imports'
      `,
      [],
    );
    assert.deepStrictEqual(
      yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
        SELECT migration_id, name, created_at FROM effect_sql_migrations
        WHERE migration_id BETWEEN 34 AND 51 ORDER BY migration_id
      `,
      forkJournalBefore,
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:fork-v1'
      `,
      responseBefore,
    );

    yield* sql`DROP INDEX idx_pending_interaction_responses_thread_request_partial`;
    yield* sql`
      CREATE UNIQUE INDEX idx_pending_interaction_responses_thread_request
      ON pending_interaction_responses(thread_id, request_id)
    `;
    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationManifest.filter(([id]) => id > 51),
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT * FROM pending_interaction_responses WHERE idempotency_key = 'key:fork-v1'
      `,
      responseBefore,
    );
    assert.deepStrictEqual(
      yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 57
      `,
      [{ migration_id: 57, name: "PendingInteractionResponses" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
