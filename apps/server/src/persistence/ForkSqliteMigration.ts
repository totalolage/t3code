import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0063 from "./Migrations/059_McpAppModelContext.ts";
import Migration0062 from "./Migrations/058_WebhookRelayDeliveries.ts";
import { makeRuntimeSqliteLayer } from "./RuntimeSqliteClient.ts";

type MigrationManifest = ReadonlyArray<readonly [id: number, name: string]>;

export class SqliteMigrationLineageError extends Schema.TaggedError<SqliteMigrationLineageError>()(
  "SqliteMigrationLineageError",
  { message: Schema.String },
) {}

interface MigrationJournalRow {
  readonly migration_id: number;
  readonly name: string;
  readonly created_at: string;
}

const deployedForkNames = [
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
  "ClearAutomaticProjectModelDefaults",
  "ProjectionProjectsAutoPull",
  "RepairAutomaticSettlementTimestamps",
  "ProjectionProjectIcon",
  "ProjectionThreadBranchPullRequest",
] as const;

const hasValidTimestamp = (value: string): boolean =>
  value.trim().length > 0 && Number.isFinite(Date.parse(value));

export interface NativeWebhookMigrationState {
  readonly latestMigrationId: number;
  readonly hasNativeRelayMigration: boolean;
  readonly hasNativeMcpAppContextMigration: boolean;
  readonly forkMigrationsApplied: boolean;
}

const portMigrationNames = [
  "PendingInteractionResponses",
  "RunAcceptanceSequence",
  "ServiceUpdateQueuedRuns",
  "OrchestrationHttpCreateOperations",
] as const;

const rowHasExpectedName = (
  rows: ReadonlyArray<MigrationJournalRow>,
  index: number,
  name: string,
) => rows[index]?.migration_id === index + 1 && rows[index]?.name === name;

const hasExpectedNativeMigration = (
  row: MigrationJournalRow | undefined,
  index: number,
  manifest: MigrationManifest,
): boolean => {
  if (row === undefined) return false;
  const expected = manifest[index];
  const supportedSiteLocalMigration41 =
    index === 40 && row.migration_id === 41 && row.name === "ThreadSummaryTimeline";
  return (
    expected !== undefined &&
    row.migration_id === index + 1 &&
    (row.name === expected[1] || supportedSiteLocalMigration41) &&
    hasValidTimestamp(row.created_at)
  );
};

const hasCanonicalNativePrefix = (
  rows: ReadonlyArray<MigrationJournalRow>,
  prefixLength: number,
  manifest: MigrationManifest,
): boolean =>
  rows.length >= prefixLength &&
  rows
    .slice(0, prefixLength)
    .every((row, index) => hasExpectedNativeMigration(row, index, manifest));

/**
 * Recognizes the 2026-10-07 upstream 57–59 prefix and the canonical fork
 * suffix recorded after those colliding IDs were preserved.
 */
export const classifyNativeWebhookJournal = (
  rows: ReadonlyArray<MigrationJournalRow>,
  nativeManifest: MigrationManifest,
): NativeWebhookMigrationState | undefined => {
  if (rows.length < 57 || rows.length > 63) return undefined;
  if (!hasCanonicalNativePrefix(rows, 56, nativeManifest)) return undefined;

  const scheduledTaskWebhooks = rows[56];
  if (
    scheduledTaskWebhooks?.migration_id !== 57 ||
    scheduledTaskWebhooks.name !== "ScheduledTaskWebhooks" ||
    !hasValidTimestamp(scheduledTaskWebhooks.created_at)
  ) {
    return undefined;
  }

  const relay = rows[57];
  let hasNativeRelayMigration = false;
  if (rows.length >= 58) {
    if (
      relay?.migration_id !== 58 ||
      !hasValidTimestamp(relay.created_at) ||
      (relay.name !== "WebhookRelayDeliveries" && relay.name !== "RunAcceptanceSequence")
    ) {
      return undefined;
    }
    hasNativeRelayMigration = relay.name === "WebhookRelayDeliveries";
  }

  let hasNativeMcpAppContextMigration = false;
  for (let index = 58; index < Math.min(rows.length, 60); index++) {
    const expected = nativeManifest[index];
    const row = rows[index];
    const isNativeMcpAppContextMigration = index === 58 && row?.name === "McpAppModelContext";
    if (
      expected === undefined ||
      row?.migration_id !== index + 1 ||
      (row.name !== expected[1] && !isNativeMcpAppContextMigration) ||
      !hasValidTimestamp(row.created_at)
    ) {
      return undefined;
    }
    hasNativeMcpAppContextMigration ||= isNativeMcpAppContextMigration;
  }

  if (rows.length >= 61) {
    if (rows.length < 60 || !rowHasExpectedName(rows, 60, "ScheduledTaskWebhooks")) {
      return undefined;
    }
    const row = rows[60];
    if (row === undefined || !hasValidTimestamp(row.created_at)) return undefined;
  }

  if (rows.length >= 62) {
    if (!rowHasExpectedName(rows, 61, "WebhookRelayDeliveries")) return undefined;
    const row = rows[61];
    if (row === undefined || !hasValidTimestamp(row.created_at)) return undefined;
    hasNativeRelayMigration = true;
  }

  if (rows.length >= 63) {
    if (!rowHasExpectedName(rows, 62, "McpAppModelContext")) return undefined;
    const row = rows[62];
    if (row === undefined || !hasValidTimestamp(row.created_at)) return undefined;
    hasNativeMcpAppContextMigration = true;
  }

  const forkMigrationsApplied =
    hasNativeMcpAppContextMigration && rows[58]?.name === "McpAppModelContext"
      ? rows.length >= 60
      : (relay?.name === "RunAcceptanceSequence" && rows.length >= 58) || rows.length >= 59;

  return {
    latestMigrationId: rows.at(-1)?.migration_id ?? 0,
    hasNativeRelayMigration,
    hasNativeMcpAppContextMigration,
    forkMigrationsApplied,
  };
};

/** Accepts a port 57–60 database whose earlier 1–56 history is native. */
export const isSupportedPriorPortJournal = (
  rows: ReadonlyArray<MigrationJournalRow>,
  nativeManifest: MigrationManifest,
): boolean => {
  if (rows.length < 60 || rows.length > 63) return false;
  if (!hasCanonicalNativePrefix(rows, 56, nativeManifest)) return false;

  for (let index = 56; index < 60; index++) {
    const row = rows[index];
    if (
      row?.migration_id !== index + 1 ||
      row.name !== portMigrationNames[index - 56] ||
      !hasValidTimestamp(row.created_at)
    ) {
      return false;
    }
  }

  if (rows.length >= 61 && !rowHasExpectedName(rows, 60, "ScheduledTaskWebhooks")) {
    return false;
  }
  if (rows.length >= 62 && !rowHasExpectedName(rows, 61, "WebhookRelayDeliveries")) {
    return false;
  }
  if (rows.length >= 63 && !rowHasExpectedName(rows, 62, "McpAppModelContext")) {
    return false;
  }
  return rows.slice(60).every((row) => hasValidTimestamp(row.created_at));
};

/** Recognizes upstream webhook bodies appended after the preserved fork suffix. */
export const classifyAppendedNativeWebhookJournal = (
  rows: ReadonlyArray<MigrationJournalRow>,
  manifest: MigrationManifest,
): NativeWebhookMigrationState | undefined => {
  if (rows.length < 61 || rows.length > 63) return undefined;
  if (
    !isSupportedDeployedForkJournal(rows, manifest) &&
    !isSupportedPriorPortJournal(rows, manifest)
  ) {
    return undefined;
  }

  return {
    latestMigrationId: rows.at(-1)?.migration_id ?? 0,
    hasNativeRelayMigration: rows.length >= 62,
    hasNativeMcpAppContextMigration: rows.length >= 63,
    forkMigrationsApplied: true,
  };
};

const readMigrationJournal = Effect.fn("readForkMigrationJournal")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return [];
  return yield* sql<MigrationJournalRow>`
    SELECT migration_id, name, created_at
    FROM effect_sql_migrations
    ORDER BY migration_id
  `;
});

export const getNativeWebhookMigrationState = Effect.fn("getNativeWebhookMigrationState")(
  function* (nativeManifest: MigrationManifest) {
    const rows = yield* readMigrationJournal();
    return classifyNativeWebhookJournal(rows, nativeManifest);
  },
);

/** Recognizes the shipped 1–51 fork ledger, native 52–56, and preserved port 57–60. */
export const isSupportedDeployedForkJournal = (
  rows: ReadonlyArray<MigrationJournalRow>,
  nativeManifest: MigrationManifest,
): boolean => {
  const forkPrefixLength = 33 + deployedForkNames.length;
  if (rows.length < forkPrefixLength || rows.length > nativeManifest.length) return false;

  for (const [index, row] of rows.entries()) {
    if (
      !Number.isSafeInteger(row.migration_id) ||
      row.migration_id !== index + 1 ||
      !hasValidTimestamp(row.created_at)
    ) {
      return false;
    }

    if (index < 33) {
      const expected = nativeManifest[index];
      if (expected === undefined || row.name !== expected[1]) return false;
      continue;
    }

    if (index < forkPrefixLength) {
      if (row.name !== deployedForkNames[index - 33]) return false;
      continue;
    }

    // Preserve the shipped port's original migration IDs 57–60 after a
    // deployed fork's native 52–56 suffix. Upstream 57–59 migrations are
    // appended as 61–63 so the colliding bodies remain independently recorded.
    if (index >= 56 && index < 60) {
      if (row.name !== portMigrationNames[index - 56]) return false;
      continue;
    }

    const expected = nativeManifest[index];
    if (expected === undefined || row.name !== expected[1]) return false;
  }

  return true;
};

/** Checks whether the native 49–51 schema effects have already been applied. */
const hasNativeSchemaBridge = Effect.fn("hasNativeForkSqliteSchemaBridge")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [threadColumns, messageColumns, pullRequestTables] = yield* Effect.all([
    sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`,
    sql<{ readonly name: string }>`PRAGMA table_info(projection_thread_messages)`,
    sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name = 'projection_thread_pull_requests'
    `,
  ]);

  return (
    threadColumns.some((column) => column.name === "active_order_key") &&
    messageColumns.some((column) => column.name === "context_json") &&
    pullRequestTables.length === 1
  );
});

/**
 * Reuses native migration bodies 49–51 on the copied fork database. The
 * caller owns the encompassing transaction, including any pending 52+ work.
 */
export const applyDeployedForkNativeSchemaBridge = Effect.fn("applyDeployedForkNativeSchemaBridge")(
  function* () {
    if (yield* hasNativeSchemaBridge()) return false;
    yield* Migration0049;
    yield* Migration0050;
    yield* Migration0051;
    return true;
  },
);

const pendingInteractionsMigrationError = (detail: string) =>
  new SqliteMigrationLineageError({
    message: `Recognized deployed fork migration 57 has an incompatible pending-interaction schema: ${detail}`,
  });

const expectedInteractionColumns = [
  ["thread_id", "TEXT", 1, 1],
  ["request_id", "TEXT", 1, 2],
  ["kind", "TEXT", 1, 0],
  ["status", "TEXT", 1, 0],
  ["summary", "TEXT", 1, 0],
  ["can_approve", "INTEGER", 1, 0],
  ["questions_json", "TEXT", 1, 0],
  ["response_action", "TEXT", 0, 0],
  ["response_command_id", "TEXT", 0, 0],
  ["created_at", "TEXT", 1, 0],
  ["updated_at", "TEXT", 1, 0],
  ["resolved_at", "TEXT", 0, 0],
] as const;

const expectedResponseColumns = [
  ["auth_session_id", "TEXT", 1, 1],
  ["idempotency_key", "TEXT", 1, 2],
  ["thread_id", "TEXT", 1, 0],
  ["request_id", "TEXT", 1, 0],
  ["action", "TEXT", 1, 0],
  ["semantic_hash", "TEXT", 1, 0],
  ["command_id", "TEXT", 1, 0],
  ["command_created_at", "TEXT", 1, 0],
  ["dispatched_at", "TEXT", 0, 0],
] as const;

const matchesColumns = (
  actual: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly pk: number;
  }>,
  expected: ReadonlyArray<readonly [string, string, number, number]>,
) =>
  actual.length === expected.length &&
  expected.every(([name, type, notnull, pk], index) => {
    const column = actual[index];
    return (
      column?.name === name &&
      column.type.toUpperCase() === type &&
      column.notnull === notnull &&
      column.pk === pk
    );
  });

const readIndexColumns = (indexName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly seqno: number; readonly name: string | null }>`
      SELECT seqno, name
      FROM pragma_index_info(${indexName})
      ORDER BY seqno
    `;
  });

type SchemaColumn = {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
};

type SchemaIndex = {
  readonly name: string;
  readonly unique: number;
  readonly partial: number;
};

const expectedScheduledTaskWebhookDeliveryColumns = [
  ["delivery_id", "TEXT", 0, 1],
  ["task_id", "TEXT", 1, 0],
  ["received_at", "TEXT", 1, 0],
  ["method", "TEXT", 1, 0],
  ["query", "TEXT", 1, 0],
  ["headers_json", "TEXT", 1, 0],
  ["body", "TEXT", 1, 0],
  ["body_bytes", "INTEGER", 1, 0],
  ["body_truncated", "INTEGER", 1, 0],
  ["outcome", "TEXT", 1, 0],
  ["signature_verified", "INTEGER", 1, 0],
  ["missing_fields_json", "TEXT", 1, 0],
  ["rendered_prompt", "TEXT", 0, 0],
  ["error", "TEXT", 0, 0],
] as const;

const expectedWebhookRelayDeliveryColumns = [
  ["relay_delivery_id", "TEXT", 0, 1],
  ["task_id", "TEXT", 1, 0],
  ["seen_at", "TEXT", 1, 0],
] as const;

const nativeWebhookSchemaError = (detail: string) =>
  new SqliteMigrationLineageError({
    message: `Native scheduled-task webhook migration schema is incompatible: ${detail}`,
  });

const tableExists = (tableName: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ${tableName}
    `;
  });

const scheduledTaskWebhookSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const scheduledTasks = yield* sql<SchemaColumn>`PRAGMA table_info(scheduled_tasks)`;
  const deliveryTables = yield* tableExists("scheduled_task_webhook_deliveries");
  const deliveryColumns = yield* sql<SchemaColumn>`
    PRAGMA table_info(scheduled_task_webhook_deliveries)
  `;
  const deliveryIndexes = yield* sql<SchemaIndex>`
    PRAGMA index_list(scheduled_task_webhook_deliveries)
  `;
  const deliveryIndex = deliveryIndexes.find(
    (index) => index.name === "idx_scheduled_task_webhook_deliveries_task",
  );
  const deliveryIndexColumns = deliveryIndex ? yield* readIndexColumns(deliveryIndex.name) : [];

  return {
    scheduledTasks,
    deliveryTables,
    deliveryColumns,
    deliveryIndex,
    deliveryIndexColumns,
  };
});

const isNativeScheduledTaskWebhookSchemaApplied = Effect.gen(function* () {
  const schema = yield* scheduledTaskWebhookSchema;
  const webhookColumns = ["webhook_token", "webhook_secret"].map((name) =>
    schema.scheduledTasks.filter((column) => column.name === name),
  );
  const columnsValid = webhookColumns.every(
    (matches) =>
      matches.length === 1 &&
      matches[0]?.type.toUpperCase() === "TEXT" &&
      matches[0]?.notnull === 0 &&
      matches[0]?.pk === 0,
  );
  const indexColumns = schema.deliveryIndexColumns.map((column) => column.name).join(",");
  return (
    columnsValid &&
    schema.deliveryTables.length === 1 &&
    matchesColumns(schema.deliveryColumns, expectedScheduledTaskWebhookDeliveryColumns) &&
    schema.deliveryIndex !== undefined &&
    schema.deliveryIndex.unique === 0 &&
    schema.deliveryIndex.partial === 0 &&
    indexColumns === "task_id,received_at"
  );
});

const relayWebhookSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const relayTables = yield* tableExists("scheduled_task_webhook_relay_deliveries");
  const relayColumns = yield* sql<SchemaColumn>`
    PRAGMA table_info(scheduled_task_webhook_relay_deliveries)
  `;
  const relayIndexes = yield* sql<SchemaIndex>`
    PRAGMA index_list(scheduled_task_webhook_relay_deliveries)
  `;
  const relayIndex = relayIndexes.find(
    (index) => index.name === "idx_scheduled_task_webhook_relay_deliveries_seen",
  );
  const relayIndexColumns = relayIndex ? yield* readIndexColumns(relayIndex.name) : [];
  const otherRelayIndexes = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name = 'idx_scheduled_task_webhook_relay_deliveries_seen'
  `;

  return {
    relayTables,
    relayColumns,
    relayIndex,
    relayIndexColumns,
    otherRelayIndexes,
  };
});

const isNativeRelayWebhookSchemaApplied = Effect.gen(function* () {
  const schema = yield* relayWebhookSchema;
  return (
    schema.relayTables.length === 1 &&
    matchesColumns(schema.relayColumns, expectedWebhookRelayDeliveryColumns) &&
    schema.relayIndex !== undefined &&
    schema.relayIndex.unique === 0 &&
    schema.relayIndex.partial === 0 &&
    schema.relayIndexColumns.map((column) => column.name).join(",") === "seen_at"
  );
});

const isNativeRelayWebhookSchemaAbsent = Effect.gen(function* () {
  const schema = yield* relayWebhookSchema;
  return schema.relayTables.length === 0 && schema.otherRelayIndexes.length === 0;
});

export const reconcileNativeScheduledTaskWebhooks = Effect.fn(
  "reconcileNativeScheduledTaskWebhooks",
)(function* () {
  if (!(yield* isNativeScheduledTaskWebhookSchemaApplied)) {
    return yield* Effect.fail(nativeWebhookSchemaError("ScheduledTaskWebhooks effects"));
  }
});

export const reconcileNativeWebhookRelayDeliveries = Effect.fn(
  "reconcileNativeWebhookRelayDeliveries",
)(function* () {
  if (!(yield* isNativeRelayWebhookSchemaApplied)) {
    return yield* Effect.fail(nativeWebhookSchemaError("WebhookRelayDeliveries effects"));
  }
});

export const applyNativeWebhookRelayDeliveries = Effect.fn("applyNativeWebhookRelayDeliveries")(
  function* () {
    if (!(yield* isNativeRelayWebhookSchemaAbsent)) {
      return yield* Effect.fail(nativeWebhookSchemaError("unrecorded relay delivery schema"));
    }
    yield* Migration0062;
    yield* reconcileNativeWebhookRelayDeliveries();
  },
);

const expectedMcpAppModelContextColumns = [
  ["thread_id", "TEXT", 1, 1],
  ["item_id", "TEXT", 1, 2],
  ["server", "TEXT", 1, 0],
  ["tool", "TEXT", 1, 0],
  ["text", "TEXT", 1, 0],
  ["updated_at", "TEXT", 1, 0],
] as const;

const mcpAppModelContextSchema = Effect.gen(function* () {
  const tables = yield* tableExists("mcp_app_model_context");
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<SchemaColumn>`PRAGMA table_info(mcp_app_model_context)`;
  return { tables, columns };
});

const isNativeMcpAppModelContextSchemaApplied = Effect.gen(function* () {
  const schema = yield* mcpAppModelContextSchema;
  return (
    schema.tables.length === 1 && matchesColumns(schema.columns, expectedMcpAppModelContextColumns)
  );
});

const isNativeMcpAppModelContextSchemaAbsent = Effect.gen(function* () {
  const tables = yield* tableExists("mcp_app_model_context");
  return tables.length === 0;
});

export const reconcileNativeMcpAppModelContext = Effect.fn("reconcileNativeMcpAppModelContext")(
  function* () {
    if (!(yield* isNativeMcpAppModelContextSchemaApplied)) {
      return yield* Effect.fail(
        new SqliteMigrationLineageError({
          message: "Native MCP app model context migration schema is incompatible.",
        }),
      );
    }
  },
);

export const applyNativeMcpAppModelContext = Effect.fn("applyNativeMcpAppModelContext")(
  function* () {
    if (!(yield* isNativeMcpAppModelContextSchemaAbsent)) {
      return yield* Effect.fail(
        new SqliteMigrationLineageError({
          message: "Unrecorded MCP app model context schema conflicts with migration 63.",
        }),
      );
    }
    yield* Migration0063;
    yield* reconcileNativeMcpAppModelContext();
  },
);

/** Read-only schema check used before an accepted native journal is opened writable. */
const isForkPendingSchemaAbsent = Effect.gen(function* () {
  const pendingInteractions = yield* tableExists("pending_interactions");
  const pendingResponses = yield* tableExists("pending_interaction_responses");
  return pendingInteractions.length === 0 && pendingResponses.length === 0;
});

const isForkRunAcceptanceSchemaApplied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<SchemaColumn>`
    PRAGMA table_info(orchestration_v2_projection_runs)
  `;
  const indexes = yield* sql<SchemaIndex>`
    PRAGMA index_list(orchestration_v2_projection_runs)
  `;
  const index = indexes.find(
    (candidate) => candidate.name === "idx_orchestration_v2_projection_queued_acceptance_sequence",
  );
  const indexColumns = index ? yield* readIndexColumns(index.name) : [];
  const acceptedSequence = columns.filter((column) => column.name === "accepted_sequence");
  return (
    acceptedSequence.length === 1 &&
    acceptedSequence[0]?.type.toUpperCase() === "INTEGER" &&
    acceptedSequence[0]?.notnull === 0 &&
    index !== undefined &&
    index.unique === 0 &&
    index.partial === 1 &&
    indexColumns.map((column) => column.name).join(",") === "accepted_sequence"
  );
});

const isForkRunAcceptanceSchemaAbsent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_runs)
  `;
  const indexes = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'index'
      AND name = 'idx_orchestration_v2_projection_queued_acceptance_sequence'
  `;
  return !columns.some((column) => column.name === "accepted_sequence") && indexes.length === 0;
});

const isForkServiceUpdateQueuedRunsSchemaApplied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<SchemaColumn & { readonly dflt_value: string | null }>`
    PRAGMA table_info(orchestration_v2_projection_runs)
  `;
  const indexes = yield* sql<SchemaIndex>`
    PRAGMA index_list(orchestration_v2_projection_runs)
  `;
  const index = indexes.find(
    (candidate) => candidate.name === "idx_orchestration_v2_projection_runs_service_update_resume",
  );
  const indexColumns = index ? yield* readIndexColumns(index.name) : [];
  const resumeAfterUpdate = columns.filter(
    (column) => column.name === "service_update_resume_after_update",
  );
  return (
    resumeAfterUpdate.length === 1 &&
    resumeAfterUpdate[0]?.type.toUpperCase() === "INTEGER" &&
    resumeAfterUpdate[0]?.notnull === 1 &&
    resumeAfterUpdate[0]?.dflt_value === "0" &&
    index !== undefined &&
    index.unique === 0 &&
    index.partial === 1 &&
    indexColumns.map((column) => column.name).join(",") === "thread_id,accepted_sequence"
  );
});

const isForkServiceUpdateQueuedRunsSchemaAbsent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(orchestration_v2_projection_runs)
  `;
  const indexes = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'index'
      AND name = 'idx_orchestration_v2_projection_runs_service_update_resume'
  `;
  return (
    !columns.some((column) => column.name === "service_update_resume_after_update") &&
    indexes.length === 0
  );
});

const isNativeWebhookJournalSchemaCompatibleFromCurrentConnection = Effect.fn(
  "isNativeWebhookJournalSchemaCompatibleFromCurrentConnection",
)(function* (migrationState: NativeWebhookMigrationState) {
  const scheduledTaskWebhooksApplied = yield* isNativeScheduledTaskWebhookSchemaApplied;
  if (!scheduledTaskWebhooksApplied) return false;
  const relaySchemaCompatible = migrationState.hasNativeRelayMigration
    ? yield* isNativeRelayWebhookSchemaApplied
    : yield* isNativeRelayWebhookSchemaAbsent;
  if (!relaySchemaCompatible) return false;
  const mcpAppModelContextSchemaCompatible = migrationState.hasNativeMcpAppContextMigration
    ? yield* isNativeMcpAppModelContextSchemaApplied
    : yield* isNativeMcpAppModelContextSchemaAbsent;
  if (!mcpAppModelContextSchemaCompatible) return false;
  if (migrationState.forkMigrationsApplied) {
    const pendingSchema = yield* Effect.exit(reconcileDeployedForkPendingInteractionSchema());
    return (
      Exit.isSuccess(pendingSchema) &&
      (yield* isForkRunAcceptanceSchemaApplied) &&
      (yield* isForkServiceUpdateQueuedRunsSchemaApplied)
    );
  }
  return (
    (yield* isForkPendingSchemaAbsent) &&
    (yield* isForkRunAcceptanceSchemaAbsent) &&
    (yield* isForkServiceUpdateQueuedRunsSchemaAbsent)
  );
});

export const isNativeWebhookJournalSchemaCompatible = (
  dbPath: string,
  migrationState: NativeWebhookMigrationState,
) =>
  isNativeWebhookJournalSchemaCompatibleFromCurrentConnection(migrationState).pipe(
    Effect.scoped,
    Effect.provide(makeRuntimeSqliteLayer({ filename: dbPath, readonly: true })),
    Effect.match({ onFailure: () => false, onSuccess: (compatible) => compatible }),
  );

/** Reject webhook DDL attached to a journal that claims the colliding port bodies. */
const isNativeCollisionSchemaAbsentFromCurrentConnection = Effect.fn(
  "isNativeCollisionSchemaAbsentFromCurrentConnection",
)(function* () {
  const scheduled = yield* scheduledTaskWebhookSchema;
  const relay = yield* relayWebhookSchema;
  const mcpAppModelContextAbsent = yield* isNativeMcpAppModelContextSchemaAbsent;
  return (
    mcpAppModelContextAbsent &&
    !scheduled.scheduledTasks.some(
      (column) => column.name === "webhook_token" || column.name === "webhook_secret",
    ) &&
    scheduled.deliveryTables.length === 0 &&
    scheduled.deliveryIndex === undefined &&
    relay.relayTables.length === 0 &&
    relay.otherRelayIndexes.length === 0
  );
});

export const isNativeCollisionSchemaAbsent = (dbPath: string) =>
  isNativeCollisionSchemaAbsentFromCurrentConnection().pipe(
    Effect.scoped,
    Effect.provide(makeRuntimeSqliteLayer({ filename: dbPath, readonly: true })),
    Effect.match({ onFailure: () => false, onSuccess: (absent) => absent }),
  );

/**
 * F migration 34 already created the same pending-interaction schema as native
 * migration 57. On that recognized lineage, validate the existing schema and
 * let Migrator record native 57 without executing its duplicate CREATEs.
 */
export const reconcileDeployedForkPendingInteractionSchema = Effect.fn(
  "reconcileDeployedForkPendingInteractionSchema",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const interactionColumns = yield* sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly pk: number;
  }>`PRAGMA table_info(pending_interactions)`;
  if (!matchesColumns(interactionColumns, expectedInteractionColumns)) {
    return yield* Effect.fail(pendingInteractionsMigrationError("pending_interactions columns"));
  }

  const responseColumns = yield* sql<{
    readonly name: string;
    readonly type: string;
    readonly notnull: number;
    readonly pk: number;
  }>`PRAGMA table_info(pending_interaction_responses)`;
  if (!matchesColumns(responseColumns, expectedResponseColumns)) {
    return yield* Effect.fail(
      pendingInteractionsMigrationError("pending_interaction_responses columns"),
    );
  }

  const interactionIndexes = yield* sql<{
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
  }>`PRAGMA index_list(pending_interactions)`;
  const statusIndex = interactionIndexes.find(
    (index) => index.name === "idx_pending_interactions_status_created",
  );
  if (
    statusIndex === undefined ||
    statusIndex.unique !== 0 ||
    statusIndex.partial !== 0 ||
    (yield* readIndexColumns(statusIndex.name)).map((column) => column.name).join(",") !==
      "status,created_at,thread_id,request_id"
  ) {
    return yield* Effect.fail(
      pendingInteractionsMigrationError("idx_pending_interactions_status_created definition"),
    );
  }

  const responseIndexes = yield* sql<{
    readonly name: string;
    readonly unique: number;
    readonly partial: number;
  }>`PRAGMA index_list(pending_interaction_responses)`;
  const commandIndex = responseIndexes.find(
    (index) => index.name === "idx_pending_interaction_responses_command",
  );
  if (
    commandIndex === undefined ||
    commandIndex.unique !== 1 ||
    commandIndex.partial !== 0 ||
    (yield* readIndexColumns(commandIndex.name)).map((column) => column.name).join(",") !==
      "command_id"
  ) {
    return yield* Effect.fail(
      pendingInteractionsMigrationError("idx_pending_interaction_responses_command definition"),
    );
  }

  const uniqueResponseKeys = [];
  for (const index of responseIndexes) {
    if (index.unique !== 1 || index.partial !== 0) continue;
    uniqueResponseKeys.push(
      (yield* readIndexColumns(index.name)).map((column) => column.name).join(","),
    );
  }
  if (!uniqueResponseKeys.includes("thread_id,request_id")) {
    return yield* Effect.fail(
      pendingInteractionsMigrationError("unique response key (thread_id, request_id)"),
    );
  }

  const responseForeignKeys = yield* sql<{
    readonly id: number;
    readonly seq: number;
    readonly table: string;
    readonly from: string;
    readonly to: string;
    readonly on_delete: string;
  }>`PRAGMA foreign_key_list(pending_interaction_responses)`;
  const orderedForeignKeys = responseForeignKeys.toSorted(
    (left, right) => left.id - right.id || left.seq - right.seq,
  );
  const foreignKeyIdentity = orderedForeignKeys.map((foreignKey) =>
    [foreignKey.table, foreignKey.from, foreignKey.to, foreignKey.on_delete.toUpperCase()].join(
      ",",
    ),
  );
  if (
    orderedForeignKeys.length !== 2 ||
    orderedForeignKeys[0]?.id !== orderedForeignKeys[1]?.id ||
    orderedForeignKeys[0]?.seq !== 0 ||
    orderedForeignKeys[1]?.seq !== 1 ||
    foreignKeyIdentity.join(";") !==
      "pending_interactions,thread_id,thread_id,CASCADE;pending_interactions,request_id,request_id,CASCADE"
  ) {
    return yield* Effect.fail(
      pendingInteractionsMigrationError("response foreign key to pending_interactions"),
    );
  }
});

/** Reads and classifies the current migration ledger before the native migrator runs. */
export const hasSupportedDeployedForkJournal = Effect.fn("hasSupportedDeployedForkJournal")(
  function* (nativeManifest: MigrationManifest) {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
    if (tables.length === 0) return false;

    const rows = yield* sql<MigrationJournalRow>`
    SELECT migration_id, name, created_at
    FROM effect_sql_migrations
    ORDER BY migration_id
  `;
    return isSupportedDeployedForkJournal(rows, nativeManifest);
  },
);

const isCanonicalMigrationPrefix = (
  rows: ReadonlyArray<MigrationJournalRow>,
  manifest: MigrationManifest,
): boolean =>
  rows.length <= manifest.length &&
  rows.every((row, index) => hasExpectedNativeMigration(row, index, manifest));

/**
 * The migrator skips a recorded ID without checking its name. Refuse journals
 * that reach the colliding upstream 57–59 range unless they match a lineage
 * already accepted by the read-only compatibility preflight.
 */
export const assertKnownCollidingMigrationJournal = Effect.fn(
  "assertKnownCollidingMigrationJournal",
)(function* (manifest: MigrationManifest) {
  const rows = yield* readMigrationJournal();
  if (!rows.some((row) => row.migration_id >= 57)) return;

  const nativeWebhookState = classifyNativeWebhookJournal(rows, manifest);
  const appendedNativeWebhookState = classifyAppendedNativeWebhookJournal(rows, manifest);
  const claimsPortCollisionBody = rows.some(
    (row) =>
      (row.migration_id === 57 && row.name === "PendingInteractionResponses") ||
      (row.migration_id === 58 && row.name === "RunAcceptanceSequence"),
  );
  const webhookStateToValidate = nativeWebhookState ?? appendedNativeWebhookState;
  const webhookSchemaCompatible =
    webhookStateToValidate !== undefined
      ? yield* isNativeWebhookJournalSchemaCompatibleFromCurrentConnection(webhookStateToValidate)
      : !claimsPortCollisionBody || (yield* isNativeCollisionSchemaAbsentFromCurrentConnection());
  const supported =
    isSupportedDeployedForkJournal(rows, manifest) ||
    nativeWebhookState !== undefined ||
    isSupportedPriorPortJournal(rows, manifest) ||
    isCanonicalMigrationPrefix(rows, manifest);
  if (!supported || !webhookSchemaCompatible) {
    return yield* Effect.fail(
      new SqliteMigrationLineageError({
        message:
          "Unrecognized migration journal at colliding migration IDs 57–59; refusing to run migrations.",
      }),
    );
  }
});
