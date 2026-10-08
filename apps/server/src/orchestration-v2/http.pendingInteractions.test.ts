import {
  ApprovalRequestId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
  RemotePendingInteractionsResult,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as HttpCreateOperations from "../persistence/OrchestrationHttpCreateOperations.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStoreV2 from "./EventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ManualThreadCompaction from "./ManualThreadCompaction.ts";
import * as ServerConfig from "../config.ts";
import * as PendingInteractionService from "./PendingInteractionService.ts";
import * as OrchestrationHttp from "./http.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

const TestHttpApi = HttpApi.make("environment").add(EnvironmentHttpApi.groups.orchestration);
const AUTHORIZATION = { authorization: "Bearer test" };
const SESSION_ID = AuthSessionId.make("authenticated-session");
const THREAD_ID = ThreadId.make("thread-1");
const REQUEST_ID = ApprovalRequestId.make("request-1");
const decodeRemotePendingInteractionsResult = Schema.decodeUnknownSync(
  RemotePendingInteractionsResult,
);

const safeListResult = decodeRemotePendingInteractionsResult({
  interactions: [
    {
      threadId: THREAD_ID,
      requestId: REQUEST_ID,
      kind: "user-input",
      status: "pending",
      summary: "Safe input",
      canApprove: false,
      allowedActions: ["answer"],
      questions: [
        {
          id: "question-1",
          header: "Choice",
          prompt: "Choose a safe value.",
          options: [{ label: "Continue", description: "Continue safely." }],
          multiSelect: false,
          allowsCustomAnswer: false,
        },
      ],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    },
  ],
});

type PendingInteractionServiceShape =
  PendingInteractionService.PendingInteractionService["Service"];
type RespondInput = Parameters<PendingInteractionServiceShape["respond"]>[0];

const makePendingInteractionService = (options: {
  readonly list?: PendingInteractionServiceShape["list"];
  readonly respond?: PendingInteractionServiceShape["respond"];
}) => {
  const listInputs: Array<{ readonly threadId?: ThreadId }> = [];
  const respondInputs: RespondInput[] = [];
  const service = PendingInteractionService.PendingInteractionService.of({
    list: (input) => {
      listInputs.push(input);
      return options.list?.(input) ?? Effect.succeed(safeListResult);
    },
    respond: (input) => {
      respondInputs.push(input);
      return (
        options.respond?.(input) ??
        Effect.succeed({
          threadId: input.threadId,
          requestId: input.requestId,
          status: "responding" as const,
          action: input.action,
          idempotencyKey: input.idempotencyKey,
          replayed: false,
        })
      );
    },
  });
  return { service, listInputs, respondInputs };
};

const makeHandler = (
  options: {
    readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
    readonly list?: PendingInteractionServiceShape["list"];
    readonly respond?: PendingInteractionServiceShape["respond"];
  } = {},
) => {
  const pending = makePendingInteractionService(options);
  const scopes = new Set(options.scopes ?? []);
  const principal = {
    sessionId: SESSION_ID,
    subject: "test",
    method: "bearer-access-token" as const,
    scopes,
  };
  const authenticatedAuthLayer = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (request.headers.authorization !== AUTHORIZATION.authorization) {
        return yield* new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason:
            request.headers.authorization === undefined
              ? "missing_credential"
              : "invalid_credential",
          traceId: "test-trace",
        });
      }
      return yield* Effect.provideService(httpEffect, EnvironmentAuthenticatedPrincipal, principal);
    }),
  );
  const dispatchInputs: unknown[] = [];
  const receipts = new Map<CommandId, CommandReceiptStore.CommandReceiptV2>();
  const threadManagementLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({
    dispatch: (command) => {
      dispatchInputs.push(command);
      if (!("threadId" in command)) {
        return Effect.die("pending interaction command must target a thread");
      }
      receipts.set(command.commandId, {
        commandId: command.commandId,
        threadId: command.threadId,
        commandType: command.type,
        acceptedAt: DateTime.makeUnsafe("2026-10-06T00:00:00.000Z"),
        resultSequence: 1,
        status: "accepted",
        error: null,
      });
      return Effect.succeed({ sequence: 1, storedEvents: [] });
    },
  });
  const commandReceiptLayer = Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
    getByCommandId: (commandId) =>
      Effect.succeed(Option.fromNullishOr(receipts.get(commandId) ?? null)),
    getProjectByCommandId: () => Effect.succeed(Option.none()),
  });
  const pendingLayer = Layer.succeed(
    PendingInteractionService.PendingInteractionService,
    pending.service,
  );
  const compactionLayer = Layer.mock(ManualThreadCompaction.ManualThreadCompaction)({});
  const orchestrationServicesLayer = Layer.mergeAll(
    threadManagementLayer,
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
    Layer.mock(HttpCreateOperations.OrchestrationHttpCreateOperations)({}),
    commandReceiptLayer,
    Layer.mock(EventStoreV2.EventStoreV2)({}),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    pendingLayer,
    compactionLayer,
    layerMemory,
  );
  const routesLayer = HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(authenticatedAuthLayer),
    Layer.provideMerge(orchestrationServicesLayer),
    Layer.provide(NodeServices.layer),
    Layer.provide(FileSystem.layerNoop({})),
    Layer.provide(Path.layer),
    Layer.provide(
      Layer.succeed(ServerConfig.ServerConfig, {} as ServerConfig.ServerConfig["Service"]),
    ),
    Layer.provide(
      Layer.succeed(WorkspacePaths.WorkspacePaths, {} as WorkspacePaths.WorkspacePaths["Service"]),
    ),
    Layer.provide(HttpServer.layerServices),
  );
  const webHandler = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  disposers.push(webHandler.dispose);
  const requestContext = Context.empty().pipe(
    Context.add(FileSystem.FileSystem, {} as FileSystem.FileSystem),
    Context.add(Path.Path, {} as Path.Path),
    Context.add(ServerConfig.ServerConfig, {} as ServerConfig.ServerConfig["Service"]),
    Context.add(WorkspacePaths.WorkspacePaths, {} as WorkspacePaths.WorkspacePaths["Service"]),
  );
  const handler = (request: Request) => webHandler.handler(request, requestContext);
  return { ...webHandler, handler, ...pending, dispatchInputs };
};

const jsonRequest = (url: string, body: unknown, authorization = true) =>
  new Request(url, {
    method: "POST",
    headers: {
      ...(authorization ? AUTHORIZATION : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const responseBody = async (response: Response) =>
  (await response.json()) as Record<string, unknown>;

const responseInput = (overrides: Record<string, unknown> = {}) => ({
  threadId: THREAD_ID,
  requestId: REQUEST_ID,
  idempotencyKey: "response-key",
  ...overrides,
});

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    await dispose();
  }
});

describe("pending interaction HTTP endpoints", () => {
  it("lists redacted bounded interaction documents with read scope and preserves the thread filter", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationReadScope] });
    const response = await fixture.handler(
      new Request("http://t3.test/api/orchestration/pending-interactions?threadId=thread-1", {
        headers: AUTHORIZATION,
      }),
    );

    expect(response.status).toBe(200);
    const body = await responseBody(response);
    expect(body).toEqual(safeListResult);
    expect(decodeRemotePendingInteractionsResult(body)).toEqual(body);
    expect(fixture.listInputs).toEqual([{ threadId: THREAD_ID }]);
  });

  it("requires read scope for GET and operate scope for every response endpoint", async () => {
    const operateOnly = makeHandler({ scopes: [AuthOrchestrationOperateScope] });
    const getResponse = await operateOnly.handler(
      new Request("http://t3.test/api/orchestration/pending-interactions", {
        headers: AUTHORIZATION,
      }),
    );
    expect(getResponse.status).toBe(403);

    const readOnly = makeHandler({ scopes: [AuthOrchestrationReadScope] });
    const postResponse = await readOnly.handler(
      jsonRequest("http://t3.test/api/orchestration/pending-interactions/approve", responseInput()),
    );
    expect(postResponse.status).toBe(403);
    expect(readOnly.respondInputs).toHaveLength(0);
  });

  it("forwards only the authenticated principal session to answer, approve, and reject handlers", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationOperateScope] });
    const requests = [
      [
        "/api/orchestration/pending-interactions/answer",
        responseInput({ answers: [{ questionId: "question-1", values: ["Continue"] }] }),
        "answer",
      ],
      ["/api/orchestration/pending-interactions/approve", responseInput(), "approve"],
      [
        "/api/orchestration/pending-interactions/reject",
        responseInput({ decision: "cancel" }),
        "cancel",
      ],
    ] as const;

    for (const [path, body, action] of requests) {
      const response = await fixture.handler(jsonRequest(`http://t3.test${path}`, body));
      expect(response.status).toBe(200);
      expect((await responseBody(response)).action).toBe(action);
    }

    expect(fixture.respondInputs).toEqual([
      {
        authSessionId: SESSION_ID,
        threadId: THREAD_ID,
        requestId: REQUEST_ID,
        idempotencyKey: "response-key",
        action: "answer",
        answers: [{ questionId: "question-1", values: ["Continue"] }],
      },
      {
        authSessionId: SESSION_ID,
        threadId: THREAD_ID,
        requestId: REQUEST_ID,
        idempotencyKey: "response-key",
        action: "approve",
      },
      {
        authSessionId: SESSION_ID,
        threadId: THREAD_ID,
        requestId: REQUEST_ID,
        idempotencyKey: "response-key",
        action: "cancel",
      },
    ]);
  });

  it("rejects caller-supplied authSessionId and other excess response fields before service invocation", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationOperateScope] });
    const response = await fixture.handler(
      jsonRequest(
        "http://t3.test/api/orchestration/pending-interactions/approve",
        responseInput({ authSessionId: "attacker-session", unexpected: "field" }),
      ),
    );

    expect(response.status).toBe(400);
    expect(fixture.respondInputs).toHaveLength(0);
  });

  it("maps missing or stale interactions to 404 and semantic conflicts to 400", async () => {
    const unavailable = makeHandler({
      scopes: [AuthOrchestrationOperateScope],
      respond: () =>
        Effect.fail(new PendingInteractionService.PendingInteractionUnavailableError()),
    });
    const unavailableResponse = await unavailable.handler(
      jsonRequest("http://t3.test/api/orchestration/pending-interactions/approve", responseInput()),
    );
    expect(unavailableResponse.status).toBe(404);
    expect((await responseBody(unavailableResponse)).reason).toBe("pending_interaction_not_found");

    const conflict = makeHandler({
      scopes: [AuthOrchestrationOperateScope],
      respond: () =>
        Effect.fail(
          new PendingInteractionService.PendingInteractionInvalidResponseError({
            reason: "idempotency_conflict",
          }),
        ),
    });
    const conflictResponse = await conflict.handler(
      jsonRequest("http://t3.test/api/orchestration/pending-interactions/approve", responseInput()),
    );
    expect(conflictResponse.status).toBe(400);
    expect((await responseBody(conflictResponse)).reason).toBe("invalid_interaction");
  });

  it("keeps authentication failures separate from scope failures", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationReadScope] });
    const response = await fixture.handler(
      new Request("http://t3.test/api/orchestration/pending-interactions", {
        headers: { authorization: "Bearer invalid" },
      }),
    );

    expect(response.status).toBe(401);
  });

  it("uses endpoint-specific internal failure reasons for list and response failures", async () => {
    const listFailure = makeHandler({
      scopes: [AuthOrchestrationReadScope],
      list: () =>
        Effect.fail(new PersistenceSqlError({ operation: "PendingInteractionQuery.list:test" })),
    });
    const listResponse = await listFailure.handler(
      new Request("http://t3.test/api/orchestration/pending-interactions", {
        headers: AUTHORIZATION,
      }),
    );
    expect(listResponse.status).toBe(500);
    expect((await responseBody(listResponse)).reason).toBe("pending_interactions_read_failed");

    const responseFailure = makeHandler({
      scopes: [AuthOrchestrationOperateScope],
      respond: () =>
        Effect.fail(
          new PersistenceSqlError({ operation: "PendingInteractionService.respond:test" }),
        ),
    });
    const response = await responseFailure.handler(
      jsonRequest("http://t3.test/api/orchestration/pending-interactions/approve", responseInput()),
    );
    expect(response.status).toBe(500);
    expect((await responseBody(response)).reason).toBe("pending_interaction_response_failed");
  });
});

describe("orchestration dispatch interaction guard", () => {
  const approvalRespondCommand = {
    type: "thread.approval.respond" as const,
    commandId: "command-1",
    threadId: THREAD_ID,
    requestId: REQUEST_ID,
    decision: "accept",
    createdAt: "2026-07-22T00:00:00.000Z",
  };
  const userInputRespondCommand = {
    type: "thread.user-input.respond" as const,
    commandId: "command-2",
    threadId: THREAD_ID,
    requestId: REQUEST_ID,
    answers: { "question-1": ["Continue"] },
    createdAt: "2026-07-22T00:00:00.000Z",
  };
  const genericCommand = {
    type: "thread.meta.update" as const,
    commandId: "command-3",
    threadId: THREAD_ID,
    title: "Updated from the native HTTP adapter",
  };

  const expectDispatchRejected = async (
    command: Record<string, unknown>,
    fixture: ReturnType<typeof makeHandler>,
  ) => {
    const response = await fixture.handler(
      jsonRequest("http://t3.test/api/orchestration/dispatch", command),
    );
    expect(response.status).toBe(400);
    expect((await responseBody(response)).reason).toBe("invalid_command");
    expect(fixture.dispatchInputs).toHaveLength(0);
    expect(fixture.respondInputs).toHaveLength(0);
  };

  it("rejects approval responses sent through generic dispatch, even when they look valid", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationOperateScope] });
    await expectDispatchRejected(approvalRespondCommand, fixture);
  });

  it("rejects user-input responses sent through generic dispatch so claims and policy cannot be bypassed", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationOperateScope] });
    await expectDispatchRejected(userInputRespondCommand, fixture);
  });

  it("translates ordinary metadata commands to native dispatch with a valid operate token", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationOperateScope] });
    const response = await fixture.handler(
      jsonRequest("http://t3.test/api/orchestration/dispatch", genericCommand),
    );
    expect(response.status).toBe(200);
    expect(fixture.dispatchInputs).toHaveLength(1);
    expect(fixture.dispatchInputs[0]).toMatchObject({ type: "thread.metadata.update" });
    expect(fixture.respondInputs).toHaveLength(0);
  });

  it("reports missing credentials before revealing any command policy", async () => {
    const fixture = makeHandler({ scopes: [AuthOrchestrationOperateScope] });
    const response = await fixture.handler(
      jsonRequest("http://t3.test/api/orchestration/dispatch", approvalRespondCommand, false),
    );
    expect(response.status).toBe(401);
    expect(fixture.dispatchInputs).toHaveLength(0);
    expect(fixture.respondInputs).toHaveLength(0);
  });
});
