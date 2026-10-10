import {
  AuthEnvironmentScope,
  CommandId,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

export const RemoteCliErrorReason = Schema.Literals([
  "invalid-host",
  "unexpected-token",
  "authentication-required",
  "scope-required",
  "confirmation-required",
  "invalid-input",
  "capability-required",
  "version-incompatible",
  "local-server-not-running",
  "local-server-mismatch",
  "request-failed",
  "ambiguous-dispatch",
]);
export type RemoteCliErrorReason = typeof RemoteCliErrorReason.Type;

const REMOTE_CLI_REQUEST_TIMEOUT = Duration.seconds(15);
const SAFE_MACHINE_IDENTIFIER = /^[A-Za-z0-9_-]{1,100}$/;
const SAFE_OPERATION_IDENTIFIER = /^(?:[A-Za-z0-9_-]{1,100}|cli-send:[A-Fa-f0-9]{64})$/;
const SAFE_TRACE_ID = /^[A-Fa-f0-9]{32}$/;

export class RemoteCliError extends Schema.TaggedError<RemoteCliError>()("RemoteCliError", {
  reason: RemoteCliErrorReason,
  commandId: Schema.optionalKey(CommandId),
  threadId: Schema.optionalKey(ThreadId),
}) {
  static messageForReason(reason: RemoteCliErrorReason): string {
    switch (reason) {
      case "invalid-host":
        return "Remote host must be an absolute HTTP or HTTPS URL without credentials.";
      case "unexpected-token":
        return "The remote environment did not issue the requested bearer orchestration scopes.";
      case "authentication-required":
        return "The stored remote CLI token is not authenticated.";
      case "scope-required":
        return "The remote environment requires a scope that this token does not have.";
      case "confirmation-required":
        return "This remote operation requires explicit confirmation.";
      case "invalid-input":
        return "Remote command input is invalid.";
      case "capability-required":
        return "The target environment does not advertise the required capability.";
      case "version-incompatible":
        return "The target environment has an incompatible orchestration CLI API.";
      case "local-server-not-running":
        return "No live T3 server was discovered for this base directory.";
      case "local-server-mismatch":
        return "The discovered T3 server does not match this base directory.";
      case "request-failed":
        return "The remote environment request failed.";
      case "ambiguous-dispatch":
        return "The remote dispatch outcome is ambiguous; inspect the target thread before retrying.";
    }
  }

  get code(): RemoteCliErrorReason {
    return this.reason;
  }

  override get message(): string {
    return RemoteCliError.messageForReason(this.reason);
  }
}

const isRemoteCliError = Schema.is(RemoteCliError);
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

/** Normalizes a remote endpoint to its origin, which also keys the stored token. */
export const normalizeRemoteHttpBaseUrl = Effect.fn("normalizeRemoteHttpBaseUrl")(function* (
  host: string,
) {
  const url = yield* Effect.try({
    try: () => new URL(host),
    catch: () => new RemoteCliError({ reason: "invalid-host" }),
  });

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    return yield* new RemoteCliError({ reason: "invalid-host" });
  }

  return url.origin;
});

/**
 * Builds the native EnvironmentHttpApi client. Authentication is deliberately
 * not installed here: callers provide endpoint headers for authenticated calls.
 */
export const makeRemoteCliApi = (httpBaseUrl: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: new URL(httpBaseUrl).origin });

const normalizeRemoteCliRequestError = (
  error: unknown,
): RemoteCliError | EnvironmentHttpCommonError =>
  isRemoteCliError(error) || isEnvironmentHttpCommonError(error)
    ? error
    : new RemoteCliError({ reason: "request-failed" });

/** Applies the fixed remote request deadline and removes untrusted failure detail. */
export const requestRemoteCli = <A, E, R>(
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteCliError | EnvironmentHttpCommonError, R> =>
  request.pipe(
    Effect.timeoutOption(REMOTE_CLI_REQUEST_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteCliError({ reason: "request-failed" })),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError(normalizeRemoteCliRequestError),
    Effect.catchDefect(() => Effect.fail(new RemoteCliError({ reason: "request-failed" }))),
  );

const safeMachineIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_MACHINE_IDENTIFIER.test(value) ? value : undefined;

const safeOperationIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_OPERATION_IDENTIFIER.test(value) ? value : undefined;

const safeTraceId = (value: unknown): string | undefined =>
  typeof value === "string" && SAFE_TRACE_ID.test(value) ? value : undefined;

const remoteReasonForEnvironmentError = (
  error: EnvironmentHttpCommonError,
): RemoteCliErrorReason => {
  switch (error._tag) {
    case "EnvironmentRequestInvalidError":
      return "invalid-input";
    case "EnvironmentAuthInvalidError":
      return "authentication-required";
    case "EnvironmentScopeRequiredError":
      return "scope-required";
    default:
      return "request-failed";
  }
};

const formatRemoteCliErrorFields = (error: RemoteCliError) => ({
  code: error.reason,
  message: RemoteCliError.messageForReason(error.reason),
  ...(safeOperationIdentifier(error.commandId) === undefined
    ? {}
    : { commandId: safeOperationIdentifier(error.commandId) }),
  ...(safeOperationIdentifier(error.threadId) === undefined
    ? {}
    : { threadId: safeOperationIdentifier(error.threadId) }),
});

export function formatRemoteCliError(error: unknown) {
  if (isRemoteCliError(error)) {
    return { error: formatRemoteCliErrorFields(error) };
  }

  if (isEnvironmentHttpCommonError(error)) {
    const remoteReason = remoteReasonForEnvironmentError(error);
    const code = safeMachineIdentifier(error.code) ?? remoteReason;
    const reason = "reason" in error ? safeMachineIdentifier(error.reason) : undefined;
    const traceId = safeTraceId(error.traceId);
    const requiredScope =
      error._tag === "EnvironmentScopeRequiredError" && isAuthEnvironmentScope(error.requiredScope)
        ? error.requiredScope
        : undefined;

    return {
      error: {
        code,
        message: RemoteCliError.messageForReason(remoteReason),
        ...(reason === undefined ? {} : { reason }),
        ...(traceId === undefined ? {} : { traceId }),
        ...(requiredScope === undefined ? {} : { requiredScope }),
      },
    };
  }

  return {
    error: {
      code: "request-failed",
      message: RemoteCliError.messageForReason("request-failed"),
    },
  };
}

export type RemoteCliErrorOutput = ReturnType<typeof formatRemoteCliError>;
