import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  type EnvironmentSessionPrincipalShape,
  EnvironmentHttpApi,
  EnvironmentThreadCompactionError,
  type OrchestrationCompactRequest,
  type OrchestrationCompactResult,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as EnvironmentHttpAuth from "../auth/http.ts";
import { ServerConfig } from "../config.ts";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as HttpCreateOperations from "../persistence/OrchestrationHttpCreateOperations.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStoreV2 from "./EventStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as PendingInteractionService from "./PendingInteractionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as OrchestrationHttp from "./http.ts";
import {
  ManualCompactionInvalidRequestError,
  ManualCompactionThreadNotFoundError,
  ManualThreadCompaction,
  type ManualThreadCompactionError,
  type ManualThreadCompactionShape,
} from "./ManualThreadCompaction.ts";

const makeTestAuthLayer = (tokens: ReadonlyMap<string, EnvironmentSessionPrincipalShape>) => {
  const authenticateHttpRequest: EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"] =
    (request) => {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      if (token === undefined) {
        return Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}));
      }
      const session = tokens.get(token);
      if (session === undefined) {
        return Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}));
      }
      return Effect.succeed({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        scopes: [...session.scopes],
        ...(session.proofKeyThumbprint === undefined
          ? {}
          : { proofKeyThumbprint: session.proofKeyThumbprint }),
        ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
      });
    };

  const auth = EnvironmentAuth.EnvironmentAuth.of({
    getDescriptor: () => Effect.die("unused"),
    authenticateMcpClient: () => Effect.die("unused"),
    issueMcpClientSession: () => Effect.die("unused"),
    consumeMcpApprovalCode: () => Effect.die("unused"),
    authenticateBrowserSession: () => Effect.die("unused"),
    getSessionState: () => Effect.die("unused"),
    createBrowserSession: () => Effect.die("unused"),
    exchangeBootstrapCredentialForAccessToken: () => Effect.die("unused"),
    createPairingLink: () => Effect.die("unused"),
    issuePairingCredential: () => Effect.die("unused"),
    issueStartupPairingCredential: () => Effect.die("unused"),
    listPairingLinks: () => Effect.die("unused"),
    revokePairingLink: () => Effect.die("unused"),
    issueSession: () => Effect.die("unused"),
    listSessions: () => Effect.die("unused"),
    revokeSession: () => Effect.die("unused"),
    revokeOtherSessionsExcept: () => Effect.die("unused"),
    listClientSessions: () => Effect.die("unused"),
    revokeClientSession: () => Effect.die("unused"),
    revokeOtherClientSessions: () => Effect.die("unused"),
    authenticateHttpRequest,
    authenticateWebSocketUpgrade: authenticateHttpRequest,
    issueWebSocketTicket: () => Effect.die("unused"),
    issueStartupPairingUrl: () => Effect.die("unused"),
  });

  return Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth);
};

const operateSession: EnvironmentSessionPrincipalShape = {
  sessionId: AuthSessionId.make("session-operate"),
  subject: "user-operate",
  method: "bearer-access-token",
  scopes: new Set([AuthOrchestrationOperateScope]),
};

const operateTokens = new Map([["operate-token", operateSession]]);
const readOnlyTokens = new Map([
  [
    "read-token",
    { ...operateSession, subject: "user-read", scopes: new Set([AuthOrchestrationReadScope]) },
  ],
]);

interface CompactionCall {
  readonly sessionId: string;
  readonly request: OrchestrationCompactRequest;
}

const makeCompactionStub = () => {
  const calls: Array<CompactionCall> = [];
  let scenario:
    | ((
        sessionId: string,
        request: OrchestrationCompactRequest,
      ) => Effect.Effect<OrchestrationCompactResult, ManualThreadCompactionError>)
    | undefined;
  const stub: ManualThreadCompactionShape = {
    compact: (sessionId, request) =>
      Effect.suspend(() => {
        calls.push({ sessionId, request });
        return scenario === undefined
          ? Effect.die("compaction scenario not configured")
          : scenario(sessionId, request);
      }),
  };
  return {
    stub,
    calls,
    onCompact: (
      next: (
        sessionId: string,
        request: OrchestrationCompactRequest,
      ) => Effect.Effect<OrchestrationCompactResult, ManualThreadCompactionError>,
    ) => {
      scenario = next;
    },
    reset: () => {
      calls.length = 0;
      scenario = undefined;
    },
  };
};

const compaction = makeCompactionStub();
const compactStubLayer = Layer.succeed(ManualThreadCompaction, compaction.stub);

const threadManagementLayer = Layer.mock(ThreadManagementService.ThreadManagementService)({});

const platformLayer = Layer.mergeAll(
  NodeServices.layer,
  Etag.layer,
  HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer), Layer.provide(Etag.layer)),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-compact-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  WorkspacePaths.layer.pipe(Layer.provide(NodeServices.layer)),
);

const makeFixture = (tokens: ReadonlyMap<string, EnvironmentSessionPrincipalShape>) => {
  class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.orchestration) {}
  const orchestrationServicesLayer = Layer.mergeAll(
    compactStubLayer,
    threadManagementLayer,
    Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
    Layer.mock(ProjectStore.ProjectStoreV2)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
    Layer.mock(HttpCreateOperations.OrchestrationHttpCreateOperations)({}),
    Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({}),
    Layer.mock(EventStoreV2.EventStoreV2)({}),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(PendingInteractionService.PendingInteractionService)({}),
    Layer.mock(Orchestrator.OrchestratorV2)({}),
    layerMemory,
  );
  const routesLayer = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(OrchestrationHttp.layer),
    Layer.provide(
      EnvironmentHttpAuth.layerAuthenticatedAuth.pipe(Layer.provide(makeTestAuthLayer(tokens))),
    ),
    Layer.provideMerge(orchestrationServicesLayer),
    Layer.provideMerge(platformLayer),
  );
  const webHandler = HttpRouter.toWebHandler(routesLayer, { disableLogger: true });
  return {
    handler: (request: Request) => webHandler.handler(request, Context.empty()),
    dispose: webHandler.dispose,
  };
};

type TestHandler = (request: Request) => Promise<Response>;

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const postJson = async (
  handler: TestHandler,
  path: string,
  token: string | undefined,
  body: unknown,
) => {
  const response = await handler(
    new Request(`http://t3.test${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await response.text();
  const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
  if (!isJsonRecord(parsed)) {
    throw new Error("Expected an object JSON response.");
  }
  return {
    response,
    text,
    json: parsed,
  };
};

const compactBody = (idempotencyKey: string, threadId = "thread-1") => ({
  threadId,
  idempotencyKey,
});

const encodeCompactBody = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String, idempotencyKey: Schema.String })),
);

describe("orchestration http compact", () => {
  it("rejects unauthenticated compact requests with 401", async () => {
    const { handler, dispose } = makeFixture(operateTokens);
    const { response, json } = await postJson(
      handler,
      "/api/orchestration/compact",
      undefined,
      compactBody("key-1"),
    );
    expect(response.status).toBe(401);
    expect(json.code).toBe("auth_invalid");
    expect(compaction.calls).toHaveLength(0);
    await dispose();
  });

  it("rejects read-scoped sessions with 403", async () => {
    const { handler, dispose } = makeFixture(readOnlyTokens);
    const { response, json } = await postJson(
      handler,
      "/api/orchestration/compact",
      "read-token",
      compactBody("key-1"),
    );
    expect(response.status).toBe(403);
    expect(json.code).toBe("insufficient_scope");
    expect(compaction.calls).toHaveLength(0);
    await dispose();
  });

  it("compacts under the authenticated session identity, ignoring a spoofed sessionId", async () => {
    compaction.reset();
    compaction.onCompact(() =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        commandId: CommandId.make("cli-compact:abc"),
        sequence: 3,
        replayed: false,
      }),
    );
    const { handler, dispose } = makeFixture(operateTokens);
    const { response, json } = await postJson(
      handler,
      "/api/orchestration/compact",
      "operate-token",
      {
        ...compactBody("key-1"),
        sessionId: "spoofed-session",
      },
    );
    expect(response.status).toBe(200);
    expect(json.threadId).toBe("thread-1");
    expect(json.sequence).toBe(3);
    expect(compaction.calls).toHaveLength(1);
    expect(compaction.calls[0]?.sessionId).toBe("session-operate");
    expect(compaction.calls[0]?.request.idempotencyKey).toBe("key-1");
    await dispose();
  });

  it("passes a typed compaction failure through as 409", async () => {
    compaction.reset();
    compaction.onCompact(() =>
      Effect.fail(
        new EnvironmentThreadCompactionError({
          code: "thread_compaction_failed",
          reason: "active-thread",
          traceId: "trace-compact-409",
        }),
      ),
    );
    const { handler, dispose } = makeFixture(operateTokens);
    const { response, json } = await postJson(
      handler,
      "/api/orchestration/compact",
      "operate-token",
      compactBody("key-1"),
    );
    expect(response.status).toBe(409);
    expect(json.code).toBe("thread_compaction_failed");
    expect(json.reason).toBe("active-thread");
    await dispose();
  });

  it("maps an unknown thread to 404 not_found", async () => {
    compaction.reset();
    compaction.onCompact(() =>
      Effect.fail(new ManualCompactionThreadNotFoundError({ threadId: ThreadId.make("ghost") })),
    );
    const { handler, dispose } = makeFixture(operateTokens);
    const { response, json } = await postJson(
      handler,
      "/api/orchestration/compact",
      "operate-token",
      compactBody("key-1", "ghost"),
    );
    expect(response.status).toBe(404);
    expect(json.code).toBe("not_found");
    expect(json.reason).toBe("thread_not_found");
    await dispose();
  });

  it("maps invalid compaction requests and native receipt identity conflicts to 400", async () => {
    compaction.reset();
    compaction.onCompact(() =>
      Effect.fail(
        new ManualCompactionInvalidRequestError({
          message: "Idempotency key is already used for another thread.",
        }),
      ),
    );
    const { handler, dispose } = makeFixture(operateTokens);
    const invalid = await postJson(
      handler,
      "/api/orchestration/compact",
      "operate-token",
      compactBody("key-1"),
    );
    expect(invalid.response.status).toBe(400);
    expect(invalid.json.reason).toBe("invalid_command");

    compaction.reset();
    compaction.onCompact(() =>
      Effect.fail(
        new ManualCompactionInvalidRequestError({
          message: "The compaction idempotency key is already bound to another command.",
        }),
      ),
    );
    const identityConflict = await postJson(
      handler,
      "/api/orchestration/compact",
      "operate-token",
      compactBody("key-2"),
    );
    expect(identityConflict.response.status).toBe(400);
    await dispose();
  });

  effectIt.effect(
    "lets a disconnecting requester abandon its compact await without disturbing the job",
    () =>
      Effect.gen(function* () {
        compaction.reset();
        // The real service runs jobs in the server application scope; the HTTP
        // requester merely awaits the outcome. This stub mirrors that shape: the
        // requester disconnect mid-await must not cancel or error the stub job.
        const jobStarted = yield* Deferred.make<void>();
        const settled = yield* Deferred.make<
          OrchestrationCompactResult,
          ManualThreadCompactionError
        >();
        const job = Effect.gen(function* () {
          yield* Deferred.succeed(jobStarted, undefined);
          return yield* Deferred.await(settled);
        });
        compaction.onCompact(() => job);
        const { handler, dispose } = makeFixture(operateTokens);
        const signal = AbortSignal.timeout(50);
        const responseFiber = yield* Effect.promise(() =>
          handler(
            new Request("http://t3.test/api/orchestration/compact", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: "Bearer operate-token",
              },
              body: encodeCompactBody(compactBody("disconnect-key")),
              signal,
            }),
          ).then(
            (response) => response,
            () => undefined,
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(jobStarted);
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
              } else {
                signal.addEventListener("abort", () => resolve(), { once: true });
              }
            }),
        );
        // The requester is gone by now (its fetch aborted); finishing the job must
        // still succeed — the service instance stays untouched by the disconnect.
        expect(compaction.calls[0]?.request.idempotencyKey).toBe("disconnect-key");
        yield* Deferred.succeed(settled, {
          threadId: ThreadId.make("thread-1"),
          commandId: CommandId.make("cli-compact:disconnected"),
          sequence: 9,
          replayed: false,
        });
        const outcome = yield* Fiber.join(responseFiber);
        expect(outcome?.status ?? "aborted").toBeDefined();
        yield* Effect.promise(() => dispose());
      }),
  );
});
