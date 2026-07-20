import * as Effect from "effect/Effect";
import type { RemoteQueryParameter } from "@t3tools/shared/remote";

import { environmentEndpointUrl } from "./endpoint.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

export const fetchRemoteEnvironmentDescriptor = Effect.fn(
  "clientRuntime.environment.fetchRemoteEnvironmentDescriptor",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
  readonly timeoutMs?: number;
}) {
  const queryParameters = input.queryParameters ?? [];
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl, queryParameters);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/.well-known/t3/environment", queryParameters),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.metadata.descriptor(),
  );
});
