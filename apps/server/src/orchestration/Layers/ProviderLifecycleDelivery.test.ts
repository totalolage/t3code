// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProviderInstanceConfigMap,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ServerProvider,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { ProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import { ProviderAdapterRegistryLive } from "../../provider/Layers/ProviderAdapterRegistry.ts";
import { makeProviderInstanceRegistry } from "../../provider/Layers/ProviderInstanceRegistryLive.ts";
import * as ProviderDriver from "../../provider/ProviderDriver.ts";
import * as ProviderAdapter from "../../provider/Services/ProviderAdapter.ts";
import { ProviderAuthService } from "../../provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderInstanceRegistryMutator } from "../../provider/Services/ProviderInstanceRegistryMutator.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../../provider/Services/ProviderSessionDirectory.ts";
import { makeProviderRegistryLayer } from "../../provider/testUtils/providerRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { QueuedProviderTurnStartRepositoryLive } from "../../persistence/Layers/QueuedProviderTurnStarts.ts";
import { PendingInteractionRepositoryLive } from "../../persistence/Layers/PendingInteractions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { QueuedProviderTurnStartRepository } from "../../persistence/Services/QueuedProviderTurnStarts.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./ProviderCommandReactor.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import {
  makeCommandGate,
  ServerRuntimeStartupError,
  shutdownServerRuntime,
} from "../../serverRuntimeStartup.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import type { ProviderAdapterError } from "../../provider/Errors.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeSqlStatementCounter } from "../../../integration/SqlStatementCounter.integration.ts";

const OPENCODE = ProviderDriverKind.make("opencode");
const MAIN_INSTANCE = ProviderInstanceId.make("opencode-main");
const HEALTHY_INSTANCE = ProviderInstanceId.make("opencode-healthy");
const PROJECT_ID = ProjectId.make("provider-lifecycle-project");
const MAIN_THREAD_ID = ThreadId.make("provider-lifecycle-main");
const HEALTHY_THREAD_ID = ThreadId.make("provider-lifecycle-healthy");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

type FakeOpenCodeRuntimeEventEntry =
  | { readonly _tag: "event"; readonly event: ProviderRuntimeEvent }
  | { readonly _tag: "barrier"; readonly deferred: Deferred.Deferred<void> };

type FakeOpenCodeHandle = {
  readonly adapter: ProviderAdapter.ProviderAdapterShape<ProviderAdapterError>;
  readonly cleanupStarted: Deferred.Deferred<void>;
  readonly cleanupRelease: Deferred.Deferred<void>;
  readonly queue: Queue.Queue<FakeOpenCodeRuntimeEventEntry, Cause.Done>;
  readonly scope: Scope.Scope;
  readonly streamSubscribed: Deferred.Deferred<void>;
  readonly streamEnded: Deferred.Deferred<void>;
  readonly allExitEvents: Array<ProviderRuntimeEvent>;
  readonly stopAllCalls: { value: number };
  readonly stopSessionCalls: { value: number };
  readonly offer: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
};

type NativeCompactionControl = {
  readonly entered: Deferred.Deferred<void>;
  readonly startCalls: { value: number };
};

type FixtureState = {
  readonly current: Map<ProviderInstanceId, FakeOpenCodeHandle>;
  readonly all: Array<FakeOpenCodeHandle>;
  readonly withCommandReactor: boolean;
  readonly nativeCompaction: NativeCompactionControl | undefined;
  readonly shutdownRegression: ShutdownRegression;
};

type LifecycleHarness = {
  readonly commandReactor: ProviderCommandReactor["Service"] | undefined;
  readonly engine: OrchestrationEngineShape;
  readonly ingestion: ProviderRuntimeIngestionService["Service"];
  readonly mutator: ProviderInstanceRegistryMutator["Service"];
  readonly provider: ProviderService.ProviderService["Service"];
  readonly queuedTurnStarts: QueuedProviderTurnStartRepository["Service"];
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly main: FakeOpenCodeHandle;
  readonly healthy: FakeOpenCodeHandle;
  readonly reactorClosed: Deferred.Deferred<void>;
  readonly reactorScope: Scope.Closeable;
  readonly workspaceRoot: string;
  readonly state: FixtureState;
  readonly dispatch: OrchestrationEngineShape["dispatch"];
};

type LifecycleScenario =
  | "provider.stopSession"
  | "registry removal"
  | "registry replacement"
  | "child scope close"
  | "provider.stopAll"
  | "server runtime shutdown";

type ShutdownGate = {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  used: boolean;
};

type ShutdownRegression = {
  readonly enabled: { value: boolean };
  readonly metadata: readonly [ShutdownGate, ShutdownGate, ShutdownGate, ShutdownGate];
  readonly native: ShutdownGate & { readonly completed: Deferred.Deferred<void> };
};

const makeShutdownGate = (): ShutdownGate => ({
  entered: Deferred.makeUnsafe<void>(),
  release: Deferred.makeUnsafe<void>(),
  used: false,
});

const makeShutdownRegression = (): ShutdownRegression => ({
  enabled: { value: false },
  metadata: [makeShutdownGate(), makeShutdownGate(), makeShutdownGate(), makeShutdownGate()],
  native: {
    ...makeShutdownGate(),
    completed: Deferred.makeUnsafe<void>(),
  },
});

const gateShutdownPhase = <A, E>(
  shutdown: ShutdownRegression,
  gate: ShutdownGate,
  duration: "1.9 seconds" | "8 seconds",
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    if (!shutdown.enabled.value || gate.used) return effect;
    gate.used = true;
    return Effect.gen(function* () {
      yield* Deferred.succeed(gate.entered, undefined);
      yield* Effect.sleep(duration);
      yield* Deferred.await(gate.release);
      return yield* effect;
    });
  });

const releaseShutdownGates = (shutdown: ShutdownRegression) =>
  Effect.forEach(
    [...shutdown.metadata, shutdown.native],
    (gate) => Deferred.succeed(gate.release, undefined).pipe(Effect.asVoid),
    { discard: true },
  );

const scenarios: ReadonlyArray<LifecycleScenario> = [
  "provider.stopSession",
  "registry removal",
  "registry replacement",
  "child scope close",
  "provider.stopAll",
  "server runtime shutdown",
];

const makeOpenCodeEvent = (input: {
  readonly eventId: string;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
  readonly type: "turn.started" | "content.delta" | "turn.completed" | "session.exited";
}): ProviderRuntimeEvent => {
  const base = {
    eventId: EventId.make(input.eventId),
    provider: OPENCODE,
    threadId: input.threadId,
    createdAt: CREATED_AT,
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
  };
  switch (input.type) {
    case "turn.started":
      return { ...base, type: input.type, payload: {} };
    case "content.delta":
      return {
        ...base,
        type: input.type,
        payload: { streamKind: "assistant_text", delta: "partial answer" },
      };
    case "turn.completed":
      return { ...base, type: input.type, payload: { state: "completed" } };
    case "session.exited":
      return { ...base, type: input.type, payload: { exitKind: "graceful" } };
  }
};

const makeFakeOpenCodeHandle = Effect.fn("ProviderLifecycleDeliveryTest.makeFakeOpenCodeHandle")(
  function* (
    instanceId: ProviderInstanceId,
    childScope: Scope.Scope,
    generation: number,
    shutdownRegression: ShutdownRegression,
    nativeCompaction: NativeCompactionControl | undefined,
  ) {
    const queue = yield* Queue.unbounded<FakeOpenCodeRuntimeEventEntry, Cause.Done>();
    const cleanupStarted = yield* Deferred.make<void>();
    const cleanupRelease = yield* Deferred.make<void>();
    const streamSubscribed = yield* Deferred.make<void>();
    const streamEnded = yield* Deferred.make<void>();
    const sessions = new Map<ThreadId, ProviderSession>();
    const allExitEvents: Array<ProviderRuntimeEvent> = [];
    const stopAllCalls = { value: 0 };
    const stopSessionCalls = { value: 0 };
    let turnNumber = 0;

    const offer = (event: ProviderRuntimeEvent) =>
      Effect.gen(function* () {
        yield* Queue.offer(queue, { _tag: "event", event });
        if (event.type !== "turn.completed") return;
        yield* Effect.sync(() => {
          const session = sessions.get(event.threadId);
          if (session === undefined) return;
          sessions.set(event.threadId, {
            ...session,
            status: "ready",
            activeTurnId: undefined,
            updatedAt: CREATED_AT,
          });
        });
      });

    const drainEvents = Effect.fn("ProviderLifecycleDeliveryTest.drainEvents")(function* () {
      const deferred = yield* Deferred.make<void>();
      const accepted = yield* Queue.offer(queue, { _tag: "barrier", deferred });
      if (!accepted) return false;
      yield* Deferred.await(deferred);
      return true;
    });

    const startSession = (input: ProviderSessionStartInput) =>
      Effect.sync(() => {
        const session: ProviderSession = {
          provider: OPENCODE,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? { opaque: `resume-${String(input.threadId)}` },
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        };
        sessions.set(input.threadId, session);
        return session;
      });

    const sendTurn = (input: ProviderSendTurnInput): Effect.Effect<ProviderTurnStartResult> =>
      Effect.gen(function* () {
        const session = yield* Effect.sync(() => sessions.get(input.threadId));
        if (session === undefined) {
          return yield* Effect.die(`No fake OpenCode session for ${String(input.threadId)}`);
        }
        const turnId = TurnId.make(
          `${String(instanceId)}-generation-${generation}-turn-${++turnNumber}`,
        );
        yield* Effect.sync(() => {
          sessions.set(input.threadId, {
            ...session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: CREATED_AT,
          });
        });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: session.resumeCursor,
        };
      });

    const stopSession = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const session = yield* Effect.sync(() => sessions.get(threadId));
        if (session === undefined) return;
        stopSessionCalls.value += 1;
        yield* Deferred.succeed(cleanupStarted, undefined);
        yield* Deferred.await(cleanupRelease);
        const removed = yield* Effect.sync(() => {
          if (!sessions.has(threadId)) return false;
          sessions.delete(threadId);
          return true;
        });
        if (!removed) return;
        const event = makeOpenCodeEvent({
          eventId: `${String(instanceId)}-${String(threadId)}-session-exited`,
          threadId,
          ...(session.activeTurnId === undefined ? {} : { turnId: session.activeTurnId }),
          type: "session.exited",
        });
        allExitEvents.push(event);
        yield* offer(event);
      });

    const stopAll = () =>
      gateShutdownPhase(
        shutdownRegression,
        shutdownRegression.native,
        "8 seconds",
        Effect.gen(function* () {
          stopAllCalls.value += 1;
          const threadIds = yield* Effect.sync(() => Array.from(sessions.keys()));
          yield* Effect.forEach(threadIds, stopSession, { concurrency: 1 });
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(shutdownRegression.native.completed, undefined).pipe(Effect.asVoid),
          ),
        ),
      ).pipe(Effect.asVoid);

    const listSessions = () =>
      gateShutdownPhase(
        shutdownRegression,
        shutdownRegression.metadata[2],
        "1.9 seconds",
        Effect.sync(() => Array.from(sessions.values())),
      );

    const adapter: ProviderAdapter.ProviderAdapterShape<ProviderAdapterError> = {
      provider: OPENCODE,
      capabilities: {
        sessionModelSwitch: "in-session",
        promptlessTurnContinuation: true,
        turnSteering: "supported",
      },
      startSession,
      sendTurn,
      ...(nativeCompaction === undefined
        ? {}
        : {
            compaction: {
              type: "native" as const,
              start: () =>
                Effect.gen(function* () {
                  nativeCompaction.startCalls.value += 1;
                  yield* Deferred.succeed(nativeCompaction.entered, undefined);
                }),
            },
          }),
      interruptTurn: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession,
      listSessions,
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      stopAll,
      drainEvents,
      streamEvents: Stream.unwrap(
        Deferred.succeed(streamSubscribed, undefined).pipe(
          Effect.as(
            Stream.fromQueue(queue).pipe(
              Stream.rechunk(1),
              Stream.filterMapEffect((entry) =>
                entry._tag === "event"
                  ? Effect.succeed(Result.succeed(entry.event))
                  : Deferred.succeed(entry.deferred, undefined).pipe(Effect.as(Result.fail(entry))),
              ),
            ),
          ),
        ),
      ).pipe(Stream.ensuring(Deferred.succeed(streamEnded, undefined).pipe(Effect.asVoid))),
    };

    return {
      adapter,
      cleanupStarted,
      cleanupRelease,
      queue,
      scope: childScope,
      streamSubscribed,
      streamEnded,
      allExitEvents,
      stopAllCalls,
      stopSessionCalls,
      offer,
    };
  },
);

function makeFakeOpenCodeInstance(
  instanceId: ProviderInstanceId,
  handle: FakeOpenCodeHandle,
): ProviderDriver.ProviderInstance {
  return {
    instanceId,
    driverKind: OPENCODE,
    continuationIdentity: {
      driverKind: OPENCODE,
      continuationKey: `${OPENCODE}:instance:${instanceId}`,
    },
    displayName: `Fake OpenCode ${instanceId}`,
    enabled: true,
    snapshot: {
      resolveMaintenance: () => Effect.die("unused in lifecycle delivery test"),
      getSnapshot: Effect.succeed({} as ServerProvider),
      refresh: Effect.succeed({} as ServerProvider),
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
    },
    adapter: handle.adapter,
    textGeneration: {} as ProviderDriver.ProviderInstance["textGeneration"],
  };
}

function makeFixture(
  options: {
    readonly withCommandReactor?: boolean;
    readonly nativeCompaction?: NativeCompactionControl;
  } = {},
) {
  const shutdownRegression = makeShutdownRegression();
  const state: FixtureState = {
    current: new Map(),
    all: [],
    withCommandReactor: options.withCommandReactor === true,
    nativeCompaction: options.nativeCompaction,
    shutdownRegression,
  };
  const sqlCounter = makeSqlStatementCounter();
  const driver: ProviderDriver.ProviderDriver<{ readonly marker: string }> = {
    driverKind: OPENCODE,
    metadata: { displayName: "Fake OpenCode" },
    configSchema: Schema.Struct({ marker: Schema.String }),
    defaultConfig: () => ({ marker: "default" }),
    create: ({ instanceId }) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const handle = yield* makeFakeOpenCodeHandle(
          instanceId,
          scope,
          state.all.length + 1,
          shutdownRegression,
          options.nativeCompaction,
        );
        state.current.set(instanceId, handle);
        state.all.push(handle);
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            yield* handle.adapter.stopAll().pipe(Effect.orDie);
            yield* Queue.end(handle.queue).pipe(Effect.asVoid);
          }),
        );
        return makeFakeOpenCodeInstance(instanceId, handle);
      }),
  };

  const configMap: ProviderInstanceConfigMap = {
    [MAIN_INSTANCE]: {
      driver: OPENCODE,
      enabled: true,
      config: { marker: "main" },
    },
    [HEALTHY_INSTANCE]: {
      driver: OPENCODE,
      enabled: true,
      config: { marker: "healthy" },
    },
  };
  const registryLayer = Layer.effectContext(
    makeProviderInstanceRegistry({ drivers: [driver], configMap }).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  );
  const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(Layer.provideMerge(registryLayer));
  const serverSettingsLayer = ServerSettingsService.layerTest({
    enableLegacyTokenStreaming: false,
  });
  const gatedServerSettingsLayer = Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      return {
        ...settings,
        getSettings: gateShutdownPhase(
          shutdownRegression,
          shutdownRegression.metadata[0],
          "1.9 seconds",
          settings.getSettings,
        ),
      } satisfies ServerSettingsService["Service"];
    }),
  ).pipe(Layer.provide(serverSettingsLayer));
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), process.cwd());
  const nodeServicesLayer = NodeServices.layer;
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
  const gatedDirectoryLayer = Layer.effect(
    ProviderSessionDirectory.ProviderSessionDirectory,
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      return {
        ...directory,
        listThreadIds: () =>
          gateShutdownPhase(
            shutdownRegression,
            shutdownRegression.metadata[1],
            "1.9 seconds",
            directory.listThreadIds(),
          ),
        upsert: (binding, options) =>
          gateShutdownPhase(
            shutdownRegression,
            shutdownRegression.metadata[3],
            "1.9 seconds",
            directory.upsert(binding, options),
          ),
      } satisfies ProviderSessionDirectory.ProviderSessionDirectory["Service"];
    }),
  ).pipe(Layer.provide(directoryLayer));
  const providerLayer = ProviderServiceLive.pipe(
    Layer.provideMerge(adapterRegistryLayer),
    Layer.provide(gatedDirectoryLayer),
    Layer.provide(gatedServerSettingsLayer),
    Layer.provide(serverConfigLayer),
    Layer.provide(AnalyticsService.layerTest),
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provide(nodeServicesLayer),
  );
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(QueuedProviderTurnStartRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
  );
  const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  );
  const ingestionProjectionSnapshotLayer = Layer.effect(
    ProjectionSnapshotQuery,
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      return ProjectionSnapshotQuery.of({
        ...query,
        getThreadDetailById: () => Effect.die("thread detail is not used by this seam"),
      });
    }),
  ).pipe(Layer.provide(projectionSnapshotLayer));
  const ingestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(ingestionProjectionSnapshotLayer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
    Layer.provideMerge(PendingInteractionRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(providerLayer),
    Layer.provideMerge(serverSettingsLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(nodeServicesLayer),
    Layer.provideMerge(Layer.succeed(Tracer.Tracer, sqlCounter.tracer)),
  );

  return {
    state,
    layer: Layer.merge(ingestionLayer, projectionSnapshotLayer),
  };
}

function makeThreadCreateCommand(input: {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
}): OrchestrationCommand {
  return {
    type: "thread.create",
    commandId: CommandId.make(`create-${String(input.threadId)}`),
    threadId: input.threadId,
    projectId: PROJECT_ID,
    title: input.title,
    modelSelection: { instanceId: input.instanceId, model: "fake-model" },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    createdAt: CREATED_AT,
  };
}

const awaitSharedEvent = Effect.fn("ProviderLifecycleDeliveryTest.awaitSharedEvent")(function* (
  provider: ProviderService.ProviderService["Service"],
  predicate: (event: ProviderRuntimeEvent) => boolean,
) {
  const receipt = yield* provider.streamEvents.pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* Effect.yieldNow;
  return receipt;
});

const awaitProviderFailureActivity = Effect.fn(
  "ProviderLifecycleDeliveryTest.awaitProviderFailureActivity",
)(function* (engine: OrchestrationEngineShape, threadId: ThreadId) {
  const domainEvents = yield* engine.subscribeDomainEvents;
  const receipt = yield* domainEvents.pipe(
    Stream.filter(
      (event): event is Extract<OrchestrationEvent, { type: "thread.activity-appended" }> =>
        event.type === "thread.activity-appended" &&
        event.payload.threadId === threadId &&
        event.payload.activity.kind === "provider.turn.start.failed",
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* Effect.yieldNow;
  return receipt;
});

const awaitProviderSessionStatus = Effect.fn(
  "ProviderLifecycleDeliveryTest.awaitProviderSessionStatus",
)(function* (engine: OrchestrationEngineShape, threadId: ThreadId, status: "starting" | "ready") {
  const domainEvents = yield* engine.subscribeDomainEvents;
  const receipt = yield* domainEvents.pipe(
    Stream.filter(
      (event): event is Extract<OrchestrationEvent, { type: "thread.session-set" }> =>
        event.type === "thread.session-set" &&
        event.payload.threadId === threadId &&
        event.payload.session.status === status,
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* Effect.yieldNow;
  return receipt;
});

const startTurn = Effect.fn("ProviderLifecycleDeliveryTest.startTurn")(function* (input: {
  readonly harness: LifecycleHarness;
  readonly handle: FakeOpenCodeHandle;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly eventPrefix: string;
  readonly prompt: string;
}) {
  const { harness } = input;
  const request = yield* harness.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`${input.eventPrefix}-request`),
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.prompt,
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: CREATED_AT,
  });
  const turn = yield* harness.provider.sendTurn({
    threadId: input.threadId,
    input: input.prompt,
    attachments: [],
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    modelSelection: {
      instanceId: input.instanceId,
      model: "fake-model",
    },
  });
  const started = makeOpenCodeEvent({
    eventId: `${input.eventPrefix}-started`,
    threadId: input.threadId,
    turnId: turn.turnId,
    type: "turn.started",
  });
  const startedReceipt = yield* awaitSharedEvent(
    harness.provider,
    (event) => event.eventId === started.eventId,
  );
  yield* input.handle.offer(started);
  yield* Fiber.join(startedReceipt);
  yield* harness.ingestion.drain;

  const delta = makeOpenCodeEvent({
    eventId: `${input.eventPrefix}-delta`,
    threadId: input.threadId,
    turnId: turn.turnId,
    itemId: RuntimeItemId.make(`${input.eventPrefix}-item`),
    type: "content.delta",
  });
  const deltaReceipt = yield* awaitSharedEvent(
    harness.provider,
    (event) => event.eventId === delta.eventId,
  );
  yield* input.handle.offer(delta);
  yield* Fiber.join(deltaReceipt);
  yield* harness.ingestion.drain;
  return { eventSequence: request.sequence, messageId: input.messageId, turnId: turn.turnId };
});

const completeTurn = Effect.fn("ProviderLifecycleDeliveryTest.completeTurn")(function* (input: {
  readonly harness: LifecycleHarness;
  readonly handle: FakeOpenCodeHandle;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly eventPrefix: string;
}) {
  const completed = makeOpenCodeEvent({
    eventId: `${input.eventPrefix}-completed`,
    threadId: input.threadId,
    turnId: input.turnId,
    type: "turn.completed",
  });
  const completedReceipt = yield* awaitSharedEvent(
    input.harness.provider,
    (event) => event.eventId === completed.eventId,
  );
  yield* input.handle.offer(completed);
  yield* Fiber.join(completedReceipt);
  yield* input.harness.ingestion.drain;
});

const readThread = (harness: LifecycleHarness, threadId: ThreadId) =>
  harness.snapshotQuery
    .getSnapshot()
    .pipe(Effect.map((snapshot) => snapshot.threads.find((thread) => thread.id === threadId)));

const seedCompletedConversation = Effect.fn(
  "ProviderLifecycleDeliveryTest.seedCompletedConversation",
)(function* (harness: LifecycleHarness) {
  yield* harness.provider.startSession(MAIN_THREAD_ID, {
    threadId: MAIN_THREAD_ID,
    provider: OPENCODE,
    providerInstanceId: MAIN_INSTANCE,
    cwd: harness.workspaceRoot,
    runtimeMode: "full-access",
    modelSelection: { instanceId: MAIN_INSTANCE, model: "fake-model" },
  });
  const seeded = yield* startTurn({
    harness,
    handle: harness.main,
    instanceId: MAIN_INSTANCE,
    threadId: MAIN_THREAD_ID,
    messageId: MessageId.make("compaction-seeded-user-message"),
    eventPrefix: "compaction-seeded",
    prompt: "Keep this conversation history",
  });
  yield* completeTurn({
    harness,
    handle: harness.main,
    threadId: MAIN_THREAD_ID,
    turnId: seeded.turnId,
    eventPrefix: "compaction-seeded",
  });
  yield* harness.queuedTurnStarts.delete({ eventSequence: seeded.eventSequence });

  const thread = yield* readThread(harness, MAIN_THREAD_ID);
  expect(thread?.session).toMatchObject({ status: "ready", activeTurnId: null });
  expect(thread?.latestTurn).toMatchObject({ turnId: seeded.turnId, state: "completed" });
  expect(thread?.messages).toContainEqual(
    expect.objectContaining({
      id: seeded.messageId,
      role: "user",
      text: "Keep this conversation history",
    }),
  );
  expect(thread?.messages).toContainEqual(
    expect.objectContaining({
      turnId: seeded.turnId,
      role: "assistant",
      text: "partial answer",
      streaming: false,
    }),
  );
  const sessions = yield* harness.main.adapter.listSessions();
  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({ threadId: MAIN_THREAD_ID, status: "ready" });
  expect(sessions[0]?.activeTurnId).toBeUndefined();
  return seeded;
});

const dispatchCompactCommand = Effect.fn("ProviderLifecycleDeliveryTest.dispatchCompactCommand")(
  function* (harness: LifecycleHarness, commandPrefix: string) {
    const request = yield* harness.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`${commandPrefix}-request`),
      threadId: MAIN_THREAD_ID,
      message: {
        messageId: MessageId.make(`${commandPrefix}-message`),
        role: "user",
        text: "/compact",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      createdAt: CREATED_AT,
    });
    return request;
  },
);

const runCompactFailure = Effect.fn("ProviderLifecycleDeliveryTest.runCompactFailure")(
  function* (input: {
    readonly harness: LifecycleHarness;
    readonly commandPrefix: string;
    readonly expectedDetail: string;
  }) {
    const commandReactor = input.harness.commandReactor;
    if (commandReactor === undefined) {
      return yield* Effect.die("command reactor is not enabled for this fixture");
    }
    const failureReceipt = yield* awaitProviderFailureActivity(
      input.harness.engine,
      MAIN_THREAD_ID,
    );
    const startingReceipt = yield* awaitProviderSessionStatus(
      input.harness.engine,
      MAIN_THREAD_ID,
      "starting",
    );
    const readyReceipt = yield* awaitProviderSessionStatus(
      input.harness.engine,
      MAIN_THREAD_ID,
      "ready",
    );
    yield* dispatchCompactCommand(input.harness, input.commandPrefix);
    const starting = yield* Fiber.join(startingReceipt);
    expect(Option.isSome(starting)).toBe(true);
    if (Option.isSome(starting)) {
      expect(starting.value.payload.session).toMatchObject({
        status: "starting",
        activeTurnId: null,
      });
    }
    const ready = yield* Fiber.join(readyReceipt);
    expect(Option.isSome(ready)).toBe(true);
    if (Option.isSome(ready)) {
      expect(ready.value.payload.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
      });
    }
    const failure = yield* Fiber.join(failureReceipt);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isSome(failure)) {
      expect(failure.value.payload.activity.payload).toEqual(
        expect.objectContaining({ detail: expect.stringContaining(input.expectedDetail) }),
      );
    }
    yield* commandReactor.drain;
    expect(yield* input.harness.queuedTurnStarts.list()).toHaveLength(0);
  },
);

const assertInterruptedSnapshot = Effect.fn(
  "ProviderLifecycleDeliveryTest.assertInterruptedSnapshot",
)(function* (input: {
  readonly harness: LifecycleHarness;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly messageId: MessageId;
  readonly prompt: string;
}) {
  const thread = yield* readThread(input.harness, input.threadId);
  expect(thread).toBeDefined();
  if (thread === undefined) return;
  expect(thread.session).toMatchObject({ status: "stopped", activeTurnId: null });
  expect(thread.latestTurn).toMatchObject({ turnId: input.turnId, state: "interrupted" });
  expect(thread.latestTurn?.completedAt).not.toBeNull();
  expect(thread.messages).toContainEqual(
    expect.objectContaining({
      id: input.messageId,
      role: "user",
      text: input.prompt,
    }),
  );
  expect(thread.messages).toContainEqual(
    expect.objectContaining({
      turnId: input.turnId,
      role: "assistant",
      text: "partial answer",
      streaming: false,
    }),
  );
});

function makeHarness(state: FixtureState) {
  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const ingestion = yield* ProviderRuntimeIngestionService;
    const provider = yield* ProviderService.ProviderService;
    const queuedTurnStarts = yield* QueuedProviderTurnStartRepository;
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const mutator = yield* ProviderInstanceRegistryMutator;
    const main = state.current.get(MAIN_INSTANCE);
    const healthy = state.current.get(HEALTHY_INSTANCE);
    if (main === undefined || healthy === undefined) {
      return yield* Effect.die("fake OpenCode instances were not materialized");
    }
    const reactorScope = yield* Scope.make("sequential");
    const reactorClosed = yield* Deferred.make<void>();
    // Register this before ingestion so it observes the scope after its
    // consumer finalizers have run. The enclosing test scope closes it for
    // every scenario that does not exercise server shutdown.
    yield* Scope.addFinalizer(
      reactorScope,
      Deferred.succeed(reactorClosed, undefined).pipe(Effect.asVoid),
    );
    yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void).pipe(Effect.ignore));
    const commandReactor = state.withCommandReactor
      ? yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const serverSettings = yield* ServerSettingsService;
          const commandReactorContext = yield* Layer.build(
            ProviderCommandReactorLive.pipe(
              Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
              Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
              Layer.provideMerge(Layer.succeed(ProviderService.ProviderService, provider)),
              Layer.provide(
                Layer.mock(ProviderAuthService)({
                  tryHandlePromptCommand: () => Effect.succeed(false),
                }),
              ),
              Layer.provideMerge(makeProviderRegistryLayer()),
              Layer.provideMerge(Layer.mock(GitWorkflowService.GitWorkflowService)({})),
              Layer.provideMerge(Layer.mock(VcsStatusBroadcaster)({})),
              Layer.provideMerge(Layer.mock(TextGeneration)({})),
              Layer.provideMerge(Layer.succeed(ServerSettingsService, serverSettings)),
              Layer.provideMerge(Layer.succeed(SqlClient.SqlClient, sql)),
              Layer.provide(NodeServices.layer),
            ),
          ).pipe(Scope.provide(reactorScope), Effect.provide(NodeServices.layer));
          return Context.get(commandReactorContext, ProviderCommandReactor);
        })
      : undefined;
    const fixtureRoot = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "provider-lifecycle-project-"),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(fixtureRoot, { recursive: true, force: true })),
    );
    const dispatch = (command: OrchestrationCommand) => engine.dispatch(command);
    yield* dispatch({
      type: "project.create",
      commandId: CommandId.make("create-provider-lifecycle-project"),
      projectId: PROJECT_ID,
      title: "Provider lifecycle project",
      workspaceRoot: fixtureRoot,
      defaultModelSelection: { instanceId: MAIN_INSTANCE, model: "fake-model" },
      createdAt: CREATED_AT,
    });
    yield* dispatch(
      makeThreadCreateCommand({
        threadId: MAIN_THREAD_ID,
        title: "Main lifecycle thread",
        instanceId: MAIN_INSTANCE,
      }),
    );
    yield* dispatch(
      makeThreadCreateCommand({
        threadId: HEALTHY_THREAD_ID,
        title: "Healthy lifecycle thread",
        instanceId: HEALTHY_INSTANCE,
      }),
    );
    yield* ingestion.start().pipe(Scope.provide(reactorScope));
    yield* Deferred.await(main.streamSubscribed);
    yield* Deferred.await(healthy.streamSubscribed);
    yield* Effect.yieldNow;
    return {
      commandReactor,
      engine,
      ingestion,
      mutator,
      provider,
      queuedTurnStarts,
      snapshotQuery,
      main,
      healthy,
      reactorClosed,
      reactorScope,
      workspaceRoot: fixtureRoot,
      state,
      dispatch,
    };
  });
}

const shutdownHarness = (fixture: ReturnType<typeof makeFixture>, harness: LifecycleHarness) =>
  Effect.gen(function* () {
    yield* Effect.forEach(fixture.state.all, (handle) =>
      Deferred.succeed(handle.cleanupRelease, undefined).pipe(Effect.asVoid),
    );
    const commandGate = yield* makeCommandGate;
    yield* shutdownServerRuntime({
      commandGate,
      shutdownError: new ServerRuntimeStartupError({
        mode: "web",
        host: null,
        port: 0,
        cause: new Error("provider lifecycle command reactor test teardown"),
      }),
      reactorScope: harness.reactorScope,
      stopProviders: harness.provider.stopAll(),
      drainIngestion: harness.ingestion.drain,
    });
  });

const runScenario = Effect.fn("ProviderLifecycleDeliveryTest.runScenario")(function* (
  harness: LifecycleHarness,
  scenario: LifecycleScenario,
) {
  yield* harness.provider.startSession(MAIN_THREAD_ID, {
    threadId: MAIN_THREAD_ID,
    provider: OPENCODE,
    providerInstanceId: MAIN_INSTANCE,
    runtimeMode: "full-access",
    modelSelection: { instanceId: MAIN_INSTANCE, model: "fake-model" },
  });
  const initial = yield* startTurn({
    harness,
    handle: harness.main,
    instanceId: MAIN_INSTANCE,
    threadId: MAIN_THREAD_ID,
    messageId: MessageId.make("main-user-message"),
    eventPrefix: "main-initial",
    prompt: "Start the main work",
  });

  if (scenario === "registry replacement") {
    yield* harness.provider.startSession(HEALTHY_THREAD_ID, {
      threadId: HEALTHY_THREAD_ID,
      provider: OPENCODE,
      providerInstanceId: HEALTHY_INSTANCE,
      runtimeMode: "full-access",
      modelSelection: { instanceId: HEALTHY_INSTANCE, model: "fake-model" },
    });
    const healthyTurn = yield* startTurn({
      harness,
      handle: harness.healthy,
      instanceId: HEALTHY_INSTANCE,
      threadId: HEALTHY_THREAD_ID,
      messageId: MessageId.make("healthy-user-message"),
      eventPrefix: "healthy-initial",
      prompt: "Keep the healthy work running",
    });
    const healthyBefore = yield* readThread(harness, HEALTHY_THREAD_ID);
    expect(healthyBefore).toBeDefined();
    const terminalReceipt = yield* awaitSharedEvent(
      harness.provider,
      (event) =>
        event.type === "session.exited" &&
        event.threadId === MAIN_THREAD_ID &&
        event.providerInstanceId === MAIN_INSTANCE,
    );
    const replacement = yield* harness.mutator
      .reconcile({
        [MAIN_INSTANCE]: {
          driver: OPENCODE,
          enabled: true,
          config: { marker: "replacement" },
        },
        [HEALTHY_INSTANCE]: {
          driver: OPENCODE,
          enabled: true,
          config: { marker: "healthy" },
        },
      })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(harness.main.cleanupStarted);
    expect(replacement.pollUnsafe()).toBeUndefined();
    expect(Option.isNone(yield* Deferred.poll(harness.main.cleanupRelease))).toBe(true);
    yield* Deferred.succeed(harness.main.cleanupRelease, undefined);
    yield* Fiber.join(replacement);
    yield* assertInterruptedSnapshot({
      harness,
      threadId: MAIN_THREAD_ID,
      turnId: initial.turnId,
      messageId: initial.messageId,
      prompt: "Start the main work",
    });
    yield* Fiber.join(terminalReceipt);
    const replacementHandle = harness.state.current.get(MAIN_INSTANCE);
    if (replacementHandle === undefined || replacementHandle === harness.main) {
      return yield* Effect.die("the OpenCode replacement was not materialized");
    }
    yield* Deferred.await(replacementHandle.streamSubscribed);
    yield* harness.provider.startSession(MAIN_THREAD_ID, {
      threadId: MAIN_THREAD_ID,
      provider: OPENCODE,
      providerInstanceId: MAIN_INSTANCE,
      runtimeMode: "full-access",
      modelSelection: { instanceId: MAIN_INSTANCE, model: "fake-model" },
    });
    const replacementTurn = yield* startTurn({
      harness,
      handle: replacementHandle,
      instanceId: MAIN_INSTANCE,
      threadId: MAIN_THREAD_ID,
      messageId: MessageId.make("replacement-user-message"),
      eventPrefix: "main-replacement",
      prompt: "Continue after replacement",
    });
    const mainAfterReplacement = yield* readThread(harness, MAIN_THREAD_ID);
    expect(mainAfterReplacement?.session).toMatchObject({
      status: "running",
      activeTurnId: replacementTurn.turnId,
    });
    expect(mainAfterReplacement?.latestTurn).toMatchObject({
      turnId: replacementTurn.turnId,
      state: "running",
      completedAt: null,
    });
    expect(mainAfterReplacement?.messages).toContainEqual(
      expect.objectContaining({
        id: initial.messageId,
        text: "Start the main work",
      }),
    );
    expect(mainAfterReplacement?.messages).toContainEqual(
      expect.objectContaining({
        turnId: initial.turnId,
        text: "partial answer",
        streaming: false,
      }),
    );
    expect(mainAfterReplacement?.messages).toContainEqual(
      expect.objectContaining({
        id: replacementTurn.messageId,
        role: "user",
        text: "Continue after replacement",
      }),
    );
    const healthyAfter = yield* readThread(harness, HEALTHY_THREAD_ID);
    expect(healthyAfter).toEqual(healthyBefore);
    expect(healthyAfter?.session).toMatchObject({
      status: "running",
      activeTurnId: healthyTurn.turnId,
    });
    expect(replacementHandle.allExitEvents).toHaveLength(0);
    expect(yield* replacementHandle.adapter.listSessions()).toHaveLength(1);
    expect(Option.isSome(yield* Deferred.poll(harness.main.streamEnded))).toBe(true);
    return;
  }

  const terminalReceipt = yield* awaitSharedEvent(
    harness.provider,
    (event) =>
      event.type === "session.exited" &&
      event.threadId === MAIN_THREAD_ID &&
      event.providerInstanceId === MAIN_INSTANCE,
  );
  const action = (() => {
    switch (scenario) {
      case "provider.stopSession":
        return harness.provider.stopSession({ threadId: MAIN_THREAD_ID });
      case "registry removal":
        return harness.mutator.reconcile({
          [HEALTHY_INSTANCE]: {
            driver: OPENCODE,
            enabled: true,
            config: { marker: "healthy" },
          },
        });
      case "child scope close":
        return Scope.close(harness.main.scope, Exit.void);
      case "provider.stopAll":
        return harness.provider.stopAll();
      case "server runtime shutdown":
        return Effect.gen(function* () {
          const commandGate = yield* makeCommandGate;
          yield* shutdownServerRuntime({
            commandGate,
            shutdownError: new ServerRuntimeStartupError({
              mode: "web",
              host: null,
              port: 0,
              cause: new Error("lifecycle delivery test shutdown"),
            }),
            reactorScope: harness.reactorScope,
            stopProviders: harness.provider.stopAll(),
            drainIngestion: harness.ingestion.drain,
          });
        });
    }
  })();
  const operation = yield* action.pipe(Effect.forkChild({ startImmediately: true }));
  yield* Deferred.await(harness.main.cleanupStarted);
  expect(operation.pollUnsafe()).toBeUndefined();
  expect(Option.isNone(yield* Deferred.poll(harness.main.cleanupRelease))).toBe(true);
  yield* Deferred.succeed(harness.main.cleanupRelease, undefined);
  yield* Fiber.join(operation);
  if (scenario === "child scope close") {
    yield* Fiber.join(terminalReceipt);
  }
  if (scenario === "registry removal") {
    expect(Option.isSome(yield* Deferred.poll(harness.main.streamEnded))).toBe(true);
  }
  if (scenario === "server runtime shutdown") {
    expect(Option.isSome(yield* Deferred.poll(harness.reactorClosed))).toBe(true);
  }
  yield* assertInterruptedSnapshot({
    harness,
    threadId: MAIN_THREAD_ID,
    turnId: initial.turnId,
    messageId: initial.messageId,
    prompt: "Start the main work",
  });
  if (scenario !== "child scope close") {
    yield* Fiber.join(terminalReceipt);
  }
  expect(harness.main.allExitEvents).toHaveLength(1);
  expect(yield* harness.main.adapter.listSessions()).toHaveLength(0);
  const followupMessageId = MessageId.make(`${scenario.replaceAll(" ", "-")}-followup-message`);
  yield* harness.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`${scenario.replaceAll(" ", "-")}-followup-request`),
    threadId: MAIN_THREAD_ID,
    message: {
      messageId: followupMessageId,
      role: "user",
      text: "Follow up after the lifecycle boundary",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: CREATED_AT,
  });
  const afterFollowup = yield* readThread(harness, MAIN_THREAD_ID);
  expect(afterFollowup?.messages).toContainEqual(
    expect.objectContaining({
      id: followupMessageId,
      role: "user",
      text: "Follow up after the lifecycle boundary",
    }),
  );
  if (scenario === "provider.stopAll") {
    expect(harness.main.stopAllCalls.value).toBe(1);
    expect(Option.isNone(yield* Deferred.poll(harness.main.streamEnded))).toBe(true);
    yield* harness.provider.stopAll();
  }
});

describe("integrated provider lifecycle delivery", () => {
  it.effect.each(scenarios)("preserves delivery across %s", (scenario) => {
    const fixture = makeFixture();
    const program = Effect.gen(function* () {
      const harness = yield* makeHarness(fixture.state);
      yield* runScenario(harness, scenario).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Effect.forEach(fixture.state.all, (handle) =>
              Deferred.succeed(handle.cleanupRelease, undefined).pipe(Effect.asVoid),
            );
            const commandGate = yield* makeCommandGate;
            yield* shutdownServerRuntime({
              commandGate,
              shutdownError: new ServerRuntimeStartupError({
                mode: "web",
                host: null,
                port: 0,
                cause: new Error("provider lifecycle delivery test teardown"),
              }),
              reactorScope: harness.reactorScope,
              stopProviders: harness.provider.stopAll(),
              drainIngestion: harness.ingestion.drain,
            });
          }),
        ),
      );
    }).pipe(
      Effect.ensuring(
        Effect.forEach(fixture.state.all, (handle) =>
          Deferred.succeed(handle.cleanupRelease, undefined).pipe(Effect.asVoid),
        ),
      ),
      Effect.provide(fixture.layer),
    );
    return Effect.scoped(program);
  });

  it.effect("keeps the reactor open until native stop and ingestion drain finish", () => {
    const fixture = makeFixture();
    const program = Effect.gen(function* () {
      const harness = yield* makeHarness(fixture.state);
      yield* harness.provider.startSession(MAIN_THREAD_ID, {
        threadId: MAIN_THREAD_ID,
        provider: OPENCODE,
        providerInstanceId: MAIN_INSTANCE,
        runtimeMode: "full-access",
        modelSelection: { instanceId: MAIN_INSTANCE, model: "fake-model" },
      });
      const initial = yield* startTurn({
        harness,
        handle: harness.main,
        instanceId: MAIN_INSTANCE,
        threadId: MAIN_THREAD_ID,
        messageId: MessageId.make("shutdown-deadline-user-message"),
        eventPrefix: "shutdown-deadline-initial",
        prompt: "Preserve this partial work during shutdown",
      });
      const terminalReceipt = yield* awaitSharedEvent(
        harness.provider,
        (event) =>
          event.type === "session.exited" &&
          event.threadId === MAIN_THREAD_ID &&
          event.providerInstanceId === MAIN_INSTANCE,
      );

      yield* Effect.forEach(fixture.state.all, (handle) =>
        Deferred.succeed(handle.cleanupRelease, undefined).pipe(Effect.asVoid),
      );
      const shutdownRegression = fixture.state.shutdownRegression;
      shutdownRegression.enabled.value = true;
      const commandGate = yield* makeCommandGate;
      const shutdownFiber = yield* shutdownServerRuntime({
        commandGate,
        shutdownError: new ServerRuntimeStartupError({
          mode: "web",
          host: null,
          port: 0,
          cause: new Error("provider lifecycle shutdown deadline test"),
        }),
        reactorScope: harness.reactorScope,
        stopProviders: harness.provider.stopAll(),
        drainIngestion: harness.ingestion.drain,
      }).pipe(Effect.forkChild({ startImmediately: true }));

      for (const gate of shutdownRegression.metadata) {
        yield* Deferred.await(gate.entered);
        yield* TestClock.adjust("1.9 seconds");
        yield* Deferred.succeed(gate.release, undefined);
      }
      yield* Deferred.await(shutdownRegression.native.entered);

      yield* TestClock.adjust("7.4 seconds");
      expect(harness.reactorScope.state._tag).toBe("Open");

      yield* TestClock.adjust("600 millis");
      yield* Deferred.succeed(shutdownRegression.native.release, undefined);
      yield* Deferred.await(shutdownRegression.native.completed);
      yield* Fiber.join(terminalReceipt);
      yield* harness.ingestion.drain;

      expect(harness.reactorScope.state._tag).toBe("Open");
      yield* assertInterruptedSnapshot({
        harness,
        threadId: MAIN_THREAD_ID,
        turnId: initial.turnId,
        messageId: initial.messageId,
        prompt: "Preserve this partial work during shutdown",
      });
      const terminalSnapshot = yield* readThread(harness, MAIN_THREAD_ID);
      expect(terminalSnapshot?.session).toMatchObject({
        status: "stopped",
        activeTurnId: null,
      });

      yield* Fiber.join(shutdownFiber);
      expect(harness.reactorScope.state._tag).toBe("Closed");
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.forEach(fixture.state.all, (handle) =>
            Deferred.succeed(handle.cleanupRelease, undefined).pipe(Effect.asVoid),
          );
          yield* releaseShutdownGates(fixture.state.shutdownRegression);
        }),
      ),
      Effect.provide(fixture.layer),
    );
    return Effect.scoped(program).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("restores a ready session after unsupported compaction", () => {
    const fixture = makeFixture({ withCommandReactor: true });
    const program = Effect.gen(function* () {
      const harness = yield* makeHarness(fixture.state);
      const commandReactor = harness.commandReactor;
      if (commandReactor === undefined) {
        return yield* Effect.die("command reactor is not enabled for this fixture");
      }
      yield* Effect.gen(function* () {
        const seeded = yield* seedCompletedConversation(harness);
        yield* commandReactor.start().pipe(Scope.provide(harness.reactorScope));

        yield* runCompactFailure({
          harness,
          commandPrefix: "unsupported-compaction-first",
          expectedDetail: "does not support context compaction",
        });
        const afterFirstFailure = yield* readThread(harness, MAIN_THREAD_ID);
        expect(afterFirstFailure?.session).toMatchObject({ status: "ready", activeTurnId: null });
        expect(afterFirstFailure?.messages).toContainEqual(
          expect.objectContaining({
            id: seeded.messageId,
            text: "Keep this conversation history",
          }),
        );
        expect(afterFirstFailure?.messages).toContainEqual(
          expect.objectContaining({ turnId: seeded.turnId, text: "partial answer" }),
        );

        yield* runCompactFailure({
          harness,
          commandPrefix: "unsupported-compaction-retry",
          expectedDetail: "does not support context compaction",
        });
        const afterRetry = yield* readThread(harness, MAIN_THREAD_ID);
        expect(afterRetry?.session).toMatchObject({ status: "ready", activeTurnId: null });
        expect(afterRetry?.messages).toContainEqual(
          expect.objectContaining({ turnId: seeded.turnId, text: "partial answer" }),
        );
        expect(afterRetry?.messages).toContainEqual(
          expect.objectContaining({
            id: seeded.messageId,
            role: "user",
            text: "Keep this conversation history",
          }),
        );
      }).pipe(Effect.ensuring(shutdownHarness(fixture, harness)));
    }).pipe(Effect.provide(fixture.layer));
    return Effect.scoped(program);
  });

  it.effect("quarantines native compaction after its completion timeout", () => {
    const nativeCompaction: NativeCompactionControl = {
      entered: Deferred.makeUnsafe<void>(),
      startCalls: { value: 0 },
    };
    const fixture = makeFixture({ withCommandReactor: true, nativeCompaction });
    const program = Effect.gen(function* () {
      const harness = yield* makeHarness(fixture.state);
      const commandReactor = harness.commandReactor;
      if (commandReactor === undefined) {
        return yield* Effect.die("command reactor is not enabled for this fixture");
      }
      yield* Effect.gen(function* () {
        const seeded = yield* seedCompletedConversation(harness);
        yield* commandReactor.start().pipe(Scope.provide(harness.reactorScope));

        const failureReceipt = yield* awaitProviderFailureActivity(harness.engine, MAIN_THREAD_ID);
        const startingReceipt = yield* awaitProviderSessionStatus(
          harness.engine,
          MAIN_THREAD_ID,
          "starting",
        );
        const readyReceipt = yield* awaitProviderSessionStatus(
          harness.engine,
          MAIN_THREAD_ID,
          "ready",
        );
        yield* dispatchCompactCommand(harness, "native-compaction-timeout-first");

        const starting = yield* Fiber.join(startingReceipt);
        expect(Option.isSome(starting)).toBe(true);
        if (Option.isSome(starting)) {
          expect(starting.value.payload.session).toMatchObject({
            status: "starting",
            activeTurnId: null,
          });
        }
        yield* Deferred.await(nativeCompaction.entered);
        yield* TestClock.adjust("600001 millis").pipe(Effect.andThen(Effect.yieldNow));

        const ready = yield* Fiber.join(readyReceipt);
        expect(Option.isSome(ready)).toBe(true);
        if (Option.isSome(ready)) {
          expect(ready.value.payload.session).toMatchObject({
            status: "ready",
            activeTurnId: null,
          });
        }
        const failure = yield* Fiber.join(failureReceipt);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value.payload.activity.payload).toEqual(
            expect.objectContaining({
              detail: expect.stringContaining("did not report completed context compaction"),
            }),
          );
        }
        yield* commandReactor.drain;
        expect(nativeCompaction.startCalls.value).toBe(1);
        expect(yield* harness.queuedTurnStarts.list()).toHaveLength(0);

        const afterTimeout = yield* readThread(harness, MAIN_THREAD_ID);
        expect(afterTimeout?.session).toMatchObject({ status: "ready", activeTurnId: null });
        expect(afterTimeout?.messages).toContainEqual(
          expect.objectContaining({
            id: seeded.messageId,
            role: "user",
            text: "Keep this conversation history",
          }),
        );
        expect(afterTimeout?.messages).toContainEqual(
          expect.objectContaining({ turnId: seeded.turnId, text: "partial answer" }),
        );

        yield* runCompactFailure({
          harness,
          commandPrefix: "native-compaction-timeout-retry",
          expectedDetail: "previous context compaction may still be running",
        });
        expect(nativeCompaction.startCalls.value).toBe(1);
        const afterRetry = yield* readThread(harness, MAIN_THREAD_ID);
        expect(afterRetry?.session).toMatchObject({ status: "ready", activeTurnId: null });
        expect(afterRetry?.messages).toContainEqual(
          expect.objectContaining({ turnId: seeded.turnId, text: "partial answer" }),
        );
      }).pipe(Effect.ensuring(shutdownHarness(fixture, harness)));
    }).pipe(Effect.provide(fixture.layer));
    return Effect.scoped(program).pipe(Effect.provide(TestClock.layer()));
  });
});
