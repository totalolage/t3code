import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import { markQueuedRunsForUpdate } from "./ServiceUpdateQueuedRuns.ts";

const layer = it.layer(layerMemory);

layer("ServiceUpdateQueuedRuns", (it) => {
  it.effect("marks only unheld queued runs and can scope arrivals to their thread", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();

      const insertRun = (
        runId: string,
        threadId: string,
        ordinal: number,
        status: string,
        queueHeld: boolean,
      ) =>
        sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_instance_id,
            provider_thread_id, status, requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal}, 'codex', 'codex', NULL, ${status},
            '2026-10-06T00:00:00.000Z', NULL,
            ${JSON.stringify({ queueHeld })}
          )
        `;

      yield* insertRun("eligible-a", "thread-a", 1, "queued", false);
      yield* insertRun("held-a", "thread-a", 2, "queued", true);
      yield* insertRun("active-a", "thread-a", 3, "running", false);
      yield* insertRun("eligible-b", "thread-b", 1, "queued", false);

      yield* markQueuedRunsForUpdate(sql, { threadId: ThreadId.make("thread-a") });

      const rows = yield* sql<{
        readonly run_id: string;
        readonly service_update_resume_after_update: number;
      }>`
        SELECT run_id, service_update_resume_after_update
        FROM orchestration_v2_projection_runs ORDER BY run_id
      `;
      assert.deepStrictEqual(rows, [
        { run_id: "active-a", service_update_resume_after_update: 0 },
        { run_id: "eligible-a", service_update_resume_after_update: 1 },
        { run_id: "eligible-b", service_update_resume_after_update: 0 },
        { run_id: "held-a", service_update_resume_after_update: 0 },
      ]);

      yield* markQueuedRunsForUpdate(sql);
      const marked = yield* sql<{ readonly run_id: string }>`
        SELECT run_id FROM orchestration_v2_projection_runs
        WHERE service_update_resume_after_update = 1 ORDER BY run_id
      `;
      assert.deepStrictEqual(marked, [{ run_id: "eligible-a" }, { run_id: "eligible-b" }]);
    }),
  );
});
