// @effect-diagnostics nodeBuiltinImport:off unsafeEffectTypeAssertion:off
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  MessageId,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ServiceUpdateAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

const isServiceUpdateError = Schema.is(ServiceUpdateError);

const isSqlTemplateStrings = (value: unknown): value is TemplateStringsArray => {
  if (!Array.isArray(value) || !value.every(Predicate.isString)) return false;
  const raw = Reflect.get(value, "raw");
  return Array.isArray(raw) && raw.length === value.length && raw.every(Predicate.isString);
};

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ServiceUpdateAdmission from "../orchestration-v2/ServiceUpdateAdmission.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ServiceUpdateDrain,
  ServiceUpdateError,
  type ServiceUpdateDrainObservation,
  ServiceUpdateOperationError,
  ServiceUpdateRuntime,
  ServiceUpdateSource,
  StagedServiceRuntime,
  UpdateAuthority,
  type UpdateAuthorityOwner,
  type UpdateAuthorityLease,
  type ServiceUpdateRuntimeAvailability,
  type ServiceUpdateSourceShape,
  type ServiceUpdateRuntimeShape,
} from "./serviceUpdateServices.ts";
import { ServiceUpdateDrainLive } from "./serviceUpdateDrain.ts";
import type { ServiceUpdateReleaseDescriptor } from "./serviceUpdateRelease.ts";
import { makeServiceUpdateSource, STAGED_ARTIFACT_FILENAME } from "./serviceUpdateSourceLive.ts";
import {
  makePreflightValidate,
  makeServiceUpdateRuntime,
  runtimeInstallPaths,
} from "./serviceUpdateRuntimeLive.ts";
import { resolveInstalledServiceRuntime } from "./serviceRuntime.ts";
import { ServiceLauncherRejectedError } from "./serviceLauncherClient.ts";
import {
  ServiceUpdateAttemptBusyError,
  ServiceUpdateScheduler,
  ServiceUpdateSchedulerLive,
  type ServiceUpdateSchedulerShape,
} from "./serviceUpdateScheduler.ts";
import { makeUpdateAuthority } from "./updateAuthorityLive.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const currentServiceUpdateState = Effect.gen(function* () {
  const events = yield* ServerLifecycleEvents.ServerLifecycleEvents;
  const snapshot = yield* events.snapshot;
  const update = snapshot.events.find((event) => event.type === "serviceUpdate");
  return update?.type === "serviceUpdate" ? update.payload : { status: "idle" as const };
});

const attemptId = ServiceUpdateAttemptId.make("11111111-1111-4111-8111-111111111111");
const PINNED_AT = "2026-01-01T00:00:00.000Z";
const staged: StagedServiceRuntime = {
  format: 1,
  attemptId,
  version: "1.1.0",
  platform: "linux-x64",
  sha256: "a".repeat(64),
  bytes: 1024,
  stagingDirectory: "/tmp/staged",
};
const emptyProviderRegistry = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: (instanceId) =>
      Effect.fail(new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId })),
    list: () => Effect.succeed([]),
  }),
);

const makeNativeDrainLayer = (
  state: Pick<Fakes, "replayCalls">,
  observations: Stream.Stream<ServiceUpdateDrainObservation>,
  waitForQuiescence: () => Effect.Effect<void>,
  afterQuiescence: () => Effect.Effect<void> = () => Effect.void,
) =>
  Layer.effect(
    ServiceUpdateDrain,
    Effect.gen(function* () {
      const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      const orchestrator = yield* Orchestrator.OrchestratorV2;

      return {
        acquire: admission.withExclusive((current, setAdmissionState) =>
          current === "open"
            ? setAdmissionState("draining").pipe(
                Effect.as({
                  observations,
                  cancel: Effect.sync(() => {
                    state.replayCalls += 1;
                  }).pipe(
                    Effect.andThen(setAdmissionState("open")),
                    Effect.andThen(orchestrator.resumeQueuedRuns),
                    Effect.mapError((cause) =>
                      cause instanceof ServiceUpdateOperationError
                        ? cause
                        : new ServiceUpdateOperationError({ stage: "drain", code: "io", cause }),
                    ),
                  ),
                  withQuiescence: (use) =>
                    Effect.gen(function* () {
                      yield* waitForQuiescence();
                      const result = yield* admission.withExclusive((_current, set) => use(set));
                      yield* afterQuiescence();
                      return result;
                    }),
                }),
              )
            : Effect.fail(
                new ServiceUpdateOperationError({
                  stage: "drain",
                  code: "unavailable",
                  cause: new Error("The service update admission gate is already closed."),
                }),
              ),
        ),
      };
    }),
  );

const makeSchedulerDatabaseLayer = (filename: string, afterQueueCount: () => Effect.Effect<void>) =>
  Layer.effect(
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
          if (query.includes(" AS queued") && query.includes("orchestration_v2_effect_outbox")) {
            return Effect.flatMap(queryEffect, (rows) => Effect.as(afterQueueCount(), rows));
          }
          return queryEffect;
        },
      });
    }),
  ).pipe(Layer.provide(NodeSqliteClient.layer({ filename })));

const preparationModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "test-model",
} as const;
const preparationProject = {
  id: ProjectId.make("scheduler-preparation-project"),
  title: "Scheduler preparation",
  workspaceRoot: "/repo",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: preparationModelSelection,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  deletedAt: null,
} satisfies Project;

const makeSchedulerThreadLaunchLayer = (
  coreLayer: ReturnType<
    typeof ProviderReplayHarness.layerWithRegistry<ProviderAdapterRegistry.ProviderAdapterRegistryLookupError>
  >,
  runForThread: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"] = () =>
    Effect.succeed({ status: "no-script" as const }),
) => {
  const threadManagement = ThreadManagement.layer.pipe(Layer.provide(coreLayer));
  const receiptStore = CommandReceiptStore.layer.pipe(Layer.provide(coreLayer));
  const dependencies = Layer.mergeAll(
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
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
    ServerSettingsService.layerTest(),
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  return ThreadLaunch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(dependencies, threadManagement, receiptStore, IdAllocator.layer, coreLayer),
    ),
  );
};

interface Fakes {
  attemptId?: string;
  adoptCalls: number;
  stageCalls: number;
  adoptFails: boolean;
  handoffCalls: number;
  handoffAttempts: number;
  checkCalls: number;
  discardCalls: number;
  discardFails: boolean;
  noCandidate: boolean;
  reserveCalls: number;
  reservationActive: boolean;
  releaseCalls: number;
  replayCalls: number;
  irreversibleCalls: number;
  readonly onAdopt?: (staged: StagedServiceRuntime) => Effect.Effect<void>;
  readonly onCheck?: () => Effect.Effect<void>;
  readonly onHandoff?: () => Effect.Effect<void>;
  readonly order: string[];
  handoffFailure?: "acceptance-unknown" | "rejected-before-acceptance";
  readonly availability: ServiceUpdateRuntimeAvailability;
}

const makeFakes = (
  overrides: Partial<Fakes>,
  baseDir: string,
  sourceOverride?: (baseDir: string, state: Fakes) => ServiceUpdateSourceShape,
  authorityOverride?: UpdateAuthority["Service"],
  runtimeOverride?: ServiceUpdateRuntimeShape,
  drainWait: (state: Fakes) => Effect.Effect<void> = () => Effect.void,
  useNativeDrain = false,
) => {
  const state: Fakes = {
    adoptCalls: 0,
    stageCalls: 0,
    adoptFails: false,
    handoffCalls: 0,
    handoffAttempts: 0,
    checkCalls: 0,
    discardCalls: 0,
    discardFails: false,
    noCandidate: false,
    reserveCalls: 0,
    reservationActive: false,
    releaseCalls: 0,
    replayCalls: 0,
    irreversibleCalls: 0,
    order: [],
    availability: { status: "supported" },
    ...overrides,
  };

  const source = Layer.succeed(
    ServiceUpdateSource,
    sourceOverride?.(baseDir, state) ?? {
      check: () =>
        Effect.sync(() => {
          state.checkCalls += 1;
        }).pipe(
          Effect.andThen(state.onCheck?.() ?? Effect.void),
          Effect.as(state.noCandidate ? null : ({ version: "1.1.0" } as never)),
        ),
      resolveTargetVersion: () =>
        Effect.fail(
          new ServiceUpdateOperationError({
            stage: "source",
            code: "unavailable",
            cause: "unexpected explicit-version lookup",
          }),
        ),
      stage: () =>
        Effect.sync(() => {
          state.stageCalls += 1;
          return staged;
        }),
      discard: () =>
        Effect.sync(() => {
          state.discardCalls += 1;
        }).pipe(
          Effect.andThen(
            state.discardFails
              ? Effect.fail(
                  new ServiceUpdateOperationError({
                    stage: "source",
                    code: "io",
                    cause: "discard failed",
                  }),
                )
              : Effect.void,
          ),
        ),
    },
  );

  const runtime = Layer.succeed(
    ServiceUpdateRuntime,
    runtimeOverride ?? {
      availability: Effect.succeed(state.availability),
      captureSource: ({ fromVersion }) =>
        Effect.succeed({
          databaseIdentity: NodePath.join(baseDir, "db.sqlite"),
          fromVersion,
        }),
      adopt: (adopted) =>
        Effect.sync(() => {
          state.adoptCalls += 1;
          state.order.push("adopt");
        }).pipe(
          Effect.andThen(
            state.adoptFails
              ? Effect.fail(
                  new ServiceUpdateOperationError({
                    stage: "runtime",
                    code: "io",
                    cause: "adoption failed",
                  }),
                )
              : (state.onAdopt?.(adopted) ?? Effect.void),
          ),
        ),
      requestHandoff: () =>
        Effect.gen(function* () {
          state.handoffAttempts += 1;
          state.order.push("handoff");
          yield* state.onHandoff?.() ?? Effect.void;
          if (state.handoffFailure !== undefined) {
            return yield* Effect.fail(
              new ServiceUpdateOperationError({
                stage: "authority",
                code: state.handoffFailure,
                cause: "handoff failed",
              }),
            );
          }
          return yield* Effect.sync(() => {
            state.handoffCalls += 1;
            return { updateId: "native-1" };
          });
        }),
    },
  );

  const drain = useNativeDrain
    ? Layer.empty
    : makeNativeDrainLayer(state, Stream.empty, () => drainWait(state));

  const fakeAuthority: UpdateAuthority["Service"] = {
    reserve: (input) => {
      return Effect.sync(() => {
        state.reserveCalls += 1;
        if (state.reservationActive) return { _tag: "busy" as const };
        state.attemptId = input.attemptId ?? "manual";
        state.reservationActive = true;
        return {
          _tag: "owned",
          lease: {
            owner: "scheduled",
            attemptId: (input.attemptId ?? "manual") as ServiceUpdateAttemptId,
            enterIrreversible: Effect.sync(() => {
              state.irreversibleCalls += 1;
            }),
            release: Effect.sync(() => {
              state.releaseCalls += 1;
              state.reservationActive = false;
              return "released" as const;
            }),
          } satisfies UpdateAuthorityLease,
        };
      });
    },
  };
  const authority = Layer.succeed(UpdateAuthority, authorityOverride ?? fakeAuthority);

  return { state, fakes: Layer.mergeAll(source, runtime, drain, authority) };
};

const makeHarness = (
  overrides: Partial<Fakes> = {},
  options: {
    readonly settings?: ReturnType<typeof ServerSettingsService.layerTest>;
    readonly source?: (baseDir: string, state: Fakes) => ServiceUpdateSourceShape;
    readonly authority?: UpdateAuthority["Service"];
    readonly runtime?: ServiceUpdateRuntimeShape;
    readonly runtimeForBaseDir?: (baseDir: string) => ServiceUpdateRuntimeShape;
    readonly drainWait?: (state: Fakes) => Effect.Effect<void>;
    readonly onQueueCount?: (state: Fakes) => Effect.Effect<void>;
    readonly onDrainObservation?: (
      observation: ServiceUpdateDrainObservation,
    ) => Effect.Effect<void>;
    readonly beforeLifecyclePublish?: (
      event: Parameters<ServerLifecycleEvents.ServerLifecycleEvents["Service"]["publish"]>[0],
      state: Fakes,
    ) => Effect.Effect<void>;
    readonly nativeDrain?: boolean;
    readonly providerRegistry?: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>;
    readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
    readonly onFinalPreparationObservation?: (
      active: ReadonlyArray<ThreadLaunch.ThreadLaunchPreparationActivity>,
    ) => Effect.Effect<void>;
    readonly onFinalDrainObservation?: (
      active: ReadonlyArray<ProviderSessionManager.ProviderSessionActivity>,
    ) => Effect.Effect<void>;
  } = {},
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scheduler-"));
  NodeFS.mkdirSync(NodePath.join(tempDir, "runtime"));
  const { state, fakes } = makeFakes(
    overrides,
    tempDir,
    options.source,
    options.authority,
    options.runtime ?? options.runtimeForBaseDir?.(tempDir),
    options.drainWait,
    options.nativeDrain,
  );
  const databasePath = NodePath.join(tempDir, "db.sqlite");
  const databaseLayer = makeSchedulerDatabaseLayer(
    databasePath,
    () => options.onQueueCount?.(state) ?? Effect.void,
  );
  const nativeRuntimeLayer = Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      { name: "service-update-scheduler" },
      options.providerRegistry ?? emptyProviderRegistry,
      {
        databaseLayer,
        runEffectWorker: false,
      },
    ),
    EffectOutbox.layer.pipe(Layer.provide(databaseLayer)),
    ProjectStore.layer.pipe(Layer.provide(databaseLayer)),
    databaseLayer,
  );
  const threadManagementLayer = ThreadManagement.layer.pipe(Layer.provide(nativeRuntimeLayer));
  const schedulerNativeLayer = options.nativeDrain
    ? (() => {
        const finalQuiescenceFibers = new Set<number>();
        const observedSessionsLayer = Layer.effect(
          ProviderSessionManager.ProviderSessionManagerV2,
          Effect.gen(function* () {
            const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const observeActive = Effect.gen(function* () {
              const observation = yield* sessions.observeActive;
              const fiberId = yield* Effect.fiberId;
              if (finalQuiescenceFibers.has(fiberId)) {
                const onFinalDrainObservation = options.onFinalDrainObservation;
                if (onFinalDrainObservation !== undefined) {
                  yield* onFinalDrainObservation(observation.active);
                }
              }
              return observation;
            });
            return ProviderSessionManager.ProviderSessionManagerV2.of({
              ...sessions,
              observeActive,
            });
          }),
        ).pipe(Layer.provide(nativeRuntimeLayer));
        const observedPreparationsLayer = Layer.effect(
          ThreadLaunch.ThreadLaunchService,
          Effect.gen(function* () {
            const launches = yield* ThreadLaunch.ThreadLaunchService;
            const observePreparations: ThreadLaunch.ThreadLaunchService["Service"]["observePreparations"] =
              Effect.gen(function* () {
                const observation = yield* launches.observePreparations;
                const fiberId = yield* Effect.fiberId;
                if (finalQuiescenceFibers.has(fiberId)) {
                  const onFinalPreparationObservation = options.onFinalPreparationObservation;
                  if (onFinalPreparationObservation !== undefined) {
                    yield* onFinalPreparationObservation(observation.active);
                  }
                }
                return observation;
              });
            return ThreadLaunch.ThreadLaunchService.of({ ...launches, observePreparations });
          }),
        ).pipe(Layer.provide(makeSchedulerThreadLaunchLayer(nativeRuntimeLayer, options.runSetup)));
        const nativeDrainOnly = ServiceUpdateDrainLive.pipe(
          Layer.provide(
            Layer.mergeAll(nativeRuntimeLayer, observedSessionsLayer, observedPreparationsLayer),
          ),
        );
        const observedDrainLayer = Layer.effect(
          ServiceUpdateDrain,
          Effect.gen(function* () {
            const drain = yield* ServiceUpdateDrain;
            return ServiceUpdateDrain.of({
              acquire: Effect.map(drain.acquire, (lease) => {
                let quiescencePass = 0;
                return {
                  observations: lease.observations.pipe(
                    Stream.tap(
                      (observation) => options.onDrainObservation?.(observation) ?? Effect.void,
                    ),
                  ),
                  cancel: lease.cancel,
                  withQuiescence: (use) =>
                    Effect.gen(function* () {
                      quiescencePass += 1;
                      const isFinalPass = quiescencePass === 2;
                      const fiberId = yield* Effect.fiberId;
                      if (isFinalPass) finalQuiescenceFibers.add(fiberId);
                      return yield* lease
                        .withQuiescence(use)
                        .pipe(
                          Effect.ensuring(
                            isFinalPass
                              ? Effect.sync(() => finalQuiescenceFibers.delete(fiberId)).pipe(
                                  Effect.asVoid,
                                )
                              : Effect.void,
                          ),
                        );
                    }),
                };
              }),
            });
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              nativeRuntimeLayer,
              observedSessionsLayer,
              observedPreparationsLayer,
              nativeDrainOnly,
            ),
          ),
        );
        return Layer.merge(
          Layer.mergeAll(
            nativeRuntimeLayer,
            observedSessionsLayer,
            observedPreparationsLayer,
            threadManagementLayer,
          ),
          observedDrainLayer,
        );
      })()
    : Layer.merge(
        Layer.merge(
          nativeRuntimeLayer,
          makeSchedulerThreadLaunchLayer(nativeRuntimeLayer, options.runSetup),
        ),
        threadManagementLayer,
      );
  const lifecycleEventsLayer = Layer.effect(
    ServerLifecycleEvents.ServerLifecycleEvents,
    Effect.gen(function* () {
      const events = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      return ServerLifecycleEvents.ServerLifecycleEvents.of({
        ...events,
        publish: (event) => {
          return Effect.flatMap(options.beforeLifecyclePublish?.(event, state) ?? Effect.void, () =>
            events.publish(event),
          );
        },
      });
    }),
  ).pipe(Layer.provide(ServerLifecycleEvents.layer));
  const layer = ServiceUpdateSchedulerLive.pipe(
    Layer.provide(fakes),
    Layer.provide(
      options.settings ?? ServerSettingsService.layerTest({ serviceUpdateRepository: "" }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), tempDir)),
    Layer.provideMerge(schedulerNativeLayer),
  ).pipe(Layer.provideMerge(lifecycleEventsLayer), Layer.provideMerge(NodeServices.layer));
  return {
    state,
    baseDir: tempDir,
    dispose: () => NodeFS.rmSync(tempDir, { recursive: true, force: true }),
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const migrationContext = yield* Layer.build(
                NodeSqliteClient.layer({ filename: databasePath }).pipe(
                  Layer.provideMerge(NodeServices.layer),
                ),
              );
              yield* runMigrations().pipe(Effect.provide(migrationContext));
            }),
          );
          const context = yield* Layer.build(layer);
          return yield* Effect.provide(effect, context);
        }),
      ),
  };
};

const makeManualSource = (targetVersion: string, state: Fakes): ServiceUpdateSourceShape => ({
  check: () => Effect.succeed(null),
  resolveTargetVersion: () => Effect.succeed({ version: targetVersion } as never),
  stage: ({ attemptId: id, candidate }) =>
    Effect.sync(() => {
      state.stageCalls += 1;
      return { ...staged, attemptId: id, version: candidate.version };
    }),
  discard: () =>
    Effect.sync(() => {
      state.discardCalls += 1;
    }),
});

const manualRequest = (targetVersion: string) => ({
  manual: {
    targetVersion,
    reportProgress: () => Effect.void,
    onHandoffAccepted: () => Effect.void,
  },
});

const lateOwnerInstanceId = ProviderInstanceId.make("codex");
const lateOwnerDriver = ProviderDriverKind.make("codex");
const lateOwnerModelSelection = { instanceId: lateOwnerInstanceId, model: "test-model" } as const;

const makeLateOwnerAdapter = (closed: Deferred.Deferred<void>) => {
  const adapter: ProviderAdapter.ProviderAdapterV2Shape = {
    instanceId: lateOwnerInstanceId,
    driver: lateOwnerDriver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event, Cause.Done>();
        yield* Effect.addFinalizer(() =>
          Queue.shutdown(events).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
        );
        const providerThread = {
          id: ProviderThreadId.make("provider-thread-scheduler-late-owner"),
          driver: lateOwnerDriver,
          providerInstanceId: input.modelSelection.instanceId,
          providerSessionId: input.providerSessionId,
          appThreadId: input.threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver: lateOwnerDriver,
            nativeId: "native-scheduler-late-owner",
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
          driver: lateOwnerDriver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver: lateOwnerDriver,
            providerInstanceId: input.modelSelection.instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? process.cwd(),
            model: input.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({ ...providerThread, appThreadId: threadId }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: () => Effect.void,
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused in scheduler quiescence test"),
          rollbackThread: () => Effect.die("unused in scheduler quiescence test"),
          forkThread: () => Effect.die("unused in scheduler quiescence test"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  };
  return adapter;
};

it.effect("the Scheduler final drain pass waits for a session opened during adoption", () =>
  Effect.gen(function* () {
    const ownerOpened = yield* Deferred.make<void>();
    const finishAdoption = yield* Deferred.make<void>();
    const finalPassActivities =
      yield* Deferred.make<ReadonlyArray<ProviderSessionManager.ProviderSessionActivity>>();
    const sessionClosed = yield* Deferred.make<void>();
    const ownerThreadId = ThreadId.make("scheduler-late-owner-thread");
    const ownerSessionId = ProviderSessionId.make("scheduler-late-owner-session");
    let openOwner: Effect.Effect<void> = Effect.void;
    let verifyHandoff: Effect.Effect<void> = Effect.void;
    const harness = makeHarness(
      {
        onAdopt: () => openOwner,
        onHandoff: () => verifyHandoff,
      },
      {
        nativeDrain: true,
        providerRegistry: ProviderAdapterRegistry.layerFromAdapters([
          makeLateOwnerAdapter(sessionClosed),
        ]),
        onFinalDrainObservation: (active) =>
          Deferred.succeed(finalPassActivities, active).pipe(Effect.asVoid),
      },
    );

    yield* Effect.ensuring(
      harness.run(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const scheduler = yield* ServiceUpdateScheduler;
          openOwner = Effect.scoped(
            Effect.gen(function* () {
              yield* orchestrator
                .dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("scheduler-late-owner-create"),
                  threadId: ownerThreadId,
                  projectId: ProjectId.make("scheduler-late-owner-project"),
                  title: "Late updater owner",
                  modelSelection: lateOwnerModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdBy: "user",
                  creationSource: "web",
                })
                .pipe(Effect.orDie);
              yield* manager
                .open({
                  threadId: ownerThreadId,
                  providerSessionId: ownerSessionId,
                  modelSelection: lateOwnerModelSelection,
                  runtimePolicy: {
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    cwd: process.cwd(),
                  },
                })
                .pipe(Effect.orDie);
              yield* Deferred.succeed(ownerOpened, undefined);
              yield* Deferred.await(finishAdoption);
            }),
          );
          verifyHandoff = Effect.scoped(
            Effect.gen(function* () {
              assert.isTrue(yield* Deferred.isDone(sessionClosed));
              assert.isTrue(Option.isNone(yield* manager.get(ownerSessionId)));
              const settled = yield* manager.observeActive;
              assert.isFalse(
                settled.active.some((activity) => activity.providerSessionId === ownerSessionId),
              );
            }),
          ).pipe(Effect.orDie);

          const attempt = yield* Effect.forkChild(
            scheduler.beginAttempt({ currentVersion: "1.0.0" }),
            { startImmediately: true },
          );
          const opening = yield* Effect.raceFirst(
            Deferred.await(ownerOpened).pipe(Effect.as({ _tag: "opened" as const })),
            Fiber.await(attempt).pipe(
              Effect.map((exit) => ({ _tag: "attempt-exited" as const, exit })),
            ),
          );
          if (opening._tag === "attempt-exited") {
            const failure = Exit.isFailure(opening.exit)
              ? Cause.squash(opening.exit.cause)
              : undefined;
            const failureDetail = isServiceUpdateError(failure)
              ? `${failure.stage}/${failure.code}: ${failure.detail}`
              : failure instanceof Error
                ? failure.message
                : failure === undefined
                  ? "the update attempt completed successfully"
                  : String(failure);
            assert.fail(`Scheduler exited before the provider session opened: ${failureDetail}`);
          }
          assert.equal(harness.state.handoffAttempts, 0);
          assert.isFalse(yield* Deferred.isDone(finalPassActivities));
          const liveDrainStatus = yield* currentServiceUpdateState;
          assert.equal(liveDrainStatus.status, "draining");
          if (liveDrainStatus.status === "draining") {
            assert.equal(liveDrainStatus.activeTurnCount, 1);
          }
          yield* Deferred.succeed(finishAdoption, undefined);
          const finalActivities = yield* Deferred.await(finalPassActivities);
          assert.isTrue(
            finalActivities.some(
              (activity) =>
                activity.providerSessionId === ownerSessionId && activity.kind === "scope",
            ),
            "the actual final Drain observation saw the live session scope",
          );
          assert.isTrue(
            finalActivities.some(
              (activity) =>
                activity.providerSessionId === ownerSessionId && activity.kind === "event-pump",
            ),
            "the actual final Drain observation saw the live provider event pump",
          );
          assert.equal(harness.state.handoffAttempts, 0);

          yield* manager.close(ownerSessionId);
          yield* Deferred.await(sessionClosed);
          yield* Fiber.join(attempt);

          assert.equal(harness.state.handoffAttempts, 1);
          assert.equal(harness.state.handoffCalls, 1);
          assert.equal(harness.state.releaseCalls, 0);
          assert.isTrue(harness.state.reservationActive);
        }),
      ),
      Effect.sync(harness.dispose),
    );
  }),
);

it.effect("the Scheduler final drain pass waits for message-free ThreadLaunch preparation", () => {
  const setupCompletionValue = { exitCode: 0, durationMs: 1 } as const;
  return Effect.gen(function* () {
    const setupEntered = yield* Deferred.make<void>();
    const setupCompletion = yield* Deferred.make<{
      readonly exitCode: number | null;
      readonly durationMs: number;
    }>();
    const finalPassPreparation =
      yield* Deferred.make<ReadonlyArray<ThreadLaunch.ThreadLaunchPreparationActivity>>();
    const commandId = CommandId.make("scheduler-message-free-preparation");
    const threadId = ThreadId.make("scheduler-message-free-preparation-thread");
    let launchPreparation: Effect.Effect<void> = Effect.void;
    let verifyHandoff: Effect.Effect<void> = Effect.void;
    const harness = makeHarness(
      {
        onAdopt: () => launchPreparation,
        onHandoff: () => verifyHandoff,
      },
      {
        nativeDrain: true,
        runSetup: () =>
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
        onFinalPreparationObservation: (active) =>
          Deferred.succeed(finalPassPreparation, active).pipe(Effect.asVoid),
      },
    );

    yield* Effect.ensuring(
      harness.run(
        Effect.ensuring(
          Effect.gen(function* () {
            const launches = yield* ThreadLaunch.ThreadLaunchService;
            const scheduler = yield* ServiceUpdateScheduler;
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            launchPreparation = Effect.gen(function* () {
              const result = yield* launches.launch({
                commandId,
                threadId,
                projectId: preparationProject.id,
                title: "Message-free native preparation during adoption",
                generateTitle: false,
                modelSelection: preparationModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                workspaceStrategy: { type: "root" },
                createdBy: "user",
                creationSource: "web",
              });
              assert.isEmpty(result.projection.messages);
              assert.isEmpty(result.projection.runs);
              yield* Deferred.await(setupEntered);
              assert.isEmpty(yield* outbox.listByCommandId(commandId));
            }).pipe(Effect.orDie);
            verifyHandoff = Effect.scoped(
              Effect.gen(function* () {
                assert.isTrue(yield* Deferred.isDone(setupCompletion));
                yield* launches.awaitPreparation(commandId);
                const settled = yield* launches.observePreparations;
                assert.isFalse(settled.active.some((activity) => activity.commandId === commandId));
                assert.isEmpty(yield* outbox.listByCommandId(commandId));
              }),
            ).pipe(Effect.orDie);

            const attempt = yield* Effect.forkChild(
              scheduler.beginAttempt({ currentVersion: "1.0.0" }),
              { startImmediately: true },
            );
            const stage = yield* Effect.raceFirst(
              Deferred.await(finalPassPreparation).pipe(
                Effect.map((active) => ({ _tag: "observed" as const, active })),
              ),
              Fiber.await(attempt).pipe(
                Effect.map((exit) => ({ _tag: "attempt-exited" as const, exit })),
              ),
            );
            if (stage._tag === "attempt-exited") {
              const failure = Exit.isFailure(stage.exit)
                ? Cause.squash(stage.exit.cause)
                : undefined;
              assert.fail(
                `Scheduler exited before its final preparation observation: ${failure instanceof Error ? failure.message : String(failure)}`,
              );
            }
            assert.isTrue(
              stage.active.some(
                (activity) => activity.commandId === commandId && activity.runId === null,
              ),
              "the actual final Drain pass observed the message-free ThreadLaunch preparation",
            );
            assert.equal(harness.state.handoffAttempts, 0);
            assert.equal((yield* currentServiceUpdateState).status, "draining");

            yield* Deferred.succeed(setupCompletion, setupCompletionValue);
            yield* launches.awaitPreparation(commandId);
            yield* Fiber.join(attempt);

            assert.equal(harness.state.handoffAttempts, 1);
            assert.equal(harness.state.handoffCalls, 1);
            assert.isTrue(harness.state.reservationActive);
          }),
          Deferred.succeed(setupCompletion, setupCompletionValue).pipe(Effect.asVoid),
        ),
      ),
      Effect.sync(harness.dispose),
    );
  });
});

it.effect("publishes queued native turns when drain counts stay unchanged", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("scheduler-queued-visibility-project");
    const threadId = ThreadId.make("scheduler-queued-visibility-thread");
    const commandId = CommandId.make("scheduler-queued-visibility-send");
    const messageId = MessageId.make("scheduler-queued-visibility-message");
    const sessionClosed = yield* Deferred.make<void>();
    const drainingEntered = yield* Deferred.make<void>();
    const sessionOpened = yield* Deferred.make<void>();
    const initialDrainObservation = yield* Deferred.make<void>();
    const queuedDrainObservation = yield* Deferred.make<void>();
    const drainObservations: ServiceUpdateDrainObservation[] = [];
    const drainingStates: Extract<
      import("@t3tools/contracts").ServiceUpdateState,
      { readonly status: "draining" }
    >[] = [];
    let queuedResult: ThreadManagement.ThreadManagementSendResult | undefined;
    let queueAdmissionStarted = false;
    let queueAdmissionAccepted = false;
    let observationBeforeQueue: ServiceUpdateDrainObservation | undefined;
    let observationsBeforeQueue = 0;
    let drainingSignalSent = false;

    const harness = makeHarness(
      {},
      {
        source: (_baseDir, state) => makeManualSource("1.1.0", state),
        nativeDrain: true,
        providerRegistry: ProviderAdapterRegistry.layerFromAdapters([
          makeLateOwnerAdapter(sessionClosed),
        ]),
        onDrainObservation: (observation) =>
          Effect.gen(function* () {
            drainObservations.push(observation);
            if (drainObservations.length === 1) {
              yield* Deferred.succeed(initialDrainObservation, undefined);
            }
            if (
              queueAdmissionStarted &&
              queueAdmissionAccepted &&
              drainObservations.length > observationsBeforeQueue
            ) {
              yield* Deferred.succeed(queuedDrainObservation, undefined);
            }
          }),
        beforeLifecyclePublish: (event) => {
          if (event.type !== "serviceUpdate" || event.payload.status !== "draining") {
            return Effect.void;
          }
          drainingStates.push(event.payload);
          if (drainingSignalSent) return Effect.void;
          drainingSignalSent = true;
          return Effect.gen(function* () {
            yield* Deferred.succeed(drainingEntered, undefined);
            yield* Deferred.await(sessionOpened);
          });
        },
      },
    );

    yield* Effect.ensuring(
      harness.run(
        Effect.gen(function* () {
          const projects = yield* ProjectStore.ProjectStoreV2;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threads = yield* ThreadManagement.ThreadManagementService;
          const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
          const scheduler = yield* ServiceUpdateScheduler;
          const now = DateTime.formatIso(yield* DateTime.now);
          const providerSessionId = ProviderSessionId.make("scheduler-queue-visibility-session");

          yield* projects.apply({
            sequence: 0,
            eventId: EventId.make("scheduler-queued-visibility-project-created"),
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
              title: "Updater queue visibility",
              workspaceRoot: "/work/scheduler-queue-visibility",
              defaultModelSelection: preparationModelSelection,
              scripts: [],
              createdAt: now,
              updatedAt: now,
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("scheduler-queued-visibility-thread-created"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            projectId,
            title: "Updater queue visibility",
            modelSelection: preparationModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          const attempt = yield* Effect.forkChild(scheduler.beginAttempt(manualRequest("1.1.0")), {
            startImmediately: true,
          });
          yield* Deferred.await(drainingEntered);
          yield* sessions.open({
            threadId,
            providerSessionId,
            modelSelection: preparationModelSelection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: process.cwd(),
            },
          });
          yield* Deferred.succeed(sessionOpened, undefined);
          yield* Deferred.await(initialDrainObservation);
          observationBeforeQueue = drainObservations.at(-1);
          observationsBeforeQueue = drainObservations.length;
          queueAdmissionStarted = true;
          queuedResult = yield* threads.sendToThread({
            projectId,
            commandId,
            threadId,
            messageId,
            text: "Queue while the updater is draining.",
            attachments: [],
            mode: "auto",
            createdBy: "user",
            creationSource: "web",
          });
          queueAdmissionAccepted = true;
          if (drainObservations.length > observationsBeforeQueue) {
            yield* Deferred.succeed(queuedDrainObservation, undefined);
          }
          yield* Deferred.await(queuedDrainObservation);
          assert.isTrue(queueAdmissionStarted && queueAdmissionAccepted);
          assert.equal(queuedResult?.delivery, "queued");
          assert.isNull(queuedResult?.turnItem);

          const queuedState = drainingStates.find((state) =>
            state.queuedTurns.some(
              (turn) => turn.threadId === threadId && turn.messageId === messageId,
            ),
          );
          assert.isDefined(queuedState);
          assert.equal(queuedState.queuedTurnCount, 1);
          assert.equal(queuedState.activeTurnCount, observationBeforeQueue?.activeTurns);
          assert.isDefined(observationBeforeQueue);

          const unchangedDrainObservation = drainObservations
            .slice(observationsBeforeQueue)
            .find(
              (observation) =>
                observation.queued === observationBeforeQueue?.queued &&
                observation.claimed === observationBeforeQueue?.claimed &&
                observation.activeTurns === observationBeforeQueue?.activeTurns &&
                observation.startingOperations === observationBeforeQueue?.startingOperations &&
                observation.unresolvedClaims === observationBeforeQueue?.unresolvedClaims,
            );
          assert.isDefined(unchangedDrainObservation);

          yield* sessions.close(providerSessionId);
          yield* Deferred.await(sessionClosed);
          yield* Fiber.join(attempt);
        }),
      ),
      Effect.sync(harness.dispose),
    );
  }),
);

it.effect("a failed precommit status read cannot retain the update authority lease", () => {
  const targetVersion = "0.0.40-f8y.20260912.103";
  let postAdoptionCountReads = 0;
  const harness = makeHarness(
    {},
    {
      source: (_baseDir, state) => makeManualSource(targetVersion, state),
      onQueueCount: (state) => {
        if (state.adoptCalls === 0) return Effect.void;
        postAdoptionCountReads += 1;
        return Effect.die(new Error("native outbox count read failed"));
      },
    },
  );

  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* Effect.exit(scheduler.beginAttempt(manualRequest(targetVersion)));

        assert.equal(postAdoptionCountReads, 1);
        assert.equal(harness.state.handoffAttempts, 0);
        assert.equal(harness.state.releaseCalls, 1);
        assert.isFalse(harness.state.reservationActive);
        assert.equal(harness.state.replayCalls, 1);
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("an activation publication failure remains unsent and releases the update gate", () => {
  const targetVersion = "0.0.40-f8y.20260912.103";
  let failFirstActivatingRead = true;
  let activatingPublicationFailures = 0;
  const harness = makeHarness(
    {},
    {
      source: (_baseDir, state) => makeManualSource(targetVersion, state),
      beforeLifecyclePublish: (event) => {
        if (
          event.type === "serviceUpdate" &&
          event.payload.status === "activating" &&
          failFirstActivatingRead
        ) {
          failFirstActivatingRead = false;
          activatingPublicationFailures += 1;
          return Effect.die(new Error("activating lifecycle publication failed"));
        }
        return Effect.void;
      },
    },
  );

  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        const failed = yield* Effect.exit(scheduler.beginAttempt(manualRequest(targetVersion)));

        assert.equal(activatingPublicationFailures, 1);
        assert.equal(failed._tag, "Failure");
        assert.equal(harness.state.handoffAttempts, 0);
        assert.equal(harness.state.irreversibleCalls, 0);
        assert.equal(harness.state.releaseCalls, 1);
        assert.isFalse(harness.state.reservationActive);
        assert.equal(harness.state.replayCalls, 1);
        assert.equal((yield* currentServiceUpdateState).status, "idle");

        yield* scheduler.beginAttempt(manualRequest(targetVersion));
        assert.equal(harness.state.handoffCalls, 1);
        assert.equal(harness.state.irreversibleCalls, 1);
        assert.equal(harness.state.reserveCalls, 2);
        assert.equal(harness.state.releaseCalls, 1);
        assert.isTrue(harness.state.reservationActive);
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect(
  "interrupting a paused activation publication before commit releases admission and authority",
  () =>
    Effect.gen(function* () {
      const targetVersion = "0.0.40-f8y.20260912.103";
      const publicationEntered = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      let pausedActivationPublication = false;
      const harness = makeHarness(
        {},
        {
          source: (_baseDir, state) => makeManualSource(targetVersion, state),
          beforeLifecyclePublish: (event) => {
            if (
              !pausedActivationPublication &&
              event.type === "serviceUpdate" &&
              event.payload.status === "activating"
            ) {
              pausedActivationPublication = true;
              return Deferred.succeed(publicationEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releasePublication)),
              );
            }
            return Effect.void;
          },
        },
      );

      try {
        yield* harness.run(
          Effect.gen(function* () {
            const scheduler = yield* ServiceUpdateScheduler;
            const attemptFiber = yield* Effect.forkChild(
              scheduler.beginAttempt(manualRequest(targetVersion)),
            );
            yield* Deferred.await(publicationEntered);

            assert.equal(harness.state.handoffAttempts, 0);
            assert.equal(harness.state.irreversibleCalls, 0);
            const interruptor = yield* Effect.forkChild(Fiber.interrupt(attemptFiber), {
              startImmediately: true,
            });
            const attemptExit = yield* Fiber.await(attemptFiber);
            yield* Fiber.join(interruptor);
            yield* Deferred.succeed(releasePublication, undefined);

            assert.isTrue(Exit.isFailure(attemptExit));
            assert.equal(harness.state.handoffAttempts, 0);
            assert.equal(harness.state.handoffCalls, 0);
            assert.equal(harness.state.irreversibleCalls, 0);
            assert.equal(harness.state.releaseCalls, 1);
            assert.isFalse(harness.state.reservationActive);
            assert.equal(harness.state.replayCalls, 1);

            yield* scheduler.beginAttempt(manualRequest(targetVersion));
            assert.equal(harness.state.handoffCalls, 1);
            assert.equal(harness.state.reserveCalls, 2);
            assert.equal(harness.state.releaseCalls, 1);
            assert.isTrue(harness.state.reservationActive);
          }),
        );
      } finally {
        yield* Deferred.succeed(releasePublication, undefined);
        harness.dispose();
      }
    }),
);

it.effect("hands activation to the launcher without stopping the requester", () => {
  const harness = makeHarness();
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* scheduler.beginAttempt({ currentVersion: "1.0.0" });
        expect(harness.state.adoptCalls).toBe(1);
        expect(harness.state.handoffCalls).toBe(1);
        expect(harness.state.order).toEqual(["adopt", "handoff"]);
        const status = yield* currentServiceUpdateState;
        assert.equal(status.status, "activating");
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect(
  "runs an exact manual F8Y target through the shared pipeline from a legacy core version",
  () => {
    const targetVersion = "0.0.40-f8y.20260912.103";
    const binaryName = `t3-${targetVersion}-linux-x64`;
    const descriptor: ServiceUpdateReleaseDescriptor = {
      version: targetVersion,
      tag: `v${targetVersion}`,
      binaryName,
      binaryUrl: `https://github.com/owner/repo/releases/download/v${targetVersion}/${binaryName}`,
      checksumsUrl: `https://github.com/owner/repo/releases/download/v${targetVersion}/${binaryName}.sha256`,
    };
    const authority = makeUpdateAuthority();
    const owners: Array<UpdateAuthorityOwner> = [];
    const manualAuthority: UpdateAuthority["Service"] = {
      reserve: (input) =>
        Effect.sync(() => {
          owners.push(input.owner);
        }).pipe(Effect.andThen(authority.reserve(input))),
    };
    let resolvedRequest:
      | { readonly repository: string; readonly targetVersion: string }
      | undefined;
    const progress: Array<string> = [];
    const harness = makeHarness(
      {},
      {
        settings: ServerSettingsService.layerTest({ serviceUpdateRepository: "owner/repo" }),
        authority: manualAuthority,
        source: (_baseDir, state) => ({
          check: () =>
            Effect.sync(() => {
              state.checkCalls += 1;
              return null;
            }),
          resolveTargetVersion: (request) =>
            Effect.sync(() => {
              resolvedRequest = request;
              return descriptor;
            }),
          stage: ({ attemptId: id, candidate }) =>
            Effect.sync(() => {
              state.stageCalls += 1;
              return { ...staged, attemptId: id, version: candidate.version };
            }),
          discard: () =>
            Effect.sync(() => {
              state.discardCalls += 1;
            }),
        }),
      },
    );

    return harness
      .run(
        Effect.gen(function* () {
          const scheduler = yield* ServiceUpdateScheduler;
          const result = yield* scheduler.beginAttempt({
            manual: {
              targetVersion,
              reportProgress: (stage) =>
                Effect.sync(() => {
                  progress.push(stage);
                }),
              onHandoffAccepted: () =>
                Effect.sync(() => {
                  progress.push("accepted");
                }),
            },
          });

          expect(resolvedRequest).toEqual({ repository: "owner/repo", targetVersion });
          expect(owners).toEqual(["manual"]);
          expect(harness.state.checkCalls).toBe(0);
          expect(harness.state.stageCalls).toBe(1);
          expect(harness.state.adoptCalls).toBe(1);
          expect(harness.state.discardCalls).toBe(1);
          expect(harness.state.handoffCalls).toBe(1);
          expect(harness.state.order).toEqual(["adopt", "handoff"]);
          expect(progress).toEqual(["downloading", "installing", "accepted"]);
          expect(result).toEqual({ targetVersion, updateId: "native-1" });
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
  },
);

it.effect(
  "interrupting manual handoff status counts before commit releases the drain and authority",
  () =>
    Effect.gen(function* () {
      const targetVersion = "0.0.40-f8y.20260912.103";
      const countQueryReturned = yield* Deferred.make<void>();
      const releaseCountQuery = yield* Deferred.make<void>();
      let countQueryPaused = false;
      const harness = makeHarness(
        {},
        {
          source: (_baseDir, state) => makeManualSource(targetVersion, state),
          drainWait: (state) =>
            state.adoptCalls > 0 && !countQueryPaused
              ? Effect.sync(() => {
                  countQueryPaused = true;
                }).pipe(
                  Effect.andThen(Deferred.succeed(countQueryReturned, undefined)),
                  Effect.andThen(Deferred.await(releaseCountQuery)),
                )
              : Effect.void,
        },
      );

      try {
        yield* harness.run(
          Effect.gen(function* () {
            const scheduler = yield* ServiceUpdateScheduler;
            const attemptFiber = yield* Effect.forkChild(
              scheduler.beginAttempt(manualRequest(targetVersion)),
            );
            // The wrapper pauses after the real SQLite count query has returned.
            yield* Deferred.await(countQueryReturned);
            yield* Fiber.interrupt(attemptFiber);
            yield* Deferred.succeed(releaseCountQuery, undefined);

            assert.equal(harness.state.handoffAttempts, 0);
            assert.equal(harness.state.handoffCalls, 0);
            assert.equal(
              harness.state.releaseCalls,
              1,
              "interrupted precommit attempt should release the authority lease",
            );
            assert.isFalse(harness.state.reservationActive);
            assert.equal(harness.state.replayCalls, 1);
          }),
        );
      } finally {
        harness.dispose();
      }
    }),
);

it.effect("a manual disconnect between commit and launcher send cannot interrupt acceptance", () =>
  Effect.gen(function* () {
    const targetVersion = "0.0.40-f8y.20260912.103";
    const handoffEntered = yield* Deferred.make<void>();
    const releaseHandoff = yield* Deferred.make<void>();
    const harness = makeHarness(
      {
        onHandoff: () =>
          Effect.andThen(
            Deferred.succeed(handoffEntered, undefined),
            Deferred.await(releaseHandoff),
          ),
      },
      { source: (_baseDir, state) => makeManualSource(targetVersion, state) },
    );

    try {
      yield* harness.run(
        Effect.gen(function* () {
          const scheduler = yield* ServiceUpdateScheduler;
          const attemptFiber = yield* Effect.forkChild(
            scheduler.beginAttempt(manualRequest(targetVersion)),
          );
          yield* Deferred.await(handoffEntered);

          // This is after the scheduler's commit decision but before the fake
          // runtime records the actual launcher send.
          const interruptor = yield* Effect.forkChild(Fiber.interrupt(attemptFiber), {
            startImmediately: true,
          });
          assert.equal(harness.state.handoffCalls, 0);
          yield* Deferred.succeed(releaseHandoff, undefined);
          const attemptExit = yield* Fiber.await(attemptFiber);
          yield* Fiber.join(interruptor);

          assert.isTrue(Exit.isFailure(attemptExit));
          if (Exit.isFailure(attemptExit)) {
            assert.isTrue(Cause.hasInterruptsOnly(attemptExit.cause));
          }
          assert.equal(harness.state.handoffCalls, 1);
          assert.equal(harness.state.releaseCalls, 0);
          assert.isTrue(harness.state.reservationActive);
          const status = yield* currentServiceUpdateState;
          assert.equal(status.status, "activating");
        }),
      );
    } finally {
      harness.dispose();
    }
  }),
);

it.effect(
  "refuses manual raw updates before source or runtime work when capability is unsupported",
  () => {
    const harness = makeHarness({
      availability: { status: "unsupported", reason: "platform" },
    });
    return harness
      .run(
        Effect.gen(function* () {
          const scheduler = yield* ServiceUpdateScheduler;
          const result = yield* Effect.result(
            scheduler.beginAttempt({
              manual: {
                targetVersion: "0.0.40-f8y.20260912.103",
                reportProgress: () => Effect.void,
                onHandoffAccepted: () => Effect.void,
              },
            }),
          );

          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.instanceOf(result.failure, ServiceUpdateError);
            assert.equal(result.failure.code, "unsupported");
            assert.equal(result.failure.stage, "runtime");
          }
          assert.equal(harness.state.reserveCalls, 0);
          assert.equal(harness.state.checkCalls, 0);
          assert.equal(harness.state.stageCalls, 0);
          assert.equal(harness.state.adoptCalls, 0);
          assert.equal(harness.state.handoffAttempts, 0);
          assert.equal((yield* currentServiceUpdateState).status, "idle");
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
  },
);

it.effect("a held manual lease blocks scheduled work before source and runtime operations", () => {
  const authority = makeUpdateAuthority();
  const harness = makeHarness({}, { authority });
  return harness
    .run(
      Effect.gen(function* () {
        const manual = yield* authority.reserve({ owner: "manual" });
        assert.equal(manual._tag, "owned");
        if (manual._tag !== "owned") return;

        const scheduler = yield* ServiceUpdateScheduler;
        const result = yield* Effect.result(scheduler.beginAttempt({ currentVersion: "1.0.0" }));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, ServiceUpdateAttemptBusyError);
        }
        assert.equal(harness.state.checkCalls, 0);
        assert.equal(harness.state.stageCalls, 0);
        assert.equal(harness.state.adoptCalls, 0);
        assert.equal(harness.state.handoffAttempts, 0);
        yield* manual.lease.release;
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("discards the source stage after adoption and keeps the adopted runtime", () => {
  const adoptedArtifact = { path: "" };
  const harness = makeHarness(
    {
      onAdopt: (runtime) =>
        Effect.sync(() => {
          const baseDir = NodePath.dirname(
            NodePath.dirname(NodePath.dirname(runtime.stagingDirectory)),
          );
          const targetDirectory = NodePath.join(baseDir, "runtime", "versions", runtime.version);
          adoptedArtifact.path = NodePath.join(targetDirectory, "runtime.bin");
          NodeFS.mkdirSync(targetDirectory, { recursive: true });
          NodeFS.copyFileSync(
            NodePath.join(runtime.stagingDirectory, STAGED_ARTIFACT_FILENAME),
            adoptedArtifact.path,
          );
        }),
    },
    {
      source: (baseDir, state) => {
        const liveSource = makeServiceUpdateSource({ fetch: globalThis.fetch, baseDir });
        return {
          check: () => Effect.succeed({ version: "1.1.0" } as never),
          resolveTargetVersion: () =>
            Effect.fail(
              new ServiceUpdateOperationError({
                stage: "source",
                code: "unavailable",
                cause: "unexpected explicit-version lookup",
              }),
            ),
          stage: ({ attemptId: id, candidate }) =>
            Effect.sync(() => {
              const stagingDirectory = NodePath.join(
                baseDir,
                "runtime",
                "service-update-staging",
                id,
              );
              NodeFS.mkdirSync(stagingDirectory, { recursive: true });
              NodeFS.writeFileSync(
                NodePath.join(stagingDirectory, STAGED_ARTIFACT_FILENAME),
                "verified-runtime",
              );
              return {
                ...staged,
                attemptId: id,
                version: candidate.version,
                bytes: 16,
                stagingDirectory,
              };
            }),
          discard: (runtime) =>
            Effect.sync(() => state.order.push("discard")).pipe(
              Effect.andThen(liveSource.discard(runtime)),
            ),
        };
      },
    },
  );
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* scheduler.beginAttempt({ currentVersion: "1.0.0" });

        assert.deepEqual(harness.state.order, ["adopt", "discard", "handoff"]);
        assert.isFalse(
          NodeFS.existsSync(
            NodePath.join(
              harness.baseDir,
              "runtime",
              "service-update-staging",
              harness.state.attemptId!,
            ),
          ),
        );
        assert.isTrue(NodeFS.existsSync(adoptedArtifact.path));
        assert.equal(NodeFS.readFileSync(adoptedArtifact.path, "utf8"), "verified-runtime");
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect(
  "retries the same release after handoff rejection by reusing the verified runtime",
  () => {
    const version = "1.2.4-f8y.20260101.2";
    const currentVersion = "1.2.4-f8y.20260101.1";
    const tag = `v${version}`;
    const binaryName = `t3-${version}-linux-x64`;
    const assetUrl = (name: string) =>
      `https://github.com/owner/repo/releases/download/${tag}/${name}`;
    let invocationLog = "";
    let handoffCalls = 0;
    const artifactForBaseDir = (baseDir: string) => {
      const dbPath = NodePath.join(baseDir, "userdata", "state.sqlite");
      invocationLog = NodePath.join(baseDir, "preflight.log");
      const executable = Buffer.from(`#!/bin/sh
printf '%s\\n' "$0|$*" >> ${JSON.stringify(invocationLog)}
[ "$#" -eq 5 ] || exit 20
[ "$1" = "__service-preflight" ] || exit 21
[ "$2" = "--database-path" ] || exit 22
[ "$3" = ${JSON.stringify(dbPath)} ] || exit 23
[ "$4" = "--launcher-protocol" ] || exit 24
[ "$5" = "${SERVICE_LAUNCHER_PROTOCOL}" ] || exit 25
printf '{"status":"ready","version":"${version}","launcherProtocol":${SERVICE_LAUNCHER_PROTOCOL},"runtimeFormat":"bun-standalone","supportsProtectedLauncher":true}\\n'
`);
      const digest = NodeCrypto.createHash("sha256").update(executable).digest("hex");
      const checksums = `${digest}  ${binaryName}\n`;
      const release = {
        tag_name: tag,
        draft: false,
        prerelease: true,
        assets: [
          {
            name: binaryName,
            browser_download_url: assetUrl(binaryName),
          },
          {
            name: `${binaryName}.sha256`,
            browser_download_url: assetUrl(`${binaryName}.sha256`),
          },
        ],
      };
      const fetch = ((url: string | URL) => {
        const requested = String(url);
        if (requested === "https://api.github.com/repos/owner/repo/releases?per_page=30") {
          return Promise.resolve(new Response(JSON.stringify([release])));
        }
        if (requested.endsWith(`/${binaryName}.sha256`))
          return Promise.resolve(new Response(checksums));
        if (requested.endsWith(`/${binaryName}`)) return Promise.resolve(new Response(executable));
        return Promise.resolve(new Response("not found", { status: 404 }));
      }) as typeof globalThis.fetch;
      return { dbPath, executable, digest, fetch };
    };
    const runner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) =>
        Effect.sync(() => {
          const result = NodeChildProcess.spawnSync(input.command, [...input.args], {
            encoding: "utf8",
            env: input.env ?? process.env,
          });
          if (result.error !== undefined) throw result.error;
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            code: result.status as ProcessRunner.ProcessRunOutput["code"],
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    };
    const harness = makeHarness(
      {},
      {
        source: (baseDir) => {
          const source = makeServiceUpdateSource({
            fetch: artifactForBaseDir(baseDir).fetch,
            baseDir,
          });
          return {
            ...source,
            check: ({ currentVersion }) =>
              source.check({ repository: "owner/repo", currentVersion }),
          };
        },
        runtimeForBaseDir: (baseDir) => {
          const artifact = artifactForBaseDir(baseDir);
          return makeServiceUpdateRuntime({
            launcher: {
              managed: true,
              requestUpdate: (request) => {
                handoffCalls += 1;
                return handoffCalls === 1
                  ? Effect.fail(
                      new ServiceLauncherRejectedError({
                        targetVersion: request.targetVersion,
                        reason: "injected definite rejection",
                      }),
                    )
                  : Effect.succeed("native-retry");
              },
            },
            baseDir,
            dbPath: artifact.dbPath,
            captureSource: ({ fromVersion }) =>
              Effect.succeed({
                databaseIdentity: artifact.dbPath,
                fromVersion,
              }),
            desktopManaged: false,
            launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
            platform: "linux",
            architecture: "x64",
            validate: makePreflightValidate({
              runner,
              execPath: process.execPath,
              dbPath: artifact.dbPath,
            }),
          });
        },
      },
    );

    return harness
      .run(
        Effect.gen(function* () {
          const scheduler = yield* ServiceUpdateScheduler;
          const runtimeFiles = runtimeInstallPaths(
            harness.baseDir,
            version,
            "standalone-executable",
          );
          const firstArtifact = artifactForBaseDir(harness.baseDir);

          const firstAttemptExit = yield* Effect.exit(scheduler.beginAttempt({ currentVersion }));
          assert.isTrue(Exit.isFailure(firstAttemptExit));
          const rejectedAttemptId = ServiceUpdateAttemptId.make(harness.state.attemptId!);
          assert.equal((yield* currentServiceUpdateState).status, "idle");
          assert.equal(harness.state.releaseCalls, 1);
          assert.isFalse(harness.state.reservationActive);
          assert.deepEqual(
            yield* Effect.promise(() => resolveInstalledServiceRuntime(harness.baseDir, version)),
            {
              format: "standalone-executable",
              versionDir: runtimeFiles.versionDir,
              executablePath: runtimeFiles.executablePath,
            },
          );
          assert.equal(
            NodeCrypto.createHash("sha256")
              .update(NodeFS.readFileSync(runtimeFiles.executablePath))
              .digest("hex"),
            firstArtifact.digest,
          );
          assert.isFalse(
            NodeFS.existsSync(
              NodePath.join(
                harness.baseDir,
                "runtime",
                "service-update-staging",
                harness.state.attemptId!,
              ),
            ),
          );

          yield* scheduler.beginAttempt({ currentVersion });
          const retriedAttemptId = ServiceUpdateAttemptId.make(harness.state.attemptId!);
          assert.notEqual(retriedAttemptId, rejectedAttemptId);
          assert.equal((yield* currentServiceUpdateState).status, "activating");
          assert.equal(handoffCalls, 2);
          const preflights = NodeFS.readFileSync(invocationLog, "utf8").trim().split("\n");
          assert.equal(preflights.length, 2);
          assert.include(preflights[0], ".staging-");
          assert.equal(
            preflights[1],
            [
              `${runtimeFiles.executablePath}|__service-preflight`,
              `--database-path ${firstArtifact.dbPath}`,
              `--launcher-protocol ${SERVICE_LAUNCHER_PROTOCOL}`,
            ].join(" "),
          );
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
  },
);

it.effect("does not hand off when source-stage cleanup fails", () => {
  const harness = makeHarness({ discardFails: true });
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* Effect.exit(scheduler.beginAttempt({ currentVersion: "1.0.0" }));

        assert.equal((yield* currentServiceUpdateState).status, "idle");
        assert.equal(harness.state.discardCalls, 1);
        assert.equal(harness.state.handoffCalls, 0);
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("adopts and hands off, then commit makes cancel too-late", () => {
  const harness = makeHarness();
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* scheduler.beginAttempt({ currentVersion: "1.0.0" });
        expect(harness.state.order).toEqual(["adopt", "handoff"]);
        assert.equal((yield* currentServiceUpdateState).status, "activating");
        const cancel = yield* scheduler.cancelCurrent();
        assert.isFalse(cancel.cancelled);
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect(
  "definite launcher rejection replays the drain, releases authority, and can retry",
  () => {
    const harness = makeHarness({ handoffFailure: "rejected-before-acceptance" });
    return harness
      .run(
        Effect.gen(function* () {
          const scheduler = yield* ServiceUpdateScheduler;
          yield* Effect.exit(scheduler.beginAttempt({ currentVersion: "1.0.0" }));
          expect(harness.state.adoptCalls).toBe(1);
          expect(harness.state.handoffAttempts).toBe(1);
          expect(harness.state.handoffCalls).toBe(0);
          expect(harness.state.order).toEqual(["adopt", "handoff"]);
          expect(harness.state.replayCalls).toBe(1);
          expect(harness.state.releaseCalls).toBe(1);
          assert.isFalse(harness.state.reservationActive);
          assert.equal((yield* currentServiceUpdateState).status, "idle");

          delete harness.state.handoffFailure;
          yield* scheduler.beginAttempt({ currentVersion: "1.0.0" });
          assert.equal(harness.state.reserveCalls, 2);
          assert.equal(harness.state.checkCalls, 2);
          assert.equal(harness.state.stageCalls, 2);
          assert.equal(harness.state.adoptCalls, 2);
          assert.equal(harness.state.handoffAttempts, 2);
          const lateCancel = yield* scheduler.cancelCurrent();
          assert.isFalse(lateCancel.cancelled);
          assert.equal((yield* currentServiceUpdateState).status, "activating");
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
  },
);

it.effect("a disconnect after definite rejection still reopens the native queue", () => {
  const harness = makeLatchedHarness({
    handoffFailure: "rejected-before-acceptance",
    holdFinalQuiescence: true,
  });
  return harness
    .run(
      Effect.gen(function* () {
        yield* harness.setup;
        const scheduler = yield* ServiceUpdateScheduler;
        const attemptFiber = yield* driveTo(scheduler, harness, "handoff");
        yield* Deferred.succeed(harness.latches().releaseHandoff, undefined);
        yield* Deferred.await(harness.latches().finalQuiescenceReturned);

        assert.equal(harness.state.releaseCalls, 0);
        assert.isTrue(harness.state.reservationActive);

        const interruptor = yield* Effect.forkChild(Fiber.interrupt(attemptFiber), {
          startImmediately: true,
        });
        yield* Fiber.join(interruptor);
        const attemptExit = yield* Fiber.await(attemptFiber);
        assert.equal(harness.state.replayCalls, 1);
        assert.equal(harness.state.releaseCalls, 1);
        assert.isFalse(harness.state.reservationActive);
        assert.equal((yield* currentServiceUpdateState).status, "idle");
        assert.isTrue(Exit.isFailure(attemptExit));
        if (Exit.isFailure(attemptExit)) {
          assert.isTrue(Cause.hasInterruptsOnly(attemptExit.cause));
        }
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("unknown launcher acceptance holds authority and suppresses later attempts", () => {
  const harness = makeHarness({ handoffFailure: "acceptance-unknown" });
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* Effect.exit(scheduler.beginAttempt({ currentVersion: "1.0.0" }));
        assert.equal((yield* currentServiceUpdateState).status, "activating");
        assert.equal(harness.state.reserveCalls, 1);
        assert.equal(harness.state.checkCalls, 1);
        assert.equal(harness.state.stageCalls, 1);
        assert.equal(harness.state.adoptCalls, 1);
        assert.equal(harness.state.handoffAttempts, 1);
        assert.equal(harness.state.releaseCalls, 0);
        assert.isTrue(harness.state.reservationActive);

        const laterAttempt = yield* Effect.result(
          scheduler.beginAttempt({ currentVersion: "1.0.0" }),
        );
        assert.equal(laterAttempt._tag, "Failure");
        if (laterAttempt._tag === "Failure") {
          assert.instanceOf(laterAttempt.failure, ServiceUpdateAttemptBusyError);
        }
        assert.equal(harness.state.reserveCalls, 2);
        assert.equal(harness.state.checkCalls, 1);
        assert.equal(harness.state.stageCalls, 1);
        assert.equal(harness.state.adoptCalls, 1);
        assert.equal(harness.state.handoffAttempts, 1);
        assert.equal(harness.state.releaseCalls, 0);
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("a check with no release publishes idle service-update state", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(PINNED_AT));
    const harness = makeHarness({ noCandidate: true });
    try {
      yield* harness.run(
        Effect.gen(function* () {
          const scheduler = yield* ServiceUpdateScheduler;
          yield* scheduler.beginAttempt({ currentVersion: "1.0.0" });

          assert.isFalse(harness.state.reservationActive);
          assert.equal(harness.state.releaseCalls, 1);
          const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
          const serviceUpdate = (yield* lifecycleEvents.snapshot).events.find(
            (event) => event.type === "serviceUpdate",
          );
          assert.isDefined(serviceUpdate);
          if (serviceUpdate?.type === "serviceUpdate") {
            assert.deepEqual(serviceUpdate.payload, { status: "idle" });
          }
        }),
      );
    } finally {
      harness.dispose();
    }
  }),
);

it.effect("an unsupported runtime publishes idle service-update state", () => {
  const harness = makeHarness({
    availability: { status: "unsupported", reason: "unmanaged" },
  });
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* scheduler.beginAttempt({ currentVersion: "1.0.0" });
        // Unsupported runtime attempts do not create a visible update state.
        assert.equal((yield* currentServiceUpdateState).status, "idle");
        const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
        const serviceUpdate = (yield* lifecycleEvents.snapshot).events.find(
          (event) => event.type === "serviceUpdate",
        );
        assert.isDefined(serviceUpdate);
        if (serviceUpdate?.type === "serviceUpdate") {
          assert.deepEqual(serviceUpdate.payload, { status: "idle" });
        }
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("handoff acceptance publishes activating, not ready", () => {
  const harness = makeHarness();
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* scheduler.beginAttempt({ currentVersion: "1.0.0" });
        assert.equal((yield* currentServiceUpdateState).status, "activating");
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

// ---------------------------------------------------------------------------
// Latched harness: every irreversible side effect parks on a Deferred so the
// tests interleave cancellation and subscription deterministically — latches,
// never sleeps.
// ---------------------------------------------------------------------------

interface LatchSet {
  readonly stageStarted: Deferred.Deferred<void>;
  readonly releaseStage: Deferred.Deferred<void>;
  readonly quiesceStarted: Deferred.Deferred<void>;
  readonly releaseQuiesce: Deferred.Deferred<void>;
  readonly adoptStarted: Deferred.Deferred<void>;
  readonly releaseAdopt: Deferred.Deferred<void>;
  readonly handoffStarted: Deferred.Deferred<void>;
  readonly releaseHandoff: Deferred.Deferred<void>;
  readonly finalQuiescenceReturned: Deferred.Deferred<void>;
  readonly releaseFinalQuiescence: Deferred.Deferred<void>;
}

const makeLatchedHarness = (
  overrides: {
    readonly adoptFails?: boolean;
    readonly handoffFailure?: boolean | "rejected-before-acceptance" | "unavailable";
    readonly handoffUpdateId?: string;
    readonly holdFinalQuiescence?: boolean;
  } = {},
) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scheduler-latched-"));
  const runtimeDirectory = NodePath.join(tempDir, "runtime");
  NodeFS.mkdirSync(runtimeDirectory);
  const state = {
    attemptId: undefined as string | undefined,
    adoptCalls: 0,
    handoffCalls: 0,
    discardCalls: 0,
    reserveCalls: 0,
    releaseCalls: 0,
    reservationActive: false,
    replayCalls: 0,
    order: [] as string[],
  };
  const box: {
    latches?: LatchSet;
    observations?: Queue.Queue<ServiceUpdateDrainObservation>;
  } = {};

  const setup = Effect.gen(function* () {
    box.latches = {
      stageStarted: yield* Deferred.make<void>(),
      releaseStage: yield* Deferred.make<void>(),
      quiesceStarted: yield* Deferred.make<void>(),
      releaseQuiesce: yield* Deferred.make<void>(),
      adoptStarted: yield* Deferred.make<void>(),
      releaseAdopt: yield* Deferred.make<void>(),
      handoffStarted: yield* Deferred.make<void>(),
      releaseHandoff: yield* Deferred.make<void>(),
      finalQuiescenceReturned: yield* Deferred.make<void>(),
      releaseFinalQuiescence: yield* Deferred.make<void>(),
    };
    box.observations = yield* Queue.unbounded<ServiceUpdateDrainObservation>();
  });

  const source = Layer.succeed(ServiceUpdateSource, {
    check: () => Effect.succeed({ version: "1.1.0" } as never),
    resolveTargetVersion: () =>
      Effect.fail(
        new ServiceUpdateOperationError({
          stage: "source",
          code: "unavailable",
          cause: "unexpected explicit-version lookup",
        }),
      ),
    stage: (_input, reportProgress) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(box.latches!.stageStarted, undefined);
        yield* reportProgress({ downloadedBytes: 512, totalBytes: 1024 });
        yield* Deferred.await(box.latches!.releaseStage);
        return staged;
      }),
    discard: () =>
      Effect.sync(() => {
        state.discardCalls += 1;
      }),
  });

  const runtime = Layer.succeed(ServiceUpdateRuntime, {
    availability: Effect.succeed({ status: "supported" } as const),
    captureSource: ({ fromVersion }) =>
      Effect.succeed({
        databaseIdentity: NodePath.join(tempDir, "db.sqlite"),
        fromVersion,
      }),
    adopt: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(box.latches!.adoptStarted, undefined);
        state.adoptCalls += 1;
        state.order.push("adopt");
        if (overrides.adoptFails === true) {
          return yield* Effect.fail(
            new ServiceUpdateOperationError({
              stage: "runtime",
              code: "io",
              cause: "adoption failed",
            }),
          );
        }
        yield* Deferred.await(box.latches!.releaseAdopt);
      }),
    requestHandoff: () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(box.latches!.handoffStarted, undefined);
        yield* Deferred.await(box.latches!.releaseHandoff);
        if (overrides.handoffFailure !== undefined && overrides.handoffFailure !== false) {
          return yield* Effect.fail(
            new ServiceUpdateOperationError({
              stage: "authority",
              code:
                overrides.handoffFailure === true ? "acceptance-unknown" : overrides.handoffFailure,
              cause: "handoff acknowledgement was lost",
            }),
          );
        }
        state.handoffCalls += 1;
        state.order.push("handoff");
        return { updateId: overrides.handoffUpdateId ?? "native-1" };
      }),
  });

  let quiescencePass = 0;
  const drain = makeNativeDrainLayer(
    state,
    Stream.unwrap(Effect.sync(() => Stream.fromQueue(box.observations!))),
    () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(box.latches!.quiesceStarted, undefined);
        yield* Deferred.await(box.latches!.releaseQuiesce);
      }),
    () => {
      quiescencePass += 1;
      if (overrides.holdFinalQuiescence !== true || quiescencePass !== 2) {
        return Effect.void;
      }
      return Deferred.succeed(box.latches!.finalQuiescenceReturned, undefined).pipe(
        Effect.andThen(Deferred.await(box.latches!.releaseFinalQuiescence)),
      );
    },
  );

  const authority = Layer.succeed(UpdateAuthority, {
    reserve: (input) => {
      state.reserveCalls += 1;
      state.attemptId = input.attemptId ?? "manual";
      state.reservationActive = true;
      return Effect.succeed({
        _tag: "owned",
        lease: {
          owner: "scheduled",
          attemptId: (input.attemptId ?? "manual") as ServiceUpdateAttemptId,
          enterIrreversible: Effect.void,
          release: Effect.sync(() => {
            state.releaseCalls += 1;
            state.reservationActive = false;
            return "released" as const;
          }),
        } satisfies UpdateAuthorityLease,
      });
    },
  });

  const databasePath = NodePath.join(tempDir, "db.sqlite");
  const databaseLayer = NodeSqliteClient.layer({ filename: databasePath });
  const nativeRuntimeLayer = Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      { name: "service-update-scheduler-latched" },
      emptyProviderRegistry,
      {
        databaseLayer,
        runEffectWorker: false,
      },
    ),
    EffectOutbox.layer.pipe(Layer.provide(databaseLayer)),
    ProjectStore.layer.pipe(Layer.provide(databaseLayer)),
    databaseLayer,
  );
  const layer = ServiceUpdateSchedulerLive.pipe(
    Layer.provide(Layer.mergeAll(source, runtime, drain, authority)),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(ServerConfig.layerTest(process.cwd(), tempDir)),
    Layer.provideMerge(nativeRuntimeLayer),
  ).pipe(Layer.provideMerge(ServerLifecycleEvents.layer), Layer.provideMerge(NodeServices.layer));

  const finishAttempt = Effect.gen(function* () {
    const l = box.latches!;
    yield* Deferred.succeed(l.releaseQuiesce, undefined);
    yield* Deferred.await(l.adoptStarted);
    yield* Deferred.succeed(l.releaseAdopt, undefined);
    yield* Deferred.await(l.handoffStarted);
    yield* Deferred.succeed(l.releaseHandoff, undefined);
  });

  return {
    state,
    databasePath,
    setup,
    finishAttempt,
    latches: () => box.latches!,
    emitObservation: (observation: ServiceUpdateDrainObservation) =>
      Queue.offer(box.observations!, observation),
    dispose: () => NodeFS.rmSync(tempDir, { recursive: true, force: true }),
    run: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const migrationContext = yield* Layer.build(
            NodeSqliteClient.layer({ filename: databasePath }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          );
          yield* runMigrations().pipe(Effect.provide(migrationContext));
          const context = yield* Layer.build(layer);
          return yield* Effect.provide(effect, context);
        }),
      ) as Effect.Effect<A, E>,
  };
};

/** Drive one latched attempt up to a chosen point, leaving it parked there. */
const driveTo = (
  scheduler: ServiceUpdateSchedulerShape,
  harness: ReturnType<typeof makeLatchedHarness>,
  stopAt: "stage" | "quiesce" | "adopt" | "handoff",
) =>
  Effect.gen(function* () {
    const attemptFiber = yield* Effect.forkChild(
      Effect.ignore(scheduler.beginAttempt({ currentVersion: "1.0.0" })),
    );
    const l = harness.latches();
    yield* Deferred.await(l.stageStarted);
    if (stopAt === "stage") return attemptFiber;
    yield* Deferred.succeed(l.releaseStage, undefined);
    yield* Deferred.await(l.quiesceStarted);
    if (stopAt === "quiesce") return attemptFiber;
    yield* Deferred.succeed(l.releaseQuiesce, undefined);
    yield* Deferred.await(l.adoptStarted);
    if (stopAt === "adopt") return attemptFiber;
    yield* Deferred.succeed(l.releaseAdopt, undefined);
    yield* Deferred.await(l.handoffStarted);
    return attemptFiber;
  });

it.effect("cancel during staging wakes deterministically and skips adoption and handoff", () => {
  const harness = makeLatchedHarness();
  return harness
    .run(
      Effect.gen(function* () {
        yield* harness.setup;
        const scheduler = yield* ServiceUpdateScheduler;
        const attemptFiber = yield* driveTo(scheduler, harness, "stage");
        const cancel = yield* scheduler.cancelCurrent();
        assert.isTrue(cancel.cancelled);
        // Deterministic wake: the attempt resolves without releasing the
        // stage latch — cancellation is observed mid-staging, not after the
        // whole drain.
        yield* Fiber.join(attemptFiber);
        expect(harness.state.order).not.toContain("stop");
        expect(harness.state.order).not.toContain("adopt");
        expect(harness.state.order).not.toContain("handoff");
        assert.equal((yield* currentServiceUpdateState).status, "idle");
        const secondCancel = yield* scheduler.cancelCurrent();
        assert.isFalse(secondCancel.cancelled);
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("cancelling a release check aborts fetch before cancel resolves", () =>
  Effect.gen(function* () {
    const requestStarted = yield* Deferred.make<void>();
    let requestSignal: AbortSignal | undefined;
    const fetch = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestSignal = init?.signal ?? undefined;
        const signal = requestSignal;
        const onAbort = () => reject(new DOMException("fetch aborted", "AbortError"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        Deferred.doneUnsafe(requestStarted, Effect.succeed(undefined));
      })) as typeof globalThis.fetch;
    const harness = makeHarness(
      {},
      {
        source: (baseDir) => {
          const source = makeServiceUpdateSource({ fetch, baseDir });
          return {
            ...source,
            check: ({ currentVersion }) =>
              source.check({ repository: "owner/repo", currentVersion }),
          };
        },
      },
    );

    try {
      yield* harness.run(
        Effect.gen(function* () {
          const scheduler = yield* ServiceUpdateScheduler;
          const attemptFiber = yield* Effect.forkChild(
            Effect.ignore(scheduler.beginAttempt({ currentVersion: "1.0.0-f8y.20260101.1" })),
          );
          yield* Deferred.await(requestStarted);
          const cancel = yield* scheduler.cancelCurrent().pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                assert.isTrue(result.cancelled);
                assert.isDefined(requestSignal);
                assert.isTrue(requestSignal!.aborted);
              }),
            ),
          );
          assert.isTrue(cancel.cancelled);
          yield* Fiber.join(attemptFiber);

          assert.equal((yield* currentServiceUpdateState).status, "idle");
        }),
      );
    } finally {
      harness.dispose();
    }
  }),
);

it.effect("cancelling a staged attempt discards its source artifact before adoption", () => {
  const harness = makeLatchedHarness();
  return harness
    .run(
      Effect.gen(function* () {
        yield* harness.setup;
        const scheduler = yield* ServiceUpdateScheduler;
        const attemptFiber = yield* driveTo(scheduler, harness, "quiesce");
        const cancel = yield* scheduler.cancelCurrent();
        assert.isTrue(cancel.cancelled);
        yield* Fiber.join(attemptFiber);

        assert.equal(harness.state.discardCalls, 1);
        assert.equal(harness.state.adoptCalls, 0);
        assert.equal(harness.state.handoffCalls, 0);
        assert.equal((yield* currentServiceUpdateState).status, "idle");
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect("cancel during adoption returns cancelled and never commits a handoff", () => {
  const harness = makeLatchedHarness();
  return harness
    .run(
      Effect.gen(function* () {
        yield* harness.setup;
        const scheduler = yield* ServiceUpdateScheduler;
        const attemptFiber = yield* driveTo(scheduler, harness, "adopt");
        const cancel = yield* scheduler.cancelCurrent();
        assert.isTrue(cancel.cancelled);
        yield* Deferred.succeed(harness.latches().releaseAdopt, undefined);
        yield* Fiber.join(attemptFiber);
        // A `cancelled` response is never followed by a handoff.
        assert.equal(harness.state.adoptCalls, 1);
        assert.equal(harness.state.handoffCalls, 0);
        assert.equal(harness.state.discardCalls, 1);
        expect(harness.state.order).not.toContain("handoff");
        assert.equal((yield* currentServiceUpdateState).status, "idle");
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

it.effect(
  "cancel after the commit decision is too-late and status is truthfully non-cancellable",
  () => {
    const harness = makeLatchedHarness();
    return harness
      .run(
        Effect.gen(function* () {
          yield* harness.setup;
          const scheduler = yield* ServiceUpdateScheduler;
          const attemptFiber = yield* driveTo(scheduler, harness, "handoff");
          const cancel = yield* scheduler.cancelCurrent();
          assert.isFalse(cancel.cancelled);
          assert.equal((yield* currentServiceUpdateState).status, "activating");
          yield* Deferred.succeed(harness.latches().releaseHandoff, undefined);
          yield* Fiber.join(attemptFiber);
          assert.equal((yield* currentServiceUpdateState).status, "activating");
          const lateCancel = yield* scheduler.cancelCurrent();
          assert.isFalse(lateCancel.cancelled);
        }),
      )
      .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
  },
);

it.effect("failed pre-commit attempts report not-current", () => {
  const harness = makeHarness({ adoptFails: true });
  return harness
    .run(
      Effect.gen(function* () {
        const scheduler = yield* ServiceUpdateScheduler;
        yield* Effect.exit(scheduler.beginAttempt({ currentVersion: "1.0.0" }));
        const cancel = yield* scheduler.cancelCurrent();
        assert.isFalse(cancel.cancelled);
      }),
    )
    .pipe(Effect.ensuring(Effect.sync(harness.dispose)));
});

// ---------------------------------------------------------------------------
// Production trigger and idle next-fire bookkeeping. Driven with `TestClock`
// and per-tick latches (queue offers) — never sleeps or polling.
// ---------------------------------------------------------------------------

/** `layerTest` settings whose `getSettings` signals every trigger tick. */
const makeTickSettings = (
  serviceUpdateRepository: string,
  ticks: Queue.Queue<void>,
): ReturnType<typeof ServerSettingsService.layerTest> =>
  Layer.effect(
    ServerSettingsService,
    Effect.map(ServerSettingsService, (settings) => ({
      ...settings,
      getSettings: settings.getSettings.pipe(Effect.tap(() => Queue.offer(ticks, undefined))),
    })),
  ).pipe(Layer.provide(ServerSettingsService.layerTest({ serviceUpdateRepository })));

it.effect("the periodic trigger begins an attempt only when a repository is configured", () =>
  Effect.gen(function* () {
    const checks = yield* Queue.unbounded<void>();
    const configured = makeHarness(
      { noCandidate: true, onCheck: () => Queue.offer(checks, undefined) },
      {
        settings: ServerSettingsService.layerTest({
          serviceUpdateRepository: "pingdotgg/t3code",
        }),
      },
    );
    try {
      yield* configured.run(
        Effect.gen(function* () {
          // The first tick fires as soon as the trigger is forked.
          yield* Queue.take(checks);
          expect(configured.state.checkCalls).toBe(1);
          yield* TestClock.adjust("15 minutes");
          yield* Queue.take(checks);
          expect(configured.state.checkCalls).toBe(2);
        }),
      );
    } finally {
      configured.dispose();
    }

    const ticks = yield* Queue.unbounded<void>();
    const unconfigured = makeHarness({}, { settings: makeTickSettings("", ticks) });
    try {
      yield* unconfigured.run(
        Effect.gen(function* () {
          yield* Queue.take(ticks);
          expect(unconfigured.state.checkCalls).toBe(0);
          yield* TestClock.adjust("15 minutes");
          yield* Queue.take(ticks);
          expect(unconfigured.state.checkCalls).toBe(0);
        }),
      );
    } finally {
      unconfigured.dispose();
    }
  }),
);
