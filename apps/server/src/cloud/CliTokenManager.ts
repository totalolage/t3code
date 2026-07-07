// @effect-diagnostics nodeBuiltinImport:off - The CLI loopback OAuth callback is a Node HTTP boundary.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  RelayDeviceAuthorizationGrantType,
  RelayDeviceAuthorizationResponse,
  RelayDeviceTokenPollCode,
  RelayDeviceTokenResponse,
} from "@t3tools/contracts/relay";
import {
  HostProcessArchitecture,
  HostProcessHostname,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cloudCliOAuthConfig, relayUrlConfig, type CloudCliOAuthConfig } from "./publicConfig.ts";

const CLOUD_CLI_OAUTH_TOKEN_SECRET = "cloud-cli-oauth-token";
const CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT = Duration.minutes(10);
const CLOUD_CLI_OAUTH_REFRESH_EARLY_MS = Duration.toMillis(Duration.minutes(5));
const CLOUD_CLI_DEVICE_POLL_MAX_TRANSPORT_FAILURES = 5;

const PersistedToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
});
type PersistedToken = typeof PersistedToken.Type;

const PersistedTokenJson = Schema.fromJsonString(PersistedToken);
const decodePersistedToken = Schema.decodeUnknownEffect(PersistedTokenJson);
const encodePersistedToken = Schema.encodeEffect(PersistedTokenJson);

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  token_type: Schema.String,
});

const DeviceTokenPollErrorBody = Schema.Struct({
  code: RelayDeviceTokenPollCode,
});

export class CloudCliCredentialRemovalError extends Schema.TaggedErrorClass<CloudCliCredentialRemovalError>()(
  "CloudCliCredentialRemovalError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not remove the stored T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialRefreshError extends Schema.TaggedErrorClass<CloudCliCredentialRefreshError>()(
  "CloudCliCredentialRefreshError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not refresh the T3 Connect CLI credential.";
  }
}

export class CloudCliCredentialReadError extends Schema.TaggedErrorClass<CloudCliCredentialReadError>()(
  "CloudCliCredentialReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the stored T3 Connect CLI credential.";
  }
}

export class CloudCliAuthorizationError extends Schema.TaggedErrorClass<CloudCliAuthorizationError>()(
  "CloudCliAuthorizationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not authorize the T3 Connect CLI.";
  }
}

export class CloudCliAuthorizationTimeoutError extends Schema.TaggedErrorClass<CloudCliAuthorizationTimeoutError>()(
  "CloudCliAuthorizationTimeoutError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Timed out waiting for T3 Connect authorization.";
  }
}

export const CloudCliTokenManagerError = Schema.Union([
  CloudCliCredentialRemovalError,
  CloudCliCredentialRefreshError,
  CloudCliCredentialReadError,
  CloudCliAuthorizationError,
  CloudCliAuthorizationTimeoutError,
]);
export type CloudCliTokenManagerError = typeof CloudCliTokenManagerError.Type;

export class CloudCliTokenManager extends Context.Service<
  CloudCliTokenManager,
  {
    readonly get: Effect.Effect<PersistedToken, CloudCliTokenManagerError>;
    readonly getWithDeviceLogin: Effect.Effect<PersistedToken, CloudCliTokenManagerError>;
    readonly getExisting: Effect.Effect<Option.Option<PersistedToken>, CloudCliTokenManagerError>;
    readonly hasCredential: Effect.Effect<boolean, CloudCliTokenManagerError>;
    readonly clear: Effect.Effect<void, CloudCliTokenManagerError>;
  }
>()("t3/cloud/CliTokenManager/CloudCliTokenManager") {}

const wrapError =
  <WrappedError extends CloudCliTokenManagerError>(makeError: (cause: unknown) => WrappedError) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, WrappedError, R> =>
    effect.pipe(Effect.mapError(makeError));

const isCloudCliTokenManagerError = Schema.is(CloudCliTokenManagerError);

// Keeps already-typed manager errors (e.g. the authorization timeout) intact
// instead of collapsing them into a generic authorization failure.
const wrapUnknownError =
  <WrappedError extends CloudCliTokenManagerError>(makeError: (cause: unknown) => WrappedError) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, WrappedError | CloudCliTokenManagerError, R> =>
    effect.pipe(
      Effect.mapError((cause) => (isCloudCliTokenManagerError(cause) ? cause : makeError(cause))),
    );

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  // Device-token polling reads structured 400 bodies, so it needs the unfiltered client.
  const rawHttpClient = yield* HttpClient.HttpClient;
  const httpClient = rawHttpClient.pipe(HttpClient.filterStatusOk);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const semaphore = yield* Semaphore.make(1);
  const persist = Effect.fn("cloud.cli_token.persist")(function* (token: PersistedToken) {
    const encoded = yield* encodePersistedToken(token);
    yield* secrets.set(CLOUD_CLI_OAUTH_TOKEN_SECRET, stringToBytes(encoded));
    return token;
  });

  const clear = secrets
    .remove(CLOUD_CLI_OAUTH_TOKEN_SECRET)
    .pipe(wrapError((cause) => new CloudCliCredentialRemovalError({ cause })));

  const read = Effect.fn("cloud.cli_token.read")(function* () {
    const encoded = yield* secrets.get(CLOUD_CLI_OAUTH_TOKEN_SECRET);
    if (Option.isNone(encoded)) return Option.none<PersistedToken>();
    return Option.some(yield* decodePersistedToken(bytesToString(encoded.value)));
  });

  const exchangeToken = Effect.fn("cloud.cli_token.exchange")(function* (
    metadata: CloudCliOAuthConfig,
    params: Record<string, string>,
  ) {
    const response = yield* HttpClientRequest.post(metadata.tokenEndpoint).pipe(
      HttpClientRequest.bodyUrlParams(params),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OAuthTokenResponse)),
    );
    const now = yield* Clock.currentTimeMillis;
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? params.refresh_token ?? "",
      expiresAtEpochMs: now + response.expires_in * 1_000,
    } satisfies PersistedToken;
  });

  const refresh = Effect.fn("cloud.cli_token.refresh")(function* (token: PersistedToken) {
    const metadata = yield* cloudCliOAuthConfig;
    return yield* exchangeToken(metadata, {
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      client_id: metadata.clientId,
    });
  });

  const login = Effect.fn("cloud.cli_token.login")(function* () {
    const metadata = yield* cloudCliOAuthConfig;
    const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
    const challenge = Encoding.encodeBase64Url(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const state = yield* crypto.randomUUIDv4;
    const callback = yield* Deferred.make<string>();
    const callbackRoute = HttpRouter.add(
      "GET",
      "/callback",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl, metadata.redirectUri);
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || !code) {
          return HttpServerResponse.text("Invalid T3 Connect authorization callback.", {
            status: 400,
          });
        }
        yield* Deferred.succeed(callback, code);
        return yield* HttpServerResponse.html`
<html>
  <body style="font-family: sans-serif; text-align: center; margin-top: 50px;">
    <h1>T3 Connect authorization complete</h1>
    <p>You can close this window and return to your terminal.</p>
  </body>
</html>
`;
      }),
    );
    yield* HttpRouter.serve(callbackRoute, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 34338,
          disablePreemptiveShutdown: true,
        }),
      ),
      Layer.build,
    );
    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.searchParams.set("client_id", metadata.clientId);
    authorizationUrl.searchParams.set("redirect_uri", metadata.redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", metadata.scopes.join(" "));
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    yield* Console.log(
      [
        `Open this URL to authorize T3 Connect:\n${authorizationUrl.toString()}`,
        "",
        "Tip: on a headless or remote machine (SSH, VPS), run `t3 connect login --device` instead.",
        "",
      ].join("\n"),
    );
    const code = yield* Deferred.await(callback).pipe(
      Effect.timeout(CLOUD_CLI_OAUTH_CALLBACK_TIMEOUT),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(
          new CloudCliAuthorizationTimeoutError({
            cause,
          }),
        ),
      ),
    );
    return yield* exchangeToken(metadata, {
      grant_type: "authorization_code",
      code,
      redirect_uri: metadata.redirectUri,
      client_id: metadata.clientId,
      code_verifier: verifier,
    });
  });

  const loginDevice = Effect.fn("cloud.cli_token.login_device")(function* () {
    const metadata = yield* cloudCliOAuthConfig;
    const relayUrl = yield* relayUrlConfig;
    const verifier = Encoding.encodeBase64Url(yield* crypto.randomBytes(32));
    const challenge = Encoding.encodeBase64Url(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
    );

    const hostname = yield* HostProcessHostname;
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    const authorization = yield* HttpClientRequest.post(`${relayUrl}/v1/device/authorization`).pipe(
      HttpClientRequest.bodyUrlParams({
        client_id: metadata.clientId,
        scope: metadata.scopes.join(" "),
        code_challenge: challenge,
        code_challenge_method: "S256",
        device_name: hostname,
        device_platform: `${platform} (${architecture}) node-v${process.versions.node}`,
      }),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayDeviceAuthorizationResponse)),
    );

    yield* Console.log(
      [
        `To authorize T3 Connect, open ${authorization.verification_uri} on another device and enter this code:`,
        "",
        `  ${authorization.user_code}`,
        "",
        "Or open this link directly:",
        authorization.verification_uri_complete,
        "",
        "Waiting for approval...",
      ].join("\n"),
    );

    let pollInterval = Duration.seconds(authorization.interval);
    // Approval can take minutes; a flaky network or a relay blip mid-wait
    // must not abort the whole login, so only repeated transport failures do.
    let consecutiveTransportFailures = 0;
    const failTransportOrContinue = (cause: unknown) => {
      consecutiveTransportFailures += 1;
      return consecutiveTransportFailures >= CLOUD_CLI_DEVICE_POLL_MAX_TRANSPORT_FAILURES
        ? Effect.fail(new CloudCliAuthorizationError({ cause }))
        : Effect.succeed(Option.none<HttpClientResponse.HttpClientResponse>());
    };
    const poll = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(pollInterval);
        const response = yield* rawHttpClient
          .execute(
            HttpClientRequest.post(`${relayUrl}/v1/device/token`).pipe(
              HttpClientRequest.bodyUrlParams({
                grant_type: RelayDeviceAuthorizationGrantType,
                device_code: authorization.device_code,
                client_id: metadata.clientId,
              }),
            ),
          )
          .pipe(Effect.map(Option.some), Effect.catch(failTransportOrContinue));
        if (Option.isNone(response)) {
          continue;
        }
        if (response.value.status === 200) {
          return yield* HttpClientResponse.schemaBodyJson(RelayDeviceTokenResponse)(response.value);
        }
        if (response.value.status !== 400) {
          // Gateway errors and other unexpected statuses are transient.
          yield* failTransportOrContinue(
            `Relay device token poll returned status ${response.value.status}.`,
          );
          continue;
        }
        consecutiveTransportFailures = 0;
        const body = yield* HttpClientResponse.schemaBodyJson(DeviceTokenPollErrorBody)(
          response.value,
        ).pipe(Effect.mapError((cause) => new CloudCliAuthorizationError({ cause })));
        switch (body.code) {
          case "authorization_pending":
            continue;
          case "slow_down":
            pollInterval = Duration.sum(pollInterval, Duration.seconds(5));
            continue;
          case "access_denied":
            return yield* new CloudCliAuthorizationError({
              cause: "The device authorization request was denied.",
            });
          case "expired_token":
            return yield* new CloudCliAuthorizationTimeoutError({
              cause:
                "The device authorization request expired or was already redeemed before this device could complete it.",
            });
        }
      }
    });

    // The relay owns the authoritative expiry (it answers expired_token), so
    // the local timeout is a backstop padded past the final scheduled poll.
    const grant = yield* poll.pipe(
      Effect.timeout(Duration.seconds(authorization.expires_in + authorization.interval + 5)),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(new CloudCliAuthorizationTimeoutError({ cause })),
      ),
    );

    return yield* exchangeToken(metadata, {
      grant_type: "authorization_code",
      code: grant.authorization_code,
      redirect_uri: grant.redirect_uri,
      client_id: metadata.clientId,
      code_verifier: verifier,
    });
  });

  const getExistingNoLock = Effect.fn("cloud.cli_token.get_existing_no_lock")(function* () {
    const token = yield* read();
    if (Option.isNone(token)) return token;
    const now = yield* Clock.currentTimeMillis;
    if (token.value.expiresAtEpochMs - CLOUD_CLI_OAUTH_REFRESH_EARLY_MS > now) {
      return token;
    }
    return Option.some(yield* refresh(token.value).pipe(Effect.flatMap(persist)));
  });

  const getExisting = semaphore.withPermits(1)(
    getExistingNoLock().pipe(wrapError((cause) => new CloudCliCredentialRefreshError({ cause }))),
  );
  const hasCredential = semaphore.withPermits(1)(
    read().pipe(
      Effect.map(Option.isSome),
      wrapError((cause) => new CloudCliCredentialReadError({ cause })),
    ),
  );
  const get = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const token = yield* getExistingNoLock();
      return Option.isSome(token)
        ? token.value
        : yield* Effect.scoped(login()).pipe(Effect.flatMap(persist));
    }).pipe(wrapUnknownError((cause) => new CloudCliAuthorizationError({ cause }))),
  );
  const getWithDeviceLogin = semaphore.withPermits(1)(
    Effect.gen(function* () {
      const token = yield* getExistingNoLock();
      return Option.isSome(token)
        ? token.value
        : yield* loginDevice().pipe(Effect.flatMap(persist));
    }).pipe(wrapUnknownError((cause) => new CloudCliAuthorizationError({ cause }))),
  );

  return CloudCliTokenManager.of({ get, getWithDeviceLogin, getExisting, hasCredential, clear });
});

export const layer = Layer.effect(CloudCliTokenManager, make);
