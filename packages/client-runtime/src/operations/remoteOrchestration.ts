import {
  type ClientOrchestrationCommand,
  type CommandId,
  type DispatchResult,
  type OrchestrationReadModel,
  type OrchestrationCliCreateRequest,
  type OrchestrationCliCreateResult,
  type OrchestrationCliCompactRequest,
  type OrchestrationCliCompactResult,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type ThreadId,
  type RemoteInteractionAnswerRequest,
  type RemoteInteractionApproveRequest,
  type RemoteInteractionRejectRequest,
  type RemoteInteractionResponseResult,
  type RemoteInteractionThreadId,
  type RemotePendingInteractionsResult,
} from "@t3tools/contracts";
import type { RemoteQueryParameter } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

const DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS = 10_000;

export interface RemoteBearerAuthorization {
  readonly accessToken: string;
}

const bearerHeaders = (authorization: RemoteBearerAuthorization) => ({
  authorization: `Bearer ${authorization.accessToken}`,
});

interface RemoteOrchestrationHttpInput {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
}

const remoteHttpRequest = Effect.fn("clientRuntime.operations.remoteHttpRequest")(function* (
  input: RemoteOrchestrationHttpInput,
  pathname: string,
) {
  const queryParameters = input.queryParameters ?? [];
  return {
    requestUrl: environmentEndpointUrl(input.httpBaseUrl, pathname, queryParameters),
    client: yield* makeEnvironmentHttpApiClient(input.httpBaseUrl, queryParameters),
  };
});

export const fetchRemoteOrchestrationSnapshot = Effect.fn(
  "clientRuntime.operations.fetchRemoteOrchestrationSnapshot",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly timeoutMs?: number;
}): Effect.fn.Return<OrchestrationReadModel, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
  const { requestUrl, client } = yield* remoteHttpRequest(input, "/api/orchestration/snapshot");
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.snapshot({ headers: bearerHeaders(input.authorization) }),
  );
});

export const fetchRemoteOrchestrationShell = Effect.fn(
  "clientRuntime.operations.fetchRemoteOrchestrationShell",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationShellSnapshot,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(input, "/api/orchestration/shell");
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.shellSnapshot({ headers: bearerHeaders(input.authorization) }),
  );
});

export const fetchRemoteOrchestrationThread = Effect.fn(
  "clientRuntime.operations.fetchRemoteOrchestrationThread",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly threadId: ThreadId;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationThreadDetailSnapshot,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(
    input,
    `/api/orchestration/threads/${input.threadId}`,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.threadSnapshot({
      params: { threadId: input.threadId },
      headers: bearerHeaders(input.authorization),
      payload: {},
    }),
  );
});

export const dispatchRemoteOrchestrationCommand = Effect.fn(
  "clientRuntime.operations.dispatchRemoteOrchestrationCommand",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly command: ClientOrchestrationCommand;
  readonly timeoutMs?: number;
}): Effect.fn.Return<DispatchResult, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
  const { requestUrl, client } = yield* remoteHttpRequest(input, "/api/orchestration/dispatch");
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.dispatch({
      headers: bearerHeaders(input.authorization),
      payload: input.command,
    } as Parameters<typeof client.orchestration.dispatch>[0]),
  );
});

export const createRemoteOrchestrationThread = Effect.fn(
  "clientRuntime.operations.createRemoteOrchestrationThread",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: OrchestrationCliCreateRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationCliCreateResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(input, "/api/orchestration/create");
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.create({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export const compactRemoteOrchestrationThread = Effect.fn(
  "clientRuntime.operations.compactRemoteOrchestrationThread",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: OrchestrationCliCompactRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationCliCompactResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(input, "/api/orchestration/compact");
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? 30_000,
    client.orchestration.compact({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export const fetchRemotePendingInteractions = Effect.fn(
  "clientRuntime.operations.fetchRemotePendingInteractions",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly threadId?: RemoteInteractionThreadId;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemotePendingInteractionsResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(
    input,
    "/api/orchestration/pending-interactions",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.pendingInteractions({
      headers: bearerHeaders(input.authorization),
      query: input.threadId === undefined ? {} : { threadId: input.threadId },
    }),
  );
});

export const answerRemotePendingInteraction = Effect.fn(
  "clientRuntime.operations.answerRemotePendingInteraction",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: RemoteInteractionAnswerRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemoteInteractionResponseResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(
    input,
    "/api/orchestration/pending-interactions/answer",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.answerPendingInteraction({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export const approveRemotePendingInteraction = Effect.fn(
  "clientRuntime.operations.approveRemotePendingInteraction",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: RemoteInteractionApproveRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemoteInteractionResponseResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(
    input,
    "/api/orchestration/pending-interactions/approve",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.approvePendingInteraction({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export const rejectRemotePendingInteraction = Effect.fn(
  "clientRuntime.operations.rejectRemotePendingInteraction",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: RemoteInteractionRejectRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemoteInteractionResponseResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const { requestUrl, client } = yield* remoteHttpRequest(
    input,
    "/api/orchestration/pending-interactions/reject",
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.rejectPendingInteraction({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export function remoteThreadContainsCommand(
  snapshot: OrchestrationThreadDetailSnapshot,
  commandId: CommandId,
): boolean {
  return snapshot.thread.messages.some((message) => String(message.id) === String(commandId));
}
