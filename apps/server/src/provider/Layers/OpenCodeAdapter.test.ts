import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    createdSessionIds: [] as string[],
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    abortSignals: [] as AbortSignal[],
    abortImplementation: null as
      | ((sessionID: string, signal?: AbortSignal) => Promise<void>)
      | null,
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    messageCalls: [] as Array<{ sessionID: string; messageID: string }>,
    messageFailures: 0,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    promptAsyncImplementation: null as (() => Promise<void>) | null,
    autoPromptEcho: true,
    autoConnect: true,
    promptEchoEvents: [] as Array<unknown>,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as Array<unknown | Promise<unknown>>,
    eventSubscribeObserved: null as (() => void) | null,
    permissionReplyCalls: [] as Array<{ requestID: string; reply: string }>,
    questionReplyCalls: [] as Array<{
      requestID: string;
      answers: ReadonlyArray<ReadonlyArray<string>>;
    }>,
    sessionStatus: "idle" as "idle" | "busy",
    sessionStatusFailures: 0,
    sessionStatusCalls: 0,
    sessionStatusImplementation: null as (() => Promise<unknown>) | null,
    sessionGetIds: [] as string[],
    sessionGetObserved: null as ((sessionID: string) => void) | null,
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionDirectoryById: new Map<string, string>(),
    sessionParentById: new Map<string, string>(),
    pendingPermissions: [] as Array<PermissionRequest>,
    pendingQuestions: [] as Array<QuestionRequest>,
    permissionListCalls: 0,
    questionListCalls: 0,
    permissionListImplementation: null as (() => Promise<Array<PermissionRequest>>) | null,
    questionListImplementation: null as (() => Promise<Array<QuestionRequest>>) | null,
    sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
    forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.sessionCreateInputs.length = 0;
    this.state.createdSessionIds.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.abortSignals.length = 0;
    this.state.abortImplementation = null;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.messageCalls.length = 0;
    this.state.messageFailures = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.promptAsyncImplementation = null;
    this.state.autoPromptEcho = true;
    this.state.autoConnect = true;
    this.state.promptEchoEvents.length = 0;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.eventSubscribeObserved = null;
    this.state.permissionReplyCalls.length = 0;
    this.state.questionReplyCalls.length = 0;
    this.state.sessionStatus = "idle";
    this.state.sessionStatusFailures = 0;
    this.state.sessionStatusCalls = 0;
    this.state.sessionStatusImplementation = null;
    this.state.sessionGetIds.length = 0;
    this.state.sessionGetObserved = null;
    this.state.missingSessionIds.clear();
    this.state.transientErrorSessionIds.clear();
    this.state.sessionDirectoryById.clear();
    this.state.sessionParentById.clear();
    this.state.pendingPermissions = [];
    this.state.pendingQuestions = [];
    this.state.permissionListCalls = 0;
    this.state.questionListCalls = 0;
    this.state.permissionListImplementation = null;
    this.state.questionListImplementation = null;
    this.state.sessionUpdateCalls.length = 0;
    this.state.forkCalls.length = 0;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, serverPassword }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        version: "1.15.13",
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Always register a finalizer so the closeCalls/closeError probes fire;
      // production attaches none for external servers.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        version: "1.15.13",
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.sessionCreateInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return {
            data: { id: runtimeMock.state.createdSessionIds.shift() ?? `${baseUrl}/session` },
          };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetIds.push(sessionID);
          runtimeMock.state.sessionGetObserved?.(sessionID);
          // The real client is `throwOnError: true`: non-2xx rejects rather
          // than resolving, so missing → 404 throw, transient → 500 throw.
          if (runtimeMock.state.transientErrorSessionIds.has(sessionID)) {
            throw new Error("opencode server error", { cause: { status: 500 } });
          }
          if (runtimeMock.state.missingSessionIds.has(sessionID)) {
            throw new Error(`Session not found: ${sessionID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          const directory = runtimeMock.state.sessionDirectoryById.get(sessionID);
          const parentID = runtimeMock.state.sessionParentById.get(sessionID);
          return {
            data: {
              id: sessionID,
              ...(directory ? { directory } : {}),
              ...(parentID ? { parentID } : {}),
            },
          };
        },
        update: async ({ sessionID, permission }: { sessionID: string; permission: unknown }) => {
          runtimeMock.state.sessionUpdateCalls.push({ sessionID, permission });
          return { data: { id: sessionID } };
        },
        fork: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
          // Fork clones history into a new session bound to the directory.
          const forkedId = `${sessionID}_fork`;
          runtimeMock.state.forkCalls.push({ sessionID, ...(directory ? { directory } : {}) });
          if (directory) {
            runtimeMock.state.sessionDirectoryById.set(forkedId, directory);
          }
          return { data: { id: forkedId, ...(directory ? { directory } : {}) } };
        },
        abort: async ({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) => {
          runtimeMock.state.abortCalls.push(sessionID);
          if (options?.signal) {
            runtimeMock.state.abortSignals.push(options.signal);
          }
          await runtimeMock.state.abortImplementation?.(sessionID, options?.signal);
        },
        status: async () => {
          runtimeMock.state.sessionStatusCalls += 1;
          if (runtimeMock.state.sessionStatusImplementation) {
            return await runtimeMock.state.sessionStatusImplementation();
          }
          if (runtimeMock.state.sessionStatusFailures > 0) {
            runtimeMock.state.sessionStatusFailures -= 1;
            throw new Error("status failed");
          }
          return {
            data:
              runtimeMock.state.sessionStatus === "idle"
                ? {}
                : { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          await runtimeMock.state.promptAsyncImplementation?.();
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
          if (
            runtimeMock.state.autoPromptEcho &&
            typeof input === "object" &&
            input !== null &&
            "sessionID" in input &&
            "messageID" in input &&
            typeof input.sessionID === "string" &&
            typeof input.messageID === "string"
          ) {
            runtimeMock.state.messages.push({
              info: { id: input.messageID, role: "user" },
              parts: [],
            });
            runtimeMock.state.promptEchoEvents.push({
              id: `evt-auto-user-${input.messageID}`,
              type: "message.updated",
              properties: {
                sessionID: input.sessionID,
                info: { id: input.messageID, role: "user" },
              },
            });
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        message: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
          runtimeMock.state.messageCalls.push({ sessionID, messageID });
          if (runtimeMock.state.messageFailures > 0) {
            runtimeMock.state.messageFailures -= 1;
            throw new Error("message lookup failed", { cause: { status: 500 } });
          }
          const message = runtimeMock.state.messages.find((entry) => entry.info.id === messageID);
          if (!message) {
            throw new Error(`Message not found: ${messageID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          return { data: message };
        },
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => {
          runtimeMock.state.eventSubscribeObserved?.();
          return {
            stream: (async function* () {
              if (runtimeMock.state.autoConnect) {
                yield { id: "evt-auto-connected", type: "server.connected", properties: {} };
              }
              for (const event of runtimeMock.state.subscribedEvents) {
                const resolved = await event;
                while (runtimeMock.state.promptEchoEvents.length > 0) {
                  yield runtimeMock.state.promptEchoEvents.shift();
                }
                yield resolved;
              }
            })(),
          };
        },
      },
      permission: {
        list: async () => {
          runtimeMock.state.permissionListCalls += 1;
          return {
            data: runtimeMock.state.permissionListImplementation
              ? await runtimeMock.state.permissionListImplementation()
              : runtimeMock.state.pendingPermissions,
          };
        },
        reply: async ({ requestID, reply }: { requestID: string; reply: string }) => {
          runtimeMock.state.permissionReplyCalls.push({ requestID, reply });
        },
      },
      question: {
        list: async () => {
          runtimeMock.state.questionListCalls += 1;
          return {
            data: runtimeMock.state.questionListImplementation
              ? await runtimeMock.state.questionListImplementation()
              : runtimeMock.state.pendingQuestions,
          };
        },
        reply: async ({
          requestID,
          answers,
        }: {
          requestID: string;
          answers: ReadonlyArray<ReadonlyArray<string>>;
        }) => {
          runtimeMock.state.questionReplyCalls.push({ requestID, answers });
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

function promiseWithResolvers<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const permissionRequest = (id: string, sessionID: string): PermissionRequest => ({
  id,
  sessionID,
  permission: "bash",
  patterns: ["pwd"],
  metadata: {},
  always: [],
});

const questionRequest = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [
    {
      header: "Scope",
      question: "Which scope should OpenCode use?",
      options: [{ label: "Workspace", description: "Use this workspace." }],
    },
  ],
});

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "opencode");
      NodeAssert.equal(session.threadId, "thread-opencode");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("fails startup when the OpenCode event stream does not connect", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-connect-timeout");
      runtimeMock.state.autoConnect = false;

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* advanceTestClock(10_000);

      const result = yield* Fiber.join(startFiber);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterRequestError");
      NodeAssert.equal(result.failure.method, "event.subscribe");
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("closes a connecting session when startup is interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-connect-interrupted");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(startFiber);

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["http://127.0.0.1:9999/session"]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("stops a connecting session and rejects its waiting send", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-connecting");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      const connecting = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      NodeAssert.equal(connecting?.status, "connecting");

      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Must not be sent",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);

      yield* adapter.stopSession(threadId);
      const startResult = yield* Fiber.join(startFiber);
      const sendResult = yield* Fiber.join(sendFiber);
      NodeAssert.equal(startResult._tag, "Failure");
      NodeAssert.equal(sendResult._tag, "Failure");
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);
      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:9999"]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("aborts a held teardown request before closing the session scope", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-teardown-timeout");
      const abortStarted = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await new Promise<void>(() => {});
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);

      yield* advanceTestClock(999);
      NodeAssert.equal(stopFiber.pollUnsafe(), undefined);
      NodeAssert.equal(runtimeMock.state.abortSignals.length, 1);
      NodeAssert.equal(runtimeMock.state.abortSignals[0]?.aborted, false);
      NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);

      yield* advanceTestClock(1);
      yield* Fiber.join(stopFiber);
      NodeAssert.equal(runtimeMock.state.abortSignals[0]?.aborted, true);
      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:9999"]);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("stopAll closes a connecting session and releases startup", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-all-connecting");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);

      const startFiber = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      const sessionCount = (yield* adapter.listSessions()).length;

      yield* adapter.stopAll();
      const startResult = yield* Fiber.join(startFiber);
      NodeAssert.equal(startResult._tag, "Failure");
      NodeAssert.equal(runtimeMock.state.closeCalls.length, sessionCount);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("keeps one session when concurrent starts cross the connection barrier", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-concurrent-start");
      const connectionEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.createdSessionIds.push("ses_race_a", "ses_race_b");
      runtimeMock.state.subscribedEvents = [connectionEvent.promise];

      const firstStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      const secondStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      connectionEvent.resolve({
        id: "evt-concurrent-start-connected",
        type: "server.connected",
        properties: {},
      });

      const [firstSession, secondSession] = yield* Effect.all([
        Fiber.join(firstStart),
        Fiber.join(secondStart),
      ]);
      const sessions = yield* adapter.listSessions();
      const threadSessions = sessions.filter((session) => session.threadId === threadId);
      NodeAssert.equal(threadSessions.length, 1);
      NodeAssert.deepEqual(firstSession.resumeCursor, secondSession.resumeCursor);
      NodeAssert.equal(firstSession.status, "ready");
      NodeAssert.equal(secondSession.status, "ready");
      const winnerId = (threadSessions[0]?.resumeCursor as { sessionId?: string } | undefined)
        ?.sessionId;
      NodeAssert.ok(winnerId === "ses_race_a" || winnerId === "ses_race_b");
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [
        winnerId === "ses_race_a" ? "ses_race_b" : "ses_race_a",
      ]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reuses a published connecting session after it becomes ready", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-reuse-connecting");
      const connectionEvent = promiseWithResolvers<unknown>();
      const eventSubscribeObserved = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);
      runtimeMock.state.subscribedEvents = [connectionEvent.promise];

      const owningStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);
      const reusedStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.sessionCreateUrls.length, 1);

      connectionEvent.resolve({
        id: "evt-reused-start-connected",
        type: "server.connected",
        properties: {},
      });
      const [ownedSession, reusedSession] = yield* Effect.all([
        Fiber.join(owningStart),
        Fiber.join(reusedStart),
      ]);
      NodeAssert.equal(ownedSession.status, "ready");
      NodeAssert.equal(reusedSession.status, "ready");
      NodeAssert.deepEqual(ownedSession.resumeCursor, reusedSession.resumeCursor);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not let an old held stop delete its replacement", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-old-stop-replacement");
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.createdSessionIds.push("ses_old", "ses_replacement");

      const oldSession = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };
      const oldStop = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);

      const replacement = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      NodeAssert.deepEqual(oldSession.resumeCursor, { schemaVersion: 1, sessionId: "ses_old" });
      NodeAssert.deepEqual(replacement.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_replacement",
      });

      abortRelease.resolve(undefined);
      yield* Fiber.join(oldStop);
      const current = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      NodeAssert.deepEqual(current?.resumeCursor, replacement.resumeCursor);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("replaces a stopped connecting session while its teardown is held", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stopped-connecting-retry");
      const eventSubscribeObserved = promiseWithResolvers<void>();
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoConnect = false;
      runtimeMock.state.eventSubscribeObserved = () => eventSubscribeObserved.resolve(undefined);
      runtimeMock.state.createdSessionIds.push("ses_connecting_old", "ses_connecting_replacement");

      const oldStart = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => eventSubscribeObserved.promise);

      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };
      const oldStop = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);

      runtimeMock.state.autoConnect = true;
      runtimeMock.state.abortImplementation = null;
      const replacement = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      NodeAssert.equal(replacement.status, "ready");
      NodeAssert.deepEqual(replacement.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_connecting_replacement",
      });

      abortRelease.resolve(undefined);
      const oldStartResult = yield* Fiber.join(oldStart);
      yield* Fiber.join(oldStop);
      NodeAssert.equal(oldStartResult._tag, "Failure");
      const current = (yield* adapter.listSessions()).find(
        (session) => session.threadId === threadId,
      );
      NodeAssert.deepEqual(current?.resumeCursor, replacement.resumeCursor);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("returns a durable resume cursor for a freshly created session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-cursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      // Without a persisted cursor, a session is created and its id is
      // surfaced as a resume cursor so the upper layer can persist it.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes the persisted OpenCode session instead of creating a new one", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      // The adapter validates the persisted id with session.get and re-adopts
      // it — no new session is minted (issue #3604).
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_persisted"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });
      // Resume re-asserts the permission ruleset for the current runtimeMode.
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_persisted");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends follow-up turns to the resumed session id", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume-turn");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "continue where we left off",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });

      // The prompt targets the resumed id, and the turn re-surfaces the cursor.
      NodeAssert.deepEqual(
        (runtimeMock.state.promptCalls[0] as { sessionID: string }).sessionID,
        "ses_persisted",
      );
      NodeAssert.deepEqual(result.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("falls back to a fresh session when the persisted session is gone", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale");
      runtimeMock.state.missingSessionIds.add("ses_stale");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_stale" },
      });

      // get probed the stale id, found nothing, then created a new session and
      // emitted a fresh cursor rather than wedging the thread.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_stale"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a malformed or wrong-version resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-badcursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "ses_persisted" },
      });

      // A foreign/stale-shaped cursor is treated as "no resume": never probed,
      // a fresh session is created.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces a non-not-found resume probe error instead of silently starting fresh", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-transient");
      // session.get returns a 500 (not a 404) for this id.
      runtimeMock.state.transientErrorSessionIds.add("ses_transient");

      const exit = yield* Effect.exit(
        adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_transient" },
        }),
      );

      // A transient/transport/auth failure must propagate — NOT be masked as a
      // brand-new empty session (the #3604 class of silent context loss).
      NodeAssert.equal(Exit.isFailure(exit), true);
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_transient"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
    }),
  );

  it.effect("re-applies the current runtimeMode permissions when resuming", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-perms");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        // A different runtimeMode than the original create — resume must not
        // leave the upstream session on stale permissions.
        runtimeMode: "approval-required",
        threadId,
        resumeCursor: { schemaVersion: 1, sessionId: "ses_perms" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_perms"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_perms");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "forks the resumed session into the requested directory instead of losing context",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-cwd");
        // The persisted session still exists but was created in another working dir
        // (e.g. the thread moved from the project root into a git worktree).
        runtimeMock.state.sessionDirectoryById.set("ses_otherdir", "/some/other/worktree");

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_otherdir" },
        });

        // A cwd change must not mint an empty session: the adapter forks the
        // persisted session into the requested cwd, carrying history forward.
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_otherdir"]);
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
        NodeAssert.equal(runtimeMock.state.forkCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, "ses_otherdir");
        NodeAssert.equal(typeof runtimeMock.state.forkCalls[0]?.directory, "string");
        // Permission ruleset re-asserted on the fork for the current runtimeMode.
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_otherdir_fork");
        // Durable cursor now points at the history-complete fork in the new directory.
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "ses_otherdir_fork",
        });

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("reuses the resumed session when the stored directory differs only lexically", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-samedir");
      // Same working tree, different spelling (trailing slash) — must reuse,
      // not fork.
      runtimeMock.state.sessionDirectoryById.set("ses_samedir", `${process.cwd()}/`);

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_samedir" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_samedir"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(runtimeMock.state.forkCalls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_samedir",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails sendTurn for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-opencode-missing-send"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-send");
    }),
  );

  it.effect("fails stopSession for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .stopSession(asThreadId("thread-opencode-missing-stop"))
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-stop");
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      NodeAssert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        NodeAssert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "prompt failed");
      NodeAssert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      // Steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("keeps the running turn when a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      runtimeMock.state.promptAsyncError = new Error("steer failed");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      // The original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
    }),
  );

  it.effect("does not let an old idle status complete a successful steer", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-idle-admission");
      const busyBeforeSteer = promiseWithResolvers<unknown>();
      const idleBeforeSteer = promiseWithResolvers<unknown>();
      const idleAfterSteer = promiseWithResolvers<unknown>();
      const statusStarted = promiseWithResolvers<void>();
      const statusRelease = promiseWithResolvers<void>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        busyBeforeSteer.promise,
        idleBeforeSteer.promise,
        idleAfterSteer.promise,
      ];
      runtimeMock.state.sessionStatusImplementation = async () => {
        statusStarted.resolve(undefined);
        await statusRelease.promise;
        return { data: {} };
      };
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 3) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start the next turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyBeforeSteer.resolve({
        id: "evt-busy-before-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleBeforeSteer.resolve({
        id: "evt-idle-before-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Add one more task",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      statusRelease.resolve(undefined);
      steerRelease.resolve(undefined);
      yield* Fiber.join(steerFiber);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, activeTurn.turnId);

      idleAfterSteer.resolve({
        id: "evt-idle-after-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("waits for steer admission before accepting the only idle event", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-admission-only-idle");
      runtimeMock.state.autoPromptEcho = false;
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const staleIdleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        firstUserMessageEvent.promise,
        staleIdleEvent.promise,
        userMessageEvent.promise,
        idleEvent.promise,
      ];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Add another task",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      const firstMessageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      const steerMessageId = (runtimeMock.state.promptCalls[1] as { messageID?: string }).messageID;
      NodeAssert.match(firstMessageId ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      NodeAssert.match(steerMessageId ?? "", /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      firstUserMessageEvent.resolve({
        id: "evt-delayed-first-user-message",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: firstMessageId, role: "user" },
        },
      });
      staleIdleEvent.resolve({
        id: "evt-stale-idle-during-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      userMessageEvent.resolve({
        id: "evt-steer-user-message",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: steerMessageId, role: "user" },
        },
      });
      idleEvent.resolve({
        id: "evt-only-idle-during-steer",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 0);
      steerRelease.resolve(undefined);
      yield* Fiber.join(steerFiber);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls > 0, true);
    }),
  );

  it.effect("keeps steer admission until its user message arrives after prompt acceptance", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-message-after-acceptance");
      runtimeMock.state.autoPromptEcho = false;
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const staleIdleEvent = promiseWithResolvers<unknown>();
      const steerUserMessageEvent = promiseWithResolvers<unknown>();
      const validIdleEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        firstUserMessageEvent.promise,
        staleIdleEvent.promise,
        steerUserMessageEvent.promise,
        validIdleEvent.promise,
      ];

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const firstMessageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      firstUserMessageEvent.resolve({
        id: "evt-first-user-message-before-steer",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: firstMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;

      yield* adapter.sendTurn({
        threadId,
        input: "Add another task",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const steerMessageId = (runtimeMock.state.promptCalls[1] as { messageID?: string }).messageID;

      staleIdleEvent.resolve({
        id: "evt-stale-idle-after-steer-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      const sessionsAfterStaleIdle = yield* adapter.listSessions();
      const sessionAfterStaleIdle = sessionsAfterStaleIdle.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionAfterStaleIdle?.status, "running");
      NodeAssert.equal(sessionAfterStaleIdle?.activeTurnId, activeTurn.turnId);

      steerUserMessageEvent.resolve({
        id: "evt-steer-user-message-after-acceptance",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: steerMessageId, role: "user" },
        },
      });
      validIdleEvent.resolve({
        id: "evt-valid-idle-after-steer-message",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("recovers steer admission when reconnect happens before prompt acceptance", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-reconnect-before-acceptance");
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const reconnectEvent = promiseWithResolvers<unknown>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [firstUserMessageEvent.promise, reconnectEvent.promise];
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const firstMessageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      firstUserMessageEvent.resolve({
        id: "evt-first-user-before-reconnect-steer",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: firstMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;

      const steerFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Add another task",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      const steerMessageId = (runtimeMock.state.promptCalls[1] as { messageID?: string }).messageID;
      NodeAssert.ok(steerMessageId);
      runtimeMock.state.messages.push({
        info: { id: steerMessageId, role: "user" },
        parts: [],
      });
      runtimeMock.state.messageFailures = 1;
      reconnectEvent.resolve({
        id: "evt-reconnected-during-steer",
        type: "server.connected",
        properties: {},
      });
      yield* Effect.yieldNow;

      steerRelease.resolve(undefined);
      yield* Fiber.join(steerFiber);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      NodeAssert.equal(
        runtimeMock.state.messageCalls.filter((call) => call.messageID === steerMessageId).length,
        2,
      );
      const abortCallsAfterCompletion = runtimeMock.state.abortCalls.length;
      yield* adapter.interruptTurn(threadId, activeTurn.turnId);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, abortCallsAfterCompletion);
    }),
  );

  it.effect("resolves admission without a prompt echo when busy and idle still arrive", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-admission-without-echo");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined;
        if (prompt?.messageID) {
          runtimeMock.state.messages.push({
            info: { id: prompt.messageID, role: "user" },
            parts: [],
          });
        }
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run without an echo event",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-busy-without-echo",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-idle-without-echo",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* advanceTestClock(1_000);

      NodeAssert.equal(
        runtimeMock.state.messageCalls.some(
          (call) => call.messageID === runtimeMock.state.messages[0]?.info.id,
        ),
        true,
      );
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls > 0, true);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.equal(turn.turnId !== undefined, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("uses polled busy status to admit output after a stopped turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-polled-busy-after-stop");
      const firstUserMessageEvent = promiseWithResolvers<unknown>();
      const assistantMessageEvent = promiseWithResolvers<unknown>();
      const assistantPartEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const busyStatusPolled = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [
        firstUserMessageEvent.promise,
        assistantMessageEvent.promise,
        assistantPartEvent.promise,
        idleEvent.promise,
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "content.delta" || event.type === "turn.completed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const stoppedMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;
      firstUserMessageEvent.resolve({
        id: "evt-first-user-before-polled-busy-turn",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: stoppedMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);

      runtimeMock.state.sessionStatusCalls = 0;
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          busyStatusPolled.resolve(undefined);
          return {
            data: { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        }
        return { data: {} };
      };
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run without echo or busy events",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* Effect.promise(() => busyStatusPolled.promise);
      yield* Effect.yieldNow;

      assistantMessageEvent.resolve({
        id: "evt-assistant-after-polled-busy",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: "msg-assistant-after-polled-busy", role: "assistant" },
        },
      });
      assistantPartEvent.resolve({
        id: "evt-part-after-polled-busy",
        type: "message.part.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          part: {
            id: "part-after-polled-busy",
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-assistant-after-polled-busy",
            type: "text",
            text: "Visible output",
            time: { start: 1 },
          },
          time: 1,
        },
      });
      idleEvent.resolve({
        id: "evt-idle-after-polled-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["content.delta", "turn.completed"],
      );
      const delta = events[0];
      if (delta?.type === "content.delta") {
        NodeAssert.equal(delta.payload.delta, "Visible output");
      }
      NodeAssert.equal(events[1]?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a stale admission status response after the next turn starts", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stale-admission-status-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      const staleStatusStarted = promiseWithResolvers<void>();
      const staleStatusRelease = promiseWithResolvers<void>();
      const staleStatusReturned = promiseWithResolvers<void>();
      const activePromptStarted = promiseWithResolvers<void>();
      const activePromptRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          staleStatusStarted.resolve(undefined);
          await staleStatusRelease.promise;
          staleStatusReturned.resolve(undefined);
          return {
            data: { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        }
        return { data: {} };
      };
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          activePromptStarted.resolve(undefined);
          await activePromptRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop while status is pending",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* Effect.promise(() => staleStatusStarted.promise);
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);

      const activeTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Start while the old status is pending",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => activePromptStarted.promise);
      const activeMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;

      staleStatusRelease.resolve(undefined);
      yield* Effect.promise(() => staleStatusReturned.promise);
      for (let index = 0; index < 2; index += 1) {
        yield* Effect.yieldNow;
      }
      idleEvent.resolve({
        id: "evt-idle-after-stale-admission-status",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      for (let index = 0; index < 4; index += 1) {
        yield* Effect.yieldNow;
      }
      NodeAssert.equal(activeTurnFiber.pollUnsafe(), undefined);
      NodeAssert.equal(completedFiber.pollUnsafe(), undefined);
      const sessionsBeforeAcceptance = yield* adapter.listSessions();
      const sessionBeforeAcceptance = sessionsBeforeAcceptance.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeAcceptance?.status, "running");
      NodeAssert.notEqual(sessionBeforeAcceptance?.activeTurnId, stoppedTurn.turnId);

      userMessageEvent.resolve({
        id: "evt-user-after-stale-admission-status",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: activeMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;
      activePromptRelease.resolve(undefined);
      const activeTurn = yield* Fiber.join(activeTurnFiber);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reconciles a sole idle when the matching prompt echo arrives later", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-before-delayed-echo");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Finish before the echo arrives",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const messageId = (runtimeMock.state.promptCalls[0] as { messageID?: string }).messageID;
      idleEvent.resolve({
        id: "evt-idle-before-delayed-echo",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      userMessageEvent.resolve({
        id: "evt-delayed-matching-echo",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: messageId, role: "user" },
        },
      });
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, turn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reconciles the only idle after a stopped turn when the prompt echo is missing", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-only-without-echo-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        const prompt = runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined;
        if (prompt?.messageID) {
          runtimeMock.state.messages.push({
            info: { id: prompt.messageID, role: "user" },
            parts: [],
          });
        }
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run after the stop",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const activeMessageId = (
        runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined
      )?.messageID;
      idleEvent.resolve({
        id: "evt-only-idle-without-echo-after-stop",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* advanceTestClock(1_000);

      NodeAssert.equal(
        runtimeMock.state.messageCalls.some((call) => call.messageID === activeMessageId),
        true,
      );
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls > 0, true);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);
      NodeAssert.notEqual(activeTurn.turnId, stoppedTurn.turnId);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reconciles a sole idle after a stop when the exact prompt echo arrives", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-before-exact-echo-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run after the stop",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const activeMessageId = (
        runtimeMock.state.promptCalls.at(-1) as { messageID?: string } | undefined
      )?.messageID;
      idleEvent.resolve({
        id: "evt-only-idle-before-exact-echo-after-stop",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      const sessionsBeforeEcho = yield* adapter.listSessions();
      const sessionBeforeEcho = sessionsBeforeEcho.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeEcho?.status, "running");
      NodeAssert.equal(sessionBeforeEcho?.activeTurnId, activeTurn.turnId);

      userMessageEvent.resolve({
        id: "evt-exact-prompt-echo-after-stop",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: activeMessageId, role: "user" },
        },
      });
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers an idle before the exact prompt echo while acceptance is held", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-and-echo-before-acceptance-after-stop");
      const idleEvent = promiseWithResolvers<unknown>();
      const userMessageEvent = promiseWithResolvers<unknown>();
      const activePromptStarted = promiseWithResolvers<void>();
      const activePromptRelease = promiseWithResolvers<void>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [idleEvent.promise, userMessageEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          activePromptStarted.resolve(undefined);
          await activePromptRelease.promise;
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);

      const activeTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Run after the stop",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => activePromptStarted.promise);
      const activeMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;
      idleEvent.resolve({
        id: "evt-idle-before-held-prompt-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      userMessageEvent.resolve({
        id: "evt-exact-echo-before-held-prompt-acceptance",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: activeMessageId, role: "user" },
        },
      });
      yield* Effect.yieldNow;
      NodeAssert.equal(activeTurnFiber.pollUnsafe(), undefined);

      activePromptRelease.resolve(undefined);
      const activeTurn = yield* Fiber.join(activeTurnFiber);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores idle reconciliation after a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-failed-steer-idle");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const firstStatusStarted = promiseWithResolvers<void>();
      const firstStatusRelease = promiseWithResolvers<void>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          firstStatusStarted.resolve(undefined);
          await firstStatusRelease.promise;
        }
        return { data: {} };
      };
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 3) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
          throw new Error("steer failed");
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start the next turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-failed-steer-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-failed-steer-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => firstStatusStarted.promise);
      const steerFiber = yield* Effect.exit(
        adapter.sendTurn({
          threadId,
          input: "This steer fails",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      firstStatusRelease.resolve(undefined);
      steerRelease.resolve(undefined);
      const steerExit = yield* Fiber.join(steerFiber);
      NodeAssert.equal(Exit.isFailure(steerExit), true);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 2);
    }),
  );

  it.effect("accepts the only idle event after a steer fails before creating its message", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-failed-steer-admission-idle");
      const idleEvent = promiseWithResolvers<unknown>();
      const steerStarted = promiseWithResolvers<void>();
      const steerRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => ({ data: {} });
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 2) {
          steerStarted.resolve(undefined);
          await steerRelease.promise;
          throw new Error("steer failed before message creation");
        }
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start work",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const steerFiber = yield* Effect.exit(
        adapter.sendTurn({
          threadId,
          input: "This steer fails",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => steerStarted.promise);
      idleEvent.resolve({
        id: "evt-idle-during-failed-admission",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      steerRelease.resolve(undefined);
      NodeAssert.equal(Exit.isFailure(yield* Fiber.join(steerFiber)), true);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("routes child-session approval requests and replies through the parent thread", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-approval");
      const permissionReply = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-child-created",
          type: "session.created",
          properties: {
            sessionID: "ses_child",
            info: {
              id: "ses_child",
              parentID: "http://127.0.0.1:9999/session",
              title: "Child session",
            },
          },
        },
        {
          id: "evt-child-permission",
          type: "permission.asked",
          properties: {
            id: "per_child",
            sessionID: "ses_child",
            permission: "external_directory",
            patterns: ["/tmp/external/*"],
            metadata: { source: "child" },
            always: ["/tmp/external/*"],
          },
        },
        permissionReply.promise,
      ];

      const openedEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const openedEvents = Array.from(
        yield* Fiber.join(openedEventsFiber).pipe(Effect.timeout("1 second")),
      );
      const opened = openedEvents.find((event) => event.type === "request.opened");
      NodeAssert.ok(opened);
      NodeAssert.equal(opened.requestId, "per_child");
      NodeAssert.equal(
        opened.raw?.source === "opencode.sdk.event" &&
          typeof opened.raw.payload === "object" &&
          opened.raw.payload !== null &&
          "properties" in opened.raw.payload
          ? (opened.raw.payload.properties as { sessionID?: string }).sessionID
          : undefined,
        "ses_child",
      );

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("per_child"),
        "acceptForSession",
      );
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_child", reply: "always" },
      ]);

      const resolvedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      permissionReply.resolve({
        id: "evt-child-permission-replied",
        type: "permission.replied",
        properties: {
          sessionID: "ses_child",
          requestID: "per_child",
          reply: "always",
        },
      });
      const resolved = yield* Fiber.join(resolvedEventFiber).pipe(Effect.timeout("1 second"));
      NodeAssert.equal(Option.getOrUndefined(resolved)?.type, "request.resolved");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("routes child-session questions and replies through the parent thread", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-question");
      const questionReply = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-child-created",
          type: "session.created",
          properties: {
            sessionID: "ses_child_question",
            info: {
              id: "ses_child_question",
              parentID: "http://127.0.0.1:9999/session",
              title: "Child session",
            },
          },
        },
        {
          id: "evt-child-question",
          type: "question.asked",
          properties: {
            id: "que_child",
            sessionID: "ses_child_question",
            questions: [
              {
                header: "Scope",
                question: "Which scope should OpenCode use?",
                options: [{ label: "Workspace", description: "Use this workspace." }],
              },
            ],
          },
        },
        questionReply.promise,
      ];

      const requestedEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });

      const requestedEvents = Array.from(
        yield* Fiber.join(requestedEventsFiber).pipe(Effect.timeout("1 second")),
      );
      const requested = requestedEvents.find((event) => event.type === "user-input.requested");
      NodeAssert.ok(requested);
      NodeAssert.equal(requested.requestId, "que_child");

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("que_child"), {
        Scope: "Workspace",
      });
      NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, [
        { requestID: "que_child", answers: [["Workspace"]] },
      ]);

      const resolvedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      questionReply.resolve({
        id: "evt-child-question-replied",
        type: "question.replied",
        properties: {
          sessionID: "ses_child_question",
          requestID: "que_child",
          answers: [["Workspace"]],
        },
      });
      const resolved = yield* Fiber.join(resolvedEventFiber).pipe(Effect.timeout("1 second"));
      NodeAssert.equal(Option.getOrUndefined(resolved)?.type, "user-input.resolved");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("recovers pending requests from existing nested child sessions on resume", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-resume-child-requests");
      runtimeMock.state.sessionParentById.set("ses_child", "ses_parent");
      runtimeMock.state.sessionParentById.set("ses_nested", "ses_child");
      runtimeMock.state.pendingPermissions = [permissionRequest("per_existing", "ses_nested")];
      runtimeMock.state.pendingQuestions = [questionRequest("que_existing", "ses_child")];

      const requestsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "user-input.requested"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_parent" },
      });

      const requests = Array.from(
        yield* Fiber.join(requestsFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.deepEqual(requests.map((event) => [event.type, event.requestId]).sort(), [
        ["request.opened", "per_existing"],
        ["user-input.requested", "que_existing"],
      ]);
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("per_existing"), "accept");
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("que_existing"), {
        Scope: "Workspace",
      });
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_existing", reply: "once" },
      ]);
      NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, [
        { requestID: "que_existing", answers: [["Workspace"]] },
      ]);
    }),
  );

  it.effect("retries ancestry for one live child request after a transient failure", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-request-ancestry-retry");
      const parentId = "http://127.0.0.1:9999/session";
      const ancestryAttempted = promiseWithResolvers<void>();
      runtimeMock.state.sessionParentById.set("ses_existing_child", parentId);
      runtimeMock.state.transientErrorSessionIds.add("ses_existing_child");
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID === "ses_existing_child") {
          ancestryAttempted.resolve(undefined);
        }
      };
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-existing-child-permission",
          type: "permission.asked",
          properties: permissionRequest("per_retry", "ses_existing_child"),
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "runtime.warning" || event.type === "request.opened"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* Effect.promise(() => ancestryAttempted.promise);
      runtimeMock.state.transientErrorSessionIds.delete("ses_existing_child");
      yield* advanceTestClock(250);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["runtime.warning", "request.opened"],
      );
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("per_retry"), "accept");
    }),
  );

  it.effect("does not resurrect a recovered child request after its live reply", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stale-child-request-recovery");
      const listStarted = promiseWithResolvers<void>();
      const listRelease = promiseWithResolvers<void>();
      const stale = permissionRequest("per_stale", "ses_existing_child");
      runtimeMock.state.sessionParentById.set("ses_existing_child", "ses_parent");
      runtimeMock.state.permissionListImplementation = async () => {
        listStarted.resolve(undefined);
        await listRelease.promise;
        return [stale];
      };
      runtimeMock.state.subscribedEvents = [
        {
          id: "evt-stale-child-replied",
          type: "permission.replied",
          properties: {
            sessionID: "ses_existing_child",
            requestID: stale.id,
            reply: "once",
          },
        },
      ];

      const resolvedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_parent" },
      });
      yield* Effect.promise(() => listStarted.promise);
      const resolved = Option.getOrUndefined(
        yield* Fiber.join(resolvedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(resolved?.type, "request.resolved");
      listRelease.resolve(undefined);
      yield* Effect.yieldNow;

      const response = yield* Effect.exit(
        adapter.respondToRequest(threadId, ApprovalRequestId.make(stale.id), "accept"),
      );
      NodeAssert.equal(Exit.isFailure(response), true);
    }),
  );

  it.effect("lets a child reply supersede an ask while ancestry lookup is retrying", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-child-terminal-during-ancestry");
      const ancestryAttempted = promiseWithResolvers<void>();
      const childId = "ses_terminal_child";
      const request = permissionRequest("per_terminal", childId);
      runtimeMock.state.sessionParentById.set(childId, "http://127.0.0.1:9999/session");
      runtimeMock.state.transientErrorSessionIds.add(childId);
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID === childId) {
          ancestryAttempted.resolve(undefined);
        }
      };
      runtimeMock.state.subscribedEvents = [
        { id: "evt-terminal-ask", type: "permission.asked", properties: request },
        {
          id: "evt-terminal-reply",
          type: "permission.replied",
          properties: { sessionID: childId, requestID: request.id, reply: "once" },
        },
      ];

      const terminalFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* Effect.promise(() => ancestryAttempted.promise);
      runtimeMock.state.transientErrorSessionIds.delete(childId);
      yield* advanceTestClock(250);

      const terminal = Option.getOrUndefined(
        yield* Fiber.join(terminalFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(terminal?.type, "request.resolved");
      const response = yield* Effect.exit(
        adapter.respondToRequest(threadId, ApprovalRequestId.make(request.id), "accept"),
      );
      NodeAssert.equal(Exit.isFailure(response), true);
    }),
  );

  it.effect("caps terminal ancestry retries after a request finishes", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-terminal-ancestry-retry-cap");
      const childId = "ses_terminal_retry_cap_child";
      const request = permissionRequest("per_terminal_retry_cap", childId);
      const terminalEvent = promiseWithResolvers<unknown>();
      const askedAttempted = promiseWithResolvers<void>();
      const terminalAttempted = promiseWithResolvers<void>();
      let terminalReleased = false;
      runtimeMock.state.transientErrorSessionIds.add(childId);
      runtimeMock.state.sessionGetObserved = (sessionID) => {
        if (sessionID !== childId) {
          return;
        }
        if (terminalReleased) {
          terminalAttempted.resolve(undefined);
        } else {
          askedAttempted.resolve(undefined);
        }
      };
      runtimeMock.state.subscribedEvents = [
        { id: "evt-terminal-cap-ask", type: "permission.asked", properties: request },
        terminalEvent.promise,
      ];

      const unexpectedRequestFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* Effect.promise(() => askedAttempted.promise);
      const askedAttempts = runtimeMock.state.sessionGetIds.filter(
        (sessionID) => sessionID === childId,
      ).length;

      terminalReleased = true;
      terminalEvent.resolve({
        id: "evt-terminal-cap-reply",
        type: "permission.replied",
        properties: { sessionID: childId, requestID: request.id, reply: "once" },
      });
      yield* Effect.promise(() => terminalAttempted.promise);
      yield* advanceTestClock(10_000);
      const callsAfterCap = runtimeMock.state.sessionGetIds.filter(
        (sessionID) => sessionID === childId,
      ).length;
      NodeAssert.equal(callsAfterCap - askedAttempts, 5);

      yield* advanceTestClock(30_000);
      NodeAssert.equal(
        runtimeMock.state.sessionGetIds.filter((sessionID) => sessionID === childId).length,
        callsAfterCap,
      );
      NodeAssert.equal(unexpectedRequestFiber.pollUnsafe(), undefined);
      yield* Fiber.interrupt(unexpectedRequestFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reruns recovery when the event stream connects during the startup snapshot", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-connected-recovery-rerun");
      const firstListStarted = promiseWithResolvers<void>();
      const firstListRelease = promiseWithResolvers<void>();
      const pending = permissionRequest("per_connected", "ses_existing_child");
      runtimeMock.state.sessionParentById.set("ses_existing_child", "ses_parent");
      runtimeMock.state.permissionListImplementation = async () => {
        if (runtimeMock.state.permissionListCalls === 1) {
          firstListStarted.resolve(undefined);
          await firstListRelease.promise;
          return [];
        }
        return [pending];
      };
      runtimeMock.state.subscribedEvents = [
        { id: "evt-connected", type: "server.connected", properties: {} },
      ];

      const openedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_parent" },
      });
      yield* Effect.promise(() => firstListStarted.promise);
      firstListRelease.resolve(undefined);

      const opened = Option.getOrUndefined(
        yield* Fiber.join(openedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(opened?.requestId, pending.id);
      NodeAssert.equal(runtimeMock.state.permissionListCalls, 2);
    }),
  );

  it.effect("keeps an idle event from completing a turn while its abort request is pending", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-idle-race");
      const idleEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [idleEvent.promise];
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      idleEvent.resolve({
        id: "evt-idle-after-stop",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;
      abortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed" || event.type === "turn.aborted")
          .map((event) => event.type),
        ["turn.aborted"],
      );
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores late busy and idle status after an interrupted turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-late-status-after-interrupt");
      const lateBusy = promiseWithResolvers<unknown>();
      const lateIdle = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [lateBusy.promise, lateIdle.promise];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Stop this turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, turn.turnId);

      lateBusy.resolve({
        id: "evt-late-busy-after-interrupt",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      lateIdle.resolve({
        id: "evt-late-idle-after-interrupt",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.yieldNow;

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed" || event.type === "turn.aborted")
          .map((event) => event.type),
        ["turn.aborted"],
      );
    }),
  );

  it.effect("rejects a prompt accepted after its turn was interrupted", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-during-prompt-admission");
      const promptStarted = promiseWithResolvers<void>();
      const promptRelease = promiseWithResolvers<void>();
      const lateBusy = promiseWithResolvers<unknown>();
      const lateMessage = promiseWithResolvers<unknown>();
      const latePart = promiseWithResolvers<unknown>();
      const lateIdle = promiseWithResolvers<unknown>();
      const marker = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [
        lateBusy.promise,
        lateMessage.promise,
        latePart.promise,
        lateIdle.promise,
        marker.promise,
      ];
      runtimeMock.state.promptAsyncImplementation = async () => {
        if (runtimeMock.state.promptCalls.length === 1) {
          promptStarted.resolve(undefined);
          await promptRelease.promise;
        }
      };

      const firstLateOutput = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "content.delta" || event.type === "thread.metadata.updated"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "This request is still pending",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => promptStarted.promise);

      yield* adapter.interruptTurn(threadId);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      const sessionsAfterStop = yield* adapter.listSessions();
      const sessionAfterStop = sessionsAfterStop.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionAfterStop?.status, "ready");
      NodeAssert.equal(sessionAfterStop?.activeTurnId, undefined);

      promptRelease.resolve(undefined);
      const sendResult = yield* Fiber.join(sendFiber);
      lateBusy.resolve({
        id: "evt-busy-after-late-prompt-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      lateMessage.resolve({
        id: "evt-assistant-after-late-prompt-acceptance",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: "msg-late-assistant", role: "assistant" },
        },
      });
      latePart.resolve({
        id: "evt-part-after-late-prompt-acceptance",
        type: "message.part.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          part: {
            id: "part-late-assistant",
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-late-assistant",
            type: "text",
            text: "Late output",
            time: { start: 1 },
          },
          time: 1,
        },
      });
      lateIdle.resolve({
        id: "evt-idle-after-late-prompt-acceptance",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      marker.resolve({
        id: "evt-marker-after-late-prompt-acceptance",
        type: "session.updated",
        properties: {
          info: {
            id: "http://127.0.0.1:9999/session",
            title: "Late prompt cleaned up",
          },
        },
      });

      const firstOutput = Option.getOrUndefined(
        yield* Fiber.join(firstLateOutput).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(firstOutput?.type, "thread.metadata.updated");
      NodeAssert.equal(Exit.isFailure(sendResult), true);
      if (Exit.isFailure(sendResult)) {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendResult.cause), true);
      }

      yield* adapter.sendTurn({
        threadId,
        input: "Start after late cleanup",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      const sessionsAfterNextTurn = yield* adapter.listSessions();
      const sessionAfterNextTurn = sessionsAfterNextTurn.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionAfterNextTurn?.status, "running");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("treats MessageAbortedError as the acknowledgment for a pending user stop", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-error-race");
      const abortedEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [abortedEvent.promise];
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      abortedEvent.resolve({
        id: "evt-aborted-after-stop",
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      yield* Effect.yieldNow;
      abortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error",
          )
          .map((event) => event.type),
        ["turn.aborted"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not claim a turn stopped when the abort request fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-request-failure");
      runtimeMock.state.abortImplementation = async () => {
        throw new Error("abort failed");
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const exit = yield* Effect.exit(adapter.interruptTurn(threadId, turn.turnId));
      NodeAssert.equal(Exit.isFailure(exit), true);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, turn.turnId);
    }),
  );

  it.effect("releases stop and send waiters when a native abort times out", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-timeout");
      const abortStarted = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await new Promise<void>(() => {});
      };
      runtimeMock.state.sessionStatus = "busy";

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const unexpectedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" || event.type === "turn.aborted"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      const firstInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.abortSignals.length, 1);
      const abortSignal = runtimeMock.state.abortSignals[0];
      const secondInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.result, Effect.forkChild);
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Wait for the stop request",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);

      yield* advanceTestClock(9_999);
      NodeAssert.equal(firstInterrupt.pollUnsafe(), undefined);
      NodeAssert.equal(secondInterrupt.pollUnsafe(), undefined);
      NodeAssert.equal(sendFiber.pollUnsafe(), undefined);
      yield* advanceTestClock(1);

      const firstResult = yield* Fiber.join(firstInterrupt);
      const secondResult = yield* Fiber.join(secondInterrupt);
      const sendResult = yield* Fiber.join(sendFiber);
      NodeAssert.equal(firstResult._tag, "Failure");
      NodeAssert.equal(secondResult._tag, "Failure");
      NodeAssert.equal(sendResult._tag, "Failure");
      if (firstResult._tag === "Failure") {
        NodeAssert.equal(firstResult.failure._tag, "ProviderAdapterRequestError");
        NodeAssert.equal(
          firstResult.failure.detail,
          "OpenCode session abort did not complete within 10 seconds.",
        );
      }
      NodeAssert.equal(abortSignal?.aborted, true);
      NodeAssert.equal(unexpectedEventFiber.pollUnsafe(), undefined);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.sendTurn({
        threadId,
        input: "Continue after the failed stop request",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);

      yield* Fiber.interrupt(unexpectedEventFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("shares one abort request across concurrent stops", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-concurrent-interrupt");
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const firstInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      const secondInterrupt = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);

      abortRelease.resolve(undefined);
      yield* Fiber.join(firstInterrupt);
      yield* Fiber.join(secondInterrupt);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed" || event.type === "turn.aborted")
          .map((event) => event.type),
        ["turn.aborted"],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("accepts a native turnless abort before its request times out", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-turnless-interrupt");
      const abortEvent = promiseWithResolvers<unknown>();
      const markerEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [abortEvent.promise, markerEvent.promise];
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await new Promise<void>(() => {});
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_existing" },
      });
      const acknowledgmentFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error" ||
              event.type === "thread.metadata.updated"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      const firstInterrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      const secondInterrupt = yield* adapter.interruptTurn(threadId).pipe(Effect.forkChild);
      runtimeMock.state.sessionStatusImplementation = async () => ({
        data: { ses_existing: { type: "busy" as const } },
      });
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Start after the session abort",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      NodeAssert.equal(runtimeMock.state.abortCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);

      abortEvent.resolve({
        id: "evt-turnless-abort",
        type: "session.error",
        properties: {
          sessionID: "ses_existing",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      markerEvent.resolve({
        id: "evt-after-turnless-abort",
        type: "session.updated",
        properties: {
          info: { id: "ses_existing", title: "Turnless abort acknowledged" },
        },
      });
      const acknowledgment = Option.getOrUndefined(yield* Fiber.join(acknowledgmentFiber));
      NodeAssert.equal(acknowledgment?.type, "thread.metadata.updated");
      const unexpectedEventFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* advanceTestClock(10_000);
      yield* Fiber.join(firstInterrupt);
      yield* Fiber.join(secondInterrupt);
      yield* Fiber.join(sendFiber);

      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.abortSignals[0]?.aborted, true);
      NodeAssert.equal(unexpectedEventFiber.pollUnsafe(), undefined);
      yield* Fiber.interrupt(unexpectedEventFiber);
      runtimeMock.state.abortImplementation = null;
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a native turnless abort after its request succeeds", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-late-turnless-abort");
      const abortEvent = promiseWithResolvers<unknown>();
      const markerEvent = promiseWithResolvers<unknown>();
      runtimeMock.state.subscribedEvents = [abortEvent.promise, markerEvent.promise];

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_existing" },
      });
      const acknowledgmentFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error" ||
              event.type === "thread.metadata.updated"),
        ),
        Stream.runHead,
        Effect.forkChild,
      );

      yield* adapter.interruptTurn(threadId);
      abortEvent.resolve({
        id: "evt-late-turnless-abort",
        type: "session.error",
        properties: {
          sessionID: "ses_existing",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      markerEvent.resolve({
        id: "evt-after-late-turnless-abort",
        type: "session.updated",
        properties: {
          info: { id: "ses_existing", title: "Late turnless abort ignored" },
        },
      });
      const acknowledgment = Option.getOrUndefined(yield* Fiber.join(acknowledgmentFiber));

      NodeAssert.equal(acknowledgment?.type, "thread.metadata.updated");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "ready");
      NodeAssert.equal(session?.activeTurnId, undefined);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("clears a failed turnless interrupt before the next turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-turnless-interrupt-failure");
      runtimeMock.state.abortImplementation = async () => {
        throw new Error("abort failed");
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_existing" },
      });
      const interruptExit = yield* Effect.exit(adapter.interruptTurn(threadId));
      NodeAssert.equal(Exit.isFailure(interruptExit), true);

      runtimeMock.state.abortImplementation = null;
      yield* adapter.sendTurn({
        threadId,
        input: "Start after the failed session abort",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("waits for a pending stop before starting the next turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-send-during-stop");
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const stopFiber = yield* adapter
        .interruptTurn(threadId, stoppedTurn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Second turn",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);
      abortRelease.resolve(undefined);
      yield* Fiber.join(stopFiber);
      const nextTurn = yield* Fiber.join(sendFiber);

      NodeAssert.notEqual(nextTurn.turnId, stoppedTurn.turnId);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("interrupts a turn waiting on cancellation when the session stops", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stop-during-cancellation");
      const firstAbortStarted = promiseWithResolvers<void>();
      const teardownAbortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async () => {
        if (runtimeMock.state.abortCalls.length === 1) {
          firstAbortStarted.resolve(undefined);
        } else {
          teardownAbortStarted.resolve(undefined);
        }
        await abortRelease.promise;
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const interruptFiber = yield* adapter
        .interruptTurn(threadId, activeTurn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => firstAbortStarted.promise);

      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "Must not be sent",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      const sendResult = yield* Fiber.join(sendFiber);
      NodeAssert.equal(Exit.isFailure(sendResult), true);
      if (Exit.isFailure(sendResult)) {
        NodeAssert.equal(Cause.hasInterruptsOnly(sendResult.cause), true);
      }
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);

      yield* Effect.promise(() => teardownAbortStarted.promise);
      yield* advanceTestClock(1_000);
      yield* Fiber.join(stopFiber);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);

      abortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 1);
      NodeAssert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("rechecks a newer idle after an older status call returns busy", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-newer-idle-during-status");
      const busyEvent = promiseWithResolvers<unknown>();
      const staleIdle = promiseWithResolvers<unknown>();
      const realIdle = promiseWithResolvers<unknown>();
      const statusStarted = promiseWithResolvers<void>();
      const statusRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, staleIdle.promise, realIdle.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 1) {
          statusStarted.resolve(undefined);
          await statusRelease.promise;
          return {
            data: { "http://127.0.0.1:9999/session": { type: "busy" as const } },
          };
        }
        return { data: {} };
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-new-turn-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      staleIdle.resolve({
        id: "evt-old-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      realIdle.resolve({
        id: "evt-new-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      statusRelease.resolve(undefined);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, secondTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 2);
    }),
  );

  it.effect("completes after transient status failures without another idle event", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-status-retry");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const failuresObserved = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls <= 2) {
          if (runtimeMock.state.sessionStatusCalls === 2) {
            failuresObserved.resolve(undefined);
          }
          throw new Error("status failed");
        }
        return { data: {} };
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-retry-turn-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-retry-turn-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => failuresObserved.promise);
      yield* advanceTestClock(250);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, secondTurn.turnId);
      NodeAssert.equal(runtimeMock.state.sessionStatusCalls, 3);
    }),
  );

  it.effect("keeps idle reconciliation after a delayed abort from the stopped turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stale-abort-during-idle-check");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const staleAbortEvent = promiseWithResolvers<unknown>();
      const statusStarted = promiseWithResolvers<void>();
      const statusRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        busyEvent.promise,
        idleEvent.promise,
        staleAbortEvent.promise,
      ];
      runtimeMock.state.sessionStatusImplementation = async () => {
        statusStarted.resolve(undefined);
        await statusRelease.promise;
        return { data: {} };
      };

      const completedFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "turn.completed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-stale-abort-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-stale-abort-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => statusStarted.promise);
      staleAbortEvent.resolve({
        id: "evt-delayed-old-abort",
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      statusRelease.resolve(undefined);

      const completed = Option.getOrUndefined(
        yield* Fiber.join(completedFiber).pipe(Effect.timeout("1 second")),
      );
      NodeAssert.equal(completed?.turnId, activeTurn.turnId);
    }),
  );

  it.effect("keeps the newer turn running while status lookup keeps failing", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-idle-status-permanent-failure");
      const busyEvent = promiseWithResolvers<unknown>();
      const idleEvent = promiseWithResolvers<unknown>();
      const firstAttemptFailed = promiseWithResolvers<void>();
      const retryAttemptFailed = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [busyEvent.promise, idleEvent.promise];
      runtimeMock.state.sessionStatusImplementation = async () => {
        if (runtimeMock.state.sessionStatusCalls === 2) {
          firstAttemptFailed.resolve(undefined);
        }
        if (runtimeMock.state.sessionStatusCalls === 4) {
          retryAttemptFailed.resolve(undefined);
        }
        throw new Error("status remains unavailable");
      };

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stoppedTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, stoppedTurn.turnId);
      const activeTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      busyEvent.resolve({
        id: "evt-permanent-failure-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      idleEvent.resolve({
        id: "evt-permanent-failure-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      yield* Effect.promise(() => firstAttemptFailed.promise);
      yield* advanceTestClock(250);
      yield* Effect.promise(() => retryAttemptFailed.promise);

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(session?.activeTurnId, activeTurn.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores delayed stop events around the next turn startup", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-delayed-interrupt-events");
      const staleIdleBeforeBusy = promiseWithResolvers<unknown>();
      const nextBusy = promiseWithResolvers<unknown>();
      const nextUserMessage = promiseWithResolvers<unknown>();
      const staleAbort = promiseWithResolvers<unknown>();
      const staleIdle = promiseWithResolvers<unknown>();
      const secondStaleIdle = promiseWithResolvers<unknown>();
      const nextIdle = promiseWithResolvers<unknown>();
      runtimeMock.state.autoPromptEcho = false;
      runtimeMock.state.subscribedEvents = [
        staleIdleBeforeBusy.promise,
        nextBusy.promise,
        nextUserMessage.promise,
        staleAbort.promise,
        staleIdle.promise,
        secondStaleIdle.promise,
        nextIdle.promise,
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "First turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      yield* adapter.interruptTurn(threadId, firstTurn.turnId);
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Second turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      const secondMessageId = (runtimeMock.state.promptCalls.at(-1) as { messageID: string })
        .messageID;

      staleIdleBeforeBusy.resolve({
        id: "evt-delayed-idle-before-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      for (let index = 0; index < 2; index += 1) {
        yield* Effect.yieldNow;
      }
      const sessionsBeforeBusy = yield* adapter.listSessions();
      const sessionBeforeBusy = sessionsBeforeBusy.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeBusy?.status, "running");
      NodeAssert.equal(sessionBeforeBusy?.activeTurnId, secondTurn.turnId);

      runtimeMock.state.sessionStatus = "busy";
      nextBusy.resolve({
        id: "evt-next-busy",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "busy" },
        },
      });
      nextUserMessage.resolve({
        id: "evt-next-user-message",
        type: "message.updated",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          info: { id: secondMessageId, role: "user" },
        },
      });
      staleAbort.resolve({
        id: "evt-delayed-abort",
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error: { name: "MessageAbortedError", data: { message: "Aborted" } },
        },
      });
      staleIdle.resolve({
        id: "evt-delayed-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      secondStaleIdle.resolve({
        id: "evt-second-delayed-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });
      for (let index = 0; index < 4; index += 1) {
        yield* Effect.yieldNow;
      }

      const sessionsBeforeRealIdle = yield* adapter.listSessions();
      const sessionBeforeRealIdle = sessionsBeforeRealIdle.find(
        (candidate) => candidate.threadId === threadId,
      );
      NodeAssert.equal(sessionBeforeRealIdle?.status, "running");
      NodeAssert.equal(sessionBeforeRealIdle?.activeTurnId, secondTurn.turnId);

      runtimeMock.state.sessionStatus = "idle";
      nextIdle.resolve({
        id: "evt-next-idle",
        type: "session.status",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          status: { type: "idle" },
        },
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error",
          )
          .map((event) => ({ type: event.type, turnId: event.turnId })),
        [
          { type: "turn.aborted", turnId: firstTurn.turnId },
          { type: "turn.completed", turnId: secondTurn.turnId },
        ],
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a genuine provider error visible during a pending user stop", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-interrupt-provider-error");
      const errorEvent = promiseWithResolvers<unknown>();
      const abortStarted = promiseWithResolvers<void>();
      const abortRelease = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [errorEvent.promise];
      runtimeMock.state.abortImplementation = async () => {
        abortStarted.resolve(undefined);
        await abortRelease.promise;
      };

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Keep working",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });

      const interruptFiber = yield* adapter
        .interruptTurn(threadId, turn.turnId)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted.promise);
      errorEvent.resolve({
        id: "evt-provider-error-after-stop",
        type: "session.error",
        properties: {
          sessionID: "http://127.0.0.1:9999/session",
          error: {
            name: "APIError",
            data: { message: "Upstream failed", isRetryable: false },
          },
        },
      });
      yield* Effect.yieldNow;
      abortRelease.resolve(undefined);
      yield* Fiber.join(interruptFiber);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events
          .filter(
            (event) =>
              event.type === "turn.completed" ||
              event.type === "turn.aborted" ||
              event.type === "runtime.error",
          )
          .map((event) => event.type),
        ["turn.completed", "runtime.error"],
      );
      const failed = events.find((event) => event.type === "turn.completed");
      NodeAssert.equal(
        failed?.type === "turn.completed" ? failed.payload.state : undefined,
        "failed",
      );

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "passes agent, variant, and verbosity options for the adapter's bound custom instance id",
    () => {
      const instanceId = ProviderInstanceId.make("opencode_zen");
      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-custom-instance"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-custom-instance"),
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode_zen"),
            "anthropic/claude-sonnet-4-5",
            [
              { id: "agent", value: "github-copilot" },
              { id: "variant", value: "high" },
              { id: "verbosity", value: "high" },
            ],
          ),
        });

        const { messageID, ...prompt } = runtimeMock.state.promptCalls.at(-1) as {
          messageID: string;
          [key: string]: unknown;
        };
        NodeAssert.match(messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
        NodeAssert.deepEqual(prompt, {
          sessionID: "http://127.0.0.1:9999/session",
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5",
          },
          agent: "github-copilot",
          variant: "high",
          verbosity: "high",
          parts: [{ type: "text", text: "Fix it" }],
        });
      }).pipe(Effect.provide(adapterLayer));
    },
  );

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      const { messageID, ...prompt } = runtimeMock.state.promptCalls.at(-1) as {
        messageID: string;
        [key: string]: unknown;
      };
      NodeAssert.match(messageID, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      NodeAssert.deepEqual(prompt, {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      NodeAssert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("classifies a confirmed not-found across the shapes the SDK/runtime can produce", () =>
    Effect.sync(() => {
      // The real production shape: runOpenCodeSdk wraps the thrown Error
      // (cause = { body, status }) under OpenCodeRuntimeError.
      const wrappedError = new Error("Session not found: ses_x", {
        cause: { body: { name: "NotFoundError" }, status: 404 },
      });
      NodeAssert.equal(
        isOpenCodeNotFound({
          _tag: "OpenCodeRuntimeError",
          operation: "session.get",
          detail: "Session not found: ses_x",
          cause: wrappedError,
        }),
        true,
      );

      // 404 expressed only via response.status (the bot's flagged shape).
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 404 } } }), true);
      // 404 via a bare numeric status / statusCode.
      NodeAssert.equal(isOpenCodeNotFound(new Error("x", { cause: { status: 404 } })), true);
      NodeAssert.equal(isOpenCodeNotFound({ statusCode: 404 }), true);
      // OpenCode NotFoundError body name with no status.
      NodeAssert.equal(isOpenCodeNotFound({ body: { name: "NotFoundError" } }), true);

      // NOT a miss: only structured signals count, never free text. A non-404
      // error whose message/detail merely contains "not found" must propagate,
      // not be misread as a missing session and silently start fresh.
      NodeAssert.equal(
        isOpenCodeNotFound(new Error("upstream provider not found", { cause: { status: 500 } })),
        false,
      );
      NodeAssert.equal(isOpenCodeNotFound({ detail: "status=500 body={...not found...}" }), false);
      // An explicit non-404 status seals its subtree: a 500 whose serialized
      // body echoes a NotFoundError name — or that is itself named
      // *NotFound* — is a real failure, never a miss.
      NodeAssert.equal(isOpenCodeNotFound({ status: 500, body: { name: "NotFoundError" } }), false);
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError", status: 500 }), false);
      // A "NotFound"-flavored name that isn't OpenCode's exact `NotFoundError`
      // is not a confirmed miss even without a sealing status.
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError" }), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { name: "ProviderNotFoundError" } }), false);
      NodeAssert.equal(
        isOpenCodeNotFound(
          new Error("x", { cause: { status: 502, body: { name: "NotFoundError" } } }),
        ),
        false,
      );
      // Other transient/auth/network failures must propagate too.
      NodeAssert.equal(isOpenCodeNotFound(new Error("boom", { cause: { status: 500 } })), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 401 } } }), false);
      NodeAssert.equal(isOpenCodeNotFound(new Error("network error (no response)")), false);
      NodeAssert.equal(isOpenCodeNotFound(undefined), false);
    }),
  );

  it.effect("treats lexically or physically identical directories as the same", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sameDirectory = (left: string, right: string) =>
        isSameOpenCodeDirectory(fileSystem, path, left, right);

      // Lexical-only differences (trailing slash, dot segments) short-circuit
      // without touching the filesystem — the paths need not exist.
      NodeAssert.equal(yield* sameDirectory("/repo/project/", "/repo/project"), true);
      NodeAssert.equal(yield* sameDirectory("/repo/nested/../project", "/repo/project"), true);
      // Nonexistent paths degrade to the lexical comparison instead of failing.
      NodeAssert.equal(yield* sameDirectory("/repo/project", "/repo/other"), false);

      // A symlinked cwd (the macOS `/tmp` → `/private/tmp` shape) resolves to
      // the directory it points at, so the two spellings compare equal.
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-dir-" });
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      yield* fileSystem.makeDirectory(real);
      yield* fileSystem.symlink(real, link);
      NodeAssert.equal(yield* sameDirectory(link, real), true);
      NodeAssert.equal(yield* sameDirectory(link, path.join(base, "other")), false);
    }).pipe(Effect.scoped),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect(
    "projects OpenCode compaction summaries without emitting them as assistant messages",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-compaction-summary");
        const sessionID = "http://127.0.0.1:9999/session";
        const assistantInfo = (input: {
          id: string;
          agent: string;
          mode: string;
          created: number;
          completed?: number;
          summary?: boolean;
        }) => ({
          id: input.id,
          sessionID,
          role: "assistant" as const,
          parentID: `${input.id}-parent`,
          modelID: "kimi-k3",
          providerID: "opencode",
          mode: input.mode,
          agent: input.agent,
          path: { cwd: "/repo", root: "/repo" },
          ...(input.summary ? { summary: true } : {}),
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          time: {
            created: input.created,
            ...(input.completed !== undefined ? { completed: input.completed } : {}),
          },
        });
        runtimeMock.state.subscribedEvents = [
          {
            id: "evt-failed-compaction-message",
            type: "message.updated",
            properties: {
              sessionID,
              info: assistantInfo({
                id: "msg-failed-compaction",
                agent: "compaction",
                mode: "compaction",
                created: 0,
                summary: true,
              }),
            },
          },
          {
            id: "evt-failed-compaction-part",
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-failed-compaction",
                sessionID,
                messageID: "msg-failed-compaction",
                type: "text",
                text: "Stale failed summary",
                time: { start: 0, end: 1 },
              },
              time: 1,
            },
          },
          {
            id: "evt-compaction-part-before-message",
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-compaction",
                sessionID,
                messageID: "msg-compaction",
                type: "text",
                text: "Compacted",
                time: { start: 1 },
              },
              time: 1,
            },
          },
          {
            id: "evt-compaction-delta-before-message",
            type: "message.part.delta",
            properties: {
              sessionID,
              messageID: "msg-compaction",
              partID: "part-compaction",
              field: "text",
              delta: " context",
            },
          },
          {
            id: "evt-compaction-message",
            type: "message.updated",
            properties: {
              sessionID,
              info: assistantInfo({
                id: "msg-compaction",
                agent: "compaction",
                mode: "compaction",
                created: 1,
                summary: true,
              }),
            },
          },
          {
            id: "evt-compaction-part-started",
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-compaction",
                sessionID,
                messageID: "msg-compaction",
                type: "text",
                text: "Compacted context",
                time: { start: 1 },
              },
              time: 1,
            },
          },
          {
            id: "evt-compaction-part-delta",
            type: "message.part.delta",
            properties: {
              sessionID,
              messageID: "msg-compaction",
              partID: "part-compaction",
              field: "text",
              delta: " summary",
            },
          },
          {
            id: "evt-compaction-part-completed",
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-compaction",
                sessionID,
                messageID: "msg-compaction",
                type: "text",
                text: "Compacted context summary",
                time: { start: 1, end: 2 },
              },
              time: 2,
            },
          },
          {
            id: "evt-session-compacted",
            type: "session.compacted",
            properties: { sessionID },
          },
          {
            id: "evt-assistant-message",
            type: "message.updated",
            properties: {
              sessionID,
              info: assistantInfo({
                id: "msg-assistant",
                agent: "build",
                mode: "build",
                created: 3,
                completed: 4,
              }),
            },
          },
          {
            id: "evt-assistant-part-completed",
            type: "message.part.updated",
            properties: {
              sessionID,
              part: {
                id: "part-assistant",
                sessionID,
                messageID: "msg-assistant",
                type: "text",
                text: "Normal reply",
                time: { start: 3, end: 4 },
              },
              time: 4,
            },
          },
        ];
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.take(5),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
        const compactionEvents = events.filter((event) => event.type === "thread.state.changed");
        NodeAssert.equal(compactionEvents.length, 1);
        const compactionEvent = compactionEvents[0];
        if (compactionEvent?.type === "thread.state.changed") {
          NodeAssert.equal(compactionEvent.payload.state, "compacted");
          NodeAssert.equal(compactionEvent.payload.detail, "Compacted context summary");
        }
        NodeAssert.deepEqual(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
          ["Normal reply"],
        );
        NodeAssert.deepEqual(
          events
            .filter((event) => event.type === "item.completed")
            .map((event) => (event.type === "item.completed" ? event.payload.detail : undefined)),
          ["Normal reply"],
        );
      }),
  );

  it.effect("lets OpenCode own session title generation and emits title metadata updates", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-sync");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate OpenCode title sync",
            },
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal("title" in (runtimeMock.state.sessionCreateInputs[0] ?? {}), false);

      const metadataUpdated = events.find((event) => event.type === "thread.metadata.updated");
      NodeAssert.ok(metadataUpdated);
      if (metadataUpdated.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated.payload.name, "Investigate OpenCode title sync");
      }
    }),
  );

  it.effect("passes the thread title to session.create when provided", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-provided");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        title: "Investigate reconnect failures",
      });

      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal(
        runtimeMock.state.sessionCreateInputs[0]?.title,
        "Investigate reconnect failures",
      );
    }),
  );

  it.effect("does not mirror OpenCode's default placeholder session titles", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-placeholder-title");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "New session - 2026-08-09T10:20:30.456Z",
            },
          },
        },
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate reconnect failures",
            },
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const metadataUpdated = events.filter((event) => event.type === "thread.metadata.updated");
      NodeAssert.equal(metadataUpdated.length, 1);
      if (metadataUpdated[0]?.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated[0].payload.name, "Investigate reconnect failures");
      }
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          id: "evt-unrelated-child",
          type: "session.created",
          properties: {
            sessionID: "ses_unrelated_child",
            info: {
              id: "ses_unrelated_child",
              parentID: "ses_unrelated_parent",
              title: "Unrelated child",
            },
          },
        },
        {
          id: "evt-unrelated-permission",
          type: "permission.asked",
          properties: {
            id: "per_unrelated",
            sessionID: "ses_unrelated_child",
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
          },
        },
        {
          id: "evt-unrelated-question",
          type: "question.asked",
          properties: {
            id: "que_unrelated",
            sessionID: "ses_unrelated_child",
            questions: [],
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );

  const OPENCODE_TEST_SESSION_ID = "http://127.0.0.1:9999/session";

  const toolPartEvent = (part: Record<string, unknown>) => ({
    type: "message.part.updated" as const,
    properties: {
      sessionID: OPENCODE_TEST_SESSION_ID,
      part,
    },
  });

  const makeToolPart = (
    id: string,
    tool: string,
    callID: string,
    state: Record<string, unknown>,
  ) => ({
    id,
    sessionID: OPENCODE_TEST_SESSION_ID,
    messageID: `msg-${id}`,
    type: "tool",
    callID,
    tool,
    state,
  });

  const collectItemEvents = (threadId: ThreadId, count: number) =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "item.started" ||
              event.type === "item.updated" ||
              event.type === "item.completed"),
        ),
        Stream.take(count),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      return Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("5 seconds")));
    });

  it.effect("emits concise input-derived titles for completed OpenCode tool rows", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-opencode-tool-titles");
      runtimeMock.state.subscribedEvents = [
        toolPartEvent(
          makeToolPart("part-read", "read", "call-read", {
            status: "completed",
            input: { filePath: "/repo/src/auth.ts" },
            output:
              "<path>/repo/src/auth.ts</path>\n<skill_content>huge raw xml payload</skill_content>",
            title: "auth.ts",
            metadata: {},
            time: { start: 1, end: 2 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-skill", "skill", "call-skill", {
            status: "completed",
            input: { name: "release-notes" },
            output: "<skill_content>entire skill markdown body</skill_content>",
            title: "release-notes",
            metadata: {},
            time: { start: 3, end: 4 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-task", "task", "call-task", {
            status: "completed",
            input: {
              description: "Review the auth flow",
              prompt: "Read every file",
              command: "Continue implementation",
            },
            output: "<task_result>raw subagent transcript</task_result>",
            title: "Review the auth flow",
            metadata: {},
            time: { start: 5, end: 6 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-task-prompt", "task", "call-task-prompt", {
            status: "completed",
            input: { prompt: `${"p".repeat(100)}\n${"q".repeat(100)}` },
            output: "<task_result>raw subagent transcript</task_result>",
            title: "x".repeat(400),
            metadata: {},
            time: { start: 7, end: 8 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-bash", "bash", "call-bash", {
            status: "completed",
            input: { command: "pnpm vitest run auth" },
            output: "raw stdout noise",
            title: "pnpm vitest run auth",
            metadata: {},
            time: { start: 9, end: 10 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-mcp", "mcp_database", "call-mcp", {
            status: "completed",
            input: { sql: "select * from users" },
            output: "12 rows",
            title: "Query database",
            metadata: {},
            time: { start: 11, end: 12 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-todowrite", "todowrite", "call-todowrite", {
            status: "completed",
            input: {
              todos: [
                {
                  content: "Inspect bar header implementation",
                  status: "in_progress",
                  priority: "high",
                },
                { content: "Adjust hero contrast", status: "pending", priority: "high" },
              ],
            },
            output:
              '[{"content":"Inspect bar header implementation","status":"in_progress","priority":"high"}]',
            title: "2 todos",
            metadata: {},
            time: { start: 13, end: 14 },
          }),
        ),
      ];

      const events = yield* collectItemEvents(threadId, 7);
      const payloads = events.flatMap((event) =>
        event.type === "item.completed" ? [event.payload] : [],
      );
      NodeAssert.equal(payloads.length, 7);

      const [read, skill, task, taskPrompt, bash, mcp, todoWrite] = payloads;

      NodeAssert.equal(read?.itemType, "dynamic_tool_call");
      NodeAssert.equal(read?.status, "completed");
      NodeAssert.equal(read?.title, "Read File");
      NodeAssert.equal(read?.detail, "/repo/src/auth.ts");
      const readData = read?.data as { state?: { output?: string } } | undefined;
      NodeAssert.equal(readData?.state?.output?.startsWith("<path>"), true);

      NodeAssert.equal(skill?.title, "Skill");
      NodeAssert.equal(skill?.detail, "release-notes");

      // Uncorrelated task calls keep an ordinary completed item row.
      NodeAssert.equal(task?.itemType, "collab_agent_tool_call");
      NodeAssert.equal(task?.status, "completed");
      NodeAssert.equal(task?.title, "Subagent task");
      NodeAssert.equal(task?.detail, "Review the auth flow");
      NodeAssert.equal(taskPrompt?.itemType, "collab_agent_tool_call");
      NodeAssert.equal(taskPrompt?.title, "Subagent task");

      NodeAssert.equal(bash?.itemType, "command_execution");
      NodeAssert.equal(bash?.title, "bash");
      NodeAssert.equal(bash?.detail, "pnpm vitest run auth");

      NodeAssert.equal(mcp?.itemType, "mcp_tool_call");
      NodeAssert.equal(mcp?.detail, "12 rows");

      NodeAssert.equal(todoWrite?.itemType, "dynamic_tool_call");
      NodeAssert.equal(todoWrite?.title, "Update task list");
      NodeAssert.equal(todoWrite?.detail, "Inspect bar header implementation");
    }),
  );

  it.effect("derives running and failed OpenCode tool rows from inputs and errors", () =>
    Effect.gen(function* () {
      const threadId = asThreadId("thread-opencode-tool-running");
      runtimeMock.state.subscribedEvents = [
        toolPartEvent(
          makeToolPart("part-read-run", "read", "call-read-run", {
            status: "running",
            input: { filePath: "/repo/src/main.ts" },
            title: "Reading /repo/src/main.ts",
            metadata: {},
            time: { start: 1 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-task-run", "task", "call-task-run", {
            status: "running",
            input: {},
            title: "Exploring repository structure",
            metadata: {},
            time: { start: 2 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-task-run", "task", "call-task-run", {
            status: "error",
            input: {},
            error: "Unknown subagent type",
            metadata: {},
            time: { start: 2, end: 3 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-bash-err", "bash", "call-bash-err", {
            status: "error",
            input: { command: "pnpm build" },
            error: "exit code 1",
            metadata: {},
            time: { start: 3, end: 4 },
          }),
        ),
      ];

      const events = yield* collectItemEvents(threadId, 3);

      NodeAssert.equal(events[0]?.type, "item.updated");
      const readRunning = events[0];
      if (readRunning?.type !== "item.updated") {
        throw new Error("expected item.updated");
      }
      NodeAssert.equal(readRunning.payload.status, "inProgress");
      NodeAssert.equal(readRunning.payload.title, "Read File");
      NodeAssert.equal(readRunning.payload.detail, "/repo/src/main.ts");

      const taskFailed = events[1];
      if (taskFailed?.type !== "item.completed") {
        throw new Error("expected item.completed");
      }
      NodeAssert.equal(taskFailed.payload.itemType, "collab_agent_tool_call");
      NodeAssert.equal(taskFailed.payload.status, "failed");
      NodeAssert.equal(taskFailed.payload.detail, "Unknown subagent type");

      NodeAssert.equal(events[2]?.type, "item.completed");
      const bashFailed = events[2];
      if (bashFailed?.type !== "item.completed") {
        throw new Error("expected item.completed");
      }
      NodeAssert.equal(bashFailed.payload.status, "failed");
      NodeAssert.equal(bashFailed.payload.title, "bash");
      NodeAssert.equal(bashFailed.payload.detail, "exit code 1");
    }),
  );

  it.effect("streams metadata-correlated child tools through the shared task lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-metadata");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_child_metadata";
      const taskState = {
        status: "running",
        input: { description: "Review the auth flow", subagent_type: "worker" },
        title: "Review the auth flow",
        metadata: {
          parentSessionId: OPENCODE_TEST_SESSION_ID,
          sessionId: childSessionId,
        },
        time: { start: 1 },
      };
      const childTool = (status: "pending" | "running" | "completed") => ({
        type: "message.part.updated",
        properties: {
          sessionID: childSessionId,
          part: {
            id: "part-child-bash",
            sessionID: childSessionId,
            messageID: "msg-child-bash",
            type: "tool",
            callID: "call-child-bash",
            tool: "bash",
            state: {
              status,
              input: { command: "vp test run auth" },
              title: "vp test run auth",
              metadata: {},
              time: status === "completed" ? { start: 2, end: 3 } : { start: 2 },
              ...(status === "completed" ? { output: "passed" } : {}),
            },
          },
        },
      });
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(makeToolPart("part-parent-task", "task", "call-parent-task", taskState)),
        ),
        childTool("pending"),
        childTool("pending"),
        childTool("running"),
        childTool("completed"),
        toolPartEvent(
          makeToolPart("part-parent-task", "task", "call-parent-task", {
            ...taskState,
            status: "completed",
            output: "x".repeat(4_000),
            time: { start: 1, end: 4 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-parent-task", "task", "call-parent-task", {
            ...taskState,
            status: "completed",
            input: { description: "Late wrong title", subagent_type: "wrong-role" },
            output: "late output",
            time: { start: 1, end: 5 },
          }),
        ),
        {
          type: "message.part.updated",
          properties: {
            sessionID: childSessionId,
            part: {
              id: "part-late-child-text",
              sessionID: childSessionId,
              messageID: "msg-late-child-text",
              type: "text",
              text: "Late child output",
              time: { start: 5, end: 6 },
            },
          },
        },
        toolPartEvent(
          makeToolPart("part-parent-task", "task", "call-parent-task", {
            ...taskState,
            status: "completed",
            output: "x".repeat(4_000),
            time: { start: 1, end: 4 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-marker", "bash", "call-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 5, end: 6 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.updated" ||
              event.type === "task.progress" ||
              event.type === "task.completed" ||
              event.type === "tool.progress" ||
              event.type === "item.completed" ||
              event.type === "item.updated"),
        ),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Delegate the review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "task.started",
          "tool.progress",
          "tool.progress",
          "tool.progress",
          "task.completed",
          "item.completed",
        ],
      );
      NodeAssert.equal(
        events.slice(0, 5).every((event) => event.turnId === turn.turnId),
        true,
      );
      const started = events[0];
      NodeAssert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        NodeAssert.equal(started.payload.taskId, childSessionId);
        NodeAssert.equal(started.payload.description, "Review the auth flow");
        NodeAssert.equal(started.payload.title, "Review the auth flow");
        NodeAssert.equal(started.payload.role, "worker");
        NodeAssert.equal(started.payload.timelineBypass, true);
      }
      const toolProgress = events.filter((event) => event.type === "tool.progress");
      NodeAssert.equal(toolProgress.length, 3);
      NodeAssert.equal(
        toolProgress.every(
          (event) => event.type === "tool.progress" && event.payload.taskId === childSessionId,
        ),
        true,
      );
      const completed = events.find((event) => event.type === "task.completed");
      NodeAssert.equal(completed?.type, "task.completed");
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.status, "completed");
        NodeAssert.equal(completed.payload.summary?.length, 2_000);
        NodeAssert.equal(completed.payload.summary?.endsWith("…"), true);
      }
    }),
  );

  it.effect("summarizes accumulated child text deltas instead of raw fragments", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-delta-summary");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_child_delta_summary";
      const childTextDelta = (delta: string) => ({
        type: "message.part.delta" as const,
        properties: {
          sessionID: childSessionId,
          messageID: "msg-child-delta-text",
          partID: "part-child-delta-text",
          field: "text",
          delta,
        },
      });
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-parent-task-delta", "task", "call-parent-task-delta", {
              status: "running",
              input: { description: "Watch the state machine", subagent_type: "worker" },
              title: "Watch the state machine",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
              },
              time: { start: 1 },
            }),
          ),
        ),
        childTextDelta("the"),
        childTextDelta(" em"),
        childTextDelta(" state"),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.updated" ||
              event.type === "task.progress" ||
              event.type === "task.completed"),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Watch the state machine",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.progress", "task.progress", "task.progress"],
      );
      NodeAssert.equal(
        events.slice(1).every((event) => event.turnId === turn.turnId),
        true,
      );
      // Each progress row is the accumulated child text so far, so the status
      // row stays stable instead of flickering per raw token fragment.
      NodeAssert.deepEqual(
        events.flatMap((event) => (event.type === "task.progress" ? [event.payload.summary] : [])),
        ["the", "the em", "the em state"],
      );
    }),
  );

  it.effect("seeds child delta accumulation from authoritative part snapshots", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-snapshot-delta");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_child_snapshot_delta";
      const childTextSnapshot = (partID: string, messageID: string, text: string) => ({
        type: "message.part.updated" as const,
        properties: {
          sessionID: childSessionId,
          part: {
            id: partID,
            sessionID: childSessionId,
            messageID,
            type: "text",
            text,
            time: { start: 1 },
          },
          time: 1,
        },
      });
      const childReasoningSnapshot = (partID: string, messageID: string, text: string) => ({
        type: "message.part.updated" as const,
        properties: {
          sessionID: childSessionId,
          part: {
            id: partID,
            sessionID: childSessionId,
            messageID,
            type: "reasoning",
            text,
            time: { start: 1 },
          },
          time: 2,
        },
      });
      const childDelta = (partID: string, messageID: string, delta: string) => ({
        type: "message.part.delta" as const,
        properties: {
          sessionID: childSessionId,
          messageID,
          partID,
          field: "text",
          delta,
        },
      });
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart(
              "part-parent-task-snapshot-delta",
              "task",
              "call-parent-task-snapshot-delta",
              {
                status: "running",
                input: { description: "Draft the summary", subagent_type: "writer" },
                title: "Draft the summary",
                metadata: {
                  parentSessionId: OPENCODE_TEST_SESSION_ID,
                  sessionId: childSessionId,
                },
                time: { start: 1 },
              },
            ),
          ),
        ),
        // An authoritative snapshot lands first; the next delta must continue
        // from it instead of restarting the accumulator from empty text.
        childTextSnapshot("part-child-snapshot-text", "msg-child-snapshot-text", "the"),
        childDelta("part-child-snapshot-text", "msg-child-snapshot-text", " em"),
        childReasoningSnapshot(
          "part-child-snapshot-reasoning",
          "msg-child-snapshot-reasoning",
          "plan step",
        ),
        childDelta("part-child-snapshot-reasoning", "msg-child-snapshot-reasoning", " two"),
        // An empty snapshot is an authoritative replacement of the part: it
        // must reset that part's accumulator so the next delta starts fresh
        // instead of extending the stale text. Other parts keep theirs.
        childTextSnapshot("part-child-snapshot-text", "msg-child-snapshot-text", ""),
        childDelta("part-child-snapshot-text", "msg-child-snapshot-text", "new"),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.updated" ||
              event.type === "task.progress" ||
              event.type === "task.completed"),
        ),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Draft the summary",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "task.started",
          "task.progress",
          "task.progress",
          "task.progress",
          "task.progress",
          "task.progress",
        ],
      );
      NodeAssert.equal(
        events.slice(1).every((event) => event.turnId === turn.turnId),
        true,
      );
      // Each delta row continues from the snapshot it followed, for text and
      // reasoning parts alike. The empty snapshot resets its part, so the
      // final delta reads "new" instead of extending the stale "the em".
      NodeAssert.deepEqual(
        events.flatMap((event) => (event.type === "task.progress" ? [event.payload.summary] : [])),
        ["the", "the em", "plan step", "plan step two", "new"],
      );
    }),
  );

  it.effect("reports correlated child usage through progress and completion", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-token-usage");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_child_token_usage";
      const childTokens = {
        input: 100,
        output: 40,
        reasoning: 10,
        cache: { read: 50, write: 25 },
      };
      const childUsageEvent = (tokens: typeof childTokens) => ({
        type: "message.updated" as const,
        properties: {
          sessionID: childSessionId,
          info: {
            id: "msg-child-usage",
            role: "assistant",
            tokens,
          },
        },
      });
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-parent-task-usage", "task", "call-parent-task-usage", {
              status: "running",
              input: { description: "Summarize the ledger", subagent_type: "worker" },
              title: "Summarize the ledger",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
              },
              time: { start: 1 },
            }),
          ),
        ),
        // OpenCode initializes a fresh child's token snapshot at all zeros;
        // the initialization must not emit usage or seed a zero baseline.
        childUsageEvent({
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
        childUsageEvent(childTokens),
        // A later step can report a smaller per-step snapshot; the persisted
        // usage must never regress.
        childUsageEvent({
          input: 20,
          output: 5,
          reasoning: 2,
          cache: { read: 4, write: 1 },
        }),
        // OpenCode overwrites the token snapshot at each step finish, so the
        // same values can arrive again; the second copy must not churn events.
        childUsageEvent(childTokens),
        // Raises the input (and total) while lowering output: the field-wise
        // max keeps the higher of each instead of adopting the whole snapshot.
        childUsageEvent({
          input: 130,
          output: 25,
          reasoning: 10,
          cache: { read: 50, write: 25 },
        }),
        // Usage from a session that never correlated must be dropped whole.
        {
          type: "message.updated",
          properties: {
            sessionID: "ses_unrelated_usage",
            info: {
              id: "msg-unrelated-usage",
              role: "assistant",
              tokens: {
                input: 90_000,
                output: 8_000,
                reasoning: 900,
                cache: { read: 7_000, write: 800 },
              },
            },
          },
        },
        toolPartEvent(
          makeToolPart("part-parent-task-usage", "task", "call-parent-task-usage", {
            status: "completed",
            input: { description: "Summarize the ledger", subagent_type: "worker" },
            output: "<task_result>ledger summarized</task_result>",
            title: "Summarize the ledger",
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childSessionId,
            },
            time: { start: 1, end: 5 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.updated" ||
              event.type === "task.progress" ||
              event.type === "task.completed"),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Summarize the ledger",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.progress", "task.progress", "task.completed"],
      );
      NodeAssert.equal(
        events.every((event) => event.turnId === turn.turnId),
        true,
      );
      // input + cache.read + cache.write + output + reasoning, per the
      // snapshot mapping the shared usage contract documents.
      const expectedUsage = {
        totalTokens: 225,
        inputTokens: 175,
        cachedInputTokens: 50,
        outputTokens: 40,
        reasoningOutputTokens: 10,
      };
      // Field-wise max of the high snapshot and the later one that raised
      // input to 130 while lowering output to 25: total 240 and input 205
      // grow, while output keeps its earlier high of 40.
      const expectedMergedUsage = {
        totalTokens: 240,
        inputTokens: 205,
        cachedInputTokens: 50,
        outputTokens: 40,
        reasoningOutputTokens: 10,
      };
      const progressUsages = events.flatMap((event) =>
        event.type === "task.progress" && event.payload.typedUsage
          ? [event.payload.typedUsage]
          : [],
      );
      NodeAssert.deepEqual(progressUsages, [expectedUsage, expectedMergedUsage]);
      const completed = events.find((event) => event.type === "task.completed");
      NodeAssert.equal(completed?.type, "task.completed");
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.status, "completed");
        NodeAssert.deepEqual(completed.payload.typedUsage, expectedMergedUsage);
      }
    }),
  );

  it.effect("discovers a child through parentID and isolates failures and unrelated sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-parent-id");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_child_parent_id";
      const childToolEvent = {
        type: "message.part.updated",
        properties: {
          sessionID: childSessionId,
          part: {
            id: "part-child-read",
            sessionID: childSessionId,
            messageID: "msg-child-read",
            type: "tool",
            callID: "call-child-read",
            tool: "read",
            state: {
              status: "running",
              input: { filePath: "/repo/auth.ts" },
              title: "auth.ts",
              metadata: {},
              time: { start: 2 },
            },
          },
        },
      };
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-parent-task-parent-id", "task", "call-parent-task-parent-id", {
              status: "running",
              input: { description: "Inspect auth", subagent_type: "explore" },
              title: "Inspect auth",
              metadata: {},
              time: { start: 1 },
            }),
          ),
        ),
        {
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: {
              id: childSessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "Child session - 2026-08-30T12:00:00.000Z",
            },
          },
        },
        childToolEvent,
        childToolEvent,
        {
          type: "session.error",
          properties: {
            sessionID: childSessionId,
            error: { name: "ProviderError", data: { message: "Child failed" } },
          },
        },
        {
          type: "session.error",
          properties: {
            sessionID: childSessionId,
            error: { name: "ProviderError", data: { message: "Child failed again" } },
          },
        },
        {
          type: "session.created",
          properties: {
            sessionID: "ses_unrelated",
            info: { id: "ses_unrelated", parentID: "ses_other", title: "Unrelated" },
          },
        },
        {
          ...childToolEvent,
          properties: {
            ...childToolEvent.properties,
            sessionID: "ses_unrelated",
            part: {
              ...childToolEvent.properties.part,
              sessionID: "ses_unrelated",
              callID: "call-unrelated",
            },
          },
        },
        toolPartEvent(
          makeToolPart("part-parent-id-marker", "bash", "call-parent-id-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 5, end: 6 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.updated" ||
              event.type === "task.progress" ||
              event.type === "task.completed" ||
              event.type === "tool.progress" ||
              event.type === "item.completed" ||
              event.type === "item.updated"),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Inspect auth",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "tool.progress", "task.completed", "item.completed"],
      );
      NodeAssert.equal(
        events.slice(0, 3).every((event) => event.turnId === turn.turnId),
        true,
      );
      const started = events[0];
      if (started?.type === "task.started") {
        NodeAssert.equal(started.payload.taskId, childSessionId);
        NodeAssert.equal(started.payload.description, "Inspect auth");
        NodeAssert.equal(started.payload.role, "explore");
      }
      const failed = events[2];
      if (failed?.type === "task.completed") {
        NodeAssert.equal(failed.payload.taskId, childSessionId);
        NodeAssert.equal(failed.payload.status, "failed");
        NodeAssert.equal(failed.payload.summary, "Child failed");
      }
    }),
  );

  it.effect("keeps concurrent OpenCode child sessions separate", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-concurrent-children");
      const releaseEvents = promiseWithResolvers<void>();
      const parentTaskEvent = (
        childSessionId: string,
        description: string,
        role: string,
        status: "running" | "completed" = "running",
      ) =>
        toolPartEvent(
          makeToolPart(`part-${childSessionId}`, "task", `call-${childSessionId}`, {
            status,
            input: { description, subagent_type: role },
            title: description,
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childSessionId,
            },
            ...(status === "completed" ? { output: `${description} done` } : {}),
            time: status === "completed" ? { start: 1, end: 3 } : { start: 1 },
          }),
        );
      const childToolEvent = (childSessionId: string, tool: string) => ({
        type: "message.part.updated",
        properties: {
          sessionID: childSessionId,
          part: {
            id: `part-tool-${childSessionId}`,
            sessionID: childSessionId,
            messageID: `msg-tool-${childSessionId}`,
            type: "tool",
            callID: `call-tool-${childSessionId}`,
            tool,
            state: {
              status: "running",
              input: {},
              title: tool,
              metadata: {},
              time: { start: 2 },
            },
          },
        },
      });
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() => parentTaskEvent("ses_child_a", "Review API", "worker")),
        parentTaskEvent("ses_child_b", "Review UI", "explore"),
        childToolEvent("ses_child_a", "bash"),
        childToolEvent("ses_child_b", "read"),
        {
          type: "session.status",
          properties: { sessionID: "ses_child_b", status: { type: "idle" } },
        },
        {
          type: "session.status",
          properties: { sessionID: "ses_child_a", status: { type: "idle" } },
        },
        parentTaskEvent("ses_child_b", "Review UI", "explore", "completed"),
        parentTaskEvent("ses_child_a", "Review API", "worker", "completed"),
        toolPartEvent(
          makeToolPart("part-concurrent-marker", "bash", "call-concurrent-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 5, end: 6 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "tool.progress" ||
              event.type === "item.completed"),
        ),
        Stream.take(7),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run both reviews",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      const taskEvents = events.filter(
        (event) =>
          event.type === "task.started" ||
          event.type === "task.completed" ||
          event.type === "tool.progress",
      );
      NodeAssert.equal(taskEvents.length, 6);
      NodeAssert.equal(
        taskEvents.every((event) => event.turnId === turn.turnId),
        true,
      );
      const byTask = new Map<string, Array<(typeof taskEvents)[number]>>();
      for (const event of taskEvents) {
        const taskId =
          event.type === "task.started" ||
          event.type === "task.completed" ||
          event.type === "tool.progress"
            ? event.payload.taskId
            : undefined;
        if (taskId) {
          byTask.set(taskId, [...(byTask.get(taskId) ?? []), event]);
        }
      }
      NodeAssert.deepEqual([...byTask.keys()].sort(), ["ses_child_a", "ses_child_b"]);
      NodeAssert.deepEqual(
        byTask.get("ses_child_a")?.map((event) => event.type),
        ["task.started", "tool.progress", "task.completed"],
      );
      NodeAssert.deepEqual(
        byTask.get("ses_child_b")?.map((event) => event.type),
        ["task.started", "tool.progress", "task.completed"],
      );
      const aTool = byTask.get("ses_child_a")?.find((event) => event.type === "tool.progress");
      const bTool = byTask.get("ses_child_b")?.find((event) => event.type === "tool.progress");
      NodeAssert.equal(
        aTool?.type === "tool.progress" ? aTool.payload.toolName : undefined,
        "bash",
      );
      NodeAssert.equal(
        bTool?.type === "tool.progress" ? bTool.payload.toolName : undefined,
        "read",
      );
    }),
  );

  it.effect(
    "keeps background children live through the parent turn and settles on child idle",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-background-child");
        const releaseEvents = promiseWithResolvers<void>();
        const childSessionId = "ses_background_child";
        runtimeMock.state.subscribedEvents = [
          releaseEvents.promise.then(() =>
            toolPartEvent(
              makeToolPart("part-background-task", "task", "call-background-task", {
                status: "completed",
                input: { description: "Watch the build", subagent_type: "worker" },
                title: "Watch the build",
                metadata: {
                  parentSessionId: OPENCODE_TEST_SESSION_ID,
                  sessionId: childSessionId,
                  background: true,
                },
                output: '<task state="running">Still working</task>',
                time: { start: 1, end: 2 },
              }),
            ),
          ),
          {
            type: "session.status",
            properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
          },
          {
            type: "session.status",
            properties: { sessionID: childSessionId, status: { type: "busy" } },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: childSessionId,
              part: {
                id: "part-background-result",
                sessionID: childSessionId,
                messageID: "msg-background-result",
                type: "text",
                text: "R".repeat(4_000),
                time: { start: 2, end: 3 },
              },
            },
          },
          {
            type: "session.status",
            properties: { sessionID: childSessionId, status: { type: "idle" } },
          },
          toolPartEvent(
            makeToolPart("part-background-marker", "bash", "call-background-marker", {
              status: "completed",
              input: { command: "done" },
              output: "done",
              title: "done",
              metadata: {},
              time: { start: 3, end: 4 },
            }),
          ),
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === threadId &&
              (event.type === "task.started" ||
                event.type === "task.completed" ||
                event.type === "turn.completed" ||
                event.type === "item.completed"),
          ),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Start a background watcher",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        });
        releaseEvents.resolve(undefined);

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        NodeAssert.deepEqual(
          events.map((event) => event.type),
          ["task.started", "turn.completed", "task.completed", "item.completed"],
        );
        const completed = events[2];
        if (completed?.type === "task.completed") {
          NodeAssert.equal(completed.turnId, turn.turnId);
          NodeAssert.equal(completed.payload.status, "completed");
          NodeAssert.equal(completed.payload.summary?.length, 2_000);
          NodeAssert.equal(completed.payload.summary?.endsWith("…"), true);
        }
      }),
  );

  it.effect("settles idle-before-metadata background children and bounds session titles", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-background-late-metadata");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_background_late_metadata";
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() => ({
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: {
              id: childSessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "T".repeat(400),
            },
          },
        })),
        {
          type: "session.status",
          properties: { sessionID: childSessionId, status: { type: "idle" } },
        },
        toolPartEvent(
          makeToolPart("part-background-late", "task", "call-background-late", {
            status: "completed",
            input: { subagent_type: "worker" },
            title: "Background audit",
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childSessionId,
              background: true,
            },
            output: '<task state="running">Still working</task>',
            time: { start: 1, end: 2 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-background-late-marker", "bash", "call-background-late-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 3, end: 4 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "item.completed"),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Start a background audit",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed", "item.completed"],
      );
      const started = events[0];
      if (started?.type === "task.started") {
        NodeAssert.equal(started.turnId, turn.turnId);
        NodeAssert.equal(started.payload.title?.length, 240);
        NodeAssert.equal(started.payload.title?.endsWith("…"), true);
        NodeAssert.equal(started.payload.role, "worker");
      }
      const completed = events[1];
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.status, "completed");
      }
    }),
  );

  it.effect("buffers ambiguous child idle and result until exact metadata arrives", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-ambiguous-child-buffer");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_ambiguous_buffered";
      const unboundTask = (suffix: string, description: string) =>
        toolPartEvent(
          makeToolPart(`part-unbound-${suffix}`, "task", `call-unbound-${suffix}`, {
            status: "running",
            input: { description, subagent_type: "worker" },
            title: description,
            metadata: {},
            time: { start: 1 },
          }),
        );
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() => unboundTask("a", "Buffered A")),
        unboundTask("b", "Buffered B"),
        {
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: {
              id: childSessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "Ambiguous child",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: childSessionId,
            part: {
              id: "part-ambiguous-result",
              sessionID: childSessionId,
              messageID: "msg-ambiguous-result",
              type: "text",
              text: "Z".repeat(4_000),
              time: { start: 2, end: 3 },
            },
          },
        },
        {
          type: "session.status",
          properties: { sessionID: childSessionId, status: { type: "idle" } },
        },
        toolPartEvent(
          makeToolPart("part-unbound-a", "task", "call-unbound-a", {
            status: "completed",
            input: { description: "Buffered A", subagent_type: "worker" },
            title: "Buffered A",
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childSessionId,
              background: true,
            },
            output: '<task state="running">Still working</task>',
            time: { start: 1, end: 4 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-ambiguous-marker", "bash", "call-ambiguous-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 5, end: 6 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "item.completed"),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Start ambiguous tasks",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed", "item.completed"],
      );
      NodeAssert.equal(events[0]?.turnId, turn.turnId);
      const completed = events[1];
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.taskId, childSessionId);
        NodeAssert.equal(completed.payload.summary?.length, 2_000);
        NodeAssert.equal(completed.payload.summary?.endsWith("…"), true);
      }
    }),
  );

  it.effect("settles a live child before explicit session stop", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-child");
      const releaseEvents = promiseWithResolvers<void>();
      const childStarted = yield* Deferred.make<void>();
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-stop-child", "task", "call-stop-child", {
              status: "running",
              input: { description: "Long review", subagent_type: "worker" },
              title: "Long review",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: "ses_stop_child",
              },
              time: { start: 1 },
            }),
          ),
        ),
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "session.exited"),
        ),
        Stream.tap((event) =>
          event.type === "task.started"
            ? Deferred.succeed(childStarted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Start a long review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);
      yield* Deferred.await(childStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed", "session.exited"],
      );
      const completed = events[1];
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.status, "stopped");
      }
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [
        "ses_stop_child",
        OPENCODE_TEST_SESSION_ID,
      ]);
    }),
  );

  it.effect("aborts a related child that is still awaiting exact task correlation", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-unbound-child");
      const releaseEvents = promiseWithResolvers<void>();
      const markerObserved = yield* Deferred.make<void>();
      const unboundTask = (suffix: string) =>
        toolPartEvent(
          makeToolPart(`part-stop-unbound-${suffix}`, "task", `call-stop-unbound-${suffix}`, {
            status: "running",
            input: { description: `Unbound ${suffix}`, subagent_type: "worker" },
            title: `Unbound ${suffix}`,
            metadata: {},
            time: { start: 1 },
          }),
        );
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() => unboundTask("a")),
        unboundTask("b"),
        {
          type: "session.created",
          properties: {
            sessionID: "ses_stop_unbound_child",
            info: {
              id: "ses_stop_unbound_child",
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "Unbound child",
            },
          },
        },
        toolPartEvent(
          makeToolPart("part-stop-unbound-marker", "bash", "call-stop-unbound-marker", {
            status: "completed",
            input: { command: "ready" },
            output: "ready",
            title: "ready",
            metadata: {},
            time: { start: 2, end: 3 },
          }),
        ),
      ];
      const markerFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "item.completed" &&
            event.itemId === "call-stop-unbound-marker",
        ),
        Stream.tap(() => Deferred.succeed(markerObserved, undefined).pipe(Effect.asVoid)),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Start ambiguous child",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);
      yield* Deferred.await(markerObserved).pipe(Effect.timeout("2 seconds"));
      yield* adapter.stopSession(threadId);
      yield* Fiber.join(markerFiber);

      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [
        "ses_stop_unbound_child",
        OPENCODE_TEST_SESSION_ID,
      ]);
    }),
  );

  it.effect("aborts a child discovered while its parent session is stopping", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-late-child");
      const childSessionId = "ses_stop_late_child";
      const grandchildSessionId = "ses_stop_late_grandchild";
      const releaseLateChild = promiseWithResolvers<void>();
      const releaseLateGrandchild = promiseWithResolvers<void>();
      const parentAbortStarted = promiseWithResolvers<void>();
      const releaseParentAbort = promiseWithResolvers<void>();
      const childAbortStarted = promiseWithResolvers<void>();
      const releaseChildAbort = promiseWithResolvers<void>();
      const grandchildAbortObserved = promiseWithResolvers<void>();
      runtimeMock.state.abortImplementation = async (sessionId) => {
        if (sessionId === OPENCODE_TEST_SESSION_ID) {
          parentAbortStarted.resolve(undefined);
          await releaseParentAbort.promise;
        } else if (sessionId === childSessionId) {
          childAbortStarted.resolve(undefined);
          await releaseChildAbort.promise;
        } else if (sessionId === grandchildSessionId) {
          grandchildAbortObserved.resolve(undefined);
        }
      };
      runtimeMock.state.subscribedEvents = [
        releaseLateChild.promise.then(() => ({
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: {
              id: childSessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "Late child",
            },
          },
        })),
        releaseLateGrandchild.promise.then(() => ({
          type: "session.created",
          properties: {
            sessionID: grandchildSessionId,
            info: {
              id: grandchildSessionId,
              parentID: childSessionId,
              title: "Late grandchild",
            },
          },
        })),
      ];

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => parentAbortStarted.promise).pipe(Effect.timeout("2 seconds"));
      releaseLateChild.resolve(undefined);
      yield* Effect.promise(() => childAbortStarted.promise).pipe(Effect.timeout("2 seconds"));
      releaseChildAbort.resolve(undefined);
      releaseLateGrandchild.resolve(undefined);
      yield* Effect.promise(() => grandchildAbortObserved.promise).pipe(
        Effect.timeout("2 seconds"),
      );
      releaseParentAbort.resolve(undefined);
      yield* Fiber.join(stopFiber).pipe(Effect.timeout("2 seconds"));

      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [
        OPENCODE_TEST_SESSION_ID,
        childSessionId,
        grandchildSessionId,
      ]);
    }),
  );

  it.effect("settles a live child before replacing its OpenCode session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-replace-child");
      const releaseEvents = promiseWithResolvers<void>();
      const childStarted = yield* Deferred.make<void>();
      runtimeMock.state.createdSessionIds.push("ses_parent_old", "ses_parent_new");
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() => ({
          type: "message.part.updated",
          properties: {
            sessionID: "ses_parent_old",
            part: {
              ...makeToolPart("part-replace-child", "task", "call-replace-child", {
                status: "running",
                input: { description: "Replace review", subagent_type: "worker" },
                title: "Replace review",
                metadata: {
                  parentSessionId: "ses_parent_old",
                  sessionId: "ses_replace_child",
                },
                time: { start: 1 },
              }),
              sessionID: "ses_parent_old",
            },
          },
        })),
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" || event.type === "task.completed"),
        ),
        Stream.tap((event) =>
          event.type === "task.started"
            ? Deferred.succeed(childStarted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Start replace review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);
      yield* Deferred.await(childStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed"],
      );
      const completed = events[1];
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.status, "stopped");
      }
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["ses_replace_child", "ses_parent_old"]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps background child requests on their captured parent turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-background-request-turn");
      const releaseFirstTurn = promiseWithResolvers<void>();
      const releaseSecondTurn = promiseWithResolvers<void>();
      const firstTurnCompleted = yield* Deferred.make<void>();
      const childSessionId = "ses_background_request";
      runtimeMock.state.subscribedEvents = [
        releaseFirstTurn.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-background-request", "task", "call-background-request", {
              status: "completed",
              input: { description: "Background request", subagent_type: "worker" },
              title: "Background request",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
                background: true,
              },
              output: '<task state="running">Still working</task>',
              time: { start: 1, end: 2 },
            }),
          ),
        ),
        {
          type: "session.status",
          properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
        },
        releaseSecondTurn.promise.then(() => ({
          type: "permission.asked",
          properties: {
            id: "per_background_request",
            sessionID: childSessionId,
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
          },
        })),
        {
          type: "permission.replied",
          properties: {
            sessionID: childSessionId,
            requestID: "per_background_request",
            reply: "once",
          },
        },
        toolPartEvent(
          makeToolPart("part-background-request-marker", "bash", "call-background-request-marker", {
            status: "completed",
            input: { command: "second turn" },
            output: "done",
            title: "second turn",
            metadata: {},
            time: { start: 3, end: 4 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "request.opened" ||
              event.type === "request.resolved" ||
              event.type === "item.completed"),
        ),
        Stream.tap((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(firstTurnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start a background request",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseFirstTurn.resolve(undefined);
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("2 seconds"));
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start a new turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseSecondTurn.resolve(undefined);
      releaseSecondTurn.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.completed", "request.opened", "request.resolved", "item.completed"],
      );
      NodeAssert.equal(events[1]?.turnId, firstTurn.turnId);
      NodeAssert.equal(events[2]?.turnId, firstTurn.turnId);
      NodeAssert.equal(events[3]?.turnId, secondTurn.turnId);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("bounds terminal child correlation retention", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-bounded-task-retention");
      const releaseEvents = promiseWithResolvers<void>();
      const taskEvents = Array.from({ length: 130 }, (_, index) =>
        toolPartEvent(
          makeToolPart(`part-retained-${index}`, "task", `call-retained-${index}`, {
            status: "completed",
            input: { description: `Task ${index}`, subagent_type: "worker" },
            title: `Task ${index}`,
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: `ses_retained_${index}`,
            },
            output: `Task ${index} done`,
            time: { start: index + 1, end: index + 2 },
          }),
        ),
      );
      runtimeMock.state.sessionParentById.set("ses_retained_0", OPENCODE_TEST_SESSION_ID);
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() => taskEvents[0]!),
        ...taskEvents.slice(1),
        {
          type: "permission.asked",
          properties: {
            id: "per_evicted_child",
            sessionID: "ses_retained_0",
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
          },
        },
        {
          type: "permission.asked",
          properties: {
            id: "per_retained_child",
            sessionID: "ses_retained_129",
            permission: "bash",
            patterns: ["pwd"],
            metadata: {},
            always: [],
          },
        },
        toolPartEvent(
          makeToolPart("part-retention-marker", "bash", "call-retention-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 200, end: 201 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "item.completed"),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Run many tasks",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["request.opened", "item.completed"],
      );
      NodeAssert.equal(events[0]?.requestId, "per_retained_child");
      NodeAssert.equal(runtimeMock.state.sessionGetIds.includes("ses_retained_0"), false);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not attach a late child event to a newer parent turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-late-child");
      const releaseFirstTurn = promiseWithResolvers<void>();
      const releaseSecondTurn = promiseWithResolvers<void>();
      const childSessionId = "ses_child_old_turn";
      runtimeMock.state.subscribedEvents = [
        releaseFirstTurn.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-old-task", "task", "call-old-task", {
              status: "running",
              input: { description: "Old task", subagent_type: "worker" },
              title: "Old task",
              metadata: {},
              time: { start: 1 },
            }),
          ),
        ),
        {
          type: "session.status",
          properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
        },
        releaseSecondTurn.promise.then(() => ({
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: {
              id: childSessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "Late child",
            },
          },
        })),
        toolPartEvent(
          makeToolPart("part-old-task", "task", "call-old-task", {
            status: "completed",
            input: { description: "Old task", subagent_type: "worker" },
            title: "Old task",
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childSessionId,
            },
            output: "Old task done",
            time: { start: 1, end: 2 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-late-marker", "bash", "call-late-marker", {
            status: "completed",
            input: { command: "second turn" },
            output: "done",
            title: "second turn",
            metadata: {},
            time: { start: 3, end: 4 },
          }),
        ),
      ];

      const firstTurnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "tool.progress" ||
              event.type === "turn.completed" ||
              event.type === "item.completed"),
        ),
        Stream.tap((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(firstTurnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run the old task",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseFirstTurn.resolve(undefined);
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("2 seconds"));
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start a new turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseSecondTurn.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.completed", "task.started", "task.completed", "item.completed"],
      );
      NodeAssert.equal(events[1]?.turnId, firstTurn.turnId);
      NodeAssert.equal(events[2]?.turnId, firstTurn.turnId);
      NodeAssert.equal(events[3]?.turnId, secondTurn.turnId);
    }),
  );

  it.effect("does not let a stale unbound task call claim a child discovered in a later turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale-unbound-task-child");
      const releaseFirstTurn = promiseWithResolvers<void>();
      const releaseSecondTurn = promiseWithResolvers<void>();
      const childSessionId = "ses_child_after_stale_task";
      const staleTaskState = {
        status: "running",
        input: { description: "Stale review", subagent_type: "worker" },
        title: "Stale review",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        releaseFirstTurn.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-stale-task", "task", "call-stale-task", {
              ...staleTaskState,
              metadata: {},
            }),
          ),
        ),
        {
          type: "session.status",
          properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
        },
        releaseSecondTurn.promise.then(() => ({
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: {
              id: childSessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "Child from turn two",
            },
          },
        })),
        {
          type: "session.status",
          properties: { sessionID: childSessionId, status: { type: "busy" } },
        },
        toolPartEvent(
          makeToolPart("part-stale-task", "task", "call-stale-task", {
            ...staleTaskState,
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childSessionId,
            },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-stale-task-marker", "bash", "call-stale-task-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 2, end: 3 },
          }),
        ),
      ];

      const firstTurnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.updated" ||
              event.type === "task.completed" ||
              event.type === "turn.completed" ||
              event.type === "item.completed"),
        ),
        Stream.tap((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(firstTurnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start the stale review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseFirstTurn.resolve(undefined);
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("2 seconds"));
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Start a new turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseSecondTurn.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      // The turn-one call stays unbound when the child surfaces during turn
      // two: no claim at discovery, no linkage churn from the buffered child
      // status, and the exact metadata performs the only binding.
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.completed", "task.started", "item.completed"],
      );
      NodeAssert.equal(events[0]?.turnId, firstTurn.turnId);
      const started = events[1];
      if (started?.type === "task.started") {
        NodeAssert.equal(started.turnId, firstTurn.turnId);
        NodeAssert.equal(started.payload.taskId, childSessionId);
        NodeAssert.equal(started.payload.description, "Stale review");
        NodeAssert.equal(started.payload.role, "worker");
        NodeAssert.equal(started.payload.toolUseId, "call-stale-task");
        NodeAssert.equal(started.payload.timelineBypass, true);
      }
      NodeAssert.equal(events[2]?.turnId, secondTurn.turnId);
    }),
  );

  it.effect(
    "keeps a discovery-bound child live through root idle until its background metadata lands",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-discovery-bound-background");
        const releaseEvents = promiseWithResolvers<void>();
        const childSessionId = "ses_discovery_bound_child";
        runtimeMock.state.subscribedEvents = [
          releaseEvents.promise.then(() =>
            toolPartEvent(
              makeToolPart("part-discovery-task", "task", "call-discovery-task", {
                status: "running",
                input: { description: "Watch the deploy", subagent_type: "worker" },
                title: "Watch the deploy",
                metadata: {},
                time: { start: 1 },
              }),
            ),
          ),
          {
            type: "session.created",
            properties: {
              sessionID: childSessionId,
              info: {
                id: childSessionId,
                parentID: OPENCODE_TEST_SESSION_ID,
                title: "Deploy watcher",
              },
            },
          },
          {
            type: "session.status",
            properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: childSessionId,
              part: {
                id: "part-discovery-result",
                sessionID: childSessionId,
                messageID: "msg-discovery-result",
                type: "text",
                text: "D".repeat(4_000),
                time: { start: 2, end: 3 },
              },
            },
          },
          {
            type: "session.status",
            properties: { sessionID: childSessionId, status: { type: "idle" } },
          },
          toolPartEvent(
            makeToolPart("part-discovery-task", "task", "call-discovery-task", {
              status: "completed",
              input: { description: "Watch the deploy", subagent_type: "worker" },
              title: "Watch the deploy",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
                background: true,
              },
              output: '<task state="running">Still working</task>',
              time: { start: 1, end: 4 },
            }),
          ),
          toolPartEvent(
            makeToolPart("part-discovery-marker", "bash", "call-discovery-marker", {
              status: "completed",
              input: { command: "done" },
              output: "done",
              title: "done",
              metadata: {},
              time: { start: 5, end: 6 },
            }),
          ),
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === threadId &&
              (event.type === "task.started" ||
                event.type === "task.completed" ||
                event.type === "turn.completed" ||
                event.type === "item.completed"),
          ),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Start the deploy watcher",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        });
        releaseEvents.resolve(undefined);

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        // The child binds through sole-candidate discovery, so root idle
        // completes the turn but must not complete the background-unknown
        // child; the exact background metadata plus the observed child idle
        // is what settles it.
        NodeAssert.deepEqual(
          events.map((event) => event.type),
          ["task.started", "turn.completed", "task.completed", "item.completed"],
        );
        NodeAssert.equal(
          events.slice(0, 3).every((event) => event.turnId === turn.turnId),
          true,
        );
        const completed = events[2];
        if (completed?.type === "task.completed") {
          NodeAssert.equal(completed.payload.taskId, childSessionId);
          NodeAssert.equal(completed.payload.status, "completed");
          NodeAssert.equal(completed.payload.summary?.length, 2_000);
          NodeAssert.equal(completed.payload.summary?.endsWith("…"), true);
        }
      }),
  );

  it.effect(
    "rebinds a provisionally discovered child when exact metadata names another same-turn task",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-provisional-rebind");
        const releaseEvents = promiseWithResolvers<void>();
        const childSessionId = "ses_rebound_child";
        runtimeMock.state.subscribedEvents = [
          releaseEvents.promise.then(() =>
            toolPartEvent(
              makeToolPart("part-rebind-a", "task", "call-rebind-a", {
                status: "running",
                input: { description: "Ambiguous review", subagent_type: "worker" },
                title: "Ambiguous review",
                metadata: {},
                time: { start: 1 },
              }),
            ),
          ),
          {
            type: "session.created",
            properties: {
              sessionID: childSessionId,
              info: {
                id: childSessionId,
                parentID: OPENCODE_TEST_SESSION_ID,
                title: "Rebound child",
              },
            },
          },
          toolPartEvent(
            makeToolPart("part-rebind-b", "task", "call-rebind-b", {
              status: "running",
              input: { description: "Exact review", subagent_type: "worker" },
              title: "Exact review",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
              },
              time: { start: 2 },
            }),
          ),
          toolPartEvent(
            makeToolPart("part-rebind-a", "task", "call-rebind-a", {
              status: "completed",
              input: { description: "Ambiguous review", subagent_type: "worker" },
              output: "<task_result>raw subagent transcript</task_result>",
              title: "Ambiguous review",
              metadata: {},
              time: { start: 2, end: 3 },
            }),
          ),
          toolPartEvent(
            makeToolPart("part-rebind-marker", "bash", "call-rebind-marker", {
              status: "completed",
              input: { command: "done" },
              output: "done",
              title: "done",
              metadata: {},
              time: { start: 3, end: 4 },
            }),
          ),
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === threadId &&
              (event.type === "task.started" ||
                event.type === "task.updated" ||
                event.type === "task.completed" ||
                event.type === "item.completed"),
          ),
          Stream.take(4),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Start ambiguous and exact tasks",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        });
        releaseEvents.resolve(undefined);

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        // The sole-candidate discovery binds call-rebind-a provisionally, the
        // exact metadata rebinds the child to call-rebind-b, and the detached
        // call keeps only its ordinary completed item row — one owner, no
        // duplicate lifecycle.
        NodeAssert.deepEqual(
          events.map((event) => event.type),
          ["task.started", "task.updated", "item.completed", "item.completed"],
        );
        NodeAssert.equal(
          events.every((event) => event.turnId === turn.turnId),
          true,
        );
        const started = events[0];
        if (started?.type === "task.started") {
          NodeAssert.equal(started.payload.taskId, childSessionId);
          NodeAssert.equal(started.payload.toolUseId, "call-rebind-a");
          NodeAssert.equal(started.payload.title, "Ambiguous review");
        }
        const updated = events[1];
        if (updated?.type === "task.updated") {
          NodeAssert.equal(updated.payload.taskId, childSessionId);
          NodeAssert.equal(updated.payload.toolUseId, "call-rebind-b");
          NodeAssert.equal(updated.payload.title, "Exact review");
        }
        const detachedRow = events[2];
        if (detachedRow?.type === "item.completed") {
          NodeAssert.equal(detachedRow.itemId, "call-rebind-a");
          NodeAssert.equal(detachedRow.payload.itemType, "collab_agent_tool_call");
          NodeAssert.equal(detachedRow.payload.title, "Subagent task");
          NodeAssert.equal(detachedRow.payload.status, "completed");
        }
        NodeAssert.equal(
          events[3]?.type === "item.completed" && events[3]?.itemId,
          "call-rebind-marker",
        );
      }),
  );

  it.effect("settles an exact foreground child through the root idle fallback", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-exact-foreground-idle");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_exact_foreground_child";
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-exact-foreground", "task", "call-exact-foreground", {
              status: "running",
              input: { description: "Foreground review", subagent_type: "worker" },
              title: "Foreground review",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
              },
              time: { start: 1 },
            }),
          ),
        ),
        {
          type: "session.status",
          properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
        },
        toolPartEvent(
          makeToolPart("part-exact-foreground-marker", "bash", "call-exact-foreground-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 2, end: 3 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "turn.completed" ||
              event.type === "item.completed"),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Start the foreground review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      // Exact running metadata without a `background` flag is known
      // foreground, so the root idle fallback settles the child.
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed", "turn.completed", "item.completed"],
      );
      NodeAssert.equal(
        events.slice(0, 3).every((event) => event.turnId === turn.turnId),
        true,
      );
      const completed = events[1];
      if (completed?.type === "task.completed") {
        NodeAssert.equal(completed.payload.taskId, childSessionId);
        NodeAssert.equal(completed.payload.status, "completed");
        NodeAssert.equal(completed.payload.toolUseId, "call-exact-foreground");
      }
    }),
  );

  it.effect("emits the inner result for OpenCode task output envelope", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-task-output-envelope");
      // OpenCode's task tool wraps its output in a protocol envelope (see
      // upstream `renderOutput`): `<task id=… state=…>` around an optional
      // `<summary>` and a `<task_result>`/`<task_error>` block. Only a whole
      // anchored envelope unwraps; anything else passes through untouched.
      // `summary` is the unwrapped expectation; omit it to assert the
      // original output passes through (modulo the boundary trim).
      const envelope = (sessionId: string, inner: string) =>
        `<task id="${sessionId}" state="completed">\n${inner}\n</task>\n`;
      const taskCases: ReadonlyArray<{
        sessionId: string;
        output: string;
        summary?: string;
      }> = [
        {
          sessionId: "ses_envelope_summary",
          output: envelope(
            "ses_envelope_summary",
            "<summary>Background task completed: Envelope review</summary>\n<task_result>\nLine one.\nLine two.\n</task_result>",
          ),
          summary: "Line one.\nLine two.",
        },
        {
          sessionId: "ses_envelope_no_summary",
          output: envelope(
            "ses_envelope_no_summary",
            "<task_result>\n  Indented result body.\n</task_result>",
          ),
          summary: "Indented result body.",
        },
        {
          sessionId: "ses_envelope_error",
          output: envelope(
            "ses_envelope_error",
            "<summary>Background task failed: Envelope review</summary>\n<task_error>\nThe child blew up.\n</task_error>",
          ),
          summary: "The child blew up.",
        },
        {
          sessionId: "ses_bare_result",
          output: "<task_result>bare result stays visible</task_result>",
        },
        {
          sessionId: "ses_bare_error",
          output: "<task_error>bare error stays visible</task_error>",
        },
        {
          sessionId: "ses_mismatched_tags",
          output: envelope("ses_mismatched_tags", "<task_result>mismatched</task_error>"),
        },
        {
          sessionId: "ses_no_result_block",
          output: '<task id="ses_no_result_block" state="completed">plain wrapper text</task>',
        },
        {
          sessionId: "ses_malformed_markup",
          output: envelope(
            "ses_malformed_markup",
            "<task_result>never closed</task_result>",
          ).replace("</task>\n", ""),
        },
        {
          sessionId: "ses_embedded_xml",
          output: 'See <task id="ses_other" state="completed">inner</task> for details.',
        },
      ];
      const releaseAll = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = taskCases.map((taskCase, index) =>
        releaseAll.promise.then(() =>
          toolPartEvent(
            makeToolPart(`part-envelope-${index}`, "task", `call-envelope-${index}`, {
              status: "completed",
              input: { description: "Envelope review", subagent_type: "worker" },
              title: "Envelope review",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: taskCase.sessionId,
              },
              output: taskCase.output,
              time: { start: index * 2 + 1, end: index * 2 + 2 },
            }),
          ),
        ),
      );

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" || event.type === "task.completed"),
        ),
        Stream.take(taskCases.length * 2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run envelope and plain reviews",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseAll.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("5 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        taskCases.flatMap(() => ["task.started", "task.completed"]),
      );
      NodeAssert.equal(
        events.every((event) => event.turnId === turn.turnId),
        true,
      );
      for (const [index, taskCase] of taskCases.entries()) {
        const completed = events[index * 2 + 1];
        NodeAssert.ok(completed?.type === "task.completed");
        NodeAssert.equal(completed.payload.taskId, taskCase.sessionId, taskCase.sessionId);
        NodeAssert.equal(completed.payload.status, "completed");
        NodeAssert.equal(
          completed.payload.summary,
          taskCase.summary ?? taskCase.output.trim(),
          taskCase.sessionId,
        );
      }
    }),
  );

  it.effect("keeps an ordinary completed row for an uncorrelated task call", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-uncorrelated-task-row");
      const releaseEvents = promiseWithResolvers<void>();
      const childSessionId = "ses_uncorrelated_row_child";
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-correlated-task", "task", "call-correlated-task", {
              status: "completed",
              input: { description: "Tracked review", subagent_type: "worker" },
              output: "<task_result>raw subagent transcript</task_result>",
              title: "Tracked review",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
              },
              time: { start: 1, end: 2 },
            }),
          ),
        ),
        toolPartEvent(
          makeToolPart("part-uncorrelated-task", "task", "call-uncorrelated-task", {
            status: "completed",
            input: { description: "Untracked review", subagent_type: "worker" },
            output: "<task_result>raw subagent transcript</task_result>",
            title: "Untracked review",
            metadata: {},
            time: { start: 3, end: 4 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-uncorrelated-marker", "bash", "call-uncorrelated-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 5, end: 6 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "item.completed"),
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run tracked and untracked reviews",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      // The correlated call is represented by the shared child lifecycle
      // alone; the uncorrelated successful call keeps its ordinary row.
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed", "item.completed", "item.completed"],
      );
      NodeAssert.equal(
        events.slice(0, 2).every((event) => event.turnId === turn.turnId),
        true,
      );
      const uncorrelatedRow = events[2];
      if (uncorrelatedRow?.type === "item.completed") {
        NodeAssert.equal(uncorrelatedRow.itemId, "call-uncorrelated-task");
        NodeAssert.equal(uncorrelatedRow.payload.itemType, "collab_agent_tool_call");
        NodeAssert.equal(uncorrelatedRow.payload.title, "Subagent task");
        NodeAssert.equal(uncorrelatedRow.payload.status, "completed");
        NodeAssert.equal(uncorrelatedRow.payload.detail, "Untracked review");
      }
      NodeAssert.equal(
        events[3]?.type === "item.completed" && events[3]?.itemId,
        "call-uncorrelated-marker",
      );
    }),
  );

  it.effect(
    "aborts a descendant discovered under an already-terminal child task without lifecycle rows",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-terminal-child-descendant");
        const releaseEvents = promiseWithResolvers<void>();
        const childSessionId = "ses_terminal_child";
        const grandchildSessionId = "ses_descendant_of_terminal";
        const discoveredGrandchildSessionId = "ses_discovered_descendant_of_terminal";
        runtimeMock.state.subscribedEvents = [
          releaseEvents.promise.then(() =>
            toolPartEvent(
              makeToolPart("part-terminal-child", "task", "call-terminal-child", {
                status: "running",
                input: { description: "Terminal review", subagent_type: "worker" },
                title: "Terminal review",
                metadata: {
                  parentSessionId: OPENCODE_TEST_SESSION_ID,
                  sessionId: childSessionId,
                },
                time: { start: 1 },
              }),
            ),
          ),
          toolPartEvent(
            makeToolPart("part-terminal-child", "task", "call-terminal-child", {
              status: "error",
              input: { description: "Terminal review", subagent_type: "worker" },
              error: "Subagent crashed",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childSessionId,
              },
              time: { start: 1, end: 2 },
            }),
          ),
          {
            type: "message.part.updated",
            properties: {
              sessionID: childSessionId,
              part: {
                ...makeToolPart("part-terminal-descendant", "task", "call-terminal-descendant", {
                  status: "running",
                  input: { description: "Orphan descendant", subagent_type: "worker" },
                  title: "Orphan descendant",
                  metadata: {
                    parentSessionId: childSessionId,
                    sessionId: grandchildSessionId,
                  },
                  time: { start: 3 },
                }),
                sessionID: childSessionId,
              },
            },
          },
          {
            type: "session.created",
            properties: {
              sessionID: discoveredGrandchildSessionId,
              info: {
                id: discoveredGrandchildSessionId,
                parentID: childSessionId,
                title: "Discovered orphan descendant",
              },
            },
          },
          {
            type: "message.part.updated",
            properties: {
              sessionID: grandchildSessionId,
              part: {
                id: "part-descendant-output",
                sessionID: grandchildSessionId,
                messageID: "msg-descendant-output",
                type: "text",
                text: "Orphan output",
                time: { start: 4, end: 5 },
              },
            },
          },
          toolPartEvent(
            makeToolPart("part-terminal-marker", "bash", "call-terminal-marker", {
              status: "completed",
              input: { command: "done" },
              output: "done",
              title: "done",
              metadata: {},
              time: { start: 6, end: 7 },
            }),
          ),
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === threadId &&
              (event.type === "task.started" ||
                event.type === "task.completed" ||
                event.type === "turn.completed" ||
                event.type === "item.completed"),
          ),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Start the terminal review",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        });
        releaseEvents.resolve(undefined);

        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        // The descendant is denied outright: one abort, no lifecycle rows of
        // its own, and its late output never routes anywhere.
        NodeAssert.deepEqual(
          events.map((event) => event.type),
          ["task.started", "task.completed", "item.completed"],
        );
        NodeAssert.equal(
          events.every((event) => event.turnId === turn.turnId),
          true,
        );
        const failed = events[1];
        if (failed?.type === "task.completed") {
          NodeAssert.equal(failed.payload.taskId, childSessionId);
          NodeAssert.equal(failed.payload.status, "failed");
          NodeAssert.equal(failed.payload.summary, "Subagent crashed");
        }
        NodeAssert.deepEqual(runtimeMock.state.abortCalls, [
          grandchildSessionId,
          discoveredGrandchildSessionId,
        ]);
      }),
  );

  it.effect(
    "settles a failing child's nested descendant in order without duplicate lifecycle",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-nested-child-failure");
        const childAId = "ses_nested_child_a";
        const childBId = "ses_nested_child_b";
        const releaseEvents = promiseWithResolvers<void>();
        runtimeMock.state.subscribedEvents = [
          releaseEvents.promise.then(() =>
            toolPartEvent(
              makeToolPart("part-nested-root-task", "task", "call-nested-root-task", {
                status: "running",
                input: { description: "Root review", subagent_type: "worker" },
                title: "Root review",
                metadata: {
                  parentSessionId: OPENCODE_TEST_SESSION_ID,
                  sessionId: childAId,
                },
                time: { start: 1 },
              }),
            ),
          ),
          {
            type: "message.part.updated",
            properties: {
              sessionID: childAId,
              part: {
                ...makeToolPart("part-nested-child-task", "task", "call-nested-child-task", {
                  status: "running",
                  input: { description: "Nested review", subagent_type: "worker" },
                  title: "Nested review",
                  metadata: {
                    parentSessionId: childAId,
                    sessionId: childBId,
                  },
                  time: { start: 2 },
                }),
                sessionID: childAId,
              },
            },
          },
          toolPartEvent(
            makeToolPart("part-nested-root-task", "task", "call-nested-root-task", {
              status: "error",
              input: { description: "Root review", subagent_type: "worker" },
              error: "Subagent crashed",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childAId,
              },
              time: { start: 3, end: 4 },
            }),
          ),
          toolPartEvent(
            makeToolPart("part-nested-marker", "bash", "call-nested-marker", {
              status: "completed",
              input: { command: "done" },
              output: "done",
              title: "done",
              metadata: {},
              time: { start: 5, end: 6 },
            }),
          ),
        ];

        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.filter(
            (event) =>
              event.threadId === threadId &&
              (event.type === "task.started" ||
                event.type === "task.completed" ||
                (event.type === "item.completed" && event.itemId === "call-nested-marker")),
          ),
          Stream.take(5),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Run the nested review",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "opencode/kimi-k3",
          ),
        });
        releaseEvents.resolve(undefined);

        // The marker row is processed last by the sequential event pump, so its
        // arrival proves the failed settle (and B's abort) already completed.
        const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
        NodeAssert.deepEqual(
          events.map((event) => event.type),
          ["task.started", "task.started", "task.completed", "task.completed", "item.completed"],
        );
        const taskRows = events.filter(
          (event) => event.type === "task.started" || event.type === "task.completed",
        );
        NodeAssert.deepEqual(
          taskRows.map((event) => [event.type, event.turnId === turn.turnId]),
          [
            ["task.started", true],
            ["task.started", true],
            ["task.completed", true],
            ["task.completed", true],
          ],
        );
        const startedA = taskRows[0];
        if (startedA?.type === "task.started") {
          NodeAssert.equal(startedA.payload.taskId, childAId);
          NodeAssert.equal(startedA.payload.description, "Root review");
          NodeAssert.equal(startedA.payload.parentAgentId, undefined);
        }
        const startedB = taskRows[1];
        if (startedB?.type === "task.started") {
          NodeAssert.equal(startedB.payload.taskId, childBId);
          NodeAssert.equal(startedB.payload.description, "Nested review");
          NodeAssert.equal(startedB.payload.parentAgentId, childAId);
        }
        const failedA = taskRows[2];
        if (failedA?.type === "task.completed") {
          NodeAssert.equal(failedA.payload.taskId, childAId);
          NodeAssert.equal(failedA.payload.status, "failed");
          NodeAssert.equal(failedA.payload.summary, "Subagent crashed");
        }
        const stoppedB = taskRows[3];
        if (stoppedB?.type === "task.completed") {
          NodeAssert.equal(stoppedB.payload.taskId, childBId);
          NodeAssert.equal(stoppedB.payload.status, "stopped");
        }
        NodeAssert.deepEqual(runtimeMock.state.abortCalls, [childBId]);

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("denies a pending lineage discovered under a failed child without lifecycle rows", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-pending-lineage");
      const childAId = "ses_pending_lineage_a";
      const childBId = "ses_pending_lineage_b";
      const childCId = "ses_pending_lineage_c";
      const releaseEvents = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-pending-lineage-root-task", "task", "call-pending-lineage-root", {
              status: "running",
              input: { description: "Lineage review", subagent_type: "worker" },
              title: "Lineage review",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: childAId,
              },
              time: { start: 1 },
            }),
          ),
        ),
        {
          type: "session.created",
          properties: {
            sessionID: childBId,
            info: {
              id: childBId,
              parentID: childAId,
              title: "Pending child",
            },
          },
        },
        toolPartEvent(
          makeToolPart("part-pending-lineage-root-task", "task", "call-pending-lineage-root", {
            status: "error",
            input: { description: "Lineage review", subagent_type: "worker" },
            error: "Subagent crashed",
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childAId,
            },
            time: { start: 2, end: 3 },
          }),
        ),
        {
          type: "session.created",
          properties: {
            sessionID: childCId,
            info: {
              id: childCId,
              parentID: childBId,
              title: "Grandchild of denied pending child",
            },
          },
        },
        toolPartEvent(
          makeToolPart("part-pending-lineage-marker", "bash", "call-pending-lineage-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 4, end: 5 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              (event.type === "item.completed" && event.itemId === "call-pending-lineage-marker")),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Run the lineage review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) =>
          event.type === "task.started" || event.type === "task.completed"
            ? [event.type, event.payload.taskId]
            : [event.type, undefined],
        ),
        [
          ["task.started", childAId],
          ["task.completed", childAId],
          ["item.completed", undefined],
        ],
      );
      const failedA = events[1];
      if (failedA?.type === "task.completed") {
        NodeAssert.equal(failedA.payload.status, "failed");
      }
      // B was pending under A, so its denial is silent: aborted, never given
      // a lifecycle row.
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [childBId, childCId]);
    }),
  );

  it.effect("keeps a pending child's request on the turn where the child was discovered", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-pending-child-request-turn");
      const childSessionId = "ses_pending_request_turn";
      const releaseFirstTurn = promiseWithResolvers<void>();
      const releaseSecondTurn = promiseWithResolvers<void>();
      const firstTurnCompleted = yield* Deferred.make<void>();
      runtimeMock.state.subscribedEvents = [
        releaseFirstTurn.promise.then(() => ({
          type: "session.created",
          properties: {
            sessionID: childSessionId,
            info: {
              id: childSessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: "Pending request child",
            },
          },
        })),
        {
          type: "session.status",
          properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
        },
        releaseSecondTurn.promise.then(() => ({
          type: "permission.asked",
          properties: permissionRequest("per_pending_turn", childSessionId),
        })),
        toolPartEvent(
          makeToolPart("part-pending-request-marker", "bash", "call-pending-request-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 2, end: 3 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "turn.completed" ||
              event.type === "request.opened" ||
              (event.type === "item.completed" && event.itemId === "call-pending-request-marker")),
        ),
        Stream.tap((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(firstTurnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "Discover a pending child",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseFirstTurn.resolve(undefined);
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("2 seconds"));
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Continue while the child waits",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseSecondTurn.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["turn.completed", "request.opened", "item.completed"],
      );
      NodeAssert.equal(events[0]?.turnId, firstTurn.turnId);
      NodeAssert.equal(events[1]?.turnId, firstTurn.turnId);
      NodeAssert.equal(events[2]?.turnId, secondTurn.turnId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("per_pending_turn"),
        "accept",
      );
      NodeAssert.deepEqual(runtimeMock.state.permissionReplyCalls, [
        { requestID: "per_pending_turn", reply: "once" },
      ]);
    }),
  );

  it.effect("forgets a pending child's open request when its ancestor fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-denied-child-request-cleanup");
      const parentChildSessionId = "ses_request_cleanup_parent";
      const pendingChildSessionId = "ses_request_cleanup_pending";
      const releaseEvents = promiseWithResolvers<void>();
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() =>
          toolPartEvent(
            makeToolPart("part-request-cleanup-parent", "task", "call-request-cleanup-parent", {
              status: "running",
              input: { description: "Parent review", subagent_type: "worker" },
              title: "Parent review",
              metadata: {
                parentSessionId: OPENCODE_TEST_SESSION_ID,
                sessionId: parentChildSessionId,
              },
              time: { start: 1 },
            }),
          ),
        ),
        {
          type: "session.created",
          properties: {
            sessionID: pendingChildSessionId,
            info: {
              id: pendingChildSessionId,
              parentID: parentChildSessionId,
              title: "Pending nested request",
            },
          },
        },
        {
          type: "question.asked",
          properties: questionRequest("que_denied_child", pendingChildSessionId),
        },
        {
          type: "session.error",
          properties: {
            sessionID: parentChildSessionId,
            error: { name: "ProviderError", data: { message: "Parent child failed" } },
          },
        },
        {
          type: "question.replied",
          properties: {
            sessionID: pendingChildSessionId,
            requestID: "que_denied_child",
            answers: [["Workspace"]],
          },
        },
        toolPartEvent(
          makeToolPart("part-request-cleanup-marker", "bash", "call-request-cleanup-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 2, end: 3 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "user-input.requested" ||
              event.type === "user-input.resolved" ||
              (event.type === "item.completed" && event.itemId === "call-request-cleanup-marker")),
        ),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "Run a nested review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "task.started",
          "user-input.requested",
          "task.completed",
          "user-input.resolved",
          "item.completed",
        ],
      );
      NodeAssert.equal(events[1]?.turnId, turn.turnId);
      NodeAssert.equal(events[3]?.turnId, turn.turnId);
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [pendingChildSessionId]);
      const response = yield* Effect.result(
        adapter.respondToUserInput(threadId, ApprovalRequestId.make("que_denied_child"), {
          Scope: "Workspace",
        }),
      );
      NodeAssert.equal(Result.isFailure(response), true);
      NodeAssert.deepEqual(runtimeMock.state.questionReplyCalls, []);
    }),
  );

  it.effect("bounds resolved request deduplication with a defined rollover window", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-request-tombstone-rollover");
      const releaseEvents = promiseWithResolvers<void>();
      const requestPair = (index: number) => {
        const requestId = `per_request_tombstone_${String(index).padStart(3, "0")}`;
        return [
          {
            type: "permission.asked" as const,
            properties: permissionRequest(requestId, OPENCODE_TEST_SESSION_ID),
          },
          {
            type: "permission.replied" as const,
            properties: {
              sessionID: OPENCODE_TEST_SESSION_ID,
              requestID: requestId,
              reply: "once" as const,
            },
          },
        ];
      };
      const initialEvents = Array.from({ length: 129 }, (_, index) => requestPair(index)).flat();
      const replay = requestPair(0);
      runtimeMock.state.subscribedEvents = [
        releaseEvents.promise.then(() => initialEvents[0]!),
        ...initialEvents.slice(1),
        ...replay,
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" || event.type === "request.resolved"),
        ),
        Stream.take(260),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.equal(events.filter((event) => event.type === "request.opened").length, 130);
      NodeAssert.equal(events.filter((event) => event.type === "request.resolved").length, 130);
      NodeAssert.equal(
        events.filter((event) => event.requestId === "per_request_tombstone_000").length,
        4,
      );
      NodeAssert.deepEqual(
        events.slice(-2).map((event) => event.type),
        ["request.opened", "request.resolved"],
      );
    }),
  );

  it.effect("reactivates a terminal child when OpenCode resumes its task session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resumed-child-task");
      const childSessionId = "ses_resumed_child_task";
      const releaseFirstTurn = promiseWithResolvers<void>();
      const releaseSecondTurn = promiseWithResolvers<void>();
      const firstTurnCompleted = yield* Deferred.make<void>();
      const taskPart = (callId: string, status: "running" | "completed", resume: boolean) =>
        toolPartEvent(
          makeToolPart(`part-${callId}`, "task", callId, {
            status,
            input: {
              description: "Reusable review",
              subagent_type: "worker",
              ...(resume ? { task_id: childSessionId } : {}),
            },
            title: "Reusable review",
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: childSessionId,
            },
            ...(status === "completed" ? { output: "Review complete" } : {}),
            time: status === "completed" ? { start: 1, end: 2 } : { start: 1 },
          }),
        );
      const childTextPartId = "part-resumed-child-text";
      const childTextMessageId = "msg-resumed-child-text";
      const childTextSnapshot = (text: string) => ({
        type: "message.part.updated" as const,
        properties: {
          sessionID: childSessionId,
          part: {
            id: childTextPartId,
            sessionID: childSessionId,
            messageID: childTextMessageId,
            type: "text",
            text,
            time: { start: 1 },
          },
          time: 1,
        },
      });
      const childTextDelta = (delta: string) => ({
        type: "message.part.delta" as const,
        properties: {
          sessionID: childSessionId,
          messageID: childTextMessageId,
          partID: childTextPartId,
          field: "text",
          delta,
        },
      });
      runtimeMock.state.subscribedEvents = [
        releaseFirstTurn.promise.then(() => taskPart("call-resume-first", "running", false)),
        releaseFirstTurn.promise.then(() => childTextSnapshot("old draft")),
        releaseFirstTurn.promise.then(() => childTextDelta(" tail")),
        taskPart("call-resume-first", "completed", false),
        {
          type: "session.status",
          properties: { sessionID: OPENCODE_TEST_SESSION_ID, status: { type: "idle" } },
        },
        releaseSecondTurn.promise.then(() => taskPart("call-resume-second", "running", true)),
        // The part id carried over from the first activation; its accumulator
        // must have been reset, or this delta would resurrect old text.
        releaseSecondTurn.promise.then(() => childTextDelta("new")),
        taskPart("call-resume-second", "completed", true),
        toolPartEvent(
          makeToolPart("part-resume-marker", "bash", "call-resume-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 3, end: 4 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "task.started" ||
              event.type === "task.updated" ||
              event.type === "task.progress" ||
              event.type === "task.completed" ||
              event.type === "turn.completed" ||
              (event.type === "item.completed" && event.itemId === "call-resume-marker")),
        ),
        Stream.tap((event) =>
          event.type === "turn.completed"
            ? Deferred.succeed(firstTurnCompleted, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Stream.take(9),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter.sendTurn({
        threadId,
        input: "Run the reusable review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseFirstTurn.resolve(undefined);
      yield* Deferred.await(firstTurnCompleted).pipe(Effect.timeout("2 seconds"));
      const secondTurn = yield* adapter.sendTurn({
        threadId,
        input: "Resume the reusable review",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseSecondTurn.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        [
          "task.started",
          "task.progress",
          "task.progress",
          "task.completed",
          "turn.completed",
          "task.updated",
          "task.progress",
          "task.completed",
          "item.completed",
        ],
      );
      // First activation accumulates snapshot→delta text; after terminal
      // settlement and resume reactivation the same part id starts from
      // empty text instead of inheriting the first activation's buffer.
      NodeAssert.deepEqual(
        events.flatMap((event) => (event.type === "task.progress" ? [event.payload.summary] : [])),
        ["old draft", "old draft tail", "new"],
      );
      NodeAssert.equal(events[0]?.turnId, firstTurn.turnId);
      NodeAssert.equal(events[1]?.turnId, firstTurn.turnId);
      const reactivated = events[5];
      if (reactivated?.type === "task.updated") {
        NodeAssert.equal(reactivated.turnId, secondTurn.turnId);
        NodeAssert.equal(reactivated.payload.taskId, childSessionId);
        NodeAssert.equal(reactivated.payload.status, "running");
        NodeAssert.equal(reactivated.payload.toolUseId, "call-resume-second");
      }
      NodeAssert.equal(events[7]?.turnId, secondTurn.turnId);
    }),
  );

  it.effect("keeps rolled-off child tombstones from reopening ancestry routing", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-tombstone-rollover");
      const releaseEvents = promiseWithResolvers<void>();
      const childCreated = (index: number) => {
        const sessionId = `ses_tombstone_${String(index).padStart(3, "0")}`;
        return {
          type: "session.created" as const,
          properties: {
            sessionID: sessionId,
            info: {
              id: sessionId,
              parentID: OPENCODE_TEST_SESSION_ID,
              title: `Tombstone child ${index}`,
            },
          },
        };
      };
      runtimeMock.state.subscribedEvents = [
        ...Array.from({ length: 257 }, (_, offset) => {
          const event = childCreated(offset + 1);
          return offset === 0 ? releaseEvents.promise.then(() => event) : event;
        }),
        toolPartEvent(
          makeToolPart("part-rolled-tombstone-task", "task", "call-rolled-tombstone-task", {
            status: "running",
            input: { description: "Late rolled child", subagent_type: "worker" },
            title: "Late rolled child",
            metadata: {
              parentSessionId: OPENCODE_TEST_SESSION_ID,
              sessionId: "ses_tombstone_001",
            },
            time: { start: 1 },
          }),
        ),
        {
          type: "permission.asked",
          properties: permissionRequest("per_rolled_tombstone", "ses_tombstone_001"),
        },
        {
          type: "permission.asked",
          properties: permissionRequest("per_retained_tombstone", "ses_tombstone_257"),
        },
        toolPartEvent(
          makeToolPart("part-tombstone-marker", "bash", "call-tombstone-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 2, end: 3 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" ||
              event.type === "runtime.warning" ||
              event.type === "task.started" ||
              (event.type === "item.completed" && event.itemId === "call-tombstone-marker")),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Exercise strict child correlation",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["request.opened", "item.completed"],
      );
      NodeAssert.equal(events[0]?.requestId, "per_retained_tombstone");
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.equal(runtimeMock.state.abortCalls.length, 130);
      NodeAssert.equal(runtimeMock.state.abortCalls[0], "ses_tombstone_001");
      NodeAssert.equal(runtimeMock.state.abortCalls[128], "ses_tombstone_129");
      NodeAssert.equal(runtimeMock.state.abortCalls[129], "ses_tombstone_001");
      NodeAssert.equal(new Set(runtimeMock.state.abortCalls).size, 129);
      NodeAssert.equal(runtimeMock.state.abortCalls.includes("ses_tombstone_257"), false);
    }),
  );

  it.effect("aborts and denies pending children evicted by retention overflow", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-pending-child-overflow");
      const releaseEvents = promiseWithResolvers<void>();
      const overflowCount = 130;
      const overflowChildCreated = (index: number) => ({
        id: `evt-overflow-created-${index}`,
        type: "session.created",
        properties: {
          sessionID: `ses_overflow_${index}`,
          info: {
            id: `ses_overflow_${index}`,
            parentID: OPENCODE_TEST_SESSION_ID,
            title: `Overflow child ${index}`,
          },
        },
      });
      runtimeMock.state.subscribedEvents = [
        ...Array.from({ length: overflowCount }, (_, index) =>
          index === 0
            ? releaseEvents.promise.then(() => overflowChildCreated(0))
            : overflowChildCreated(index),
        ),
        {
          type: "session.status",
          properties: { sessionID: "ses_overflow_0", status: { type: "idle" } },
        },
        {
          type: "permission.asked",
          properties: permissionRequest("per_evicted_overflow", "ses_overflow_0"),
        },
        {
          type: "permission.asked",
          properties: permissionRequest("per_retained_overflow", "ses_overflow_2"),
        },
        toolPartEvent(
          makeToolPart("part-overflow-marker", "bash", "call-overflow-marker", {
            status: "completed",
            input: { command: "done" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 300, end: 301 },
          }),
        ),
        toolPartEvent(
          makeToolPart("part-overflow-marker-two", "bash", "call-overflow-marker-two", {
            status: "completed",
            input: { command: "done again" },
            output: "done",
            title: "done",
            metadata: {},
            time: { start: 302, end: 303 },
          }),
        ),
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            (event.type === "request.opened" ||
              event.type === "runtime.warning" ||
              event.type === "task.started" ||
              event.type === "task.completed" ||
              event.type === "item.completed"),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Flood pending child state",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "opencode/kimi-k3",
        ),
      });
      releaseEvents.resolve(undefined);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")));
      // Only the retained child's late request surfaces; the evicted children
      // stay denied and silent.
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["request.opened", "item.completed", "item.completed"],
      );
      NodeAssert.equal(events[0]?.requestId, "per_retained_overflow");
      for (let index = 0; index < 5; index += 1) {
        yield* Effect.yieldNow;
      }
      // The two overflow-evicted children were aborted on eviction...
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, ["ses_overflow_0", "ses_overflow_1"]);
      // ...and their denial never probes session ancestry.
      NodeAssert.equal(runtimeMock.state.sessionGetIds.includes("ses_overflow_0"), false);
      NodeAssert.equal(runtimeMock.state.sessionGetIds.includes("ses_overflow_2"), false);
    }),
  );
});
