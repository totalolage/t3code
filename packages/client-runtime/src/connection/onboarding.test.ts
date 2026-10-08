import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthEnvironmentScope,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as RpcHttp from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { fetchRemoteSessionState } from "../authorization/remote.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";
import {
  prepareBearerConnectionUpdate,
  preparePairingRegistration,
  prepareSshRegistration,
} from "./onboarding.ts";

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

function layerPairingHttp(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
    readonly grantScopes?: ReadonlyArray<AuthEnvironmentScope>;
  },
) {
  const grantScopes = options?.grantScopes ?? AuthStandardClientScopes;
  let sessionScopes: ReadonlyArray<string> = [];
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/.well-known/t3/environment") {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
            ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
          },
        }),
      );
    }

    if (requestUrl.pathname === "/oauth/token") {
      const body =
        init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body);
      const requestedScope = new URLSearchParams(body).get("scope");
      sessionScopes = requestedScope === null ? grantScopes : requestedScope.split(" ");
      if (!sessionScopes.every((scope) => grantScopes.some((granted) => granted === scope))) {
        return Promise.resolve(
          Response.json(
            {
              _tag: "EnvironmentRequestInvalidError",
              code: "invalid_request",
              reason: "scope_not_granted",
              traceId: "pairing-scope-test",
            },
            { status: 400 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          access_token: "bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: sessionScopes.join(" "),
        }),
      );
    }

    if (url.endsWith("/api/auth/session")) {
      return Promise.resolve(
        Response.json({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["bearer-access-token"],
            sessionCookieName: "t3_session",
          },
          scopes: sessionScopes,
          sessionMethod: "bearer-access-token",
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return RpcHttp.layerRemoteHttpClient(fetchFn);
}

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired:https://remote.example.test",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => new URL(call.url).pathname === "/oauth/token");
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.has("scope")).toBe(false);
      expect(tokenParams.get("client_label")).toBe("T3 Code Test");
      expect(tokenParams.get("client_device_type")).toBe("desktop");
      expect(tokenParams.get("client_os")).toBe("Test OS");
    }),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );
  it.effect.each([
    { label: "read-only", scopes: ["orchestration:read"] },
    { label: "administrative", scopes: AuthAdministrativeScopes },
  ] as const)("preserves the $label grant when pairing a remote environment", ({ scopes }) =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const httpLayer = layerPairingHttp(calls, { grantScopes: scopes });
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, httpLayer)));

      const session = yield* fetchRemoteSessionState({
        httpBaseUrl: registration.profile.httpBaseUrl,
        bearerToken: registration.credential.token,
      }).pipe(Effect.provide(httpLayer));

      expect(session.authenticated).toBe(true);
      expect(session.scopes).toEqual(scopes);
    }),
  );

  it.effect("refuses to add a route that reaches a different machine, keeping the code", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
      }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "configuration" });
      expect(error.message).toContain("different machine");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("pairs an outdated server so it can be updated from this client", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, {
              protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
              selfUpdate: true,
            }),
          ),
        ),
      );
      expect(registration.target.environmentId).toBe("environment-paired");
      expect(calls.map((call) => call.url)).toContain("https://remote.example.test/oauth/token");
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("preserves ordered pairing query parameters in discovery and token requests", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        pairingUrl: "https://remote.example.test/pair?route=a&route=b&token=pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))));

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment?route=a&route=b",
        "https://remote.example.test/oauth/token?route=a&route=b",
      ]);
      expect(registration.profile).toMatchObject({
        httpBaseUrl: "https://remote.example.test/",
        wsBaseUrl: "wss://remote.example.test/",
        queryParameters: [
          { key: "route", value: "a" },
          { key: "route", value: "b" },
        ],
      });
      expect(calls.every((call) => !new URL(call.url).searchParams.has("token"))).toBe(true);
      const tokenRequest = calls.find((call) => new URL(call.url).pathname === "/oauth/token");
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      expect(new URLSearchParams(tokenBody).get("subject_token")).toBe("pairing-token");
    }),
  );

  it.effect("uses explicit pairing query parameters instead of URL parameters", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        pairingUrl: "https://remote.example.test/pair?route=url-a&route=url-b&token=pairing-token",
        queryParameters: [
          { key: "route", value: "override-a" },
          { key: "route", value: "override-b" },
        ],
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))));

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment?route=override-a&route=override-b",
        "https://remote.example.test/oauth/token?route=override-a&route=override-b",
      ]);
      expect(registration.profile.queryParameters).toEqual([
        { key: "route", value: "override-a" },
        { key: "route", value: "override-b" },
      ]);
    }),
  );

  it.effect("clears pairing URL query parameters with an explicit empty override", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        pairingUrl: "https://remote.example.test/pair?route=url-a&route=url-b&token=pairing-token",
        queryParameters: [],
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))));

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);
      expect(registration.profile.queryParameters).toEqual([]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerClientPresentation,
            layerPairingHttp(calls, { failDescriptor: true }),
          ),
        ),
        Effect.flip,
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("rejects invalid pairing details before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "",
        pairingCode: "",
      }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        message: "Enter a backend URL.",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("does not expose malformed pairing URL details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const pairingUrl = "not a url?route=secret&token=pairing-token";
      const error = yield* preparePairingRegistration({ pairingUrl }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerPairingHttp(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        detail: "Pairing URL is invalid.",
      });
      expect(error.detail).not.toContain(pairingUrl);
      expect(error.detail).not.toContain("route=secret");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const credential = new BearerConnectionCredential({ token: "bearer-token" });
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
              queryParameters: [
                { key: "route", value: "one" },
                { key: "route", value: "two" },
              ],
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(credential),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
          queryParameters: [
            { key: "route", value: "one" },
            { key: "route", value: "two" },
          ],
        },
        credential: { token: "bearer-token" },
      });
      expect(registration.credential).toBe(credential);
      expect(registration.target.environmentId).toBe(environmentId);
      expect(registration.target.connectionId).toBe("bearer:environment-paired");
      expect(registration.profile.environmentId).toBe(environmentId);
      expect(registration.profile.connectionId).toBe("bearer:environment-paired");
    }),
  );

  it.effect("clears saved bearer query parameters when explicitly given an empty list", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const credential = new BearerConnectionCredential({ token: "bearer-token" });
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "https://remote.example.test",
          queryParameters: [],
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "https://old.example.test/",
              wsBaseUrl: "wss://old.example.test/",
              queryParameters: [{ key: "route", value: "saved" }],
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(credential),
      });

      expect(registration.profile.queryParameters).toEqual([]);
      expect(registration.credential).toBe(credential);
      expect(registration.target.environmentId).toBe(environmentId);
      expect(registration.target.connectionId).toBe("bearer:environment-paired");
    }),
  );

  it.effect("normalizes explicit bearer query parameter replacements", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const credential = new BearerConnectionCredential({ token: "bearer-token" });
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "https://remote.example.test",
          queryParameters: [
            { key: "  route  ", value: "first" },
            { key: "route", value: "second" },
            { key: " ", value: "" },
          ],
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "https://old.example.test/",
              wsBaseUrl: "wss://old.example.test/",
              queryParameters: [{ key: "saved", value: "value" }],
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(credential),
      });

      expect(registration.profile.queryParameters).toEqual([
        { key: "route", value: "first" },
        { key: "route", value: "second" },
      ]);
      expect(registration.credential).toBe(credential);
      expect(registration.target.environmentId).toBe(environmentId);
      expect(registration.target.connectionId).toBe("bearer:environment-paired");
    }),
  );

  it.effect("prepares an SSH registration from the provisioned platform environment", () =>
    Effect.gen(function* () {
      const target = {
        alias: "devbox",
        hostname: "devbox.example.test",
        username: "developer",
        port: 22,
      };
      const registration = yield* prepareSshRegistration({
        target,
      }).pipe(
        Effect.provideService(
          ClientCapabilities.SshEnvironmentGateway,
          ClientCapabilities.SshEnvironmentGateway.of({
            provision: () =>
              Effect.succeed({
                environmentId: EnvironmentId.make("environment-ssh"),
                label: "Remote development box",
                bootstrap: {
                  target,
                  httpBaseUrl: "http://127.0.0.1:3201",
                  wsBaseUrl: "ws://127.0.0.1:3201",
                  pairingToken: "pairing-token",
                },
                bearerToken: "bearer-token",
              }),
            prepare: () => Effect.die("unused"),
            disconnect: () => Effect.die("unused"),
          }),
        ),
      );

      expect(registration).toMatchObject({
        _tag: "SshConnectionRegistration",
        target: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
        },
        profile: {
          environmentId: "environment-ssh",
          label: "Remote development box",
          connectionId: 'ssh:environment-ssh:["devbox","devbox.example.test","developer",22]',
          target,
        },
      });
    }),
  );
});
