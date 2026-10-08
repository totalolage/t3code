import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import { layerMemory } from "../Sqlite.ts";

const layer = it.layer(Layer.mergeAll(layerMemory));

const normalizeSql = (value: string) => value.replace(/\s+/g, " ").trim();

layer("057_PendingInteractionResponses", (it) => {
  it.effect("creates durable caller intent tables after the official native schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      assert.deepStrictEqual(migrationManifest.slice(54, 57), [
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "PendingInteractionResponses"],
      ]);

      const interactionColumns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(pending_interactions)`;
      assert.deepStrictEqual(
        interactionColumns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
        [
          { name: "thread_id", type: "TEXT", notnull: 1, pk: 1 },
          { name: "request_id", type: "TEXT", notnull: 1, pk: 2 },
          { name: "kind", type: "TEXT", notnull: 1, pk: 0 },
          { name: "status", type: "TEXT", notnull: 1, pk: 0 },
          { name: "summary", type: "TEXT", notnull: 1, pk: 0 },
          { name: "can_approve", type: "INTEGER", notnull: 1, pk: 0 },
          { name: "questions_json", type: "TEXT", notnull: 1, pk: 0 },
          { name: "response_action", type: "TEXT", notnull: 0, pk: 0 },
          { name: "response_command_id", type: "TEXT", notnull: 0, pk: 0 },
          { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "resolved_at", type: "TEXT", notnull: 0, pk: 0 },
        ],
      );

      const responseColumns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly pk: number;
      }>`PRAGMA table_info(pending_interaction_responses)`;
      assert.deepStrictEqual(
        responseColumns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
        [
          { name: "auth_session_id", type: "TEXT", notnull: 1, pk: 1 },
          { name: "idempotency_key", type: "TEXT", notnull: 1, pk: 2 },
          { name: "thread_id", type: "TEXT", notnull: 1, pk: 0 },
          { name: "request_id", type: "TEXT", notnull: 1, pk: 0 },
          { name: "action", type: "TEXT", notnull: 1, pk: 0 },
          { name: "semantic_hash", type: "TEXT", notnull: 1, pk: 0 },
          { name: "command_id", type: "TEXT", notnull: 1, pk: 0 },
          { name: "command_created_at", type: "TEXT", notnull: 1, pk: 0 },
          { name: "dispatched_at", type: "TEXT", notnull: 0, pk: 0 },
        ],
      );

      const definitions = yield* sql<{ readonly name: string; readonly definition: string }>`
        SELECT name, sql AS definition
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('pending_interactions', 'pending_interaction_responses')
        ORDER BY name
      `;
      const interactionDefinition = definitions.find(({ name }) => name === "pending_interactions");
      const responseDefinition = definitions.find(
        ({ name }) => name === "pending_interaction_responses",
      );
      assert.isDefined(interactionDefinition);
      assert.isDefined(responseDefinition);
      assert.include(
        normalizeSql(interactionDefinition?.definition ?? ""),
        "CHECK (length(thread_id) BETWEEN 1 AND 128)",
      );
      assert.include(
        normalizeSql(interactionDefinition?.definition ?? ""),
        "CHECK (length(request_id) BETWEEN 1 AND 128)",
      );
      assert.include(
        normalizeSql(interactionDefinition?.definition ?? ""),
        "CHECK (kind IN ('approval', 'user-input'))",
      );
      assert.include(
        normalizeSql(interactionDefinition?.definition ?? ""),
        "CHECK (status IN ('pending', 'responding', 'resolved', 'stale'))",
      );
      assert.include(
        normalizeSql(interactionDefinition?.definition ?? ""),
        "CHECK (length(summary) BETWEEN 1 AND 512)",
      );
      assert.include(
        normalizeSql(interactionDefinition?.definition ?? ""),
        "CHECK (can_approve IN (0, 1))",
      );
      assert.include(
        normalizeSql(responseDefinition?.definition ?? ""),
        "CHECK (length(idempotency_key) BETWEEN 1 AND 128)",
      );
      assert.include(
        normalizeSql(responseDefinition?.definition ?? ""),
        "UNIQUE (thread_id, request_id)",
      );
      assert.include(
        normalizeSql(responseDefinition?.definition ?? ""),
        "FOREIGN KEY (thread_id, request_id) REFERENCES pending_interactions(thread_id, request_id) ON DELETE CASCADE",
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_pending_interactions_status_created',
            'idx_pending_interaction_responses_command'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_pending_interaction_responses_command" },
        { name: "idx_pending_interactions_status_created" },
      ]);

      const recordedMigrations = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE migration_id BETWEEN 55 AND 57
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(recordedMigrations, [
        { migrationId: 55 },
        { migrationId: 56 },
        { migrationId: 57 },
      ]);
    }),
  );
});
