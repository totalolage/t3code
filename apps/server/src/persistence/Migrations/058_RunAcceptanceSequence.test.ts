import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import { layerMemory } from "../Sqlite.ts";

const layer = it.layer(Layer.mergeAll(layerMemory));

layer("058_RunAcceptanceSequence", (it) => {
  it.effect("adds nullable server-only queued-run acceptance order after pending intent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      assert.deepStrictEqual(migrationManifest.slice(55, 58), [
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "PendingInteractionResponses"],
        [58, "RunAcceptanceSequence"],
      ]);

      const columns = yield* sql<{
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`PRAGMA table_info(orchestration_v2_projection_runs)`;
      const acceptanceColumn = columns.find(({ name }) => name === "accepted_sequence");
      assert.isDefined(acceptanceColumn);
      assert.equal(acceptanceColumn?.name, "accepted_sequence");
      assert.equal(acceptanceColumn?.type, "INTEGER");
      assert.equal(acceptanceColumn?.notnull, 0);
      assert.equal(acceptanceColumn?.dflt_value, null);

      const indexes = yield* sql<{
        readonly name: string;
        readonly definition: string;
      }>`
        SELECT name, sql AS definition
        FROM sqlite_master
        WHERE type = 'index'
          AND name = 'idx_orchestration_v2_projection_queued_acceptance_sequence'
      `;
      assert.equal(indexes.length, 1);
      assert.equal(indexes[0]?.definition?.includes("WHERE status = 'queued'"), true);
      assert.equal(indexes[0]?.definition?.includes("accepted_sequence IS NOT NULL"), true);
    }),
  );
});
