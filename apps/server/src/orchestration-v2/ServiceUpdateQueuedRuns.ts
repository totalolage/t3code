import type { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../persistence/Errors.ts";

export const markQueuedRunsForUpdate = (
  sql: SqlClient.SqlClient,
  input: { readonly threadId?: ThreadId } = {},
) =>
  sql`
    UPDATE orchestration_v2_projection_runs
    SET service_update_resume_after_update = 1
    WHERE status = 'queued'
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.queueHeld') IS NOT 1
        ELSE 0
      END
      ${input.threadId === undefined ? sql`` : sql`AND thread_id = ${input.threadId}`}
  `.pipe(
    Effect.asVoid,
    Effect.mapError(toPersistenceSqlError("ServiceUpdateQueuedRuns.markQueuedRunsForUpdate")),
  );

export const isQueuedRunMarkedForUpdate = (sql: SqlClient.SqlClient, runId: RunId) =>
  sql<{ readonly marked: number }>`
    SELECT service_update_resume_after_update AS marked
    FROM orchestration_v2_projection_runs
    WHERE run_id = ${runId}
  `.pipe(
    Effect.map((rows) => rows[0]?.marked === 1),
    Effect.mapError(toPersistenceSqlError("ServiceUpdateQueuedRuns.isQueuedRunMarkedForUpdate")),
  );
