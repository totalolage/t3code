import {
  ApprovalRequestId,
  AuthSessionId,
  CommandId,
  IsoDateTime,
  RemoteInteractionIdempotencyKey,
  RemotePendingInteractionAction,
  RemotePendingInteractionQuestion,
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

export const PendingInteractionRow = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  kind: PendingInteractionKind,
  status: PendingInteractionStatus,
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  canApprove: Schema.Boolean,
  questions: Schema.Array(RemotePendingInteractionQuestion),
  responseAction: Schema.NullOr(RemotePendingInteractionAction),
  responseCommandId: Schema.NullOr(CommandId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type PendingInteractionRow = typeof PendingInteractionRow.Type;

export interface PendingInteractionClaimInput {
  readonly authSessionId: AuthSessionId;
  readonly idempotencyKey: RemoteInteractionIdempotencyKey;
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly action: RemotePendingInteractionAction;
  readonly semanticHash: string;
  readonly commandId: CommandId;
  readonly commandCreatedAt: string;
}

export type PendingInteractionClaimResult =
  | {
      readonly _tag: "claimed";
      readonly commandId: CommandId;
      readonly commandCreatedAt: string;
      readonly dispatchAccepted: false;
    }
  | {
      readonly _tag: "replayed";
      readonly commandId: CommandId;
      readonly commandCreatedAt: string;
      readonly dispatchAccepted: boolean;
    }
  | { readonly _tag: "conflict" }
  | { readonly _tag: "unavailable" };

export interface PendingInteractionRepositoryShape {
  readonly upsertOpened: (
    row: PendingInteractionRow,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listOpen: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<ReadonlyArray<PendingInteractionRow>, ProjectionRepositoryError>;
  readonly get: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
  }) => Effect.Effect<Option.Option<PendingInteractionRow>, ProjectionRepositoryError>;
  readonly markResponding: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly action: RemotePendingInteractionAction;
    readonly commandId: CommandId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly resolve: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markThreadStale: (input: {
    readonly threadId: ThreadId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markStale: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly claimResponse: (
    input: PendingInteractionClaimInput,
  ) => Effect.Effect<PendingInteractionClaimResult, ProjectionRepositoryError>;
  readonly markDispatchAccepted: (input: {
    readonly authSessionId: AuthSessionId;
    readonly idempotencyKey: RemoteInteractionIdempotencyKey;
    readonly commandId: CommandId;
    readonly dispatchedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class PendingInteractionRepository extends Context.Service<
  PendingInteractionRepository,
  PendingInteractionRepositoryShape
>()("t3/persistence/Services/PendingInteractions/PendingInteractionRepository") {}
