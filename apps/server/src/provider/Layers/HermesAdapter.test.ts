// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  HermesSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

const decodeSettings = Schema.decodeSync(HermesSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockHermesWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-hermes.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-hermes-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("HermesAdapter ACP", (it) => {
  it.effect("binds cwd, model, mode, and prompt flow through Hermes ACP", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-requests-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const instanceId = ProviderInstanceId.make("hermes");
      const adapter = yield* makeHermesAdapter(decodeSettings({ binaryPath: wrapperPath }), {
        instanceId,
      });
      const threadId = ThreadId.make("hermes-acp-thread");
      const turnCompleted = yield* Deferred.make<void>();
      const events: ProviderRuntimeEvent[] = [];
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "grok-mock-alt" },
      });
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.deepStrictEqual(adapter.capabilities, { sessionModelSwitch: "in-session" });

      yield* adapter.sendTurn({
        threadId,
        input: "hello Hermes",
        attachments: [],
      });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventFiber);

      assert.includeMembers(
        events.map((event) => event.type),
        ["session.started", "thread.started", "turn.started", "content.delta", "turn.completed"],
      );
      const delta = events.find((event) => event.type === "content.delta");
      assert.equal(
        delta?.type === "content.delta" ? delta.payload.delta : undefined,
        "hello from mock",
      );

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const newSession = requests.find((request) => request.method === "session/new");
      assert.equal((newSession?.params as Record<string, unknown>)?.cwd, process.cwd());
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "session/set_model" &&
            (request.params as Record<string, unknown>)?.modelId === "grok-mock-alt",
        ),
      );
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "session/set_mode" &&
            (request.params as Record<string, unknown>)?.modeId === "dont_ask",
        ),
      );
    }),
  );

  it.effect("loads a persisted ACP session and switches models on a later turn", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-acp-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const instanceId = ProviderInstanceId.make("hermes_work");
      const adapter = yield* makeHermesAdapter(decodeSettings({ binaryPath: wrapperPath }), {
        instanceId,
      });
      const threadId = ThreadId.make("hermes-resumed-thread");
      const session = yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionId: "existing-hermes-session" },
        modelSelection: { instanceId, model: "grok-build" },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "existing-hermes-session",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "switch model",
        attachments: [],
        modelSelection: { instanceId, model: "grok-mock-alt" },
      });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((request) => request.method === "session/load"));
      assert.isFalse(requests.some((request) => request.method === "session/new"));
      const switches = requests.filter((request) => request.method === "session/set_model");
      assert.deepEqual(
        switches.map((request) => (request.params as Record<string, unknown>).modelId),
        ["grok-mock-alt"],
      );
      assert.isTrue(
        requests.some(
          (request) =>
            request.method === "session/set_mode" &&
            (request.params as Record<string, unknown>)?.modeId === "default",
        ),
      );
    }),
  );

  it.effect("bridges ACP permission requests for approval-required sessions", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockHermesWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const instanceId = ProviderInstanceId.make("hermes");
      const adapter = yield* makeHermesAdapter(decodeSettings({ binaryPath: wrapperPath }), {
        instanceId,
      });
      const threadId = ThreadId.make("hermes-approval-thread");
      const opened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(opened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "grok-build" },
      });
      const turnFiber = yield* adapter
        .sendTurn({ threadId, input: "run a tool", attachments: [] })
        .pipe(Effect.forkChild);
      const request = yield* Deferred.await(opened);
      assert.isDefined(request.requestId);
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(request.requestId!),
        "accept",
      );
      yield* Fiber.join(turnFiber);
      yield* Fiber.interrupt(eventFiber);
    }),
  );
});
