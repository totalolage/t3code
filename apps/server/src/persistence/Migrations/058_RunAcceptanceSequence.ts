import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE orchestration_v2_projection_runs
    ADD COLUMN accepted_sequence INTEGER
  `;
  yield* sql`
    CREATE INDEX idx_orchestration_v2_projection_queued_acceptance_sequence
    ON orchestration_v2_projection_runs(accepted_sequence)
    WHERE status = 'queued' AND accepted_sequence IS NOT NULL
  `;
});
