// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live `ServiceUpdateSource` port: bounded release lookup plus immutable
 * artifact staging.
 *
 * `stage` downloads the release checksum sidecar and binary through the bounded
 * asset consumer (fixed `credentials:"omit"` / manual-redirect policy,
 * tightenable-only budgets), verifies the sha256 of the consumed bytes against
 * the sidecar, and writes the artifact into an immutable staging directory
 * under `<baseDir>/runtime/service-update-staging/<attemptId>/`. The staged
 * file is made read-only and the directory is rename-published
 * (`pinnedRuntime.ts` `versionsDir/.staging-*` precedent), so the runtime
 * adopter later copies and re-verifies a never-mutated source.
 *
 * Errors carry bounded causes only: request URLs and signed queries never
 * reach an error message, cause, or log.
 *
 * @module ServiceUpdateSourceLive
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ServiceUpdateAttemptId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  ServiceUpdateReleaseError,
  parseServiceUpdateChecksum,
  verifyServiceUpdateChecksum,
} from "./serviceUpdateRelease.ts";
import {
  consumeServiceUpdateAsset,
  makeServiceUpdateSourceOperations,
  type ServiceUpdateAssetIdentity,
} from "./serviceUpdateSource.ts";
import {
  ServiceUpdateOperationError,
  ServiceUpdateSource,
  type ServiceUpdateProgress,
  type ServiceUpdateSourceShape,
  type StagedServiceRuntime,
} from "./serviceUpdateServices.ts";

/** Well-known immutable artifact name inside a published staging directory. */
export const STAGED_ARTIFACT_FILENAME = "t3-runtime.bin";

const STAGING_PARENT = NodePath.join("runtime", "service-update-staging");
const STAGING_PREFIX = ".staging-";
const isAttemptId = Schema.is(ServiceUpdateAttemptId);

const makeSourceError = (input: {
  readonly code: ServiceUpdateOperationError["code"];
  readonly message: string;
  readonly cause?: unknown;
  readonly cleanupFailure?: boolean;
}): ServiceUpdateOperationError =>
  new ServiceUpdateOperationError({
    stage: "source",
    code: input.code,
    cause: input.cause === undefined ? input.message : input.cause,
    ...(input.cleanupFailure === undefined ? {} : { cleanupFailure: input.cleanupFailure }),
  });

/** Maps a frozen-policy release error to a bounded source error. */
const mapReleaseError = (cause: unknown): ServiceUpdateOperationError => {
  if (cause instanceof ServiceUpdateReleaseError) {
    return makeSourceError({
      code:
        cause.code === "checksum-mismatch" ||
        cause.code === "invalid-checksums" ||
        cause.code === "invalid-digest"
          ? "verification-failed"
          : cause.code === "invalid-repository" || cause.code === "invalid-current-version"
            ? "invalid-input"
            : "unavailable",
      message: cause.message,
      cause,
    });
  }
  return makeSourceError({
    code: "verification-failed",
    message: "The release artifact could not be verified.",
    cause,
  });
};

/**
 * Recovers the canonical asset identity from a release asset URL. Release
 * selection already pinned these URLs to the configured repository's own
 * GitHub download URL, so the path segments are the identity.
 */
const parseAssetIdentity = (
  url: string,
  expectedAssetName: string,
): ServiceUpdateAssetIdentity | ServiceUpdateOperationError => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return makeSourceError({
      code: "invalid-input",
      message: "The release asset URL is invalid.",
    });
  }
  const segments = parsed.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment));
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    segments.length !== 6 ||
    segments[2] !== "releases" ||
    segments[3] !== "download" ||
    segments[5] !== expectedAssetName
  ) {
    return makeSourceError({
      code: "invalid-input",
      message: "The release asset URL is not the canonical GitHub download URL.",
    });
  }
  const [owner, repo, , , tag] = segments;
  if (
    owner === undefined ||
    repo === undefined ||
    tag === undefined ||
    owner === "" ||
    repo === "" ||
    tag === ""
  ) {
    return makeSourceError({
      code: "invalid-input",
      message: "The release asset URL is not the canonical GitHub download URL.",
    });
  }
  return { owner, repo, tag, assetName: expectedAssetName };
};

/** Yields one artifact file's bytes in chunks so verification never buffers it. */
export function* artifactFileChunks(filePath: string): Generator<Uint8Array> {
  const handle = NodeFS.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const bytes = NodeFS.readSync(handle, buffer, 0, buffer.length, null);
      if (bytes <= 0) break;
      yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytes);
    }
  } finally {
    NodeFS.closeSync(handle);
  }
}

const isOwnedStagingContent = (directory: string, workInProgress: boolean): boolean => {
  const entries = NodeFS.readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.name !== STAGED_ARTIFACT_FILENAME || !entry.isFile())) {
    return false;
  }
  return workInProgress || entries.length === 1;
};

const removeStagingDirectory = (
  directory: string,
): Effect.Effect<void, ServiceUpdateOperationError> =>
  Effect.try({
    try: () => NodeFS.rmSync(directory, { recursive: true, force: true }),
    catch: () =>
      makeSourceError({
        code: "io",
        message: "The source staging directory could not be cleaned up.",
        cleanupFailure: true,
      }),
  }).pipe(Effect.asVoid);

/** Remove only direct, recognizable staging children left by a prior process. */
export const cleanupAbandonedServiceUpdateStaging = (
  baseDir: string,
): Effect.Effect<void, ServiceUpdateOperationError> =>
  Effect.try({
    try: () => {
      const basePath = NodePath.resolve(baseDir);
      const parent = NodePath.resolve(basePath, STAGING_PARENT);
      if (NodePath.dirname(parent) !== NodePath.join(basePath, "runtime")) {
        throw new Error("The source staging directory escaped the runtime directory.");
      }

      const runtimeDirectory = NodePath.join(basePath, "runtime");
      let runtimeStat: NodeFS.Stats;
      try {
        runtimeStat = NodeFS.lstatSync(runtimeDirectory);
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
        throw cause;
      }
      if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
        throw new Error("The runtime directory is not a directory.");
      }

      let parentStat: NodeFS.Stats;
      try {
        parentStat = NodeFS.lstatSync(parent);
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
        throw cause;
      }
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new Error("The source staging parent is not a directory.");
      }

      for (const entry of NodeFS.readdirSync(parent, { withFileTypes: true })) {
        const workInProgress = entry.name.startsWith(STAGING_PREFIX);
        const attemptId = workInProgress ? entry.name.slice(STAGING_PREFIX.length) : entry.name;
        if (!isAttemptId(attemptId) || !entry.isDirectory()) continue;

        const directory = NodePath.resolve(parent, entry.name);
        if (NodePath.dirname(directory) !== parent || NodePath.basename(directory) !== entry.name) {
          continue;
        }
        const directoryStat = NodeFS.lstatSync(directory);
        if (
          !directoryStat.isDirectory() ||
          directoryStat.isSymbolicLink() ||
          !isOwnedStagingContent(directory, workInProgress)
        ) {
          continue;
        }
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    },
    catch: () =>
      makeSourceError({
        code: "io",
        message: "Abandoned source staging could not be cleaned up.",
        cleanupFailure: true,
      }),
  }).pipe(Effect.asVoid);

export interface ServiceUpdateSourceLiveInput {
  readonly fetch: typeof globalThis.fetch;
  readonly baseDir: string;
}

/**
 * Production `ServiceUpdateSource` binding. `check` is the Unit1a metadata
 * lookup; `stage`/`discard` own bounded artifact staging.
 */
export function makeServiceUpdateSource(
  input: ServiceUpdateSourceLiveInput,
): ServiceUpdateSourceShape {
  const operations = makeServiceUpdateSourceOperations({ fetch: input.fetch });
  const stagingParent = NodePath.join(input.baseDir, STAGING_PARENT);

  const stage: ServiceUpdateSourceShape["stage"] = ({ attemptId, candidate }, reportProgress) => {
    const stagingDirectory = NodePath.join(stagingParent, attemptId);
    const stagingWip = NodePath.join(stagingParent, `${STAGING_PREFIX}${attemptId}`);
    const artifactPath = NodePath.join(stagingWip, STAGED_ARTIFACT_FILENAME);
    let published = false;
    let returned = false;
    let cleanupFailure: ServiceUpdateOperationError | undefined;
    return Effect.gen(function* () {
      const checksumsIdentity = parseAssetIdentity(
        candidate.checksumsUrl,
        `${candidate.binaryName}.sha256`,
      );
      if (checksumsIdentity instanceof ServiceUpdateOperationError) {
        return yield* Effect.fail(checksumsIdentity);
      }
      const binaryIdentity = parseAssetIdentity(candidate.binaryUrl, candidate.binaryName);
      if (binaryIdentity instanceof ServiceUpdateOperationError) {
        return yield* Effect.fail(binaryIdentity);
      }

      const checksumsChunks: Array<Uint8Array> = [];
      yield* consumeServiceUpdateAsset({
        fetch: input.fetch,
        identity: checksumsIdentity,
        kind: "checksums",
        onChunk: (chunk) =>
          Effect.sync(() => {
            checksumsChunks.push(chunk);
          }),
      });
      const decoder = new TextDecoder();
      let checksumsText = "";
      for (const chunk of checksumsChunks) {
        checksumsText += decoder.decode(chunk, { stream: true });
      }
      checksumsText += decoder.decode();
      const expectedDigest = yield* Effect.try({
        try: () => parseServiceUpdateChecksum(checksumsText),
        catch: mapReleaseError,
      });

      yield* Effect.try({
        try: () => {
          NodeFS.rmSync(stagingWip, { recursive: true, force: true });
          NodeFS.rmSync(stagingDirectory, { recursive: true, force: true });
          NodeFS.mkdirSync(stagingWip, { recursive: true });
        },
        catch: () =>
          makeSourceError({
            code: "io",
            message: "The staging directory could not be prepared.",
          }),
      });

      let downloadedBytes = 0;
      let lastReported = 0;
      const report = (progress: ServiceUpdateProgress) =>
        reportProgress(progress).pipe(
          Effect.mapError((error) =>
            makeSourceError({
              code: error.code,
              message: "Progress reporting failed.",
              cause: error,
            }),
          ),
        );

      const consumed = yield* consumeServiceUpdateAsset({
        fetch: input.fetch,
        identity: binaryIdentity,
        kind: "binary",
        onChunk: (chunk) =>
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => {
                NodeFS.appendFileSync(artifactPath, chunk);
              },
              catch: () =>
                makeSourceError({
                  code: "io",
                  message: "The staged release artifact could not be written.",
                }),
            });
            downloadedBytes += chunk.byteLength;
            if (downloadedBytes > lastReported) {
              lastReported = downloadedBytes;
              const progress: ServiceUpdateProgress = {
                downloadedBytes,
                totalBytes: null,
              };
              yield* report(progress);
            }
          }),
      });

      // Verify the consumed bytes against the sidecar through the frozen
      // checksum verifier (streams the staged file; never buffers it).
      yield* Effect.try({
        try: () => verifyServiceUpdateChecksum(artifactFileChunks(artifactPath), expectedDigest),
        catch: mapReleaseError,
      });

      // Immutable staging: read-only artifact, then rename-publish the dir.
      yield* Effect.try({
        try: () => {
          NodeFS.chmodSync(artifactPath, 0o444);
          NodeFS.rmSync(stagingDirectory, { recursive: true, force: true });
          NodeFS.renameSync(stagingWip, stagingDirectory);
          published = true;
        },
        catch: () =>
          makeSourceError({
            code: "io",
            message: "The staged release artifact could not be published.",
          }),
      });

      const staged: StagedServiceRuntime = {
        format: 1,
        attemptId,
        version: candidate.version,
        platform: "linux-x64",
        sha256: expectedDigest,
        bytes: consumed,
        stagingDirectory,
      };
      returned = true;
      return staged;
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          if (returned) return Effect.void;
          return removeStagingDirectory(published ? stagingDirectory : stagingWip).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                cleanupFailure = error;
              }),
            ),
          );
        }),
      ),
      Effect.mapError((error) => {
        if (cleanupFailure === undefined) return error;
        return new ServiceUpdateOperationError({
          stage: "source",
          code: error.code,
          cause: { primary: error, cleanup: cleanupFailure },
          cleanupFailure: true,
        });
      }),
    );
  };

  const discard: ServiceUpdateSourceShape["discard"] = (staged) =>
    Effect.suspend(() => {
      if (!isAttemptId(staged.attemptId)) {
        return Effect.fail(
          makeSourceError({
            code: "invalid-input",
            message: "The staged release artifact identity is invalid.",
          }),
        );
      }
      const expectedDirectory = NodePath.resolve(stagingParent, staged.attemptId);
      if (
        NodePath.resolve(staged.stagingDirectory) !== expectedDirectory ||
        NodePath.dirname(expectedDirectory) !== NodePath.resolve(stagingParent) ||
        NodePath.basename(expectedDirectory) !== staged.attemptId
      ) {
        return Effect.fail(
          makeSourceError({
            code: "invalid-input",
            message: "The staged release artifact path is outside its owned directory.",
          }),
        );
      }
      return Effect.try({
        try: () => {
          const stagingParentDirectory = NodePath.dirname(expectedDirectory);
          const runtimeDirectory = NodePath.dirname(stagingParentDirectory);
          let runtimeStat: NodeFS.Stats;
          let parentStat: NodeFS.Stats;
          try {
            runtimeStat = NodeFS.lstatSync(runtimeDirectory);
            parentStat = NodeFS.lstatSync(stagingParentDirectory);
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
            throw cause;
          }
          if (
            !runtimeStat.isDirectory() ||
            runtimeStat.isSymbolicLink() ||
            !parentStat.isDirectory() ||
            parentStat.isSymbolicLink()
          ) {
            throw new Error("The staged release artifact parent is not owned by this runtime.");
          }

          let directoryStat: NodeFS.Stats;
          try {
            directoryStat = NodeFS.lstatSync(expectedDirectory);
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return;
            throw cause;
          }
          if (
            !directoryStat.isDirectory() ||
            directoryStat.isSymbolicLink() ||
            !isOwnedStagingContent(expectedDirectory, true)
          ) {
            throw new Error("The staged release artifact directory is not owned by this attempt.");
          }
          NodeFS.rmSync(expectedDirectory, { recursive: true, force: true });
        },
        catch: () =>
          makeSourceError({
            code: "io",
            message: "The staged release artifact could not be discarded.",
            cleanupFailure: true,
          }),
      }).pipe(Effect.asVoid);
    });

  return {
    check: operations.check,
    resolveTargetVersion: operations.resolveTargetVersion,
    stage,
    discard,
  };
}

/**
 * Live layer. Exported for a later unit to compose; deliberately not wired
 * into `server.ts` here (same boundary as `ServiceUpdateDrainLive`).
 */
export const ServiceUpdateSourceLive = Layer.effect(
  ServiceUpdateSource,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    yield* cleanupAbandonedServiceUpdateStaging(config.baseDir);
    return ServiceUpdateSource.of(
      makeServiceUpdateSource({ fetch: globalThis.fetch, baseDir: config.baseDir }),
    );
  }),
);
