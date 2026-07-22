import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
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
