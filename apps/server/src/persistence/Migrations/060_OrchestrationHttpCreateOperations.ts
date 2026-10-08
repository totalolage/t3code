import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE orchestration_http_create_operations (
      key_hash TEXT NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL,
      semantic_hash TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      launch_plan_json TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('ready', 'running', 'retry-ready', 'completed')),
      attempts_json TEXT NOT NULL,
      run_id TEXT,
      result_sequence INTEGER,
      failure_json TEXT,
      CHECK (
        (phase = 'ready' AND run_id IS NULL AND result_sequence IS NULL AND failure_json IS NULL)
        OR (phase = 'running' AND result_sequence IS NULL AND failure_json IS NULL)
        OR (phase = 'retry-ready' AND run_id IS NOT NULL AND result_sequence IS NULL AND failure_json IS NOT NULL)
        OR (phase = 'completed' AND run_id IS NOT NULL AND result_sequence IS NOT NULL AND failure_json IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE TRIGGER orchestration_http_create_operations_identity_immutable
    BEFORE UPDATE OF key_hash, session_id, semantic_hash, command_id, thread_id, message_id, launch_plan_json
    ON orchestration_http_create_operations
    BEGIN
      SELECT RAISE(ABORT, 'orchestration HTTP create operation identity is immutable');
    END
  `;
});
