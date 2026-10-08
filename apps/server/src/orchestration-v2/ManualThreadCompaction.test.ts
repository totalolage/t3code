import {
  AuthSessionId,
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type ApplicationProjectEvent,
  type OrchestrationV2CompactionRun,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventStore from "./EventStore.ts";
import * as ManualThreadCompaction from "./ManualThreadCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const NOW = "2026-10-06T00:00:00.000Z";
const SESSION_ID = AuthSessionId.make("session-cli-compact-tests");
const OTHER_SESSION_ID = AuthSessionId.make("session-cli-compact-other");
const CODEX_ID = ProviderInstanceId.make("codex");
const CODEX_DRIVER = ProviderDriverKind.make("codex");

const commandIdFor = (sessionId: AuthSessionId, idempotencyKey: string) =>
  Effect.promise(async () => {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${sessionId}\0${idempotencyKey.trim()}`),
    );
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return CommandId.make(`cli-compact:${hash}`);
  });

type ProviderControl = {
  readonly blocked: boolean;
  readonly calls: Array<ProviderAdapter.ProviderAdapterV2MaintenanceInput>;
  readonly started: Queue.Queue<ProviderAdapter.ProviderAdapterV2MaintenanceInput>;
  readonly release: Deferred.Deferred<void>;
};

const makeProviderControl = (blocked: boolean) =>
  Effect.gen(function* () {
    return {
      blocked,
      calls: [] as Array<ProviderAdapter.ProviderAdapterV2MaintenanceInput>,
      started: yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2MaintenanceInput>(),
      release: yield* Deferred.make<void>(),
    } satisfies ProviderControl;
  });

const makeFixtureLayer = (
  control: ProviderControl,
  providerInstanceId = CODEX_ID,
  driver = CODEX_DRIVER,
  cryptoLayer = NodeCrypto.layer,
) => {
  const adapter: ProviderAdapter.ProviderAdapterV2Shape = {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession = {
          id: input.providerSessionId,
          driver,
          providerInstanceId,
          status: "ready" as const,
          cwd: input.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId, existingProviderThread }) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              if (existingProviderThread !== undefined) {
                return {
                  ...existingProviderThread,
                  nativeThreadRef: {
                    driver,
                    nativeId: `native:${threadId}`,
                    strength: "strong" as const,
                  },
                  status: "idle" as const,
                  updatedAt: createdAt,
                };
              }
              return {
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native:${threadId}`,
                  strength: "strong" as const,
                },
                nativeConversationHeadRef: null,
                status: "idle" as const,
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              };
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: () => Effect.die("Native compaction must not create a user turn."),
          compactContext: (maintenance) =>
            Effect.gen(function* () {
              control.calls.push(maintenance);
              yield* Queue.offer(control.started, maintenance);
              if (control.blocked) yield* Deferred.await(control.release);
              const completedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${maintenance.runId}`);
              const providerTurn = {
                id: providerTurnId,
                providerThreadId: maintenance.providerThread.id,
                nodeId: maintenance.rootNodeId,
                runAttemptId: maintenance.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native-turn:${maintenance.runId}`,
                  strength: "strong" as const,
                },
                ordinal: maintenance.providerTurnOrdinal,
                status: "running" as const,
                startedAt: completedAt,
                completedAt: null,
              };
              yield* Queue.offerAll(events, [
                {
                  type: "provider_turn.updated",
                  driver,
                  threadId: maintenance.threadId,
                  providerTurn,
                },
                {
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: TurnItemId.make(`compaction-item:${maintenance.runId}`),
                    threadId: maintenance.threadId,
                    runId: maintenance.runId,
                    nodeId: maintenance.rootNodeId,
                    providerThreadId: maintenance.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed",
                    title: "Context compacted",
                    startedAt: completedAt,
                    completedAt,
                    updatedAt: completedAt,
                    type: "compaction",
                    driver,
                    summary: "Native test compaction",
                  },
                },
                {
                  type: "provider_turn.updated",
                  driver,
                  threadId: maintenance.threadId,
                  providerTurn: { ...providerTurn, status: "completed", completedAt },
                },
                {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: maintenance.providerThread.id,
                  providerTurnId,
                  runOrdinal: maintenance.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: ({ providerThread }) =>
            Effect.succeed({
              providerThread,
              providerTurns: [],
              messages: [],
              runtimeRequests: [],
            }),
          rollbackThread: () => Effect.die("Unused by native compaction tests."),
          forkThread: () => Effect.die("Unused by native compaction tests."),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
    get: () => Effect.succeed(adapter),
    list: () => Effect.succeed([providerInstanceId]),
  });
  const core = ProviderReplayHarness.layerWithRegistry(
    { name: "native-cli-manual-compaction" },
    registry,
    { runEffectWorker: false },
  );
  const coreWithStores = Layer.mergeAll(
    core,
    EventStore.layer.pipe(Layer.provide(core)),
    CommandReceiptStore.layer.pipe(Layer.provide(core)),
  );
  return ManualThreadCompaction.ManualThreadCompactionLive.pipe(
    Layer.provideMerge(Layer.mergeAll(coreWithStores, cryptoLayer)),
  );
};

const seedThread = Effect.fn("seedNativeCompactionThread")(function* (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  projects: ProjectStore.ProjectStoreV2["Service"],
  input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly providerInstanceId: ProviderInstanceId;
  },
) {
  const projectId = ProjectId.make(`${input.threadId}-project`);
  const modelSelection = { instanceId: input.providerInstanceId, model: "gpt-5.4" };
  yield* projects.apply({
    sequence: 0,
    eventId: EventId.make(`${input.threadId}:project-created`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: "Native compaction test",
      workspaceRoot: input.cwd,
      defaultModelSelection: modelSelection,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
    },
  } satisfies ApplicationProjectEvent);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${input.threadId}:thread-created`),
    threadId: input.threadId,
    projectId,
    title: "Native compaction test",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.cwd,
    createdBy: "user",
    creationSource: "web",
  });
  return input.threadId;
});

const observeWaitingRun = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  commandId: CommandId,
) =>
  orchestrator.streamDomainEvents.pipe(
    Stream.filter(
      (event) =>
        event.type === "run.updated" &&
        event.threadId === threadId &&
        event.payload.purpose === "compaction" &&
        event.payload.requestCommandId === commandId &&
        event.payload.status === "waiting",
    ),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkChild({ startImmediately: true }),
  );

const observeCreatedRun = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  commandId: CommandId,
) =>
  orchestrator.streamDomainEvents.pipe(
    Stream.filter(
      (event): event is Extract<OrchestrationV2DomainEvent, { readonly type: "run.created" }> =>
        event.type === "run.created" &&
        event.threadId === threadId &&
        event.payload.threadId === threadId &&
        event.payload.purpose === "compaction" &&
        event.payload.requestCommandId === commandId,
    ),
    Stream.take(1),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );

const completeCompaction = Effect.fn("completeNativeCompaction")(function* (
  control: ProviderControl,
  service: ManualThreadCompaction.ManualThreadCompactionShape,
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  worker: EffectWorker.OrchestrationEffectWorkerV2["Service"],
  threadId: ThreadId,
  sessionId: AuthSessionId,
  idempotencyKey: string,
) {
  yield* worker.drain();
  const commandId = yield* commandIdFor(sessionId, idempotencyKey);
  const createdRun = yield* observeCreatedRun(orchestrator, threadId, commandId);
  const waiting = yield* observeWaitingRun(orchestrator, threadId, commandId);
  const callerFinished = yield* Deferred.make<void>();
  const caller = yield* service
    .compact(sessionId, { threadId, idempotencyKey })
    .pipe(Effect.forkChild({ startImmediately: true }));
  const callerObserver = yield* Fiber.await(caller).pipe(
    Effect.andThen(Deferred.succeed(callerFinished, undefined)),
    Effect.forkChild({ startImmediately: true }),
  );
  const startEvidence = yield* Effect.raceFirst(
    Fiber.join(createdRun).pipe(Effect.map((event) => ({ _tag: "created" as const, event }))),
    Deferred.await(callerFinished).pipe(
      Effect.andThen(Fiber.join(caller)),
      Effect.as({ _tag: "caller-finished" as const }),
    ),
  );
  if (startEvidence._tag === "caller-finished") {
    return yield* Effect.die(
      new Error("Compaction caller finished before its correlated native run was created."),
    );
  }
  if (Option.isNone(startEvidence.event)) {
    return yield* Effect.die(
      new Error("Native compaction event stream ended before its run was created."),
    );
  }
  const runId = startEvidence.event.value.payload.id;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const receiptOption = yield* receipts.getByCommandId(commandId);
  if (Option.isNone(receiptOption)) {
    return yield* Effect.die(
      new Error("Native run.created event had no exact durable command receipt."),
    );
  }
  const acceptedReceipt = receiptOption.value;
  expect(acceptedReceipt.commandId).toBe(commandId);
  expect(acceptedReceipt.commandType).toBe("thread.compact");
  expect(acceptedReceipt.threadId).toBe(threadId);
  expect(acceptedReceipt.status).toBe("accepted");
  expect(acceptedReceipt.error).toBeNull();
  expect(acceptedReceipt.resultSequence).toBeGreaterThan(0);

  const eventStore = yield* EventStore.EventStoreV2;
  const commandEvents = Array.from(
    yield* Stream.runCollect(eventStore.readByCommandId({ commandId })),
  );
  expect(commandEvents.length).toBeGreaterThan(0);
  expect(commandEvents.at(-1)?.sequence).toBe(acceptedReceipt.resultSequence);
  expect(
    commandEvents.every(
      (event) => event.commandId === commandId && event.event.threadId === threadId,
    ),
  ).toBe(true);
  const createdEvents = commandEvents.filter(
    (event) =>
      event.event.type === "run.created" &&
      event.event.payload.id === runId &&
      event.event.payload.purpose === "compaction" &&
      event.event.payload.requestCommandId === commandId,
  );
  expect(createdEvents).toHaveLength(1);

  const startingRecords = yield* orchestrator.getThreadRecords(threadId, ["runs"], {
    runIds: [runId],
  });
  const run = startingRecords.runs.find(
    (candidate): candidate is OrchestrationV2CompactionRun =>
      candidate.id === runId &&
      candidate.purpose === "compaction" &&
      candidate.requestCommandId === commandId,
  );
  if (run === undefined) {
    return yield* Effect.die(
      new Error("Exact accepted compaction run is missing from native projection."),
    );
  }
  expect(run.status).toBe("starting");

  const beforeProviderCalls = control.calls.length;
  let providerStart = (yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
    outbox.listByCommandId(commandId),
  )).find((effect) => effect.request.type === "provider-turn.start");
  if (providerStart === undefined) {
    return yield* Effect.die(
      new Error(
        `Accepted compaction run ${runId} had no correlated provider-turn.start outbox effect.`,
      ),
    );
  }
  expect(providerStart.commandId).toBe(commandId);
  expect(providerStart.threadId).toBe(threadId);
  expect(providerStart.request).toMatchObject({ type: "provider-turn.start", runId });
  let providerStartAttemptCount = providerStart?.attemptCount ?? 0;
  while (control.calls.length === beforeProviderCalls) {
    // A generic availability wake can be stale relative to this command's
    // outbox row. Only step the worker after the correlated run and durable
    // receipt/outbox observations above, then bind progress to the adapter's
    // exact maintenance handshake.
    const worked = yield* worker.runOnce;
    const effects = yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
      outbox.listByCommandId(commandId),
    );
    providerStart = effects.find((effect) => effect.request.type === "provider-turn.start");
    if (control.calls.length > beforeProviderCalls) break;
    if (
      providerStart !== undefined &&
      providerStart.attemptCount > providerStartAttemptCount &&
      providerStart.lastError !== null
    ) {
      return yield* Effect.die(
        new Error(
          `Native compaction start failed on attempt ${providerStart.attemptCount}: ${providerStart.lastError}`,
        ),
      );
    }
    if (!worked) {
      return yield* Effect.die(
        new Error(
          providerStart === undefined
            ? "Worker found no claimable effect before native compaction start: missing provider-turn.start effect"
            : `Worker found no claimable effect before native compaction start: ${providerStart.request.type} attempt ${providerStart.attemptCount}, last error ${providerStart.lastError ?? "none"}`,
        ),
      );
    }
    providerStartAttemptCount = providerStart?.attemptCount ?? providerStartAttemptCount;
  }
  const started = yield* Queue.take(control.started);
  if (started.requestCommandId !== commandId) {
    return yield* Effect.die(
      new Error("Provider start signal belonged to another compaction command."),
    );
  }
  expect(yield* Deferred.isDone(callerFinished)).toBe(false);
  yield* Fiber.join(waiting);

  const records = yield* orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
  const waitingRun = records.runs.find(
    (candidate): candidate is OrchestrationV2CompactionRun => candidate.id === runId,
  );
  expect(waitingRun?.status).toBe("waiting");
  expect(waitingRun?.purpose).toBe("compaction");
  expect(waitingRun?.requestCommandId).toBe(commandId);
  expect("userMessageId" in run).toBe(false);
  expect(records.messages).toEqual([]);
  expect(yield* Deferred.isDone(callerFinished)).toBe(false);

  const checkpointCommand = CommandId.make(`command:effect:checkpoint.capture:${run.id}`);
  const capture = yield* EffectOutbox.EffectOutboxV2.use((outbox) =>
    outbox.listByCommandId(checkpointCommand),
  );
  expect(capture.some((entry) => entry.request.type === "checkpoint.capture")).toBe(true);

  yield* worker.drain();
  yield* Fiber.join(callerObserver);
  const result = yield* Fiber.join(caller);
  expect(result).toMatchObject({ threadId, commandId, replayed: false });
  const finalRecords = yield* orchestrator.getThreadRecords(
    threadId,
    ["runs", "messages", "turnItems", "checkpoints"],
    {
      runIds: [run.id],
      turnItemRunId: run.id,
    },
  );
  const completedRun = finalRecords.runs.find((candidate) => candidate.id === run.id);
  expect(completedRun?.status).toBe("completed");
  expect(completedRun?.checkpointId).not.toBeNull();
  expect(finalRecords.messages).toEqual([]);
  expect(
    finalRecords.turnItems.filter(
      (item) => item.type === "compaction" && item.status === "completed",
    ),
  ).toHaveLength(1);
  expect(
    finalRecords.checkpoints.some(
      (checkpoint) =>
        checkpoint.id === completedRun?.checkpointId &&
        checkpoint.runId === run.id &&
        checkpoint.status === "ready",
    ),
  ).toBe(true);

  const receipt = yield* CommandReceiptStore.CommandReceiptStoreV2.use((store) =>
    store.getByCommandId(commandId),
  );
  expect(Option.isSome(receipt)).toBe(true);
  if (Option.isSome(receipt)) expect(result.sequence).toBe(receipt.value.resultSequence);
  const replay = yield* service.compact(sessionId, { threadId, idempotencyKey });
  expect(replay.replayed).toBe(true);
  expect(replay.sequence).toBe(result.sequence);
  return result;
});

it.effect("native compaction waits for its correlated completed checkpoint", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* makeProviderControl(false);
      const fixture = makeFixtureLayer(control);
      return yield* Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-manual-compaction");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const service = yield* ManualThreadCompaction.ManualThreadCompaction;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* seedThread(orchestrator, projects, {
          threadId: ThreadId.make("native-manual-compaction"),
          cwd,
          providerInstanceId: CODEX_ID,
        });

        const result = yield* completeCompaction(
          control,
          service,
          orchestrator,
          worker,
          threadId,
          SESSION_ID,
          "success-key",
        );
        expect(result.commandId).toBe(yield* commandIdFor(SESSION_ID, "success-key"));
        expect(control.calls).toHaveLength(1);
        expect(control.calls[0]?.purpose).toBe("compaction");
        expect(control.calls[0]?.requestCommandId).toBe(result.commandId);
        expect("message" in (control.calls[0] ?? {})).toBe(false);
      }).pipe(Effect.provide(fixture));
    }),
  ),
);

it.effect("fails trace allocation before admitting compaction work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* makeProviderControl(false);
      const failingCryptoLayer = Layer.effect(
        Crypto.Crypto,
        Effect.gen(function* () {
          const crypto = yield* Crypto.Crypto;
          return {
            ...crypto,
            randomUUIDv4: Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "ManualThreadCompaction.test",
                method: "randomUUIDv4",
              }),
            ),
          };
        }),
      ).pipe(Layer.provide(NodeCrypto.layer));
      const fixture = makeFixtureLayer(control, CODEX_ID, CODEX_DRIVER, failingCryptoLayer);
      return yield* Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-manual-compaction-crypto-failure");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
        const service = yield* ManualThreadCompaction.ManualThreadCompaction;
        const threadId = yield* seedThread(orchestrator, projects, {
          threadId: ThreadId.make("native-manual-compaction-crypto-failure"),
          cwd,
          providerInstanceId: CODEX_ID,
        });
        const commandId = yield* commandIdFor(SESSION_ID, "crypto-failure");

        const result = yield* Effect.exit(
          service.compact(SESSION_ID, { threadId, idempotencyKey: "crypto-failure" }),
        );
        const events = yield* Stream.runCollect(eventStore.readByCommandId({ commandId }));
        const receipt = yield* receipts.getByCommandId(commandId);

        expect(result._tag).toBe("Failure");
        expect(control.calls).toHaveLength(0);
        expect(Array.from(events)).toHaveLength(0);
        expect(Option.isNone(receipt)).toBe(true);
      }).pipe(Effect.provide(fixture));
    }),
  ),
);

it.effect(
  "coalesces a scoped duplicate and keeps native work after its first observer is cancelled",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const control = yield* makeProviderControl(true);
        const fixture = makeFixtureLayer(control);
        return yield* Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("native-manual-compaction-coalesce");
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projects = yield* ProjectStore.ProjectStoreV2;
          const service = yield* ManualThreadCompaction.ManualThreadCompaction;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const firstThread = yield* seedThread(orchestrator, projects, {
            threadId: ThreadId.make("native-manual-compaction-coalesce-a"),
            cwd,
            providerInstanceId: CODEX_ID,
          });
          const otherThread = yield* seedThread(orchestrator, projects, {
            threadId: ThreadId.make("native-manual-compaction-coalesce-b"),
            cwd,
            providerInstanceId: CODEX_ID,
          });
          yield* worker.drain();
          const commandId = yield* commandIdFor(SESSION_ID, "shared-key");
          const waiting = yield* observeWaitingRun(orchestrator, firstThread, commandId);
          const first = yield* service
            .compact(SESSION_ID, { threadId: firstThread, idempotencyKey: "shared-key" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* worker.awaitWork;
          const start = yield* worker.runOnce.pipe(Effect.forkChild({ startImmediately: true }));
          const started = yield* Queue.take(control.started);
          expect(started.requestCommandId).toBe(commandId);
          const duplicate = yield* service
            .compact(SESSION_ID, { threadId: firstThread, idempotencyKey: "shared-key" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          const conflict = yield* Effect.flip(
            service.compact(SESSION_ID, { threadId: otherThread, idempotencyKey: "shared-key" }),
          );
          expect(conflict._tag).toBe("ManualCompactionInvalidRequestError");
          yield* Fiber.interrupt(first);
          yield* Deferred.succeed(control.release, undefined);
          yield* Fiber.join(start);
          yield* Fiber.join(waiting);
          yield* worker.drain();
          const result = yield* Fiber.join(duplicate);
          expect(result.replayed).toBe(true);
          expect(control.calls).toHaveLength(1);
          const records = yield* orchestrator.getThreadRecords(firstThread, ["runs"]);
          expect(
            records.runs.filter(
              (run): run is OrchestrationV2CompactionRun =>
                run.purpose === "compaction" && run.requestCommandId === commandId,
            ),
          ).toHaveLength(1);
        }).pipe(
          Effect.ensuring(Deferred.succeed(control.release, undefined).pipe(Effect.asVoid)),
          Effect.provide(fixture),
        );
      }),
    ),
);

it.effect("isolates identical idempotency keys by authenticated session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* makeProviderControl(false);
      const fixture = makeFixtureLayer(control);
      return yield* Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-manual-compaction-sessions");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const service = yield* ManualThreadCompaction.ManualThreadCompaction;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = yield* seedThread(orchestrator, projects, {
          threadId: ThreadId.make("native-manual-compaction-sessions"),
          cwd,
          providerInstanceId: CODEX_ID,
        });
        const first = yield* completeCompaction(
          control,
          service,
          orchestrator,
          worker,
          threadId,
          SESSION_ID,
          "same-key",
        );
        const second = yield* completeCompaction(
          control,
          service,
          orchestrator,
          worker,
          threadId,
          OTHER_SESSION_ID,
          "same-key",
        );
        expect(first.commandId).not.toBe(second.commandId);
        expect(control.calls).toHaveLength(2);
      }).pipe(Effect.provide(fixture));
    }),
  ),
);

it.effect("returns recovery-required for accepted work that has no completed native evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* makeProviderControl(false);
      const fixture = makeFixtureLayer(control);
      return yield* Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-manual-compaction-recovery");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const eventStore = yield* EventStore.EventStoreV2;
        const service = yield* ManualThreadCompaction.ManualThreadCompaction;
        const threadId = yield* seedThread(orchestrator, projects, {
          threadId: ThreadId.make("native-manual-compaction-recovery"),
          cwd,
          providerInstanceId: CODEX_ID,
        });
        const commandId = yield* commandIdFor(SESSION_ID, "accepted-unresolved");
        yield* orchestrator.dispatch({ type: "thread.compact", commandId, threadId });
        const before = yield* Stream.runCollect(eventStore.readByCommandId({ commandId }));
        const failure = yield* Effect.flip(
          service.compact(SESSION_ID, { threadId, idempotencyKey: "accepted-unresolved" }),
        );
        const after = yield* Stream.runCollect(eventStore.readByCommandId({ commandId }));
        expect(failure._tag).toBe("EnvironmentThreadCompactionError");
        if (failure._tag === "EnvironmentThreadCompactionError") {
          expect(failure.reason).toBe("recovery-required");
        }
        expect(Array.from(after)).toEqual(Array.from(before));
        expect(control.calls).toHaveLength(0);
        const records = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
        const run = records.runs.find(
          (candidate) =>
            candidate.purpose === "compaction" && candidate.requestCommandId === commandId,
        );
        expect(run?.purpose).toBe("compaction");
        expect(run?.status).toBe("starting");
      }).pipe(Effect.provide(fixture));
    }),
  ),
);

it.effect("maps native active-work and unsupported-provider receipts to their typed reasons", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activeControl = yield* makeProviderControl(false);
      const activeFixture = makeFixtureLayer(activeControl);
      yield* Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-manual-compaction-active");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const service = yield* ManualThreadCompaction.ManualThreadCompaction;
        const threadId = yield* seedThread(orchestrator, projects, {
          threadId: ThreadId.make("native-manual-compaction-active"),
          cwd,
          providerInstanceId: CODEX_ID,
        });
        yield* orchestrator.dispatch({
          type: "thread.compact",
          commandId: yield* commandIdFor(SESSION_ID, "active-run"),
          threadId,
        });
        const failure = yield* Effect.flip(
          service.compact(SESSION_ID, { threadId, idempotencyKey: "active-refusal" }),
        );
        expect(failure._tag).toBe("EnvironmentThreadCompactionError");
        if (failure._tag === "EnvironmentThreadCompactionError") {
          expect(failure.reason).toBe("active-thread");
        }
        expect(activeControl.calls).toHaveLength(0);
      }).pipe(Effect.provide(activeFixture));

      const unsupportedControl = yield* makeProviderControl(false);
      const cursorId = ProviderInstanceId.make("cursor");
      const unsupportedFixture = makeFixtureLayer(
        unsupportedControl,
        cursorId,
        ProviderDriverKind.make("cursor"),
      );
      yield* Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-manual-compaction-unsupported");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const service = yield* ManualThreadCompaction.ManualThreadCompaction;
        const threadId = yield* seedThread(orchestrator, projects, {
          threadId: ThreadId.make("native-manual-compaction-unsupported"),
          cwd,
          providerInstanceId: cursorId,
        });
        const failure = yield* Effect.flip(
          service.compact(SESSION_ID, { threadId, idempotencyKey: "unsupported-provider" }),
        );
        expect(failure._tag).toBe("EnvironmentThreadCompactionError");
        if (failure._tag === "EnvironmentThreadCompactionError") {
          expect(failure.reason).toBe("unsupported-provider");
        }
        expect(unsupportedControl.calls).toHaveLength(0);
      }).pipe(Effect.provide(unsupportedFixture));
    }),
  ),
);

it.effect("rejects a command receipt whose native command type does not match compaction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const control = yield* makeProviderControl(false);
      const fixture = makeFixtureLayer(control);
      return yield* Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-manual-compaction-receipt");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const service = yield* ManualThreadCompaction.ManualThreadCompaction;
        const threadId = yield* seedThread(orchestrator, projects, {
          threadId: ThreadId.make("native-manual-compaction-receipt"),
          cwd,
          providerInstanceId: CODEX_ID,
        });
        const commandId = yield* commandIdFor(SESSION_ID, "wrong-command-type");
        yield* orchestrator.dispatch({
          type: "thread.visit",
          commandId,
          threadId,
          visitedAt: NOW,
        });
        const failure = yield* Effect.flip(
          service.compact(SESSION_ID, { threadId, idempotencyKey: "wrong-command-type" }),
        );
        expect(failure._tag).toBe("ManualCompactionInvalidRequestError");
        expect(control.calls).toHaveLength(0);
      }).pipe(Effect.provide(fixture));
    }),
  ),
);
