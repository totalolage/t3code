import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  EnvironmentHttpApi,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ApplicationProjectEvent,
  type OrchestrationCliCreateResult,
  type Project,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as EnvironmentHttpAuth from "../auth/http.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as HttpCreateOperations from "../persistence/OrchestrationHttpCreateOperations.ts";
import { PendingInteractionResponseRepositoryLive } from "../persistence/PendingInteractionResponses.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStore from "./EventStore.ts";
import * as ManualThreadCompaction from "./ManualThreadCompaction.ts";
import * as PendingInteractionQuery from "./PendingInteractionQuery.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ServiceUpdateAdmission from "./ServiceUpdateAdmission.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as PendingInteractionService from "./PendingInteractionService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as OrchestrationHttp from "./http.ts";
import { getHttpCreateIdentity } from "./httpCreatePlan.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const SESSION_ID = AuthSessionId.make("native-http-create-integration-session");
const OTHER_SESSION_ID = AuthSessionId.make("native-http-create-integration-other-session");
const PROJECT_ID = ProjectId.make("native-http-create-integration-project");
const PROVIDER_ID = ProviderInstanceId.make("codex");
const PENDING_THREAD_ID = ThreadId.make("native-http-pending-thread");
const PENDING_ANSWER_ID = RuntimeRequestId.make("native-http-pending-answer");
const PENDING_APPROVAL_ID = RuntimeRequestId.make("native-http-pending-approval");
const NOW = "2026-10-06T00:00:00.000Z";
const TestHttpApi = HttpApi.make("environment").add(EnvironmentHttpApi.groups.orchestration);
const disposers: Array<() => Promise<void>> = [];
const DEFAULT_MODEL_SELECTION = {
  instanceId: PROVIDER_ID,
  model: "gpt-5.4",
} satisfies NonNullable<Project["defaultModelSelection"]>;

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const project: Project = {
  id: PROJECT_ID,
  title: "Native HTTP create project",
  workspaceRoot: "/tmp/native-http-create-project",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: DEFAULT_MODEL_SELECTION,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};

const projectCreatedEvent = (
  scripts: Project["scripts"] = project.scripts,
): ApplicationProjectEvent => ({
  sequence: 0,
  eventId: EventId.make("native-http-create-project-created"),
  aggregateKind: "project",
  aggregateId: PROJECT_ID,
  occurredAt: NOW,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.created",
  payload: {
    projectId: PROJECT_ID,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection: project.defaultModelSelection,
    scripts,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

type FixtureOptions = {
  readonly sessionId?: AuthSessionId;
  readonly dropPreparedFail?: boolean;
  readonly failComplete?: boolean;
  readonly omitCheckpointRun?: boolean;
  readonly failRetryReady?: boolean;
  readonly holdUpdaterRelease?: boolean;
  readonly seedPendingInteractions?: boolean;
  readonly failPendingRespondDispatch?: boolean;
  readonly setupScriptOnWorktreeCreate?: boolean;
  readonly runSetup?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"];
};

type Fixture = {
  readonly handler: (request: Request) => Promise<Response>;
  readonly createWorktreeCalls: () => number;
  readonly preparedFailDispatches: () => number;
  readonly pendingRespondDispatches: () => number;
  readonly completeCalls: () => number;
  readonly retryReadyCalls: () => number;
  readonly setupCalls: () => number;
  readonly setSessionId: (sessionId: AuthSessionId) => void;
  readonly setScopes: (
    scopes: ReadonlyArray<typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope>,
  ) => void;
  readonly waitForAuthCalls: (count: number) => Promise<void>;
};

const makeFixture = (options: FixtureOptions = {}): Fixture => {
  const runSetupScript = options.setupScriptOnWorktreeCreate ?? options.runSetup !== undefined;
  const scripts: Project["scripts"] = runSetupScript
    ? [
        {
          id: "install",
          name: "Install",
          command: "pnpm install",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ]
    : project.scripts;
  const fixtureProject = { ...project, scripts };
  let createWorktreeCalls = 0;
  let preparedFailDispatches = 0;
  let pendingRespondDispatches = 0;
  let completeCalls = 0;
  let retryReadyCalls = 0;
  let setupCalls = 0;
  let authCalls = 0;
  let activeSessionId = options.sessionId ?? SESSION_ID;
  let activeScopes: ReadonlyArray<
    typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope
  > = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
  const authWaiters = new Map<number, () => void>();
  const waitForAuthCalls = (count: number) =>
    authCalls >= count
      ? Promise.resolve()
      : new Promise<void>((resolve) => authWaiters.set(count, resolve));
  const database = SqlitePersistence.layerMemory;
  const serverConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
    prefix: "native-http-create-attachments-",
  }).pipe(Layer.provideMerge(NodeServices.layer));
  const adapter: ProviderAdapter.ProviderAdapterV2Shape = {
    instanceId: PROVIDER_ID,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("The HTTP create integration test must not start a provider."),
  };
  const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const core = ProviderReplayHarness.layerWithRegistry(
    { name: "native-http-create-integration" },
    registry,
    { databaseLayer: database, runEffectWorker: false },
  );
  const instrumentedCore = Layer.effect(
    Orchestrator.OrchestratorV2,
    Effect.gen(function* () {
      const native = yield* Orchestrator.OrchestratorV2;
      const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      const dispatch: typeof native.dispatch = (command) => {
        if (options.dropPreparedFail === true && command.type === "prepared-run.fail") {
          preparedFailDispatches += 1;
          return Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: new Error("synthetic prepared-run.fail persistence failure"),
            }),
          );
        }
        if (options.holdUpdaterRelease === true && command.type === "prepared-run.release") {
          return admission.setState("draining").pipe(Effect.andThen(native.dispatch(command)));
        }
        if (command.type === "runtime-request.respond") {
          pendingRespondDispatches += 1;
          if (options.failPendingRespondDispatch === true) {
            return native.dispatch(command).pipe(
              Effect.flatMap(() =>
                Effect.fail(
                  new Orchestrator.OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: new Error("synthetic response lost after native commit"),
                  }),
                ),
              ),
            );
          }
        }
        return native.dispatch(command);
      };
      return Orchestrator.OrchestratorV2.of({ ...native, dispatch });
    }),
  ).pipe(Layer.provideMerge(core));
  const projectionStore = ProjectionStore.layer.pipe(Layer.provide(database));
  const seededCore = Layer.effectDiscard(
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* projects.apply(projectCreatedEvent(scripts));
      if (options.seedPendingInteractions === true) {
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("native-http-pending-thread-create"),
          threadId: PENDING_THREAD_ID,
          projectId: PROJECT_ID,
          title: "Native pending interactions",
          modelSelection: DEFAULT_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "server",
        });

        const now = yield* DateTime.now;
        const candidates = [
          {
            requestId: PENDING_ANSWER_ID,
            nodeId: NodeId.make("native-http-pending-answer-node"),
            itemId: TurnItemId.make("native-http-pending-answer-item"),
            kind: "user_input" as const,
            itemType: "user_input_request" as const,
          },
          {
            requestId: PENDING_APPROVAL_ID,
            nodeId: NodeId.make("native-http-pending-approval-node"),
            itemId: TurnItemId.make("native-http-pending-approval-item"),
            kind: "permission" as const,
            itemType: "approval_request" as const,
          },
        ];
        for (const candidate of candidates) {
          yield* projections.apply({
            id: EventId.make(`native-http-pending-node-${candidate.requestId}`),
            type: "node.updated",
            threadId: PENDING_THREAD_ID,
            occurredAt: now,
            payload: {
              id: candidate.nodeId,
              threadId: PENDING_THREAD_ID,
              runId: null,
              parentNodeId: null,
              rootNodeId: candidate.nodeId,
              kind:
                candidate.itemType === "user_input_request"
                  ? "user_input_request"
                  : "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: candidate.requestId,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
          yield* projections.apply({
            id: EventId.make(`native-http-pending-request-${candidate.requestId}`),
            type: "runtime-request.updated",
            threadId: PENDING_THREAD_ID,
            occurredAt: now,
            payload: {
              id: candidate.requestId,
              nodeId: candidate.nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: candidate.kind,
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          });
          yield* projections.apply({
            id: EventId.make(`native-http-pending-item-${candidate.requestId}`),
            type: "turn-item.updated",
            threadId: PENDING_THREAD_ID,
            occurredAt: now,
            payload:
              candidate.itemType === "user_input_request"
                ? {
                    id: candidate.itemId,
                    threadId: PENDING_THREAD_ID,
                    runId: null,
                    nodeId: candidate.nodeId,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "waiting",
                    title: null,
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                    type: "user_input_request",
                    requestId: candidate.requestId,
                    responseMode: "message",
                    questions: [
                      {
                        id: "native-http-question",
                        header: "Target",
                        question: "Which target should be used?",
                        options: [
                          { label: "Local", description: "Use the local target.", value: "local" },
                        ],
                      },
                    ],
                  }
                : {
                    id: candidate.itemId,
                    threadId: PENDING_THREAD_ID,
                    runId: null,
                    nodeId: candidate.nodeId,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 1,
                    status: "waiting",
                    title: null,
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                    type: "approval_request",
                    requestId: candidate.requestId,
                    requestKind: "permission",
                    prompt: "Allow permission?",
                  },
          });
        }
      }
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(instrumentedCore, projectionStore)));

  const projectService = Layer.mock(ProjectService.ProjectService)({
    getById: (projectId) =>
      Effect.succeed(projectId === PROJECT_ID ? Option.some(fixtureProject) : Option.none()),
    getByWorkspaceRoot: () => Effect.succeed(Option.some(fixtureProject)),
  });
  const git = Layer.mock(GitWorkflowService.GitWorkflowService)({
    listRefs: () =>
      Effect.succeed({
        refs: [
          {
            name: "main",
            isRemote: false,
            current: true,
            isDefault: true,
            worktreePath: null,
          },
        ],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 1,
      }),
    localStatus: () =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      }),
    remoteExists: () => Effect.succeed(false),
    createWorktree: (input) =>
      Effect.sync(() => {
        createWorktreeCalls += 1;
        return {
          worktree: {
            path: project.workspaceRoot + "/worktrees/create-" + createWorktreeCalls,
            refName: input.newRefName ?? "t3/http-create",
          },
        };
      }),
    removeWorktree: () => Effect.void,
    fetchRemote: () => Effect.void,
    remoteBranchExists: () => Effect.succeed(false),
    resolveRemoteTrackingCommit: () =>
      Effect.succeed({ commitSha: "remote-main", remoteRefName: "origin/main" }),
    renameBranch: (input) => Effect.succeed({ branch: input.newBranch }),
  });
  const setup = options.runSetup ?? (() => Effect.succeed({ status: "no-script" as const }));
  const externalServices = Layer.mergeAll(
    serverConfig,
    WorktreeSetupTracker.layer,
    Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    projectService,
    git,
    Layer.succeed(ProjectSetupScriptRunner.ProjectSetupScriptRunner, {
      runForThread: (input) =>
        Effect.sync(() => {
          setupCalls += 1;
        }).pipe(Effect.andThen(setup(input))),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
      generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
    }),
    ServerSettings.layerTest(),
    ProviderRegistryMock.layer(),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/tmp/native-http-create-projects",
      folderForThread: () => Effect.succeed(Option.none()),
    }),
  );
  const threadManagement = ThreadManagementService.layer.pipe(Layer.provide(seededCore));
  const threadLaunch = ThreadLaunchService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(externalServices, threadManagement, IdAllocator.layer, seededCore),
    ),
  );
  const applicationEvents = OrchestrationEventStore.layer.pipe(Layer.provide(database));
  const operationsBase = HttpCreateOperations.layer.pipe(Layer.provide(database));
  const operations = Layer.effect(
    HttpCreateOperations.OrchestrationHttpCreateOperations,
    Effect.gen(function* () {
      const native = yield* HttpCreateOperations.OrchestrationHttpCreateOperations;
      return HttpCreateOperations.OrchestrationHttpCreateOperations.of({
        ...native,
        checkpointRun: (input) =>
          options.omitCheckpointRun === true ? Effect.void : native.checkpointRun(input),
        complete: (input) => {
          completeCalls += 1;
          return options.failComplete === true
            ? Effect.fail(
                new HttpCreateOperations.OrchestrationHttpCreateOperationPersistenceError({
                  operation: "complete",
                  detail: "synthetic HTTP completion materialization failure",
                }),
              )
            : native.complete(input);
        },
        markRetryReady: (input) => {
          retryReadyCalls += 1;
          return options.failRetryReady === true
            ? Effect.fail(
                new HttpCreateOperations.OrchestrationHttpCreateOperationPersistenceError({
                  operation: "markRetryReady",
                  detail: "synthetic retry-ready materialization failure",
                }),
              )
            : native.markRetryReady(input);
        },
      });
    }),
  ).pipe(Layer.provide(operationsBase));
  const eventStore = EventStore.layer.pipe(Layer.provide(database));
  const receipts = CommandReceiptStore.layer.pipe(Layer.provide(database));
  const compaction = ManualThreadCompaction.ManualThreadCompactionLive.pipe(
    Layer.provide(Layer.mergeAll(seededCore, eventStore, receipts, NodeCrypto.layer)),
  );
  const pendingQuery = PendingInteractionQuery.PendingInteractionQueryLive.pipe(
    Layer.provideMerge(seededCore),
  );
  const pendingResponseRepository = PendingInteractionResponseRepositoryLive.pipe(
    Layer.provide(database),
  );
  const pendingInteractions = PendingInteractionService.PendingInteractionServiceLive.pipe(
    Layer.provide(Layer.mergeAll(pendingResponseRepository, pendingQuery)),
    Layer.provideMerge(serverConfig),
  );
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateHttpRequest: () =>
      Effect.sync(() => {
        authCalls += 1;
        authWaiters.get(authCalls)?.();
        authWaiters.delete(authCalls);
        return {
          sessionId: activeSessionId,
          subject: "native-http-create-test",
          method: "bearer-access-token" as const,
          scopes: activeScopes,
        };
      }),
  });
  const appLayer = HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(EnvironmentHttpAuth.layerAuthenticatedAuth.pipe(Layer.provide(auth))),
    Layer.provideMerge(
      Layer.mergeAll(
        database,
        seededCore,
        externalServices,
        threadManagement,
        threadLaunch,
        applicationEvents,
        eventStore,
        receipts,
        operations,
        compaction,
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
        pendingInteractions,
      ),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(
    appLayer.pipe(Layer.provide(HttpServer.layerServices), Layer.provide(receipts)),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return {
    handler: (request) => handler(request, Context.empty()),
    createWorktreeCalls: () => createWorktreeCalls,
    preparedFailDispatches: () => preparedFailDispatches,
    pendingRespondDispatches: () => pendingRespondDispatches,
    completeCalls: () => completeCalls,
    retryReadyCalls: () => retryReadyCalls,
    setupCalls: () => setupCalls,
    setSessionId: (sessionId) => {
      activeSessionId = sessionId;
    },
    setScopes: (scopes) => {
      activeScopes = scopes;
    },
    waitForAuthCalls,
  };
};

const createRequest = (body: Readonly<Record<string, unknown>>, signal?: AbortSignal) =>
  new Request("http://t3.test/api/orchestration/create", {
    method: "POST",
    ...(signal === undefined ? {} : { signal }),
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const dispatchRequest = (body: Readonly<Record<string, unknown>>) =>
  new Request("http://t3.test/api/orchestration/dispatch", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const threadSnapshotRequest = (threadId: string) =>
  new Request("http://t3.test/api/orchestration/threads/" + threadId, {
    headers: {
      authorization: "Bearer operate-token",
      "x-t3-orchestration-protocol": "2",
    },
  });

const pendingListRequest = () =>
  new Request(
    `http://t3.test/api/orchestration/pending-interactions?threadId=${PENDING_THREAD_ID}`,
    {
      headers: { authorization: "Bearer read-token" },
    },
  );

const pendingAnswerRequest = (idempotencyKey: string) =>
  new Request("http://t3.test/api/orchestration/pending-interactions/answer", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId: PENDING_THREAD_ID,
      requestId: PENDING_ANSWER_ID,
      idempotencyKey,
      answers: [{ questionId: "native-http-question", values: ["Local"] }],
    }),
  });

const pendingApproveRequest = (idempotencyKey: string) =>
  new Request("http://t3.test/api/orchestration/pending-interactions/approve", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId: PENDING_THREAD_ID,
      requestId: PENDING_APPROVAL_ID,
      idempotencyKey,
    }),
  });

const pendingRejectRequest = (idempotencyKey: string) =>
  new Request("http://t3.test/api/orchestration/pending-interactions/reject", {
    method: "POST",
    headers: {
      authorization: "Bearer operate-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      threadId: PENDING_THREAD_ID,
      requestId: PENDING_APPROVAL_ID,
      idempotencyKey,
      decision: "decline",
    }),
  });

describe("native HTTP create integration", () => {
  it("returns and replays the exact SQL-backed native launch acceptance", async () => {
    const fixture = makeFixture();
    const request = {
      project: String(PROJECT_ID),
      message: "Create a native thread",
      idempotencyKey: "create-replay",
    };
    const firstResponse = await fixture.handler(createRequest(request));
    const replayResponse = await fixture.handler(createRequest(request));

    expect(firstResponse.status).toBe(200);
    expect(replayResponse.status).toBe(200);
    const first = (await firstResponse.json()) as OrchestrationCliCreateResult;
    const replay = (await replayResponse.json()) as OrchestrationCliCreateResult;
    const identity = getHttpCreateIdentity(SESSION_ID, request.idempotencyKey);
    expect(first).toMatchObject({
      threadId: identity.threadId,
      commandId: identity.commandId,
      replayed: false,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(first.sequence).toBeGreaterThan(0);
    expect(fixture.createWorktreeCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(0);

    const semanticConflict = await fixture.handler(
      createRequest({ ...request, message: "Different semantic request" }),
    );
    expect(semanticConflict.status).toBe(409);
    expect(fixture.createWorktreeCalls()).toBe(1);

    fixture.setSessionId(OTHER_SESSION_ID);
    const otherSessionResponse = await fixture.handler(createRequest(request));
    expect(otherSessionResponse.status).toBe(200);
    const otherSession = (await otherSessionResponse.json()) as OrchestrationCliCreateResult;
    expect(otherSession.threadId).not.toBe(first.threadId);
    expect(otherSession.commandId).not.toBe(first.commandId);
    expect(fixture.createWorktreeCalls()).toBe(2);
    expect(fixture.setupCalls()).toBe(0);

    const threadResponse = await fixture.handler(threadSnapshotRequest(first.threadId));
    expect(threadResponse.status).toBe(200);
    const snapshot = (await threadResponse.json()) as {
      readonly projection: {
        readonly messages: ReadonlyArray<{ readonly id: string }>;
        readonly runs: ReadonlyArray<{ readonly id: string }>;
      };
    };
    expect(snapshot.projection.messages.map((message) => message.id)).toHaveLength(1);
    expect(snapshot.projection.runs.map((run) => run.id)).toContain(first.turnId);
  });

  it("runs HTTP create setup only when the project opts in", async () => {
    const fixture = makeFixture({ setupScriptOnWorktreeCreate: true });
    const response = await fixture.handler(
      createRequest({
        project: String(PROJECT_ID),
        message: "Create with configured setup",
        idempotencyKey: "create-configured-setup",
      }),
    );

    expect(response.status).toBe(200);
    expect(fixture.createWorktreeCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(1);
  });

  it("persists the F bootstrap setup choice through native launch", async () => {
    const fixture = makeFixture();
    const scenarios = [
      { name: "omitted", runSetupScript: undefined, worktree: true, expected: false },
      { name: "disabled", runSetupScript: false, worktree: true, expected: false },
      { name: "root", runSetupScript: true, worktree: false, expected: true },
      { name: "worktree", runSetupScript: true, worktree: true, expected: true },
    ] as const;

    for (const scenario of scenarios) {
      const threadId = ThreadId.make(`native-http-bootstrap-${scenario.name}`);
      const commandId = CommandId.make(`native-http-bootstrap-${scenario.name}`);
      const response = await fixture.handler(
        dispatchRequest({
          type: "thread.turn.start",
          commandId,
          threadId,
          message: {
            messageId: MessageId.make(`native-http-bootstrap-message-${scenario.name}`),
            role: "user",
            text: "Start the bootstrap turn",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
          bootstrap: {
            createThread: {
              projectId: PROJECT_ID,
              title: "Bootstrap thread",
              modelSelection: DEFAULT_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: NOW,
            },
            ...(scenario.worktree
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch: "main",
                    branch: `bootstrap-${scenario.name}`,
                    startFromOrigin: false,
                  },
                }
              : {}),
            ...(scenario.runSetupScript === undefined
              ? {}
              : { runSetupScript: scenario.runSetupScript }),
          },
        }),
      );
      expect(response.status).toBe(200);

      const snapshotResponse = await fixture.handler(threadSnapshotRequest(threadId));
      expect(snapshotResponse.status).toBe(200);
      const snapshot = (await snapshotResponse.json()) as {
        readonly projection: {
          readonly runs: ReadonlyArray<{
            readonly workspacePreparation?: { readonly runSetupScript?: boolean };
          }>;
        };
      };
      expect(snapshot.projection.runs[0]?.workspacePreparation?.runSetupScript).toBe(
        scenario.expected,
      );
    }
  });

  it("persists inline dispatch images once and retains their source metadata on replay", async () => {
    const fixture = makeFixture();
    const threadId = ThreadId.make("native-http-inline-image-thread");
    const commandId = CommandId.make("native-http-inline-image-command");
    const messageId = MessageId.make("native-http-inline-image-message");
    const source = {
      kind: "snap-shot" as const,
      capturedAt: NOW,
      appName: "Editor",
      windowTitle: "main.ts",
    };
    const requestBody = {
      type: "thread.turn.start",
      commandId,
      threadId,
      message: {
        messageId,
        role: "user",
        text: "Review this image",
        attachments: [
          {
            type: "image",
            id: "existing-image-ref",
            name: "existing.png",
            mimeType: "image/png",
            sizeBytes: 1,
          },
          {
            type: "image",
            name: "inline.png",
            mimeType: "image/png",
            sizeBytes: 1,
            dataUrl: "data:image/png;base64,YQ==",
            source,
          },
        ],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
      bootstrap: {
        createThread: {
          projectId: PROJECT_ID,
          title: "Inline image thread",
          modelSelection: DEFAULT_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        },
      },
    };

    const first = await fixture.handler(dispatchRequest(requestBody));
    const replay = await fixture.handler(dispatchRequest(requestBody));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    const snapshotResponse = await fixture.handler(threadSnapshotRequest(threadId));
    expect(snapshotResponse.status).toBe(200);
    const snapshot = (await snapshotResponse.json()) as {
      readonly projection: {
        readonly messages: ReadonlyArray<{
          readonly id: string;
          readonly attachments: ReadonlyArray<{
            readonly type: string;
            readonly id: string;
            readonly name: string;
            readonly source?: unknown;
          }>;
        }>;
      };
    };
    expect(snapshot.projection.messages).toHaveLength(1);
    expect(snapshot.projection.messages[0]?.id).toBe(messageId);
    expect(snapshot.projection.messages[0]?.attachments).toEqual([
      {
        type: "image",
        id: "existing-image-ref",
        name: "existing.png",
        mimeType: "image/png",
        sizeBytes: 1,
      },
      {
        type: "image",
        id: expect.any(String),
        name: "inline.png",
        mimeType: "image/png",
        sizeBytes: 1,
        source,
      },
    ]);
  });

  it("rejects an invalid inline image payload before native launch", async () => {
    const fixture = makeFixture();
    const threadId = ThreadId.make("native-http-invalid-inline-image-thread");
    const response = await fixture.handler(
      dispatchRequest({
        type: "thread.turn.start",
        commandId: CommandId.make("native-http-invalid-inline-image-command"),
        threadId,
        message: {
          messageId: MessageId.make("native-http-invalid-inline-image-message"),
          role: "user",
          text: "Reject this image",
          attachments: [
            {
              type: "image",
              name: "invalid.png",
              mimeType: "image/png",
              sizeBytes: 1,
              dataUrl: "data:image/png;base64,%%%",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
        bootstrap: {
          createThread: {
            projectId: PROJECT_ID,
            title: "Invalid inline image thread",
            modelSelection: DEFAULT_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
          },
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      _tag: "EnvironmentRequestInvalidError",
      reason: "invalid_command",
    });
    expect((await fixture.handler(threadSnapshotRequest(threadId))).status).toBe(404);
  });

  it("retries a persisted preparation failure on the same native message and run", async () => {
    let setupAttempts = 0;
    const fixture = makeFixture({
      runSetup: () =>
        Effect.suspend(() => {
          setupAttempts += 1;
          return setupAttempts === 1
            ? Effect.die(new Error("synthetic worktree setup failure"))
            : Effect.succeed({ status: "no-script" as const });
        }),
    });
    const request = {
      project: String(PROJECT_ID),
      message: "Retry native setup",
      idempotencyKey: "retry-same-native-run",
    };
    const identity = getHttpCreateIdentity(SESSION_ID, request.idempotencyKey);
    const failedResponse = await fixture.handler(createRequest(request));
    expect(failedResponse.status).toBe(409);

    const failedSnapshotResponse = await fixture.handler(threadSnapshotRequest(identity.threadId));
    expect(failedSnapshotResponse.status).toBe(200);
    const failedSnapshot = (await failedSnapshotResponse.json()) as {
      readonly projection: {
        readonly messages: ReadonlyArray<{ readonly id: string }>;
        readonly runs: ReadonlyArray<{ readonly id: string; readonly status: string }>;
      };
    };
    expect(failedSnapshot.projection.messages.map((message) => message.id)).toEqual([
      identity.messageId,
    ]);
    expect(failedSnapshot.projection.runs).toHaveLength(1);
    const failedRun = failedSnapshot.projection.runs[0];
    if (failedRun === undefined) throw new Error("Expected the failed native run.");
    expect(failedRun.status).toBe("failed");

    const retryResponse = await fixture.handler(createRequest(request));
    expect(retryResponse.status).toBe(200);
    const retry = (await retryResponse.json()) as OrchestrationCliCreateResult;
    expect(retry.turnId).toBe(failedRun.id);
    expect(retry.replayed).toBe(false);
    expect(setupAttempts).toBe(2);
    expect(fixture.createWorktreeCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(2);

    const replayResponse = await fixture.handler(createRequest(request));
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual({ ...retry, replayed: true });
  });

  it("does not redispatch when native failure persistence is swallowed and the attempt ends", async () => {
    const fixture = makeFixture({
      dropPreparedFail: true,
      runSetup: () => Effect.die(new Error("synthetic setup failure")),
    });
    const request = {
      project: String(PROJECT_ID),
      message: "Preparation failure without durable receipt",
      idempotencyKey: "missing-failure-receipt",
    };
    const first = await fixture.handler(createRequest(request));
    const second = await fixture.handler(createRequest(request));

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(fixture.preparedFailDispatches()).toBe(1);
    expect(fixture.setupCalls()).toBe(1);
    expect(fixture.createWorktreeCalls()).toBe(1);
  });

  it("keeps same-key native preparation alive after the first HTTP observer is cancelled", async () => {
    let notifySetupStarted = () => {};
    const setupStarted = new Promise<void>((resolve) => {
      notifySetupStarted = resolve;
    });
    let releaseSetup = () => {};
    const setupGate = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    const fixture = makeFixture({
      runSetup: () =>
        Effect.promise(async () => {
          notifySetupStarted();
          await setupGate;
          return { status: "no-script" as const };
        }),
    });
    const request = {
      project: String(PROJECT_ID),
      message: "Keep preparation after cancellation",
      idempotencyKey: "cancelled-observer",
    };
    const controller = new AbortController();
    const first = fixture.handler(createRequest(request, controller.signal)).then(
      (response) => ({ response }),
      (error: unknown) => ({ error }),
    );
    await setupStarted;
    const duplicate = fixture.handler(createRequest(request));
    await fixture.waitForAuthCalls(2);
    controller.abort();
    releaseSetup();

    const duplicateResponse = await duplicate;
    await first;
    expect(duplicateResponse.status).toBe(200);
    expect(duplicateResponse.headers.get("content-type")).toContain("application/json");
    expect(await duplicateResponse.json()).toMatchObject({
      threadId: getHttpCreateIdentity(SESSION_ID, request.idempotencyKey).threadId,
      replayed: true,
    });
    expect(fixture.createWorktreeCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(1);
  });

  it("recovers a recorded native run after HTTP completion materialization fails", async () => {
    const fixture = makeFixture({ failComplete: true });
    const request = {
      project: String(PROJECT_ID),
      message: "Recover recorded native run",
      idempotencyKey: "recover-recorded-run",
    };

    const first = await fixture.handler(createRequest(request));
    expect(first.status).toBe(500);
    const recoveredResponse = await fixture.handler(createRequest(request));

    expect(recoveredResponse.status).toBe(200);
    const recovered = (await recoveredResponse.json()) as OrchestrationCliCreateResult;
    expect(recovered).toMatchObject({ replayed: true });
    expect(recovered.turnId).toBeTruthy();
    expect(recovered.sequence).toBeGreaterThan(0);
    expect(fixture.createWorktreeCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(0);
    expect(fixture.completeCalls()).toBe(2);
  });

  it("recovers a missing checkpoint run id only from the frozen initial-message command", async () => {
    const fixture = makeFixture({ failComplete: true, omitCheckpointRun: true });
    const request = {
      project: String(PROJECT_ID),
      message: "Recover by original native message",
      idempotencyKey: "recover-missing-run-id",
    };

    const first = await fixture.handler(createRequest(request));
    expect(first.status).toBe(500);
    const recoveredResponse = await fixture.handler(createRequest(request));

    expect(recoveredResponse.status).toBe(200);
    const recovered = (await recoveredResponse.json()) as OrchestrationCliCreateResult;
    expect(recovered).toMatchObject({ replayed: true });
    expect(recovered.turnId).toBeTruthy();
    expect(recovered.sequence).toBeGreaterThan(0);
    expect(fixture.createWorktreeCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(0);
    expect(fixture.completeCalls()).toBe(2);
  });

  it("recovers an accepted queued release while updater admission holds it", async () => {
    const fixture = makeFixture({
      holdUpdaterRelease: true,
      failComplete: true,
    });
    const request = {
      project: String(PROJECT_ID),
      message: "Recover updater-held native release",
      idempotencyKey: "recover-updater-held-release",
    };

    const first = await fixture.handler(createRequest(request));
    expect(first.status).toBe(500);
    const recoveredResponse = await fixture.handler(createRequest(request));

    expect(recoveredResponse.status).toBe(200);
    const recovered = (await recoveredResponse.json()) as OrchestrationCliCreateResult;
    expect(recovered).toMatchObject({ replayed: true });
    expect(recovered.turnId).toBeTruthy();
    expect(fixture.createWorktreeCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(0);
    expect(fixture.completeCalls()).toBe(2);
  });

  it("does not retry a native preparation failure when retry-ready persistence fails", async () => {
    const fixture = makeFixture({
      failRetryReady: true,
      runSetup: () => Effect.die(new Error("synthetic setup failure")),
    });
    const request = {
      project: String(PROJECT_ID),
      message: "Keep unrecorded retry permission incomplete",
      idempotencyKey: "retry-ready-write-failed",
    };

    const first = await fixture.handler(createRequest(request));
    expect(first.status).toBe(500);
    const second = await fixture.handler(createRequest(request));

    expect(second.status).toBe(409);
    expect(fixture.retryReadyCalls()).toBe(1);
    expect(fixture.setupCalls()).toBe(1);
    expect(fixture.createWorktreeCalls()).toBe(1);
  });

  it("lists and responds to native pending interactions through the SQL ledger", async () => {
    const fixture = makeFixture({ seedPendingInteractions: true });
    fixture.setScopes([AuthOrchestrationReadScope]);
    const listResponse = await fixture.handler(pendingListRequest());
    expect(listResponse.status).toBe(200);
    const listed = (await listResponse.json()) as {
      readonly interactions: ReadonlyArray<{
        readonly requestId: string;
        readonly summary: string;
        readonly canApprove: boolean;
      }>;
    };
    expect(listed.interactions).toEqual([
      expect.objectContaining({
        requestId: PENDING_ANSWER_ID,
        summary: "User input requested",
        canApprove: false,
      }),
      expect.objectContaining({
        requestId: PENDING_APPROVAL_ID,
        summary: "Permission approval requested",
        canApprove: false,
      }),
    ]);

    fixture.setScopes([AuthOrchestrationOperateScope]);
    const answer = await fixture.handler(pendingAnswerRequest("answer-native-response"));
    const answerReplay = await fixture.handler(pendingAnswerRequest("answer-native-response"));
    expect(answer.status).toBe(200);
    expect(answerReplay.status).toBe(200);
    expect(await answer.json()).toMatchObject({ status: "responding", replayed: false });
    expect(await answerReplay.json()).toMatchObject({ status: "responding", replayed: true });

    const approval = await fixture.handler(pendingApproveRequest("unsafe-native-approval"));
    expect(approval.status).toBe(400);
    const rejection = await fixture.handler(pendingRejectRequest("decline-native-approval"));
    const rejectionReplay = await fixture.handler(pendingRejectRequest("decline-native-approval"));
    expect(rejection.status).toBe(200);
    expect(rejectionReplay.status).toBe(200);
    expect(await rejection.json()).toMatchObject({ action: "decline", replayed: false });
    expect(await rejectionReplay.json()).toMatchObject({ action: "decline", replayed: true });
    expect(fixture.pendingRespondDispatches()).toBe(2);
  });

  it("does not redispatch an uncertain SQL response claim after native commit", async () => {
    const fixture = makeFixture({
      seedPendingInteractions: true,
      failPendingRespondDispatch: true,
    });
    const first = await fixture.handler(pendingAnswerRequest("uncertain-native-response"));
    const retry = await fixture.handler(pendingAnswerRequest("uncertain-native-response"));

    expect(first.status).toBe(500);
    expect(retry.status).toBe(404);
    expect(fixture.pendingRespondDispatches()).toBe(1);
  });
});
