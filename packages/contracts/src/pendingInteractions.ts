import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const REMOTE_INTERACTION_ID_MAX_CHARS = 128;
export const REMOTE_INTERACTION_IDEMPOTENCY_KEY_MAX_CHARS = 128;
export const REMOTE_INTERACTION_QUESTION_MAX_COUNT = 3;
export const REMOTE_INTERACTION_OPTION_MAX_COUNT = 3;
export const REMOTE_INTERACTION_ANSWER_VALUE_MAX_CHARS = 1_024;
export const REMOTE_PENDING_INTERACTION_MAX_COUNT = 100;

const OpaqueRemoteIdString = TrimmedNonEmptyString.check(
  Schema.isMaxLength(REMOTE_INTERACTION_ID_MAX_CHARS),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);

export const RemoteInteractionThreadId = OpaqueRemoteIdString.pipe(Schema.brand("ThreadId"));
export type RemoteInteractionThreadId = typeof RemoteInteractionThreadId.Type;

export const RemoteInteractionRequestId = OpaqueRemoteIdString.pipe(
  Schema.brand("ApprovalRequestId"),
);
export type RemoteInteractionRequestId = typeof RemoteInteractionRequestId.Type;

export const RemoteInteractionIdempotencyKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(REMOTE_INTERACTION_IDEMPOTENCY_KEY_MAX_CHARS),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
export type RemoteInteractionIdempotencyKey = typeof RemoteInteractionIdempotencyKey.Type;

const RemoteInteractionDisplayText = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
const RemoteInteractionHeader = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const RemoteInteractionOptionText = TrimmedNonEmptyString.check(Schema.isMaxLength(160));

/**
 * Public remote interaction documents fail on unknown fields. Effect structs
 * normally discard excess properties, which is useful for internal evolution
 * but unsafe for this write boundary: a misspelled answer field must never be
 * silently ignored before dispatch.
 */
function strictPublicSchema<S extends Schema.Top>(schema: S) {
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      schema,
      SchemaTransformation.transformOrFail({
        decode: (input) =>
          Schema.decodeUnknownEffect(schema, {
            errors: "all",
            onExcessProperty: "error",
          })(input).pipe(Effect.mapError((error) => error.issue)),
        encode: Effect.succeed,
      }),
    ),
  );
}

export const RemotePendingInteractionStatus = Schema.Literals(["pending", "responding"]);
export type RemotePendingInteractionStatus = typeof RemotePendingInteractionStatus.Type;

export const RemotePendingInteractionAction = Schema.Literals([
  "answer",
  "approve",
  "decline",
  "cancel",
]);
export type RemotePendingInteractionAction = typeof RemotePendingInteractionAction.Type;

export const RemotePendingInteractionOption = Schema.Struct({
  label: RemoteInteractionOptionText,
  description: RemoteInteractionOptionText,
});
export type RemotePendingInteractionOption = typeof RemotePendingInteractionOption.Type;

export const RemotePendingInteractionQuestion = Schema.Struct({
  id: OpaqueRemoteIdString,
  header: RemoteInteractionHeader,
  prompt: RemoteInteractionDisplayText,
  options: Schema.Array(RemotePendingInteractionOption).check(
    Schema.isMaxLength(REMOTE_INTERACTION_OPTION_MAX_COUNT),
  ),
  multiSelect: Schema.Boolean,
  allowsCustomAnswer: Schema.Boolean,
});
export type RemotePendingInteractionQuestion = typeof RemotePendingInteractionQuestion.Type;

const RemotePendingInteractionBase = {
  threadId: RemoteInteractionThreadId,
  requestId: RemoteInteractionRequestId,
  status: RemotePendingInteractionStatus,
  summary: RemoteInteractionDisplayText,
  canApprove: Schema.Boolean,
  allowedActions: Schema.Array(RemotePendingInteractionAction).check(Schema.isMaxLength(3)),
  questions: Schema.Array(RemotePendingInteractionQuestion).check(
    Schema.isMaxLength(REMOTE_INTERACTION_QUESTION_MAX_COUNT),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
} as const;

export const RemotePendingInteraction = strictPublicSchema(
  Schema.Union([
    Schema.Struct({
      ...RemotePendingInteractionBase,
      kind: Schema.Literal("approval"),
    }),
    Schema.Struct({
      ...RemotePendingInteractionBase,
      kind: Schema.Literal("user-input"),
    }),
  ]),
);
export type RemotePendingInteraction = typeof RemotePendingInteraction.Type;

export const RemotePendingInteractionsResult = strictPublicSchema(
  Schema.Struct({
    interactions: Schema.Array(RemotePendingInteraction).check(
      Schema.isMaxLength(REMOTE_PENDING_INTERACTION_MAX_COUNT),
    ),
  }),
);
export type RemotePendingInteractionsResult = typeof RemotePendingInteractionsResult.Type;

export const RemotePendingInteractionsQuery = strictPublicSchema(
  Schema.Struct({
    threadId: Schema.optionalKey(RemoteInteractionThreadId),
  }),
);
export type RemotePendingInteractionsQuery = typeof RemotePendingInteractionsQuery.Type;

export const RemoteInteractionAnswerValue = TrimmedNonEmptyString.check(
  Schema.isMaxLength(REMOTE_INTERACTION_ANSWER_VALUE_MAX_CHARS),
);

export const RemoteInteractionAnswer = Schema.Struct({
  questionId: OpaqueRemoteIdString,
  values: Schema.Array(RemoteInteractionAnswerValue).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(REMOTE_INTERACTION_OPTION_MAX_COUNT + 1),
  ),
});
export type RemoteInteractionAnswer = typeof RemoteInteractionAnswer.Type;

const RemoteInteractionResponseBase = {
  threadId: RemoteInteractionThreadId,
  requestId: RemoteInteractionRequestId,
  idempotencyKey: RemoteInteractionIdempotencyKey,
} as const;

export const RemoteInteractionAnswerRequest = strictPublicSchema(
  Schema.Struct({
    ...RemoteInteractionResponseBase,
    answers: Schema.Array(RemoteInteractionAnswer).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(REMOTE_INTERACTION_QUESTION_MAX_COUNT),
    ),
  }),
);
export type RemoteInteractionAnswerRequest = typeof RemoteInteractionAnswerRequest.Type;

export const RemoteInteractionApproveRequest = strictPublicSchema(
  Schema.Struct(RemoteInteractionResponseBase),
);
export type RemoteInteractionApproveRequest = typeof RemoteInteractionApproveRequest.Type;

export const RemoteInteractionRejectRequest = strictPublicSchema(
  Schema.Struct({
    ...RemoteInteractionResponseBase,
    decision: Schema.Literals(["decline", "cancel"]),
  }),
);
export type RemoteInteractionRejectRequest = typeof RemoteInteractionRejectRequest.Type;

export const RemoteInteractionResponseResult = strictPublicSchema(
  Schema.Struct({
    threadId: RemoteInteractionThreadId,
    requestId: RemoteInteractionRequestId,
    status: Schema.Literal("responding"),
    action: RemotePendingInteractionAction,
    idempotencyKey: RemoteInteractionIdempotencyKey,
    replayed: Schema.Boolean,
  }),
);
export type RemoteInteractionResponseResult = typeof RemoteInteractionResponseResult.Type;
