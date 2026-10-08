import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentHttpCommonError,
  RemoteInteractionAnswer,
  RemoteInteractionRequestId,
  RemoteInteractionThreadId,
  RemotePendingInteractionsQuery,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import { FetchHttpClient, HttpClient } from "effect/http";

import {
  authenticateRemoteCli,
  resolveAuthenticatedCliTarget,
  type AuthenticatedCliTarget,
} from "./remoteAuth.ts";
import { formatRemoteCliError, RemoteCliError } from "./remoteHttp.ts";
import { layer as remoteLocalAuthLayer } from "./remoteLocalAuth.ts";
import {
  answerPendingInteraction,
  approvePendingInteraction,
  compactThread,
  createThread,
  listPendingInteractions,
  readOrchestrationShell,
  readOrchestrationSnapshot,
  readOrchestrationThread,
  rejectPendingInteraction,
  sendThreadMessage,
} from "./remoteOperations.ts";
import { resolveCliTarget, type ResolveCliTargetInput } from "./remoteTarget.ts";
import { watchFlags } from "./remoteWatchCommand.ts";
import {
  RemoteWatchFailure,
  watchRemoteThread,
  type RemoteWatchInteractionRequiredError,
  type RemoteWatchNoTurnError,
  type RemoteWatchTerminalWithoutMessageError,
  type RemoteWatchTimeoutError,
} from "./remoteWatch.ts";
import { makeRemoteWatchTransport } from "./remoteWatchTransport.ts";

/**
 * Platform services for remote CLI handlers. These are functions, not module
 * values, so no layer is built or provided at module evaluation time: help
 * rendering and version printing never construct network or filesystem stack.
 */
const remoteCliNetworkLayer = () =>
  Layer.mergeAll(FetchHttpClient.layer, NodeSocket.layerWebSocketConstructor).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

/** Adds the guarded local issuance seam on top of the network services. */
const remoteCliAuthLayer = () =>
  Layer.mergeAll(FetchHttpClient.layer, remoteLocalAuthLayer).pipe(
    Layer.provideMerge(NodeServices.layer),
  );

const prettyJson = (value: unknown): string =>
  // CLI output is a sanitized presentation DTO, not a schema round-trip.
  JSON.stringify(value, null, 2);

/**
 * Fails the command with the sanitized remote error JSON as the user-facing
 * message. The CLI runner renders this exactly once on stderr and exits
 * nonzero; nothing raw from the transport ever reaches the terminal.
 */
const failWithSanitizedRemoteError = (error: unknown) =>
  Effect.fail(
    new CliError.UserError({
      cause: prettyJson(formatRemoteCliError(error)),
      userMessage: prettyJson(formatRemoteCliError(error)),
    }),
  );

const withSanitizedRemoteErrors = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, CliError.UserError, R> =>
  effect.pipe(Effect.catch((error) => failWithSanitizedRemoteError(error)));

type WatchFailure =
  | RemoteWatchNoTurnError
  | RemoteWatchTerminalWithoutMessageError
  | RemoteWatchTimeoutError
  | RemoteWatchFailure
  | RemoteWatchInteractionRequiredError;

/**
 * Server thread/turn ids are only guaranteed trimmed non-empty strings, so a
 * hostile or oversized id is dropped from output instead of echoed. The same
 * bounded safe-identifier discipline as formatRemoteCliError applies: id-shaped,
 * printable, length-bounded.
 */
const SAFE_WATCH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const safeWatchIdentifier = (value: string): string | undefined =>
  SAFE_WATCH_IDENTIFIER.test(value) ? value : undefined;

/**
 * One sanitized JSON line per watch failure. Only bounded, typed fields are
 * copied; ids that fail the safe-identifier check, raw causes, tokens,
 * tickets, and URLs never reach the terminal.
 */
export const renderWatchError = (error: WatchFailure): string => {
  switch (error._tag) {
    case "RemoteWatchNoTurnError": {
      const threadId = safeWatchIdentifier(error.threadId);
      return JSON.stringify({
        error: { code: "watch-no-turn", ...(threadId === undefined ? {} : { threadId }) },
      });
    }
    case "RemoteWatchTimeoutError": {
      const threadId = safeWatchIdentifier(error.threadId);
      return JSON.stringify({
        error: {
          code: "watch-timeout",
          ...(threadId === undefined ? {} : { threadId }),
          timeoutMs: error.timeoutMs,
        },
      });
    }
    case "RemoteWatchTerminalWithoutMessageError": {
      const threadId = safeWatchIdentifier(error.threadId);
      const turnId = safeWatchIdentifier(error.turnId);
      return JSON.stringify({
        error: {
          code: "watch-terminal-without-message",
          ...(threadId === undefined ? {} : { threadId }),
          ...(turnId === undefined ? {} : { turnId }),
          status: error.status,
        },
      });
    }
    case "RemoteWatchInteractionRequiredError": {
      // Built here from sanitized pieces: formatRemoteWatchInteractionResult
      // would echo the raw ids verbatim.
      const threadId = safeWatchIdentifier(error.threadId);
      const turnId = safeWatchIdentifier(error.turnId);
      return JSON.stringify({
        ...(threadId === undefined ? {} : { threadId }),
        ...(turnId === undefined ? {} : { turnId }),
        interaction: error.interaction,
      });
    }
    case "RemoteWatchFailure":
      return JSON.stringify({
        error: {
          code: "watch-failure",
          kind: error.kind,
          ...(error.lastSequence === undefined ? {} : { lastSequence: error.lastSequence }),
          ...(error.observedRunning === undefined
            ? {}
            : { observedRunning: error.observedRunning }),
        },
      });
  }
};

/**
 * Watch failures carry their own exit codes (20-26), honored by the runtime
 * teardown. We render the single safe line ourselves and flag the error as
 * already reported so neither the CLI runner nor the logger prints a second
 * copy. InteractionRequired is born reported=false and prints its one-line
 * interaction JSON on stdout instead.
 */
const failRenderedWatch = (error: WatchFailure) =>
  Effect.gen(function* () {
    if (error._tag === "RemoteWatchInteractionRequiredError") {
      yield* Console.log(renderWatchError(error));
    } else {
      yield* Console.error(renderWatchError(error));
    }
    Object.assign(error, { [Runtime.errorReported]: false });
    return yield* Effect.fail(error);
  });

const hostFlag = Flag.String("host").pipe(Flag.withDescription("Remote T3 Code server URL."));

const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription("State directory for this T3 Code base."),
  Flag.optional,
);

const runRemoteEnvironment = (input: ResolveCliTargetInput) =>
  resolveCliTarget(input).pipe(
    Effect.flatMap((target) => Console.log(prettyJson(target.environment))),
    Effect.provide(remoteCliNetworkLayer()),
    withSanitizedRemoteErrors,
  );

const runRemoteAuth = (input: {
  readonly host: string;
  readonly baseDir?: string;
  readonly credential?: string;
}) =>
  Effect.gen(function* () {
    const target = yield* resolveCliTarget(input);
    const credential =
      input.credential ??
      Redacted.value(
        yield* Prompt.run(
          Prompt.Password({
            message: "Credential",
          }),
        ),
      );
    const result = yield* authenticateRemoteCli(target, credential);
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const runReadCommand = (
  input: ResolveCliTargetInput,
  read: (
    authenticated: AuthenticatedCliTarget,
  ) => Effect.Effect<unknown, RemoteCliError | EnvironmentHttpCommonError, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(target, AuthOrchestrationReadScope);
    yield* Console.log(prettyJson(yield* read(authenticated)));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const runSendThreadMessage = (
  input: ResolveCliTargetInput & {
    readonly threadId: string;
    readonly message: string;
    readonly idempotencyKey?: string;
  },
) =>
  Effect.gen(function* () {
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(
      target,
      AuthOrchestrationOperateScope,
    );
    const result = yield* sendThreadMessage(authenticated, {
      threadId: ThreadId.make(input.threadId),
      message: input.message,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const RemoteInteractionAnswersFromJson = Schema.fromJsonString(
  Schema.Array(RemoteInteractionAnswer),
);

const decodeInteractionThread = Schema.decodeUnknownSync(RemoteInteractionThreadId);
const decodeInteractionRequest = Schema.decodeUnknownSync(RemoteInteractionRequestId);
const decodeInteractionAnswersJson = Schema.decodeUnknownSync(RemoteInteractionAnswersFromJson);
const decodePendingInteractionsQuery = Schema.decodeUnknownSync(RemotePendingInteractionsQuery);

/**
 * Flag decoding runs inside the Effect so malformed input fails as a typed
 * invalid-input RemoteCliError and flows through the sanitized error boundary
 * instead of throwing outside it.
 */
const decodeInteractionIdsEffect = (threadId: string, requestId: string) =>
  Effect.try({
    try: () => ({
      threadId: decodeInteractionThread(threadId),
      requestId: decodeInteractionRequest(requestId),
    }),
    catch: () => new RemoteCliError({ reason: "invalid-input" }),
  });

const decodeAnswersEffect = (answers: string) =>
  Effect.try({
    try: () => decodeInteractionAnswersJson(answers),
    catch: () => new RemoteCliError({ reason: "invalid-input" }),
  });

const decodePendingQueryEffect = (threadId: string) =>
  Effect.try({
    try: () => decodePendingInteractionsQuery({ threadId }),
    catch: () => new RemoteCliError({ reason: "invalid-input" }),
  });

type OperateInput = ResolveCliTargetInput & { readonly idempotencyKey: string };

const runCreateThread = (
  input: OperateInput & {
    readonly project: string;
    readonly message: string;
    readonly title?: string;
    readonly branch?: string;
    readonly baseBranch?: string;
    readonly startFromOrigin?: boolean;
    readonly runtimeMode?: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
    readonly interactionMode?: "default" | "plan";
  },
) =>
  Effect.gen(function* () {
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(
      target,
      AuthOrchestrationOperateScope,
    );
    const result = yield* createThread(authenticated, {
      project: input.project,
      message: input.message,
      idempotencyKey: input.idempotencyKey,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
      ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
      ...(input.startFromOrigin === undefined ? {} : { startFromOrigin: input.startFromOrigin }),
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
    });
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const runCompactThread = (input: OperateInput & { readonly threadId: string }) =>
  Effect.gen(function* () {
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(
      target,
      AuthOrchestrationOperateScope,
    );
    const result = yield* compactThread(authenticated, {
      threadId: ThreadId.make(input.threadId),
      idempotencyKey: input.idempotencyKey,
    });
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const runPendingList = (input: ResolveCliTargetInput & { readonly threadId?: string }) =>
  Effect.gen(function* () {
    const query =
      input.threadId === undefined ? {} : yield* decodePendingQueryEffect(input.threadId);
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(target, AuthOrchestrationReadScope);
    const result = yield* listPendingInteractions(authenticated, query);
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const runPendingAnswer = (
  input: OperateInput & {
    readonly threadId: string;
    readonly requestId: string;
    readonly answers: string;
  },
) =>
  Effect.gen(function* () {
    const ids = yield* decodeInteractionIdsEffect(input.threadId, input.requestId);
    const answers = yield* decodeAnswersEffect(input.answers);
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(
      target,
      AuthOrchestrationOperateScope,
    );
    const result = yield* answerPendingInteraction(authenticated, {
      threadId: ids.threadId,
      requestId: ids.requestId,
      idempotencyKey: input.idempotencyKey,
      answers,
    });
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const runPendingApprove = (
  input: OperateInput & { readonly threadId: string; readonly requestId: string },
) =>
  Effect.gen(function* () {
    const ids = yield* decodeInteractionIdsEffect(input.threadId, input.requestId);
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(
      target,
      AuthOrchestrationOperateScope,
    );
    const result = yield* approvePendingInteraction(authenticated, {
      threadId: ids.threadId,
      requestId: ids.requestId,
      idempotencyKey: input.idempotencyKey,
    });
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const runPendingReject = (
  input: OperateInput & {
    readonly threadId: string;
    readonly requestId: string;
    readonly decision: "decline" | "cancel";
  },
) =>
  Effect.gen(function* () {
    const ids = yield* decodeInteractionIdsEffect(input.threadId, input.requestId);
    const target = yield* resolveCliTarget(input);
    const authenticated = yield* resolveAuthenticatedCliTarget(
      target,
      AuthOrchestrationOperateScope,
    );
    const result = yield* rejectPendingInteraction(authenticated, {
      threadId: ids.threadId,
      requestId: ids.requestId,
      idempotencyKey: input.idempotencyKey,
      decision: input.decision,
    });
    yield* Console.log(prettyJson(result));
  }).pipe(Effect.provide(remoteCliAuthLayer()), withSanitizedRemoteErrors);

const remoteHostFlags = {
  host: hostFlag,
  baseDir: baseDirFlag,
};

const baseDirInput = (baseDir: Option.Option<string>): ResolveCliTargetInput => {
  const value = Option.getOrUndefined(baseDir);
  return value === undefined ? {} : { baseDir: value };
};

const remoteEnvironmentCommand = Command.make("environment", remoteHostFlags).pipe(
  Command.withDescription("Print the target environment descriptor."),
  Command.withHandler((flags) =>
    runRemoteEnvironment({ host: flags.host, ...baseDirInput(flags.baseDir) }),
  ),
);

const remoteAuthCommand = Command.make("auth", {
  ...remoteHostFlags,
  credential: Flag.String("credential").pipe(
    Flag.withDescription("One-time credential; omit to be prompted without echo."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Exchange a one-time credential for a persisted CLI access token."),
  Command.withHandler((flags) =>
    runRemoteAuth({
      host: flags.host,
      ...baseDirInput(flags.baseDir),
      ...(Option.isSome(flags.credential) ? { credential: flags.credential.value } : {}),
    }),
  ),
);

const remoteSessionCommand = Command.make("session", remoteHostFlags).pipe(
  Command.withDescription("Print the authenticated CLI session state."),
  Command.withHandler((flags) =>
    runReadCommand({ host: flags.host, ...baseDirInput(flags.baseDir) }, (authenticated) =>
      Effect.succeed(authenticated.session),
    ),
  ),
);

const remoteShellCommand = Command.make("shell", remoteHostFlags).pipe(
  Command.withDescription("Print the lightweight orchestration shell snapshot."),
  Command.withHandler((flags) =>
    runReadCommand({ host: flags.host, ...baseDirInput(flags.baseDir) }, readOrchestrationShell),
  ),
);

const remoteSnapshotCommand = Command.make("snapshot", remoteHostFlags).pipe(
  Command.withDescription("Print the full orchestration read model."),
  Command.withHandler((flags) =>
    runReadCommand({ host: flags.host, ...baseDirInput(flags.baseDir) }, readOrchestrationSnapshot),
  ),
);

const remoteThreadCommand = Command.make("thread", {
  ...remoteHostFlags,
  threadId: Argument.String("thread-id"),
}).pipe(
  Command.withDescription("Print one thread's native detail snapshot."),
  Command.withHandler((flags) =>
    runReadCommand({ host: flags.host, ...baseDirInput(flags.baseDir) }, (authenticated) =>
      readOrchestrationThread(authenticated, ThreadId.make(flags.threadId)),
    ),
  ),
);

const remoteSendCommand = Command.make("send", {
  ...remoteHostFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm dispatching this message to the target thread."),
    Flag.withDefault(false),
  ),
  idempotencyKey: Flag.String("idempotency-key").pipe(
    Flag.withDescription("Retry-stable idempotency key (1-256 characters)."),
    Flag.optional,
  ),
  threadId: Argument.String("thread-id"),
  message: Argument.String("message"),
}).pipe(
  Command.withDescription("Send one user message to a thread and print the dispatch receipt."),
  Command.withHandler((flags) =>
    // The confirmation gate runs before any target resolution, authentication,
    // or network traffic: nothing else is invoked when --yes is absent.
    flags.yes
      ? runSendThreadMessage({
          host: flags.host,
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          message: flags.message,
          ...(Option.isSome(flags.idempotencyKey)
            ? { idempotencyKey: flags.idempotencyKey.value }
            : {}),
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const remoteWatchCommand = Command.make("watch", {
  ...watchFlags,
  host: hostFlag,
  baseDir: baseDirFlag,
  threadId: Argument.String("thread-id"),
}).pipe(
  Command.withDescription("Watch a thread until its turn settles, then print the assistant reply."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const target = yield* resolveCliTarget({
        host: flags.host,
        ...baseDirInput(flags.baseDir),
      }).pipe(Effect.catch(failWithSanitizedRemoteError), Effect.provide(remoteCliNetworkLayer()));
      const authenticated = yield* resolveAuthenticatedCliTarget(
        target,
        AuthOrchestrationReadScope,
      ).pipe(Effect.catch(failWithSanitizedRemoteError), Effect.provide(remoteCliAuthLayer()));
      const threadId = ThreadId.make(flags.threadId);
      const requestedTurn = Option.map(flags.turn, (turn) => RunId.make(turn));
      const transport = yield* makeRemoteWatchTransport({
        httpBaseUrl: target.httpBaseUrl,
        accessToken: authenticated.accessToken,
        threadId,
      }).pipe(
        Effect.mapError((): RemoteWatchFailure => new RemoteWatchFailure({ kind: "transport" })),
        Effect.catch(failRenderedWatch),
        Effect.provide(remoteCliNetworkLayer()),
      );

      const outcome = yield* watchRemoteThread({
        transport,
        threadId,
        ...(Option.isSome(requestedTurn) ? { requestedTurnId: requestedTurn.value } : {}),
        timeoutMs: Duration.toMillis(flags.timeout),
        interactionAware: flags.interactions,
      }).pipe(Effect.result);

      if (Result.isSuccess(outcome)) {
        yield* Console.log(
          flags.format === "json" ? prettyJson(outcome.success) : outcome.success.message.text,
        );
        return yield* Effect.void;
      }
      return yield* failRenderedWatch(outcome.failure);
    }),
  ),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDescription("Confirm this mutating operation against the target environment."),
  Flag.withDefault(false),
);

const idempotencyKeyFlag = Flag.String("idempotency-key").pipe(
  Flag.withDescription("Retry-stable idempotency key."),
);

const remoteCreateCommand = Command.make("create", {
  ...remoteHostFlags,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or workspace root for the new thread."),
  ),
  message: Argument.String("message"),
  title: Flag.String("title").pipe(Flag.withDescription("Optional thread title."), Flag.optional),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Optional branch for the new thread."),
    Flag.optional,
  ),
  baseBranch: Flag.String("base-branch").pipe(
    Flag.withDescription("Optional base branch when creating the branch."),
    Flag.optional,
  ),
  startFromOrigin: Flag.Boolean("start-from-origin").pipe(
    Flag.withDescription("Start the new branch from origin instead of the local head."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Create a thread on the server and print the create receipt."),
  Command.withHandler((flags) =>
    flags.yes
      ? runCreateThread({
          host: flags.host,
          ...baseDirInput(flags.baseDir),
          project: flags.project,
          message: flags.message,
          idempotencyKey: flags.idempotencyKey,
          ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
          ...(Option.isSome(flags.branch) ? { branch: flags.branch.value } : {}),
          ...(Option.isSome(flags.baseBranch) ? { baseBranch: flags.baseBranch.value } : {}),
          startFromOrigin: flags.startFromOrigin,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const remoteCompactCommand = Command.make("compact", {
  ...remoteHostFlags,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  threadId: Argument.String("thread-id"),
}).pipe(
  Command.withDescription("Request compaction of one thread and print the compact receipt."),
  Command.withHandler((flags) =>
    flags.yes
      ? runCompactThread({
          host: flags.host,
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          idempotencyKey: flags.idempotencyKey,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const pendingBaseFlags = {
  ...remoteHostFlags,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  threadId: Argument.String("thread-id"),
  requestId: Argument.String("request-id"),
};

const remotePendingAnswerCommand = Command.make("answer", {
  ...pendingBaseFlags,
  answers: Flag.String("answers").pipe(
    Flag.withDescription("Answers as a JSON array of {questionId, values}."),
  ),
}).pipe(
  Command.withDescription("Answer one pending user-input interaction."),
  Command.withHandler((flags) =>
    flags.yes
      ? runPendingAnswer({
          host: flags.host,
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          requestId: flags.requestId,
          idempotencyKey: flags.idempotencyKey,
          answers: flags.answers,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const remotePendingApproveCommand = Command.make("approve", pendingBaseFlags).pipe(
  Command.withDescription("Approve one pending approval interaction."),
  Command.withHandler((flags) =>
    flags.yes
      ? runPendingApprove({
          host: flags.host,
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          requestId: flags.requestId,
          idempotencyKey: flags.idempotencyKey,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const remotePendingRejectCommand = Command.make("reject", {
  ...pendingBaseFlags,
  decision: Flag.Literals("decision", ["decline", "cancel"]).pipe(
    Flag.withDescription("Reject by declining or cancelling the interaction."),
  ),
}).pipe(
  Command.withDescription("Decline or cancel one pending interaction."),
  Command.withHandler((flags) =>
    flags.yes
      ? runPendingReject({
          host: flags.host,
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          requestId: flags.requestId,
          idempotencyKey: flags.idempotencyKey,
          decision: flags.decision,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const pendingListWithThreadFlag = Command.make("list", {
  ...remoteHostFlags,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Optionally scope the list to one thread id."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List pending interactions, optionally scoped with --thread."),
  Command.withHandler((flags) =>
    runPendingList({
      host: flags.host,
      ...baseDirInput(flags.baseDir),
      ...(Option.isSome(flags.thread) ? { threadId: flags.thread.value } : {}),
    }),
  ),
);

const remotePendingCommand = Command.make("pending").pipe(
  Command.withDescription("Inspect and respond to pending interactions."),
  Command.withSubcommands([
    pendingListWithThreadFlag,
    remotePendingAnswerCommand,
    remotePendingApproveCommand,
    remotePendingRejectCommand,
  ]),
);

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Inspect and drive a T3 Code environment over HTTP."),
  Command.withSubcommands([
    remoteEnvironmentCommand,
    remoteAuthCommand,
    remoteSessionCommand,
    remoteShellCommand,
    remoteSnapshotCommand,
    remoteThreadCommand,
    remoteSendCommand,
    remoteCreateCommand,
    remoteCompactCommand,
    remotePendingCommand,
    remoteWatchCommand,
  ]),
);

/**
 * Local aliases for the same handlers with local discovery only (no --host).
 * The existing root commands are start, serve, app, pair, auth, project,
 * service, service-preflight, theme, triage, and connect; none of the alias
 * names collide, so they register as direct root subcommands instead of a
 * namespaced group.
 */
const localBaseFlags = {
  baseDir: baseDirFlag,
};

const localSessionCommand = Command.make("session", localBaseFlags).pipe(
  Command.withDescription("Print the authenticated local CLI session state."),
  Command.withHandler((flags) =>
    runReadCommand({ ...baseDirInput(flags.baseDir) }, (authenticated) =>
      Effect.succeed(authenticated.session),
    ),
  ),
);

const localShellCommand = Command.make("shell", localBaseFlags).pipe(
  Command.withDescription("Print the local lightweight orchestration shell snapshot."),
  Command.withHandler((flags) =>
    runReadCommand({ ...baseDirInput(flags.baseDir) }, readOrchestrationShell),
  ),
);

const localSnapshotCommand = Command.make("snapshot", localBaseFlags).pipe(
  Command.withDescription("Print the local full orchestration read model."),
  Command.withHandler((flags) =>
    runReadCommand({ ...baseDirInput(flags.baseDir) }, readOrchestrationSnapshot),
  ),
);

const localThreadCommand = Command.make("thread", {
  ...localBaseFlags,
  threadId: Argument.String("thread-id"),
}).pipe(
  Command.withDescription("Print one local thread's native detail snapshot."),
  Command.withHandler((flags) =>
    runReadCommand({ ...baseDirInput(flags.baseDir) }, (authenticated) =>
      readOrchestrationThread(authenticated, ThreadId.make(flags.threadId)),
    ),
  ),
);

const localSendCommand = Command.make("send", {
  ...localBaseFlags,
  yes: Flag.Boolean("yes").pipe(
    Flag.withDescription("Confirm dispatching this message to the target thread."),
    Flag.withDefault(false),
  ),
  idempotencyKey: Flag.String("idempotency-key").pipe(
    Flag.withDescription("Retry-stable idempotency key (1-256 characters)."),
    Flag.optional,
  ),
  threadId: Argument.String("thread-id"),
  message: Argument.String("message"),
}).pipe(
  Command.withDescription("Send one user message to a local thread and print the receipt."),
  Command.withHandler((flags) =>
    flags.yes
      ? runSendThreadMessage({
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          message: flags.message,
          ...(Option.isSome(flags.idempotencyKey)
            ? { idempotencyKey: flags.idempotencyKey.value }
            : {}),
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const localCreateCommand = Command.make("create", {
  ...localBaseFlags,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or workspace root for the new thread."),
  ),
  message: Argument.String("message"),
  title: Flag.String("title").pipe(Flag.withDescription("Optional thread title."), Flag.optional),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Optional branch for the new thread."),
    Flag.optional,
  ),
  baseBranch: Flag.String("base-branch").pipe(
    Flag.withDescription("Optional base branch when creating the branch."),
    Flag.optional,
  ),
  startFromOrigin: Flag.Boolean("start-from-origin").pipe(
    Flag.withDescription("Start the new branch from origin instead of the local head."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Create a local thread and print the create receipt."),
  Command.withHandler((flags) =>
    flags.yes
      ? runCreateThread({
          ...baseDirInput(flags.baseDir),
          project: flags.project,
          message: flags.message,
          idempotencyKey: flags.idempotencyKey,
          ...(Option.isSome(flags.title) ? { title: flags.title.value } : {}),
          ...(Option.isSome(flags.branch) ? { branch: flags.branch.value } : {}),
          ...(Option.isSome(flags.baseBranch) ? { baseBranch: flags.baseBranch.value } : {}),
          startFromOrigin: flags.startFromOrigin,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const localCompactCommand = Command.make("compact", {
  ...localBaseFlags,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  threadId: Argument.String("thread-id"),
}).pipe(
  Command.withDescription("Request compaction of one local thread."),
  Command.withHandler((flags) =>
    flags.yes
      ? runCompactThread({
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          idempotencyKey: flags.idempotencyKey,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const localPendingBaseFlags = {
  ...localBaseFlags,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  threadId: Argument.String("thread-id"),
  requestId: Argument.String("request-id"),
};

const localPendingListCommand = Command.make("list", {
  ...localBaseFlags,
  thread: Flag.String("thread").pipe(
    Flag.withDescription("Optionally scope the list to one thread id."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List local pending interactions, optionally scoped with --thread."),
  Command.withHandler((flags) =>
    runPendingList({
      ...baseDirInput(flags.baseDir),
      ...(Option.isSome(flags.thread) ? { threadId: flags.thread.value } : {}),
    }),
  ),
);

const localPendingAnswerCommand = Command.make("answer", {
  ...localPendingBaseFlags,
  answers: Flag.String("answers").pipe(
    Flag.withDescription("Answers as a JSON array of {questionId, values}."),
  ),
}).pipe(
  Command.withDescription("Answer one local pending user-input interaction."),
  Command.withHandler((flags) =>
    flags.yes
      ? runPendingAnswer({
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          requestId: flags.requestId,
          idempotencyKey: flags.idempotencyKey,
          answers: flags.answers,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const localPendingApproveCommand = Command.make("approve", localPendingBaseFlags).pipe(
  Command.withDescription("Approve one local pending approval interaction."),
  Command.withHandler((flags) =>
    flags.yes
      ? runPendingApprove({
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          requestId: flags.requestId,
          idempotencyKey: flags.idempotencyKey,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const localPendingRejectCommand = Command.make("reject", {
  ...localPendingBaseFlags,
  decision: Flag.Literals("decision", ["decline", "cancel"]).pipe(
    Flag.withDescription("Reject by declining or cancelling the interaction."),
  ),
}).pipe(
  Command.withDescription("Decline or cancel one local pending interaction."),
  Command.withHandler((flags) =>
    flags.yes
      ? runPendingReject({
          ...baseDirInput(flags.baseDir),
          threadId: flags.threadId,
          requestId: flags.requestId,
          idempotencyKey: flags.idempotencyKey,
          decision: flags.decision,
        })
      : failWithSanitizedRemoteError(new RemoteCliError({ reason: "confirmation-required" })),
  ),
);

const localPendingCommand = Command.make("pending").pipe(
  Command.withDescription("Inspect and respond to local pending interactions."),
  Command.withSubcommands([
    localPendingListCommand,
    localPendingAnswerCommand,
    localPendingApproveCommand,
    localPendingRejectCommand,
  ]),
);

export const localOrchestrationCommands = [
  localSessionCommand,
  localShellCommand,
  localSnapshotCommand,
  localThreadCommand,
  localSendCommand,
  localCreateCommand,
  localCompactCommand,
  localPendingCommand,
] as const;
