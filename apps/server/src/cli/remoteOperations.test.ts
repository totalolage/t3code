import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  AuthSessionId,
  AuthSessionState,
  EnvironmentConflictError,
  EnvironmentInternalError,
  EnvironmentRequestInvalidError,
  ExecutionEnvironmentDescriptor,
  OrchestrationCliDispatchCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import type { RemoteCliTarget } from "./remoteTarget.ts";
import {
  keyedSendCommandId,
  sendThreadMessage,
  type RemoteOperationsContext,
} from "./remoteOperations.ts";
import { RemoteCliError } from "./remoteHttp.ts";

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchLayer = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(
    NodeCrypto.layer,
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
  );

const routingFetch = (
  requests: Array<Request>,
  respond: (request: Request, ordinal: number) => Response | Promise<Response>,
): typeof globalThis.fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    return respond(request, requests.length);
  }) as typeof globalThis.fetch;

const threadSnapshot = (threadId: string) => {
  const now = "2026-10-06T00:00:00.000Z";
  return {
    snapshotSequence: 7,
    projection: {
      thread: {
        createdBy: "user",
        creationSource: "server",
        id: threadId,
        projectId: "project-1",
        title: "Remote thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        hiddenAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [],
      updatedAt: now,
    },
  };
};

const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
  environmentId: "environment-1",
  label: "Remote environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.40",
  capabilities: { repositoryIdentity: false },
});
const decodeAuthSessionState = Schema.decodeUnknownSync(AuthSessionState);

const session = (withPrincipal = true) =>
  decodeAuthSessionState({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3-session",
    },
    sessionMethod: "bearer-access-token",
    scopes: ["orchestration:read", "orchestration:operate"],
    ...(withPrincipal
      ? { principal: { sessionId: "session-1", subject: "local-cli:environment-1" } }
      : {}),
  });

const context = (withPrincipal = true): RemoteOperationsContext => ({
  target: {
    kind: "remote",
    httpBaseUrl: "https://remote.example",
    environment: descriptor,
    tokenStateDirectory: "/unused/remote-cli",
    tokenKey: "https://remote.example",
  } satisfies RemoteCliTarget,
  accessToken: "access-secret",
  session: session(withPrincipal),
});

const requestText = (request: Request | undefined) =>
  Effect.promise(() => request?.clone().text() ?? Promise.resolve(""));
const decodeDispatchCommand = Schema.decodeUnknownSync(
  Schema.fromJsonString(OrchestrationCliDispatchCommand),
);
const encodeDispatchCommand = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationCliDispatchCommand),
);

const sendRequests = (requests: ReadonlyArray<Request>) =>
  requests.filter(
    (request) => request.method === "POST" && request.url.endsWith("/api/orchestration/dispatch"),
  );

const withThreadSnapshots = (
  requests: Array<Request>,
  respond: (request: Request, ordinal: number) => Response | Promise<Response>,
) =>
  routingFetch(requests, (request, _ordinal) => {
    if (request.method === "GET" && request.url.includes("/api/orchestration/threads/")) {
      const threadId = new URL(request.url).pathname.split("/").at(-1) ?? "thread-1";
      return jsonResponse(threadSnapshot(threadId));
    }
    return respond(request, sendRequests(requests).length);
  });

const accepted = (_threadId?: string, _commandId?: string) => ({ sequence: 41 });

const TRACE_ID = "0123456789abcdef0123456789abcdef";

describe("remote CLI send", () => {
  it.effect("derives keyed command ids from the raw session and key", () =>
    Effect.gen(function* () {
      const sessionId = AuthSessionId.make("session-1");
      const padded = yield* keyedSendCommandId(sessionId, " key ");
      assert.equal(
        padded,
        "cli-send:94e336f61d06a91441e9d31617004634ec1cfceaa51a5c5f378090e041a6596c",
      );
      assert.equal(padded, yield* keyedSendCommandId(sessionId, " key "));
      assert.notEqual(padded, yield* keyedSendCommandId(sessionId, "key"));
      assert.notEqual(
        yield* keyedSendCommandId(sessionId, "key"),
        yield* keyedSendCommandId(AuthSessionId.make("session-2"), "key"),
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("requires a session principal before sending a keyed command", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const error = yield* sendThreadMessage(context(false), {
        threadId: ThreadId.make("thread-1"),
        message: "hello",
        idempotencyKey: "key",
      }).pipe(Effect.flip);

      assert.instanceOf(error, RemoteCliError);
      assert.equal(error.reason, "invalid-input");
      assert.lengthOf(requests, 0);
    }).pipe(Effect.provide(fetchLayer(routingFetch(requests, () => jsonResponse({})))));
  });

  it.effect("accepts only raw idempotency keys from 1 through 256 characters", () => {
    const requests: Array<Request> = [];
    const boundaryKeys = ["k", "k".repeat(256)];
    return Effect.gen(function* () {
      for (const key of ["", "k".repeat(257)]) {
        const error = yield* sendThreadMessage(context(), {
          threadId: ThreadId.make("thread-1"),
          message: "hello",
          idempotencyKey: key,
        }).pipe(Effect.flip);
        assert.instanceOf(error, RemoteCliError);
        assert.equal(error.reason, "invalid-input");
      }

      for (const key of boundaryKeys) {
        const expectedCommandId = yield* keyedSendCommandId(AuthSessionId.make("session-1"), key);
        const result = yield* sendThreadMessage(context(), {
          threadId: ThreadId.make("thread-1"),
          message: "hello",
          idempotencyKey: key,
        });
        assert.equal(result.commandId, expectedCommandId);
      }
      assert.lengthOf(sendRequests(requests), 2);
    }).pipe(
      Effect.provide(
        fetchLayer(
          withThreadSnapshots(requests, async (request) => {
            const payload = JSON.parse(await request.clone().text()) as {
              threadId: string;
              commandId: string;
            };
            return jsonResponse(accepted(payload.threadId, payload.commandId));
          }),
        ),
      ),
    );
  });

  it.effect(
    "sends one unchanged native turn-start command to the canonical dispatch endpoint",
    () => {
      const requests: Array<Request> = [];
      const message = "  keep whitespace\nexactly  ";
      const threadId = ThreadId.make("thread-1");
      return Effect.gen(function* () {
        const result = yield* sendThreadMessage(context(), {
          threadId,
          message,
          idempotencyKey: "raw key",
        });

        const sent = sendRequests(requests);
        assert.equal(result.threadId, threadId);
        const expectedCommandId = yield* keyedSendCommandId(
          AuthSessionId.make("session-1"),
          "raw key",
        );
        assert.equal(result.commandId, expectedCommandId);
        assert.equal(result.sequence, 41);
        assert.equal(result.recovered, false);
        assert.lengthOf(sent, 1);
        assert.equal(sent[0]?.method, "POST");
        assert.equal(sent[0]?.headers.get("authorization"), "Bearer access-secret");
        assert.deepEqual(
          encodeDispatchCommand(decodeDispatchCommand(yield* requestText(sent[0]))),
          {
            type: "thread.turn.start",
            commandId: result.commandId,
            threadId,
            message: {
              messageId: result.commandId,
              role: "user",
              text: message,
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "1970-01-01T00:00:00.000Z",
          },
        );
      }).pipe(
        Effect.provide(fetchLayer(withThreadSnapshots(requests, () => jsonResponse(accepted())))),
      );
    },
  );

  it.effect("retries an unknown native outcome once with identical request bytes", () => {
    const requests: Array<Request> = [];
    const threadId = ThreadId.make("thread-1");
    return Effect.gen(function* () {
      const result = yield* sendThreadMessage(context(), {
        threadId,
        message: "hello",
        idempotencyKey: "retry-key",
      });

      const sent = sendRequests(requests);
      assert.equal(result.sequence, 41);
      assert.equal(result.recovered, true);
      assert.lengthOf(sent, 2);
      assert.equal(yield* requestText(sent[0]), yield* requestText(sent[1]));
    }).pipe(
      Effect.provide(
        fetchLayer(
          withThreadSnapshots(requests, (_request, ordinal) =>
            ordinal === 1
              ? jsonResponse(
                  {
                    _tag: "EnvironmentInternalError",
                    code: "internal_error",
                    reason: "orchestration_send_outcome_unknown",
                    traceId: TRACE_ID,
                  },
                  500,
                )
              : jsonResponse(accepted()),
          ),
        ),
      ),
    );
  });

  it.effect("does not retry the typed unknown result when retry is disabled", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const error = yield* sendThreadMessage(context(), {
        threadId: ThreadId.make("thread-1"),
        message: "hello",
        idempotencyKey: "retry-key",
        retryAmbiguous: false,
      }).pipe(Effect.flip);

      assert.instanceOf(error, EnvironmentInternalError);
      assert.equal(error.reason, "orchestration_send_outcome_unknown");
      assert.lengthOf(sendRequests(requests), 1);
    }).pipe(
      Effect.provide(
        fetchLayer(
          withThreadSnapshots(requests, () =>
            jsonResponse(
              {
                _tag: "EnvironmentInternalError",
                code: "internal_error",
                reason: "orchestration_send_outcome_unknown",
                traceId: TRACE_ID,
              },
              500,
            ),
          ),
        ),
      ),
    );
  });

  it.effect("does not retry declared request or command-id conflicts", () => {
    const requests: Array<Request> = [];
    const responses = [
      jsonResponse(
        {
          _tag: "EnvironmentRequestInvalidError",
          code: "invalid_request",
          reason: "invalid_command",
          traceId: TRACE_ID,
        },
        400,
      ),
      jsonResponse(
        {
          _tag: "EnvironmentConflictError",
          code: "conflict",
          reason: "idempotency_payload_mismatch",
          message: "The command id belongs to another thread.",
          traceId: TRACE_ID,
        },
        409,
      ),
    ];
    let scenario = 0;
    return Effect.gen(function* () {
      for (const [index] of [EnvironmentRequestInvalidError, EnvironmentConflictError].entries()) {
        const error = yield* sendThreadMessage(context(), {
          threadId: ThreadId.make("thread-1"),
          message: "hello",
          idempotencyKey: `declared-${index}`,
        }).pipe(Effect.flip);
        if (index === 0) assert.instanceOf(error, EnvironmentRequestInvalidError);
        else assert.instanceOf(error, EnvironmentConflictError);
      }
      assert.equal(scenario, 2);
      assert.lengthOf(sendRequests(requests), 2);
    }).pipe(
      Effect.provide(
        fetchLayer(
          withThreadSnapshots(requests, () => {
            const response = responses[scenario];
            scenario += 1;
            return response ?? jsonResponse({});
          }),
        ),
      ),
    );
  });

  it.effect("returns ambiguous-dispatch after a second uncertain result", () => {
    const requests: Array<Request> = [];
    const threadId = ThreadId.make("thread-1");
    return Effect.gen(function* () {
      const error = yield* sendThreadMessage(context(), {
        threadId,
        message: "hello",
        idempotencyKey: "retry-key",
      }).pipe(Effect.flip);

      assert.instanceOf(error, RemoteCliError);
      assert.equal(error.reason, "ambiguous-dispatch");
      const expectedCommandId = yield* keyedSendCommandId(
        AuthSessionId.make("session-1"),
        "retry-key",
      );
      assert.equal(error.commandId, expectedCommandId);
      assert.equal(error.threadId, threadId);
      assert.lengthOf(sendRequests(requests), 2);
      assert.equal(
        yield* requestText(sendRequests(requests)[0]),
        yield* requestText(sendRequests(requests)[1]),
      );
    }).pipe(
      Effect.provide(
        fetchLayer(
          withThreadSnapshots(requests, () =>
            jsonResponse(
              {
                _tag: "EnvironmentInternalError",
                code: "internal_error",
                reason: "orchestration_send_outcome_unknown",
                traceId: TRACE_ID,
              },
              500,
            ),
          ),
        ),
      ),
    );
  });

  it.effect("retries transport failures once and keeps the final error sanitized", () => {
    const requests: Array<Request> = [];
    const threadId = ThreadId.make("thread-1");
    return Effect.gen(function* () {
      const error = yield* sendThreadMessage(context(), {
        threadId,
        message: "hello",
        idempotencyKey: "transport-key",
      }).pipe(Effect.flip);

      assert.instanceOf(error, RemoteCliError);
      assert.equal(error.reason, "ambiguous-dispatch");
      assert.equal(error.message, RemoteCliError.messageForReason("ambiguous-dispatch"));
      assert.equal(error.message.includes("transport-secret"), false);
      const sent = sendRequests(requests);
      assert.lengthOf(sent, 2);
      assert.equal(yield* requestText(sent[0]), yield* requestText(sent[1]));
    }).pipe(
      Effect.provide(
        fetchLayer(
          withThreadSnapshots(requests, () =>
            Promise.reject(new TypeError("transport-secret diagnostic")),
          ),
        ),
      ),
    );
  });
});
