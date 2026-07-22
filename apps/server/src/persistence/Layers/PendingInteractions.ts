import {
  ApprovalRequestId,
  AuthSessionId,
  CommandId,
  IsoDateTime,
  RemoteInteractionIdempotencyKey,
  RemotePendingInteractionAction,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  PendingInteractionRepository,
  PendingInteractionQuestion,
  PendingInteractionRow,
  type PendingInteractionClaimInput,
  type PendingInteractionRepositoryShape,
} from "../Services/PendingInteractions.ts";

const PendingInteractionDbRow = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  kind: Schema.Literals(["approval", "user-input"]),
  status: Schema.Literals(["pending", "responding", "resolved", "stale"]),
  summary: Schema.String,
  canApprove: Schema.Number,
  questions: Schema.fromJsonString(Schema.Array(PendingInteractionQuestion)),
  responseAction: Schema.NullOr(RemotePendingInteractionAction),
  responseCommandId: Schema.NullOr(CommandId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});

const PendingInteractionLookup = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
});

const PendingInteractionResponseDbRow = Schema.Struct({
  authSessionId: AuthSessionId,
  idempotencyKey: RemoteInteractionIdempotencyKey,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  action: RemotePendingInteractionAction,
  semanticHash: Schema.String,
  commandId: CommandId,
  commandCreatedAt: IsoDateTime,
  dispatchedAt: Schema.NullOr(IsoDateTime),
});

const PendingInteractionResponseLookup = Schema.Struct({
  authSessionId: AuthSessionId,
  idempotencyKey: RemoteInteractionIdempotencyKey,
});

function mapRepositoryError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function toRow(row: typeof PendingInteractionDbRow.Type): PendingInteractionRow {
  return {
    ...row,
    canApprove: row.canApprove === 1,
  };
}

const makePendingInteractionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertOpenedRow = SqlSchema.void({
    Request: PendingInteractionRow,
    execute: (row) => sql`
      INSERT INTO pending_interactions (
        thread_id, request_id, kind, status, summary, can_approve,
        questions_json, response_action, response_command_id,
        created_at, updated_at, resolved_at
      ) VALUES (
        ${row.threadId}, ${row.requestId}, ${row.kind}, ${row.status}, ${row.summary},
        ${row.canApprove ? 1 : 0}, ${JSON.stringify(row.questions)}, ${row.responseAction},
        ${row.responseCommandId},
        ${row.createdAt}, ${row.updatedAt}, ${row.resolvedAt}
      )
      ON CONFLICT (thread_id, request_id) DO UPDATE SET
        kind = CASE
          WHEN pending_interactions.status <> 'pending'
            THEN pending_interactions.kind
          ELSE excluded.kind
        END,
        status = CASE
          WHEN pending_interactions.status <> 'pending'
            THEN pending_interactions.status
          ELSE excluded.status
        END,
        summary = CASE
          WHEN pending_interactions.status <> 'pending'
            THEN pending_interactions.summary
          ELSE excluded.summary
        END,
        can_approve = CASE
          WHEN pending_interactions.status <> 'pending'
            THEN pending_interactions.can_approve
          ELSE excluded.can_approve
        END,
        questions_json = CASE
          WHEN pending_interactions.status <> 'pending'
            THEN pending_interactions.questions_json
          ELSE excluded.questions_json
        END,
        updated_at = CASE
          WHEN pending_interactions.status <> 'pending'
            THEN pending_interactions.updated_at
          ELSE excluded.updated_at
        END
    `,
  });

  const listOpenRows = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.NullOr(ThreadId) }),
    Result: PendingInteractionDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId", request_id AS "requestId", kind, status, summary,
        can_approve AS "canApprove", questions_json AS "questions",
        response_action AS "responseAction", response_command_id AS "responseCommandId",
        created_at AS "createdAt",
        updated_at AS "updatedAt", resolved_at AS "resolvedAt"
      FROM pending_interactions
      WHERE status IN ('pending', 'responding')
        AND (${threadId} IS NULL OR thread_id = ${threadId})
      ORDER BY created_at ASC, thread_id ASC, request_id ASC
      LIMIT 100
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: PendingInteractionLookup,
    Result: PendingInteractionDbRow,
    execute: ({ threadId, requestId }) => sql`
      SELECT
        thread_id AS "threadId", request_id AS "requestId", kind, status, summary,
        can_approve AS "canApprove", questions_json AS "questions",
        response_action AS "responseAction", response_command_id AS "responseCommandId",
        created_at AS "createdAt",
        updated_at AS "updatedAt", resolved_at AS "resolvedAt"
      FROM pending_interactions
      WHERE thread_id = ${threadId} AND request_id = ${requestId}
      LIMIT 1
    `,
  });

  const getResponse = SqlSchema.findOneOption({
    Request: PendingInteractionResponseLookup,
    Result: PendingInteractionResponseDbRow,
    execute: ({ authSessionId, idempotencyKey }) => sql`
      SELECT
        auth_session_id AS "authSessionId", idempotency_key AS "idempotencyKey",
        thread_id AS "threadId", request_id AS "requestId", action,
        semantic_hash AS "semanticHash", command_id AS "commandId",
        command_created_at AS "commandCreatedAt", dispatched_at AS "dispatchedAt"
      FROM pending_interaction_responses
      WHERE auth_session_id = ${authSessionId} AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `,
  });

  const insertResponse = SqlSchema.void({
    Request: Schema.Struct({
      authSessionId: AuthSessionId,
      idempotencyKey: RemoteInteractionIdempotencyKey,
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      action: RemotePendingInteractionAction,
      semanticHash: Schema.String,
      commandId: CommandId,
      commandCreatedAt: Schema.String,
    }),
    execute: (row) => sql`
      INSERT OR IGNORE INTO pending_interaction_responses (
        auth_session_id, idempotency_key, thread_id, request_id,
        action, semantic_hash, command_id, command_created_at, dispatched_at
      ) VALUES (
        ${row.authSessionId}, ${row.idempotencyKey}, ${row.threadId}, ${row.requestId},
        ${row.action}, ${row.semanticHash}, ${row.commandId}, ${row.commandCreatedAt}, NULL
      )
    `,
  });

  const upsertOpened: PendingInteractionRepositoryShape["upsertOpened"] = (row) =>
    upsertOpenedRow(row).pipe(
      Effect.mapError(
        mapRepositoryError(
          "PendingInteractionRepository.upsertOpened:query",
          "PendingInteractionRepository.upsertOpened:encode",
        ),
      ),
    );

  const listOpen: PendingInteractionRepositoryShape["listOpen"] = (input = {}) =>
    listOpenRows({ threadId: input.threadId ?? null }).pipe(
      Effect.map((rows) => rows.map(toRow)),
      Effect.mapError(
        mapRepositoryError(
          "PendingInteractionRepository.listOpen:query",
          "PendingInteractionRepository.listOpen:decode",
        ),
      ),
    );

  const get: PendingInteractionRepositoryShape["get"] = (input) =>
    getRow(input).pipe(
      Effect.map(Option.map(toRow)),
      Effect.mapError(
        mapRepositoryError(
          "PendingInteractionRepository.get:query",
          "PendingInteractionRepository.get:decode",
        ),
      ),
    );

  const markResponding: PendingInteractionRepositoryShape["markResponding"] = (input) =>
    sql`
      UPDATE pending_interactions
      SET status = 'responding', response_action = ${input.action},
          response_command_id = ${input.commandId}, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND request_id = ${input.requestId}
        AND status = 'pending'
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PendingInteractionRepository.markResponding:query")),
    );

  const resolve: PendingInteractionRepositoryShape["resolve"] = (input) =>
    sql`
      UPDATE pending_interactions
      SET status = 'resolved', updated_at = ${input.updatedAt}, resolved_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND request_id = ${input.requestId}
        AND status IN ('pending', 'responding')
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PendingInteractionRepository.resolve:query")),
    );

  const markThreadStale: PendingInteractionRepositoryShape["markThreadStale"] = (input) =>
    sql`
      UPDATE pending_interactions
      SET status = 'stale', updated_at = ${input.updatedAt}, resolved_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND status IN ('pending', 'responding')
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PendingInteractionRepository.markThreadStale:query")),
    );

  const markStale: PendingInteractionRepositoryShape["markStale"] = (input) =>
    sql`
      UPDATE pending_interactions
      SET status = 'stale', updated_at = ${input.updatedAt}, resolved_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId} AND request_id = ${input.requestId}
        AND status IN ('pending', 'responding')
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("PendingInteractionRepository.markStale:query")),
    );

  const claimResponse: PendingInteractionRepositoryShape["claimResponse"] = (
    input: PendingInteractionClaimInput,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* getResponse({
            authSessionId: input.authSessionId,
            idempotencyKey: input.idempotencyKey,
          });
          if (Option.isSome(previous)) {
            const row = previous.value;
            const matches =
              row.threadId === input.threadId &&
              row.requestId === input.requestId &&
              row.action === input.action &&
              row.semanticHash === input.semanticHash;
            if (!matches) {
              return { _tag: "conflict" } as const;
            }
            if (row.dispatchedAt === null) {
              const interaction = yield* getRow({
                threadId: input.threadId,
                requestId: input.requestId,
              });
              if (
                Option.isNone(interaction) ||
                (interaction.value.status !== "pending" &&
                  interaction.value.responseCommandId !== row.commandId)
              ) {
                return { _tag: "unavailable" } as const;
              }
            }
            return {
              _tag: "replayed",
              commandId: row.commandId,
              commandCreatedAt: row.commandCreatedAt,
              dispatchAccepted: row.dispatchedAt !== null,
            } as const;
          }

          const interaction = yield* getRow({
            threadId: input.threadId,
            requestId: input.requestId,
          });
          if (Option.isNone(interaction) || interaction.value.status !== "pending") {
            return { _tag: "unavailable" } as const;
          }

          yield* insertResponse(input);
          const inserted = yield* getResponse({
            authSessionId: input.authSessionId,
            idempotencyKey: input.idempotencyKey,
          });
          if (Option.isNone(inserted)) {
            return { _tag: "unavailable" } as const;
          }
          if (
            inserted.value.threadId !== input.threadId ||
            inserted.value.requestId !== input.requestId ||
            inserted.value.action !== input.action ||
            inserted.value.semanticHash !== input.semanticHash
          ) {
            return { _tag: "conflict" } as const;
          }

          if (inserted.value.commandId === input.commandId) {
            return {
              _tag: "claimed",
              commandId: inserted.value.commandId,
              commandCreatedAt: inserted.value.commandCreatedAt,
              dispatchAccepted: false,
            } as const;
          }
          return {
            _tag: "replayed",
            commandId: inserted.value.commandId,
            commandCreatedAt: inserted.value.commandCreatedAt,
            dispatchAccepted: inserted.value.dispatchedAt !== null,
          } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          mapRepositoryError(
            "PendingInteractionRepository.claimResponse:query",
            "PendingInteractionRepository.claimResponse:decode",
          ),
        ),
      );

  const markDispatchAccepted: PendingInteractionRepositoryShape["markDispatchAccepted"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
              UPDATE pending_interaction_responses
              SET dispatched_at = COALESCE(dispatched_at, ${input.dispatchedAt})
              WHERE auth_session_id = ${input.authSessionId}
                AND idempotency_key = ${input.idempotencyKey}
                AND command_id = ${input.commandId}
            `;
          yield* sql`
              UPDATE pending_interactions
              SET status = 'responding',
                  response_action = (
                    SELECT action FROM pending_interaction_responses
                    WHERE auth_session_id = ${input.authSessionId}
                      AND idempotency_key = ${input.idempotencyKey}
                      AND command_id = ${input.commandId}
                  ),
                  response_command_id = ${input.commandId},
                  updated_at = ${input.dispatchedAt}
              WHERE (thread_id, request_id) = (
                SELECT thread_id, request_id FROM pending_interaction_responses
                WHERE auth_session_id = ${input.authSessionId}
                  AND idempotency_key = ${input.idempotencyKey}
                  AND command_id = ${input.commandId}
              ) AND status = 'pending'
            `;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("PendingInteractionRepository.markDispatchAccepted:query"),
        ),
      );

  return PendingInteractionRepository.of({
    upsertOpened,
    listOpen,
    get,
    markResponding,
    resolve,
    markThreadStale,
    markStale,
    claimResponse,
    markDispatchAccepted,
  });
});

export const PendingInteractionRepositoryLive = Layer.effect(
  PendingInteractionRepository,
  makePendingInteractionRepository,
);
