import {
  type OrchestrationCliCreateRequest,
  type OrchestrationCliCreateResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

export const createRemoteOrchestrationThread = Effect.fn(
  "clientRuntime.operations.createRemoteOrchestrationThread",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly payload: OrchestrationCliCreateRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationCliCreateResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "orchestration");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/orchestration/create"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.create({
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
      },
      payload: input.payload,
    }),
  );
});
