import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { HermesGatewayClient, HermesSseEvent } from "../hermes/HermesGatewayClient.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

function makeClient(state: {
  readonly created: string[];
  readonly resumed: string[];
  readonly turns: string[];
}): HermesGatewayClient {
  return {
    health: async () => ({ version: "test" }),
    listModels: async () => [{ id: "hermes-agent" }],
    createSession: async () => {
      state.created.push("session-1");
      return { id: "session-1", model: "hermes-agent" };
    },
    getSession: async (sessionId) => {
      state.resumed.push(sessionId);
      return { id: sessionId, model: "hermes-agent" };
    },
    listMessages: async () => [],
    streamSessionChat: async (sessionId, input, onEvent) => {
      state.turns.push(`${sessionId}:${String(input.message)}`);
      const events: HermesSseEvent[] = [
        {
          event: "message.started",
          data: { message: { id: `msg-${state.turns.length}`, role: "assistant" } },
        },
        {
          event: "assistant.delta",
          data: { message_id: `msg-${state.turns.length}`, delta: "Hello" },
        },
        {
          event: "assistant.completed",
          data: { message_id: `msg-${state.turns.length}`, content: "Hello" },
        },
        { event: "run.completed", data: { completed: true } },
      ];
      for (const event of events) await onEvent(event);
    },
    chatCompletion: async () => "{}",
  };
}

it.effect("HermesAdapter starts and continues a native Hermes session", () =>
  Effect.gen(function* () {
    const state = { created: [] as string[], resumed: [] as string[], turns: [] as string[] };
    const adapter = yield* makeHermesAdapter({
      instanceId: ProviderInstanceId.make("hermes"),
      client: makeClient(state),
      enabled: true,
    });
    const threadId = ThreadId.make("hermes-thread");
    const session = yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
    assert.deepStrictEqual(session.resumeCursor, { sessionId: "session-1" });

    for (const message of ["First", "Second"]) {
      const observed: ProviderRuntimeEvent[] = [];
      const completionFiber = yield* Stream.runHead(
        adapter.streamEvents.pipe(
          Stream.tap((event) => Effect.sync(() => observed.push(event))),
          Stream.filter((event: ProviderRuntimeEvent) => event.type === "turn.completed"),
        ),
      ).pipe(Effect.orDie, Effect.forkChild);
      yield* adapter.sendTurn({ threadId, input: message });
      const completed = yield* Fiber.join(completionFiber);
      assert(Option.isSome(completed));
      assert.strictEqual(completed.value.type, "turn.completed");
      const assistantDelta = observed.find((event) => event.type === "content.delta");
      assert.strictEqual(
        assistantDelta?.type === "content.delta" ? assistantDelta.payload.delta : undefined,
        "Hello",
      );
      const messageItemIds = observed.flatMap((event) =>
        event.type === "item.started" ||
        event.type === "content.delta" ||
        event.type === "item.completed"
          ? [event.itemId]
          : [],
      );
      assert.strictEqual(new Set(messageItemIds).size, 1);
    }

    assert.deepStrictEqual(state.created, ["session-1"]);
    assert.deepStrictEqual(state.turns, ["session-1:First", "session-1:Second"]);
    const sessions = yield* adapter.listSessions();
    assert.strictEqual(sessions[0]?.status, "ready");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("HermesAdapter resumes a persisted Hermes cursor without creating a new session", () =>
  Effect.gen(function* () {
    const state = { created: [] as string[], resumed: [] as string[], turns: [] as string[] };
    const adapter = yield* makeHermesAdapter({
      instanceId: ProviderInstanceId.make("hermes_work"),
      client: makeClient(state),
      enabled: true,
    });
    const session = yield* adapter.startSession({
      threadId: ThreadId.make("resumed-thread"),
      runtimeMode: "full-access",
      resumeCursor: { sessionId: "existing-hermes-session" },
    });

    assert.deepStrictEqual(state.created, []);
    assert.deepStrictEqual(state.resumed, ["existing-hermes-session"]);
    assert.deepStrictEqual(session.resumeCursor, { sessionId: "existing-hermes-session" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("HermesAdapter rejects runtime modes the gateway cannot enforce", () =>
  Effect.gen(function* () {
    const state = { created: [] as string[], resumed: [] as string[], turns: [] as string[] };
    const adapter = yield* makeHermesAdapter({
      instanceId: ProviderInstanceId.make("hermes"),
      client: makeClient(state),
      enabled: true,
    });
    const result = yield* adapter
      .startSession({
        threadId: ThreadId.make("supervised-thread"),
        runtimeMode: "approval-required",
      })
      .pipe(Effect.result);

    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") {
      if (result.failure._tag !== "ProviderAdapterValidationError") {
        return assert.fail(`Unexpected error: ${result.failure._tag}`);
      }
      assert.match(result.failure.issue, /select Full access/u);
    }
    assert.deepStrictEqual(state.created, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
