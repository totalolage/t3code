import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import type { RemoteQueryParameter } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "../connection/model.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { resolveDeviceHubAccess, withDeviceHubQuery } from "./deviceHubAccess.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const HUB_PATH = "/api/device-hub";
const CUSTOM_QUERY_PARAMETERS = [
  { key: "tenant", value: "one" },
  { key: "tenant", value: "two" },
] satisfies readonly RemoteQueryParameter[];

type RecordedCall = {
  readonly url: string;
  readonly init: RequestInit;
};

function makeFetchHarness(ticket = "hub-ticket") {
  const calls: Array<RecordedCall> = [];
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return Response.json({ ticket, expiresAt: "2026-09-12T00:00:00.000Z" });
  };
  return { calls, fetchFn, httpLayer: layerRemoteHttpClient(fetchFn) };
}

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Bearer environment",
  connectionId: "bearer-1",
});

const BEARER_PREPARED = {
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: "https://environment.example.test",
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer" as const, token: "bearer-token" },
  queryParameters: CUSTOM_QUERY_PARAMETERS,
  target: BEARER_TARGET,
};

describe("device hub access", () => {
  it.effect("resolves bearer ticket access and preserves custom query pairs on hub URLs", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness();
      const access = yield* resolveDeviceHubAccess({
        prepared: BEARER_PREPARED,
        hubBasePath: HUB_PATH,
      }).pipe(Effect.provide(harness.httpLayer));

      expect(access).toMatchObject({
        httpBase: "https://environment.example.test/api/device-hub",
        wsBase: "wss://environment.example.test/api/device-hub",
        query: { wsTicket: "hub-ticket" },
        queryParameters: CUSTOM_QUERY_PARAMETERS,
        credentials: false,
      });
      expect(access.httpBase).not.toContain("tenant");
      expect(access.wsBase).not.toContain("tenant");

      expect(harness.calls).toHaveLength(1);
      const ticketCall = harness.calls[0]!;
      const ticketUrl = new URL(ticketCall.url);
      expect(ticketUrl.pathname).toBe("/api/auth/websocket-ticket");
      expect(ticketUrl.searchParams.getAll("tenant")).toEqual(["one", "two"]);
      expect(ticketCall.init.method).toBe("POST");
      expect(new Headers(ticketCall.init.headers).get("authorization")).toBe("Bearer bearer-token");

      for (const scheme of ["http", "ws"] as const) {
        const base = scheme === "http" ? access.httpBase : access.wsBase;
        const resolved = withDeviceHubQuery(`${base}/stream?view=live#frame`, access);
        const url = new URL(resolved);
        expect(url.searchParams.get("view")).toBe("live");
        expect(url.searchParams.get("wsTicket")).toBe("hub-ticket");
        expect(url.searchParams.getAll("tenant")).toEqual(["one", "two"]);
        expect(url.hash).toBe("#frame");
      }
    }),
  );

  it("lets service endpoint query keys and wsTicket win over custom parameters", () => {
    const access = {
      httpBase: "https://environment.example.test/api/device-hub",
      wsBase: "wss://environment.example.test/api/device-hub",
      query: { wsTicket: "service-ticket" },
      queryParameters: [
        { key: "route", value: "custom-route" },
        { key: "tenant", value: "one" },
        { key: "tenant", value: "two" },
        { key: "wsTicket", value: "custom-ticket" },
        { key: "token", value: "must-not-leak" },
      ],
      credentials: false,
    };

    const resolved = withDeviceHubQuery(
      "https://environment.example.test/api/device-hub/stream?route=endpoint-route&wsTicket=endpoint-ticket#frame",
      access,
    );
    const url = new URL(resolved);

    expect([...url.searchParams.entries()]).toEqual([
      ["route", "endpoint-route"],
      ["wsTicket", "endpoint-ticket"],
      ["wsTicket", "service-ticket"],
      ["tenant", "one"],
      ["tenant", "two"],
    ]);
    expect(url.hash).toBe("#frame");
  });

  it("returns a no-field access URL unchanged when no service or custom query exists", () => {
    const url = "https://environment.example.test/api/device-hub/stream?view=live#frame";

    expect(
      withDeviceHubQuery(url, {
        httpBase: "https://environment.example.test/api/device-hub",
        wsBase: "wss://environment.example.test/api/device-hub",
        query: {},
        credentials: true,
      }),
    ).toBe(url);
  });

  it.effect("does not fetch or expose stray query parameters for a primary cookie session", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness();
      const target = new PrimaryConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Primary environment",
        httpBaseUrl: "http://127.0.0.1:3777",
        wsBaseUrl: "ws://127.0.0.1:3777",
      });
      const access = yield* resolveDeviceHubAccess({
        prepared: {
          environmentId: ENVIRONMENT_ID,
          label: target.label,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: "ws://127.0.0.1:3777/ws",
          httpAuthorization: null,
          queryParameters: CUSTOM_QUERY_PARAMETERS,
          target,
        },
        hubBasePath: HUB_PATH,
      }).pipe(Effect.provide(harness.httpLayer));

      expect(access).toEqual({
        httpBase: "http://127.0.0.1:3777/api/device-hub",
        wsBase: "ws://127.0.0.1:3777/api/device-hub",
        query: {},
        credentials: true,
      });
      expect(access).not.toHaveProperty("queryParameters");
      expect(harness.calls).toHaveLength(0);
    }),
  );

  it.effect("keeps relay DPoP ticket authentication while ignoring stray hub parameters", () =>
    Effect.gen(function* () {
      const harness = makeFetchHarness("relay-ticket");
      const target = new RelayConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Relay environment",
      });
      const prepared = {
        environmentId: ENVIRONMENT_ID,
        label: target.label,
        httpBaseUrl: "https://relay.example.test",
        socketUrl: "wss://relay.example.test/ws",
        httpAuthorization: {
          _tag: "Dpop" as const,
          accessToken: "stale-token",
          expiresAtEpochMs: 0,
        },
        queryParameters: CUSTOM_QUERY_PARAMETERS,
        target,
      };
      const proofs: Array<ManagedRelayDpopProofInput> = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "relay-proof";
          }),
      });
      const remoteAuthorization = RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("Unexpected bearer authorization."),
        authorizeDpop: () => Effect.die("Unexpected socket authorization."),
        authorizeDpopHttp: (input) =>
          Effect.succeed({
            environmentId: input.expectedEnvironmentId,
            label: target.label,
            httpBaseUrl: "https://relay.example.test",
            httpAuthorization: {
              _tag: "Dpop" as const,
              accessToken: "current-token",
              expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
            },
          }),
      });
      const dependencies = Layer.mergeAll(
        harness.httpLayer,
        Layer.succeed(ManagedRelayDpopSigner, signer),
        Layer.succeed(RemoteEnvironmentAuthorization, remoteAuthorization),
      );

      const access = yield* resolveDeviceHubAccess({
        prepared,
        hubBasePath: HUB_PATH,
      }).pipe(Effect.provide(dependencies));

      expect(access).toMatchObject({
        httpBase: "https://relay.example.test/api/device-hub",
        wsBase: "wss://relay.example.test/api/device-hub",
        query: { wsTicket: "relay-ticket" },
        credentials: false,
      });
      expect(access).not.toHaveProperty("queryParameters");
      expect(
        new URL(withDeviceHubQuery(`${access.wsBase}/stream`, access)).searchParams.getAll(
          "tenant",
        ),
      ).toEqual([]);
      expect(harness.calls).toHaveLength(1);
      const ticketUrl = new URL(harness.calls[0]!.url);
      expect(ticketUrl.pathname).toBe("/api/auth/websocket-ticket");
      expect(ticketUrl.searchParams.getAll("tenant")).toEqual([]);
      expect(new Headers(harness.calls[0]!.init.headers).get("authorization")).toBe(
        "DPoP current-token",
      );
      expect(new Headers(harness.calls[0]!.init.headers).get("dpop")).toBe("relay-proof");
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://relay.example.test/api/auth/websocket-ticket",
          accessToken: "current-token",
        },
      ]);
    }),
  );
});
