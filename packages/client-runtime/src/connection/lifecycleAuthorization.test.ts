import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { BearerConnectionTarget, PrimaryConnectionTarget } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import * as ConnectionResolver from "./resolver.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const BEARER_TOKEN = "bearer-secret";
const QUERY_PARAMETERS = [
  { key: "route", value: "a" },
  { key: "route", value: "" },
  { key: "route", value: "b" },
] as const;
const CLIENT_METADATA = {
  label: "T3 Code Test",
  deviceType: "desktop" as const,
  os: "linux",
  surface: "web" as const,
  appVersion: "1.2.3",
  webDeployment: "server" as const,
  browser: "test-browser",
};

const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: {
    os: "linux",
    arch: "x64",
  },
  serverVersion: "0.0.0-test",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: {
    repositoryIdentity: true,
  },
};

const BEARER_TARGET = new BearerConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  connectionId: "bearer-1",
});

const BEARER_PROFILE = new BearerConnectionProfile({
  connectionId: BEARER_TARGET.connectionId,
  environmentId: ENVIRONMENT_ID,
  label: BEARER_TARGET.label,
  httpBaseUrl: ENDPOINT.httpBaseUrl,
  wsBaseUrl: ENDPOINT.wsBaseUrl,
  queryParameters: QUERY_PARAMETERS,
});

const PRIMARY_TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Primary",
  httpBaseUrl: "http://127.0.0.1:3777",
  wsBaseUrl: "ws://127.0.0.1:3777",
});

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

function recordedFetch(responses: ReadonlyArray<Response>) {
  const calls: Array<FetchCall> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const unused = () => Effect.die("Unexpected test dependency call");

function searchEntries(input: RequestInfo | URL): ReadonlyArray<readonly [string, string]> {
  return [...new URL(String(input)).searchParams.entries()];
}

function makeHarness() {
  const fetch = recordedFetch([
    Response.json(DESCRIPTOR),
    Response.json({
      ticket: "ticket-1",
      expiresAt: "2026-06-06T01:00:00.000Z",
    }),
    Response.json(DESCRIPTOR),
    Response.json(DESCRIPTOR),
  ]);
  const credentials = new Map([
    [BEARER_TARGET.connectionId, new BearerConnectionCredential({ token: BEARER_TOKEN })],
  ]);
  const profileStore = ConnectionProfileStore.ConnectionProfileStore.of({
    get: unused,
    put: unused,
    remove: unused,
  });
  const credentialStore = ConnectionCredentialStore.ConnectionCredentialStore.of({
    get: (connectionId) => Effect.succeed(Option.fromNullishOr(credentials.get(connectionId))),
    put: unused,
    remove: unused,
  });
  const presentation = ClientCapabilities.ClientPresentation.of({
    metadata: CLIENT_METADATA,
  });
  const authorizationLayer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerRemoteHttpClient(fetch.fetchFn),
        Layer.succeed(
          ManagedRelay.ManagedRelayDpopSigner,
          ManagedRelay.ManagedRelayDpopSigner.of({
            thumbprint: unused(),
            createProof: unused,
          }),
        ),
        Layer.succeed(
          ManagedRelay.ManagedRelayClient,
          ManagedRelay.ManagedRelayClient.of({
            relayUrl: "https://relay.example.test",
            listEnvironments: unused,
            listDevices: unused,
            createEnvironmentLinkChallenge: unused,
            linkEnvironment: unused,
            unlinkEnvironment: unused,
            getEnvironmentStatus: unused,
            connectEnvironment: unused,
            registerDevice: unused,
            unregisterDevice: unused,
            registerLiveActivity: unused,
            getAgentActivitySnapshot: unused,
            resetTokenCache: unused(),
          }),
        ),
        Layer.succeed(ClientCapabilities.CloudSession, {
          identity: Effect.succeed(Option.some({ accountId: "account-1" })),
          clerkToken: unused(),
        }),
        Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
          deviceId: unused(),
        }),
        Layer.succeed(TokenStore.RemoteDpopAccessTokenStore, {
          get: unused,
          put: unused,
          remove: unused,
        }),
        Layer.succeed(ClientCapabilities.ClientPresentation, presentation),
      ),
    ),
  );
  const layer = ConnectionResolver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ConnectionProfileStore.ConnectionProfileStore, profileStore),
        Layer.succeed(ConnectionCredentialStore.ConnectionCredentialStore, credentialStore),
        Layer.succeed(
          ClientCapabilities.PrimaryEnvironmentAuth,
          ClientCapabilities.PrimaryEnvironmentAuth.of({
            bearerToken: Effect.succeed(Option.none()),
          }),
        ),
        Layer.succeed(ClientCapabilities.ClientPresentation, presentation),
        Layer.succeed(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: unused,
            prepare: unused,
            disconnect: unused,
          }),
        ),
        authorizationLayer,
      ),
    ),
  );

  return { calls: fetch.calls, layer };
}

describe("connection authorization lifecycle", () => {
  it.effect("preserves remote routing parameters across authorization and primary cookies", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const resolver = yield* ConnectionResolver.ConnectionResolver.pipe(
        Effect.provide(harness.layer),
      );
      const bearerEntry: ConnectionCatalogEntry = {
        target: BEARER_TARGET,
        profile: Option.some(BEARER_PROFILE),
        enabled: true,
      };

      const prepared = yield* resolver.prepare(bearerEntry);
      expect(prepared).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: DESCRIPTOR.label,
        httpBaseUrl: ENDPOINT.httpBaseUrl,
        socketUrl: `wss://environment.example.test/ws?wsTicket=ticket-1&clientSurface=web&clientAppVersion=1.2.3&clientDeviceType=desktop&clientOs=linux&clientWebDeployment=server&clientBrowser=test-browser&connectionMethod=direct&route=a&route=&route=b&orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
        httpAuthorization: {
          _tag: "Bearer",
          token: BEARER_TOKEN,
        },
        queryParameters: QUERY_PARAMETERS,
        target: BEARER_TARGET,
      });
      expect(prepared.environmentId).toBe(ENVIRONMENT_ID);
      expect(prepared.httpBaseUrl).toBe(ENDPOINT.httpBaseUrl);
      expect(prepared.httpAuthorization).toEqual({
        _tag: "Bearer",
        token: BEARER_TOKEN,
      });

      expect(harness.calls).toHaveLength(3);
      const descriptorCall = harness.calls[0];
      const ticketCall = harness.calls[1];
      const compatibilityDescriptorCall = harness.calls[2];
      expect(descriptorCall).toBeDefined();
      expect(ticketCall).toBeDefined();
      expect(compatibilityDescriptorCall).toBeDefined();
      if (
        descriptorCall === undefined ||
        ticketCall === undefined ||
        compatibilityDescriptorCall === undefined
      ) {
        return;
      }
      expect(new URL(String(descriptorCall[0])).pathname).toBe("/.well-known/t3/environment");
      expect(searchEntries(descriptorCall[0])).toEqual([
        ["route", "a"],
        ["route", ""],
        ["route", "b"],
      ]);
      expect(new URL(String(ticketCall[0])).pathname).toBe("/api/auth/websocket-ticket");
      expect(searchEntries(ticketCall[0])).toEqual([
        ["route", "a"],
        ["route", ""],
        ["route", "b"],
      ]);
      expect(new URL(String(compatibilityDescriptorCall[0])).pathname).toBe(
        "/.well-known/t3/environment",
      );
      expect(searchEntries(compatibilityDescriptorCall[0])).toEqual([
        ["route", "a"],
        ["route", ""],
        ["route", "b"],
      ]);
      expect(new Headers(ticketCall[1].headers).get("authorization")).toBe(
        `Bearer ${BEARER_TOKEN}`,
      );

      expect([...new URL(prepared.socketUrl).searchParams.entries()]).toEqual([
        ["wsTicket", "ticket-1"],
        ["clientSurface", "web"],
        ["clientAppVersion", "1.2.3"],
        ["clientDeviceType", "desktop"],
        ["clientOs", "linux"],
        ["clientWebDeployment", "server"],
        ["clientBrowser", "test-browser"],
        ["connectionMethod", "direct"],
        ["route", "a"],
        ["route", ""],
        ["route", "b"],
        ["orchestrationProtocol", String(ORCHESTRATION_PROTOCOL_VERSION)],
      ]);
      expect(new URL(prepared.socketUrl).pathname).toBe("/ws");

      expect(BEARER_PROFILE).not.toHaveProperty("token");
      for (const input of [
        descriptorCall[0],
        ticketCall[0],
        compatibilityDescriptorCall[0],
        prepared.socketUrl,
      ]) {
        const url = new URL(String(input));
        expect(url.searchParams.has("token")).toBe(false);
        expect([...url.searchParams.values()]).not.toContain(BEARER_TOKEN);
        expect(url.toString()).not.toContain(BEARER_TOKEN);
      }

      const primary = yield* resolver.prepare({
        target: PRIMARY_TARGET,
        profile: Option.none(),
        enabled: true,
      });
      expect(harness.calls).toHaveLength(4);
      expect(primary).toEqual({
        environmentId: ENVIRONMENT_ID,
        label: PRIMARY_TARGET.label,
        httpBaseUrl: PRIMARY_TARGET.httpBaseUrl,
        socketUrl: `ws://127.0.0.1:3777/ws?clientSurface=web&clientAppVersion=1.2.3&clientDeviceType=desktop&clientOs=linux&clientWebDeployment=server&clientBrowser=test-browser&connectionMethod=direct&orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`,
        httpAuthorization: null,
        target: PRIMARY_TARGET,
      });
      const primaryDescriptorCall = harness.calls[3];
      expect(primaryDescriptorCall).toBeDefined();
      if (primaryDescriptorCall !== undefined) {
        expect(searchEntries(primaryDescriptorCall[0])).toEqual([]);
      }
      expect(primary).not.toHaveProperty("queryParameters");
    }),
  );
});
