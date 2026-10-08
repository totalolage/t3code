import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import {
  ServiceUpdateReleaseError,
  isServiceUpdateTargetVersion,
  resolveServiceUpdateReleaseByVersion,
  selectServiceUpdateRelease,
  type ServiceUpdateReleaseDescriptor,
} from "./serviceUpdateRelease.ts";
import { ServiceUpdateOperationError } from "./serviceUpdateServices.ts";

/**
 * Bounded metadata lookup and asset consumption for native service updates.
 * `check` retains the scheduled newest-release policy; `resolveTargetVersion`
 * resolves one exact F8Y tag for a manual request. The live source binding owns
 * staging and per-binary checksum sidecar verification.
 *
 * Transport: the injectable `fetch` is captured at the lowest boundary — the
 * same injection point the installed FetchHttpClient's `Fetch` reference uses —
 * and driven with one fixed policy for every request: GET, `redirect: manual`,
 * `credentials: omit`. No caller-supplied HttpClient can introduce redirect
 * following, default headers, or cookies. Each request owns an AbortController
 * whose abort runs in an `Effect.ensuring` finalizer spanning the fetch and its
 * full body consumption, so every branch (redirect hop, non-200, consumer
 * failure, over-budget, timeout, interruption, success) closes the request
 * explicitly before the next fetch or return. Errors carry bounded causes only;
 * request URLs and signed queries never reach an error message or cause.
 */

export const SERVICE_UPDATE_SOURCE_LIMITS = Object.freeze({
  metadataMaxBytes: 2 * 1024 * 1024,
  metadataTimeout: Duration.seconds(30),
  checksumsMaxBytes: 128 * 1024,
  checksumsTimeout: Duration.seconds(30),
  binaryMaxBytes: 512 * 1024 * 1024,
  binaryTimeout: Duration.minutes(10),
  maxRedirectHops: 3,
});

const RELEASES_ACCEPT = "application/vnd.github+json";
const ASSET_ACCEPT = "application/octet-stream";
const RELEASE_ASSET_CDN_HOSTNAME = "release-assets.githubusercontent.com";
const RELEASE_ASSET_CDN_PATH_PREFIX = "/github-production-release-asset/";

/** Fixed fetch policy for every request this source makes. */
const REQUEST_INIT = {
  method: "GET",
  redirect: "manual",
  credentials: "omit",
  cache: "no-store",
} as const;

/** Bounded transport/body cause labels; raw causes never survive. */
const CAUSE_TRANSPORT = "transport-error";
const CAUSE_BODY = "body-read-error";

type SourceCode = "invalid-input" | "unavailable" | "io" | "verification-failed" | "timeout";

const makeSourceError = (input: {
  readonly code: SourceCode;
  readonly message: string;
  readonly cause?: unknown;
}): ServiceUpdateOperationError =>
  new ServiceUpdateOperationError({
    stage: "source",
    code: input.code,
    cause: input.cause === undefined ? input.message : input.cause,
  });

const failSource = (
  code: SourceCode,
  message: string,
  cause?: unknown,
): Effect.Effect<never, ServiceUpdateOperationError> =>
  Effect.fail(makeSourceError({ code, message, cause }));

const parseJsonText = (text: string): unknown => JSON.parse(text) as unknown;

interface ParsedRepository {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Same owner/repo rules as the frozen release policy: an empty repository
 * disables the source (`null`), anything else must be exact `owner/repo`.
 */
const parseRepository = (value: unknown): ParsedRepository | null | ServiceUpdateOperationError => {
  if (typeof value !== "string") {
    return makeSourceError({
      code: "invalid-input",
      message: "The configured GitHub repository must be owner/repo.",
    });
  }
  if (value === "") return null;

  const segments = value.split("/");
  const owner = segments[0];
  const repo = segments[1];
  if (
    segments.length !== 2 ||
    owner === undefined ||
    repo === undefined ||
    owner === "" ||
    repo === "" ||
    owner === "." ||
    owner === ".." ||
    repo === "." ||
    repo === ".." ||
    !/^[A-Za-z0-9_.-]+$/u.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(repo)
  ) {
    return makeSourceError({
      code: "invalid-input",
      message: "The configured GitHub repository must be exact owner/repo.",
    });
  }
  return { owner, repo };
};

const parseCurrentVersion = (value: unknown): ServiceUpdateOperationError | null => {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return makeSourceError({
      code: "invalid-input",
      message: "The current version must be a non-empty trimmed string.",
    });
  }
  return null;
};

/** Maps a frozen-policy selection failure to a bounded source error. */
const mapSelectionCause = (cause: unknown): ServiceUpdateOperationError =>
  cause instanceof ServiceUpdateReleaseError
    ? makeSourceError({
        code:
          cause.code === "invalid-repository" ||
          cause.code === "invalid-current-version" ||
          cause.code === "invalid-target-version"
            ? "invalid-input"
            : "unavailable",
        message: cause.message,
        cause,
      })
    : makeSourceError({
        code: "unavailable",
        message: "The release metadata could not be evaluated.",
        cause,
      });

/**
 * Runs the frozen policy's current-version validation with an empty release
 * list, which performs no I/O. It accepts canonical plain cores and F8Y
 * baselines; F8Y dates and run numbers keep their additional validation. Call
 * this BEFORE any HTTP execution so malformed versions fail with `invalid-input`
 * and zero requests.
 */
const validateCurrentVersionWithoutFetch = (input: {
  readonly repository: string;
  readonly currentVersion: string;
}): Effect.Effect<void, ServiceUpdateOperationError> =>
  Effect.try({
    try: () => {
      selectServiceUpdateRelease({
        repository: input.repository,
        currentVersion: input.currentVersion,
        platform: "linux",
        architecture: "x64",
        releases: [],
      });
    },
    catch: mapSelectionCause,
  });

const assetPath = (identity: ServiceUpdateAssetIdentity): string =>
  [identity.owner, identity.repo, "releases", "download", identity.tag, identity.assetName]
    .map((segment) => encodeURIComponent(segment))
    .reduce((path, segment) => `${path}/${segment}`, "");

export interface ServiceUpdateAssetIdentity {
  readonly owner: string;
  readonly repo: string;
  readonly tag: string;
  readonly assetName: string;
}

/**
 * Validate a URL BEFORE it is fetched. Only the configured repo's own GitHub
 * download URLs and the GitHub release-asset CDN are allowed. Any other host,
 * scheme, or port is rejected. URLs carrying credentials or a fragment fail
 * with a typed error before the transport sees the destination — they are never
 * normalized into an allowed URL. A query is only allowed on the CDN (its
 * signed query must be preserved untouched). Error messages never contain the
 * URL, so signed CDN queries cannot leak through errors.
 */
const validateAssetUrl = (location: string, identity: ServiceUpdateAssetIdentity): string => {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw makeSourceError({
      code: "unavailable",
      message: "The release asset redirected to an invalid location.",
    });
  }

  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw makeSourceError({
      code: "unavailable",
      message:
        "The release asset URL must not carry credentials or a fragment; it was rejected before any request.",
    });
  }

  const isGitHub =
    url.protocol === "https:" &&
    url.hostname === "github.com" &&
    url.port === "" &&
    url.pathname === assetPath(identity);
  const isCdn =
    url.protocol === "https:" &&
    url.hostname === RELEASE_ASSET_CDN_HOSTNAME &&
    url.port === "" &&
    url.pathname.startsWith(RELEASE_ASSET_CDN_PATH_PREFIX);

  if (isGitHub && url.search === "") {
    return url.toString();
  }
  if (isCdn) {
    return url.toString();
  }

  throw makeSourceError({
    code: "unavailable",
    message: "The release asset redirected to a host outside the allowed release targets.",
  });
};

const isRedirectStatus = (status: number): boolean => status >= 300 && status < 400;

export interface ServiceUpdateChunkConsumer {
  (chunk: Uint8Array): Effect.Effect<void, ServiceUpdateOperationError>;
}

/** Per-hop outcome: either the validated redirect target or consumed bytes. */
type HopOutcome =
  | { readonly _tag: "redirect"; readonly nextUrl: string }
  | { readonly _tag: "done"; readonly bytes: number };

/**
 * Consume one response body through its reader under the hop's abort scope.
 * The byte budget is enforced against the actually consumed decoded bytes —
 * never `content-length` — and the body is never buffered beyond the current
 * chunk (metadata reassembles text only after the budget check).
 */
const bodyReadError = (): ServiceUpdateOperationError =>
  makeSourceError({
    code: "io",
    message: "The response body could not be read.",
    cause: CAUSE_BODY,
  });

const abortSentinel = makeSourceError({
  code: "io",
  message: "The release request was aborted.",
  cause: "aborted",
});

/** Fails as soon as the request's abort signal fires. */
const abortAwaiter = (signal: AbortSignal): Effect.Effect<never, ServiceUpdateOperationError> =>
  Effect.callback((callback) => {
    const onAbort = () => callback(Effect.fail(abortSentinel));
    if (signal.aborted) {
      onAbort();
      return undefined;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

/**
 * Consume one response body under the hop's abort scope. Each read races the
 * request's abort signal, so a deadline, interruption, or any other abort cuts
 * off a stalled body immediately; the reader is also cancelled explicitly on
 * every exit. The byte budget is enforced against the actually consumed decoded
 * bytes — never `content-length` — and the body is never buffered beyond the
 * current chunk.
 */
const consumeBody = (
  body: NonNullable<Response["body"]>,
  signal: AbortSignal,
  maxBytes: number,
  onChunk: ServiceUpdateChunkConsumer,
): Effect.Effect<number, ServiceUpdateOperationError> =>
  Effect.suspend(() => {
    const reader = body.getReader();
    return Effect.gen(function* () {
      let consumedBytes = 0;
      for (;;) {
        const result = yield* Effect.raceFirst(
          Effect.tryPromise({ try: () => reader.read(), catch: bodyReadError }),
          abortAwaiter(signal),
        );
        if (result.done) break;
        const chunk = result.value;
        consumedBytes += chunk.byteLength;
        if (consumedBytes > maxBytes) {
          return yield* failSource(
            "verification-failed",
            "The release response exceeded its decoded byte budget.",
          );
        }
        yield* onChunk(chunk);
      }
      return consumedBytes;
    }).pipe(
      // Explicit teardown on every exit (failure, interruption, completion).
      Effect.ensuring(
        Effect.sync(() => {
          void reader.cancel().catch(() => {});
        }),
      ),
    );
  });

/**
 * One controlled GET: fixed policy, its own AbortController, and an
 * `Effect.ensuring` finalizer that aborts on every exit — redirect, error,
 * completion, timeout, or interruption — before the caller continues.
 */
const controlledGet = <A>(
  input: {
    readonly fetch: typeof globalThis.fetch;
    readonly url: string;
    readonly accept: string;
  },
  use: (response: Response, signal: AbortSignal) => Effect.Effect<A, ServiceUpdateOperationError>,
): Effect.Effect<A, ServiceUpdateOperationError> =>
  Effect.suspend(() => {
    const controller = new AbortController();
    return Effect.tryPromise({
      try: () =>
        input.fetch(input.url, {
          ...REQUEST_INIT,
          headers: { accept: input.accept },
          signal: controller.signal,
        }),
      catch: () =>
        makeSourceError({
          code: "io",
          message: "The release request failed.",
          cause: CAUSE_TRANSPORT,
        }),
    }).pipe(
      Effect.flatMap((response) => use(response, controller.signal)),
      Effect.ensuring(Effect.sync(() => controller.abort())),
    );
  });

const fetchReleaseMetadata = (input: {
  readonly fetch: typeof globalThis.fetch;
  readonly url: string;
}): Effect.Effect<unknown, ServiceUpdateOperationError> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    yield* controlledGet(
      { fetch: input.fetch, url: input.url, accept: RELEASES_ACCEPT },
      (response, signal) => {
        if (isRedirectStatus(response.status) || response.status !== 200) {
          return failSource("unavailable", "The release metadata request did not succeed.");
        }
        if (response.body === null) {
          return failSource("unavailable", "The release metadata response had no body.");
        }
        return consumeBody(
          response.body,
          signal,
          SERVICE_UPDATE_SOURCE_LIMITS.metadataMaxBytes,
          (chunk) =>
            Effect.sync(() => {
              chunks.push(chunk);
            }),
        ).pipe(Effect.asVoid);
      },
    );

    const decoder = new TextDecoder();
    let text = "";
    for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
    text += decoder.decode();
    return yield* Effect.try({
      try: () => parseJsonText(text),
      catch: () =>
        makeSourceError({
          code: "unavailable",
          message: "The release metadata response was not valid JSON.",
        }),
    });
  });

export interface ServiceUpdateSourceOperations {
  readonly check: (input: {
    readonly repository: string;
    readonly currentVersion: string;
  }) => Effect.Effect<ServiceUpdateReleaseDescriptor | null, ServiceUpdateOperationError>;
  readonly resolveTargetVersion: (input: {
    readonly repository: string;
    readonly targetVersion: string;
  }) => Effect.Effect<ServiceUpdateReleaseDescriptor, ServiceUpdateOperationError>;
}

/**
 * Constructor capturing the injected fetch dependency. The live source binding
 * composes these metadata/asset operations with artifact staging.
 */
export const makeServiceUpdateSourceOperations = (input: {
  readonly fetch: typeof globalThis.fetch;
}): ServiceUpdateSourceOperations => ({
  check: ({ repository, currentVersion }) =>
    Effect.gen(function* () {
      const parsedRepository = parseRepository(repository);
      if (parsedRepository instanceof ServiceUpdateOperationError) {
        return yield* Effect.fail(parsedRepository);
      }
      // An empty repository disables the update source without any fetch.
      if (parsedRepository === null) return null;

      const versionError = parseCurrentVersion(currentVersion);
      if (versionError !== null) return yield* Effect.fail(versionError);

      // Full frozen-policy validation happens before any request so a
      // malformed nonempty version never reaches GitHub.
      yield* validateCurrentVersionWithoutFetch({ repository, currentVersion });

      const releasesUrl = `https://api.github.com/repos/${encodeURIComponent(
        parsedRepository.owner,
      )}/${encodeURIComponent(parsedRepository.repo)}/releases?per_page=30`;

      // Metadata requests are never redirected: GitHub serves this endpoint
      // directly, so a 3xx means something is between us and the API.
      const releases = yield* fetchReleaseMetadata({ fetch: input.fetch, url: releasesUrl });

      return yield* Effect.try({
        try: () =>
          selectServiceUpdateRelease({
            repository,
            currentVersion,
            platform: "linux",
            architecture: "x64",
            releases,
          }),
        catch: mapSelectionCause,
      });
    }).pipe(
      Effect.timeout(SERVICE_UPDATE_SOURCE_LIMITS.metadataTimeout),
      Effect.catchTags({
        TimeoutError: () =>
          failSource("timeout", "The release metadata request exceeded its time budget."),
      }),
    ),
  resolveTargetVersion: ({ repository, targetVersion }) =>
    Effect.gen(function* () {
      const parsedRepository = parseRepository(repository);
      if (parsedRepository instanceof ServiceUpdateOperationError) {
        return yield* Effect.fail(parsedRepository);
      }
      if (parsedRepository === null) {
        return yield* failSource(
          "invalid-input",
          "A GitHub repository is required for an exact-version update.",
        );
      }
      if (!isServiceUpdateTargetVersion(targetVersion)) {
        return yield* failSource(
          "invalid-input",
          "The requested update version must be canonical MAJOR.MINOR.PATCH-f8y.YYYYMMDD.RUN.",
        );
      }

      const tag = `v${targetVersion}`;
      const releaseUrl = `https://api.github.com/repos/${encodeURIComponent(
        parsedRepository.owner,
      )}/${encodeURIComponent(parsedRepository.repo)}/releases/tags/${encodeURIComponent(tag)}`;
      const release = yield* fetchReleaseMetadata({ fetch: input.fetch, url: releaseUrl });
      return yield* Effect.try({
        try: () => resolveServiceUpdateReleaseByVersion({ repository, targetVersion, release }),
        catch: mapSelectionCause,
      });
    }).pipe(
      Effect.timeout(SERVICE_UPDATE_SOURCE_LIMITS.metadataTimeout),
      Effect.catchTags({
        TimeoutError: () =>
          failSource("timeout", "The exact-version release request exceeded its time budget."),
      }),
    ),
});

export type ServiceUpdateAssetKind = "checksums" | "binary";

/** Hard per-kind limits from the outcome contract; overrides may only tighten. */
const assetKindLimits = (
  kind: ServiceUpdateAssetKind,
): { readonly maxBytes: number; readonly timeout: Duration.Duration } =>
  kind === "checksums"
    ? {
        maxBytes: SERVICE_UPDATE_SOURCE_LIMITS.checksumsMaxBytes,
        timeout: SERVICE_UPDATE_SOURCE_LIMITS.checksumsTimeout,
      }
    : {
        maxBytes: SERVICE_UPDATE_SOURCE_LIMITS.binaryMaxBytes,
        timeout: SERVICE_UPDATE_SOURCE_LIMITS.binaryTimeout,
      };

/**
 * Positive-finite caller budgets may only tighten the kind's hard limits;
 * zero, negative, and non-finite values are rejected as invalid input.
 */
const resolveAssetLimits = (
  kind: ServiceUpdateAssetKind,
  override: { readonly maxBytes?: number; readonly timeout?: Duration.Duration },
):
  | { readonly maxBytes: number; readonly timeout: Duration.Duration }
  | ServiceUpdateOperationError => {
  const hard = assetKindLimits(kind);
  let maxBytes = hard.maxBytes;
  if (override.maxBytes !== undefined) {
    if (!Number.isFinite(override.maxBytes) || override.maxBytes <= 0) {
      return makeSourceError({
        code: "invalid-input",
        message: "The asset byte budget must be a positive finite number.",
      });
    }
    maxBytes = Math.min(override.maxBytes, hard.maxBytes);
  }
  let timeout = hard.timeout;
  if (override.timeout !== undefined) {
    const millis = Duration.toMillis(override.timeout);
    if (!Number.isFinite(millis) || millis <= 0) {
      return makeSourceError({
        code: "invalid-input",
        message: "The asset time budget must be a positive finite duration.",
      });
    }
    if (millis < Duration.toMillis(hard.timeout)) timeout = override.timeout;
  }
  return { maxBytes, timeout };
};

interface BoundedAssetInput {
  readonly fetch: typeof globalThis.fetch;
  readonly identity: ServiceUpdateAssetIdentity;
  readonly maxBytes: number;
  readonly timeout: Duration.Duration;
  readonly onChunk: ServiceUpdateChunkConsumer;
}

/**
 * Generic bounded consumer for one release-asset response. Validates each
 * redirect target before fetching it (at most `maxRedirectHops` hops), then
 * streams the response body chunk by chunk into `onChunk`. Every hop runs
 * under its own explicit abort scope. The byte budget is enforced against the
 * actually consumed decoded bytes — never `content-length` — and the body is
 * never buffered. A consumer failure, an over-budget chunk, the timeout, or any
 * interruption aborts the in-flight request before the caller continues.
 */
const consumeBoundedAsset = (
  input: BoundedAssetInput,
): Effect.Effect<number, ServiceUpdateOperationError> =>
  Effect.gen(function* () {
    // The first URL is the canonical GitHub download URL built from the
    // validated descriptor; validating it up front anchors every later hop.
    let currentUrl: string = yield* Effect.try({
      try: () => validateAssetUrl(`https://github.com${assetPath(input.identity)}`, input.identity),
      catch: (cause) =>
        makeSourceError({
          code: "unavailable",
          message: "The release asset URL was not the canonical GitHub download URL.",
          cause,
        }),
    });

    for (let remainingHops = SERVICE_UPDATE_SOURCE_LIMITS.maxRedirectHops; ; remainingHops--) {
      const outcome = yield* controlledGet(
        { fetch: input.fetch, url: currentUrl, accept: ASSET_ACCEPT },
        (response, signal): Effect.Effect<HopOutcome, ServiceUpdateOperationError> => {
          if (isRedirectStatus(response.status)) {
            const location = response.headers.get("location");
            if (location === null || location === "") {
              return failSource(
                "unavailable",
                "The release asset redirected without a location header.",
              );
            }
            return Effect.try({
              try: (): HopOutcome => ({
                _tag: "redirect",
                nextUrl: validateAssetUrl(location, input.identity),
              }),
              catch: (cause) => cause as ServiceUpdateOperationError,
            });
          }
          if (response.status !== 200) {
            return failSource("unavailable", "The release asset request did not succeed.");
          }
          if (response.body === null) {
            return failSource("unavailable", "The release asset response had no body.");
          }
          return Effect.map(
            consumeBody(response.body, signal, input.maxBytes, input.onChunk),
            (bytes): HopOutcome => ({ _tag: "done", bytes }),
          );
        },
      );

      if (outcome._tag === "redirect") {
        if (remainingHops <= 0) {
          return yield* failSource(
            "unavailable",
            "The release asset exceeded the allowed number of redirects.",
          );
        }
        currentUrl = outcome.nextUrl;
        continue;
      }
      return outcome.bytes;
    }
  }).pipe(
    Effect.timeout(input.timeout),
    Effect.catchTags({
      TimeoutError: () =>
        failSource("timeout", "The release asset download exceeded its time budget."),
    }),
  );

/**
 * Asset consumer entry point. The hard byte/time limits come from the asset
 * kind (checksums or binary); optional caller budgets may only tighten them,
 * and zero/negative/non-finite budgets fail with `invalid-input` before any
 * request is issued.
 */
export const consumeServiceUpdateAsset = (input: {
  readonly fetch: typeof globalThis.fetch;
  readonly identity: ServiceUpdateAssetIdentity;
  readonly kind: ServiceUpdateAssetKind;
  readonly maxBytes?: number;
  readonly timeout?: Duration.Duration;
  readonly onChunk: ServiceUpdateChunkConsumer;
}): Effect.Effect<number, ServiceUpdateOperationError> =>
  Effect.gen(function* () {
    const limits = resolveAssetLimits(input.kind, input);
    if (limits instanceof ServiceUpdateOperationError) return yield* Effect.fail(limits);
    return yield* consumeBoundedAsset({
      fetch: input.fetch,
      identity: input.identity,
      maxBytes: limits.maxBytes,
      timeout: limits.timeout,
      onChunk: input.onChunk,
    });
  });
