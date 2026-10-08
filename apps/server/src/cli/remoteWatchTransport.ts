import {
  EnvironmentAuthorizationError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WsRpcGroup,
  type OrchestrationV2ThreadStreamItem,
  type RunId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import {
  observeRemoteWatchStream,
  RemoteWatchFailure,
  type RemoteWatchSnapshot,
  type RemoteWatchObservation,
  type RemoteWatchTransport,
} from "./remoteWatch.ts";
import { makeRemoteCliApi } from "./remoteHttp.ts";

const makeWsRpcClient = RpcClient.make(WsRpcGroup);

// Fixed transport-local deadline applied to both native HTTP endpoints; the
// raw endpoint errors are classified here, before any normalized helper could
// erase the status and body evidence the classification depends on.
const REMOTE_WATCH_HTTP_TIMEOUT = Duration.seconds(15);
const SOCKET_OPEN_TIMEOUT = "15 seconds";

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const authFailure = () => new RemoteWatchFailure({ kind: "auth" });
const transportFailure = () => new RemoteWatchFailure({ kind: "transport" });
const protocolFailure = () => new RemoteWatchFailure({ kind: "protocol" });

/**
 * Root decision: a bare 404 never establishes an unsupported capability. No
 * agreed wire signal for "subscription unsupported" has been demonstrated, so
 * ambiguous 404s are protocol failures — deliberately never `unavailable`, so
 * the watch loop above this transport never silently degrades to polling on
 * an unproven signal. `unavailable` stays reserved for a future explicitly
 * evidenced capability signal.
 */

/**
 * Classifies raw native HTTP failures for both endpoints this transport
 * drives (thread snapshot and WebSocket ticket). Authentication rejections
 * are recognized by response status, so non-contract bodies still classify
 * as auth; schema-invalid responses are protocol failures; connection-level
 * failures are transport failures. Failures are sanitized: only the kind
 * travels, never the raw body, URL, or cause.
 */
const classifyHttpEndpointFailure = (error: unknown): RemoteWatchFailure => {
  if (isEnvironmentAuthorizationError(error)) return authFailure();
  const tag = (error as { readonly _tag?: string } | null)?._tag;
  if (tag === "EnvironmentAuthInvalidError" || tag === "EnvironmentScopeRequiredError") {
    return authFailure();
  }
  // A successful response that failed schema decoding means the endpoint
  // answered wrongly: a protocol failure, not a transport one.
  if (tag === "SchemaError") return protocolFailure();
  if (tag === "HttpClientError") {
    const reason = (error as { readonly reason: { readonly _tag: string } }).reason;
    const status =
      "response" in reason
        ? (reason as { readonly response: { readonly status: number } }).response.status
        : undefined;
    if (status === 401 || status === 403) return authFailure();
    if (status !== undefined) return protocolFailure();
    return transportFailure();
  }
  return transportFailure();
};

/**
 * Classifies failures of the native subscribeThread RPC stream. Decode/defect
 * problems are protocol failures; socket-level breaks are transport failures
 * that `observeRemoteWatchStream` enriches with the observer progress.
 */
const classifyStreamFailure = (error: unknown): RemoteWatchFailure => {
  if (isEnvironmentAuthorizationError(error)) return authFailure();
  const tag = (error as { readonly _tag?: string } | null)?._tag;
  if (tag === "RpcClientError") {
    const reason = (error as { readonly reason: { readonly _tag: string } }).reason;
    return new RemoteWatchFailure({
      kind: reason._tag === "RpcClientDefect" ? "protocol" : "transport",
    });
  }
  // Native socket failures (read, write, open, close) are connection-level.
  if (tag === "SocketError") return transportFailure();
  // Server answered the RPC with a typed failure (snapshot error, etc.):
  // a protocol-level rejection, never an unsupported endpoint.
  return protocolFailure();
};

/**
 * The installed RpcClient decodes Chunk/Exit values with `Effect.orDie` and
 * logs raw causes, so a schema-invalid (but valid-JSON) frame surfaces here
 * as a die carrying server payload detail. Convert non-interruption causes
 * into sanitized failures before the observer, which then attaches its
 * retained progress (lastSequence/observedRunning): socket-level RPC errors
 * keep their transport classification, decode defects become protocol
 * failures, and interruption stays interruption. Only the sanitized kind
 * travels onward — never the raw cause or payload.
 */
const sanitizeStreamDefects = <E, R>(
  stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>,
): Stream.Stream<OrchestrationV2ThreadStreamItem, RemoteWatchFailure | E, R> =>
  Stream.catchCause(
    stream,
    (cause): Stream.Stream<OrchestrationV2ThreadStreamItem, RemoteWatchFailure | E> => {
      // Typed stream failures were already classified by `classifyStreamFailure`
      // (and carry observer progress); interruption stays interruption. Only
      // dies — the orDie'd Chunk/Exit schema decode failures and raw socket
      // errors — need sanitizing here.
      if (Cause.hasInterruptsOnly(cause) || !Cause.hasDies(cause)) {
        return Stream.failCause(cause);
      }
      // `Cause.findDefect` yields `Result.success(defect)` when a die is
      // present; the failure branch holds the remaining cause instead.
      const found = Cause.findDefect(cause);
      const defect = Result.isSuccess(found) ? found.success : undefined;
      const defectTag = (defect as { readonly _tag?: string } | null)?._tag;
      // Native socket errors (SocketError over its read/write/open/close
      // reasons) and RPC client errors are connection-level: transport.
      if (defectTag === "RpcClientError" || defectTag === "SocketError") {
        return Stream.fail(classifyStreamFailure(defect));
      }
      // Everything else that dies (the orDie'd Chunk/Exit schema decode
      // failures) is a wire-protocol violation.
      return Stream.fail(protocolFailure());
    },
  );

/**
 * Derives the native `/ws` socket URL: swaps the protocol, replaces the path,
 * preserves the explicit routing query pairs in order, and appends the fresh
 * `wsTicket`. The bearer token never travels in the URL.
 */
const webSocketUrl = (httpBaseUrl: string, ticket: string): string => {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  return url.toString();
};

/**
 * Builds one socket-backed JSON RPC protocol per subscription attempt. Retry
 * policies are disabled: the watch loop above the transport owns reconnects,
 * and the acquire scope closes the WebSocket on every exit path. Raw RPC
 * diagnostic logging (the protocol layer logs decode causes with server
 * payload detail) is suppressed by replacing the logger set for this attempt
 * scope only; the process-default logger configuration is untouched.
 */
const protocolLayer = (
  wsUrl: string,
  webSocketConstructor: Socket.WebSocketConstructor["Service"],
) => {
  const socketLayer = Socket.layerWebSocket(wsUrl, { openTimeout: SOCKET_OPEN_TIMEOUT }).pipe(
    Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
  );
  return RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
    Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)),
  );
};

const subscribeAttempt = (
  wsUrl: string,
  webSocketConstructor: Socket.WebSocketConstructor["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly targetTurnId: RunId;
    readonly observedRunning: boolean;
    readonly interactionAware: boolean;
  },
): Effect.Effect<RemoteWatchObservation, RemoteWatchFailure> =>
  Effect.gen(function* () {
    const protocol = yield* Layer.build(protocolLayer(wsUrl, webSocketConstructor));
    const client = yield* makeWsRpcClient.pipe(Effect.provide(protocol));
    const stream = client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
      threadId: input.threadId,
      afterSequence: input.afterSequence,
    });
    return yield* observeRemoteWatchStream({
      stream: sanitizeStreamDefects(Stream.mapError(stream, classifyStreamFailure)),
      initialSequence: input.afterSequence,
      targetTurnId: input.targetTurnId,
      observedRunning: input.observedRunning,
      interactionAware: input.interactionAware,
    });
  }).pipe(
    // Attempt-local suppression: the installed protocol layer logs raw decode
    // causes (causePretty renders server payload detail), so the logger set is
    // emptied for this scope only. The process-default logger configuration is
    // untouched outside the attempt.
    Effect.provideService(
      Logger.CurrentLoggers,
      new Set() as ReadonlySet<Logger.Logger<unknown, any>>,
    ),
    Effect.scoped,
  );

/**
 * Transport for the remote thread watch: native HTTP for the thread snapshot
 * and one fresh-authenticated native WebSocket RPC subscription per attempt.
 * Every subscription mints its own WebSocket ticket; connection resources are
 * scoped to the attempt and released on success, failure, and cancellation.
 */
export const makeRemoteWatchTransport = Effect.fn("remoteWatchTransport.make")(function* (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly threadId: ThreadId;
}) {
  const client = yield* makeRemoteCliApi(input.httpBaseUrl);
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const bearerHeaders = { authorization: `Bearer ${input.accessToken}` };
  const orchestrationHeaders = {
    ...bearerHeaders,
    [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT as "2",
  };

  const guardHttp = <A, E>(request: Effect.Effect<A, E>): Effect.Effect<A, RemoteWatchFailure> =>
    request.pipe(
      Effect.timeoutOption(REMOTE_WATCH_HTTP_TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(transportFailure()),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError(classifyHttpEndpointFailure),
      // Successful responses that fail schema decoding surface as SchemaError
      // defects (the endpoint answered, wrongly) — protocol failures, not
      // transport.
      Effect.catchDefect((defect) =>
        Effect.fail(
          (defect as { readonly _tag?: string } | null)?._tag === "SchemaError"
            ? protocolFailure()
            : transportFailure(),
        ),
      ),
    );

  const readThread = (): Effect.Effect<RemoteWatchSnapshot, RemoteWatchFailure> =>
    Effect.gen(function* () {
      // The V2 detail owns body data and its event cursor. Read metadata after
      // it so the active/latest ids cover every event included in that cursor.
      const detail = yield* guardHttp(
        client.orchestration.threadSnapshot({
          headers: orchestrationHeaders,
          params: { threadId: input.threadId },
        }),
      );
      const metadata = yield* guardHttp(client.orchestration.snapshot({ headers: bearerHeaders }));
      const thread = metadata.threads.find((candidate) => candidate.id === input.threadId);
      if (thread === undefined) return yield* protocolFailure();
      return {
        ...detail,
        latestRunId: thread.latestRunId,
        activeRunId: thread.activeRunId,
      } satisfies RemoteWatchSnapshot;
    });

  const subscribeThread = (sub: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly targetTurnId: RunId;
    readonly observedRunning: boolean;
    readonly interactionAware: boolean;
  }) =>
    guardHttp(client.auth.webSocketTicket({ headers: bearerHeaders })).pipe(
      Effect.flatMap((issued) =>
        subscribeAttempt(webSocketUrl(input.httpBaseUrl, issued.ticket), webSocketConstructor, sub),
      ),
    );

  return {
    readThread,
    subscribeThread,
  } satisfies RemoteWatchTransport;
});
