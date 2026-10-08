import {
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type EnvironmentAuthInvalidError,
  type EnvironmentConflictError,
  type EnvironmentInternalError,
  type EnvironmentOperationForbiddenError,
  type EnvironmentRequestInvalidError,
  type EnvironmentResourceNotFoundError,
  type EnvironmentScopeRequiredError,
  type EnvironmentThreadCompactionError,
} from "@t3tools/contracts";
import * as HttpObservability from "@t3tools/shared/httpObservability";
import { mergeRemoteQueryParameters, type RemoteQueryParameter } from "@t3tools/shared/remote";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const SAFE_REMOTE_REQUEST_URL = "remote environment endpoint";

const sanitizeRemoteRequestUrl = (requestUrl: string): string => {
  try {
    const url = new URL(requestUrl);
    return url.origin === "null" ? SAFE_REMOTE_REQUEST_URL : `${url.origin}${url.pathname}`;
  } catch {
    return SAFE_REMOTE_REQUEST_URL;
  }
};

export class RemoteEnvironmentAuthFetchError extends Data.TaggedError(
  "RemoteEnvironmentAuthFetchError",
)<{
  readonly message: string;
  readonly cause: "fetch";
}> {
  constructor(input: { readonly message: string; readonly cause: unknown }) {
    super({ message: input.message, cause: "fetch" });
  }
}

export class RemoteEnvironmentAuthInvalidJsonError extends Data.TaggedError(
  "RemoteEnvironmentAuthInvalidJsonError",
)<{
  readonly message: string;
  readonly cause: "invalid-json";
}> {
  constructor(input: { readonly message: string; readonly cause: unknown }) {
    super({ message: input.message, cause: "invalid-json" });
  }
}

export class RemoteEnvironmentAuthUndeclaredStatusError extends Data.TaggedError(
  "RemoteEnvironmentAuthUndeclaredStatusError",
)<{
  readonly message: string;
  readonly status: number;
  readonly requestUrl: string;
}> {
  constructor(requestUrl: string, status: number) {
    const safeRequestUrl = sanitizeRemoteRequestUrl(requestUrl);
    super({
      message: `Remote environment endpoint ${safeRequestUrl} returned undeclared status ${status}.`,
      requestUrl: safeRequestUrl,
      status,
    });
  }
}

export class RemoteEnvironmentAuthTimeoutError extends Data.TaggedError(
  "RemoteEnvironmentAuthTimeoutError",
)<{
  readonly message: string;
  readonly requestUrl: string;
  readonly timeoutMs: number;
}> {
  constructor(requestUrl: string, timeoutMs: number) {
    const safeRequestUrl = sanitizeRemoteRequestUrl(requestUrl);
    super({
      message: `Remote environment endpoint ${safeRequestUrl} timed out after ${timeoutMs}ms.`,
      requestUrl: safeRequestUrl,
      timeoutMs,
    });
  }
}

export type RemoteEnvironmentRequestError =
  | EnvironmentRequestInvalidError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError
  | EnvironmentConflictError
  | EnvironmentResourceNotFoundError
  | EnvironmentThreadCompactionError
  | EnvironmentInternalError
  | RemoteEnvironmentAuthFetchError
  | RemoteEnvironmentAuthInvalidJsonError
  | RemoteEnvironmentAuthUndeclaredStatusError
  | RemoteEnvironmentAuthTimeoutError;

export const layerRemoteHttpClient = (
  fetchFn: typeof globalThis.fetch,
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.merge(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
    HttpObservability.layer,
  );

const remoteApiBaseUrl = (httpBaseUrl: string): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

const transformRemoteHttpClient = (
  httpBaseUrl: string,
  queryParameters: readonly RemoteQueryParameter[],
) => {
  const baseUrl = remoteApiBaseUrl(httpBaseUrl);

  return (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((request) => {
        const requestWithBase = HttpClientRequest.prependUrl(baseUrl)(request);
        if (queryParameters.length === 0) {
          return requestWithBase;
        }
        const fullRequestUrl = Option.getOrThrow(HttpClientRequest.toUrl(requestWithBase));
        const mergedUrl = new URL(
          mergeRemoteQueryParameters(fullRequestUrl.toString(), queryParameters),
        );
        return HttpClientRequest.setUrl(requestWithBase, mergedUrl);
      }),
    );
};

export const makeEnvironmentHttpApiClient = (
  httpBaseUrl: string,
  queryParameters?: readonly RemoteQueryParameter[],
) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    transformClient: transformRemoteHttpClient(httpBaseUrl, queryParameters ?? []),
  });

export const makeEnvironmentHttpApiGroupClient = <
  Group extends keyof typeof EnvironmentHttpApi.groups,
>(
  httpBaseUrl: string,
  group: Group,
  queryParameters?: readonly RemoteQueryParameter[],
) =>
  Effect.flatMap(HttpClient.HttpClient, (httpClient) =>
    HttpApiClient.group(EnvironmentHttpApi, {
      httpClient: transformRemoteHttpClient(httpBaseUrl, queryParameters ?? [])(httpClient),
      group,
    }),
  );

/** Contract-derived request URLs for authentication proofs, tracing, and structured errors. */
export const makeEnvironmentHttpApiUrlBuilder = (httpBaseUrl: string) =>
  HttpApiClient.urlBuilder(EnvironmentHttpApi, {
    baseUrl: remoteApiBaseUrl(httpBaseUrl),
  });

const failRemoteRequest = (
  requestUrl: string,
  cause: unknown,
): Effect.Effect<never, RemoteEnvironmentRequestError> => {
  const safeRequestUrl = sanitizeRemoteRequestUrl(requestUrl);
  if (cause instanceof RemoteEnvironmentAuthTimeoutError) {
    return Effect.fail(cause);
  }
  if (isEnvironmentHttpCommonError(cause)) {
    return Effect.fail(cause);
  }
  if (Schema.isSchemaError(cause)) {
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${safeRequestUrl}.`,
        cause: "invalid-json",
      }),
    );
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const response = cause.response;
    if (response.status < 200 || response.status >= 300) {
      return Effect.fail(
        new RemoteEnvironmentAuthUndeclaredStatusError(safeRequestUrl, response.status),
      );
    }
    return Effect.fail(
      new RemoteEnvironmentAuthInvalidJsonError({
        message: `Remote environment endpoint returned an invalid response from ${safeRequestUrl}.`,
        cause: "invalid-json",
      }),
    );
  }
  return Effect.fail(
    new RemoteEnvironmentAuthFetchError({
      message: `Failed to fetch remote environment endpoint ${safeRequestUrl}.`,
      cause: "fetch",
    }),
  );
};

export const executeEnvironmentHttpRequest = <A, E, R>(
  requestUrl: string,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
): Effect.Effect<A, RemoteEnvironmentRequestError, R> =>
  request.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new RemoteEnvironmentAuthTimeoutError(requestUrl, timeoutMs)),
        onSome: Effect.succeed,
      }),
    ),
    Effect.catch((cause) => failRemoteRequest(requestUrl, cause)),
  );
