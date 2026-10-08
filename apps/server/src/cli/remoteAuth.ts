import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  type AuthAccessTokenResult,
  type AuthEnvironmentScope,
  type AuthSessionState,
} from "@t3tools/contracts";
import { parseOAuthScope, encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeRemoteCliApi, requestRemoteCli, RemoteCliError } from "./remoteHttp.ts";
import type { RemoteCliTarget } from "./remoteTarget.ts";
import {
  readRemoteToken,
  StoredRemoteToken as StoredRemoteTokenSchema,
  type StoredRemoteToken,
  writeRemoteToken,
} from "./remoteTokenStore.ts";

export type AuthenticatedCliTarget = {
  readonly target: RemoteCliTarget;
  readonly accessToken: string;
  readonly session: AuthSessionState;
};

type LocalCliTarget = Extract<RemoteCliTarget, { readonly kind: "local" }>;

/**
 * The local server owns how a local CLI session is acquired. This seam keeps
 * acquisition separate from the token file and HTTP authentication logic.
 */
export class LocalCliSessionIssuer extends Context.Service<
  LocalCliSessionIssuer,
  {
    readonly issue: (target: LocalCliTarget) => Effect.Effect<StoredRemoteToken, RemoteCliError>;
  }
>()("t3/cli/remoteAuth/LocalCliSessionIssuer") {}

const CLI_AUTH_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const satisfies ReadonlyArray<AuthEnvironmentScope>;

const CLI_AUTH_SCOPE_VALUE = encodeOAuthScope(CLI_AUTH_SCOPES);
const isRemoteCliError = Schema.is(RemoteCliError);
const isStoredRemoteToken = Schema.is(StoredRemoteTokenSchema);

const hasAllScopes = (
  scopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
  requiredScopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean => scopes !== undefined && requiredScopes.every((scope) => scopes.includes(scope));

const hasExactScopes = (
  scopes: ReadonlyArray<AuthEnvironmentScope> | undefined,
  expectedScopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean =>
  scopes !== undefined &&
  scopes.length === expectedScopes.length &&
  expectedScopes.every((scope) => scopes.includes(scope));

const requestAuthToken = Effect.fn("remoteCli.requestAuthToken")(function* (
  target: RemoteCliTarget,
  credential: string,
) {
  const api = yield* Effect.try({
    try: () => makeRemoteCliApi(target.httpBaseUrl),
    catch: () => new RemoteCliError({ reason: "request-failed" }),
  }).pipe(Effect.flatten);
  const request = yield* Effect.try({
    try: () =>
      api.auth.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: CLI_AUTH_SCOPE_VALUE,
        },
      }),
    catch: () => new RemoteCliError({ reason: "request-failed" }),
  });
  return yield* requestRemoteCli(request);
});

const validateIssuedAccessToken = Effect.fn("remoteCli.validateIssuedAccessToken")(function* (
  response: AuthAccessTokenResult,
) {
  if (response.token_type !== "Bearer") {
    return yield* new RemoteCliError({ reason: "unexpected-token" });
  }

  const scopes = parseOAuthScope(response.scope);
  if (
    scopes === null ||
    !CLI_AUTH_SCOPES.every((scope) => scopes.includes(scope)) ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 0
  ) {
    return yield* new RemoteCliError({ reason: "unexpected-token" });
  }

  const now = yield* DateTime.now;
  const expiresAtEpochMs = now.epochMilliseconds + response.expires_in * 1_000;
  if (!Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= now.epochMilliseconds) {
    return yield* new RemoteCliError({ reason: "unexpected-token" });
  }

  return {
    accessToken: response.access_token,
    expiresAtEpochMs,
  } satisfies StoredRemoteToken;
});

const requestBearerSession = Effect.fn("remoteCli.requestBearerSession")(function* (
  target: RemoteCliTarget,
  accessToken: string,
) {
  const api = yield* Effect.try({
    try: () => makeRemoteCliApi(target.httpBaseUrl),
    catch: () => new RemoteCliError({ reason: "request-failed" }),
  }).pipe(Effect.flatten);
  const request = yield* Effect.try({
    try: () =>
      api.auth.session({
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    catch: () => new RemoteCliError({ reason: "request-failed" }),
  });
  return yield* requestRemoteCli(request);
});

const requireAuthenticatedBearerSession = (
  session: AuthSessionState,
): Effect.Effect<AuthSessionState, RemoteCliError> => {
  if (!session.authenticated) {
    return Effect.fail(new RemoteCliError({ reason: "authentication-required" }));
  }
  if (session.sessionMethod !== undefined && session.sessionMethod !== "bearer-access-token") {
    return Effect.fail(new RemoteCliError({ reason: "unexpected-token" }));
  }
  return Effect.succeed(session);
};

const requireIssuedCliSession = (session: AuthSessionState) =>
  requireAuthenticatedBearerSession(session).pipe(
    Effect.filterOrFail(
      (authenticated) => hasAllScopes(authenticated.scopes, CLI_AUTH_SCOPES),
      () => new RemoteCliError({ reason: "unexpected-token" }),
    ),
  );

const localCliSubject = (target: LocalCliTarget): string =>
  `local-cli:${target.environment.environmentId}`;

const requireLocalCliSession = (target: LocalCliTarget, session: AuthSessionState) =>
  requireAuthenticatedBearerSession(session).pipe(
    Effect.filterOrFail(
      (authenticated) =>
        authenticated.principal?.subject === localCliSubject(target) &&
        hasExactScopes(authenticated.scopes, CLI_AUTH_SCOPES),
      () => new RemoteCliError({ reason: "unexpected-token" }),
    ),
  );

const validateLocalIssuedToken = Effect.fn("remoteCli.validateLocalIssuedToken")(function* (
  token: StoredRemoteToken,
) {
  if (!isStoredRemoteToken(token)) {
    return yield* new RemoteCliError({ reason: "unexpected-token" });
  }

  const now = yield* DateTime.now;
  if (token.expiresAtEpochMs <= now.epochMilliseconds) {
    return yield* new RemoteCliError({ reason: "unexpected-token" });
  }

  return token;
});

const persistAuthenticatedToken = Effect.fn("remoteCli.persistAuthenticatedToken")(function* (
  target: RemoteCliTarget,
  token: StoredRemoteToken,
) {
  yield* writeRemoteToken(target.tokenStateDirectory, target.tokenKey, token);
  return token;
});

const issueAndValidateLocalSession = Effect.fn("remoteCli.issueAndValidateLocalSession")(function* (
  target: LocalCliTarget,
) {
  const issuer = yield* LocalCliSessionIssuer;
  const issued = yield* issuer.issue(target);
  const token = yield* validateLocalIssuedToken(issued);
  const session = yield* requestBearerSession(target, token.accessToken);
  const authenticatedSession = yield* requireLocalCliSession(target, session);
  yield* persistAuthenticatedToken(target, token);
  return {
    accessToken: token.accessToken,
    session: authenticatedSession,
  } as const;
});

/** Exchanges a bootstrap credential and persists only a validated bearer token. */
export const authenticateRemoteCli = Effect.fn("remoteCli.authenticateRemoteCli")(function* (
  remoteTarget: RemoteCliTarget,
  credential: string,
) {
  if (remoteTarget.kind !== "remote") {
    return yield* new RemoteCliError({ reason: "invalid-input" });
  }

  const issuedResponse = yield* requestAuthToken(remoteTarget, credential);
  const issued = yield* validateIssuedAccessToken(issuedResponse);
  const session = yield* requestBearerSession(remoteTarget, issued.accessToken);
  yield* requireIssuedCliSession(session);
  yield* persistAuthenticatedToken(remoteTarget, issued);

  return {
    authenticated: true,
    expiresAtEpochMs: issued.expiresAtEpochMs,
  } as const;
});

const resolveStoredAuthenticatedSession = Effect.fn("remoteCli.resolveStoredAuthenticatedSession")(
  function* (
    target: RemoteCliTarget,
    requiredScope: AuthEnvironmentScope,
    token: StoredRemoteToken,
  ) {
    const now = yield* DateTime.now;
    if (token.expiresAtEpochMs <= now.epochMilliseconds) {
      return yield* new RemoteCliError({ reason: "authentication-required" });
    }

    const session = yield* requestBearerSession(target, token.accessToken);
    if (target.kind === "local") {
      return yield* requireLocalCliSession(target, session).pipe(
        Effect.map((authenticated) => ({
          accessToken: token.accessToken,
          session: authenticated,
        })),
      );
    }

    const authenticated = yield* requireAuthenticatedBearerSession(session);
    if (!hasAllScopes(authenticated.scopes, [requiredScope])) {
      return yield* new RemoteCliError({ reason: "scope-required" });
    }
    return {
      accessToken: token.accessToken,
      session: authenticated,
    } as const;
  },
);

/** Resolves an already-resolved target without discovering or registering it. */
export const resolveAuthenticatedCliTarget = Effect.fn("remoteCli.resolveAuthenticatedCliTarget")(
  function* (target: RemoteCliTarget, requiredScope: AuthEnvironmentScope) {
    if (target.kind === "local" && !CLI_AUTH_SCOPES.some((scope) => scope === requiredScope)) {
      return yield* new RemoteCliError({ reason: "scope-required" });
    }

    const stored = yield* readRemoteToken(target.tokenStateDirectory, target.tokenKey);
    if (Option.isNone(stored)) {
      if (target.kind !== "local") {
        return yield* new RemoteCliError({ reason: "authentication-required" });
      }
      const issued = yield* issueAndValidateLocalSession(target);
      return {
        target,
        accessToken: issued.accessToken,
        session: issued.session,
      } satisfies AuthenticatedCliTarget;
    }

    const resolved = yield* resolveStoredAuthenticatedSession(
      target,
      requiredScope,
      stored.value,
    ).pipe(
      Effect.catchIf(isRemoteCliError, (error) =>
        target.kind === "local" && error.reason === "authentication-required"
          ? issueAndValidateLocalSession(target)
          : Effect.fail(error),
      ),
    );

    return {
      target,
      accessToken: resolved.accessToken,
      session: resolved.session,
    } satisfies AuthenticatedCliTarget;
  },
);
