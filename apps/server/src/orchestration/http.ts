import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentInternalError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import {
  isExpectedClientDispatchError,
  make as makeOrchestrationCommandDispatcher,
} from "./Services/OrchestrationCommandDispatcher.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  listRemotePendingInteractions,
  respondToRemotePendingInteraction,
} from "./PendingInteractionService.ts";

const failEnvironmentDispatch = (
  cause: unknown,
): Effect.Effect<never, EnvironmentInternalError | EnvironmentRequestInvalidError, never> =>
  isExpectedClientDispatchError(cause)
    ? failEnvironmentInvalidRequest("invalid_command", cause)
    : failEnvironmentInternal("orchestration_dispatch_failed", cause);

const failPendingInteractionResponse = (
  cause: unknown,
): Effect.Effect<
  never,
  EnvironmentInternalError | EnvironmentRequestInvalidError | EnvironmentResourceNotFoundError,
  never
> => {
  const tag =
    typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined;
  if (tag === "PendingInteractionUnavailableError") {
    return failEnvironmentNotFound("pending_interaction_not_found");
  }
  if (tag === "PendingInteractionInvalidResponseError") {
    return failEnvironmentInvalidRequest("invalid_interaction");
  }
  // The public error and the server log stay generic: persistence, provider,
  // and validation causes can carry sensitive local context.
  return failEnvironmentInternal("pending_interaction_response_failed");
};

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationCommandDispatcher = yield* makeOrchestrationCommandDispatcher;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return snapshot.value;
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (
            args.payload.type === "thread.approval.respond" ||
            args.payload.type === "thread.user-input.respond"
          ) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch((cause) => failEnvironmentInvalidRequest("invalid_command", cause)),
          );
          return yield* orchestrationCommandDispatcher
            .dispatch(normalizedCommand)
            .pipe(Effect.catch(failEnvironmentDispatch));
        }),
      )
      .handle(
        "pendingInteractions",
        Effect.fn("environment.orchestration.pendingInteractions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* listRemotePendingInteractions(
            args.query.threadId === undefined ? {} : { threadId: args.query.threadId },
          ).pipe(Effect.catch(() => failEnvironmentInternal("pending_interactions_read_failed")));
        }),
      )
      .handle(
        "answerPendingInteraction",
        Effect.fn("environment.orchestration.answerPendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* respondToRemotePendingInteraction({
            authSessionId: principal.sessionId,
            threadId: args.payload.threadId,
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: "answer",
            answers: args.payload.answers,
            dispatcher: orchestrationCommandDispatcher,
          }).pipe(Effect.catch(failPendingInteractionResponse));
        }),
      )
      .handle(
        "approvePendingInteraction",
        Effect.fn("environment.orchestration.approvePendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* respondToRemotePendingInteraction({
            authSessionId: principal.sessionId,
            threadId: args.payload.threadId,
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: "approve",
            dispatcher: orchestrationCommandDispatcher,
          }).pipe(Effect.catch(failPendingInteractionResponse));
        }),
      )
      .handle(
        "rejectPendingInteraction",
        Effect.fn("environment.orchestration.rejectPendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* respondToRemotePendingInteraction({
            authSessionId: principal.sessionId,
            threadId: args.payload.threadId,
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: args.payload.decision,
            dispatcher: orchestrationCommandDispatcher,
          }).pipe(Effect.catch(failPendingInteractionResponse));
        }),
      );
  }),
);
