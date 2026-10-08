import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { layerMemory } from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2SessionRuntime, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadLifecycle from "./ThreadLifecycleService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const autoSettleModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;
const autoSettleAdapter = {
  instanceId: autoSettleModelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Provider execution is not used by auto-settle tests"),
} as ProviderAdapterV2Shape;

function makeAutoSettleLayer(name: string) {
  const database = layerMemory.pipe(Layer.orDie);
  return Layer.mergeAll(
    database,
    ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerFromAdapters([autoSettleAdapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
}

function createAutoSettleThread(input: { readonly commandId: string; readonly threadId: string }) {
  return Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make(input.threadId),
      projectId: ProjectId.make("project:auto-settle-tests"),
      title: "Auto-settle test thread",
      modelSelection: autoSettleModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function dispatchSequenceAutoSettle(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly snapshotSequence: number;
}) {
  return Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make(input.threadId),
      snapshotSequence: input.snapshotSequence,
      settledAt: DateTime.makeUnsafe("2026-10-06T00:00:00.000Z"),
    }),
  );
}

function makeSessionStopAdapter(closed: Array<string>): ProviderAdapterV2Shape {
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    sessions: {
      ...CodexProviderCapabilitiesV2.sessions,
      supportsMultipleProviderThreadsPerSession: false,
    },
  };
  return {
    instanceId: autoSettleModelSelection.instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => closed.push(String(input.providerSessionId))),
        );
        const runtime: ProviderAdapterV2SessionRuntime = {
          instanceId: autoSettleModelSelection.instanceId,
          driver: ProviderDriverKind.make("codex"),
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: autoSettleModelSelection.instanceId,
            status: String(input.providerSessionId).endsWith("running") ? "running" : "ready",
            cwd: input.runtimePolicy.cwd ?? process.cwd(),
            model: input.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.never,
          ensureThread: () => Effect.die("Thread creation is not used by session-stop tests"),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            Effect.die("Thread snapshots are not used by session-stop tests"),
          rollbackThread: () => Effect.die("Rollback is not used by session-stop tests"),
          forkThread: () => Effect.die("Forking is not used by session-stop tests"),
        };
        return runtime;
      }),
  };
}

function makeSessionStopLayer(name: string, closed: Array<string>) {
  const database = layerMemory.pipe(Layer.orDie);
  return ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([makeSessionStopAdapter(closed)]),
    { databaseLayer: database, runEffectWorker: false },
  );
}

function openSessionForTest(input: { readonly threadId: string; readonly sessionId: string }) {
  return ProviderSessionManager.ProviderSessionManagerV2.use((providerSessions) =>
    providerSessions.open({
      threadId: ThreadId.make(input.threadId),
      providerSessionId: ProviderSessionId.make(input.sessionId),
      modelSelection: autoSettleModelSelection,
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      },
    }),
  );
}

function stopThreadSession(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly onlyIfSettled?: boolean;
}) {
  return Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(input.commandId),
      threadId: ThreadId.make(input.threadId),
      createdAt: DateTime.makeUnsafe("2026-10-06T00:00:00.000Z"),
      ...(input.onlyIfSettled === undefined ? {} : { onlyIfSettled: input.onlyIfSettled }),
    }),
  );
}

it.effect("maps application lifecycle operations to V2-native commands", () => {
  const threadId = ThreadId.make("thread_lifecycle_service");
  const commands: Array<string> = [];
  const projection = { thread: { id: threadId } } as OrchestrationV2ThreadProjection;
  const layer = ThreadLifecycle.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) => {
          commands.push(command.type);
          return Effect.succeed({ sequence: commands.length, storedEvents: [] });
        },
        getThreadRecords: () => Effect.succeed(projection),
      }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadLifecycle.ThreadLifecycleService;
    yield* service.archive({ commandId: CommandId.make("archive"), threadId });
    yield* service.unarchive({ commandId: CommandId.make("unarchive"), threadId });
    yield* service.updateMetadata({ commandId: CommandId.make("metadata"), threadId, title: "T" });
    yield* service.setRuntimeMode({
      commandId: CommandId.make("runtime"),
      threadId,
      runtimeMode: "approval-required",
    });
    yield* service.setInteractionMode({
      commandId: CommandId.make("interaction"),
      threadId,
      interactionMode: "plan",
    });
    yield* service.setModelSelection({
      commandId: CommandId.make("model"),
      threadId,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.2" },
    });
    yield* service.delete({ commandId: CommandId.make("delete"), threadId });
    assert.deepEqual(commands, [
      "thread.archive",
      "thread.unarchive",
      "thread.metadata.update",
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
      "thread.model-selection.set",
      "thread.delete",
    ]);
  }).pipe(Effect.provide(layer));
});

it.effect("rejects sequence auto-settle after same-thread activity without an updatedAt bump", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:auto-settle-same-thread");
    const created = yield* createAutoSettleThread({
      commandId: "command:auto-settle-create-same-thread",
      threadId,
    });
    const beforeHide = yield* orchestrator.getThreadProjection(threadId);
    yield* orchestrator.dispatch({
      type: "thread.hide",
      commandId: CommandId.make("command:auto-settle-hide-same-thread"),
      threadId,
    });
    const afterHide = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(afterHide.thread.updatedAt, beforeHide.thread.updatedAt);

    const stale = yield* dispatchSequenceAutoSettle({
      commandId: "command:auto-settle-stale-sequence",
      threadId,
      snapshotSequence: created.sequence,
    }).pipe(Effect.flip);
    assert.instanceOf(stale, Orchestrator.OrchestratorDispatchError);
    assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride, null);
  }).pipe(Effect.provide(makeAutoSettleLayer("auto-settle-same-thread"))),
);

it.effect("ignores unrelated-thread events when checking a sequence watermark", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const targetId = ThreadId.make("thread:auto-settle-unrelated-target");
    const unrelatedId = ThreadId.make("thread:auto-settle-unrelated-other");
    const created = yield* createAutoSettleThread({
      commandId: "command:auto-settle-create-unrelated-target",
      threadId: targetId,
    });
    yield* createAutoSettleThread({
      commandId: "command:auto-settle-create-unrelated-other",
      threadId: unrelatedId,
    });
    yield* orchestrator.dispatch({
      type: "thread.hide",
      commandId: CommandId.make("command:auto-settle-hide-unrelated-other"),
      threadId: unrelatedId,
    });

    yield* dispatchSequenceAutoSettle({
      commandId: "command:auto-settle-unrelated-watermark",
      threadId: targetId,
      snapshotSequence: created.sequence,
    });
    assert.equal(
      (yield* orchestrator.getThreadProjection(targetId)).thread.settledOverride,
      "settled",
    );
  }).pipe(Effect.provide(makeAutoSettleLayer("auto-settle-unrelated-thread"))),
);

it.effect("accepts an exact thread sequence watermark", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:auto-settle-exact-watermark");
    const created = yield* createAutoSettleThread({
      commandId: "command:auto-settle-create-exact-watermark",
      threadId,
    });

    const settled = yield* dispatchSequenceAutoSettle({
      commandId: "command:auto-settle-exact-watermark",
      threadId,
      snapshotSequence: created.sequence,
    });
    assert.ok(settled.sequence > created.sequence);
    assert.equal(
      (yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride,
      "settled",
    );
  }).pipe(Effect.provide(makeAutoSettleLayer("auto-settle-exact-watermark"))),
);

it.effect("replays an accepted sequence auto-settle receipt before fresh sequence checks", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("thread:auto-settle-replay");
    const created = yield* createAutoSettleThread({
      commandId: "command:auto-settle-create-replay",
      threadId,
    });
    const command = {
      type: "thread.auto-settle" as const,
      commandId: CommandId.make("command:auto-settle-replay"),
      threadId,
      snapshotSequence: created.sequence,
      settledAt: DateTime.makeUnsafe("2026-10-06T00:00:00.000Z"),
    };
    const accepted = yield* orchestrator.dispatch(command);
    yield* orchestrator.dispatch({
      type: "thread.hide",
      commandId: CommandId.make("command:auto-settle-after-acceptance"),
      threadId,
    });
    const replayed = yield* orchestrator.dispatch(command);

    assert.equal(replayed.sequence, accepted.sequence);
    assert.equal(JSON.stringify(replayed.storedEvents), JSON.stringify(accepted.storedEvents));
  }).pipe(Effect.provide(makeAutoSettleLayer("auto-settle-replay"))),
);

it.effect("keeps the native timestamp auto-settle guard unchanged", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* TestClock.setTime(Date.parse("2026-10-06T00:00:00.000Z"));
    const threadId = ThreadId.make("thread:auto-settle-timestamp");
    yield* createAutoSettleThread({
      commandId: "command:auto-settle-create-timestamp",
      threadId,
    });
    const beforeUpdate = yield* orchestrator.getThreadProjection(threadId);
    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("command:auto-settle-update-timestamp"),
      threadId,
      title: "Updated after snapshot",
    });
    const stale = yield* orchestrator
      .dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("command:auto-settle-stale-timestamp"),
        threadId,
        snapshotAt: beforeUpdate.thread.updatedAt,
      })
      .pipe(Effect.flip);

    assert.instanceOf(stale, Orchestrator.OrchestratorDispatchError);
    assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.settledOverride, null);
  }).pipe(
    Effect.provide(Layer.mergeAll(makeAutoSettleLayer("auto-settle-timestamp"), TestClock.layer())),
  ),
);

it.effect("stops live idle and running sessions attached to one thread", () => {
  const closed: Array<string> = [];
  return Effect.gen(function* () {
    const targetId = ThreadId.make("thread:session-stop-target");
    const otherId = ThreadId.make("thread:session-stop-other");
    yield* createAutoSettleThread({
      commandId: "command:session-stop-create-target",
      threadId: targetId,
    });
    yield* createAutoSettleThread({
      commandId: "command:session-stop-create-other",
      threadId: otherId,
    });
    yield* openSessionForTest({
      threadId: targetId,
      sessionId: "provider-session:session-stop-idle",
    });
    yield* openSessionForTest({
      threadId: targetId,
      sessionId: "provider-session:session-stop-running",
    });
    yield* openSessionForTest({
      threadId: otherId,
      sessionId: "provider-session:session-stop-other-running",
    });

    const dispatch = yield* stopThreadSession({
      commandId: "command:session-stop-live",
      threadId: targetId,
    });
    assert.equal(dispatch.storedEvents.length, 2);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const effects = yield* outbox.listByCommandId(CommandId.make("command:session-stop-live"));
    assert.deepEqual(
      effects.map((effect) => effect.request.type),
      ["provider-session.detach", "provider-session.detach"],
    );

    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    assert.equal(yield* worker.drain(2), 2);
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    assert.equal(
      (yield* sessions.get(ProviderSessionId.make("provider-session:session-stop-idle")))._tag,
      "None",
    );
    assert.equal(
      (yield* sessions.get(ProviderSessionId.make("provider-session:session-stop-running")))._tag,
      "None",
    );
    assert.equal(
      (yield* sessions.get(ProviderSessionId.make("provider-session:session-stop-other-running")))
        ._tag,
      "Some",
    );
    assert.deepEqual(closed.toSorted(), [
      "provider-session:session-stop-idle",
      "provider-session:session-stop-running",
    ]);
  }).pipe(Effect.provide(makeSessionStopLayer("session-stop-live", closed)));
});

it.effect("replays an accepted no-session stop without detaching a later session", () => {
  const closed: Array<string> = [];
  return Effect.gen(function* () {
    const threadId = ThreadId.make("thread:session-stop-no-session");
    yield* createAutoSettleThread({
      commandId: "command:session-stop-create-no-session",
      threadId,
    });
    const command = {
      commandId: "command:session-stop-no-session",
      threadId: String(threadId),
    } as const;
    const first = yield* stopThreadSession(command);
    assert.deepEqual(first.storedEvents, []);

    yield* openSessionForTest({
      threadId,
      sessionId: "provider-session:session-stop-late",
    });
    const replay = yield* stopThreadSession(command);
    assert.equal(replay.sequence, first.sequence);
    assert.deepEqual(replay.storedEvents, []);
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    assert.equal(
      (yield* sessions.get(ProviderSessionId.make("provider-session:session-stop-late")))._tag,
      "Some",
    );
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    assert.deepEqual(
      yield* outbox.listByCommandId(CommandId.make("command:session-stop-no-session")),
      [],
    );
    assert.deepEqual(closed, []);
  }).pipe(Effect.provide(makeSessionStopLayer("session-stop-no-session", closed)));
});

it.effect("skips a settled-only session stop after the thread is re-engaged", () => {
  const closed: Array<string> = [];
  return Effect.gen(function* () {
    const threadId = ThreadId.make("thread:session-stop-reengaged");
    yield* createAutoSettleThread({
      commandId: "command:session-stop-create-reengaged",
      threadId,
    });
    yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("command:session-stop-settle-before-turn"),
        threadId,
      }),
    );
    yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:session-stop-reengage-turn"),
        threadId,
        messageId: MessageId.make("message:session-stop-reengage-turn"),
        text: "Start again",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      }),
    );
    const projection = yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.getThreadProjection(threadId),
    );
    assert.isTrue(
      projection.runs.some(
        (run) =>
          run.status === "queued" ||
          run.status === "preparing" ||
          run.status === "starting" ||
          run.status === "running",
      ),
    );
    yield* openSessionForTest({
      threadId,
      sessionId: "provider-session:session-stop-reengaged",
    });

    const rejected = yield* stopThreadSession({
      commandId: "command:session-stop-only-if-settled-reengaged",
      threadId,
      onlyIfSettled: true,
    }).pipe(Effect.flip);
    assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    assert.equal(
      (yield* sessions.get(ProviderSessionId.make("provider-session:session-stop-reengaged")))._tag,
      "Some",
    );
    assert.deepEqual(closed, []);
  }).pipe(Effect.provide(makeSessionStopLayer("session-stop-reengaged", closed)));
});

it.effect("does not stop a running provider session that appears after settle", () => {
  const closed: Array<string> = [];
  return Effect.gen(function* () {
    const threadId = ThreadId.make("thread:session-stop-starting");
    yield* createAutoSettleThread({
      commandId: "command:session-stop-create-starting",
      threadId,
    });
    yield* Orchestrator.OrchestratorV2.use((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("command:session-stop-settle-starting"),
        threadId,
      }),
    );
    yield* openSessionForTest({
      threadId,
      sessionId: "provider-session:session-stop-running",
    });

    const rejected = yield* stopThreadSession({
      commandId: "command:session-stop-only-if-settled-starting",
      threadId,
      onlyIfSettled: true,
    }).pipe(Effect.flip);
    assert.instanceOf(rejected, Orchestrator.OrchestratorDispatchError);
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    assert.equal(
      (yield* sessions.get(ProviderSessionId.make("provider-session:session-stop-running")))._tag,
      "Some",
    );
    assert.deepEqual(closed, []);
  }).pipe(Effect.provide(makeSessionStopLayer("session-stop-starting", closed)));
});
