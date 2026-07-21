import {
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ClientOrchestrationCommand,
  type CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type DispatchResult,
  EnvironmentInternalError,
  MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationThreadDetailSnapshot,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "@t3tools/client-runtime/authorization";
import { remoteThreadContainsCommand } from "@t3tools/client-runtime/operations";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);

export function remoteSessionHasScopes(
  session: AuthSessionState,
  requiredScopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean {
  if (!session.authenticated) {
    return false;
  }
  const grantedScopes = new Set(session.scopes ?? []);
  return requiredScopes.every((scope) => grantedScopes.has(scope));
}

export interface RemoteDispatchResolution extends DispatchResult {
  readonly recovered: boolean;
}

export class RemoteCliAmbiguousDispatchError extends Schema.TaggedErrorClass<RemoteCliAmbiguousDispatchError>()(
  "RemoteCliAmbiguousDispatchError",
  {
    commandId: Schema.String,
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Remote dispatch ${this.commandId} has an ambiguous outcome; inspect thread ${this.threadId} before retrying.`;
  }
}

export function isAmbiguousRemoteDispatchError(error: unknown): boolean {
  return (
    error instanceof RemoteEnvironmentAuthFetchError ||
    error instanceof RemoteEnvironmentAuthInvalidJsonError ||
    error instanceof RemoteEnvironmentAuthTimeoutError ||
    error instanceof RemoteEnvironmentAuthUndeclaredStatusError ||
    isEnvironmentInternalError(error)
  );
}

export function makeRemoteSendCommand(input: {
  readonly snapshot: OrchestrationThreadDetailSnapshot;
  readonly commandId: CommandId;
  readonly message: string;
  readonly createdAt: string;
}): Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> {
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.snapshot.thread.id,
    message: {
      messageId: MessageId.make(input.commandId),
      role: "user",
      text: input.message,
      attachments: [],
    },
    runtimeMode: input.snapshot.thread.runtimeMode,
    interactionMode: input.snapshot.thread.interactionMode,
    createdAt: input.createdAt,
  };
}

export function makeRemoteCreateCommand(input: {
  readonly project: OrchestrationProjectShell;
  readonly modelSelection: ModelSelection;
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly message: string;
  readonly title: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly createdAt: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly startFromOrigin?: boolean;
}): Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }> {
  const runtimeMode = input.runtimeMode ?? DEFAULT_RUNTIME_MODE;
  const interactionMode = input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.threadId,
    message: {
      messageId: MessageId.make(input.commandId),
      role: "user",
      text: input.message,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: input.title,
    runtimeMode,
    interactionMode,
    bootstrap: {
      createThread: {
        projectId: input.project.id,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode,
        interactionMode,
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      },
      prepareWorktree: {
        projectCwd: input.project.workspaceRoot,
        baseBranch: input.baseBranch,
        branch: input.branch,
        ...(input.startFromOrigin === undefined ? {} : { startFromOrigin: input.startFromOrigin }),
      },
      runSetupScript: input.project.scripts.some((script) => script.runOnWorktreeCreate),
    },
    createdAt: input.createdAt,
  };
}

export const dispatchRemoteCommandSafely = Effect.fn("remoteCli.dispatchSafely")(function* <
  E,
  R,
  ReadError,
  ReadContext,
>(input: {
  readonly command: Extract<ClientOrchestrationCommand, { type: "thread.turn.start" }>;
  readonly dispatch: Effect.Effect<DispatchResult, E, R>;
  readonly readThread: Effect.Effect<
    Option.Option<OrchestrationThreadDetailSnapshot>,
    ReadError,
    ReadContext
  >;
  readonly retryDispatch: Effect.Effect<DispatchResult, E, R>;
}): Effect.fn.Return<
  RemoteDispatchResolution,
  E | RemoteCliAmbiguousDispatchError,
  R | ReadContext
> {
  const first = yield* Effect.exit(input.dispatch);
  if (Exit.isSuccess(first)) {
    return { ...first.value, recovered: false };
  }
  const initialError = first.cause.reasons.find((reason) => reason._tag === "Fail");
  if (initialError?.error !== undefined && !isAmbiguousRemoteDispatchError(initialError.error)) {
    return yield* Effect.failCause(first.cause);
  }

  const observedBeforeRetry = yield* input.readThread.pipe(Effect.option);
  if (Option.isNone(observedBeforeRetry)) {
    return yield* new RemoteCliAmbiguousDispatchError({
      commandId: input.command.commandId,
      threadId: input.command.threadId,
    });
  }
  if (
    Option.isSome(observedBeforeRetry.value) &&
    remoteThreadContainsCommand(observedBeforeRetry.value.value, input.command.commandId)
  ) {
    return {
      sequence: observedBeforeRetry.value.value.snapshotSequence,
      recovered: true,
    };
  }

  const retried = yield* Effect.exit(input.retryDispatch);
  if (Exit.isSuccess(retried)) {
    return { ...retried.value, recovered: false };
  }
  const observedAfterRetry = yield* input.readThread.pipe(Effect.option);
  if (
    Option.isSome(observedAfterRetry) &&
    Option.isSome(observedAfterRetry.value) &&
    remoteThreadContainsCommand(observedAfterRetry.value.value, input.command.commandId)
  ) {
    return {
      sequence: observedAfterRetry.value.value.snapshotSequence,
      recovered: true,
    };
  }
  return yield* new RemoteCliAmbiguousDispatchError({
    commandId: input.command.commandId,
    threadId: input.command.threadId,
  });
});
