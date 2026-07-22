import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  EnvironmentId,
  type AuthEnvironmentScope,
  ProjectId,
  ProviderInteractionMode,
  RemoteInteractionAnswer,
  RemoteInteractionIdempotencyKey,
  RemoteInteractionRequestId,
  RemoteInteractionThreadId,
  RuntimeMode,
  ThreadId,
  TurnId,
  ORCHESTRATION_WS_METHODS,
} from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  issueRemoteWebSocketTicket,
} from "@t3tools/client-runtime/authorization";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import {
  dispatchRemoteOrchestrationCommand,
  answerRemotePendingInteraction,
  approveRemotePendingInteraction,
  fetchRemoteOrchestrationShell,
  fetchRemoteOrchestrationSnapshot,
  fetchRemoteOrchestrationThread,
  fetchRemotePendingInteractions,
  rejectRemotePendingInteraction,
} from "@t3tools/client-runtime/operations";
import { RpcSessionFactory, rpcSessionLayer } from "@t3tools/client-runtime/rpc";
import { oauthScopeSetEquals } from "@t3tools/shared/oauthScope";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, Prompt } from "effect/unstable/cli";

import { resolveBaseDir } from "../os-jank.ts";
import { DurationFromString, projectLocationFlags, type CliAuthLocationFlags } from "./config.ts";
import {
  dispatchRemoteCommandSafely,
  makeRemoteCreateCommand,
  makeRemoteSendCommand,
  remoteSessionHasScopes,
} from "./remoteOperations.ts";
import {
  loadRemoteCliToken,
  normalizeRemoteHttpBaseUrl,
  storeRemoteCliToken,
} from "./remoteTokenStore.ts";
import {
  formatRemoteWatchResult,
  observeRemoteWatchStream,
  type RemoteWatchFailure,
  RemoteWatchFailure as RemoteWatchFailureClass,
  type RemoteWatchTransport,
  watchRemoteThread,
} from "./remoteWatch.ts";

const REMOTE_ORCHESTRATION_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const;

export class RemoteCliError extends Schema.TaggedErrorClass<RemoteCliError>()("RemoteCliError", {
  reason: Schema.Literals([
    "invalid-host",
    "unexpected-token",
    "authentication-required",
    "scope-required",
    "confirmation-required",
    "project-not-found",
    "project-model-missing",
    "invalid-input",
    "capability-required",
    "request-failed",
  ]),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-host":
        return "Remote host must be an absolute HTTP or HTTPS URL without credentials.";
      case "unexpected-token":
        return "The remote environment did not issue the requested bearer orchestration scopes.";
      case "authentication-required":
        return "The stored remote CLI token is not authenticated.";
      case "scope-required":
        return `The stored remote CLI token is missing required scope ${this.detail ?? ""}.`.trim();
      case "confirmation-required":
        return this.detail ?? "This remote operation requires explicit confirmation.";
      case "project-not-found":
        return `Remote project ${this.detail ?? ""} was not found.`.trim();
      case "project-model-missing":
        return "The target project has no default model selection.";
      case "invalid-input":
        return this.detail ?? "Remote command input is invalid.";
      case "capability-required":
        return "The remote environment does not advertise pending interaction support.";
      case "request-failed":
        return "The remote environment request failed.";
    }
  }
}

const isRemoteCliError = Schema.is(RemoteCliError);

export function formatRemoteCliDiagnostic(error: unknown): string {
  if (isRemoteCliError(error)) {
    return `Remote request failed: ${error.message}`;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "RemoteWatchFailure" ||
      error._tag === "RemoteWatchNoTurnError" ||
      error._tag === "RemoteWatchTerminalWithoutMessageError" ||
      error._tag === "RemoteWatchTimeoutError")
  ) {
    return error instanceof Error ? error.message : "Remote watch failed.";
  }
  return "Remote request failed.";
}

const hostFlag = Flag.string("host").pipe(Flag.withDescription("Remote T3 Code HTTP base URL."));
const credentialFlag = Flag.redacted("credential").pipe(
  Flag.withDescription("One-time bootstrap credential (prompted securely when omitted)."),
  Flag.optional,
);
const yesFlag = Flag.boolean("yes").pipe(
  Flag.withDescription("Acknowledge the remote write."),
  Flag.withDefault(false),
);
const confirmCreateFlag = Flag.boolean("confirm-create").pipe(
  Flag.withDescription("Second confirmation required for remote thread creation."),
  Flag.withDefault(false),
);
const startFromOriginFlag = Flag.boolean("start-from-origin").pipe(
  Flag.withDescription("Fetch origin and resolve the base branch from its remote tracking ref."),
  Flag.withDefault(false),
);
const runtimeModeFlag = Flag.choice("runtime-mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode for the new thread."),
  Flag.optional,
);
const interactionModeFlag = Flag.choice("interaction-mode", ProviderInteractionMode.literals).pipe(
  Flag.withDescription("Interaction mode for the new thread."),
  Flag.optional,
);
const watchFormatFlag = Flag.choice("format", ["text", "json"] as const).pipe(
  Flag.withDescription("Watch output format."),
  Flag.withDefault("text"),
);
const watchTimeoutFlag = Flag.string("timeout").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("Maximum time to wait, for example 10m or 30s."),
  Flag.withDefault(Duration.minutes(10)),
);
const watchTurnFlag = Flag.string("turn").pipe(
  Flag.withDescription("Specific turn id to watch."),
  Flag.optional,
);
const pendingThreadIdFlag = Flag.string("thread-id").pipe(
  Flag.withDescription("Only return interactions for this thread id."),
  Flag.optional,
);
const idempotencyKeyFlag = Flag.string("idempotency-key").pipe(
  Flag.withDescription("Opaque retry key scoped to the authenticated remote session."),
);
const answersJsonFlag = Flag.string("answers-json").pipe(
  Flag.withDescription('JSON array of {"questionId":"...","values":["..."]} answers.'),
);
const rejectionDecisionFlag = Flag.choice("decision", ["decline", "cancel"] as const).pipe(
  Flag.withDescription("Legacy provider rejection decision."),
  Flag.withDefault("decline"),
);
const watchInteractionsFlag = Flag.boolean("interactions").pipe(
  Flag.withDescription(
    "Exit with code 26 and safe JSON when user input or command approval is pending.",
  ),
  Flag.withDefault(false),
);

interface RemoteCommandFlags extends CliAuthLocationFlags {
  readonly host: string;
}

const resolveRemoteTarget = Effect.fn("remoteCli.resolveTarget")(function* (
  flags: RemoteCommandFlags,
) {
  const path = yield* Path.Path;
  const baseDir = yield* resolveBaseDir(Option.getOrUndefined(flags.baseDir));
  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeRemoteHttpBaseUrl(flags.host),
    catch: () => new RemoteCliError({ reason: "invalid-host" }),
  });
  return { httpBaseUrl, stateDirectory: path.join(baseDir, "remote-cli") };
});

const remoteRuntimeLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  rpcSessionLayer.pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
);

const runRemote = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(remoteRuntimeLayer));

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const decodeCliValue = <S extends Schema.Decoder<unknown>>(
  schema: S,
  value: unknown,
  label: string,
) =>
  Option.match(Schema.decodeUnknownOption(schema)(value), {
    onNone: () =>
      Effect.fail(
        new RemoteCliError({
          reason: "invalid-input",
          detail: `${label} is invalid.`,
        }),
      ),
    onSome: Effect.succeed,
  });

const decodeRemoteAnswersJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(RemoteInteractionAnswer)),
);

const decodeAnswersJson = (value: string) =>
  Option.match(decodeRemoteAnswersJson(value, { onExcessProperty: "error" }), {
    onNone: () =>
      Effect.fail(
        new RemoteCliError({ reason: "invalid-input", detail: "Answers JSON is invalid." }),
      ),
    onSome: Effect.succeed,
  });

const loadRemoteAuthorization = Effect.fn("remoteCli.loadAuthorization")(function* (input: {
  readonly stateDirectory: string;
  readonly httpBaseUrl: string;
  readonly requiredScopes: ReadonlyArray<AuthEnvironmentScope>;
}) {
  const token = yield* loadRemoteCliToken(input);
  const session = yield* fetchRemoteSessionState({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: token.accessToken,
  }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
  if (!session.authenticated) {
    return yield* new RemoteCliError({ reason: "authentication-required" });
  }
  for (const scope of input.requiredScopes) {
    if (!remoteSessionHasScopes(session, [scope])) {
      return yield* new RemoteCliError({ reason: "scope-required", detail: scope });
    }
  }
  return { accessToken: token.accessToken, session };
});

const requirePendingInteractionCapability = Effect.fn(
  "remoteCli.requirePendingInteractionCapability",
)(function* (target: { readonly httpBaseUrl: string }) {
  const descriptor = yield* fetchRemoteEnvironmentDescriptor(target).pipe(
    Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })),
  );
  if (descriptor.capabilities.orchestration?.pendingInteractions !== true) {
    return yield* new RemoteCliError({ reason: "capability-required" });
  }
});

const readThreadOption = (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly threadId: ThreadId;
}) =>
  fetchRemoteOrchestrationThread({
    httpBaseUrl: input.httpBaseUrl,
    authorization: { accessToken: input.accessToken },
    threadId: input.threadId,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("EnvironmentResourceNotFoundError", () => Effect.succeed(Option.none())),
  );

function websocketBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  return url.toString();
}

function remoteWatchFailure(
  error: unknown,
  fallback: RemoteWatchFailure["kind"],
): RemoteWatchFailure {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "EnvironmentAuthInvalidError" ||
      error._tag === "EnvironmentScopeRequiredError" ||
      (error._tag === "ConnectionBlockedError" &&
        "reason" in error &&
        error.reason === "permission"))
  ) {
    return new RemoteWatchFailureClass({ kind: "auth" });
  }
  return new RemoteWatchFailureClass({ kind: fallback });
}

const makeRemoteWatchTransport = Effect.fn("remoteCli.makeWatchTransport")(function* (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly threadId: ThreadId;
}): Effect.fn.Return<RemoteWatchTransport, never, RpcSessionFactory | HttpClient.HttpClient> {
  const sessions = yield* RpcSessionFactory;
  const httpClient = yield* HttpClient.HttpClient;
  const readThread = () =>
    fetchRemoteOrchestrationThread({
      httpBaseUrl: input.httpBaseUrl,
      authorization: { accessToken: input.accessToken },
      threadId: input.threadId,
    }).pipe(
      Effect.mapError((error) => remoteWatchFailure(error, "transport")),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
  const subscribeThread: RemoteWatchTransport["subscribeThread"] = (watchInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const ticket = yield* issueRemoteWebSocketTicket({
          httpBaseUrl: input.httpBaseUrl,
          bearerToken: input.accessToken,
        }).pipe(Effect.mapError((error) => remoteWatchFailure(error, "unavailable")));
        const socketUrl = new URL(websocketBaseUrl(input.httpBaseUrl));
        socketUrl.searchParams.set("wsTicket", ticket.ticket);
        const target = new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make(`remote-cli:${new URL(input.httpBaseUrl).host}`),
          label: new URL(input.httpBaseUrl).host,
          httpBaseUrl: input.httpBaseUrl,
          wsBaseUrl: websocketBaseUrl(input.httpBaseUrl),
        });
        const connection: PreparedConnection = {
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: input.httpBaseUrl,
          socketUrl: socketUrl.toString(),
          // Remote CLI targets are normalized to an origin and do not carry
          // persisted connection-profile query parameters.
          queryParameters: [],
          httpAuthorization: { _tag: "Bearer", token: input.accessToken },
          target,
        };
        const session = yield* sessions
          .connect(connection)
          .pipe(Effect.mapError((error) => remoteWatchFailure(error, "unavailable")));
        yield* session.ready.pipe(
          Effect.mapError((error) => remoteWatchFailure(error, "unavailable")),
        );
        return yield* observeRemoteWatchStream({
          stream: session.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: watchInput.threadId,
            afterSequence: watchInput.afterSequence,
          }).pipe(Stream.mapError((error) => remoteWatchFailure(error, "transport"))),
          initialSequence: watchInput.afterSequence,
          targetTurnId: watchInput.targetTurnId,
          observedRunning: watchInput.observedRunning,
          interactionAware: watchInput.interactionAware,
        });
      }),
    ).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
  return { readThread, subscribeThread };
});

const remoteEnvironmentCommand = Command.make("environment", {
  ...projectLocationFlags,
  host: hostFlag,
}).pipe(
  Command.withDescription("Read the unauthenticated remote environment descriptor."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: target.httpBaseUrl,
        });
        yield* Console.log(formatJson(descriptor));
      }),
    ),
  ),
);

const remoteAuthCommand = Command.make("auth", {
  ...projectLocationFlags,
  host: hostFlag,
  credential: credentialFlag,
}).pipe(
  Command.withDescription("Exchange a one-time credential for narrow remote orchestration access."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const credential = Option.isSome(flags.credential)
          ? flags.credential.value
          : yield* Prompt.run(Prompt.password({ message: "One-time bootstrap credential" }));
        const exchanged = yield* bootstrapRemoteBearerSession({
          httpBaseUrl: target.httpBaseUrl,
          credential: Redacted.value(credential),
          scopes: REMOTE_ORCHESTRATION_SCOPES,
          clientMetadata: { label: "T3 remote CLI", deviceType: "bot" },
        }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
        if (
          exchanged.token_type !== "Bearer" ||
          !oauthScopeSetEquals(exchanged.scope, REMOTE_ORCHESTRATION_SCOPES)
        ) {
          return yield* new RemoteCliError({ reason: "unexpected-token" });
        }
        const now = yield* Clock.currentTimeMillis;
        const expiresAtEpochMs = now + exchanged.expires_in * 1_000;
        yield* storeRemoteCliToken({
          ...target,
          token: { accessToken: exchanged.access_token, expiresAtEpochMs },
        });
        yield* Console.log(formatJson({ authenticated: true, expiresAtEpochMs }));
      }),
    ),
  ),
);

const remoteSessionCommand = Command.make("session", {
  ...projectLocationFlags,
  host: hostFlag,
}).pipe(
  Command.withDescription("Read the authenticated remote session."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationReadScope],
        });
        yield* Console.log(formatJson(authorization.session));
      }),
    ),
  ),
);

const remoteShellCommand = Command.make("shell", {
  ...projectLocationFlags,
  host: hostFlag,
}).pipe(
  Command.withDescription("Read the authenticated orchestration shell snapshot."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationReadScope],
        });
        const snapshot = yield* fetchRemoteOrchestrationShell({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
        });
        yield* Console.log(formatJson(snapshot));
      }),
    ),
  ),
);

const remoteSnapshotCommand = Command.make("snapshot", {
  ...projectLocationFlags,
  host: hostFlag,
}).pipe(
  Command.withDescription("Read the authenticated full orchestration snapshot."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationReadScope],
        });
        const snapshot = yield* fetchRemoteOrchestrationSnapshot({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
        });
        yield* Console.log(formatJson(snapshot));
      }),
    ),
  ),
);

const remoteThreadCommand = Command.make("thread", {
  ...projectLocationFlags,
  host: hostFlag,
  threadId: Argument.string("thread-id"),
}).pipe(
  Command.withDescription("Read an authenticated thread detail snapshot."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationReadScope],
        });
        const snapshot = yield* fetchRemoteOrchestrationThread({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          threadId: ThreadId.make(flags.threadId),
        });
        yield* Console.log(formatJson(snapshot));
      }),
    ),
  ),
);

const remoteSendCommand = Command.make("send", {
  ...projectLocationFlags,
  host: hostFlag,
  yes: yesFlag,
  threadId: Argument.string("thread-id"),
  message: Argument.string("message"),
}).pipe(
  Command.withDescription("Send a turn to an existing thread after explicit acknowledgement."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        if (!flags.yes) {
          return yield* new RemoteCliError({
            reason: "confirmation-required",
            detail: "Remote send requires --yes.",
          });
        }
        if (flags.message.trim().length === 0) {
          return yield* new RemoteCliError({
            reason: "invalid-input",
            detail: "Message must not be empty.",
          });
        }
        const target = yield* resolveRemoteTarget(flags);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: REMOTE_ORCHESTRATION_SCOPES,
        });
        const threadId = ThreadId.make(flags.threadId);
        const snapshot = yield* fetchRemoteOrchestrationThread({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          threadId,
        });
        const crypto = yield* Crypto.Crypto;
        const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const command = makeRemoteSendCommand({
          snapshot,
          commandId,
          message: flags.message,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        const dispatch = dispatchRemoteOrchestrationCommand({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          command,
        });
        const result = yield* dispatchRemoteCommandSafely({
          command,
          dispatch,
          retryDispatch: dispatch,
          readThread: readThreadOption({
            httpBaseUrl: target.httpBaseUrl,
            accessToken: authorization.accessToken,
            threadId,
          }),
        });
        yield* Console.log(formatJson({ threadId, commandId, ...result }));
      }),
    ),
  ),
);

const remoteCreateCommand = Command.make("create", {
  ...projectLocationFlags,
  host: hostFlag,
  yes: yesFlag,
  confirmCreate: confirmCreateFlag,
  startFromOrigin: startFromOriginFlag,
  runtimeMode: runtimeModeFlag,
  interactionMode: interactionModeFlag,
  title: Flag.string("title").pipe(Flag.optional),
  branch: Flag.string("branch"),
  baseBranch: Flag.string("base-branch"),
  projectId: Argument.string("project-id"),
  message: Argument.string("message"),
}).pipe(
  Command.withDescription("Create an isolated-worktree thread with double confirmation."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        if (!flags.yes || !flags.confirmCreate) {
          return yield* new RemoteCliError({
            reason: "confirmation-required",
            detail: "Remote create requires both --yes and --confirm-create.",
          });
        }
        if (
          flags.message.trim().length === 0 ||
          flags.branch.trim().length === 0 ||
          flags.baseBranch.trim().length === 0
        ) {
          return yield* new RemoteCliError({
            reason: "invalid-input",
            detail: "Message, branch, and base branch must not be empty.",
          });
        }
        const target = yield* resolveRemoteTarget(flags);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: REMOTE_ORCHESTRATION_SCOPES,
        });
        const shell = yield* fetchRemoteOrchestrationShell({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
        });
        const projectId = ProjectId.make(flags.projectId);
        const project = shell.projects.find((candidate) => candidate.id === projectId);
        if (project === undefined) {
          return yield* new RemoteCliError({ reason: "project-not-found", detail: projectId });
        }
        if (project.defaultModelSelection === null) {
          return yield* new RemoteCliError({ reason: "project-model-missing" });
        }
        const crypto = yield* Crypto.Crypto;
        const threadId = ThreadId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const commandId = CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
        const command = makeRemoteCreateCommand({
          project,
          modelSelection: project.defaultModelSelection,
          threadId,
          commandId,
          message: flags.message,
          title: Option.getOrElse(flags.title, () => flags.message.trim().slice(0, 80)),
          branch: flags.branch,
          baseBranch: flags.baseBranch,
          startFromOrigin: flags.startFromOrigin,
          ...(Option.isSome(flags.runtimeMode) ? { runtimeMode: flags.runtimeMode.value } : {}),
          ...(Option.isSome(flags.interactionMode)
            ? { interactionMode: flags.interactionMode.value }
            : {}),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        const dispatch = dispatchRemoteOrchestrationCommand({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          command,
        });
        const result = yield* dispatchRemoteCommandSafely({
          command,
          dispatch,
          retryDispatch: dispatch,
          readThread: readThreadOption({
            httpBaseUrl: target.httpBaseUrl,
            accessToken: authorization.accessToken,
            threadId,
          }),
        });
        yield* Console.log(formatJson({ threadId, commandId, ...result }));
      }),
    ),
  ),
);

const remoteWatchCommand = Command.make("watch", {
  ...projectLocationFlags,
  host: hostFlag,
  timeout: watchTimeoutFlag,
  format: watchFormatFlag,
  turn: watchTurnFlag,
  interactions: watchInteractionsFlag,
  threadId: Argument.string("thread-id"),
}).pipe(
  Command.withDescription("Wait once for a thread turn's final assistant message."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationReadScope],
        });
        const threadId = ThreadId.make(flags.threadId);
        const transport = yield* makeRemoteWatchTransport({
          httpBaseUrl: target.httpBaseUrl,
          accessToken: authorization.accessToken,
          threadId,
        });
        const result = yield* watchRemoteThread({
          transport,
          threadId,
          timeoutMs: Duration.toMillis(flags.timeout),
          interactionAware: flags.interactions,
          ...(Option.isSome(flags.turn) ? { requestedTurnId: TurnId.make(flags.turn.value) } : {}),
        }).pipe(
          Effect.catchTag("RemoteWatchInteractionRequiredError", (error) =>
            Console.log(error.message).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
        yield* Console.log(formatRemoteWatchResult(result, flags.format));
      }),
    ),
  ),
);

const remotePendingCommand = Command.make("pending", {
  ...projectLocationFlags,
  host: hostFlag,
  threadId: pendingThreadIdFlag,
}).pipe(
  Command.withDescription("Read sanitized pending remote interactions."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        const target = yield* resolveRemoteTarget(flags);
        yield* requirePendingInteractionCapability(target);
        const threadId = Option.isSome(flags.threadId)
          ? yield* decodeCliValue(RemoteInteractionThreadId, flags.threadId.value, "Thread id")
          : undefined;
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationReadScope],
        });
        const result = yield* fetchRemotePendingInteractions({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          ...(threadId === undefined ? {} : { threadId }),
        }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
        yield* Console.log(formatJson(result));
      }),
    ),
  ),
);

const remoteAnswerCommand = Command.make("answer", {
  ...projectLocationFlags,
  host: hostFlag,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  answersJson: answersJsonFlag,
  threadId: Argument.string("thread-id"),
  requestId: Argument.string("request-id"),
}).pipe(
  Command.withDescription("Answer a pending remote user-input interaction."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        if (!flags.yes) {
          return yield* new RemoteCliError({
            reason: "confirmation-required",
            detail: "Remote answer requires --yes.",
          });
        }
        const [threadId, requestId, idempotencyKey, answers] = yield* Effect.all([
          decodeCliValue(RemoteInteractionThreadId, flags.threadId, "Thread id"),
          decodeCliValue(RemoteInteractionRequestId, flags.requestId, "Request id"),
          decodeCliValue(RemoteInteractionIdempotencyKey, flags.idempotencyKey, "Idempotency key"),
          decodeAnswersJson(flags.answersJson),
        ]);
        const target = yield* resolveRemoteTarget(flags);
        yield* requirePendingInteractionCapability(target);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationOperateScope],
        });
        const result = yield* answerRemotePendingInteraction({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          payload: { threadId, requestId, idempotencyKey, answers },
        }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
        yield* Console.log(formatJson(result));
      }),
    ),
  ),
);

const remoteApproveCommand = Command.make("approve", {
  ...projectLocationFlags,
  host: hostFlag,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  threadId: Argument.string("thread-id"),
  requestId: Argument.string("request-id"),
}).pipe(
  Command.withDescription("Approve a safely summarized pending remote interaction."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        if (!flags.yes) {
          return yield* new RemoteCliError({
            reason: "confirmation-required",
            detail: "Remote approve requires --yes.",
          });
        }
        const [threadId, requestId, idempotencyKey] = yield* Effect.all([
          decodeCliValue(RemoteInteractionThreadId, flags.threadId, "Thread id"),
          decodeCliValue(RemoteInteractionRequestId, flags.requestId, "Request id"),
          decodeCliValue(RemoteInteractionIdempotencyKey, flags.idempotencyKey, "Idempotency key"),
        ]);
        const target = yield* resolveRemoteTarget(flags);
        yield* requirePendingInteractionCapability(target);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationOperateScope],
        });
        const result = yield* approveRemotePendingInteraction({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          payload: { threadId, requestId, idempotencyKey },
        }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
        yield* Console.log(formatJson(result));
      }),
    ),
  ),
);

const remoteRejectCommand = Command.make("reject", {
  ...projectLocationFlags,
  host: hostFlag,
  yes: yesFlag,
  idempotencyKey: idempotencyKeyFlag,
  decision: rejectionDecisionFlag,
  threadId: Argument.string("thread-id"),
  requestId: Argument.string("request-id"),
}).pipe(
  Command.withDescription("Decline or cancel a pending remote approval interaction."),
  Command.withHandler((flags) =>
    runRemote(
      Effect.gen(function* () {
        if (!flags.yes) {
          return yield* new RemoteCliError({
            reason: "confirmation-required",
            detail: "Remote reject requires --yes.",
          });
        }
        const [threadId, requestId, idempotencyKey] = yield* Effect.all([
          decodeCliValue(RemoteInteractionThreadId, flags.threadId, "Thread id"),
          decodeCliValue(RemoteInteractionRequestId, flags.requestId, "Request id"),
          decodeCliValue(RemoteInteractionIdempotencyKey, flags.idempotencyKey, "Idempotency key"),
        ]);
        const target = yield* resolveRemoteTarget(flags);
        yield* requirePendingInteractionCapability(target);
        const authorization = yield* loadRemoteAuthorization({
          ...target,
          requiredScopes: [AuthOrchestrationOperateScope],
        });
        const result = yield* rejectRemotePendingInteraction({
          httpBaseUrl: target.httpBaseUrl,
          authorization,
          payload: {
            threadId,
            requestId,
            idempotencyKey,
            decision: flags.decision,
          },
        }).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })));
        yield* Console.log(formatJson(result));
      }),
    ),
  ),
);

export const remoteCommand = Command.make("remote").pipe(
  Command.withDescription("Use the supported remote orchestration API."),
  Command.withSubcommands([
    remoteEnvironmentCommand,
    remoteAuthCommand,
    remoteSessionCommand,
    remoteShellCommand,
    remoteSnapshotCommand,
    remoteThreadCommand,
    remoteSendCommand,
    remoteCreateCommand,
    remoteWatchCommand,
    remotePendingCommand,
    remoteAnswerCommand,
    remoteApproveCommand,
    remoteRejectCommand,
  ]),
);
