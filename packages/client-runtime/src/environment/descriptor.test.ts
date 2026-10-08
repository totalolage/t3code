import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fetchRemoteEnvironmentDescriptor } from "./descriptor.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: Array<FetchCall> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    if (!response) {
      return Promise.reject(new Error("Unexpected fetch call"));
    }
    return Promise.resolve(response);
  }) satisfies typeof fetch;

  return { fetchFn, calls };
};

const provideRemoteHttp = (fetchFn: typeof fetch) => Effect.provide(layerRemoteHttpClient(fetchFn));

const descriptor = {
  environmentId: "environment-remote",
  label: "Remote environment",
  platform: {
    os: "linux",
    arch: "x64",
    machine: "cloud",
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
    connectionProbe: true,
    attachmentUploads: true,
    questionAttachments: false,
    fileAttachments: { maxUploadBytes: 1024 },
    pullRequests: true,
    inlineMessageContext: true,
    threadSettlement: true,
    threadAutoSettlement: false,
    threadRestartContinuation: true,
    projectSettingsOverrides: true,
    threadSnooze: true,
    environmentThemes: true,
    usageLimitSources: true,
    usagePriceOverrides: true,
    threadPinning: true,
    threadPinReorder: true,
    threadActiveReorder: true,
    threadTitleRegeneration: true,
    threadPullRequestLinking: true,
    threadPullRequests: true,
    pullRequestStackActions: true,
    serverSelfUpdate: "boot-service",
    serverSelfUpdateProgress: true,
    serverUpdateThreadContinuation: true,
    agentActivityPublishing: true,
    environmentIcon: true,
    desktopAppUpdate: true,
  },
} as const;

const failingFetch = () => {
  const calls: Array<FetchCall> = [];
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    return Promise.reject(new Error(`Request failed for ${String(input)}`));
  }) satisfies typeof fetch;

  return { fetchFn, calls };
};

describe("fetchRemoteEnvironmentDescriptor", () => {
  it.effect("forwards ordered custom query parameters without pairing tokens", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(descriptor));

      const result = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
        queryParameters: [
          { key: "proxy", value: "one" },
          { key: "proxy", value: "two" },
          { key: "token", value: "query-token" },
          { key: " token ", value: "trimmed-token" },
        ],
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(result).toEqual(descriptor);
      expect(fetch.calls).toHaveLength(1);
      expect(String(fetch.calls[0]?.[0])).toBe(
        "https://remote.example.com/.well-known/t3/environment?proxy=one&proxy=two",
      );
    }),
  );

  it.effect("keeps the descriptor route query-free when custom parameters are omitted", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(descriptor));

      const result = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
      }).pipe(provideRemoteHttp(fetch.fetchFn));

      expect(result).toEqual(descriptor);
      expect(fetch.calls).toHaveLength(1);
      expect(String(fetch.calls[0]?.[0])).toBe(
        "https://remote.example.com/.well-known/t3/environment",
      );
    }),
  );

  it.effect("does not expose custom query values in fetch failure messages", () =>
    Effect.gen(function* () {
      const fetch = failingFetch();
      const secret = "secret-query-value";

      const error = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: "https://remote.example.com/",
        queryParameters: [{ key: "proxy", value: secret }],
      }).pipe(provideRemoteHttp(fetch.fetchFn), Effect.flip);

      expect(error.message).not.toContain(secret);
      expect(fetch.calls).toHaveLength(1);
      expect(String(fetch.calls[0]?.[0])).toContain(`proxy=${secret}`);
    }),
  );
});
