import {
  AuthSessionId,
  CommandId,
  IsoDateTime,
  REMOTE_INTERACTION_OPTION_MAX_COUNT,
  REMOTE_INTERACTION_QUESTION_MAX_COUNT,
  RemoteInteractionIdempotencyKey,
  RemotePendingInteractionAction,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const PendingInteractionKind = Schema.Literals(["approval", "user-input"]);
export type PendingInteractionKind = typeof PendingInteractionKind.Type;

export const PendingInteractionStatus = Schema.Literals([
  "pending",
  "responding",
  "resolved",
  "stale",
]);
export type PendingInteractionStatus = typeof PendingInteractionStatus.Type;

/**
 * The provider-facing fields are retained in the archival snapshot because
 * answer normalization uses them when a remote response is retried.
 */
export const PendingInteractionQuestion = Schema.Struct({
  id: Schema.String,
  providerQuestionId: Schema.optionalKey(Schema.String),
  header: Schema.String,
  prompt: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      description: Schema.String,
      providerValue: Schema.optionalKey(Schema.String),
    }),
  ).check(Schema.isMaxLength(REMOTE_INTERACTION_OPTION_MAX_COUNT)),
  multiSelect: Schema.Boolean,
  allowsCustomAnswer: Schema.Boolean,
});
export type PendingInteractionQuestion = typeof PendingInteractionQuestion.Type;

export const InteractionRecord = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  kind: PendingInteractionKind,
  status: PendingInteractionStatus,
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  canApprove: Schema.Boolean,
  questions: Schema.Array(PendingInteractionQuestion).check(
    Schema.isMaxLength(REMOTE_INTERACTION_QUESTION_MAX_COUNT),
  ),
  responseAction: Schema.NullOr(RemotePendingInteractionAction),
  responseCommandId: Schema.NullOr(CommandId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type InteractionRecord = typeof InteractionRecord.Type;

export const ResponseRecord = Schema.Struct({
  authSessionId: AuthSessionId,
  idempotencyKey: RemoteInteractionIdempotencyKey,
  threadId: ThreadId,
  requestId: RuntimeRequestId,
  action: RemotePendingInteractionAction,
  semanticHash: Schema.String,
  commandId: CommandId,
  commandCreatedAt: IsoDateTime,
  dispatchedAt: Schema.NullOr(IsoDateTime),
});
export type ResponseRecord = typeof ResponseRecord.Type;

export const PendingInteractionResponseKey = Schema.Struct({
  authSessionId: AuthSessionId,
  idempotencyKey: RemoteInteractionIdempotencyKey,
});
export type PendingInteractionResponseKey = typeof PendingInteractionResponseKey.Type;

export const PendingInteractionLookup = Schema.Struct({
  threadId: ThreadId,
  requestId: RuntimeRequestId,
});
export type PendingInteractionLookup = typeof PendingInteractionLookup.Type;

export const PendingInteractionResponseClaimInput = Schema.Struct({
  interaction: InteractionRecord,
  response: ResponseRecord,
});
export type PendingInteractionResponseClaimInput = typeof PendingInteractionResponseClaimInput.Type;

export const PendingInteractionResponseMarkDispatchedInput = Schema.Struct({
  authSessionId: AuthSessionId,
  idempotencyKey: RemoteInteractionIdempotencyKey,
  commandId: CommandId,
  dispatchedAt: IsoDateTime,
});
export type PendingInteractionResponseMarkDispatchedInput =
  typeof PendingInteractionResponseMarkDispatchedInput.Type;

export type PendingInteractionResponseClaimResult =
  | { readonly _tag: "Acquired"; readonly response: ResponseRecord }
  | { readonly _tag: "Existing"; readonly response: ResponseRecord }
  | { readonly _tag: "Conflict" };

export type PendingInteractionResponseRepositoryError = ProjectionRepositoryError;

export interface PendingInteractionResponseRepositoryShape {
  readonly getByKey: (
    input: PendingInteractionResponseKey,
  ) => Effect.Effect<Option.Option<ResponseRecord>, PendingInteractionResponseRepositoryError>;
  readonly getInteraction: (
    input: PendingInteractionLookup,
  ) => Effect.Effect<Option.Option<InteractionRecord>, PendingInteractionResponseRepositoryError>;
  readonly claim: (
    input: PendingInteractionResponseClaimInput,
  ) => Effect.Effect<
    PendingInteractionResponseClaimResult,
    PendingInteractionResponseRepositoryError
  >;
  readonly markDispatched: (
    input: PendingInteractionResponseMarkDispatchedInput,
  ) => Effect.Effect<void, PendingInteractionResponseRepositoryError>;
}

export class PendingInteractionResponseRepository extends Context.Service<
  PendingInteractionResponseRepository,
  PendingInteractionResponseRepositoryShape
>()("t3/persistence/Services/PendingInteractionResponses/PendingInteractionResponseRepository") {}
