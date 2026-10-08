import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "./Errors.ts";
import {
  InteractionRecord,
  PendingInteractionResponseKey,
  PendingInteractionLookup,
  PendingInteractionResponseRepository,
  ResponseRecord,
  type InteractionRecord as InteractionRecordType,
  type PendingInteractionResponseRepositoryShape,
} from "./Services/PendingInteractionResponses.ts";

const InteractionDbRow = Schema.Struct({
  threadId: InteractionRecord.fields.threadId,
  requestId: InteractionRecord.fields.requestId,
  kind: InteractionRecord.fields.kind,
  status: InteractionRecord.fields.status,
  summary: Schema.String,
  canApprove: Schema.Finite,
  questions: Schema.fromJsonString(InteractionRecord.fields.questions),
  responseAction: Schema.NullOr(InteractionRecord.fields.responseAction),
  responseCommandId: Schema.NullOr(InteractionRecord.fields.responseCommandId),
  createdAt: InteractionRecord.fields.createdAt,
  updatedAt: InteractionRecord.fields.updatedAt,
  resolvedAt: Schema.NullOr(InteractionRecord.fields.resolvedAt),
});

const ResponseDbRow = ResponseRecord;

function mapRepositoryError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function toInteractionRecord(row: typeof InteractionDbRow.Type): InteractionRecordType {
  return {
    ...row,
    canApprove: row.canApprove === 1,
  };
}

class ClaimConflict extends Schema.TaggedError<ClaimConflict>()(
  "PendingInteractionResponseClaimConflict",
  {},
) {}

const makePendingInteractionResponseRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findResponseByKey = SqlSchema.findOneOption({
    Request: PendingInteractionResponseKey,
    Result: ResponseDbRow,
    execute: ({ authSessionId, idempotencyKey }) => sql`
      SELECT
        auth_session_id AS "authSessionId",
        idempotency_key AS "idempotencyKey",
        thread_id AS "threadId",
        request_id AS "requestId",
        action,
        semantic_hash AS "semanticHash",
        command_id AS "commandId",
        command_created_at AS "commandCreatedAt",
        dispatched_at AS "dispatchedAt"
      FROM pending_interaction_responses
      WHERE auth_session_id = ${authSessionId}
        AND idempotency_key = ${idempotencyKey}
      LIMIT 1
    `,
  });

  const findInteraction = SqlSchema.findOneOption({
    Request: PendingInteractionLookup,
    Result: InteractionDbRow,
    execute: ({ threadId, requestId }) => sql`
      SELECT
        thread_id AS "threadId",
        request_id AS "requestId",
        kind,
        status,
        summary,
        can_approve AS "canApprove",
        questions_json AS "questions",
        response_action AS "responseAction",
        response_command_id AS "responseCommandId",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        resolved_at AS "resolvedAt"
      FROM pending_interactions
      WHERE thread_id = ${threadId} AND request_id = ${requestId}
      LIMIT 1
    `,
  });

  const insertInteraction = SqlSchema.void({
    Request: InteractionRecord,
    execute: (interaction) => sql`
      INSERT INTO pending_interactions (
        thread_id,
        request_id,
        kind,
        status,
        summary,
        can_approve,
        questions_json,
        response_action,
        response_command_id,
        created_at,
        updated_at,
        resolved_at
      ) VALUES (
        ${interaction.threadId},
        ${interaction.requestId},
        ${interaction.kind},
        ${interaction.status},
        ${interaction.summary},
        ${interaction.canApprove ? 1 : 0},
        ${JSON.stringify(interaction.questions)},
        ${interaction.responseAction},
        ${interaction.responseCommandId},
        ${interaction.createdAt},
        ${interaction.updatedAt},
        ${interaction.resolvedAt}
      )
      ON CONFLICT DO NOTHING
    `,
  });

  const insertResponse = SqlSchema.findOneOption({
    Request: ResponseRecord,
    Result: ResponseDbRow,
    execute: (response) => sql`
      INSERT INTO pending_interaction_responses (
        auth_session_id,
        idempotency_key,
        thread_id,
        request_id,
        action,
        semantic_hash,
        command_id,
        command_created_at,
        dispatched_at
      ) VALUES (
        ${response.authSessionId},
        ${response.idempotencyKey},
        ${response.threadId},
        ${response.requestId},
        ${response.action},
        ${response.semanticHash},
        ${response.commandId},
        ${response.commandCreatedAt},
        ${response.dispatchedAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING
        auth_session_id AS "authSessionId",
        idempotency_key AS "idempotencyKey",
        thread_id AS "threadId",
        request_id AS "requestId",
        action,
        semantic_hash AS "semanticHash",
        command_id AS "commandId",
        command_created_at AS "commandCreatedAt",
        dispatched_at AS "dispatchedAt"
    `,
  });

  const getByKey: PendingInteractionResponseRepositoryShape["getByKey"] = (input) =>
    findResponseByKey(input).pipe(
      Effect.mapError(
        mapRepositoryError(
          "PendingInteractionResponseRepository.getByKey:query",
          "PendingInteractionResponseRepository.getByKey:decode",
        ),
      ),
    );

  const getInteraction: PendingInteractionResponseRepositoryShape["getInteraction"] = (input) =>
    findInteraction(input).pipe(
      Effect.map(Option.map(toInteractionRecord)),
      Effect.mapError(
        mapRepositoryError(
          "PendingInteractionResponseRepository.getInteraction:query",
          "PendingInteractionResponseRepository.getInteraction:decode",
        ),
      ),
    );

  const claim: PendingInteractionResponseRepositoryShape["claim"] = ({ interaction, response }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* findResponseByKey({
            authSessionId: response.authSessionId,
            idempotencyKey: response.idempotencyKey,
          });
          if (Option.isSome(existing)) {
            const sameRequest =
              existing.value.threadId === response.threadId &&
              existing.value.requestId === response.requestId &&
              existing.value.action === response.action &&
              existing.value.semanticHash === response.semanticHash;
            return sameRequest
              ? ({ _tag: "Existing", response: existing.value } as const)
              : yield* new ClaimConflict();
          }

          if (
            interaction.threadId !== response.threadId ||
            interaction.requestId !== response.requestId ||
            interaction.status !== "pending" ||
            response.dispatchedAt !== null
          ) {
            return yield* new ClaimConflict();
          }

          const existingInteraction = yield* findInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          });
          if (Option.isSome(existingInteraction)) {
            return yield* new ClaimConflict();
          }

          yield* insertInteraction(interaction);
          const inserted = yield* insertResponse(response);
          if (Option.isSome(inserted)) {
            return { _tag: "Acquired", response: inserted.value } as const;
          }

          // A concurrent claim can win after the initial key lookup. A
          // matching committed row is a replay; every other unique conflict
          // belongs to a different claim and is deliberately opaque.
          const raced = yield* findResponseByKey({
            authSessionId: response.authSessionId,
            idempotencyKey: response.idempotencyKey,
          });
          if (
            Option.isSome(raced) &&
            raced.value.threadId === response.threadId &&
            raced.value.requestId === response.requestId &&
            raced.value.action === response.action &&
            raced.value.semanticHash === response.semanticHash
          ) {
            return { _tag: "Existing", response: raced.value } as const;
          }

          return yield* new ClaimConflict();
        }),
      )
      .pipe(
        Effect.catchTags({
          PendingInteractionResponseClaimConflict: () =>
            Effect.succeed({ _tag: "Conflict" } as const),
        }),
        Effect.mapError(
          mapRepositoryError(
            "PendingInteractionResponseRepository.claim:query",
            "PendingInteractionResponseRepository.claim:decode",
          ),
        ),
      );

  const markDispatched: PendingInteractionResponseRepositoryShape["markDispatched"] = (input) =>
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
                  SELECT action
                  FROM pending_interaction_responses
                  WHERE auth_session_id = ${input.authSessionId}
                    AND idempotency_key = ${input.idempotencyKey}
                    AND command_id = ${input.commandId}
                ),
                response_command_id = ${input.commandId},
                updated_at = ${input.dispatchedAt}
            WHERE (thread_id, request_id) = (
              SELECT thread_id, request_id
              FROM pending_interaction_responses
              WHERE auth_session_id = ${input.authSessionId}
                AND idempotency_key = ${input.idempotencyKey}
                AND command_id = ${input.commandId}
            )
              AND status = 'pending'
          `;
        }),
      )
      .pipe(
        Effect.mapError(
          mapRepositoryError(
            "PendingInteractionResponseRepository.markDispatched:query",
            "PendingInteractionResponseRepository.markDispatched:decode",
          ),
        ),
      );

  return PendingInteractionResponseRepository.of({
    getByKey,
    getInteraction,
    claim,
    markDispatched,
  });
});

export const PendingInteractionResponseRepositoryLive = Layer.effect(
  PendingInteractionResponseRepository,
  makePendingInteractionResponseRepository,
);
