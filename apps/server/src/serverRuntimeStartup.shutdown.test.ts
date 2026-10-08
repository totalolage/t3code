import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import { afterEach, expect, vi } from "vite-plus/test";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "./orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ServiceUpdateAdmission from "./orchestration-v2/ServiceUpdateAdmission.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { layerWithRegistry } from "./orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";

const workerProbe = vi.hoisted(() => ({
  onStart: null as (() => import("effect/Effect").Effect<void>) | null,
  onExit: null as
    | ((exit: import("effect/Exit").Exit<void, never>) => import("effect/Effect").Effect<void>)
    | null,
}));

// Observe the actual daemon's lifetime while delegating its unchanged Effect.
vi.mock("./orchestration-v2/EffectWorker.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orchestration-v2/EffectWorker.ts")>();
  const Effect = await import("effect/Effect");
  const runDaemon = Effect.gen(function* () {
    const onStart = workerProbe.onStart;
    if (onStart !== null) yield* onStart();
    return yield* actual.runDaemon;
  }).pipe(
    Effect.onExit((exit) => {
      const onExit = workerProbe.onExit;
      return onExit === null ? Effect.void : onExit(exit);
    }),
  );
  return { ...actual, runDaemon };
});

afterEach(() => {
  workerProbe.onStart = null;
  workerProbe.onExit = null;
});

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;
const driver = ProviderDriverKind.make("codex");

const makeShutdownAdapter = (
  closed: Deferred.Deferred<void>,
  recordClose: Effect.Effect<void>,
  onTurnStart: () => Effect.Effect<void> = () => Effect.void,
) => {
  const adapter: ProviderAdapter.ProviderAdapterV2Shape = {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(closed, undefined).pipe(Effect.andThen(recordClose)),
        );
        const providerSession = {
          id: input.providerSessionId,
          driver,
          providerInstanceId: input.modelSelection.instanceId,
          status: "ready" as const,
          cwd: input.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const providerThreadId = ProviderThreadId.make("provider-thread-shutdown");
        const providerThread = {
          id: providerThreadId,
          driver,
          providerInstanceId: input.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: input.threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver,
            nativeId: input.initialNativeThreadId ?? "native-shutdown-thread",
            strength: "strong" as const,
          },
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        return {
          instanceId: input.modelSelection.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ensureThread: () => Effect.succeed(providerThread),
          resumeThread: () => Effect.succeed(providerThread),
          startTurn: () => onTurnStart(),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die(new Error("unused in shutdown fixture")),
          rollbackThread: () => Effect.die(new Error("unused in shutdown fixture")),
          forkThread: () => Effect.die(new Error("unused in shutdown fixture")),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  return adapter;
};

const recoverySummary: ProviderRuntimeRecovery.ProviderRuntimeRecoverySummary = {
  terminalizedRuns: 0,
  stoppedSessions: 0,
  closedRequests: 0,
  retiredEffects: 0,
  requeuedEffects: 0,
};

const makeStartupDependencies = (input: {
  readonly core: Context.Context<
    | Orchestrator.OrchestratorV2
    | ServiceUpdateAdmission.ServiceUpdateAdmission
    | EffectWorker.OrchestrationEffectWorkerV2
    | ProviderSessionManager.ProviderSessionManagerV2
    | ProjectStore.ProjectStoreV2
  >;
  readonly recovery: ProviderRuntimeRecovery.ProviderRuntimeRecoveryService["Service"];
  readonly baseDir?: string;
}) => {
  const layers = [
    Layer.succeed(
      Orchestrator.OrchestratorV2,
      Context.get(input.core, Orchestrator.OrchestratorV2),
    ),
    Layer.succeed(
      ServiceUpdateAdmission.ServiceUpdateAdmission,
      Context.get(input.core, ServiceUpdateAdmission.ServiceUpdateAdmission),
    ),
    Layer.succeed(
      EffectWorker.OrchestrationEffectWorkerV2,
      Context.get(input.core, EffectWorker.OrchestrationEffectWorkerV2),
    ),
    Layer.succeed(
      ProviderSessionManager.ProviderSessionManagerV2,
      Context.get(input.core, ProviderSessionManager.ProviderSessionManagerV2),
    ),
    Layer.succeed(
      ProjectStore.ProjectStoreV2,
      Context.get(input.core, ProjectStore.ProjectStoreV2),
    ),
    ServerConfig.layerTest(
      process.cwd(),
      input.baseDir ?? { prefix: "t3-startup-shutdown-native-" },
    ).pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.make({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
        serve: () => Effect.void,
      }),
    ),
    NodeCrypto.layer,
    Layer.succeed(Keybindings.Keybindings, { start: Effect.void } as never),
    ServerSettings.layerTest(),
    ServerLifecycleEvents.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-startup-shutdown")),
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("environment-startup-shutdown"),
        label: "Startup shutdown test",
        version: "test",
        platform: { os: "linux", arch: "x64" },
        capabilities: {},
      } as never),
    }),
    Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
      issueStartupPairingUrl: (baseUrl: string) => Effect.succeed(`${baseUrl}/pair`),
    } as never),
    Layer.succeed(ExternalLauncher.ExternalLauncher, {
      launchBrowser: () => Effect.void,
    } as never),
    Layer.succeed(ServiceLauncherClient.ServiceLauncherClient, {
      managed: false,
      requestUpdate: () => Effect.die("unused"),
      prepareTrial: Effect.succeed(undefined),
    }),
    Layer.succeed(ThreadLaunch.ThreadLaunchService, {
      launch: () => Effect.die("unused ThreadLaunchService.launch"),
      retryPreparation: () => Effect.die("unused ThreadLaunchService.retryPreparation"),
      observePreparations: Effect.succeed({ active: [], changes: Stream.empty }),
      awaitPreparation: () => Effect.void,
    }),
    Layer.succeed(LegacyV1ThreadImporter.LegacyV1ThreadImporter, {
      pendingThreadCount: Effect.succeed(0),
      reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
      ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
      importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    }),
    Layer.succeed(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService, input.recovery),
    Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
      publishThread: () => Effect.void,
      drain: Effect.void,
      requestCatchUp: () => Effect.void,
      start: () => Effect.void,
    } as never),
    AnalyticsService.AnalyticsService.layerTest,
    Layer.succeed(GitVcsDriver.GitVcsDriver, {} as never),
    Layer.succeed(ProjectService.ProjectService, {
      snapshot: Effect.succeed({ projects: [] }),
    } as never),
    Layer.succeed(ThreadManagement.ThreadManagementService, {
      getShellSnapshot: () => Effect.succeed({ threads: [], archivedThreads: [] }),
    } as never),
  ] as const;
  return Layer.mergeAll(...layers);
};

const runShutdownScenario = (failPrepareForShutdown: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (value: string) => Ref.update(order, (current) => [...current, value]);
      const workerStarted = yield* Deferred.make<void>();
      const workerExited = yield* Deferred.make<Exit.Exit<void, never>>();
      const sessionClosed = yield* Deferred.make<void>();
      const prepareFailure = new Error("recovery preparation failed");
      workerProbe.onStart = () => Deferred.succeed(workerStarted, undefined);
      workerProbe.onExit = (exit) =>
        record("worker.exited").pipe(Effect.andThen(Deferred.succeed(workerExited, exit)));

      const coreScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const coreLayer = layerWithRegistry(
        { name: "server-runtime-startup-shutdown" },
        ProviderAdapterRegistry.layerFromAdapters([
          makeShutdownAdapter(sessionClosed, record("session.closed")),
        ]),
        { runEffectWorker: false },
      );
      const core = yield* Layer.buildWithScope(coreLayer, coreScope);

      const recovery = {
        recover: Effect.succeed(recoverySummary),
        prepareForShutdown: record("recovery.prepare").pipe(
          Effect.andThen(failPrepareForShutdown ? Effect.die(prepareFailure) : Effect.void),
        ),
        reconcile: (trigger: "startup" | "shutdown") =>
          record(`recovery.reconcile:${trigger}`).pipe(Effect.as(recoverySummary)),
      } satisfies ProviderRuntimeRecovery.ProviderRuntimeRecoveryService["Service"];
      const startupScope = yield* Effect.acquireRelease(Scope.make("sequential"), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const startupLayer = ServerRuntimeStartup.layerWithOptions().pipe(
        Layer.provideMerge(makeStartupDependencies({ core, recovery })),
      );
      const startupContext = yield* Layer.buildWithScope(startupLayer, startupScope);
      const startup = Context.get(startupContext, ServerRuntimeStartup.ServerRuntimeStartup);
      const orchestrator = Context.get(core, Orchestrator.OrchestratorV2);
      const manager = Context.get(core, ProviderSessionManager.ProviderSessionManagerV2);

      yield* startup.markHttpListening;
      yield* startup.awaitCommandReady;
      yield* Deferred.await(workerStarted);

      const threadId = ThreadId.make("shutdown-native-thread");
      const projectId = ProjectId.make("shutdown-native-project");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("shutdown-native-thread-create"),
        threadId,
        projectId,
        title: "Shutdown test thread",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const providerSessionId = ProviderSessionId.make("shutdown-native-session");
      yield* manager.open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        },
      });
      expect(Option.isSome(yield* manager.get(providerSessionId))).toBe(true);

      yield* Scope.close(startupScope, Exit.void);
      expect(yield* Deferred.isDone(workerExited)).toBe(true);
      expect(yield* Deferred.isDone(sessionClosed)).toBe(true);
      const daemonExit = yield* Deferred.await(workerExited);
      yield* Deferred.await(sessionClosed);
      const removedSession = yield* manager.get(providerSessionId);

      expect(Exit.isFailure(daemonExit) && Cause.hasInterruptsOnly(daemonExit.cause)).toBe(true);
      expect(Option.isNone(removedSession)).toBe(true);
      const expected = failPrepareForShutdown
        ? ["worker.exited", "recovery.prepare", "session.closed"]
        : ["worker.exited", "recovery.prepare", "session.closed", "recovery.reconcile:shutdown"];
      expect(yield* Ref.get(order)).toEqual(expected);

      // Shutdown has already closed its own scope; the runtime scope remains
      // open until after these assertions so its fallback finalizer cannot
      // mask a missing startup Manager.shutdown call.
      yield* Scope.close(coreScope, Exit.void);
      return yield* Ref.get(order);
    }),
  );

it.effect(
  "shutdown joins the actual worker and closes active provider scopes before reconciliation",
  () =>
    runShutdownScenario(false).pipe(
      Effect.tap((order) =>
        Effect.sync(() => expect(order).toContain("recovery.reconcile:shutdown")),
      ),
    ),
);

it.effect("provider cleanup remains guaranteed when pre-shutdown recovery fails", () =>
  runShutdownScenario(true).pipe(
    Effect.tap((order) =>
      Effect.sync(() => expect(order).not.toContain("recovery.reconcile:shutdown")),
    ),
  ),
);
