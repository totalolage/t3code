import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Inspectable from "effect/Inspectable";
import * as TestClock from "effect/testing/TestClock";

import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  makeEnvironmentHttpApiGroupClient,
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
  layerRemoteHttpClient,
  type RemoteEnvironmentRequestError,
} from "./http.ts";

const HTTP_BASE_URL = "https://remote.example.test";
const SENTINEL = "query-sentinel-7fca";
const CUSTOM_VALUE = "custom-query-value-4d2e";
const UNSAFE_REQUEST_URL = `https://user:password@remote.example.test/api/auth/session?tenant=${SENTINEL}&secret=${CUSTOM_VALUE}#fragment`;
const SAFE_REQUEST_URL = "https://remote.example.test/api/auth/session";

type FetchCall = {
  readonly url: string;
  readonly init: RequestInit;
};

const captureFetch = (response: () => Response) => {
  const calls: Array<FetchCall> = [];
  const fetchFn = ((input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response());
  }) satisfies typeof fetch;
  return { calls, fetchFn };
};

const captureHangingFetch = () => {
  const calls: Array<FetchCall> = [];
  const fetchFn = ((input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Promise<Response>(() => undefined);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
};

const responseOnly = { responseMode: "response-only" as const };

const inspectError = (error: unknown): string =>
  `${JSON.stringify(error)}\n${Inspectable.toStringUnknown(error)}`;

const expectSafeError = (error: RemoteEnvironmentRequestError, tag: string): void => {
  expect(error._tag).toBe(tag);
  if ("requestUrl" in error && error.requestUrl !== undefined) {
    expect(error.requestUrl).toBe(SAFE_REQUEST_URL);
  }
  expect(error.message).toContain(SAFE_REQUEST_URL);

  const inspected = inspectError(error);
  expect(inspected).not.toContain(SENTINEL);
  expect(inspected).not.toContain(CUSTOM_VALUE);
  expect(inspected).not.toContain("user:password");
  expect(inspected).not.toContain("HttpClientRequest");
  expect(inspected).not.toContain("HttpClientError");
  expect(inspected).not.toContain("TransportError");
  expect(inspected).not.toContain("DecodeError");
};

describe("remote environment HTTP clients", () => {
  it.effect("routes auth session through the full and group factories", () =>
    Effect.gen(function* () {
      const fullFetch = captureFetch(() => new Response(null, { status: 204 }));
      const fullClient = yield* makeEnvironmentHttpApiClient(HTTP_BASE_URL).pipe(
        Effect.provide(layerRemoteHttpClient(fullFetch.fetchFn)),
      );
      yield* fullClient.auth.session({ headers: {}, ...responseOnly });

      const groupFetch = captureFetch(() => new Response(null, { status: 204 }));
      const groupClient = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "auth").pipe(
        Effect.provide(layerRemoteHttpClient(groupFetch.fetchFn)),
      );
      yield* groupClient.session({ headers: {}, ...responseOnly });

      expect(fullFetch.calls.map((call) => call.url)).toEqual([
        `${HTTP_BASE_URL}/api/auth/session`,
      ]);
      expect(groupFetch.calls.map((call) => call.url)).toEqual([
        `${HTTP_BASE_URL}/api/auth/session`,
      ]);
    }),
  );

  it.effect("merges custom parameters after typed thread history query parameters", () =>
    Effect.gen(function* () {
      const fetch = captureFetch(() => new Response(null, { status: 204 }));
      const client = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "orchestration", [
        { key: "cursor", value: "custom-cursor" },
        { key: "tenant", value: "first-tenant" },
        { key: "tenant", value: "second-tenant" },
      ]).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)));

      yield* client.threadHistoryPage({
        params: { threadId: ThreadId.make("thread-1") },
        query: { cursor: "typed-cursor" },
        headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
        ...responseOnly,
      });

      const requestUrl = new URL(fetch.calls[0]?.url ?? "");
      expect(requestUrl.pathname).toBe("/api/orchestration/threads/thread-1/history");
      expect([...requestUrl.searchParams.entries()]).toEqual([
        ["cursor", "typed-cursor"],
        ["tenant", "first-tenant"],
        ["tenant", "second-tenant"],
      ]);
    }),
  );

  it.effect("keeps auth token payload scope and route while excluding token query parameters", () =>
    Effect.gen(function* () {
      const fetch = captureFetch(() => new Response(null, { status: 204 }));
      const client = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "auth", [
        { key: "scope", value: CUSTOM_VALUE },
        { key: "route", value: "/not-the-token-route" },
        { key: " token ", value: SENTINEL },
      ]).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)));

      yield* client.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: "pairing-token",
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: "orchestration:read",
        },
        ...responseOnly,
      });

      const call = fetch.calls[0];
      expect(call).toBeDefined();
      if (!call) return;

      const requestUrl = new URL(call.url);
      expect(requestUrl.pathname).toBe("/oauth/token");
      expect(requestUrl.searchParams.get("scope")).toBe(CUSTOM_VALUE);
      expect(requestUrl.searchParams.get("route")).toBe("/not-the-token-route");
      expect(requestUrl.searchParams.has(" token ")).toBe(false);
      expect(requestUrl.searchParams.has("token")).toBe(false);

      const body = new TextDecoder().decode(call.init.body as Uint8Array);
      expect(body).toBe(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=pairing-token&subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token&scope=orchestration%3Aread",
      );
      expect(new URLSearchParams(body).get("scope")).toBe("orchestration:read");
    }),
  );

  it.effect("does not change generated pull-request diff POST payloads", () =>
    Effect.gen(function* () {
      const payload = {
        projectId: ProjectId.make("project-1"),
        repository: "owner/repository",
        number: 42,
      };

      const unchangedFetch = captureFetch(() => new Response(null, { status: 204 }));
      const unchangedClient = yield* makeEnvironmentHttpApiGroupClient(
        HTTP_BASE_URL,
        "pullRequests",
      ).pipe(Effect.provide(layerRemoteHttpClient(unchangedFetch.fetchFn)));
      yield* unchangedClient.diff({ headers: {}, payload, ...responseOnly });

      const parameterizedFetch = captureFetch(() => new Response(null, { status: 204 }));
      const parameterizedClient = yield* makeEnvironmentHttpApiGroupClient(
        HTTP_BASE_URL,
        "pullRequests",
        [{ key: "tenant", value: CUSTOM_VALUE }],
      ).pipe(Effect.provide(layerRemoteHttpClient(parameterizedFetch.fetchFn)));
      yield* parameterizedClient.diff({ headers: {}, payload, ...responseOnly });

      const unchangedBody = new TextDecoder().decode(
        unchangedFetch.calls[0]?.init.body as Uint8Array,
      );
      const parameterizedBody = new TextDecoder().decode(
        parameterizedFetch.calls[0]?.init.body as Uint8Array,
      );
      expect(unchangedBody).toBe(parameterizedBody);
      expect(parameterizedBody).toBe(
        '{"projectId":"project-1","repository":"owner/repository","number":42}',
      );
    }),
  );

  it.effect("does not retain transport causes or query values", () =>
    Effect.gen(function* () {
      const fetch = ((input, init) => {
        void input;
        void init;
        return Promise.reject(new Error(`transport failure ${SENTINEL}`));
      }) satisfies typeof globalThis.fetch;
      const client = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "auth", [
        { key: "tenant", value: CUSTOM_VALUE },
      ]).pipe(Effect.provide(layerRemoteHttpClient(fetch)));

      const error = yield* executeEnvironmentHttpRequest(
        UNSAFE_REQUEST_URL,
        1_000,
        client.session({ headers: {} }),
      ).pipe(Effect.flip);

      expectSafeError(error, "RemoteEnvironmentAuthFetchError");
      if (error._tag === "RemoteEnvironmentAuthFetchError") {
        expect(error.cause).toBe("fetch");
      }
    }),
  );

  it.effect("does not retain invalid JSON HTTP causes or query values", () =>
    Effect.gen(function* () {
      const fetch = captureFetch(() => new Response("{", { status: 200 }));
      const client = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "auth", [
        { key: "tenant", value: CUSTOM_VALUE },
      ]).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)));

      const error = yield* executeEnvironmentHttpRequest(
        UNSAFE_REQUEST_URL,
        1_000,
        client.session({ headers: {} }),
      ).pipe(Effect.flip);

      expectSafeError(error, "RemoteEnvironmentAuthInvalidJsonError");
      if (error._tag === "RemoteEnvironmentAuthInvalidJsonError") {
        expect(error.cause).toBe("invalid-json");
      }
    }),
  );

  it.effect("does not retain schema decode causes or query values", () =>
    Effect.gen(function* () {
      const fetch = captureFetch(() => Response.json({}));
      const client = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "auth", [
        { key: "tenant", value: CUSTOM_VALUE },
      ]).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)));

      const error = yield* executeEnvironmentHttpRequest(
        UNSAFE_REQUEST_URL,
        1_000,
        client.session({ headers: {} }),
      ).pipe(Effect.flip);

      expectSafeError(error, "RemoteEnvironmentAuthInvalidJsonError");
      if (error._tag === "RemoteEnvironmentAuthInvalidJsonError") {
        expect(error.cause).toBe("invalid-json");
      }
    }),
  );

  it.effect("categorizes undeclared statuses without retaining HTTP requests", () =>
    Effect.gen(function* () {
      const fetch = captureFetch(() => new Response("gateway failure", { status: 530 }));
      const client = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "auth", [
        { key: "tenant", value: CUSTOM_VALUE },
      ]).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)));

      const error = yield* executeEnvironmentHttpRequest(
        UNSAFE_REQUEST_URL,
        1_000,
        client.session({ headers: {} }),
      ).pipe(Effect.flip);

      expectSafeError(error, "RemoteEnvironmentAuthUndeclaredStatusError");
      if (error._tag === "RemoteEnvironmentAuthUndeclaredStatusError") {
        expect(error.status).toBe(530);
      }
    }),
  );

  it.effect("uses TestClock for sanitized request timeouts", () =>
    Effect.gen(function* () {
      const fetch = captureHangingFetch();
      const client = yield* makeEnvironmentHttpApiGroupClient(HTTP_BASE_URL, "auth", [
        { key: "tenant", value: CUSTOM_VALUE },
      ]).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)));
      const pending = yield* executeEnvironmentHttpRequest(
        UNSAFE_REQUEST_URL,
        25,
        client.session({ headers: {}, ...responseOnly }),
      ).pipe(Effect.flip, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(25));

      const error = yield* Fiber.join(pending);
      expectSafeError(error, "RemoteEnvironmentAuthTimeoutError");
      if (error._tag === "RemoteEnvironmentAuthTimeoutError") {
        expect(error.timeoutMs).toBe(25);
      }
      expect(fetch.calls).toHaveLength(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("sanitizes direct structured request URL constructors", () => {
    const statusError = new RemoteEnvironmentAuthUndeclaredStatusError(UNSAFE_REQUEST_URL, 530);
    const timeoutError = new RemoteEnvironmentAuthTimeoutError(UNSAFE_REQUEST_URL, 25);

    expect(statusError.requestUrl).toBe(SAFE_REQUEST_URL);
    expect(timeoutError.requestUrl).toBe(SAFE_REQUEST_URL);
    expect(statusError.message).toContain(SAFE_REQUEST_URL);
    expect(timeoutError.message).toContain(SAFE_REQUEST_URL);
    expect(inspectError(statusError)).not.toContain(SENTINEL);
    expect(inspectError(timeoutError)).not.toContain(CUSTOM_VALUE);
  });

  it("normalizes direct auth error causes before serialization", () => {
    const opaqueCause = {
      _id: "HttpClientError",
      request: {
        _id: "HttpClientRequest",
        url: UNSAFE_REQUEST_URL,
        urlParams: { tenant: CUSTOM_VALUE },
      },
      cause: `transport failure ${SENTINEL}`,
    };
    const errors = [
      new RemoteEnvironmentAuthFetchError({
        message: "Could not fetch the remote environment.",
        cause: opaqueCause,
      }),
      new RemoteEnvironmentAuthInvalidJsonError({
        message: "The remote environment returned invalid JSON.",
        cause: opaqueCause,
      }),
    ];

    expect(errors[0]?.cause).toBe("fetch");
    expect(errors[1]?.cause).toBe("invalid-json");
    for (const error of errors) {
      const serialized = [
        JSON.stringify(error),
        Inspectable.toStringUnknown(error),
        String(error),
      ].join("\n");
      expect(serialized).not.toContain(SENTINEL);
      expect(serialized).not.toContain(CUSTOM_VALUE);
      expect(serialized).not.toContain("user:password");
      expect(serialized).not.toContain("HttpClientRequest");
      expect(serialized).not.toContain("HttpClientError");
    }
  });
});
