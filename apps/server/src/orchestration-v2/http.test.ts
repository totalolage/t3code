import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  EnvironmentHttpApi,
  EnvironmentThreadCompactionError,
  MessageId,
  NodeId,
  type OrchestrationCliSnapshot,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type ApplicationProjectEvent,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as EnvironmentHttpAuth from "../auth/http.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as OrchestrationEventStoreService from "../persistence/OrchestrationEventStore.ts";
import * as HttpCreateOperations from "../persistence/OrchestrationHttpCreateOperations.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStore from "./EventStore.ts";
import * as ManualThreadCompaction from "./ManualThreadCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PendingInteractionService from "./PendingInteractionService.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as OrchestrationHttp from "./http.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const THREAD_ID = ThreadId.make("http-cli-send-thread");
const PROJECT_ID = ProjectId.make("http-cli-send-project");
const DELETED_PROJECT_ID = ProjectId.make("http-cli-send-deleted-project");
const PROVIDER_ID = ProviderInstanceId.make("codex");
const SESSION_ID = AuthSessionId.make("http-cli-send-session");
const COMMAND_ID = CommandId.make("cli-send:http-test-command");
const MESSAGE = "  send through the native service\n";
const TestHttpApi = HttpApi.make("environment").add(EnvironmentHttpApi.groups.orchestration);
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

type Fixture = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly sendCalls: () => number;
  readonly projectionReadFailures: () => number;
  readonly receiptReadFailures: () => number;
  readonly snapshotSequence: () => number | undefined;
  readonly waitForSendCalls: (count: number) => Promise<void>;
  readonly dispatchedCommands: () => ReadonlyArray<OrchestrationV2ServerCommand>;
};

const threadCreateCommand: OrchestrationV2Command = {
  type: "thread.create",
  commandId: CommandId.make("http-cli-send-seed-thread"),
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  title: "HTTP CLI send",
  modelSelection: { instanceId: PROVIDER_ID, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdBy: "user",
  creationSource: "web",
};

const projectCreatedEvent = (projectId: ProjectId, title: string): ApplicationProjectEvent => ({
  sequence: 0,
  eventId: EventId.make(`http-cli-${projectId}-created`),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: "2026-10-06T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.created",
  payload: {
    projectId,
    title,
    workspaceRoot: `/tmp/${projectId}`,
    defaultModelSelection: { instanceId: PROVIDER_ID, model: "gpt-5.4" },
    scripts: [],
    createdAt: "2026-10-06T00:00:00.000Z",
    updatedAt: "2026-10-06T00:00:00.000Z",
  },
});

const projectDeletedEvent = (projectId: ProjectId): ApplicationProjectEvent => ({
  sequence: 1,
  eventId: EventId.make(`http-cli-${projectId}-deleted`),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: "2026-10-06T00:01:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.deleted",
  payload: { projectId, deletedAt: "2026-10-06T00:01:00.000Z" },
});

const makeFixture = (
  options: {
    readonly scope?: "operate" | "read" | "both";
    readonly failPostDispatchProjection?: boolean;
    readonly failReceiptReadAfterProjectionFailure?: boolean;
    readonly seedWrongTypeReceipt?: boolean;
    readonly synchronizeReceiptPreflight?: boolean;
    readonly concurrentArchiveDuplicate?: boolean;
    readonly concurrentDeleteAtShellLookup?: boolean;
    readonly compactError?: "invalid" | "not-found" | "compaction" | "unexpected";
    readonly pendingResponseError?: "unavailable" | "invalid" | "conflict" | "unexpected";
    readonly seedProjects?: boolean;
    readonly seedThread?: boolean;
    readonly seedHiddenArchivedDeletedThread?: boolean;
    readonly seedCheckpointHistory?: boolean;
    readonly seedProviderSwitchHistory?: boolean;
  } = {},
): Fixture => {
  const state = {
    sendCalls: 0,
    concurrentReceiptPreflightReads: 0,
    receiptReadFailures: 0,
    messageDispatchCommitted: false,
    postDispatchProjectionFailed: false,
    projectionReadFailures: 0,
    snapshotSequence: undefined as number | undefined,
    dispatchedCommands: [] as Array<OrchestrationV2ServerCommand>,
  };
  let releaseFirstConcurrentSend = () => {};
  const firstConcurrentSendDone = new Promise<void>((resolve) => {
    releaseFirstConcurrentSend = resolve;
  });
  let notifySecondSend = () => {};
  const secondSendStarted = new Promise<void>((resolve) => {
    notifySecondSend = resolve;
  });
  let releaseSecondSend = () => {};
  const secondSendGate = new Promise<void>((resolve) => {
    releaseSecondSend = resolve;
  });
  let releaseConcurrentReceiptPreflight = () => {};
  const concurrentReceiptPreflight = new Promise<void>((resolve) => {
    releaseConcurrentReceiptPreflight = resolve;
  });
  const sendCallWaiters = new Map<number, () => void>();
  const waitForSendCalls = (count: number) =>
    state.sendCalls >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => sendCallWaiters.set(count, resolve));
  const database = layerMemory;
  const serverRuntimeServices = ServerConfig.layerTest(process.cwd(), {
    prefix: "http-cli-runtime-",
  }).pipe(Layer.provideMerge(NodeServices.layer));
  const projectionStore = ProjectionStore.layer.pipe(Layer.provideMerge(database));
  const adapter: ProviderAdapter.ProviderAdapterV2Shape = {
    instanceId: PROVIDER_ID,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("The HTTP send test does not start a provider session."),
  };
  const registry = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
    get: () => Effect.succeed(adapter),
    list: () => Effect.succeed([PROVIDER_ID]),
  });
  const core = ProviderReplayHarness.layerWithRegistry({ name: "http-cli-send" }, registry, {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const instrumentedCore = Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.gen(function* () {
      const native = yield* Orchestrator.OrchestratorV2;
      const dispatch: Orchestrator.OrchestratorV2["Service"]["dispatch"] = (command) =>
        Effect.sync(() => state.dispatchedCommands.push(command)).pipe(
          Effect.andThen(native.dispatch(command)),
          Effect.tap(() =>
            command.type === "message.dispatch"
              ? Effect.sync(() => {
                  state.messageDispatchCommitted = true;
                })
              : Effect.void,
          ),
        );
      const getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"] = (
        threadId,
        fields,
        filter,
      ) => {
        if (
          options.failPostDispatchProjection === true &&
          state.messageDispatchCommitted &&
          !state.postDispatchProjectionFailed &&
          fields.some((field) => field === "messages")
        ) {
          state.postDispatchProjectionFailed = true;
          state.projectionReadFailures += 1;
          return Effect.fail(
            new Orchestrator.OrchestratorProjectionError({
              threadId,
              cause: new Error("synthetic post-dispatch projection read failure"),
            }),
          );
        }
        return native.getThreadRecords(threadId, fields, filter);
      };
      return Orchestrator.OrchestratorV2.of({ ...native, dispatch, getThreadRecords });
    }),
  ).pipe(Layer.provideMerge(core));
  const seededCore = Layer.effectDiscard(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      if (options.seedProjects === true) {
        const projects = yield* ProjectStore.ProjectStoreV2;
        yield* projects.apply(projectCreatedEvent(PROJECT_ID, "Active project"));
        yield* projects.apply(projectCreatedEvent(DELETED_PROJECT_ID, "Deleted project"));
        yield* projects.apply(projectDeletedEvent(DELETED_PROJECT_ID));
      }
      if (options.seedThread !== false) yield* orchestrator.dispatch(threadCreateCommand);
      if (options.seedCheckpointHistory === true) {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const records = yield* orchestrator.getThreadRecords(THREAD_ID, []);
        const providerThreadId = ProviderThreadId.make("http-cli-rollback-provider-thread");
        const previousProviderThreadId = ProviderThreadId.make(
          "http-cli-rollback-previous-provider-thread",
        );
        const now = DateTime.makeUnsafe("2026-10-06T00:02:00.000Z");
        if (options.seedProviderSwitchHistory === true) {
          yield* projections.apply({
            id: EventId.make("http-cli-rollback-previous-provider-thread"),
            type: "provider-thread.updated",
            threadId: THREAD_ID,
            providerInstanceId: records.thread.modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: previousProviderThreadId,
              driver: ProviderDriverKind.make("codex"),
              providerInstanceId: records.thread.modelSelection.instanceId,
              providerSessionId: null,
              appThreadId: THREAD_ID,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 3,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: null,
              createdAt: now,
              updatedAt: now,
            },
          } satisfies OrchestrationV2DomainEvent);
        }
        yield* projections.apply({
          id: EventId.make("http-cli-rollback-provider-thread"),
          type: "provider-thread.updated",
          threadId: THREAD_ID,
          providerInstanceId: records.thread.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: records.thread.modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: THREAD_ID,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: options.seedProviderSwitchHistory === true ? 4 : 1,
            lastRunOrdinal: 4,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            createdAt: now,
            updatedAt: now,
          },
        } satisfies OrchestrationV2DomainEvent);
        yield* projections.apply({
          id: EventId.make("http-cli-rollback-active-provider-thread"),
          type: "thread.provider-switched",
          threadId: THREAD_ID,
          providerInstanceId: records.thread.modelSelection.instanceId,
          occurredAt: now,
          payload: { ...records.thread, activeProviderThreadId: providerThreadId, updatedAt: now },
        } satisfies OrchestrationV2DomainEvent);
        const scopeId = CheckpointScopeId.make("http-cli-rollback-root-scope");
        const previousScopeId = CheckpointScopeId.make(
          "http-cli-rollback-previous-provider-root-scope",
        );
        const baselineId = CheckpointId.make("http-cli-rollback-baseline");
        const previousBaselineId = CheckpointId.make("http-cli-rollback-previous-baseline");
        const firstCheckpointId = CheckpointId.make("http-cli-rollback-user-run-1");
        const rolledBackCheckpointId = CheckpointId.make("http-cli-rollback-user-run-3");
        const secondCheckpointId = CheckpointId.make("http-cli-rollback-user-run-4");
        const firstRunId = RunId.make("http-cli-rollback-user-run-1");
        const maintenanceRunId = RunId.make("http-cli-rollback-compaction-run-2");
        const rolledBackRunId = RunId.make("http-cli-rollback-user-run-3");
        const secondRunId = RunId.make("http-cli-rollback-user-run-4");
        const firstNodeId = NodeId.make("http-cli-rollback-user-node-1");
        const maintenanceNodeId = NodeId.make("http-cli-rollback-compaction-node-2");
        const rolledBackNodeId = NodeId.make("http-cli-rollback-user-node-3");
        const secondNodeId = NodeId.make("http-cli-rollback-user-node-4");
        const applyUserRun = (input: {
          readonly id: RunId;
          readonly ordinal: number;
          readonly nodeId: NodeId;
          readonly status: "completed" | "rolled_back";
          readonly userMessageId: MessageId;
          readonly checkpointId: CheckpointId;
          readonly providerThreadId?: ProviderThreadId;
        }) =>
          projections.apply({
            id: EventId.make(`http-cli-rollback-run-${input.ordinal}`),
            type: "run.updated",
            threadId: THREAD_ID,
            runId: input.id,
            nodeId: input.nodeId,
            providerInstanceId: records.thread.modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: input.id,
              threadId: THREAD_ID,
              ordinal: input.ordinal,
              providerInstanceId: records.thread.modelSelection.instanceId,
              modelSelection: records.thread.modelSelection,
              providerThreadId: input.providerThreadId ?? providerThreadId,
              rootNodeId: input.nodeId,
              activeAttemptId: null,
              status: input.status,
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              checkpointId: input.checkpointId,
              contextHandoffId: null,
              purpose: "user",
              userMessageId: input.userMessageId,
            },
          } satisfies OrchestrationV2DomainEvent);
        yield* applyUserRun({
          id: firstRunId,
          ordinal: 1,
          nodeId: firstNodeId,
          status: "completed",
          userMessageId: MessageId.make("http-cli-rollback-user-message-1"),
          checkpointId: firstCheckpointId,
          ...(options.seedProviderSwitchHistory === true
            ? { providerThreadId: previousProviderThreadId }
            : {}),
        });
        yield* projections.apply({
          id: EventId.make("http-cli-rollback-compaction-run"),
          type: "run.updated",
          threadId: THREAD_ID,
          runId: maintenanceRunId,
          nodeId: maintenanceNodeId,
          providerInstanceId: records.thread.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: maintenanceRunId,
            threadId: THREAD_ID,
            ordinal: 2,
            providerInstanceId: records.thread.modelSelection.instanceId,
            modelSelection: records.thread.modelSelection,
            providerThreadId:
              options.seedProviderSwitchHistory === true
                ? previousProviderThreadId
                : providerThreadId,
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
            purpose: "compaction",
            requestCommandId: CommandId.make("http-cli-rollback-compaction-command"),
          },
        } satisfies OrchestrationV2DomainEvent);
        yield* applyUserRun({
          id: rolledBackRunId,
          ordinal: 3,
          nodeId: rolledBackNodeId,
          status: "rolled_back",
          userMessageId: MessageId.make("http-cli-rollback-user-message-3"),
          checkpointId: rolledBackCheckpointId,
          ...(options.seedProviderSwitchHistory === true
            ? { providerThreadId: previousProviderThreadId }
            : {}),
        });
        yield* applyUserRun({
          id: secondRunId,
          ordinal: 4,
          nodeId: secondNodeId,
          status: "completed",
          userMessageId: MessageId.make("http-cli-rollback-user-message-4"),
          checkpointId: secondCheckpointId,
        });
        yield* projections.apply({
          id: EventId.make("http-cli-rollback-root-scope"),
          type: "checkpoint-scope.created",
          threadId: THREAD_ID,
          runId: secondRunId,
          nodeId: secondNodeId,
          providerInstanceId: records.thread.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId: THREAD_ID,
            runId: secondRunId,
            nodeId: secondNodeId,
            parentScopeId: null,
            providerThreadId,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: `/tmp/${PROJECT_ID}`,
            createdAt: now,
          },
        } satisfies OrchestrationV2DomainEvent);
        if (options.seedProviderSwitchHistory === true) {
          yield* projections.apply({
            id: EventId.make("http-cli-rollback-previous-provider-root-scope"),
            type: "checkpoint-scope.created",
            threadId: THREAD_ID,
            runId: firstRunId,
            nodeId: firstNodeId,
            providerInstanceId: records.thread.modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: previousScopeId,
              threadId: THREAD_ID,
              runId: firstRunId,
              nodeId: firstNodeId,
              parentScopeId: null,
              providerThreadId: previousProviderThreadId,
              kind: "root_run",
              ordinalWithinParent: 0,
              advancesAppRunCount: true,
              cwd: `/tmp/${PROJECT_ID}`,
              createdAt: now,
            },
          } satisfies OrchestrationV2DomainEvent);
        }
        const applyCheckpoint = (input: {
          readonly id: CheckpointId;
          readonly scopeId?: CheckpointScopeId;
          readonly runId: RunId | null;
          readonly nodeId: NodeId;
          readonly ordinalWithinScope: number;
          readonly appRunOrdinal: number | null;
          readonly parentCheckpointId: CheckpointId | null;
        }) =>
          projections.apply({
            id: EventId.make(
              `http-cli-rollback-checkpoint-${input.scopeId ?? scopeId}-${input.ordinalWithinScope}`,
            ),
            type: "checkpoint.captured",
            threadId: THREAD_ID,
            ...(input.runId === null ? {} : { runId: input.runId }),
            nodeId: input.nodeId,
            providerInstanceId: records.thread.modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: input.id,
              scopeId: input.scopeId ?? scopeId,
              threadId: THREAD_ID,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId: input.parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: CheckpointRef.make(
                `refs/t3/orchestration-v2/checkpoints/http-cli-rollback/${input.ordinalWithinScope}`,
              ),
              status: "ready",
              files: [],
              capturedAt: now,
            },
          } satisfies OrchestrationV2DomainEvent);
        yield* applyCheckpoint({
          id: baselineId,
          runId: null,
          nodeId: options.seedProviderSwitchHistory === true ? secondNodeId : firstNodeId,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          parentCheckpointId: null,
        });
        if (options.seedProviderSwitchHistory === true) {
          yield* applyCheckpoint({
            id: previousBaselineId,
            scopeId: previousScopeId,
            runId: null,
            nodeId: firstNodeId,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            parentCheckpointId: null,
          });
        }
        yield* applyCheckpoint({
          id: firstCheckpointId,
          ...(options.seedProviderSwitchHistory === true ? { scopeId: previousScopeId } : {}),
          runId: firstRunId,
          nodeId: firstNodeId,
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          parentCheckpointId:
            options.seedProviderSwitchHistory === true ? previousBaselineId : baselineId,
        });
        yield* applyCheckpoint({
          id: rolledBackCheckpointId,
          ...(options.seedProviderSwitchHistory === true ? { scopeId: previousScopeId } : {}),
          runId: rolledBackRunId,
          nodeId: rolledBackNodeId,
          ordinalWithinScope: 3,
          appRunOrdinal: 3,
          parentCheckpointId: firstCheckpointId,
        });
        yield* applyCheckpoint({
          id: secondCheckpointId,
          runId: secondRunId,
          nodeId: secondNodeId,
          ordinalWithinScope: 4,
          appRunOrdinal: 4,
          parentCheckpointId:
            options.seedProviderSwitchHistory === true ? baselineId : firstCheckpointId,
        });
      }
      if (options.seedHiddenArchivedDeletedThread === true) {
        yield* orchestrator.dispatch({
          type: "thread.hide",
          commandId: CommandId.make("http-cli-send-seed-hide"),
          threadId: THREAD_ID,
        });
        yield* orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("http-cli-send-seed-archive"),
          threadId: THREAD_ID,
        });
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("http-cli-send-seed-delete"),
          threadId: THREAD_ID,
        });
      }
      if (options.seedWrongTypeReceipt === true) {
        yield* orchestrator.dispatch({
          type: "thread.visit",
          commandId: COMMAND_ID,
          threadId: THREAD_ID,
          visitedAt: "2026-10-06T00:00:00.000Z",
        });
      }
    }),
  ).pipe(Layer.provideMerge(instrumentedCore), Layer.provideMerge(projectionStore));
  const threadManagementBase = ThreadManagementService.layer.pipe(Layer.provideMerge(seededCore));
  const manualCompaction = Layer.succeed(
    ManualThreadCompaction.ManualThreadCompaction,
    ManualThreadCompaction.ManualThreadCompaction.of({
      compact: (_sessionId, request) => {
        switch (options.compactError) {
          case "invalid":
            return Effect.fail(
              new ManualThreadCompaction.ManualCompactionInvalidRequestError({
                message: "The key is already bound to another command.",
              }),
            );
          case "not-found":
            return Effect.fail(
              new ManualThreadCompaction.ManualCompactionThreadNotFoundError({
                threadId: request.threadId,
              }),
            );
          case "compaction":
            return Effect.fail(
              new EnvironmentThreadCompactionError({
                code: "thread_compaction_failed",
                reason: "recovery-required",
                traceId: "http-test-trace",
              }),
            );
          case "unexpected":
            return Effect.die(new Error("synthetic unexpected compaction failure"));
          default:
            return Effect.die("Compaction is outside the HTTP send fixture.");
        }
      },
    }),
  );
  const pendingService = Layer.succeed(
    PendingInteractionService.PendingInteractionService,
    PendingInteractionService.PendingInteractionService.of({
      list: () => Effect.succeed({ interactions: [] }),
      respond: (input) => {
        switch (options.pendingResponseError) {
          case "unavailable":
            return Effect.fail(new PendingInteractionService.PendingInteractionUnavailableError());
          case "invalid":
            return Effect.fail(
              new PendingInteractionService.PendingInteractionInvalidResponseError({
                reason: "wrong_kind",
              }),
            );
          case "conflict":
            return Effect.fail(
              new PendingInteractionService.PendingInteractionInvalidResponseError({
                reason: "idempotency_conflict",
              }),
            );
          case "unexpected":
            return Effect.die(new Error("synthetic pending interaction response failure"));
          default:
            return Effect.succeed({
              threadId: input.threadId,
              requestId: input.requestId,
              status: "responding",
              action: input.action,
              idempotencyKey: input.idempotencyKey,
              replayed: false,
            });
        }
      },
    }),
  );
  const threadManagement = Layer.effect(
    ThreadManagementService.ThreadManagementService,
    Effect.gen(function* () {
      const native = yield* ThreadManagementService.ThreadManagementService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return ThreadManagementService.ThreadManagementService.of({
        ...native,
        sendToThread: (input) => {
          const ordinal = ++state.sendCalls;
          sendCallWaiters.get(ordinal)?.();
          sendCallWaiters.delete(ordinal);
          const send = native.sendToThread(input);
          if (options.concurrentDeleteAtShellLookup === true) {
            if (ordinal === 2) {
              notifySecondSend();
              return Effect.promise(() => secondSendGate).pipe(Effect.andThen(send));
            }
            return Effect.promise(() => secondSendStarted).pipe(
              Effect.andThen(send),
              Effect.flatMap((result) =>
                orchestrator
                  .dispatch({
                    type: "thread.delete",
                    commandId: CommandId.make("http-cli-send-concurrent-delete-at-shell"),
                    threadId: input.threadId,
                  })
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        releaseSecondSend();
                      }),
                    ),
                    Effect.as(result),
                  ),
              ),
            );
          }
          if (options.concurrentArchiveDuplicate !== true) return send;
          if (ordinal === 2) {
            return Effect.promise(() => firstConcurrentSendDone).pipe(Effect.andThen(send));
          }
          return send.pipe(
            Effect.flatMap((result) =>
              orchestrator
                .dispatch({
                  type: "thread.archive",
                  commandId: CommandId.make("http-cli-send-concurrent-archive"),
                  threadId: input.threadId,
                })
                .pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      releaseFirstConcurrentSend();
                    }),
                  ),
                  Effect.as(result),
                ),
            ),
          );
        },
      });
    }),
  ).pipe(Layer.provideMerge(threadManagementBase));
  const receiptBaseLayer = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const receiptLayer = Layer.effect(
    CommandReceiptStore.CommandReceiptStoreV2,
    Effect.gen(function* () {
      const native = yield* CommandReceiptStore.CommandReceiptStoreV2;
      return CommandReceiptStore.CommandReceiptStoreV2.of({
        ...native,
        getByCommandId: (commandId): ReturnType<typeof native.getByCommandId> => {
          if (
            options.failReceiptReadAfterProjectionFailure === true &&
            state.postDispatchProjectionFailed &&
            state.receiptReadFailures === 0
          ) {
            state.receiptReadFailures += 1;
            return Effect.fail(new CommandReceiptStore.CommandReceiptStoreReadError({ commandId }));
          }
          const receipt = native.getByCommandId(commandId);
          if (
            (options.concurrentArchiveDuplicate === true ||
              options.synchronizeReceiptPreflight === true) &&
            commandId === COMMAND_ID &&
            state.sendCalls === 0 &&
            state.concurrentReceiptPreflightReads < 2
          ) {
            state.concurrentReceiptPreflightReads += 1;
            if (state.concurrentReceiptPreflightReads === 2) releaseConcurrentReceiptPreflight();
            const waitForPreflight: ReturnType<typeof native.getByCommandId> = Effect.tryPromise({
              try: () => concurrentReceiptPreflight,
              catch: (cause) =>
                new CommandReceiptStore.CommandReceiptStoreReadError({
                  commandId,
                  cause,
                }),
            }).pipe(Effect.as(Option.none()));
            return receipt.pipe(
              Effect.flatMap((value): ReturnType<typeof native.getByCommandId> =>
                Option.isNone(value)
                  ? waitForPreflight.pipe(Effect.as(value))
                  : Effect.succeed(value),
              ),
            );
          }
          return receipt;
        },
      });
    }),
  ).pipe(Layer.provide(receiptBaseLayer));
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: SESSION_ID,
        subject: "http-cli-send-test",
        method: "bearer-access-token" as const,
        scopes:
          options.scope === "read"
            ? [AuthOrchestrationReadScope]
            : options.scope === "operate"
              ? [AuthOrchestrationOperateScope]
              : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
      }),
  });
  const applicationEventsBase = OrchestrationEventStore.layer.pipe(Layer.provide(database));
  const applicationEventsLayer = Layer.effect(
    OrchestrationEventStoreService.OrchestrationEventStore,
    Effect.gen(function* () {
      const native = yield* OrchestrationEventStoreService.OrchestrationEventStore;
      return OrchestrationEventStoreService.OrchestrationEventStore.of({
        ...native,
        latestApplicationSequence: native.latestApplicationSequence.pipe(
          Effect.tap((sequence) =>
            Effect.sync(() => {
              state.snapshotSequence = sequence;
            }),
          ),
        ),
      });
    }),
  ).pipe(Layer.provide(applicationEventsBase));
  const projectServiceLayer = RuntimeLayer.layerProjectService.pipe(
    Layer.provideMerge(Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({})),
    Layer.provideMerge(
      Layer.succeed(WorkspacePaths.WorkspacePaths, {
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot.replace(/\/$/, "")),
        resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
          Effect.succeed({ absolutePath: `${workspaceRoot}/${relativePath}`, relativePath }),
      }),
    ),
    Layer.provideMerge(database),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cli-project-" })),
    Layer.provide(NodeServices.layer),
  );
  const appLayer = HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(EnvironmentHttpAuth.layerAuthenticatedAuth.pipe(Layer.provide(auth))),
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        serverRuntimeServices,
        projectServiceLayer,
        threadManagement,
        EventStore.layer.pipe(Layer.provide(database)),
        ProjectStore.layer.pipe(Layer.provide(database)),
        HttpCreateOperations.layer.pipe(Layer.provide(database)),
        manualCompaction,
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        pendingService,
        receiptLayer,
        applicationEventsLayer,
      ),
    ),
  );
  const { handler: webHandler, dispose } = HttpRouter.toWebHandler(
    appLayer.pipe(Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return {
    handler: (request) => webHandler(request, Context.empty()),
    sendCalls: () => state.sendCalls,
    projectionReadFailures: () => state.projectionReadFailures,
    receiptReadFailures: () => state.receiptReadFailures,
    snapshotSequence: () => state.snapshotSequence,
    waitForSendCalls,
    dispatchedCommands: () => state.dispatchedCommands,
  };
};

const sendRequest = (overrides: Record<string, unknown> = {}) =>
  new Request("http://t3.test/api/orchestration/dispatch", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "thread.turn.start",
      threadId: THREAD_ID,
      commandId: COMMAND_ID,
      message: {
        messageId: MessageId.make(COMMAND_ID),
        role: "user",
        text: MESSAGE,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-10-06T00:00:00.000Z",
      ...overrides,
    }),
  });

const dispatchRequest = (command: Record<string, unknown>) =>
  new Request("http://t3.test/api/orchestration/dispatch", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
  });

const metadataRequest = (commandId: CommandId, patch: Record<string, unknown>) =>
  dispatchRequest({
    type: "thread.meta.update",
    commandId,
    threadId: THREAD_ID,
    ...patch,
  });

const rollbackRequest = (commandId: CommandId, turnCount: number) =>
  dispatchRequest({
    type: "thread.checkpoint.revert",
    commandId,
    threadId: THREAD_ID,
    turnCount,
    createdAt: "2026-10-06T00:02:00.000Z",
  });

const compactRequest = () =>
  new Request("http://t3.test/api/orchestration/compact", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ threadId: THREAD_ID, idempotencyKey: "compact-http-errors" }),
  });

const pendingAnswerRequest = () =>
  new Request("http://t3.test/api/orchestration/pending-interactions/answer", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId: THREAD_ID,
      requestId: "http-test-request",
      idempotencyKey: "pending-http-errors",
      answers: [{ questionId: "question", values: ["answer"] }],
    }),
  });

const snapshotRequest = () =>
  new Request("http://t3.test/api/orchestration/snapshot", {
    headers: { authorization: "Bearer operate-token" },
  });

describe("native orchestration HTTP send", () => {
  it("dispatches through native SQL once and replays the exact accepted receipt", async () => {
    const fixture = makeFixture();
    const first = await fixture.handler(sendRequest());
    const second = await fixture.handler(sendRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstResult = (await first.json()) as { readonly sequence: number };
    const secondResult = await second.json();
    expect(secondResult).toEqual(firstResult);
    expect(firstResult.sequence).toEqual(expect.any(Number));
    expect(fixture.sendCalls()).toBe(1);
  });

  it("reconciles a committed dispatch after its actual projection read fails", async () => {
    const fixture = makeFixture({ failPostDispatchProjection: true });
    const first = await fixture.handler(sendRequest());
    const replay = await fixture.handler(sendRequest());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(fixture.sendCalls()).toBe(1);
    expect(fixture.projectionReadFailures()).toBe(1);
  });

  it("returns the native receipt after a concurrent duplicate encounters archive", async () => {
    const fixture = makeFixture({ concurrentArchiveDuplicate: true });
    const [first, duplicate] = await Promise.all([
      fixture.handler(sendRequest()),
      fixture.handler(sendRequest()),
    ]);

    expect(first.status).toBe(200);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(await first.json());
    expect(fixture.sendCalls()).toBe(2);
  });

  it("replays an accepted send when a concurrent dispatch observes deletion", async () => {
    const fixture = makeFixture({ concurrentDeleteAtShellLookup: true });
    const first = fixture.handler(sendRequest());
    await fixture.waitForSendCalls(1);
    const duplicate = fixture.handler(sendRequest());
    await fixture.waitForSendCalls(2);
    const [accepted, replay] = await Promise.all([first, duplicate]);

    expect(accepted.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await accepted.json());
    expect(fixture.sendCalls()).toBe(2);
  });

  it("returns unknown when accepted work cannot be reconciled, then replays the receipt", async () => {
    const fixture = makeFixture({
      failPostDispatchProjection: true,
      failReceiptReadAfterProjectionFailure: true,
    });
    const uncertain = await fixture.handler(sendRequest());
    const replay = await fixture.handler(sendRequest());

    expect(uncertain.status).toBe(500);
    expect(await uncertain.json()).toMatchObject({
      _tag: "EnvironmentInternalError",
      reason: "orchestration_send_outcome_unknown",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ sequence: expect.any(Number) });
    expect(fixture.sendCalls()).toBe(1);
    expect(fixture.projectionReadFailures()).toBe(1);
    expect(fixture.receiptReadFailures()).toBe(1);
  });

  it("rejects a pre-existing receipt for another command type", async () => {
    const fixture = makeFixture({ seedWrongTypeReceipt: true });
    const response = await fixture.handler(sendRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      _tag: "EnvironmentConflictError",
      reason: "idempotency_payload_mismatch",
    });
    expect(fixture.sendCalls()).toBe(0);
  });

  it("rejects a receipt reused for a different thread before native dispatch", async () => {
    const fixture = makeFixture();
    const accepted = await fixture.handler(sendRequest());
    const conflicting = await fixture.handler(
      sendRequest({ threadId: ThreadId.make("other-thread") }),
    );

    expect(accepted.status).toBe(200);
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({
      _tag: "EnvironmentConflictError",
      reason: "idempotency_payload_mismatch",
    });
    expect(fixture.sendCalls()).toBe(1);
  });

  it("requires operate scope before invoking the native send service", async () => {
    const fixture = makeFixture({ scope: "read" });
    const response = await fixture.handler(sendRequest());

    expect(response.status).toBe(403);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("maps rejected duplicate native attachment claims to invalid request", async () => {
    const fixture = makeFixture();
    const response = await fixture.handler(
      sendRequest({
        message: {
          messageId: MessageId.make(`${COMMAND_ID}-duplicate-attachments`),
          role: "user",
          text: MESSAGE,
          attachments: [
            {
              type: "image",
              id: "duplicate-native-attachment",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
            {
              type: "image",
              id: "duplicate-native-attachment",
              name: "image.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      _tag: "EnvironmentRequestInvalidError",
      reason: "invalid_command",
    });
    expect(fixture.sendCalls()).toBe(0);
  });
});

describe("native orchestration HTTP dispatch receipts", () => {
  it("rejects a losing concurrent reuse of a command id for a different command type", async () => {
    const fixture = makeFixture({ synchronizeReceiptPreflight: true });
    const [archive, hide] = await Promise.all([
      fixture.handler(
        dispatchRequest({ type: "thread.archive", commandId: COMMAND_ID, threadId: THREAD_ID }),
      ),
      fixture.handler(
        dispatchRequest({ type: "thread.hide", commandId: COMMAND_ID, threadId: THREAD_ID }),
      ),
    ]);
    const responses = [archive, hide];
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 409]);
    const loser = responses.find((response) => response.status === 409);
    if (loser === undefined) throw new Error("Expected one command-id conflict response.");
    expect(await loser.json()).toMatchObject({
      _tag: "EnvironmentConflictError",
      reason: "idempotency_payload_mismatch",
    });
  });
});

describe("native orchestration HTTP error mapping", () => {
  it.each([
    {
      compactError: "invalid" as const,
      status: 400,
      body: { _tag: "EnvironmentRequestInvalidError", reason: "invalid_command" },
    },
    {
      compactError: "not-found" as const,
      status: 404,
      body: { _tag: "EnvironmentResourceNotFoundError", reason: "thread_not_found" },
    },
    {
      compactError: "compaction" as const,
      status: 409,
      body: { _tag: "EnvironmentThreadCompactionError", reason: "recovery-required" },
    },
    {
      compactError: "unexpected" as const,
      status: 500,
      body: { _tag: "EnvironmentInternalError", reason: "orchestration_dispatch_failed" },
    },
  ])("maps compaction $status failures at the HTTP boundary", async (scenario) => {
    const fixture = makeFixture({ compactError: scenario.compactError });
    const response = await fixture.handler(compactRequest());
    expect(response.status).toBe(scenario.status);
    expect(await response.json()).toMatchObject(scenario.body);
  });

  it.each([
    {
      pendingResponseError: "unavailable" as const,
      status: 404,
      body: { _tag: "EnvironmentResourceNotFoundError", reason: "pending_interaction_not_found" },
    },
    {
      pendingResponseError: "invalid" as const,
      status: 400,
      body: { _tag: "EnvironmentRequestInvalidError", reason: "invalid_interaction" },
    },
    {
      pendingResponseError: "conflict" as const,
      status: 400,
      body: { _tag: "EnvironmentRequestInvalidError", reason: "invalid_interaction" },
    },
    {
      pendingResponseError: "unexpected" as const,
      status: 500,
      body: { _tag: "EnvironmentInternalError", reason: "pending_interaction_response_failed" },
    },
  ])("maps pending-response $status failures at the HTTP boundary", async (scenario) => {
    const fixture = makeFixture({ pendingResponseError: scenario.pendingResponseError });
    const response = await fixture.handler(pendingAnswerRequest());
    expect(response.status).toBe(scenario.status);
    expect(await response.json()).toMatchObject(scenario.body);
  });
});

describe("native orchestration HTTP checkpoint rollback", () => {
  it("resolves historical root checkpoints by logical user turn across maintenance and rollback runs", async () => {
    const fixture = makeFixture({ seedProjects: true, seedCheckpointHistory: true });
    const firstCommandId = CommandId.make("http-cli-rollback-logical-turn-1");
    const secondCommandId = CommandId.make("http-cli-rollback-logical-turn-2");
    const firstResponse = await fixture.handler(rollbackRequest(firstCommandId, 1));
    const secondResponse = await fixture.handler(rollbackRequest(secondCommandId, 2));

    expect(firstResponse.status).toBe(409);
    expect(secondResponse.status).toBe(409);
    const rollbackCommands = fixture
      .dispatchedCommands()
      .filter(
        (command): command is Extract<OrchestrationV2Command, { type: "checkpoint.rollback" }> =>
          command.type === "checkpoint.rollback",
      );
    expect(rollbackCommands).toHaveLength(2);
    expect(
      rollbackCommands.map(({ commandId, checkpointId }) => ({ commandId, checkpointId })),
    ).toEqual([
      {
        commandId: firstCommandId,
        checkpointId: CheckpointId.make("http-cli-rollback-user-run-1"),
      },
      {
        commandId: secondCommandId,
        checkpointId: CheckpointId.make("http-cli-rollback-user-run-4"),
      },
    ]);
  });

  it("counts user turns before rejecting a checkpoint from the prior provider lineage", async () => {
    const fixture = makeFixture({
      seedProjects: true,
      seedCheckpointHistory: true,
      seedProviderSwitchHistory: true,
    });
    const priorLineageCommandId = CommandId.make("http-cli-rollback-prior-lineage-turn-1");
    const currentLineageCommandId = CommandId.make("http-cli-rollback-current-lineage-turn-2");
    const priorLineageResponse = await fixture.handler(rollbackRequest(priorLineageCommandId, 1));
    const currentLineageResponse = await fixture.handler(
      rollbackRequest(currentLineageCommandId, 2),
    );

    expect(priorLineageResponse.status).toBe(409);
    expect(currentLineageResponse.status).toBe(409);
    const rollbackCommands = fixture
      .dispatchedCommands()
      .filter(
        (command): command is Extract<OrchestrationV2Command, { type: "checkpoint.rollback" }> =>
          command.type === "checkpoint.rollback",
      );
    expect(
      rollbackCommands.map(({ commandId, checkpointId }) => ({ commandId, checkpointId })),
    ).toEqual([
      {
        commandId: currentLineageCommandId,
        checkpointId: CheckpointId.make("http-cli-rollback-user-run-4"),
      },
    ]);
  });
});

describe("native CLI metadata snapshot", () => {
  it("applies branch and other metadata together when expectedBranch matches", async () => {
    const fixture = makeFixture();
    const seeded = await fixture.handler(
      metadataRequest(CommandId.make("http-cli-meta-seed-match"), {
        branch: "feature/current",
      }),
    );
    expect(seeded.status).toBe(200);

    const response = await fixture.handler(
      metadataRequest(CommandId.make("http-cli-meta-match"), {
        title: "Updated with matching branch",
        branch: "feature/next",
        expectedBranch: "feature/current",
      }),
    );
    expect(response.status).toBe(200);
    const snapshotResponse = await fixture.handler(snapshotRequest());
    const snapshot = (await snapshotResponse.json()) as OrchestrationCliSnapshot;
    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    if (thread === undefined) throw new Error("Expected the native thread metadata row.");
    expect(thread.title).toBe("Updated with matching branch");
    expect(thread.branch).toBe("feature/next");
  });

  it("preserves a changed branch while applying other metadata when expectedBranch mismatches", async () => {
    const fixture = makeFixture();
    const seeded = await fixture.handler(
      metadataRequest(CommandId.make("http-cli-meta-seed-mismatch"), {
        branch: "feature/current",
      }),
    );
    expect(seeded.status).toBe(200);

    const response = await fixture.handler(
      metadataRequest(CommandId.make("http-cli-meta-mismatch"), {
        title: "Updated despite branch mismatch",
        branch: "feature/next",
        expectedBranch: "feature/stale",
      }),
    );
    expect(response.status).toBe(200);
    const snapshotResponse = await fixture.handler(snapshotRequest());
    const snapshot = (await snapshotResponse.json()) as OrchestrationCliSnapshot;
    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    if (thread === undefined) throw new Error("Expected the native thread metadata row.");
    expect(thread.title).toBe("Updated despite branch mismatch");
    expect(thread.branch).toBe("feature/current");
  });

  it("returns native run metadata while keeping transcript bodies empty", async () => {
    const fixture = makeFixture({ seedProjects: true });
    const send = await fixture.handler(sendRequest());
    const response = await fixture.handler(snapshotRequest());

    expect(send.status).toBe(200);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as OrchestrationCliSnapshot;
    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    if (thread === undefined) throw new Error("Expected the native thread metadata row.");

    expect(snapshot.snapshotSequence).toBe(fixture.snapshotSequence());
    expect(snapshot.updatedAt).not.toBeNull();
    expect(snapshot.projects.map((project) => project.id).toSorted()).toEqual(
      [PROJECT_ID, DELETED_PROJECT_ID].toSorted(),
    );
    const deletedProject = snapshot.projects.find((project) => project.id === DELETED_PROJECT_ID);
    if (deletedProject === undefined) throw new Error("Expected deleted project metadata.");
    expect(deletedProject.deletedAt).not.toBeNull();
    expect(thread.latestRunId).not.toBeNull();
    expect(thread.activeRunId).toBe(thread.latestRunId);
    expect(thread.messages).toEqual([]);
    expect(thread.activities).toEqual([]);
    expect(thread.checkpoints).toEqual([]);
  });

  it("includes hidden, archived, and deleted native thread metadata", async () => {
    const fixture = makeFixture({ seedProjects: true, seedHiddenArchivedDeletedThread: true });
    const response = await fixture.handler(snapshotRequest());

    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as OrchestrationCliSnapshot;
    const thread = snapshot.threads.find((candidate) => candidate.id === THREAD_ID);
    if (thread === undefined)
      throw new Error("Expected lifecycle metadata for the deleted thread.");

    expect(snapshot.snapshotSequence).toBe(fixture.snapshotSequence());
    expect(thread.hiddenAt).not.toBeNull();
    expect(thread.archivedAt).not.toBeNull();
    expect(thread.deletedAt).not.toBeNull();
    expect(thread.messages).toEqual([]);
    expect(thread.activities).toEqual([]);
    expect(thread.checkpoints).toEqual([]);
  });

  it("represents a genuinely empty metadata history without a timestamp sentinel", async () => {
    const fixture = makeFixture({ seedThread: false });
    const response = await fixture.handler(snapshotRequest());

    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as OrchestrationCliSnapshot;
    expect(snapshot).toEqual({ snapshotSequence: 0, projects: [], threads: [], updatedAt: null });
    expect(fixture.snapshotSequence()).toBe(0);
  });
});
