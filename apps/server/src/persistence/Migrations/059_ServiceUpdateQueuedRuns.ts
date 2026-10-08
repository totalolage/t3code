import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_v2_projection_runs
    ADD COLUMN service_update_resume_after_update INTEGER NOT NULL DEFAULT 0
    CHECK (service_update_resume_after_update IN (0, 1))
  `;
  yield* sql`
    CREATE INDEX idx_orchestration_v2_projection_runs_service_update_resume
    ON orchestration_v2_projection_runs(thread_id, accepted_sequence)
    WHERE service_update_resume_after_update = 1
  `;
});
