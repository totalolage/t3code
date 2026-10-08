// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ServiceUpdateAttemptId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import type { ServiceUpdateReleaseDescriptor } from "./serviceUpdateRelease.ts";
import { SERVICE_UPDATE_SOURCE_LIMITS } from "./serviceUpdateSource.ts";
import {
  cleanupAbandonedServiceUpdateStaging,
  makeServiceUpdateSource,
  STAGED_ARTIFACT_FILENAME,
} from "./serviceUpdateSourceLive.ts";
import {
  ServiceUpdateOperationError,
  type ServiceUpdateProgress,
  type StagedServiceRuntime,
} from "./serviceUpdateServices.ts";

const attemptId = ServiceUpdateAttemptId.make("11111111-1111-4111-8111-111111111111");
const VERSION = "1.2.4-f8y.20260101.2";
const TAG = `v${VERSION}`;
const BINARY_NAME = `t3-${VERSION}-linux-x64`;
const OWNER = "owner";
const REPO = "repo";

const BINARY_TEXT = "t3-runtime-artifact-bytes";
const BINARY_BYTES = new TextEncoder().encode(BINARY_TEXT);
const BINARY_DIGEST = NodeCrypto.createHash("sha256").update(BINARY_BYTES).digest("hex");
const CHECKSUM_TEXT = `${BINARY_DIGEST}\n`;
const CHECKSUM_ASSET_NAME = `${BINARY_NAME}.sha256`;

const assetUrl = (assetName: string): string =>
  `https://github.com/${OWNER}/${REPO}/releases/download/${TAG}/${assetName}`;

const candidate: ServiceUpdateReleaseDescriptor = {
  version: VERSION,
  tag: TAG,
  binaryName: BINARY_NAME,
  binaryUrl: assetUrl(BINARY_NAME),
  checksumsUrl: assetUrl(CHECKSUM_ASSET_NAME),
};

interface CapturedRequest {
  readonly url: string;
  readonly credentials: string | undefined;
  readonly redirect: string | undefined;
}

interface Harness {
  readonly requests: Array<CapturedRequest>;
  readonly fetch: typeof globalThis.fetch;
}

const makeHarness = (respond: (request: CapturedRequest) => Response): Harness => {
  const requests: Array<CapturedRequest> = [];
  const fetch = ((_url: string | URL, init?: Record<string, unknown>) => {
    const request: CapturedRequest = {
      url: String(_url),
      credentials: init?.credentials as string | undefined,
      redirect: init?.redirect as string | undefined,
    };
    requests.push(request);
    const response = respond(request);
    const signal = init?.signal as AbortSignal | undefined;
    signal?.addEventListener("abort", () => {
      try {
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
  setup: (controller: { enqueue: (chunk: Uint8Array) => void; close: () => void }) => void,
  hooks: { pull?: () => Promise<void>; cancel?: () => void } = {},
): ByteBody => {
  const source: {
    start: (controller: { enqueue: (chunk: Uint8Array) => void; close: () => void }) => void;
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

const textResponse = (text: string): Response =>
  new Response(
    byteBody((controller) => {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }),
    { status: 200 },
  );

const bytesResponse = (bytes: Uint8Array): Response =>
  new Response(
    byteBody((controller) => {
      controller.enqueue(bytes);
      controller.close();
    }),
    { status: 200 },
  );

const hangingResponse = (onCancel: () => void): Response =>
  new Response(
    byteBody(() => {}, { pull: () => new Promise<void>(() => {}), cancel: onCancel }),
    {
      status: 200,
    },
  );

/**
 * Flattens an error's entire `cause` chain into one string, so leak
 * assertions cover the whole chain, not just the top.
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

const padToBytes = (payload: string, totalBytes: number): string =>
  payload + " ".repeat(Math.max(0, totalBytes - payload.length));

const sourceOf = (harness: Harness, baseDir: string) =>
  makeServiceUpdateSource({ fetch: harness.fetch, baseDir });

const stageOf = (
  harness: Harness,
  baseDir: string,
  progress: Array<ServiceUpdateProgress>,
  descriptor: ServiceUpdateReleaseDescriptor = candidate,
) =>
  sourceOf(harness, baseDir).stage({ attemptId, candidate: descriptor }, (step) =>
    Effect.sync(() => {
      progress.push(step);
    }),
  );

const stageErrorOf = (
  harness: Harness,
  baseDir: string,
  progress: Array<ServiceUpdateProgress>,
  descriptor: ServiceUpdateReleaseDescriptor = candidate,
): Effect.Effect<ServiceUpdateOperationError> =>
  stageOf(harness, baseDir, progress, descriptor).pipe(
    Effect.flatMap(() => Effect.die(new Error("expected a stage failure"))),
    Effect.flip,
  );

const expectStageError = (
  error: ServiceUpdateOperationError,
  code: ServiceUpdateOperationError["code"],
): ServiceUpdateOperationError => {
  expect(error).toBeInstanceOf(ServiceUpdateOperationError);
  expect(error.stage).toBe("source");
  expect(error.code).toBe(code);
  return error;
};

it.effect("stages checksums + binary, verifies the digest, and publishes immutably", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-live-"));
    const progress: Array<ServiceUpdateProgress> = [];
    const harness = makeHarness((request) =>
      request.url.endsWith(`/${CHECKSUM_ASSET_NAME}`)
        ? textResponse(CHECKSUM_TEXT)
        : bytesResponse(BINARY_BYTES),
    );
    try {
      const staged = yield* stageOf(harness, baseDir, progress);
      assert.equal(staged.format, 1);
      assert.equal(staged.attemptId, attemptId);
      assert.equal(staged.version, VERSION);
      assert.equal(staged.platform, "linux-x64");
      assert.equal(staged.sha256, BINARY_DIGEST);
      assert.equal(staged.bytes, BINARY_BYTES.byteLength);
      assert.equal(
        staged.stagingDirectory,
        NodePath.join(baseDir, "runtime", "service-update-staging", attemptId),
      );

      const artifactPath = NodePath.join(staged.stagingDirectory, STAGED_ARTIFACT_FILENAME);
      assert.equal(NodeFS.readFileSync(artifactPath, "utf8"), BINARY_TEXT);
      // Immutable staging: the published artifact is read-only.
      assert.equal(NodeFS.statSync(artifactPath).mode & 0o777, 0o444);
      // The work-in-progress staging dir was rename-published away.
      assert.isFalse(
        NodeFS.existsSync(
          NodePath.join(baseDir, "runtime", "service-update-staging", `.staging-${attemptId}`),
        ),
      );

      // Fixed transport policy on both asset fetches.
      for (const request of harness.requests) {
        assert.equal(request.credentials, "omit");
        assert.equal(request.redirect, "manual");
      }

      // Progress is monotonic and lands on the real consumed byte count.
      assert.isAbove(progress.length, 0);
      let previous = 0;
      for (const step of progress) {
        assert.isAtLeast(step.downloadedBytes, previous);
        assert.isNull(step.totalBytes);
        previous = step.downloadedBytes;
      }
      assert.equal(previous, BINARY_BYTES.byteLength);
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.effect("fails verification when the consumed bytes do not match the sidecar", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-live-"));
    const progress: Array<ServiceUpdateProgress> = [];
    const flipped = NodeCrypto.createHash("sha256")
      .update(Buffer.from(`${BINARY_TEXT}!`))
      .digest("hex");
    const harness = makeHarness((request) =>
      request.url.endsWith(`/${CHECKSUM_ASSET_NAME}`)
        ? textResponse(`${flipped}\n`)
        : bytesResponse(BINARY_BYTES),
    );
    try {
      const error = yield* stageErrorOf(harness, baseDir, progress);
      expectStageError(error, "verification-failed");
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(baseDir, "runtime", "service-update-staging", attemptId)),
      );
      assert.isFalse(
        NodeFS.existsSync(
          NodePath.join(baseDir, "runtime", "service-update-staging", `.staging-${attemptId}`),
        ),
      );
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.effect("bounds a byte-budget overrun with no URL leak", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-live-"));
    const progress: Array<ServiceUpdateProgress> = [];
    const oversized = padToBytes(CHECKSUM_TEXT, SERVICE_UPDATE_SOURCE_LIMITS.checksumsMaxBytes + 1);
    const harness = makeHarness((request) =>
      request.url.endsWith(`/${CHECKSUM_ASSET_NAME}`)
        ? textResponse(oversized)
        : bytesResponse(BINARY_BYTES),
    );
    try {
      const error = yield* stageErrorOf(harness, baseDir, progress);
      expectStageError(error, "verification-failed");
      const chain = causeChainText(error);
      assert.isFalse(chain.includes("github.com"));
      assert.isFalse(chain.includes("http://"));
      assert.isFalse(chain.includes("https://"));
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.effect("bounds a deadline overrun with no URL leak", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-live-"));
    const progress: Array<ServiceUpdateProgress> = [];
    const harness = makeHarness((request) =>
      request.url.endsWith(`/${CHECKSUM_ASSET_NAME}`)
        ? textResponse(CHECKSUM_TEXT)
        : hangingResponse(() => {}),
    );
    try {
      const settled = yield* Deferred.make<StagedServiceRuntime | ServiceUpdateOperationError>();
      yield* stageOf(harness, baseDir, progress).pipe(
        Effect.result,
        Effect.flatMap((outcome) =>
          Deferred.succeed(settled, Result.isSuccess(outcome) ? outcome.success : outcome.failure),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.minutes(9));
      expect(yield* Deferred.isDone(settled)).toBe(false);
      yield* TestClock.adjust(Duration.minutes(1));
      const outcome = yield* Deferred.await(settled);
      if (!(outcome instanceof ServiceUpdateOperationError)) {
        return yield* Effect.die(new Error("expected a stage failure"));
      }
      const error = expectStageError(outcome, "timeout");
      const chain = causeChainText(error);
      assert.isFalse(chain.includes("github.com"));
      assert.isFalse(chain.includes("https://"));
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.effect("discard removes the published staging directory", () =>
  Effect.gen(function* () {
    const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-live-"));
    const progress: Array<ServiceUpdateProgress> = [];
    const harness = makeHarness((request) =>
      request.url.endsWith(`/${CHECKSUM_ASSET_NAME}`)
        ? textResponse(CHECKSUM_TEXT)
        : bytesResponse(BINARY_BYTES),
    );
    try {
      const staged = yield* stageOf(harness, baseDir, progress);
      assert.isTrue(NodeFS.existsSync(staged.stagingDirectory));
      yield* sourceOf(harness, baseDir).discard(staged);
      assert.isFalse(NodeFS.existsSync(staged.stagingDirectory));
    } finally {
      NodeFS.rmSync(baseDir, { recursive: true, force: true });
    }
  }),
);

it.effect("startup cleanup removes abandoned source stages without touching runtimes", () => {
  const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-live-cleanup-"));
  const stagingParent = NodePath.join(baseDir, "runtime", "service-update-staging");
  const abandonedPublished = NodePath.join(stagingParent, attemptId);
  const abandonedWip = NodePath.join(stagingParent, `.staging-${attemptId}`);
  const unrecognized = NodePath.join(stagingParent, "not-an-attempt");
  const unrecognizedAttempt = NodePath.join(stagingParent, "22222222-2222-4222-8222-222222222222");
  const adoptedRuntime = NodePath.join(baseDir, "runtime", "versions", VERSION);
  NodeFS.mkdirSync(abandonedPublished, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(abandonedPublished, STAGED_ARTIFACT_FILENAME), BINARY_BYTES);
  NodeFS.mkdirSync(abandonedWip, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(abandonedWip, STAGED_ARTIFACT_FILENAME), BINARY_BYTES);
  NodeFS.mkdirSync(unrecognized, { recursive: true });
  NodeFS.mkdirSync(unrecognizedAttempt, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(unrecognizedAttempt, "foreign-data"), "leave intact");
  NodeFS.mkdirSync(adoptedRuntime, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(adoptedRuntime, ".install-complete"), VERSION);

  return cleanupAbandonedServiceUpdateStaging(baseDir).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        assert.isFalse(NodeFS.existsSync(abandonedPublished));
        assert.isFalse(NodeFS.existsSync(abandonedWip));
        assert.isTrue(NodeFS.existsSync(unrecognized));
        assert.isTrue(NodeFS.existsSync(unrecognizedAttempt));
        assert.isTrue(NodeFS.existsSync(adoptedRuntime));
        assert.isTrue(NodeFS.existsSync(NodePath.join(adoptedRuntime, ".install-complete")));
      }),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }))),
  );
});
