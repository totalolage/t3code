import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import type {
  HermesGatewayClient,
  HermesMessageResource,
  HermesSseEvent,
} from "../hermes/HermesGatewayClient.ts";

const PROVIDER = ProviderDriverKind.make("hermes");

interface HermesActiveTurn {
  readonly turnId: TurnId;
  readonly assistantItemId: RuntimeItemId;
  readonly emittedText: { value: string };
  readonly toolItemIds: Map<string, RuntimeItemId[]>;
  fiber?: Fiber.Fiber<void, never>;
  completed: boolean;
}

interface HermesSessionContext {
  session: ProviderSession;
  readonly hermesSessionId: string;
  readonly sessionScope: Scope.Closeable;
  activeTurn?: HermesActiveTurn;
  closed: boolean;
}

export interface HermesAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly client?: HermesGatewayClient;
  readonly enabled: boolean;
}

function resumeSessionId(cursor: unknown): string | undefined {
  if (typeof cursor === "string" && cursor.trim()) return cursor.trim();
  if (cursor && typeof cursor === "object" && "sessionId" in cursor) {
    const value = (cursor as { readonly sessionId?: unknown }).sessionId;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
  return undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function eventMessageId(event: HermesSseEvent): string | undefined {
  const direct = stringField(event.data, "message_id");
  if (direct) return direct;
  const message = event.data.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  return stringField(message as Readonly<Record<string, unknown>>, "id");
}

function toolItemType(name: string) {
  const normalized = name.toLowerCase();
  if (
    normalized.includes("terminal") ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return "command_execution" as const;
  }
  if (normalized.includes("write") || normalized.includes("edit") || normalized.includes("patch")) {
    return "file_change" as const;
  }
  if (normalized.includes("web") || normalized.includes("search")) return "web_search" as const;
  return "dynamic_tool_call" as const;
}

function messageText(message: HermesMessageResource): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("text" in part)) return [];
      return typeof part.text === "string" ? [part.text] : [];
    })
    .join("");
  return text || undefined;
}

export const makeHermesAdapter = Effect.fn("makeHermesAdapter")(function* (
  options: HermesAdapterOptions,
): Effect.fn.Return<
  ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterSessionClosedError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  >,
  never,
  Crypto.Crypto | Scope.Scope
> {
  const crypto = yield* Crypto.Crypto;
  const adapterScope = yield* Effect.scope;
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, HermesSessionContext>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(events, event).pipe(Effect.orDie, Effect.asVoid);
  const eventBase = Effect.fn("HermesAdapter.eventBase")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
    readonly itemId?: RuntimeItemId;
  }) {
    return {
      eventId: EventId.make(yield* uuid),
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      threadId: input.threadId,
      createdAt: yield* nowIso,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: input.itemId } : {}),
    };
  });

  const request = <T>(method: string, run: (signal: AbortSignal) => Promise<T>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: `Hermes gateway request '${method}' failed.`,
          cause,
        }),
    });

  const requireClient = Effect.fn("HermesAdapter.requireClient")(function* () {
    if (!options.enabled) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "connect",
        issue: "Hermes is disabled for this provider instance.",
      });
    }
    if (!options.client) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "connect",
        issue: "Configure a valid gateway URL and shared secret before starting a session.",
      });
    }
    return options.client;
  });

  const getContext = Effect.fn("HermesAdapter.getContext")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    if (context.closed) {
      return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
    }
    return context;
  });

  const updateReady = Effect.fn("HermesAdapter.updateReady")(function* (
    context: HermesSessionContext,
    lastError?: string,
  ) {
    const updatedAt = yield* nowIso;
    const { activeTurnId: _active, lastError: _lastError, ...rest } = context.session;
    context.session = {
      ...rest,
      status: lastError ? "error" : "ready",
      updatedAt,
      ...(lastError ? { lastError } : {}),
    };
    delete context.activeTurn;
  });

  const handleSseEvent = Effect.fn("HermesAdapter.handleSseEvent")(function* (
    context: HermesSessionContext,
    active: HermesActiveTurn,
    event: HermesSseEvent,
  ) {
    const messageId = eventMessageId(event);
    const itemId = messageId ? RuntimeItemId.make(messageId) : active.assistantItemId;
    switch (event.event) {
      case "message.started":
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            turnId: active.turnId,
            itemId,
          })),
          type: "item.started",
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        return;
      case "assistant.delta": {
        const delta = typeof event.data.delta === "string" ? event.data.delta : "";
        if (!delta) return;
        active.emittedText.value += delta;
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            turnId: active.turnId,
            itemId,
          })),
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta },
        });
        return;
      }
      case "assistant.completed": {
        const content = typeof event.data.content === "string" ? event.data.content : "";
        if (content && !active.emittedText.value) {
          active.emittedText.value = content;
          yield* emit({
            ...(yield* eventBase({
              threadId: context.session.threadId,
              turnId: active.turnId,
              itemId,
            })),
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: content },
          });
        }
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            turnId: active.turnId,
            itemId,
          })),
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "completed" },
        });
        return;
      }
      case "tool.progress": {
        const toolName = stringField(event.data, "tool_name");
        const summary = stringField(event.data, "delta") ?? stringField(event.data, "preview");
        yield* emit({
          ...(yield* eventBase({ threadId: context.session.threadId, turnId: active.turnId })),
          type: "tool.progress",
          payload: { ...(toolName ? { toolName } : {}), ...(summary ? { summary } : {}) },
        });
        return;
      }
      case "tool.started": {
        const toolName = stringField(event.data, "tool_name") ?? "Hermes tool";
        const toolId = RuntimeItemId.make(`hermes-tool-${yield* uuid}`);
        const ids = active.toolItemIds.get(toolName) ?? [];
        ids.push(toolId);
        active.toolItemIds.set(toolName, ids);
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            turnId: active.turnId,
            itemId: toolId,
          })),
          type: "item.started",
          payload: {
            itemType: toolItemType(toolName),
            status: "inProgress",
            title: toolName,
            ...(event.data.preview ? { detail: String(event.data.preview) } : {}),
          },
        });
        return;
      }
      case "tool.completed":
      case "tool.failed": {
        const toolName = stringField(event.data, "tool_name") ?? "Hermes tool";
        const ids = active.toolItemIds.get(toolName) ?? [];
        const toolId = ids.shift();
        if (!toolId) return;
        yield* emit({
          ...(yield* eventBase({
            threadId: context.session.threadId,
            turnId: active.turnId,
            itemId: toolId,
          })),
          type: "item.completed",
          payload: {
            itemType: toolItemType(toolName),
            status: event.event === "tool.failed" ? "failed" : "completed",
            title: toolName,
          },
        });
        return;
      }
      case "run.completed":
        active.completed = true;
        yield* emit({
          ...(yield* eventBase({ threadId: context.session.threadId, turnId: active.turnId })),
          type: "turn.completed",
          payload: { state: "completed", ...(event.data.usage ? { usage: event.data.usage } : {}) },
        });
        return;
      case "error":
        throw new Error("Hermes reported a run error.");
      default:
        return;
    }
  });

  const runTurn = Effect.fn("HermesAdapter.runTurn")(function* (
    context: HermesSessionContext,
    active: HermesActiveTurn,
    input: ProviderSendTurnInput,
  ) {
    return yield* requireClient().pipe(
      Effect.flatMap((client) =>
        request("session-chat-stream", (signal) =>
          client.streamSessionChat(
            context.hermesSessionId,
            { message: input.input ?? "" },
            (event) => runPromise(handleSseEvent(context, active, event)),
            signal,
          ),
        ),
      ),
      Effect.flatMap(() =>
        active.completed
          ? updateReady(context)
          : Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session-chat-stream",
                detail: "Hermes ended the event stream before completing the run.",
              }),
            ),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (!active.completed) {
            yield* emit({
              ...(yield* eventBase({
                threadId: context.session.threadId,
                turnId: active.turnId,
              })),
              type: "runtime.error",
              payload: { message: "Hermes turn failed.", class: "provider_error" },
            });
            yield* emit({
              ...(yield* eventBase({
                threadId: context.session.threadId,
                turnId: active.turnId,
              })),
              type: "turn.completed",
              payload: { state: "failed", errorMessage: "Hermes turn failed." },
            });
          }
          yield* updateReady(context, "Hermes turn failed.");
          yield* Effect.logWarning("Hermes turn failed", { errorTag: error._tag });
        }),
      ),
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          if (!active.completed) {
            yield* emit({
              ...(yield* eventBase({
                threadId: context.session.threadId,
                turnId: active.turnId,
              })),
              type: "turn.aborted",
              payload: { reason: "Turn interrupted." },
            });
            yield* emit({
              ...(yield* eventBase({
                threadId: context.session.threadId,
                turnId: active.turnId,
              })),
              type: "turn.completed",
              payload: { state: "interrupted", stopReason: "interrupted" },
            });
          }
          yield* updateReady(context);
        }),
      ),
    );
  });

  const startSession = Effect.fn("HermesAdapter.startSession")(function* (
    input: ProviderSessionStartInput,
  ) {
    if (input.runtimeMode !== "full-access") {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue:
          "Hermes does not expose T3 runtime-mode enforcement; select Full access or enforce restrictions at the gateway.",
      });
    }
    if (sessions.has(input.threadId)) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `A Hermes session already exists for thread ${input.threadId}.`,
      });
    }
    const client = yield* requireClient();
    const resumedId = resumeSessionId(input.resumeCursor);
    const createInput = input.modelSelection?.model ? { model: input.modelSelection.model } : {};
    const remoteSession = resumedId
      ? yield* request("get-session", (signal) => client.getSession(resumedId, signal))
      : yield* request("create-session", (signal) => client.createSession(createInput, signal));
    const sessionScope = yield* Scope.make();
    yield* Scope.addFinalizer(
      adapterScope,
      Scope.close(sessionScope, Exit.void).pipe(Effect.ignore),
    );
    const timestamp = yield* nowIso;
    const session: ProviderSession = {
      provider: PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(remoteSession.model
        ? { model: remoteSession.model }
        : input.modelSelection?.model
          ? { model: input.modelSelection.model }
          : {}),
      threadId: input.threadId,
      resumeCursor: { sessionId: remoteSession.id },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const context: HermesSessionContext = {
      session,
      hermesSessionId: remoteSession.id,
      sessionScope,
      closed: false,
    };
    sessions.set(input.threadId, context);
    yield* emit({
      ...(yield* eventBase({ threadId: input.threadId })),
      type: "session.started",
      payload: { resume: { sessionId: remoteSession.id } },
    });
    yield* emit({
      ...(yield* eventBase({ threadId: input.threadId })),
      type: "thread.started",
      payload: { providerThreadId: remoteSession.id },
    });
    return session;
  });

  const sendTurn = Effect.fn("HermesAdapter.sendTurn")(function* (input: ProviderSendTurnInput) {
    const context = yield* getContext(input.threadId);
    if (context.activeTurn) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "A Hermes turn is already running for this thread.",
      });
    }
    if (!input.input?.trim()) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Hermes currently requires a text message.",
      });
    }
    if (input.attachments && input.attachments.length > 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Hermes attachments are not supported in this release.",
      });
    }
    const turnId = TurnId.make(yield* uuid);
    const assistantItemId = RuntimeItemId.make(`hermes-message-${yield* uuid}`);
    const active: HermesActiveTurn = {
      turnId,
      assistantItemId,
      emittedText: { value: "" },
      toolItemIds: new Map(),
      completed: false,
    };
    context.activeTurn = active;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt: yield* nowIso,
    };
    yield* emit({
      ...(yield* eventBase({ threadId: input.threadId, turnId })),
      type: "turn.started",
      payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
    });
    active.fiber = yield* runTurn(context, active, input).pipe(Effect.forkIn(context.sessionScope));
    return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
  });

  const interruptTurn = Effect.fn("HermesAdapter.interruptTurn")(function* (
    threadId: ThreadId,
    turnId?: TurnId,
  ) {
    const context = yield* getContext(threadId);
    const active = context.activeTurn;
    if (!active || (turnId && active.turnId !== turnId)) return;
    if (active.fiber) yield* Fiber.interrupt(active.fiber).pipe(Effect.asVoid);
  });

  const stopSession = Effect.fn("HermesAdapter.stopSession")(function* (threadId: ThreadId) {
    const context = yield* getContext(threadId);
    if (context.activeTurn?.fiber)
      yield* Fiber.interrupt(context.activeTurn.fiber).pipe(Effect.asVoid);
    context.closed = true;
    sessions.delete(threadId);
    yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
    yield* emit({
      ...(yield* eventBase({ threadId })),
      type: "session.exited",
      payload: { reason: "Session stopped.", recoverable: true, exitKind: "graceful" },
    });
  });

  const readThread = Effect.fn("HermesAdapter.readThread")(function* (threadId: ThreadId) {
    const context = yield* getContext(threadId);
    const client = yield* requireClient();
    const messages = yield* request("session-messages", (signal) =>
      client.listMessages(context.hermesSessionId, signal),
    );
    const turns = messages.flatMap((message, index) => {
      if (message.role !== "assistant") return [];
      return [
        {
          id: TurnId.make(message.id ?? `hermes-history-${index}`),
          items: [{ ...message, content: messageText(message) ?? message.content }],
        },
      ];
    });
    return { threadId, turns } satisfies ProviderThreadSnapshot;
  });

  const unsupportedResponse = (operation: string) =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: `Hermes does not support ${operation} through the session API.`,
      }),
    );

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const contexts = [...sessions.values()];
      sessions.clear();
      yield* Effect.forEach(contexts, (context) => Scope.close(context.sessionScope, Exit.void), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.ignore);
      yield* Queue.shutdown(events).pipe(Effect.orDie);
    }),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest: (_threadId: ThreadId, _requestId: ApprovalRequestId) =>
      unsupportedResponse("interactive approvals"),
    respondToUserInput: (_threadId: ThreadId, _requestId: ApprovalRequestId) =>
      unsupportedResponse("structured user input"),
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread,
    rollbackThread: () => unsupportedResponse("thread rollback"),
    stopAll: () =>
      Effect.forEach([...sessions.keys()], stopSession, { discard: true }).pipe(Effect.asVoid),
    get streamEvents() {
      return Stream.fromQueue(events);
    },
  } satisfies ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterSessionClosedError
    | ProviderAdapterSessionNotFoundError
    | ProviderAdapterValidationError
  >;
});
