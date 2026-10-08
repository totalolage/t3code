// @effect-diagnostics nodeBuiltinImport:off
/**
 * Live `ServiceUpdateRuntime` port: availability resolution, immutable
 * artifact adoption, and launcher handoff.
 *
 * `adopt` copies the immutable staged artifact into the runtime install
 * location through the `pinnedRuntime.ts` staging + rename-publish precedent
 * (`versions/.staging-*` → `versions/<version>`), re-hashing the COPIED bytes
 * against `staged.sha256` before anything is published (runtime
 * copies/verifies). The staged directory is only ever read. A digest mismatch
 * fails closed and publishes nothing.
 *
 * `requestHandoff` is launcher acceptance only: `ServiceLauncherClient`'s
 * `updateId` records that the launcher acknowledged the request before it
 * terminates this process and starts the trial run — never readiness or
 * commit.
 *
 * @module ServiceUpdateRuntimeLive
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ServiceRuntimeUpdateId, ServiceUpdateVersion } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveServerSelfUpdateCapability } from "./selfUpdate.ts";
import {
  resolveInstalledServiceRuntime,
  serviceRuntimeFiles,
  serviceRuntimeFilesInDirectory,
  type ServiceRuntimeFormat,
} from "./serviceRuntime.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV } from "./serviceProtocol.ts";
import {
  ServiceLauncherClient,
  ServiceLauncherClientError,
  ServiceLauncherRejectedError,
} from "./serviceLauncherClient.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import { verifyServiceUpdateChecksum } from "./serviceUpdateRelease.ts";
import { artifactFileChunks, STAGED_ARTIFACT_FILENAME } from "./serviceUpdateSourceLive.ts";
import {
  ServiceUpdateOperationError,
  ServiceUpdateRuntime,
  UpdateAuthorityError,
  type ServiceUpdateRuntimeAvailability,
  type ServiceUpdateRuntimeShape,
  type StagedServiceRuntime,
} from "./serviceUpdateServices.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);

const makeRuntimeError = (input: {
  readonly code: ServiceUpdateOperationError["code"];
  readonly message: string;
  readonly cause?: unknown;
}): ServiceUpdateOperationError =>
  new ServiceUpdateOperationError({
    stage: "runtime",
    code: input.code,
    cause: input.cause === undefined ? input.message : input.cause,
  });

/** Layout the launcher's `runtimeExists`/`#startChild` expect for one version. */
export interface RuntimeInstallPaths {
  readonly format: ServiceRuntimeFormat;
  readonly versionDir: string;
  readonly entryPath: string;
  readonly executablePath: string;
  readonly sentinelPath: string;
}

export const runtimeInstallPaths = (
  baseDir: string,
  version: string,
  format: ServiceRuntimeFormat = "node-entry",
): RuntimeInstallPaths => {
  const files = serviceRuntimeFiles(baseDir, version);
  return {
    format,
    versionDir: files.versionDir,
    entryPath: files.nodeEntryPath,
    executablePath:
      format === "standalone-executable" ? files.standaloneExecutablePath : files.nodeEntryPath,
    sentinelPath: files.sentinelPath,
  };
};

/** Minimal launcher surface this port drives. */
export interface ServiceUpdateRuntimeLauncher {
  readonly managed: boolean;
  readonly requestUpdate: (input: {
    readonly targetVersion: string;
    readonly dbPath: string;
  }) => Effect.Effect<string, ServiceLauncherClientError | ServiceLauncherRejectedError>;
}

export interface ServiceUpdateRuntimeLiveInput {
  readonly launcher: ServiceUpdateRuntimeLauncher;
  readonly baseDir: string;
  readonly dbPath: string;
  readonly captureSource: ServiceUpdateRuntimeShape["captureSource"];
  readonly desktopManaged: boolean;
  /** The launcher's protocol revision; older ones cannot host this flow. */
  readonly launcherProtocol: number;
  readonly platform: string;
  readonly architecture: string;
  /**
   * Pre-publish validation over the staging paths and exact release version (the
   * `ensurePinnedRuntimeInstalled` `validate` pattern: staged preflight
   * before the rename publish).
   */
  readonly validate: (
    paths: RuntimeInstallPaths,
    expectedVersion: StagedServiceRuntime["version"],
  ) => Effect.Effect<void, ServiceUpdateOperationError>;
}

const makeCaptureSource =
  (input: {
    readonly sql: SqlClient.SqlClient;
    readonly fileSystem: FileSystem.FileSystem;
  }): ServiceUpdateRuntimeShape["captureSource"] =>
  ({ fromVersion }) =>
    Effect.gen(function* () {
      const fail = (cause: unknown) =>
        makeRuntimeError({
          code: "unavailable",
          message: "The active service source could not be proved.",
          cause,
        });
      const databases = yield* input.sql<{
        readonly name: string;
        readonly file: string;
      }>`PRAGMA database_list`.pipe(Effect.mapError((cause) => fail(cause)));
      const mainDatabases = databases.filter((database) => database.name === "main");
      const mainFile = mainDatabases[0]?.file;
      if (
        mainDatabases.length !== 1 ||
        mainFile === undefined ||
        mainFile.trim() === "" ||
        !NodePath.isAbsolute(mainFile)
      ) {
        return yield* Effect.fail(fail(new Error("The open SQLite main database is not a file.")));
      }
      const databaseIdentity = yield* input.fileSystem
        .realPath(mainFile)
        .pipe(Effect.mapError((cause) => fail(cause)));

      return { databaseIdentity, fromVersion };
    });

const mapLauncherError = (
  error: ServiceLauncherClientError | ServiceLauncherRejectedError,
): ServiceUpdateOperationError => {
  if (error._tag === "ServiceLauncherRejectedError") {
    return makeRuntimeError({
      code: "rejected-before-acceptance",
      message: "The service launcher rejected the update before acceptance.",
      cause: error,
    });
  }
  return makeRuntimeError({
    code:
      error.operation === "unmanaged" || error.operation === "ipc-unavailable"
        ? "unavailable"
        : "acceptance-unknown",
    message:
      error.operation === "unmanaged" || error.operation === "ipc-unavailable"
        ? "The service launcher handoff channel is unavailable."
        : "The service launcher did not confirm acceptance.",
    cause: error,
  });
};

/**
 * Production `ServiceUpdateRuntime` binding. Availability follows
 * `resolveServerSelfUpdateCapability`/`resolveServiceLauncherMode` semantics:
 * only a launcher-managed boot-service server on linux-x64 with a current
 * launcher protocol is supported.
 */
export function makeServiceUpdateRuntime(
  input: ServiceUpdateRuntimeLiveInput,
): ServiceUpdateRuntimeShape {
  const availability: Effect.Effect<ServiceUpdateRuntimeAvailability, ServiceUpdateOperationError> =
    Effect.succeed(
      input.baseDir.trim() === "" || input.dbPath.trim() === ""
        ? { status: "unsupported", reason: "runtime-binding-unavailable" }
        : resolveServerSelfUpdateCapability({
              desktopManaged: input.desktopManaged,
              launcherManaged: input.launcher.managed,
            }) !== "boot-service" || !input.launcher.managed
          ? // `null` and `desktop-managed` alike: this launcher-driven runtime
            // update path is not the active update authority here.
            { status: "unsupported", reason: "unmanaged" }
          : input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL
            ? { status: "unsupported", reason: "launcher-upgrade-required" }
            : input.platform !== "linux" || input.architecture !== "x64"
              ? { status: "unsupported", reason: "platform" }
              : { status: "supported" },
    );

  const adopt: ServiceUpdateRuntimeShape["adopt"] = (staged: StagedServiceRuntime) => {
    const artifactPath = NodePath.join(staged.stagingDirectory, STAGED_ARTIFACT_FILENAME);
    const target = runtimeInstallPaths(input.baseDir, staged.version, "standalone-executable");
    const versionsDir = NodePath.join(input.baseDir, "runtime", "versions");
    const stagingWip = NodePath.join(versionsDir, `.staging-${staged.attemptId}`);
    const stagingFiles = serviceRuntimeFilesInDirectory(stagingWip);
    const stagingPaths: RuntimeInstallPaths = {
      ...target,
      versionDir: stagingWip,
      entryPath: stagingFiles.nodeEntryPath,
      executablePath: stagingFiles.standaloneExecutablePath,
      sentinelPath: stagingFiles.sentinelPath,
    };
    let published = false;
    return Effect.gen(function* () {
      const targetExists = yield* Effect.try({
        try: () => NodeFS.existsSync(target.versionDir),
        catch: (cause) =>
          makeRuntimeError({
            code: "io",
            message: "The target runtime could not be inspected.",
            cause,
          }),
      });
      if (targetExists) {
        const installed = yield* Effect.tryPromise({
          try: () => resolveInstalledServiceRuntime(input.baseDir, staged.version),
          catch: (cause) =>
            makeRuntimeError({
              code: "io",
              message: "The existing target runtime could not be validated.",
              cause,
            }),
        });
        if (installed?.format !== "standalone-executable") {
          return yield* Effect.fail(
            makeRuntimeError({
              code: "rejected-before-acceptance",
              message: "A conflicting or invalid runtime already occupies the target version.",
            }),
          );
        }
        yield* Effect.try({
          try: () =>
            verifyServiceUpdateChecksum(
              artifactFileChunks(installed.executablePath),
              staged.sha256,
            ),
          catch: (cause) =>
            makeRuntimeError({
              code: "rejected-before-acceptance",
              message: "A conflicting or invalid runtime already occupies the target version.",
              cause,
            }),
        });
        yield* input.validate(target, staged.version);
        return;
      }

      yield* Effect.try({
        try: () => {
          NodeFS.rmSync(stagingWip, { recursive: true, force: true });
          NodeFS.mkdirSync(NodePath.dirname(stagingPaths.executablePath), { recursive: true });
          // Read-only on the staged side: the immutable artifact is never
          // mutated, only copied out.
          NodeFS.copyFileSync(artifactPath, stagingPaths.executablePath);
          NodeFS.chmodSync(stagingPaths.executablePath, 0o755);
        },
        catch: () =>
          makeRuntimeError({
            code: "io",
            message: "The staged release artifact could not be copied.",
          }),
      });

      // Runtime copies/verifies: re-hash the COPIED bytes against the staged
      // digest before anything is published.
      yield* Effect.try({
        try: () =>
          verifyServiceUpdateChecksum(
            artifactFileChunks(stagingPaths.executablePath),
            staged.sha256,
          ),
        catch: (cause) =>
          makeRuntimeError({
            code: "verification-failed",
            message: "The adopted release artifact failed digest verification.",
            cause,
          }),
      });

      yield* input.validate(stagingPaths, staged.version);

      yield* Effect.try({
        try: () => {
          if (NodeFS.existsSync(target.versionDir)) {
            throw new Error("The target runtime version is already installed.");
          }
          NodeFS.writeFileSync(stagingPaths.sentinelPath, `${staged.version}\n`);
          NodeFS.renameSync(stagingWip, target.versionDir);
          published = true;
        },
        catch: () =>
          makeRuntimeError({
            code: "io",
            message: "The adopted release artifact could not be published.",
          }),
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!published) {
            try {
              NodeFS.rmSync(stagingWip, { recursive: true, force: true });
            } catch {
              // Best-effort cleanup; the next adopt of this attempt replaces it.
            }
          }
        }),
      ),
    );
  };

  const requestHandoff: ServiceUpdateRuntimeShape["requestHandoff"] = ({
    targetVersion,
    source,
    authorityLease,
  }) =>
    Effect.gen(function* () {
      // The irreversible boundary. The scheduler enters the lease at its
      // commit point just before this call; entering here covers every other
      // caller, and a second entry is exactly the retained state we need.
      yield* authorityLease.enterIrreversible.pipe(
        Effect.catch((error: UpdateAuthorityError) =>
          error.code === "retained-lease" ? Effect.void : Effect.fail(error),
        ),
        Effect.mapError((error) =>
          makeRuntimeError({
            code: "unavailable",
            message: "The update authority lease could not be made irreversible.",
            cause: error,
          }),
        ),
      );

      const updateId = yield* input.launcher
        .requestUpdate({ targetVersion, dbPath: source.databaseIdentity })
        .pipe(Effect.mapError(mapLauncherError));

      // Launcher acceptance only: the launcher acknowledges before it
      // terminates this process and starts the trial run.
      return { updateId: updateId as ServiceRuntimeUpdateId };
    }).pipe(Effect.annotateLogs({ targetVersion }));

  return { availability, captureSource: input.captureSource, adopt, requestHandoff };
}

/**
 * The `selfUpdate.ts` staged-preflight pattern against the staging paths:
 * run `__service-preflight` on the staged entry and require `ready`.
 */
export function makePreflightValidate(input: {
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly execPath: string;
  readonly dbPath: string;
}): (
  paths: RuntimeInstallPaths,
  expectedVersion: ServiceUpdateVersion,
) => Effect.Effect<void, ServiceUpdateOperationError> {
  return (paths, expectedVersion) =>
    input.runner
      .run({
        command: paths.format === "standalone-executable" ? paths.executablePath : input.execPath,
        args: [
          ...(paths.format === "node-entry" ? [paths.executablePath] : []),
          "__service-preflight",
          "--database-path",
          input.dbPath,
          "--launcher-protocol",
          String(SERVICE_LAUNCHER_PROTOCOL),
        ],
        env: {
          [SERVICE_LAUNCHER_CONTEXT_ENV]: undefined,
        },
        timeout: PREFLIGHT_TIMEOUT,
      })
      .pipe(
        Effect.mapError((cause) =>
          makeRuntimeError({
            code: "io",
            message: "The staged service preflight could not run.",
            cause,
          }),
        ),
        Effect.flatMap((result) => {
          if (result.code !== 0) {
            return Effect.fail(
              makeRuntimeError({
                code: "rejected-before-acceptance",
                message: "The staged service preflight did not pass.",
              }),
            );
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(result.stdout.trim()) as unknown;
          } catch (cause) {
            return Effect.fail(
              makeRuntimeError({
                code: "verification-failed",
                message: "The staged service preflight result is invalid.",
                cause,
              }),
            );
          }
          const preflight = decodeServicePreflightResult(parsed);
          const runtimeQualified =
            paths.format === "node-entry" ||
            (preflight?.status === "ready" &&
              preflight.runtimeFormat === "bun-standalone" &&
              preflight.supportsProtectedLauncher === true);
          return preflight?.status === "ready" &&
            preflight.version === expectedVersion &&
            runtimeQualified
            ? Effect.void
            : Effect.fail(
                makeRuntimeError({
                  code: "rejected-before-acceptance",
                  message: "The staged service preflight did not pass.",
                }),
              );
        }),
      );
}

/**
 * Live updater runtime, composed into the server's native updater chain.
 */
export const ServiceUpdateRuntimeLive = Layer.effect(
  ServiceUpdateRuntime,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const launcher = yield* ServiceLauncherClient;
    const sql = yield* SqlClient.SqlClient;
    const fileSystem = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const execPath = yield* HostProcessExecutablePath;
    const platform = yield* HostProcessPlatform;
    const architecture = yield* HostProcessArchitecture;
    return ServiceUpdateRuntime.of(
      makeServiceUpdateRuntime({
        launcher: { managed: launcher.managed, requestUpdate: launcher.requestUpdate },
        baseDir: config.baseDir,
        dbPath: config.dbPath,
        captureSource: makeCaptureSource({
          sql,
          fileSystem,
        }),
        desktopManaged: config.mode === "desktop",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        platform,
        architecture,
        validate: makePreflightValidate({ runner, execPath, dbPath: config.dbPath }),
      }),
    );
  }),
);
