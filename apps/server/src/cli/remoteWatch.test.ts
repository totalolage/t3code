import {
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RuntimeRequestId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  formatRemoteWatchInteractionResult,
  formatRemoteWatchResult,
  observeRemoteWatchStream,
  RemoteWatchFailure,
  RemoteWatchInteractionRequiredError,
  RemoteWatchNoTurnError,
  selectFinalAssistantMessage,
  selectPendingRemoteWatchInteraction,
  selectRemoteWatchTurn,
  watchRemoteThread,
  type RemoteWatchSnapshot,
  type RemoteWatchTransport,
} from "./remoteWatch.ts";

const threadId = ThreadId.make("thread-native-watch");
const runId = RunId.make("run-native-watch");
const otherRunId = RunId.make("run-native-watch-other");
const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
const isRemoteWatchFailure = Schema.is(RemoteWatchFailure);
const isRemoteWatchInteractionRequiredError = Schema.is(RemoteWatchInteractionRequiredError);
const isRemoteWatchNoTurnError = Schema.is(RemoteWatchNoTurnError);

const makeRun = (id: RunId, status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id,
  threadId,
  ordinal: id === runId ? 1 : 2,
  providerInstanceId: ProviderInstanceId.make("codex-personal"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex-personal"), model: "gpt-5.4" },
  providerThreadId: null,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: status === "preparing" || status === "queued" ? null : now,
  completedAt:
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rolled_back"
      ? now
      : null,
  checkpointId: null,
  contextHandoffId: null,
  purpose: "user",
  userMessageId: MessageId.make(`${id}-user`),
});

const projection = (
  overrides: Partial<OrchestrationV2ThreadProjection> = {},
): OrchestrationV2ThreadProjection =>
  ({
    thread: {} as OrchestrationV2ThreadProjection["thread"],
    runs: [],
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
    ...overrides,
  }) satisfies OrchestrationV2ThreadProjection;

const snapshot = (
  sequence: number,
  input: {
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    readonly turnItems?: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly runtimeRequests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
    readonly latestRunId?: RunId | null;
    readonly activeRunId?: RunId | null;
  } = {},
): RemoteWatchSnapshot => ({
  snapshotSequence: sequence,
  projection: projection({
    runs: [...(input.runs ?? [])],
    turnItems: [...(input.turnItems ?? [])],
    runtimeRequests: [...(input.runtimeRequests ?? [])],
  }),
  latestRunId: input.latestRunId ?? null,
  activeRunId: input.activeRunId ?? null,
});

const assistantMessage = (id: string, targetRunId: RunId, text: string): OrchestrationV2TurnItem =>
  ({
    id: TurnItemId.make(`item-${id}`),
    threadId,
    runId: targetRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming: false,
  }) satisfies OrchestrationV2TurnItem;

const streamItem = (
  sequence: number,
  eventType: "run.updated",
  run: OrchestrationV2Run,
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-${sequence}`),
    threadId,
    runId: run.id,
    occurredAt: now,
    type: eventType,
    payload: run,
  },
});

const makeTransport = (inputs: {
  readonly initial: RemoteWatchSnapshot;
  readonly final: RemoteWatchSnapshot;
  readonly observation: {
    readonly status: "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";
    readonly lastSequence: number;
    readonly observedRunning: boolean;
  };
  readonly onSubscribe?: RemoteWatchTransport["subscribeThread"];
}): RemoteWatchTransport => {
  let reads = 0;
  return {
    readThread: () => Effect.succeed(reads++ === 0 ? inputs.initial : inputs.final),
    subscribeThread: inputs.onSubscribe ?? (() => Effect.succeed(inputs.observation)),
  };
};

it("uses the native active run before latest and keeps explicit run selection exact", () => {
  const selected = snapshot(4, { latestRunId: otherRunId, activeRunId: runId });
  assert.equal(selectRemoteWatchTurn(selected), runId);
  assert.equal(selectRemoteWatchTurn({ ...selected, activeRunId: null }), otherRunId);
  assert.equal(selectRemoteWatchTurn(selected, otherRunId), otherRunId);
  assert.equal(selectRemoteWatchTurn(snapshot(0)), null);
});

it("returns only the final assistant item from the requested native run", () => {
  const selected = snapshot(9, {
    turnItems: [
      assistantMessage("answer-one", runId, "target answer"),
      assistantMessage("answer-two", otherRunId, "other answer"),
    ],
  });
  assert.deepEqual(selectFinalAssistantMessage(selected, runId), {
    id: "answer-one",
    text: "target answer",
    createdAt: DateTime.formatIso(now),
  });
});

it.effect(
  "keeps the earlier V2 detail cursor when metadata selects a run created between reads",
  () =>
    Effect.gen(function* () {
      const initial = snapshot(40, { latestRunId: null, activeRunId: null });
      const finished = makeRun(runId, "completed");
      const final = snapshot(42, {
        latestRunId: runId,
        runs: [finished],
        turnItems: [assistantMessage("answer", runId, "completed between reads")],
      });
      let observedSubscription: Parameters<RemoteWatchTransport["subscribeThread"]>[0] | undefined;
      const transport = makeTransport({
        initial: { ...initial, latestRunId: runId },
        final,
        observation: { status: "completed", lastSequence: 42, observedRunning: true },
        onSubscribe: (input) => {
          observedSubscription = input;
          return Effect.succeed({ status: "completed", lastSequence: 42, observedRunning: true });
        },
      });
      const result = yield* watchRemoteThread({ transport, threadId, timeoutMs: 2_000 });
      assert.equal(observedSubscription?.afterSequence, 40);
      assert.equal(observedSubscription?.targetTurnId, runId);
      assert.equal(result.turnId, runId);
      assert.equal(result.message.text, "completed between reads");
    }),
);

it.effect("binds an explicit run to its terminal event and never substitutes a newer run", () =>
  Effect.gen(function* () {
    const initial = snapshot(7, {
      activeRunId: otherRunId,
      latestRunId: otherRunId,
      runs: [makeRun(runId, "running"), makeRun(otherRunId, "running")],
    });
    const final = snapshot(9, {
      latestRunId: otherRunId,
      activeRunId: otherRunId,
      runs: [makeRun(runId, "completed"), makeRun(otherRunId, "running")],
      turnItems: [assistantMessage("selected-answer", runId, "selected")],
    });
    let subscribedRun: RunId | undefined;
    const transport = makeTransport({
      initial,
      final,
      observation: { status: "completed", lastSequence: 9, observedRunning: true },
      onSubscribe: (input) => {
        subscribedRun = input.targetTurnId;
        return Effect.succeed({ status: "completed", lastSequence: 9, observedRunning: true });
      },
    });
    const result = yield* watchRemoteThread({
      transport,
      threadId,
      requestedTurnId: runId,
      timeoutMs: 2_000,
    });
    assert.equal(subscribedRun, runId);
    assert.equal(result.turnId, runId);
    assert.equal(result.message.text, "selected");
  }),
);

it.effect("reports only the selected run's pending native user input", () =>
  Effect.gen(function* () {
    const requestId = RuntimeRequestId.make("runtime-request-user-input");
    const nodeId = NodeId.make("node-user-input");
    const request: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: now,
      resolvedAt: null,
    };
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("item-user-input"),
      threadId,
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "user_input_request",
      requestId,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "The actual question is private presentation data.",
          options: [{ label: "One", description: "First" }],
          multiSelect: true,
        },
      ],
    };
    const selected = selectPendingRemoteWatchInteraction(
      projection({ runtimeRequests: [request], turnItems: [item] }),
      runId,
    );
    assert.deepEqual(selected, {
      kind: "user-input",
      requestId,
      prompt: {
        questionCount: 1,
        questions: [{ index: 0, optionCount: 1, multiSelect: true }],
        questionsTruncated: false,
      },
    });
    assert.equal(
      formatRemoteWatchInteractionResult({
        threadId,
        turnId: runId,
        interaction: selected!,
      }).includes("actual question"),
      false,
    );

    const error = yield* watchRemoteThread({
      transport: makeTransport({
        initial: snapshot(5, {
          activeRunId: runId,
          runs: [makeRun(runId, "running")],
          runtimeRequests: [request],
          turnItems: [item],
        }),
        final: snapshot(5, { activeRunId: runId, runs: [makeRun(runId, "running")] }),
        observation: { status: "completed", lastSequence: 5, observedRunning: true },
      }),
      threadId,
      timeoutMs: 1_000,
      interactionAware: true,
    }).pipe(Effect.flip);
    assert.isTrue(isRemoteWatchInteractionRequiredError(error));
  }),
);

it.effect("ignores terminal events for another run and preserves the native sequence", () =>
  Effect.gen(function* () {
    const otherTerminal = streamItem(12, "run.updated", makeRun(otherRunId, "completed"));
    const targetTerminal = streamItem(13, "run.updated", makeRun(runId, "failed"));
    const result = yield* observeRemoteWatchStream({
      stream: Stream.fromIterable([otherTerminal, targetTerminal]),
      initialSequence: 10,
      targetTurnId: runId,
      observedRunning: true,
    });
    assert.deepEqual(result, { status: "failed", lastSequence: 13, observedRunning: true });
  }),
);

it.effect("sanitizes socket and protocol defects without leaking their details", () =>
  Effect.gen(function* () {
    const socket = yield* observeRemoteWatchStream({
      stream: Stream.die(new Error("socket closed for https://private.example/token")),
      initialSequence: 8,
      targetTurnId: runId,
      observedRunning: true,
    }).pipe(Effect.flip);
    assert.isTrue(isRemoteWatchFailure(socket));
    assert.equal(socket.kind, "transport");
    assert.equal(socket.lastSequence, 8);
    assert.equal(socket.message.includes("private.example"), false);

    const defect = yield* observeRemoteWatchStream({
      stream: Stream.die(new Error("invalid event payload")),
      initialSequence: 4,
      targetTurnId: runId,
      observedRunning: false,
    }).pipe(Effect.flip);
    assert.isTrue(isRemoteWatchFailure(defect));
    assert.equal(defect.kind, "protocol");
  }),
);

it.effect("reports missing native run identity instead of inventing one", () =>
  Effect.gen(function* () {
    const error = yield* watchRemoteThread({
      transport: makeTransport({
        initial: snapshot(0),
        final: snapshot(0),
        observation: { status: "completed", lastSequence: 0, observedRunning: false },
      }),
      threadId,
      timeoutMs: 1_000,
    }).pipe(Effect.flip);
    assert.isTrue(isRemoteWatchNoTurnError(error));
  }),
);

it("formats the native run result as text or JSON", () => {
  const result = {
    threadId,
    turnId: runId,
    status: "completed" as const,
    message: { id: "message", text: "done", createdAt: DateTime.formatIso(now) },
  };
  assert.equal(formatRemoteWatchResult(result, "text"), "done");
  assert.isTrue(formatRemoteWatchResult(result, "json").includes('"turnId"'));
});
