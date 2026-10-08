import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { FetchHttpClient } from "effect/http";
import * as Socket from "effect/socket/Socket";

import { RemoteWatchFailure } from "./remoteWatch.ts";
import { makeRemoteWatchTransport } from "./remoteWatchTransport.ts";

const isRemoteWatchFailure = Schema.is(RemoteWatchFailure);
const threadId = ThreadId.make("thread-transport");
const turnId = RunId.make("run-transport");
const accessToken = "access-secret";
const now = DateTime.makeUnsafe("2026-07-21T00:01:00.000Z");

type JsonRecord = Record<string, unknown>;

type FakeWebSocketEvent = Socket.WebSocketEvent;

interface FakeRequestFrame extends JsonRecord {
  readonly _tag: "Request";
  readonly id: string | number;
  readonly tag: string;
  readonly payload: JsonRecord;
}

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFakeRequestFrame = (frame: JsonRecord): frame is FakeRequestFrame =>
  frame._tag === "Request" &&
  (typeof frame.id === "string" || typeof frame.id === "number") &&
  typeof frame.tag === "string" &&
  isJsonRecord(frame.payload);

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));

/** Minimal native WebSocket double driven by the tests as the remote server. */
class FakeWebSocket implements Socket.WebSocketLike {
  static instances: Array<FakeWebSocket> = [];

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  readonly url: string;
  readonly sent: Array<JsonRecord> = [];
  readonly handlers = new Map<string, Array<(event: Socket.WebSocketEvent) => void>>();
  closed = false;
  closeCode: number | undefined;
  readyState = 0;
  readonly autoOpen: boolean;

  constructor(url: string | URL, autoOpen = true) {
    this.url = String(url);
    this.autoOpen = autoOpen;
    FakeWebSocket.instances.push(this);
    if (autoOpen) queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    handler: (event: Socket.WebSocketEvent) => void,
  ): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  removeEventListener(
    type: "open" | "message" | "error" | "close",
    handler: (event: Socket.WebSocketEvent) => void,
  ): void {
    this.handlers.set(
      type,
      (this.handlers.get(type) ?? []).filter((registered) => registered !== handler),
    );
  }

  send(data: string | Uint8Array): void {
    const frame: unknown = JSON.parse(
      typeof data === "string" ? data : new TextDecoder().decode(data),
    );
    if (!isJsonRecord(frame)) throw new Error("Expected a JSON WebSocket frame.");
    if (frame._tag === "Ping") {
      this.serverSend({ _tag: "Pong" });
      return;
    }
    this.sent.push(frame);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  /** Simulates the remote server pushing a protocol frame. */
  serverSend(frame: unknown): void {
    this.emit("message", {
      data: typeof frame === "string" ? frame : JSON.stringify(frame),
    });
  }

  requestFrame(): FakeRequestFrame | undefined {
    return this.sent.find(isFakeRequestFrame);
  }

  private emit(type: string, event: FakeWebSocketEvent): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

const requiredRequestFrame = (socket: FakeWebSocket): FakeRequestFrame => {
  const frame = socket.requestFrame();
  if (frame === undefined) throw new Error("Expected the client RPC request frame.");
  return frame;
};

const makeWebSocketLayer = (wsOptions: { readonly autoOpen?: boolean } = {}) =>
  Layer.succeed(
    Socket.WebSocketConstructor,
    (url, _options) => new FakeWebSocket(url, wsOptions.autoOpen ?? true),
  );

/**
 * Drains microtasks until the predicate holds. The fake WebSocket emits its
 * open event via `queueMicrotask`, so a bounded cooperative loop observes it
 * without wall-clock timers (which `it.effect` runs against the TestClock).
 */
const waitFor = (predicate: () => boolean, label: string): Effect.Effect<void> => {
  const tick = (attempts: number): Effect.Effect<void> =>
    predicate()
      ? Effect.void
      : attempts >= 10_000
        ? Effect.die(new Error(`waitFor timeout: ${label}`))
        : Effect.flatMap(Effect.yieldNow, () => tick(attempts + 1));
  return tick(0);
};

const makeRun = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: turnId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex_personal"), model: "gpt-test" },
  providerThreadId: null,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: DateTime.makeUnsafe("2026-07-21T00:00:00.000Z"),
  startedAt: status === "preparing" || status === "queued" ? null : now,
  completedAt: status === "completed" ? now : null,
  checkpointId: null,
  contextHandoffId: null,
  purpose: "user",
  userMessageId: MessageId.make("user-transport"),
});

const projectionFixture = (
  runs: ReadonlyArray<OrchestrationV2Run> = [makeRun("running")],
): OrchestrationV2ThreadProjection => ({
  thread: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project-transport"),
    title: "Transport",
    providerInstanceId: ProviderInstanceId.make("codex_personal"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex_personal"), model: "gpt-test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe("2026-07-21T00:00:00.000Z"),
    updatedAt: now,
    archivedAt: null,
    hiddenAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [...runs],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
});

/** JSON payloads for the native V2 thread-detail and body-light metadata endpoints. */
const snapshotFixture = (sequence: number) => {
  const thread = projectionFixture().thread;
  return {
    detail: { snapshotSequence: sequence, projection: projectionFixture() },
    metadata: {
      snapshotSequence: sequence,
      projects: [
        {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          deletedAt: null,
        },
      ],
      threads: [
        {
          ...thread,
          latestRunId: turnId,
          activeRunId: turnId,
          plans: [],
          providerSessions: [],
          messages: [],
          activities: [],
          checkpoints: [],
        },
      ],
      updatedAt: now,
    },
  };
};

const sessionSetItem = (
  sequence: number,
  status: "running" | "completed",
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-transport-${sequence}`),
    threadId,
    runId: turnId,
    occurredAt: now,
    type: "run.updated",
    payload: makeRun(status),
  },
});

interface HttpRoutes {
  readonly ticketResponse?: () => Response | Promise<Response>;
  readonly threadResponse?: () => Response;
  readonly snapshotResponse?: () => Response;
}

const transportLayer = (
  requests: Array<Request>,
  routes: HttpRoutes = {},
  wsOptions: { readonly autoOpen?: boolean } = {},
) => {
  FakeWebSocket.reset();
  let ticketSequence = 0;
  return Layer.mergeAll(
    fetchLayer((async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/websocket-ticket") {
        if (routes.ticketResponse) return await routes.ticketResponse();
        ticketSequence += 1;
        return jsonResponse({
          ticket: `ticket-${ticketSequence}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname === `/api/orchestration/threads/${threadId}`) {
        return (routes.threadResponse ?? (() => jsonResponse(snapshotFixture(5).detail)))();
      }
      if (url.pathname === "/api/orchestration/snapshot") {
        return (routes.snapshotResponse ?? (() => jsonResponse(snapshotFixture(5).metadata)))();
      }
      return jsonResponse(
        {
          _tag: "EnvironmentInternalError",
          code: "internal_error",
          reason: "unexpected_route",
          traceId: "0123456789abcdef0123456789abcdef",
        },
        500,
      );
    }) as typeof globalThis.fetch),
    makeWebSocketLayer(wsOptions),
  );
};

const makeTransport = (
  requests: Array<Request>,
  routes: HttpRoutes = {},
  wsOptions: { readonly autoOpen?: boolean } = {},
) =>
  makeRemoteWatchTransport({
    httpBaseUrl: "https://remote.example/h?route=blue&route=green",
    accessToken,
    threadId,
  }).pipe(Effect.provide(transportLayer(requests, routes, wsOptions)));

interface SubscribeInput {
  readonly threadId: ThreadId;
  readonly afterSequence: number;
  readonly targetTurnId: RunId;
  readonly observedRunning: boolean;
  readonly interactionAware: boolean;
}

const subscribeInput = (over: Partial<SubscribeInput> = {}): SubscribeInput => ({
  threadId,
  afterSequence: 5,
  targetTurnId: turnId,
  observedRunning: false,
  interactionAware: false,
  ...over,
});

describe("remote watch transport", () => {
  it.effect("readThread routes the native HTTP thread snapshot with bearer auth", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);
      const snapshot = yield* transport.readThread();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.projection.thread.id, threadId);
      assert.equal(snapshot.activeRunId, turnId);
      const request = requests[0]!;
      assert.equal(new URL(request.url).pathname, `/api/orchestration/threads/${threadId}`);
      assert.equal(new URL(request.url).searchParams.get("route"), "blue");
      assert.equal(request.headers.get("authorization"), `Bearer ${accessToken}`);
      const metadataRequest = requests[1]!;
      assert.equal(new URL(metadataRequest.url).pathname, "/api/orchestration/snapshot");
      assert.equal(metadataRequest.headers.get("authorization"), `Bearer ${accessToken}`);
      assert.isTrue(requests.indexOf(request) < requests.indexOf(metadataRequest));
      assert.isTrue(FakeWebSocket.instances.every((instance) => instance.closed));
    });
  });

  it.effect("readThread classifies credential failures as auth", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests, {
        threadResponse: () =>
          jsonResponse(
            {
              _tag: "EnvironmentAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_credential",
              traceId: "0123456789abcdef0123456789abcdef",
            },
            401,
          ),
      });
      const failure = yield* transport.readThread().pipe(Effect.flip);

      assert.isTrue(isRemoteWatchFailure(failure));
      assert.equal(failure.kind, "auth");
    });
  });

  it.effect(
    "subscribeThread mints a fresh ticket per attempt and builds the /ws URL with routing pairs and no bearer",
    () => {
      const requests: Array<Request> = [];
      return Effect.gen(function* () {
        const transport = yield* makeTransport(requests);

        const fiber = yield* Effect.forkScoped(transport.subscribeThread(subscribeInput()));
        yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
        const socket = FakeWebSocket.instances[0]!;
        yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");

        const expectedUrl = new URL("wss://remote.example/ws?route=blue&route=green");
        expectedUrl.searchParams.set("wsTicket", "ticket-1");
        assert.equal(socket.url, expectedUrl.toString());
        assert.isFalse(socket.url.includes(accessToken));

        const ticketRequest = requests.find(
          (request) => new URL(request.url).pathname === "/api/auth/websocket-ticket",
        )!;
        assert.equal(ticketRequest.headers.get("authorization"), `Bearer ${accessToken}`);
        assert.equal(new URL(ticketRequest.url).searchParams.get("route"), "blue");

        yield* Fiber.interrupt(fiber);
        yield* waitFor(() => socket.closed, "socket release");
      });
    },
  );

  it.effect("subscribeThread reuses the routing cursor in the native subscribe payload", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const fiber = yield* Effect.forkScoped(
        transport.subscribeThread(subscribeInput({ afterSequence: 12 })),
      );
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
      const socket = FakeWebSocket.instances[0]!;
      yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");

      const request = requiredRequestFrame(socket);
      assert.equal(request.tag, ORCHESTRATION_V2_WS_METHODS.subscribeThread);
      assert.equal(request.payload.threadId, threadId);
      assert.equal(request.payload.afterSequence, 12);

      yield* Fiber.interrupt(fiber);
      yield* waitFor(() => socket.closed, "socket release");
    });
  });

  it.effect("subscribeThread streams native items to a terminal observation", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const fiber = yield* Effect.forkScoped(
        transport.subscribeThread(subscribeInput({ observedRunning: true })),
      );
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
      const socket = FakeWebSocket.instances[0]!;
      yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");
      const requestId = requiredRequestFrame(socket).id;

      socket.serverSend({
        _tag: "Chunk",
        requestId,
        values: [sessionSetItem(6, "running")],
      });
      socket.serverSend({
        _tag: "Chunk",
        requestId,
        values: [sessionSetItem(7, "completed")],
      });

      const observation = yield* Fiber.join(fiber);
      assert.deepEqual(observation, {
        status: "completed",
        lastSequence: 7,
        observedRunning: true,
      });
      assert.isTrue(socket.closed);
    });
  });

  it.effect("un-decodable frames classify as protocol failures", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const fiber = yield* Effect.forkScoped(transport.subscribeThread(subscribeInput()));
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
      const socket = FakeWebSocket.instances[0]!;
      yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");

      socket.serverSend("not-json{{");

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(failure));
      assert.equal(failure.kind, "protocol");
      assert.isTrue(socket.closed);
    });
  });

  it.effect("connection close classifies as transport and preserves observer state", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const fiber = yield* Effect.forkScoped(
        transport.subscribeThread(subscribeInput({ observedRunning: true })),
      );
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
      const socket = FakeWebSocket.instances[0]!;
      yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");
      const requestId = requiredRequestFrame(socket).id;

      socket.serverSend({
        _tag: "Chunk",
        requestId,
        values: [sessionSetItem(6, "running")],
      });
      yield* waitFor(() => socket.sent.some((frame) => frame._tag === "Ack"), "ack");
      socket.close(1006, "abrupt");

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(failure));
      assert.equal(failure.kind, "transport");
      assert.equal(failure.lastSequence, 6);
      assert.equal(failure.observedRunning, true);
      assert.isTrue(socket.closed);
    });
  });

  it.effect("an ambiguous 404 ticket endpoint classifies as protocol, never as fallback", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests, {
        ticketResponse: () => new Response(null, { status: 404 }),
      });
      const failure = yield* transport.subscribeThread(subscribeInput()).pipe(Effect.flip);

      assert.isTrue(isRemoteWatchFailure(failure));
      // A bare 404 is not an agreed "unsupported" signal, so it must not
      // trigger the watch loop's polling fallback. No confirmed unsupported
      // case exists to test `unavailable` with until such a signal is
      // specified on the wire; the transport intentionally never produces it.
      assert.equal(failure.kind, "protocol");
      assert.deepEqual(FakeWebSocket.instances, []);
    });
  });

  it.effect(
    "valid-JSON schema-invalid Chunk after progress is a sanitized protocol failure",
    () => {
      const requests: Array<Request> = [];
      const consoleLines: Array<string> = [];
      const recordConsole = (format: unknown, args: ReadonlyArray<unknown>) => {
        consoleLines.push(JSON.stringify([format, ...args]));
      };
      const originalLog = console.log;
      const originalError = console.error;
      console.log = recordConsole as typeof console.log;
      console.error = recordConsole as typeof console.error;
      // Recording tracer sentinel: spans (with their events and attributes)
      // are captured so the test can prove the malformed payload never leaks
      // into tracing output either.
      const spans: Array<Tracer.NativeSpan> = [];
      const recordingTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const spanText = () => {
        const parts: Array<string> = [];
        for (const span of spans) {
          parts.push(span.name);
          for (const [key, value] of span.attributes) parts.push(`${key}=${String(value)}`);
          for (const [name, , attributes] of span.events) {
            parts.push(name);
            for (const [eventKey, eventValue] of Object.entries(attributes ?? {})) {
              parts.push(`${eventKey}=${String(eventValue)}`);
            }
          }
        }
        return parts.join("\n");
      };
      return Effect.gen(function* () {
        const transport = yield* makeTransport(requests);

        const fiber = yield* Effect.forkScoped(
          transport.subscribeThread(subscribeInput({ observedRunning: true })),
        );
        yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
        const socket = FakeWebSocket.instances[0]!;
        yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");
        const requestId = requiredRequestFrame(socket).id;

        socket.serverSend({
          _tag: "Chunk",
          requestId,
          values: [sessionSetItem(6, "running")],
        });
        yield* waitFor(() => socket.sent.some((frame) => frame._tag === "Ack"), "ack");
        socket.serverSend({
          _tag: "Chunk",
          requestId,
          values: [{ kind: "mystery-frame" }],
        });

        const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
        assert.isTrue(isRemoteWatchFailure(failure));
        assert.equal(failure.kind, "protocol");
        assert.equal(failure.lastSequence, 6);
        assert.equal(failure.observedRunning, true);
        assert.isTrue(socket.closed);

        const captured = consoleLines.join("\n");
        assert.isFalse(captured.includes("mystery-frame"));
        assert.isFalse(captured.includes("SchemaError"));
        assert.isFalse(captured.includes("thread-transport"));

        const traced = spanText();
        assert.isFalse(traced.includes("mystery-frame"));
        assert.isFalse(traced.includes("SchemaError"));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            console.log = originalLog;
            console.error = originalError;
          }),
        ),
        Effect.provide(Layer.succeed(Tracer.Tracer, recordingTracer)),
      );
    },
  );

  it.effect("websocket send failure after progress classifies as transport and cleans up", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const fiber = yield* Effect.forkScoped(
        transport.subscribeThread(subscribeInput({ observedRunning: true })),
      );
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
      const socket = FakeWebSocket.instances[0]!;
      yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");
      const requestId = requiredRequestFrame(socket).id;

      socket.serverSend({
        _tag: "Chunk",
        requestId,
        values: [sessionSetItem(6, "running")],
      });
      yield* waitFor(() => socket.sent.some((frame) => frame._tag === "Ack"), "ack");

      // Writes are now broken: the next native client write (the Ack for the
      // incoming chunk) fails, which is the earliest native path that lets a
      // write error surface to an in-flight subscription after progress.
      socket.send = () => {
        throw new Error("socket gone");
      };
      socket.serverSend({
        _tag: "Chunk",
        requestId,
        values: [sessionSetItem(7, "running")],
      });

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(failure));
      assert.equal(failure.kind, "transport");
      assert.isTrue(failure.observedRunning === true);
      assert.isTrue(failure.lastSequence === 6 || failure.lastSequence === 7);
      assert.isTrue(socket.closed);
      assert.isEmpty(socket.handlers.get("message") ?? []);
    });
  });

  it.effect("valid-JSON schema-invalid Exit after progress is a sanitized protocol failure", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const fiber = yield* Effect.forkScoped(
        transport.subscribeThread(subscribeInput({ observedRunning: true })),
      );
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
      const socket = FakeWebSocket.instances[0]!;
      yield* waitFor(() => socket.requestFrame() !== undefined, "rpc request");
      const requestId = requiredRequestFrame(socket).id;

      socket.serverSend({
        _tag: "Chunk",
        requestId,
        values: [sessionSetItem(6, "running")],
      });
      yield* waitFor(() => socket.sent.some((frame) => frame._tag === "Ack"), "ack");
      socket.serverSend({ _tag: "Exit", requestId, exit: { _tag: "Bogus" } });

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(failure));
      assert.equal(failure.kind, "protocol");
      assert.equal(failure.lastSequence, 6);
      assert.equal(failure.observedRunning, true);
      assert.isTrue(socket.closed);
    });
  });

  it.effect("two sequential subscription attempts mint distinct fresh tickets", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const first = yield* Effect.forkScoped(transport.subscribeThread(subscribeInput()));
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "first socket");
      const firstSocket = FakeWebSocket.instances[0]!;
      yield* waitFor(() => firstSocket.requestFrame() !== undefined, "first rpc request");
      assert.isTrue(firstSocket.url.includes("wsTicket=ticket-1"));
      firstSocket.close(1006, "abrupt");
      const firstFailure = yield* Fiber.join(first).pipe(Effect.flip);
      assert.equal(firstFailure.kind, "transport");
      assert.isTrue(firstSocket.closed);

      const second = yield* Effect.forkScoped(transport.subscribeThread(subscribeInput()));
      yield* waitFor(() => FakeWebSocket.instances.length > 1, "second socket");
      const secondSocket = FakeWebSocket.instances[1]!;
      yield* waitFor(() => secondSocket.requestFrame() !== undefined, "second rpc request");
      assert.isTrue(secondSocket.url.includes("wsTicket=ticket-2"));
      yield* Fiber.interrupt(second);
      yield* waitFor(() => secondSocket.closed, "second socket release");

      const ticketRequests = requests.filter(
        (request) => new URL(request.url).pathname === "/api/auth/websocket-ticket",
      );
      assert.lengthOf(ticketRequests, 2);
    });
  });

  it.effect("interrupting a pending ticket request cancels before any socket opens", () => {
    const requests: Array<Request> = [];
    let gateResolve: ((response: Response) => void) | undefined;
    const gate: { readonly ticket: Promise<Response> } = {
      ticket: new Promise<Response>((resolve) => {
        gateResolve = resolve;
      }),
    };
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests, {
        ticketResponse: () => gate.ticket,
      });

      const fiber = yield* Effect.forkScoped(transport.subscribeThread(subscribeInput()));
      yield* waitFor(
        () =>
          requests.some(
            (request) => new URL(request.url).pathname === "/api/auth/websocket-ticket",
          ) && gateResolve !== undefined,
        "ticket request in flight",
      );

      yield* Fiber.interrupt(fiber);
      gateResolve?.(jsonResponse({ ticket: "late-ticket", expiresAt: "2099-01-01T00:00:00.000Z" }));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.deepEqual(FakeWebSocket.instances, []);
      const ticketRequests = requests.filter(
        (request) => new URL(request.url).pathname === "/api/auth/websocket-ticket",
      );
      assert.lengthOf(ticketRequests, 1);
    });
  });

  it.effect("websocket open timeout releases the connection resources deterministically", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests, {}, { autoOpen: false });

      const fiber = yield* Effect.forkScoped(transport.subscribeThread(subscribeInput()));
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket constructed");
      const socket = FakeWebSocket.instances[0]!;
      assert.isFalse(socket.closed);

      yield* TestClock.adjust(Duration.seconds(15));

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(failure));
      assert.equal(failure.kind, "transport");
      assert.isTrue(socket.closed);
    });
  });

  it.effect(
    "raw 401/403 with non-contract bodies classify as auth on native HTTP and ticket endpoints",
    () => {
      const requests: Array<Request> = [];
      return Effect.gen(function* () {
        const snapshotTransport = yield* makeTransport(requests, {
          threadResponse: () => new Response("denied", { status: 401 }),
        });
        const snapshotFailure = yield* snapshotTransport.readThread().pipe(Effect.flip);
        assert.isTrue(isRemoteWatchFailure(snapshotFailure));
        assert.equal(snapshotFailure.kind, "auth");

        const metadataTransport = yield* makeTransport(requests, {
          snapshotResponse: () => new Response("denied", { status: 403 }),
        });
        const metadataFailure = yield* metadataTransport.readThread().pipe(Effect.flip);
        assert.isTrue(isRemoteWatchFailure(metadataFailure));
        assert.equal(metadataFailure.kind, "auth");

        const ticketTransport = yield* makeTransport(requests, {
          ticketResponse: () => new Response("forbidden", { status: 403 }),
        });
        const ticketFailure = yield* ticketTransport
          .subscribeThread(subscribeInput())
          .pipe(Effect.flip);
        assert.isTrue(isRemoteWatchFailure(ticketFailure));
        assert.equal(ticketFailure.kind, "auth");
        assert.deepEqual(FakeWebSocket.instances, []);
      });
    },
  );

  it.effect("successful schema-invalid responses classify as protocol", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const snapshotTransport = yield* makeTransport(requests, {
        threadResponse: () => jsonResponse({ unexpected: "shape" }),
      });
      const snapshotFailure = yield* snapshotTransport.readThread().pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(snapshotFailure));
      assert.equal(snapshotFailure.kind, "protocol");

      const metadataTransport = yield* makeTransport(requests, {
        snapshotResponse: () => jsonResponse({ bogus: true }),
      });
      const metadataFailure = yield* metadataTransport.readThread().pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(metadataFailure));
      assert.equal(metadataFailure.kind, "protocol");

      const ticketTransport = yield* makeTransport(requests, {
        ticketResponse: () => jsonResponse({ bogus: true }),
      });
      const ticketFailure = yield* ticketTransport
        .subscribeThread(subscribeInput())
        .pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(ticketFailure));
      assert.equal(ticketFailure.kind, "protocol");
      assert.deepEqual(FakeWebSocket.instances, []);
    });
  });

  it.effect("connection-level endpoint failures classify as transport", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests, {
        ticketResponse: () => Promise.reject(new Error("connection reset")),
      });
      const failure = yield* transport.subscribeThread(subscribeInput()).pipe(Effect.flip);
      assert.isTrue(isRemoteWatchFailure(failure));
      assert.equal(failure.kind, "transport");
      assert.deepEqual(FakeWebSocket.instances, []);
    });
  });

  it.effect("cancelled subscriptions release their connection and listeners", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const transport = yield* makeTransport(requests);

      const fiber = yield* Effect.forkScoped(transport.subscribeThread(subscribeInput()));
      yield* waitFor(() => FakeWebSocket.instances.length > 0, "socket open");
      const socket = FakeWebSocket.instances[0]!;

      yield* Fiber.interrupt(fiber);
      yield* waitFor(() => socket.closed, "socket release");
      // The native socket removes its traffic listeners on release, so a
      // closed socket processes no frames; residual inert registrations on
      // lifecycle events belong to effect's socket internals, not the transport.
      assert.isEmpty(socket.handlers.get("message") ?? []);
    });
  });
});
