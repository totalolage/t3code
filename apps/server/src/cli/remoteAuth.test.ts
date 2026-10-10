import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTokenExchangeGrantType,
  type AuthSessionState,
  type ServerAuthDescriptor,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import {
  authenticateRemoteCli,
  LocalCliSessionIssuer,
  resolveAuthenticatedCliTarget,
} from "./remoteAuth.ts";
import type { RemoteCliTarget } from "./remoteTarget.ts";
import { readRemoteToken, type StoredRemoteToken, writeRemoteToken } from "./remoteTokenStore.ts";
import { RemoteCliError } from "./remoteHttp.ts";

const descriptor = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.40",
  capabilities: { repositoryIdentity: false },
} satisfies ExecutionEnvironmentDescriptor;

const authDescriptor = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session_test",
} satisfies ServerAuthDescriptor;

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const bearerTokenResponse = (input: {
  readonly accessToken?: string;
  readonly tokenType?: "Bearer" | "DPoP";
  readonly expiresIn?: number;
  readonly scope?: string;
}) =>
  jsonResponse({
    access_token: input.accessToken ?? "issued-access-token",
    issued_token_type: AuthAccessTokenType,
    token_type: input.tokenType ?? "Bearer",
    expires_in: input.expiresIn ?? 3_600,
    scope: input.scope ?? `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`,
  });

const authenticatedSession = (input?: {
  readonly subject?: string;
  readonly scopes?: ReadonlyArray<
    typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope | "terminal:operate"
  >;
}): AuthSessionState => ({
  authenticated: true,
  auth: authDescriptor,
  scopes: input?.scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  sessionMethod: "bearer-access-token",
  principal: {
    sessionId: AuthSessionId.make("session-1"),
    subject: input?.subject ?? "one-time-token",
  },
});

const unauthenticatedSession = (): AuthSessionState => ({
  authenticated: false,
  auth: authDescriptor,
});

const recordingFetch = (
  requests: Array<Request>,
  handle: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    return (await handle(request)).clone();
  }) as typeof globalThis.fetch;
  return fetch;
};

const fetchLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));

const withTemporaryHome = <A, E, R>(run: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "remote-auth-" });
      return yield* run(baseDir);
    }),
  );

const provideNodeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const makeLocalTarget = Effect.fn("remoteAuth.test.makeLocalTarget")(function* (baseDir: string) {
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
  );
  return {
    kind: "local",
    httpBaseUrl: "http://127.0.0.1:3773",
    environment: descriptor,
    tokenStateDirectory: path.join(baseDir, "local-cli"),
    tokenKey: `environment:${descriptor.environmentId}`,
    serverConfig,
  } satisfies RemoteCliTarget;
});

const makeRemoteTarget = (baseDir: string): RemoteCliTarget => ({
  kind: "remote",
  httpBaseUrl: "https://remote.example",
  environment: descriptor,
  tokenStateDirectory: `${baseDir}/remote-cli`,
  tokenKey: "https://remote.example",
});

const tokenFilePath = (path: Path.Path, target: RemoteCliTarget): string =>
  path.join(target.tokenStateDirectory, "tokens", `${encodeURIComponent(target.tokenKey)}.json`);

const futureExpiry = 4_000_000_000_000;

describe("remote CLI authentication", () => {
  it.effect(
    "exchanges the native token endpoint, validates the bearer, and persists its exact target",
    () =>
      provideNodeServices(
        withTemporaryHome((baseDir) => {
          const requests: Array<Request> = [];
          return Effect.gen(function* () {
            const target = makeRemoteTarget(baseDir);
            const result = yield* authenticateRemoteCli(target, "bootstrap-secret");
            const token = yield* readRemoteToken(target.tokenStateDirectory, target.tokenKey);
            if (Option.isNone(token))
              throw new Error("Expected the exchanged token to be persisted.");
            const form = new URLSearchParams(yield* Effect.promise(() => requests[0]!.text()));

            assert.isTrue(result.authenticated);
            assert.equal(result.expiresAtEpochMs, token.value.expiresAtEpochMs);
            assert.deepEqual(token.value, {
              accessToken: "issued-access-token",
              expiresAtEpochMs: result.expiresAtEpochMs,
            });
            assert.equal(requests[0]?.url, "https://remote.example/oauth/token");
            assert.equal(form.get("grant_type"), AuthTokenExchangeGrantType);
            assert.equal(form.get("subject_token"), "bootstrap-secret");
            assert.equal(form.get("subject_token_type"), AuthEnvironmentBootstrapTokenType);
            assert.equal(
              form.get("scope"),
              `${AuthOrchestrationReadScope} ${AuthOrchestrationOperateScope}`,
            );
            assert.equal(requests[1]?.url, "https://remote.example/api/auth/session");
            assert.equal(requests[1]?.headers.get("authorization"), "Bearer issued-access-token");
            assert.isNull(requests[0]?.headers.get("authorization"));
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                fetchLayer(
                  recordingFetch(requests, (request) =>
                    new URL(request.url).pathname === "/oauth/token"
                      ? bearerTokenResponse({})
                      : jsonResponse(authenticatedSession()),
                  ),
                ),
              ),
            ),
          );
        }),
      ),
  );

  it.effect(
    "does not replace an existing token when an exchanged bearer session is unauthenticated or under-scoped",
    () =>
      provideNodeServices(
        withTemporaryHome((baseDir) => {
          const cases = [
            {
              name: "unauthenticated",
              session: unauthenticatedSession(),
              reason: "authentication-required",
            },
            {
              name: "insufficient-scopes",
              session: authenticatedSession({ scopes: [AuthOrchestrationReadScope] }),
              reason: "unexpected-token",
            },
          ] as const;

          return Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;

            for (const testCase of cases) {
              const requests: Array<Request> = [];
              const target = {
                ...makeRemoteTarget(baseDir),
                tokenStateDirectory: path.join(baseDir, testCase.name),
              } satisfies RemoteCliTarget;
              const existingToken = {
                accessToken: `existing-${testCase.name}`,
                expiresAtEpochMs: futureExpiry,
              } satisfies StoredRemoteToken;
              yield* writeRemoteToken(target.tokenStateDirectory, target.tokenKey, existingToken);
              const before = yield* fileSystem.readFileString(tokenFilePath(path, target));

              const error = yield* authenticateRemoteCli(target, `bootstrap-${testCase.name}`).pipe(
                Effect.flip,
                Effect.provide(
                  Layer.mergeAll(
                    NodeServices.layer,
                    fetchLayer(
                      recordingFetch(requests, (request) =>
                        new URL(request.url).pathname === "/oauth/token"
                          ? bearerTokenResponse({ accessToken: `issued-${testCase.name}` })
                          : jsonResponse(testCase.session),
                      ),
                    ),
                  ),
                ),
              );

              assert.instanceOf(error, RemoteCliError);
              assert.equal(error.reason, testCase.reason);
              assert.lengthOf(requests, 2);
              assert.equal(yield* fileSystem.readFileString(tokenFilePath(path, target)), before);
              assert.deepEqual(
                yield* readRemoteToken(target.tokenStateDirectory, target.tokenKey),
                Option.some(existingToken),
              );
            }
          });
        }),
      ),
  );

  it.effect("rejects DPoP, missing scopes, and invalid expiry before any token is persisted", () =>
    provideNodeServices(
      withTemporaryHome((baseDir) =>
        Effect.gen(function* () {
          const cases = [
            { name: "dpop", token: bearerTokenResponse({ tokenType: "DPoP" }) },
            {
              name: "missing-scope",
              token: bearerTokenResponse({ scope: AuthOrchestrationReadScope }),
            },
            { name: "zero-expiry", token: bearerTokenResponse({ expiresIn: 0 }) },
            { name: "negative-expiry", token: bearerTokenResponse({ expiresIn: -1 }) },
            {
              name: "invalid-expiry",
              token: jsonResponse({ access_token: "bad", expires_in: "soon" }),
            },
          ] as const;

          for (const testCase of cases) {
            const requests: Array<Request> = [];
            const target = {
              ...makeRemoteTarget(baseDir),
              tokenStateDirectory: `${baseDir}/${testCase.name}`,
            } satisfies RemoteCliTarget;
            const error = yield* authenticateRemoteCli(target, "bootstrap-secret").pipe(
              Effect.flip,
              Effect.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  fetchLayer(
                    recordingFetch(requests, (request) =>
                      new URL(request.url).pathname === "/oauth/token"
                        ? testCase.token
                        : jsonResponse(authenticatedSession()),
                    ),
                  ),
                ),
              ),
            );

            assert.instanceOf(error, RemoteCliError);
            assert.equal(
              error.reason,
              testCase.name === "invalid-expiry" ? "request-failed" : "unexpected-token",
            );
            assert.lengthOf(requests, 1);
            assert.isTrue(
              Option.isNone(yield* readRemoteToken(target.tokenStateDirectory, target.tokenKey)),
            );
          }
        }),
      ),
    ),
  );

  it.effect("uses a stored read token for reads but refuses an operate request", () =>
    provideNodeServices(
      withTemporaryHome((baseDir) => {
        const requests: Array<Request> = [];
        return Effect.gen(function* () {
          const target = makeRemoteTarget(baseDir);
          yield* writeRemoteToken(target.tokenStateDirectory, target.tokenKey, {
            accessToken: "read-only-token",
            expiresAtEpochMs: futureExpiry,
          });

          const read = yield* resolveAuthenticatedCliTarget(target, AuthOrchestrationReadScope);
          assert.equal(read.accessToken, "read-only-token");

          const operateError = yield* resolveAuthenticatedCliTarget(
            target,
            AuthOrchestrationOperateScope,
          ).pipe(Effect.flip);
          assert.instanceOf(operateError, RemoteCliError);
          assert.equal(operateError.reason, "scope-required");
          assert.lengthOf(requests, 2);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              fetchLayer(
                recordingFetch(requests, () =>
                  jsonResponse(authenticatedSession({ scopes: [AuthOrchestrationReadScope] })),
                ),
              ),
              Layer.succeed(LocalCliSessionIssuer, {
                issue: () => Effect.die("local issuer is not used for remote targets"),
              }),
            ),
          ),
        );
      }),
    ),
  );

  it.effect("reuses a valid local session without invoking the issuer", () =>
    provideNodeServices(
      withTemporaryHome((baseDir) => {
        let issuerCalls = 0;
        return Effect.gen(function* () {
          const target = yield* makeLocalTarget(baseDir);
          yield* writeRemoteToken(target.tokenStateDirectory, target.tokenKey, {
            accessToken: "local-existing-token",
            expiresAtEpochMs: futureExpiry,
          });
          const result = yield* resolveAuthenticatedCliTarget(
            target,
            AuthOrchestrationOperateScope,
          );

          assert.equal(result.accessToken, "local-existing-token");
          assert.equal(result.session.principal?.subject, `local-cli:${descriptor.environmentId}`);
          assert.equal(issuerCalls, 0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              fetchLayer(
                recordingFetch([], () =>
                  jsonResponse(
                    authenticatedSession({ subject: `local-cli:${descriptor.environmentId}` }),
                  ),
                ),
              ),
              Layer.succeed(LocalCliSessionIssuer, {
                issue: () =>
                  Effect.sync(() => {
                    issuerCalls += 1;
                  }).pipe(
                    Effect.andThen(Effect.fail(new RemoteCliError({ reason: "unexpected-token" }))),
                  ),
              }),
            ),
          ),
        );
      }),
    ),
  );

  it.effect(
    "issues once for an expired or server-revoked local session and validates before replacing it",
    () =>
      provideNodeServices(
        withTemporaryHome((baseDir) => {
          let issuerCalls = 0;
          const expiredIssued: StoredRemoteToken = {
            accessToken: "replacement-expired",
            expiresAtEpochMs: futureExpiry,
          };
          const revokedIssued: StoredRemoteToken = {
            accessToken: "replacement-revoked",
            expiresAtEpochMs: futureExpiry,
          };
          return Effect.gen(function* () {
            const path = yield* Path.Path;
            const expiredTarget = yield* makeLocalTarget(path.join(baseDir, "expired"));
            const revokedTarget = yield* makeLocalTarget(path.join(baseDir, "revoked"));
            yield* writeRemoteToken(expiredTarget.tokenStateDirectory, expiredTarget.tokenKey, {
              accessToken: "expired-token",
              expiresAtEpochMs: -1,
            });
            yield* writeRemoteToken(revokedTarget.tokenStateDirectory, revokedTarget.tokenKey, {
              accessToken: "revoked-token",
              expiresAtEpochMs: futureExpiry,
            });

            const expiredResult = yield* resolveAuthenticatedCliTarget(
              expiredTarget,
              AuthOrchestrationReadScope,
            );
            const revokedResult = yield* resolveAuthenticatedCliTarget(
              revokedTarget,
              AuthOrchestrationReadScope,
            );

            assert.equal(expiredResult.accessToken, "replacement-expired");
            assert.equal(revokedResult.accessToken, "replacement-revoked");
            assert.equal(issuerCalls, 2);
            assert.deepEqual(
              yield* readRemoteToken(expiredTarget.tokenStateDirectory, expiredTarget.tokenKey),
              Option.some(expiredIssued),
            );
            assert.deepEqual(
              yield* readRemoteToken(revokedTarget.tokenStateDirectory, revokedTarget.tokenKey),
              Option.some(revokedIssued),
            );
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                fetchLayer(
                  recordingFetch([], (request) =>
                    request.headers.get("authorization") === "Bearer revoked-token"
                      ? jsonResponse(unauthenticatedSession())
                      : jsonResponse(
                          authenticatedSession({
                            subject: `local-cli:${descriptor.environmentId}`,
                          }),
                        ),
                  ),
                ),
                Layer.succeed(LocalCliSessionIssuer, {
                  issue: () =>
                    Effect.sync(() => {
                      issuerCalls += 1;
                      return issuerCalls === 1 ? expiredIssued : revokedIssued;
                    }),
                }),
              ),
            ),
          );
        }),
      ),
  );

  it.effect(
    "keeps expired and revoked local tokens when a replacement has the wrong subject or scopes",
    () =>
      provideNodeServices(
        withTemporaryHome((baseDir) => {
          let issuerCalls = 0;
          const cases = [
            {
              name: "expired-wrong-subject",
              oldToken: {
                accessToken: "expired-old-token",
                expiresAtEpochMs: -1,
              },
              replacement: {
                accessToken: "replacement-wrong-subject",
                expiresAtEpochMs: futureExpiry,
              },
              replacementSession: authenticatedSession({ subject: "local-cli:other-environment" }),
            },
            {
              name: "revoked-wrong-scopes",
              oldToken: {
                accessToken: "revoked-old-token",
                expiresAtEpochMs: futureExpiry,
              },
              replacement: {
                accessToken: "replacement-wrong-scopes",
                expiresAtEpochMs: futureExpiry,
              },
              replacementSession: authenticatedSession({
                subject: `local-cli:${descriptor.environmentId}`,
                scopes: [AuthOrchestrationReadScope],
              }),
            },
          ] as const;
          const replacementSessions = new Map(
            cases.map((testCase) => [
              `Bearer ${testCase.replacement.accessToken}`,
              testCase.replacementSession,
            ]),
          );

          return Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;

            for (const [index, testCase] of cases.entries()) {
              const target = yield* makeLocalTarget(path.join(baseDir, testCase.name));
              yield* writeRemoteToken(
                target.tokenStateDirectory,
                target.tokenKey,
                testCase.oldToken,
              );
              const before = yield* fileSystem.readFileString(tokenFilePath(path, target));
              const callsBefore = issuerCalls;

              const error = yield* resolveAuthenticatedCliTarget(
                target,
                AuthOrchestrationReadScope,
              ).pipe(Effect.flip);

              assert.instanceOf(error, RemoteCliError);
              assert.equal(error.reason, "unexpected-token");
              assert.equal(issuerCalls - callsBefore, 1);
              assert.equal(issuerCalls, index + 1);
              assert.equal(yield* fileSystem.readFileString(tokenFilePath(path, target)), before);
              assert.deepEqual(
                yield* readRemoteToken(target.tokenStateDirectory, target.tokenKey),
                Option.some(testCase.oldToken),
              );
            }
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                fetchLayer(
                  recordingFetch([], (request) => {
                    const replacementSession = replacementSessions.get(
                      request.headers.get("authorization") ?? "",
                    );
                    if (replacementSession !== undefined) {
                      return jsonResponse(replacementSession);
                    }
                    if (request.headers.get("authorization") === "Bearer revoked-old-token") {
                      return jsonResponse(unauthenticatedSession());
                    }
                    return Promise.reject(new Error("unexpected local auth request"));
                  }),
                ),
                Layer.succeed(LocalCliSessionIssuer, {
                  issue: () =>
                    Effect.sync(() => {
                      issuerCalls += 1;
                      const testCase = cases[issuerCalls - 1];
                      if (testCase === undefined) {
                        throw new Error("Unexpected extra local issuer call");
                      }
                      return testCase.replacement;
                    }),
                }),
              ),
            ),
          );
        }),
      ),
  );

  it.effect(
    "does not issue or replace a local token after principal, file, or transport failures",
    () =>
      provideNodeServices(
        withTemporaryHome((baseDir) => {
          let issuerCalls = 0;
          return Effect.gen(function* () {
            const path = yield* Path.Path;
            const wrongSubjectTarget = yield* makeLocalTarget(path.join(baseDir, "wrong-subject"));
            const extraScopeTarget = yield* makeLocalTarget(path.join(baseDir, "extra-scope"));
            const malformedTarget = yield* makeLocalTarget(path.join(baseDir, "malformed"));
            const transportTarget = yield* makeLocalTarget(path.join(baseDir, "transport"));
            for (const [target, accessToken] of [
              [wrongSubjectTarget, "wrong-subject-token"],
              [extraScopeTarget, "extra-scope-token"],
              [transportTarget, "transport-token"],
            ] as const) {
              yield* writeRemoteToken(target.tokenStateDirectory, target.tokenKey, {
                accessToken,
                expiresAtEpochMs: futureExpiry,
              });
            }
            const tokenDirectory = path.join(malformedTarget.tokenStateDirectory, "tokens");
            const malformedTokenPath = tokenFilePath(path, malformedTarget);
            const fileSystem = yield* FileSystem.FileSystem;
            yield* fileSystem.makeDirectory(tokenDirectory, { recursive: true });
            yield* fileSystem.writeFileString(malformedTokenPath, '{"accessToken":"secret",');

            const wrongSubjectError = yield* resolveAuthenticatedCliTarget(
              wrongSubjectTarget,
              AuthOrchestrationReadScope,
            ).pipe(Effect.flip);
            const extraScopeError = yield* resolveAuthenticatedCliTarget(
              extraScopeTarget,
              AuthOrchestrationReadScope,
            ).pipe(Effect.flip);
            const malformedError = yield* resolveAuthenticatedCliTarget(
              malformedTarget,
              AuthOrchestrationReadScope,
            ).pipe(Effect.flip);
            const transportError = yield* resolveAuthenticatedCliTarget(
              transportTarget,
              AuthOrchestrationReadScope,
            ).pipe(Effect.flip);

            assert.instanceOf(wrongSubjectError, RemoteCliError);
            assert.instanceOf(extraScopeError, RemoteCliError);
            assert.equal(malformedError._tag, "RemoteTokenStoreError");
            assert.instanceOf(transportError, RemoteCliError);
            assert.equal(issuerCalls, 0);
            const wrongSubjectToken = yield* readRemoteToken(
              wrongSubjectTarget.tokenStateDirectory,
              wrongSubjectTarget.tokenKey,
            );
            if (Option.isNone(wrongSubjectToken)) {
              throw new Error("Expected the existing token to remain persisted.");
            }
            assert.equal(wrongSubjectToken.value.accessToken, "wrong-subject-token");
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                fetchLayer(
                  recordingFetch([], (request) => {
                    const targetToken = request.headers.get("authorization");
                    if (targetToken === "Bearer wrong-subject-token") {
                      return jsonResponse(
                        authenticatedSession({ subject: "local-cli:other-environment" }),
                      );
                    }
                    if (targetToken === "Bearer extra-scope-token") {
                      return jsonResponse(
                        authenticatedSession({
                          subject: `local-cli:${descriptor.environmentId}`,
                          scopes: [
                            AuthOrchestrationReadScope,
                            AuthOrchestrationOperateScope,
                            "terminal:operate",
                          ],
                        }),
                      );
                    }
                    return Promise.reject(new Error("transport body credential=secret"));
                  }),
                ),
                Layer.succeed(LocalCliSessionIssuer, {
                  issue: () =>
                    Effect.sync(() => {
                      issuerCalls += 1;
                      return { accessToken: "should-not-issue", expiresAtEpochMs: futureExpiry };
                    }),
                }),
              ),
            ),
          );
        }),
      ),
  );

  it.effect("redacts credential and response-body details from errors and captured logs", () => {
    const credential = "bootstrap-secret-in-error";
    const privatePath = "/private/credential-path";
    const logs: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      logs.push(`${String(options.message)}\n${Cause.pretty(options.cause)}`);
    });
    const requests: Array<Request> = [];

    return Effect.gen(function* () {
      const error = yield* authenticateRemoteCli(
        {
          kind: "remote",
          httpBaseUrl: "https://remote.example",
          environment: descriptor,
          tokenStateDirectory: "/tmp/remote-auth-redaction",
          tokenKey: "https://remote.example",
        },
        credential,
      ).pipe(Effect.flip);
      assert.instanceOf(error, RemoteCliError);
      const serialized = String(error);
      const logText = logs.join("\n");

      assert.equal(error.reason, "request-failed");
      assert.notInclude(serialized, credential);
      assert.notInclude(serialized, privatePath);
      assert.notInclude(logText, credential);
      assert.notInclude(logText, privatePath);
      assert.lengthOf(requests, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          fetchLayer(
            recordingFetch(requests, () =>
              Promise.reject(new Error(`response body includes ${credential} at ${privatePath}`)),
            ),
          ),
          Logger.layer([logger]),
          Layer.succeed(References.MinimumLogLevel, "Trace"),
        ),
      ),
    );
  });
});
