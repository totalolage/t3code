import type { PullRequestDiffInput, PullRequestDiffResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_PULL_REQUEST_DIFF_TIMEOUT_MS = 60_000;

export const fetchEnvironmentPullRequestDiff = Effect.fn(
  "clientRuntime.state.fetchEnvironmentPullRequestDiff",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly diff: PullRequestDiffInput;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/pull-requests/diff",
    input.prepared.queryParameters,
  );
  const client = yield* makeEnvironmentHttpApiClient(
    input.prepared.httpBaseUrl,
    input.prepared.queryParameters,
  );
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_PULL_REQUEST_DIFF_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.pullRequests.diff({ payload: input.diff, headers }),
    ),
  );
});

export class PullRequestDiffLoader extends Context.Service<
  PullRequestDiffLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      input: PullRequestDiffInput,
    ) => Effect.Effect<PullRequestDiffResult, RemoteEnvironmentRequestError>;
  }
>()("@t3tools/client-runtime/state/pullRequestDiffHttp/PullRequestDiffLoader") {}

export const pullRequestDiffLoaderLayer: Layer.Layer<
  PullRequestDiffLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  PullRequestDiffLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return PullRequestDiffLoader.of({
      load: (prepared, input) =>
        fetchEnvironmentPullRequestDiff({ prepared, diff: input, signer }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
    });
  }),
);
