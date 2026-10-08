import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import { layerMemory } from "../Sqlite.ts";

const layer = it.layer(Layer.mergeAll(layerMemory));

layer("059_ServiceUpdateQueuedRuns", (it) => {
  it.effect("adds a private updater-resume marker to native queued runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      assert.deepStrictEqual(migrationManifest.slice(56, 60), [
        [57, "PendingInteractionResponses"],
        [58, "RunAcceptanceSequence"],
        [59, "ServiceUpdateQueuedRuns"],
        [60, "OrchestrationHttpCreateOperations"],
      ]);

      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(orchestration_v2_projection_runs)`;
      const marker = columns.find(({ name }) => name === "service_update_resume_after_update");
      assert.deepStrictEqual(
        marker === undefined
          ? undefined
          : {
              name: marker.name,
              type: marker.type,
              notnull: marker.notnull,
              dflt_value: marker.dflt_value,
            },
        {
          name: "service_update_resume_after_update",
          type: "INTEGER",
          notnull: 1,
          dflt_value: "0",
        },
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_orchestration_v2_projection_runs_service_update_resume'
      `;
      assert.deepStrictEqual(indexes, [
        { name: "idx_orchestration_v2_projection_runs_service_update_resume" },
      ]);

      const oldTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'service_update_epochs',
            'service_update_run_ownership',
            'service_update_turn_queue'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(oldTables, []);
    }),
  );
});
