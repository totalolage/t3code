import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0034 from "../Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "../Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "../Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "../Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "../Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "../Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "../Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "../Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "../Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "../Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "../Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "../Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "../Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "../Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "../Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0057 from "../Migrations/057_PendingInteractionResponses.ts";
import Migration0058 from "../Migrations/058_RunAcceptanceSequence.ts";
import Migration0059 from "../Migrations/059_ServiceUpdateQueuedRuns.ts";
import Migration0060 from "../Migrations/060_OrchestrationHttpCreateOperations.ts";
import NativeMigration0057 from "../Migrations/057_ScheduledTaskWebhooks.ts";
import NativeMigration0058 from "../Migrations/058_WebhookRelayDeliveries.ts";
import NativeMigration0059 from "../Migrations/059_McpAppModelContext.ts";
import { runMigrations } from "../Migrations.ts";

const migrationBodies = [
  [36, "ProjectionThreadsSnoozed", Migration0034],
  [37, "ProjectionThreadTitleRegeneration", Migration0035],
  [38, "ProjectionThreadsPinned", Migration0036],
  [39, "ProjectionTurnsKeysetIndex", Migration0037],
  [40, "ProjectionThreadsPinOrderKey", Migration0038],
  [41, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [42, "ProjectionProjectFaviconPath", Migration0040],
  [43, "AuthSessionClientConnection", Migration0041],
  [44, "ProjectionThreadLinkedPullRequest", Migration0042],
  [45, "ProjectionThreadsUnsettledAt", Migration0043],
  [47, "ClearAutomaticProjectModelDefaults", Migration0044],
  [48, "ProjectionProjectsAutoPull", Migration0045],
  [49, "RepairAutomaticSettlementTimestamps", Migration0046],
  [50, "ProjectionProjectIcon", Migration0047],
  [51, "ProjectionThreadBranchPullRequest", Migration0048],
] as const;

const createForkPendingInteractions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE pending_interactions (
      thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
      request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
      kind TEXT NOT NULL CHECK (kind IN ('approval', 'user-input')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'responding', 'resolved', 'stale')),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 512),
      can_approve INTEGER NOT NULL CHECK (can_approve IN (0, 1)),
      questions_json TEXT NOT NULL,
      response_action TEXT CHECK (
        response_action IS NULL OR response_action IN ('answer', 'approve', 'decline', 'cancel')
      ),
      response_command_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      PRIMARY KEY (thread_id, request_id)
    )
  `;

  yield* sql`
    CREATE INDEX idx_pending_interactions_status_created
    ON pending_interactions(status, created_at, thread_id, request_id)
  `;

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
      UNIQUE (thread_id, request_id),
      FOREIGN KEY (thread_id, request_id)
        REFERENCES pending_interactions(thread_id, request_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX idx_pending_interaction_responses_command
    ON pending_interaction_responses(command_id)
  `;
});

const createForkQueuedProviderTurnStarts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE queued_provider_turn_starts (
      event_sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL
    )
  `;
});

const createForkHiddenAt = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "hidden_at")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN hidden_at TEXT`;
  }
});

/**
 * Builds the shipped F 51-entry schema for migration tests and private
 * qualification fixtures. Shared migration bodies were byte-verified against
 * F commit 2a66327b3f140f02410bbbe90c6492134e3cbf3f; only F's 34, 35, and 46
 * schema steps are kept here because the native branch no longer has them.
 */
export const createDeployedForkV1Schema = Effect.fn("createDeployedForkV1Schema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 33 });

  yield* createForkPendingInteractions;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (34, 'PendingInteractions')
  `;

  yield* createForkQueuedProviderTurnStarts;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (35, 'QueuedProviderTurnStarts')
  `;

  for (const [migrationId, name, migration] of migrationBodies.slice(0, 10)) {
    yield* migration;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${migrationId}, ${name})
    `;
  }

  yield* createForkHiddenAt;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (46, 'ProjectionThreadsHiddenAt')
  `;

  for (const [migrationId, name, migration] of migrationBodies.slice(10)) {
    yield* migration;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${migrationId}, ${name})
    `;
  }
});

export const deployedForkV1FixtureIds = {
  projectId: "project:fork-v1-fixture",
  threadId: "thread:fork-v1-hidden-archived",
  messageIds: ["message:fork-v1:first", "message:fork-v1:answer", "message:fork-v1:latest"],
  authSessionId: "session:fork-v1-fixture",
} as const;

export const nativeWebhookFixtureIds = {
  scheduledTaskId: "task:native-webhook-fixture",
  deliveryId: "delivery:native-webhook-fixture",
  relayDeliveryId: "relay:native-webhook-fixture",
} as const;

export const nativeMcpAppFixtureIds = {
  threadId: "thread:native-mcp-app-fixture",
  itemId: "item:native-mcp-app-fixture",
} as const;

export const priorPort60FixtureIds = {
  pendingThreadId: "thread:prior-port-60",
  pendingRequestId: "request:prior-port-60",
  responseSessionId: "session:prior-port-60",
} as const;

const insertScheduledTaskFixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-10-06T00:00:00.000Z";
  yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: nativeWebhookFixtureIds.scheduledTaskId,
    title: "Native webhook fixture task",
    prompt: "Run fixture",
    enabled: 1,
    schedule_json: '{"type":"interval","everyMs":60000}',
    project_id: "project:native-webhook-fixture",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5.4"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: null,
    last_run_at: null,
    last_run_status: "never",
    last_run_error: null,
    run_count: 0,
  })}`;
});

const seedNativeWebhookDelivery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO scheduled_task_webhook_deliveries (
      delivery_id, task_id, received_at, method, query, headers_json, body,
      body_bytes, body_truncated, outcome, signature_verified, missing_fields_json,
      rendered_prompt, error
    ) VALUES (
      ${nativeWebhookFixtureIds.deliveryId}, ${nativeWebhookFixtureIds.scheduledTaskId},
      '2026-10-06T00:01:00.000Z', 'POST', '', '{}', 'fixture body', 12, 0,
      'accepted', 1, '[]', 'fixture prompt', NULL
    )
  `;
});

const seedNativeWebhookRelayDelivery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO scheduled_task_webhook_relay_deliveries (relay_delivery_id, task_id, seen_at)
    VALUES (
      ${nativeWebhookFixtureIds.relayDeliveryId}, ${nativeWebhookFixtureIds.scheduledTaskId},
      '2026-10-06T00:02:00.000Z'
    )
  `;
});

const seedNativeMcpAppModelContext = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO mcp_app_model_context (
      thread_id, item_id, server, tool, text, updated_at
    ) VALUES (
      ${nativeMcpAppFixtureIds.threadId}, ${nativeMcpAppFixtureIds.itemId},
      'fixture-server', 'fixture-tool', 'Native MCP context fixture',
      '2026-10-07T00:00:00.000Z'
    )
  `;
});

/**
 * Creates an exact native 1–56 prefix, then applies upstream 57–59 migrations
 * at their original IDs and journal names. Disposable test and private
 * qualification fixtures use this to exercise the real collision.
 */
export const createNativeWebhookJournal = Effect.fn("createNativeWebhookJournal")(function* ({
  includeRelayMigration,
  includeMcpAppContextMigration = false,
}: {
  readonly includeRelayMigration: boolean;
  readonly includeMcpAppContextMigration?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  if (includeMcpAppContextMigration && !includeRelayMigration) {
    return yield* Effect.die(
      new Error("MCP app context fixture requires the native relay migration."),
    );
  }
  yield* runMigrations({ toMigrationInclusive: 56 });
  yield* insertScheduledTaskFixture;
  yield* NativeMigration0057;
  yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (57, 'ScheduledTaskWebhooks')
    `;
  yield* seedNativeWebhookDelivery;

  if (includeRelayMigration) {
    yield* NativeMigration0058;
    yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (58, 'WebhookRelayDeliveries')
      `;
    yield* seedNativeWebhookRelayDelivery;
    if (includeMcpAppContextMigration) {
      yield* NativeMigration0059;
      yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (59, 'McpAppModelContext')
        `;
      yield* seedNativeMcpAppModelContext;
    }
  }
});

/** Creates the already-tested port journal with its original 57–60 bodies. */
export const createPriorPort60Journal = Effect.fn("createPriorPort60Journal")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 56 });
  yield* Migration0057;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name)
    VALUES (57, 'PendingInteractionResponses')
  `;
  for (const [migrationId, name, migration] of [
    [58, "RunAcceptanceSequence", Migration0058],
    [59, "ServiceUpdateQueuedRuns", Migration0059],
    [60, "OrchestrationHttpCreateOperations", Migration0060],
  ] as const) {
    yield* migration;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${migrationId}, ${name})
    `;
  }
  const now = "2026-10-06T00:00:00.000Z";
  yield* sql`
    INSERT INTO pending_interactions (
      thread_id, request_id, kind, status, summary, can_approve, questions_json,
      response_action, response_command_id, created_at, updated_at, resolved_at
    ) VALUES (
      ${priorPort60FixtureIds.pendingThreadId}, ${priorPort60FixtureIds.pendingRequestId},
      'approval', 'responding', 'Prior port fixture', 1, '[]', 'approve',
      'command:prior-port-60', ${now}, ${now}, NULL
    )
  `;
  yield* sql`
    INSERT INTO pending_interaction_responses (
      auth_session_id, idempotency_key, thread_id, request_id, action,
      semantic_hash, command_id, command_created_at, dispatched_at
    ) VALUES (
      ${priorPort60FixtureIds.responseSessionId}, 'key:prior-port-60',
      ${priorPort60FixtureIds.pendingThreadId}, ${priorPort60FixtureIds.pendingRequestId},
      'approve', 'prior-port-semantic-hash', 'command:prior-port-60', ${now}, NULL
    )
  `;
});

/** Seeds one source-backed thread and session after the F schema is created. */
export const seedDeployedForkV1CutoverRows = Effect.fn("seedDeployedForkV1CutoverRows")(function* (
  workspaceRoot: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-10-01T00:00:00.000Z";

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${deployedForkV1FixtureIds.projectId}, 'Fork fixture project', ${workspaceRoot},
      '[]', ${now}, ${now}, NULL
    )
  `;

  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, latest_turn_id, created_at,
      updated_at, archived_at, settled_override, settled_at, unsettled_at,
      snoozed_until, snoozed_at, pinned_at, pin_order_key,
      linked_pull_request_json, deleted_at, hidden_at
    ) VALUES (
      ${deployedForkV1FixtureIds.threadId}, ${deployedForkV1FixtureIds.projectId},
      'Fork fixture thread', '{"instanceId":"codex","model":"gpt-5.4"}',
      'full-access', 'default', 'main', NULL, NULL, ${now}, ${now},
      '2026-10-02T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL,
      '2026-10-03T00:00:00.000Z', 'fork-pin-1',
      '{"projectId":"project:fork-v1-fixture","repository":"owner/repo","number":42,"url":"https://github.com/owner/repo/pull/42"}',
      NULL, '2026-10-04T00:00:00.000Z'
    )
  `;

  const messages = [
    {
      id: deployedForkV1FixtureIds.messageIds[0],
      role: "user",
      text: "First fork message",
      createdAt: "2026-10-01T01:00:00.000Z",
      attachmentsJson: "[]",
    },
    {
      id: deployedForkV1FixtureIds.messageIds[1],
      role: "assistant",
      text: "Fork answer with an image",
      createdAt: "2026-10-01T02:00:00.000Z",
      attachmentsJson:
        '[{"type":"image","id":"fork-image","name":"proof.png","mimeType":"image/png","sizeBytes":123}]',
    },
    {
      id: deployedForkV1FixtureIds.messageIds[2],
      role: "user",
      text: "Latest fork message",
      createdAt: "2026-10-01T03:00:00.000Z",
      attachmentsJson: "[]",
    },
  ] as const;

  for (const message of messages) {
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, attachments_json,
        is_streaming, created_at, updated_at
      ) VALUES (
        ${message.id}, ${deployedForkV1FixtureIds.threadId}, NULL, ${message.role},
        ${message.text}, ${message.attachmentsJson}, 0, ${message.createdAt}, ${message.createdAt}
      )
    `;
  }

  yield* sql`
    INSERT INTO auth_sessions (
      session_id, subject, scopes, method, client_label, client_ip_address,
      client_user_agent, client_device_type, client_os, client_browser,
      issued_at, expires_at, last_connected_at, revoked_at, client_surface,
      client_app_version
    ) VALUES (
      ${deployedForkV1FixtureIds.authSessionId}, 'fork-fixture-user', '["thread:read"]',
      'pairing', 'Fork fixture', NULL, 'fixture-agent', 'desktop', 'linux',
      'test-browser', ${now}, '2027-10-01T00:00:00.000Z', ${now}, NULL,
      'desktop', '1.0.0'
    )
  `;
});
