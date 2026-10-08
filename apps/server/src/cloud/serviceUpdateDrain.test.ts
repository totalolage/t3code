import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ServiceUpdateAdmission from "../orchestration-v2/ServiceUpdateAdmission.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { ServiceUpdateDrainLive } from "./serviceUpdateDrain.ts";
import { ServiceUpdateDrain, ServiceUpdateOperationError } from "./serviceUpdateServices.ts";
const emptyRegistry = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: (instanceId) =>
      Effect.fail(new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId })),
    list: () => Effect.succeed([]),
  }),
);
const isSqlTemplateStrings = (value: unknown): value is TemplateStringsArray => {
  if (!Array.isArray(value) || !value.every(Predicate.isString)) return false;
  const raw = Reflect.get(value, "raw");
  return Array.isArray(raw) && raw.length === value.length && raw.every(Predicate.isString);
};
type ReplayLayer<RegistryError> = ReturnType<
  typeof ProviderReplayHarness.layerWithRegistry<RegistryError>
>;
const replayDatabaseLayer = SqlitePersistence.layerMemory.pipe(Layer.orDie);
const makeReplayLayer = <RegistryError>(
  scenario: { readonly name: string },
  registryLayer: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2, RegistryError>,
) =>
  Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(scenario, registryLayer, {
      databaseLayer: replayDatabaseLayer,
      runEffectWorker: false,
    }),
    EffectOutbox.layer.pipe(Layer.provide(replayDatabaseLayer)),
    ProjectStore.layer.pipe(Layer.provide(replayDatabaseLayer)),
    replayDatabaseLayer,
  );
const replayLayer = makeReplayLayer({ name: "service-update-drain" }, emptyRegistry);

const processStart = (name: string) => ({
  id: `effect:${name}`,
  commandId: CommandId.make(`command:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
  request: {
    type: "provider-turn.start" as const,
    runId: RunId.make(`run:${name}`),
  },
});

const providerInstanceId = ProviderInstanceId.make("codex");
const providerDriver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" } as const;
const queuedRunRegistry = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: () =>
      Effect.succeed({
        instanceId: providerInstanceId,
        driver: providerDriver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: () => Effect.die("The interruption recovery test must not open a session."),
      } satisfies ProviderAdapter.ProviderAdapterV2Shape),
    list: () => Effect.succeed([providerInstanceId]),
  }),
);
const queuedReplayLayer = makeReplayLayer(
  { name: "service-update-drain-interrupted-marker" },
  queuedRunRegistry,
);

const preparationProject = {
  id: ProjectId.make("project:service-update-drain"),
  title: "Drain preparation",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: modelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

const makeThreadLaunchLayer = (
  coreLayer: ReplayLayer<ProviderAdapterRegistry.ProviderAdapterRegistryLookupError>,
  runForThread: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"] = () =>
    Effect.succeed({ status: "no-script" as const }),
) => {
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(coreLayer));
  const dependencies = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
      get: () => Effect.succeed(null),
    }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(ProjectService.ProjectService)({
      getById: (projectId) =>
        Effect.succeed(
          projectId === preparationProject.id ? Option.some(preparationProject) : Option.none(),
        ),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, { runForThread }),
    Layer.mock(TextGeneration.TextGeneration)({}),
    ServerSettings.layerTest(),
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const receiptStore = CommandReceiptStore.layer.pipe(Layer.provide(coreLayer));
  const launchLayer = ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(dependencies, threadManagement, receiptStore, IdAllocator.layer, coreLayer),
    ),
  );
  return launchLayer;
};

const makeObservedPreparationLayer = (
  coreLayer: ReplayLayer<ProviderAdapterRegistry.ProviderAdapterRegistryLookupError>,
  expectedFiberId: Ref.Ref<number | undefined>,
  observed: Deferred.Deferred<ReadonlyArray<ThreadLaunch.ThreadLaunchPreparationActivity>>,
  runForThread: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"],
) => {
  const launchLayer = makeThreadLaunchLayer(coreLayer, runForThread);
  return Layer.effect(
    ThreadLaunch.ThreadLaunchService,
    Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const observePreparations: ThreadLaunch.ThreadLaunchService["Service"]["observePreparations"] =
        Effect.gen(function* () {
          const observation = yield* launches.observePreparations;
          const actualFiberId = yield* Effect.fiberId;
          const expected = yield* Ref.get(expectedFiberId);
          if (expected !== undefined && expected === actualFiberId) {
            yield* Deferred.succeed(observed, observation.active);
          }
          return observation;
        });
      return ThreadLaunch.ThreadLaunchService.of({ ...launches, observePreparations });
    }),
  ).pipe(Layer.provide(launchLayer));
};

const testLayer = ServiceUpdateDrainLive.pipe(
  Layer.provideMerge(Layer.merge(makeThreadLaunchLayer(replayLayer), replayLayer)),
);

it.effect("interrupted queue-marker persistence reopens admission and resumes native work", () =>
  Effect.gen(function* () {
    const markerWriteReached = yield* Deferred.make<void>();
    const keepMarkerWriteOpen = yield* Deferred.make<void>();
    let heldMarkerWrite = false;
    const observedDatabaseLayer = Layer.effect(
      SqlClient.SqlClient,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return new Proxy(sql, {
          apply(target, thisArg, args) {
            const template = args[0];
            if (typeof template === "string") return target(template);
            if (!isSqlTemplateStrings(template)) return Reflect.apply(target, thisArg, args);
            const query = template.join("");
            const queryEffect = target(template, ...args.slice(1));
            if (
              !heldMarkerWrite &&
              query.includes("UPDATE orchestration_v2_projection_runs") &&
              query.includes("service_update_resume_after_update = 1")
            ) {
              heldMarkerWrite = true;
              return Effect.flatMap(queryEffect, (rows) =>
                Deferred.succeed(markerWriteReached, undefined).pipe(
                  Effect.andThen(Deferred.await(keepMarkerWriteOpen)),
                  Effect.as(rows),
                ),
              );
            }
            return queryEffect;
          },
        });
      }),
    ).pipe(Layer.provideMerge(queuedReplayLayer));
    const layer = ServiceUpdateDrainLive.pipe(
      Layer.provideMerge(
        Layer.merge(makeThreadLaunchLayer(queuedReplayLayer), observedDatabaseLayer),
      ),
    );

    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      const drain = yield* ServiceUpdateDrain;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("service-update-drain-marker-project");
      const threadId = ThreadId.make("service-update-drain-marker-thread");
      const commandId = CommandId.make("service-update-drain-marker-message");
      const messageId = MessageId.make("service-update-drain-marker-message");
      const now = DateTime.formatIso(yield* DateTime.now);

      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make("service-update-drain-marker-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Updater admission marker recovery",
          workspaceRoot: "/work/service-update-drain-marker",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("service-update-drain-marker-thread-created"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Updater admission marker recovery",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      yield* admission.setState("draining");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId,
        text: "Resume this queued run if the updater is cancelled before acquiring its lease.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
      assert.isDefined(queued);
      if (queued === undefined) return yield* Effect.die("The native queued run was not created.");
      assert.equal(queued.status, "queued");
      assert.isEmpty(yield* outbox.listByCommandId(commandId));
      yield* admission.setState("open");

      const acquire = yield* Effect.forkChild(drain.acquire, { startImmediately: true });
      yield* Deferred.await(markerWriteReached);
      yield* Fiber.interrupt(acquire);
      assert.equal((yield* Fiber.await(acquire))._tag, "Failure");
      assert.isFalse(yield* admission.withAdmission((closed) => Effect.succeed(closed)));

      const resumed = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
      assert.isDefined(resumed);
      assert.equal(resumed?.status, "starting");
      const [marker] = yield* sql<{ readonly marked: number }>`
      SELECT service_update_resume_after_update AS marked
      FROM orchestration_v2_projection_runs WHERE run_id = ${queued.id}
      `;
      assert.equal(marker?.marked, 0);
      assert.isTrue(
        (yield* outbox.listByCommandId(
          CommandId.make(`command:system:start-queued:${queued.id}`),
        )).some((entry) => entry.request.type === "provider-turn.start"),
      );

      const retry = yield* drain.acquire;
      assert.isTrue(yield* admission.withAdmission((closed) => Effect.succeed(closed)));
      yield* retry.cancel;
      assert.isFalse(yield* admission.withAdmission((closed) => Effect.succeed(closed)));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("drain rejects an orphaned running outbox claim", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const drain = yield* ServiceUpdateDrain;
    const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
    yield* outbox.enqueue([processStart("lost-owner")]);
    const claim = yield* outbox.claimNext({ workerId: "lost-owner", leaseDurationMs: 60_000 });
    assert.isTrue(Option.isSome(claim), "the native outbox should persist the claim");

    const lease = yield* drain.acquire;
    const failure = yield* lease.withQuiescence(() => Effect.succeed(undefined)).pipe(Effect.flip);
    assert.instanceOf(failure, ServiceUpdateOperationError);
    assert.equal(failure.code, "unavailable");
    yield* lease.cancel;
    assert.isFalse(yield* admission.withAdmission((closed) => Effect.succeed(closed)));
  }).pipe(Effect.provide(testLayer)),
);

it.effect("native drain waits for message-free ThreadLaunch preparation before sealing", () =>
  Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const setupCompletion = yield* Deferred.make<{
      readonly exitCode: number | null;
      readonly durationMs: number;
    }>();
    const finalPassPreparation =
      yield* Deferred.make<ReadonlyArray<ThreadLaunch.ThreadLaunchPreparationActivity>>();
    const finalPassFiberId = yield* Ref.make<number | undefined>(undefined);
    const callbackEntered = yield* Deferred.make<void>();
    const commandId = CommandId.make("command:drain-message-free-preparation");
    const coreLayer = makeReplayLayer(
      { name: "service-update-drain-message-free-preparation" },
      emptyRegistry,
    );
    const preparationLayer = ServiceUpdateDrainLive.pipe(
      Layer.provideMerge(
        Layer.merge(
          coreLayer,
          makeObservedPreparationLayer(coreLayer, finalPassFiberId, finalPassPreparation, () =>
            Effect.succeed({
              status: "started" as const,
              async: true,
              scriptId: "setup",
              scriptName: "Setup",
              scriptCommand: "vp install",
              terminalId: "setup",
              cwd: "/repo",
              completion: Deferred.await(setupCompletion),
            }).pipe(Effect.tap(() => Deferred.succeed(setupEntered, undefined))),
          ),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const drain = yield* ServiceUpdateDrain;
      const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      const launched = yield* launches.launch({
        commandId,
        threadId: ThreadId.make("thread:drain-message-free-preparation"),
        projectId: preparationProject.id,
        title: "Native preparation during service handoff",
        generateTitle: false,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(launched.projection.messages.length, 0);
      assert.equal(launched.projection.runs.length, 0);
      yield* Deferred.await(setupEntered);

      const preparationObservation = yield* launches.observePreparations;
      const preparation = preparationObservation.active.find(
        (activity) => activity.commandId === commandId && activity.kind === "preparation",
      );
      assert.isDefined(preparation);
      assert.equal(preparation.runId, null);
      assert.isEmpty(yield* outbox.listByCommandId(commandId));

      const lease = yield* drain.acquire;
      const observation = Option.getOrThrow(yield* Stream.runHead(lease.observations));
      assert.equal(observation.startingOperations, 1);

      const handoff = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Ref.set(finalPassFiberId, yield* Effect.fiberId);
          return yield* lease.withQuiescence((setAdmissionState) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(callbackEntered, undefined);
              const settled = yield* launches.observePreparations;
              assert.isFalse(settled.active.some((activity) => activity.id === preparation.id));
              yield* setAdmissionState("sealed");
              return "sealed" as const;
            }),
          );
        }),
        { startImmediately: true },
      );

      const observedPreparation = yield* Deferred.await(finalPassPreparation);
      assert.isTrue(
        observedPreparation.some(
          (activity) => activity.id === preparation.id && activity.runId === null,
        ),
        "the Drain wait observes the actual message-free preparation owner",
      );
      assert.isFalse(
        yield* Deferred.isDone(callbackEntered),
        "the handoff callback remains unavailable while preparation is active",
      );
      assert.isTrue(yield* admission.withAdmission((closed) => Effect.succeed(closed)));

      yield* Deferred.succeed(setupCompletion, { exitCode: 0, durationMs: 1 });
      yield* launches.awaitPreparation(commandId);
      assert.equal(yield* Fiber.join(handoff), "sealed");
      assert.isTrue(yield* Deferred.isDone(callbackEntered));
      yield* lease.cancel;
      assert.isFalse(yield* admission.withAdmission((closed) => Effect.succeed(closed)));
    }).pipe(Effect.provide(preparationLayer));
  }),
);
