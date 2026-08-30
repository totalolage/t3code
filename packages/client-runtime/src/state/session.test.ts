import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { fetchEnvironmentSessionState } from "./session.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  queryParameters: [{ key: "proxy", value: "fork route" }],
  target: TARGET,
};

describe("fetchEnvironmentSessionState", () => {
  it.effect("preserves the prepared environment query parameters", () =>
    Effect.gen(function* () {
      const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
      const fetchFn = ((request, init) => {
        calls.push([request, init ?? {}]);
        return Promise.resolve(
          Response.json({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["bearer-access-token"],
              sessionCookieName: "t3_session",
            },
            scopes: ["orchestration:read"],
            sessionMethod: "bearer-access-token",
            expiresAt: "2026-05-01T12:00:00.000Z",
          }),
        );
      }) satisfies typeof fetch;

      const session = yield* fetchEnvironmentSessionState({
        prepared: PREPARED,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));

      expect(session.authenticated).toBe(true);
      expect(calls).toHaveLength(1);
      const [request, init] = calls[0]!;
      expect(String(request)).toBe(
        "https://environment.example.test/api/auth/session?proxy=fork+route",
      );
      expect(init.headers).toEqual(
        expect.objectContaining({ authorization: "Bearer bearer-token" }),
      );
    }),
  );
});
