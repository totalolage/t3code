import { assert, describe, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  CommandId,
  EnvironmentScopeRequiredError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import {
  formatRemoteCliError,
  makeRemoteCliApi,
  normalizeRemoteHttpBaseUrl,
  requestRemoteCli,
  RemoteCliError,
} from "./remoteHttp.ts";

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const fetchLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));

const recordingFetch = (
  requests: Array<Request>,
  response: Response | ((request: Request) => Response | Promise<Response>),
): typeof globalThis.fetch => {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    return typeof response === "function" ? response(request) : response.clone();
  }) as typeof globalThis.fetch;
  return fetch;
};

const descriptor = {
  environmentId: "environment-1",
  label: "Remote environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.40",
  capabilities: { repositoryIdentity: false },
};

describe("remote HTTP CLI seam", () => {
  it.effect("normalizes HTTP hosts to their origin", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* normalizeRemoteHttpBaseUrl(
          "https://remote.example/project?route=blue&route=green#ignored",
        ),
        "https://remote.example",
      );
      assert.equal(
        yield* normalizeRemoteHttpBaseUrl("http://remote.example/project#ignored"),
        new URL("http://remote.example/project").origin,
      );

      const credentialError = yield* normalizeRemoteHttpBaseUrl(
        "https://user:secret@remote.example/project",
      ).pipe(Effect.flip);
      assert.equal(credentialError.reason, "invalid-host");

      const protocolError = yield* normalizeRemoteHttpBaseUrl("ftp://remote.example").pipe(
        Effect.flip,
      );
      assert.equal(protocolError.reason, "invalid-host");
    }),
  );

  it.effect("parses a typed descriptor at the origin with no implicit auth", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const client = yield* makeRemoteCliApi("https://remote.example/ignored?route=blue");
      const result = yield* client.metadata.descriptor();
      const request = requests[0];

      assert.deepEqual(result, descriptor);
      assert.equal(request?.url, "https://remote.example/.well-known/t3/environment");
      assert.isNull(request?.headers.get("authorization"));
    }).pipe(Effect.provide(fetchLayer(recordingFetch(requests, jsonResponse(descriptor)))));
  });

  it.effect("uses native form encoding for token exchange and keeps explicit scopes", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const client = yield* makeRemoteCliApi("https://remote.example?route=blue");
      const result = yield* client.auth.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: "bootstrap-secret",
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: "orchestration:read orchestration:operate",
          client_label: "remote-cli-test",
        },
      });
      const request = requests[0];
      const body = yield* Effect.promise(() => request!.text());
      const form = new URLSearchParams(body);

      assert.equal(result.access_token, "access-secret");
      assert.equal(request?.url, "https://remote.example/oauth/token");
      assert.equal(request?.headers.get("content-type"), "application/x-www-form-urlencoded");
      assert.isNull(request?.headers.get("authorization"));
      assert.equal(form.get("grant_type"), AuthTokenExchangeGrantType);
      assert.equal(form.get("subject_token"), "bootstrap-secret");
      assert.equal(form.get("scope"), "orchestration:read orchestration:operate");
    }).pipe(
      Effect.provide(
        fetchLayer(
          recordingFetch(
            requests,
            jsonResponse({
              access_token: "access-secret",
              issued_token_type: AuthAccessTokenType,
              token_type: "Bearer",
              expires_in: 3_600,
              scope: "orchestration:read orchestration:operate",
            }),
          ),
        ),
      ),
    );
  });

  it.effect("drops host query parameters but keeps endpoint query parameters", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const client = yield* makeRemoteCliApi("https://remote.example?route=blue");
      yield* client.orchestration.threadHistoryPage({
        headers: {
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        },
        params: { threadId: ThreadId.make("thread-1") },
        query: { cursor: "next-page" },
        responseMode: "response-only",
      });
      const requestUrl = new URL(requests[0]!.url);

      assert.equal(requestUrl.pathname, "/api/orchestration/threads/thread-1/history");
      assert.isNull(requestUrl.searchParams.get("route"));
      assert.equal(requestUrl.searchParams.get("cursor"), "next-page");
    }).pipe(
      Effect.provide(fetchLayer(recordingFetch(requests, new Response(null, { status: 200 })))),
    );
  });

  it.effect("preserves typed scope failures and formats only safe native fields", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const client = yield* makeRemoteCliApi("https://remote.example");
      const error = yield* requestRemoteCli(
        client.orchestration.snapshot({
          headers: { authorization: "Bearer access-secret" },
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, EnvironmentScopeRequiredError);
      assert.deepEqual(formatRemoteCliError(error), {
        error: {
          code: "insufficient_scope",
          message: "The remote environment requires a scope that this token does not have.",
          traceId: "0123456789abcdef0123456789abcdef",
          requiredScope: "orchestration:read",
        },
      });
      assert.equal(requests[0]?.headers.get("authorization"), "Bearer access-secret");
    }).pipe(
      Effect.provide(
        fetchLayer(
          recordingFetch(
            requests,
            jsonResponse(
              {
                _tag: "EnvironmentScopeRequiredError",
                code: "insufficient_scope",
                requiredScope: "orchestration:read",
                traceId: "0123456789abcdef0123456789abcdef",
              },
              403,
            ),
          ),
        ),
      ),
    );
  });

  it.effect("sanitizes malformed responses and network failures", () => {
    const malformedRequests: Array<Request> = [];
    const networkRequests: Array<Request> = [];
    const malformedLayer = fetchLayer(
      recordingFetch(
        malformedRequests,
        new Response("not-json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const networkLayer = fetchLayer(
      recordingFetch(networkRequests, () =>
        Promise.reject(
          new Error("secret token in https://user:password@remote.example/private response body"),
        ),
      ),
    );
    return Effect.gen(function* () {
      const malformed = yield* Effect.gen(function* () {
        const client = yield* makeRemoteCliApi("https://remote.example");
        return yield* requestRemoteCli(client.metadata.descriptor()).pipe(Effect.flip);
      }).pipe(Effect.provide(malformedLayer));
      assert.instanceOf(malformed, RemoteCliError);
      assert.equal(malformed.reason, "request-failed");
      assert.lengthOf(malformedRequests, 1);

      const network = yield* Effect.gen(function* () {
        const client = yield* makeRemoteCliApi("https://remote.example");
        return yield* requestRemoteCli(client.metadata.descriptor()).pipe(Effect.flip);
      }).pipe(Effect.provide(networkLayer));
      assert.instanceOf(network, RemoteCliError);
      assert.equal(network.reason, "request-failed");
      assert.lengthOf(networkRequests, 1);

      const formatted = formatRemoteCliError(network);
      assert.deepEqual(formatted, {
        error: {
          code: "request-failed",
          message: "The remote environment request failed.",
        },
      });
      const formattedValues = Object.values(formatted.error);
      assert.isFalse(
        formattedValues.some(
          (value) =>
            typeof value === "string" &&
            (value.includes("user:password") || value.includes("remote.example/private")),
        ),
      );
      assert.isFalse(Object.hasOwn(formatted.error, "cause"));
    });
  });

  it.effect("normalizes timeout and defect failures without leaking causes", () =>
    Effect.gen(function* () {
      const timeoutFiber = yield* Effect.forkChild(requestRemoteCli(Effect.never));
      yield* TestClock.adjust(Duration.seconds(15));
      const timeout = yield* Fiber.join(timeoutFiber).pipe(Effect.flip);
      assert.instanceOf(timeout, RemoteCliError);
      assert.equal(timeout.reason, "request-failed");

      const defect = yield* requestRemoteCli(
        Effect.die("secret network URL and raw response body"),
      ).pipe(Effect.flip);
      assert.instanceOf(defect, RemoteCliError);
      assert.equal(defect.reason, "request-failed");
      assert.deepEqual(formatRemoteCliError(defect), {
        error: {
          code: "request-failed",
          message: "The remote environment request failed.",
        },
      });
    }),
  );

  it("formats custom errors without details or unsafe fields", () => {
    const commandId = `cli-send:${"a".repeat(64)}`;
    const formatted = formatRemoteCliError(
      new RemoteCliError({
        reason: "ambiguous-dispatch",
        commandId: CommandId.make(commandId),
        threadId: ThreadId.make("thread-1"),
      }),
    );
    assert.deepEqual(formatted, {
      error: {
        code: "ambiguous-dispatch",
        message:
          "The remote dispatch outcome is ambiguous; inspect the target thread before retrying.",
        commandId,
        threadId: "thread-1",
      },
    });

    const malicious = formatRemoteCliError({
      _tag: "EnvironmentScopeRequiredError",
      code: "<script>",
      reason: "server-body",
      message: "malicious server message",
      traceId: "not-a-trace",
      requiredScope: "../../secret",
      commandId: "cli-send:bootstrap-secret",
      threadId: "thread/secret",
      body: "bootstrap-secret",
      url: "https://user:password@remote.example/path?token=secret",
      cause: "raw-cause",
    });
    const serialized = JSON.stringify(malicious);

    assert.deepEqual(malicious, {
      error: {
        code: "request-failed",
        message: "The remote environment request failed.",
      },
    });
    assert.isFalse(serialized.includes("malicious server message"));
    assert.isFalse(serialized.includes("bootstrap-secret"));
    assert.isFalse(serialized.includes("remote.example"));
  });
});
