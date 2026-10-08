import { describe, expect, it } from "@effect/vitest";
import { EnvironmentConflictError, EnvironmentScopeRequiredError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { layerRemoteHttpClient } from "../rpc/http.ts";
import { createRemoteOrchestrationThread } from "./remoteOrchestration.ts";

const isEnvironmentConflictError = Schema.is(EnvironmentConflictError);
const isEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: Array<FetchCall> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error("Unexpected fetch call"))
      : Promise.resolve(response);
  }) satisfies typeof fetch;

  return { fetchFn, calls };
};

const requestBody = (init: RequestInit): unknown => {
  const body = init.body;
  const text =
    typeof body === "string"
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : "";
  return JSON.parse(text);
};

describe("remote orchestration HTTP operations", () => {
  it.effect("uses bearer authorization without explicit cookie headers", () =>
    Effect.gen(function* () {
      const payload = {
        project: "project-create",
        message: "create this thread",
        idempotencyKey: "create-1",
      };
      const fetch = recordedFetch(
        Response.json({
          threadId: "thread-created",
          commandId: "command-created",
          turnId: "turn-created",
          sequence: 1,
          replayed: false,
        }),
      );

      const result = yield* createRemoteOrchestrationThread({
        httpBaseUrl: "https://remote.example.com/",
        bearerToken: "secret-token",
        payload,
      }).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)));

      expect(result).toEqual({
        threadId: "thread-created",
        commandId: "command-created",
        turnId: "turn-created",
        sequence: 1,
        replayed: false,
      });
      expect(fetch.calls).toHaveLength(1);
      const call = fetch.calls[0];
      expect(call).toBeDefined();
      if (!call) return;

      const [url, init] = call;
      expect(String(url)).toBe("https://remote.example.com/api/orchestration/create");
      expect(init.method).toBe("POST");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
      expect(new Headers(init.headers).get("cookie")).toBeNull();
      expect(init.credentials).toBeUndefined();
      expect(requestBody(init)).toEqual(payload);
    }),
  );

  it.effect.each([
    {
      name: "worktree conflicts",
      response: Response.json(
        {
          _tag: "EnvironmentConflictError",
          code: "conflict",
          reason: "worktree_branch_exists",
          message:
            "The requested branch already exists locally. Choose a different branch or remove the existing branch and its worktree.",
          traceId: "trace-conflict",
        },
        { status: 409 },
      ),
      isExpectedError: isEnvironmentConflictError,
      expectedError: {
        _tag: "EnvironmentConflictError",
        code: "conflict",
        reason: "worktree_branch_exists",
        traceId: "trace-conflict",
      },
    },
    {
      name: "insufficient scope",
      response: Response.json(
        {
          _tag: "EnvironmentScopeRequiredError",
          code: "insufficient_scope",
          requiredScope: "orchestration:operate",
          traceId: "trace-scope",
        },
        { status: 403 },
      ),
      isExpectedError: isEnvironmentScopeRequiredError,
      expectedError: {
        _tag: "EnvironmentScopeRequiredError",
        code: "insufficient_scope",
        requiredScope: "orchestration:operate",
        traceId: "trace-scope",
      },
    },
    {
      name: "idempotency payload mismatch",
      response: Response.json(
        {
          _tag: "EnvironmentConflictError",
          code: "conflict",
          reason: "idempotency_payload_mismatch",
          message: "The idempotency key was already used with a different payload.",
          traceId: "trace-idempotency",
        },
        { status: 409 },
      ),
      isExpectedError: isEnvironmentConflictError,
      expectedError: {
        _tag: "EnvironmentConflictError",
        code: "conflict",
        reason: "idempotency_payload_mismatch",
        traceId: "trace-idempotency",
      },
    },
  ])("forwards typed $name failures", ({ response, isExpectedError, expectedError }) =>
    Effect.gen(function* () {
      const fetch = recordedFetch(response);
      const error = yield* createRemoteOrchestrationThread({
        httpBaseUrl: "https://remote.example.com",
        bearerToken: "secret-token",
        payload: {
          project: "project-create",
          message: "create this thread",
          idempotencyKey: "create-error",
        },
      }).pipe(Effect.provide(layerRemoteHttpClient(fetch.fetchFn)), Effect.flip);

      expect(isExpectedError(error)).toBe(true);
      expect(error).toMatchObject(expectedError);
    }),
  );
});
