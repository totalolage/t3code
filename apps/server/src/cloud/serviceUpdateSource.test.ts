import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import {
  consumeServiceUpdateAsset,
  makeServiceUpdateSourceOperations,
  SERVICE_UPDATE_SOURCE_LIMITS,
  type ServiceUpdateAssetIdentity,
  type ServiceUpdateAssetKind,
  type ServiceUpdateSourceOperations,
} from "./serviceUpdateSource.ts";
import type { ServiceUpdateReleaseDescriptor } from "./serviceUpdateRelease.ts";
import { ServiceUpdateOperationError } from "./serviceUpdateServices.ts";

const REPOSITORY = "owner/repo";
const CURRENT_VERSION = "1.2.3-f8y.20260101.1";
const NEW_VERSION = "1.2.4-f8y.20260101.2";
const NEW_TAG = `v${NEW_VERSION}`;
const BINARY_NAME = `t3-${NEW_VERSION}-linux-x64`;

const identity: ServiceUpdateAssetIdentity = {
  owner: "owner",
  repo: "repo",
  tag: NEW_TAG,
  assetName: BINARY_NAME,
};

const canonicalAssetUrl = (assetName = BINARY_NAME): string =>
  `https://github.com/owner/repo/releases/download/${NEW_TAG}/${assetName}`;

const exactReleasePayload = {
  tag_name: NEW_TAG,
  draft: false,
  prerelease: false,
  assets: [
    { name: BINARY_NAME, browser_download_url: canonicalAssetUrl() },
    {
      name: `${BINARY_NAME}.sha256`,
      browser_download_url: canonicalAssetUrl(`${BINARY_NAME}.sha256`),
    },
  ],
};

const makeReleasePayload = (): unknown => [exactReleasePayload];

const releasePayloadText = JSON.stringify(makeReleasePayload());

const draftSkippedPayloadText = JSON.stringify([
  { tag_name: `v${NEW_VERSION}`, draft: true, prerelease: false, assets: [] },
  {
    tag_name: "v9.9.9-f8y.20260202.1",
    draft: false,
    prerelease: true,
    assets: [
      {
        name: "t3-9.9.9-f8y.20260202.1-linux-x64",
        browser_download_url:
          "https://github.com/owner/repo/releases/download/v9.9.9-f8y.20260202.1/t3-9.9.9-f8y.20260202.1-linux-x64",
      },
      {
        name: "t3-9.9.9-f8y.20260202.1-linux-x64.sha256",
        browser_download_url:
          "https://github.com/owner/repo/releases/download/v9.9.9-f8y.20260202.1/t3-9.9.9-f8y.20260202.1-linux-x64.sha256",
      },
    ],
  },
  {
    tag_name: "v1.2.4-f8y.20260103.3",
    draft: false,
    prerelease: false,
    assets: [
      {
        name: "t3-1.2.4-f8y.20260103.3-linux-x64",
        browser_download_url:
          "https://github.com/owner/repo/releases/download/v1.2.4-f8y.20260103.3/t3-1.2.4-f8y.20260103.3-linux-x64",
      },
      {
        name: "t3-1.2.4-f8y.20260103.3-linux-x64.sha256",
        browser_download_url:
          "https://github.com/owner/repo/releases/download/v1.2.4-f8y.20260103.3/t3-1.2.4-f8y.20260103.3-linux-x64.sha256",
      },
    ],
  },
]);

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly credentials: string | undefined;
  readonly redirect: string | undefined;
  readonly signal: AbortSignal;
}

interface Harness {
  readonly requests: Array<CapturedRequest>;
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Fake transport standing in for the platform fetch. Wires the request signal's
 * abort to the response body cancellation the way a real fetch does, so tests
 * can observe explicit request-scoped aborts.
 */
const makeHarness = (respond: (request: CapturedRequest, index: number) => Response): Harness => {
  const requests: Array<CapturedRequest> = [];
  const fetch = ((_url: string | URL, init?: Record<string, unknown>) => {
    const request: CapturedRequest = {
      url: String(_url),
      method: (init?.method as string | undefined) ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      credentials: init?.credentials as string | undefined,
      redirect: init?.redirect as string | undefined,
      signal: init?.signal as AbortSignal,
    };
    const index = requests.length;
    requests.push(request);
    const response = respond(request, index);
    request.signal.addEventListener("abort", () => {
      try {
        // A reader-locked body is cancelled by the consumer instead; the
        // rejection from cancel() on a locked stream is swallowed here.
        void response.body?.cancel().catch(() => {});
      } catch {
        // Synchronous lock errors land here.
      }
    });
    return Promise.resolve(response);
  }) as typeof globalThis.fetch;
  return { requests, fetch };
};

type ByteBody = NonNullable<Response["body"]>;

const byteBody = (
  setup: (controller: {
    enqueue: (chunk: Uint8Array) => void;
    close: () => void;
    error: (cause: unknown) => void;
  }) => void,
  hooks: { pull?: () => Promise<void>; cancel?: () => void } = {},
): ByteBody => {
  const source: {
    start: (controller: {
      enqueue: (chunk: Uint8Array) => void;
      close: () => void;
      error: (cause: unknown) => void;
    }) => void;
    pull?: () => Promise<void>;
    cancel?: () => void;
  } = {
    start: (controller) => {
      setup(controller);
    },
  };
  if (hooks.pull !== undefined) {
    const pull = hooks.pull;
    source.pull = () => pull();
  }
  if (hooks.cancel !== undefined) {
    const cancel = hooks.cancel;
    source.cancel = () => cancel();
  }
  return new ReadableStream<Uint8Array>(source) as unknown as ByteBody;
};

const textResponse = (text: string, headers?: Record<string, string>): Response =>
  new Response(
    byteBody((controller) => {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }),
    headers === undefined ? { status: 200 } : { status: 200, headers },
  );

const hangingResponse = (onCancel: () => void): Response =>
  new Response(
    byteBody(() => {}, { pull: () => new Promise<void>(() => {}), cancel: onCancel }),
    { status: 200 },
  );

const redirectResponse = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

const padToBytes = (payload: string, totalBytes: number): string =>
  payload + " ".repeat(Math.max(0, totalBytes - payload.length));

/**
 * Flattens an error's entire `cause` chain (names, messages, terminal cause)
 * into one string, so leak assertions cover the whole chain, not just the top.
 */
const causeChainText = (error: Error): string => {
  const parts: Array<string> = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.name, current.message);
    current = (current as { cause?: unknown }).cause;
  }
  if (current !== undefined) parts.push(String(current));
  return parts.join(" | ");
};

const expectCheckError = (
  operations: ServiceUpdateSourceOperations,
  input: { readonly repository: string; readonly currentVersion: string },
): Effect.Effect<ServiceUpdateOperationError> =>
  operations.check(input).pipe(
    Effect.flatMap((value) =>
      Effect.die(new Error(`expected a check failure but selected ${value?.version ?? "nothing"}`)),
    ),
    Effect.flip,
  );

describe("serviceUpdateSource check", () => {
  it.effect("returns null for an empty repository without fetching", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => {
        throw new Error("must not fetch");
      });
      const operations = makeServiceUpdateSourceOperations(harness);
      const result = yield* operations.check({ repository: "", currentVersion: CURRENT_VERSION });
      expect(result).toBeNull();
      expect(harness.requests).toHaveLength(0);
    }),
  );

  it.effect("validates the repository and current version before fetching", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => {
        throw new Error("must not fetch");
      });
      const operations = makeServiceUpdateSourceOperations(harness);
      const badRepository = yield* expectCheckError(operations, {
        repository: "owner",
        currentVersion: CURRENT_VERSION,
      });
      expect(badRepository.code).toBe("invalid-input");
      const badVersion = yield* expectCheckError(operations, {
        repository: REPOSITORY,
        currentVersion: "",
      });
      expect(badVersion.code).toBe("invalid-input");
      expect(harness.requests).toHaveLength(0);
    }),
  );

  it.effect(
    "fetches the canonical releases URL with the fixed policy and selects the newest f8y release",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness(() => textResponse(releasePayloadText));
        const operations = makeServiceUpdateSourceOperations(harness);
        const descriptor = yield* operations.check({
          repository: REPOSITORY,
          currentVersion: CURRENT_VERSION,
        });
        expect(harness.requests).toHaveLength(1);
        const request = harness.requests[0]!;
        expect(request.url).toBe(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`);
        expect(request.method).toBe("GET");
        expect(request.redirect).toBe("manual");
        expect(request.credentials).toBe("omit");
        expect(request.headers["authorization"]).toBeUndefined();
        expect(request.headers["cookie"]).toBeUndefined();
        expect(descriptor).not.toBeNull();
        expect(descriptor?.version).toBe(NEW_VERSION);
        expect(descriptor?.binaryUrl).toBe(canonicalAssetUrl());
      }),
  );

  it.effect("checks release metadata from a canonical plain version baseline", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => textResponse(releasePayloadText));
      const operations = makeServiceUpdateSourceOperations(harness);
      const descriptor = yield* operations.check({
        repository: REPOSITORY,
        currentVersion: "1.2.3",
      });

      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]?.url).toBe(
        `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`,
      );
      expect(descriptor?.version).toBe(NEW_VERSION);
    }),
  );

  it.effect("skips drafts and keeps prereleases eligible", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => textResponse(draftSkippedPayloadText));
      const operations = makeServiceUpdateSourceOperations(harness);
      const descriptor = yield* operations.check({
        repository: REPOSITORY,
        currentVersion: CURRENT_VERSION,
      });
      // The frozen release policy skips drafts only; prereleases stay eligible.
      expect(descriptor?.version).toBe("9.9.9-f8y.20260202.1");
    }),
  );

  it.effect("rejects a redirected metadata response", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const harness = makeHarness(
        () =>
          new Response(
            byteBody(
              (controller) => {
                controller.enqueue(new TextEncoder().encode("redirect-page"));
              },
              {
                pull: () => new Promise<void>(() => {}),
                cancel: () => (cancelled = true),
              },
            ),
            { status: 302, headers: { location: "https://evil.example.test/releases" } },
          ),
      );
      const operations = makeServiceUpdateSourceOperations(harness);
      const error = yield* expectCheckError(operations, {
        repository: REPOSITORY,
        currentVersion: CURRENT_VERSION,
      });
      expect(error.code).toBe("unavailable");
      yield* Effect.yieldNow;
      expect(cancelled).toBe(true);
      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]!.signal.aborted).toBe(true);
    }),
  );

  it.effect("closes a non-200 metadata body before returning", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const harness = makeHarness(
        () =>
          new Response(
            byteBody(
              (controller) => {
                controller.enqueue(new TextEncoder().encode("server-error"));
              },
              {
                pull: () => new Promise<void>(() => {}),
                cancel: () => (cancelled = true),
              },
            ),
            { status: 502 },
          ),
      );
      const operations = makeServiceUpdateSourceOperations(harness);
      const error = yield* expectCheckError(operations, {
        repository: REPOSITORY,
        currentVersion: CURRENT_VERSION,
      });
      expect(error.code).toBe("unavailable");
      yield* Effect.yieldNow;
      expect(cancelled).toBe(true);
      expect(harness.requests[0]!.signal.aborted).toBe(true);
    }),
  );

  it.effect("rejects malformed current versions with the frozen policy before any fetch", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => {
        throw new Error("must not fetch");
      });
      const operations = makeServiceUpdateSourceOperations(harness);
      for (const version of [
        "garbage",
        "1.2.3.0",
        "01.2.3",
        "01.2.3-f8y.20260101.1",
        "1.2.3-f8y.20260231.1",
        "1.2.3-f8y.20261301.1",
        "1.2.3-f8y.20260101.0",
        "1.2.3-f8y.20260101.2100000001",
        " 1.2.3-f8y.20260101.1",
      ]) {
        const error = yield* expectCheckError(operations, {
          repository: REPOSITORY,
          currentVersion: version,
        });
        expect(error.code).toBe("invalid-input");
      }
      expect(harness.requests).toHaveLength(0);
    }),
  );

  it.effect(
    "enforces the metadata byte budget on actual decoded bytes, ignoring a misleading content-length",
    () =>
      Effect.gen(function* () {
        const oversized = padToBytes(
          releasePayloadText,
          SERVICE_UPDATE_SOURCE_LIMITS.metadataMaxBytes + 1,
        );
        const harness = makeHarness(() => textResponse(oversized, { "content-length": "1" }));
        const operations = makeServiceUpdateSourceOperations(harness);
        const error = yield* expectCheckError(operations, {
          repository: REPOSITORY,
          currentVersion: CURRENT_VERSION,
        });
        expect(error.code).toBe("verification-failed");
      }),
  );

  it.effect("accepts metadata of exactly the byte budget", () =>
    Effect.gen(function* () {
      const exact = padToBytes(releasePayloadText, SERVICE_UPDATE_SOURCE_LIMITS.metadataMaxBytes);
      const harness = makeHarness(() => textResponse(exact));
      const operations = makeServiceUpdateSourceOperations(harness);
      const descriptor = yield* operations.check({
        repository: REPOSITORY,
        currentVersion: CURRENT_VERSION,
      });
      expect(descriptor?.version).toBe(NEW_VERSION);
    }),
  );

  it.effect("keeps the metadata request running one tick before the 30 second deadline", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => hangingResponse(() => {}));
      const operations = makeServiceUpdateSourceOperations(harness);
      const settled =
        yield* Deferred.make<
          Result.Result<ServiceUpdateReleaseDescriptor | null, ServiceUpdateOperationError>
        >();
      yield* operations.check({ repository: REPOSITORY, currentVersion: CURRENT_VERSION }).pipe(
        Effect.result,
        Effect.flatMap((outcome) => Deferred.succeed(settled, outcome)),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(29));
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust(Duration.seconds(1));
      const outcome = yield* Deferred.await(settled);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.code).toBe("timeout");
      }
    }),
  );

  it.effect("decodes invalid metadata JSON into an unavailable error", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => textResponse("{not-json"));
      const operations = makeServiceUpdateSourceOperations(harness);
      const error = yield* expectCheckError(operations, {
        repository: REPOSITORY,
        currentVersion: CURRENT_VERSION,
      });
      expect(error.code).toBe("unavailable");
    }),
  );
});

describe("serviceUpdateSource resolveTargetVersion", () => {
  it.effect("looks up the exact published F8Y tag without requiring a F8Y current version", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => textResponse(JSON.stringify(exactReleasePayload)));
      const operations = makeServiceUpdateSourceOperations(harness);
      const descriptor = yield* operations.resolveTargetVersion({
        repository: REPOSITORY,
        targetVersion: NEW_VERSION,
      });

      expect(harness.requests).toHaveLength(1);
      expect(harness.requests[0]?.url).toBe(
        `https://api.github.com/repos/${REPOSITORY}/releases/tags/${NEW_TAG}`,
      );
      expect(harness.requests[0]?.method).toBe("GET");
      expect(harness.requests[0]?.redirect).toBe("manual");
      expect(harness.requests[0]?.credentials).toBe("omit");
      expect(harness.requests[0]?.headers).not.toHaveProperty("authorization");
      expect(harness.requests[0]?.headers).not.toHaveProperty("cookie");
      expect(descriptor).toEqual({
        version: NEW_VERSION,
        tag: NEW_TAG,
        binaryName: BINARY_NAME,
        binaryUrl: canonicalAssetUrl(),
        checksumsUrl: canonicalAssetUrl(`${BINARY_NAME}.sha256`),
      });
    }),
  );

  it.effect("resolves an exact older request separately from the newer scheduled candidate", () =>
    Effect.gen(function* () {
      const newerVersion = "9.9.9-f8y.20261003.999";
      const newerBinary = `t3-${newerVersion}-linux-x64`;
      const newerTag = `v${newerVersion}`;
      const newerAssetUrl = (name: string) =>
        `https://github.com/${REPOSITORY}/releases/download/${newerTag}/${name}`;
      const newerRelease = {
        tag_name: newerTag,
        draft: false,
        prerelease: true,
        assets: [
          { name: newerBinary, browser_download_url: newerAssetUrl(newerBinary) },
          {
            name: `t3-${newerVersion}-linux-x64.sha256`,
            browser_download_url: newerAssetUrl(`t3-${newerVersion}-linux-x64.sha256`),
          },
        ],
      };
      const harness = makeHarness((request) =>
        request.url.endsWith(`/releases/tags/${NEW_TAG}`)
          ? textResponse(JSON.stringify(exactReleasePayload))
          : textResponse(JSON.stringify([newerRelease, exactReleasePayload])),
      );
      const operations = makeServiceUpdateSourceOperations(harness);
      const scheduled = yield* operations.check({
        repository: REPOSITORY,
        currentVersion: CURRENT_VERSION,
      });
      const manual = yield* operations.resolveTargetVersion({
        repository: REPOSITORY,
        targetVersion: NEW_VERSION,
      });

      expect(scheduled?.version).toBe(newerVersion);
      expect(manual.version).toBe(NEW_VERSION);
      expect(harness.requests.map((request) => request.url)).toEqual([
        `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`,
        `https://api.github.com/repos/${REPOSITORY}/releases/tags/${NEW_TAG}`,
      ]);
    }),
  );

  it.effect("refuses a tag mismatch instead of resolving a different available release", () =>
    Effect.gen(function* () {
      const otherVersion = "9.9.9-f8y.20260202.3";
      const otherBinary = `t3-${otherVersion}-linux-x64`;
      const harness = makeHarness(() =>
        textResponse(
          JSON.stringify({
            tag_name: `v${otherVersion}`,
            draft: false,
            prerelease: true,
            assets: [
              {
                name: otherBinary,
                browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v${otherVersion}/${otherBinary}`,
              },
              {
                name: `${otherBinary}.sha256`,
                browser_download_url: `https://github.com/${REPOSITORY}/releases/download/v${otherVersion}/${otherBinary}.sha256`,
              },
            ],
          }),
        ),
      );
      const operations = makeServiceUpdateSourceOperations(harness);
      const result = yield* Effect.result(
        operations.resolveTargetVersion({
          repository: REPOSITORY,
          targetVersion: NEW_VERSION,
        }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.code).toBe("unavailable");
      expect(harness.requests).toHaveLength(1);
    }),
  );

  it.effect("rejects malformed targets and missing releases with typed source errors", () =>
    Effect.gen(function* () {
      const invalidHarness = makeHarness(() => {
        throw new Error("must not fetch an invalid target");
      });
      const operations = makeServiceUpdateSourceOperations(invalidHarness);
      const invalid = yield* Effect.result(
        operations.resolveTargetVersion({ repository: REPOSITORY, targetVersion: "1.2.3" }),
      );
      expect(Result.isFailure(invalid)).toBe(true);
      if (Result.isFailure(invalid)) expect(invalid.failure.code).toBe("invalid-input");
      expect(invalidHarness.requests).toHaveLength(0);

      const missingHarness = makeHarness(() => new Response("not found", { status: 404 }));
      const missing = yield* Effect.result(
        makeServiceUpdateSourceOperations(missingHarness).resolveTargetVersion({
          repository: REPOSITORY,
          targetVersion: NEW_VERSION,
        }),
      );
      expect(Result.isFailure(missing)).toBe(true);
      if (Result.isFailure(missing)) expect(missing.failure.code).toBe("unavailable");
      expect(missingHarness.requests).toHaveLength(1);
      expect(missingHarness.requests[0]?.url).toBe(
        `https://api.github.com/repos/${REPOSITORY}/releases/tags/${NEW_TAG}`,
      );
    }),
  );
});

describe("serviceUpdateSource asset consumption", () => {
  const consume = (
    fetch: typeof globalThis.fetch,
    overrides?: Partial<Parameters<typeof consumeServiceUpdateAsset>[0]>,
  ) =>
    consumeServiceUpdateAsset({
      fetch,
      identity,
      kind: "binary",
      maxBytes: 16,
      timeout: Duration.seconds(5),
      onChunk: () => Effect.void,
      ...overrides,
    });

  it.effect("consumes an unredirected asset response byte-exactly without credentials", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => textResponse("0123456789abcdef"));
      const consumed = yield* consume(harness.fetch);
      expect(consumed).toBe(16);
      expect(harness.requests).toHaveLength(1);
      const request = harness.requests[0]!;
      expect(request.url).toBe(canonicalAssetUrl());
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("manual");
      expect(request.credentials).toBe("omit");
      expect(request.headers["authorization"]).toBeUndefined();
      expect(request.headers["cookie"]).toBeUndefined();
    }),
  );

  it.effect("fails one byte over the budget and aborts the request", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const harness = makeHarness(
        () =>
          new Response(
            byteBody(
              (controller) => {
                controller.enqueue(new TextEncoder().encode("0123456789abcdefg"));
              },
              { cancel: () => (cancelled = true) },
            ),
            { status: 200 },
          ),
      );
      const error = yield* consume(harness.fetch).pipe(Effect.flip);
      expect(error.code).toBe("verification-failed");
      yield* Effect.yieldNow;
      expect(cancelled).toBe(true);
      expect(harness.requests[0]!.signal.aborted).toBe(true);
    }),
  );

  it.effect("propagates consumer failure and aborts the request", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const consumerFailure = new ServiceUpdateOperationError({
        stage: "source",
        code: "io",
        cause: "consumer exploded",
      });
      const harness = makeHarness(
        () =>
          new Response(
            byteBody(
              (controller) => {
                controller.enqueue(new TextEncoder().encode("0123456789"));
              },
              { cancel: () => (cancelled = true) },
            ),
            { status: 200 },
          ),
      );
      const error = yield* consume(harness.fetch, {
        onChunk: () => Effect.fail(consumerFailure),
      }).pipe(Effect.flip);
      expect(error).toBe(consumerFailure);
      yield* Effect.yieldNow;
      expect(cancelled).toBe(true);
      expect(harness.requests[0]!.signal.aborted).toBe(true);
    }),
  );

  it.effect("aborts the request before returning on cancellation of an endless stream", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const harness = makeHarness(() => hangingResponse(() => (cancelled = true)));
      const fiber = yield* consume(harness.fetch).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(cancelled).toBe(true);
      expect(harness.requests[0]!.signal.aborted).toBe(true);
    }),
  );

  it.effect("keeps the download running one tick before the deadline, then times out", () =>
    Effect.gen(function* () {
      const harness = makeHarness(() => hangingResponse(() => {}));
      const settled = yield* Deferred.make<Result.Result<number, ServiceUpdateOperationError>>();
      yield* consume(harness.fetch).pipe(
        Effect.result,
        Effect.flatMap((outcome) => Deferred.succeed(settled, outcome)),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(4));
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust(Duration.seconds(1));
      const outcome = yield* Deferred.await(settled);
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.code).toBe("timeout");
      }
    }),
  );

  it.effect(
    "follows allowed GitHub-to-CDN redirects preserving the credential-free signed query and the fixed policy",
    () =>
      Effect.gen(function* () {
        const signedUrl =
          "https://release-assets.githubusercontent.com/github-production-release-asset/2e6541abc/asset?X-Amz-Signature=abc123&expires=1750000000";
        const responses = [
          () => redirectResponse(signedUrl),
          () => textResponse("0123456789abcdef"),
        ];
        const harness = makeHarness((_request, index) => responses[index]!());
        const consumed = yield* consume(harness.fetch);
        expect(consumed).toBe(16);
        expect(harness.requests).toHaveLength(2);
        for (const request of harness.requests) {
          expect(request.method).toBe("GET");
          expect(request.redirect).toBe("manual");
          expect(request.credentials).toBe("omit");
          expect(request.headers["authorization"]).toBeUndefined();
          expect(request.headers["cookie"]).toBeUndefined();
        }
        // The previous hop was explicitly aborted before the next fetch.
        expect(harness.requests[0]!.signal.aborted).toBe(true);
        // The allowed signed CDN query reaches the transport untouched.
        expect(harness.requests[1]!.url).toBe(signedUrl);
        const cdnUrl = new URL(harness.requests[1]!.url);
        expect(cdnUrl.pathname.startsWith("/github-production-release-asset/")).toBe(true);
        expect(cdnUrl.searchParams.get("X-Amz-Signature")).toBe("abc123");
      }),
  );

  it.effect("aborts a non-ending redirect response before following it", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const signedUrl =
        "https://release-assets.githubusercontent.com/github-production-release-asset/2e6541abc/asset?X-Amz-Signature=abc123";
      const harness = makeHarness((_request, index) => {
        if (index === 0) {
          // A redirect response whose nonempty body never ends must still be
          // closed before the next fetch — no body drain, no GC dependence.
          return new Response(
            byteBody(
              (controller) => {
                controller.enqueue(new TextEncoder().encode("partial"));
              },
              {
                pull: () => new Promise<void>(() => {}),
                cancel: () => (cancelled = true),
              },
            ),
            { status: 302, headers: { location: signedUrl } },
          );
        }
        // The previous hop's body was already closed before this second fetch.
        expect(cancelled).toBe(true);
        return textResponse("0123456789abcdef");
      });
      const consumed = yield* consume(harness.fetch);
      expect(consumed).toBe(16);
      expect(cancelled).toBe(true);
      expect(harness.requests[0]!.signal.aborted).toBe(true);
    }),
  );

  it.effect("aborts a non-200 response body before returning and reports unavailable", () =>
    Effect.gen(function* () {
      let cancelled = false;
      const harness = makeHarness(
        () =>
          new Response(
            byteBody(
              (controller) => {
                controller.enqueue(new TextEncoder().encode("error-page"));
              },
              {
                pull: () => new Promise<void>(() => {}),
                cancel: () => (cancelled = true),
              },
            ),
            { status: 500 },
          ),
      );
      const error = yield* consume(harness.fetch).pipe(Effect.flip);
      expect(error.code).toBe("unavailable");
      yield* Effect.yieldNow;
      expect(cancelled).toBe(true);
      expect(harness.requests[0]!.signal.aborted).toBe(true);
    }),
  );

  it.effect("sanitizes a CDN transport failure to a bounded cause with no URL or signature", () =>
    Effect.gen(function* () {
      const signedUrl =
        "https://release-assets.githubusercontent.com/github-production-release-asset/2e6541abc/asset?X-Amz-Signature=abc123";
      const harness = makeHarness((_request, index) => {
        if (index === 1) {
          const failure = Promise.reject(new Error(`boom for ${signedUrl}`));
          return failure as unknown as Response;
        }
        return redirectResponse(signedUrl);
      });
      const error = yield* consume(harness.fetch).pipe(Effect.flip);
      expect(error.code).toBe("io");
      const leaked = `${String(error.message)} ${String(error.cause)}`.includes("Signature");
      expect(leaked).toBe(false);
      expect(error.cause).toBe("transport-error");
      const chain = causeChainText(error);
      expect(chain).not.toContain("https://");
      expect(chain).not.toContain("Signature");
      expect(chain).not.toContain("release-assets");
    }),
  );

  it.effect("sanitizes a CDN body read failure to a bounded cause with no URL or signature", () =>
    Effect.gen(function* () {
      const signedUrl =
        "https://release-assets.githubusercontent.com/github-production-release-asset/2e6541abc/asset?X-Amz-Signature=abc123";
      const harness = makeHarness((_request, index) => {
        if (index === 1) {
          return new Response(
            byteBody((controller) => {
              controller.enqueue(new TextEncoder().encode("012345"));
              controller.error(new Error(`stream broke for ${signedUrl}`));
            }),
            { status: 200 },
          );
        }
        return redirectResponse(signedUrl);
      });
      const error = yield* consume(harness.fetch).pipe(Effect.flip);
      expect(error.code).toBe("io");
      const leaked = `${String(error.message)} ${String(error.cause)}`.includes("Signature");
      expect(leaked).toBe(false);
      expect(error.cause).toBe("body-read-error");
      const chain = causeChainText(error);
      expect(chain).not.toContain("https://");
      expect(chain).not.toContain("Signature");
      expect(chain).not.toContain("release-assets");
    }),
  );

  it.effect("rejects disallowed redirect targets before fetching them", () =>
    Effect.gen(function* () {
      const badLocations = [
        "https://evil.example.test/asset",
        `https://github.com/owner/repo/releases/download/${NEW_TAG}/${BINARY_NAME}?X-Amz-Signature=abc123`,
        "https://github.com/other/repo/releases/download/v1.0.0/x",
        `https://github.com/owner/repo/releases/download/${NEW_TAG}/elsewhere`,
        `http://github.com/owner/repo/releases/download/${NEW_TAG}/${BINARY_NAME}`,
        "https://release-assets.example.com/github-production-release-asset/asset?s=1",
      ];
      for (const location of badLocations) {
        const harness = makeHarness(() => redirectResponse(location));
        const error = yield* consume(harness.fetch).pipe(Effect.flip);
        expect(error.code).toBe("unavailable");
        expect(harness.requests).toHaveLength(1);
      }
    }),
  );

  it.effect(
    "rejects a redirect location carrying credentials or a fragment after only the initial request",
    () =>
      Effect.gen(function* () {
        const credentialedCdn =
          "https://user:pass@release-assets.githubusercontent.com/github-production-release-asset/2e6541abc/asset?X-Amz-Signature=abc123";
        const fragmentCdn =
          "https://release-assets.githubusercontent.com/github-production-release-asset/2e6541abc/asset?X-Amz-Signature=abc123#frag";
        const credentialedGitHub = new URL(canonicalAssetUrl());
        credentialedGitHub.username = "user";
        credentialedGitHub.password = "pass";
        const fragmentGitHub = `${canonicalAssetUrl()}#fragment`;

        for (const location of [
          credentialedCdn,
          fragmentCdn,
          credentialedGitHub.toString(),
          fragmentGitHub,
        ]) {
          const harness = makeHarness(() => redirectResponse(location));
          const error = yield* consume(harness.fetch).pipe(Effect.flip);
          expect(error.code).toBe("unavailable");
          // Only the initial request ran; the rejected destination was never
          // fetched.
          expect(harness.requests).toHaveLength(1);
        }
      }),
  );

  it.effect("rejects the fourth consecutive redirect", () =>
    Effect.gen(function* () {
      const cdnHop = (n: number): Response =>
        redirectResponse(
          `https://release-assets.githubusercontent.com/github-production-release-asset/hop${n}?s=1`,
        );
      const harness = makeHarness((_request, index) => cdnHop(index));
      const error = yield* consume(harness.fetch).pipe(Effect.flip);
      expect(error.code).toBe("unavailable");
      expect(harness.requests).toHaveLength(SERVICE_UPDATE_SOURCE_LIMITS.maxRedirectHops + 1);
    }),
  );

  describe("hard kind limits", () => {
    const kib = 1024;
    const mib = 1024 * 1024;

    /** Consume with NO byte/time overrides, so the kind's hard limits apply. */
    const consumeHard = (fetch: typeof globalThis.fetch, kind: ServiceUpdateAssetKind) =>
      consumeServiceUpdateAsset({ fetch, identity, kind, onChunk: () => Effect.void });

    /** Pull-based stream emitting `chunkCount` copies of `chunk`, then closing. */
    const streamingBody = (chunk: Uint8Array, chunkCount: number, extra?: Uint8Array): ByteBody => {
      let emitted = 0;
      return new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (emitted < chunkCount) {
            emitted += 1;
            controller.enqueue(chunk);
            return;
          }
          if (extra !== undefined) {
            controller.enqueue(extra);
          }
          controller.close();
        },
      }) as unknown as ByteBody;
    };

    it.effect("accepts exactly the checksums hard byte budget", () =>
      Effect.gen(function* () {
        const harness = makeHarness(() => textResponse("a".repeat(128 * kib)));
        const consumed = yield* consumeHard(harness.fetch, "checksums");
        expect(consumed).toBe(128 * kib);
        expect(harness.requests).toHaveLength(1);
      }),
    );

    it.effect("rejects one byte over the checksums hard byte budget", () =>
      Effect.gen(function* () {
        const harness = makeHarness(() => textResponse("a".repeat(128 * kib + 1)));
        const error = yield* consumeHard(harness.fetch, "checksums").pipe(Effect.flip);
        expect(error.code).toBe("verification-failed");
        expect(harness.requests[0]!.signal.aborted).toBe(true);
      }),
    );

    it.effect("accepts exactly the binary hard byte budget", () =>
      Effect.gen(function* () {
        const harness = makeHarness(
          () => new Response(streamingBody(new Uint8Array(mib), 512), { status: 200 }),
        );
        const consumed = yield* consumeHard(harness.fetch, "binary");
        expect(consumed).toBe(512 * mib);
      }),
    );

    it.effect("rejects one byte over the binary hard byte budget", () =>
      Effect.gen(function* () {
        const harness = makeHarness(
          () =>
            new Response(streamingBody(new Uint8Array(mib), 512, new Uint8Array(1)), {
              status: 200,
            }),
        );
        const error = yield* consumeHard(harness.fetch, "binary").pipe(Effect.flip);
        expect(error.code).toBe("verification-failed");
        expect(harness.requests[0]!.signal.aborted).toBe(true);
      }),
    );

    it.effect("enforces the checksums hard deadline without an override", () =>
      Effect.gen(function* () {
        const harness = makeHarness(() => hangingResponse(() => {}));
        const settled = yield* Deferred.make<Result.Result<number, ServiceUpdateOperationError>>();
        yield* consumeHard(harness.fetch, "checksums").pipe(
          Effect.result,
          Effect.flatMap((outcome) => Deferred.succeed(settled, outcome)),
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(29));
        expect(yield* Deferred.isDone(settled)).toBe(false);
        yield* TestClock.adjust(Duration.seconds(1));
        const outcome = yield* Deferred.await(settled);
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) expect(outcome.failure.code).toBe("timeout");
      }),
    );

    it.effect("enforces the binary hard deadline without an override", () =>
      Effect.gen(function* () {
        const harness = makeHarness(() => hangingResponse(() => {}));
        const settled = yield* Deferred.make<Result.Result<number, ServiceUpdateOperationError>>();
        yield* consumeHard(harness.fetch, "binary").pipe(
          Effect.result,
          Effect.flatMap((outcome) => Deferred.succeed(settled, outcome)),
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.minutes(9));
        expect(yield* Deferred.isDone(settled)).toBe(false);
        yield* TestClock.adjust(Duration.minutes(1));
        const outcome = yield* Deferred.await(settled);
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) expect(outcome.failure.code).toBe("timeout");
      }),
    );

    it.effect("lets overrides tighten the hard limits but never loosen them", () =>
      Effect.gen(function* () {
        // A tighter byte budget fails at its own boundary.
        const tightBytes = makeHarness(() => textResponse("012345678"));
        const byteError = yield* consume(tightBytes.fetch, { maxBytes: 8 }).pipe(Effect.flip);
        expect(byteError.code).toBe("verification-failed");

        // A tighter deadline fires at its own boundary, not the 10 minute cap.
        const tightTime = makeHarness(() => hangingResponse(() => {}));
        const settled = yield* Deferred.make<Result.Result<number, ServiceUpdateOperationError>>();
        yield* consume(tightTime.fetch, { timeout: Duration.seconds(1) }).pipe(
          Effect.result,
          Effect.flatMap((outcome) => Deferred.succeed(settled, outcome)),
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(1));
        const outcome = yield* Deferred.await(settled);
        expect(Result.isFailure(outcome)).toBe(true);
        if (Result.isFailure(outcome)) expect(outcome.failure.code).toBe("timeout");

        // An oversized override is clamped to the kind's hard limit.
        const loosened = makeHarness(() => textResponse("a".repeat(128 * kib + 1)));
        const clampError = yield* consume(loosened.fetch, {
          kind: "checksums",
          maxBytes: Number.MAX_SAFE_INTEGER,
        }).pipe(Effect.flip);
        expect(clampError.code).toBe("verification-failed");
      }),
    );

    it.effect("rejects zero, negative, and non-finite budgets before any request", () =>
      Effect.gen(function* () {
        for (const maxBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          const harness = makeHarness(() => {
            throw new Error("must not fetch");
          });
          const error = yield* consume(harness.fetch, { maxBytes }).pipe(Effect.flip);
          expect(error.code).toBe("invalid-input");
          expect(harness.requests).toHaveLength(0);
        }
        for (const timeout of [Duration.zero, Duration.millis(-1), Duration.infinity]) {
          const harness = makeHarness(() => {
            throw new Error("must not fetch");
          });
          const error = yield* consume(harness.fetch, { timeout }).pipe(Effect.flip);
          expect(error.code).toBe("invalid-input");
          expect(harness.requests).toHaveLength(0);
        }
      }),
    );
  });
});
