import {
  ServiceUpdateAttemptId,
  ServiceUpdateVersion,
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
  type ThreadId,
} from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";

import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as Schema from "effect/Schema";
import { CommandResolutionCache, resolveCommandPath } from "@t3tools/shared/shell";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  PinnedRuntimeInstallError,
  PinnedRuntimePreflightBlockedError,
} from "./pinnedRuntime.ts";
import { decodeServicePreflightResult } from "./servicePreflight.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import {
  isExactServiceVersion,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
} from "./serviceProtocol.ts";
import { resolveInstalledServiceRuntime } from "./serviceRuntime.ts";
import { isServiceUpdateTargetVersion } from "./serviceUpdateRelease.ts";
import { runtimeInstallPaths } from "./serviceUpdateRuntimeLive.ts";
import {
  ServiceUpdateRuntime,
  ServiceUpdateSource,
  UpdateAuthority,
} from "./serviceUpdateServices.ts";
import { UpdateAuthorityLive } from "./updateAuthorityLive.ts";

const PREFLIGHT_TIMEOUT = Duration.seconds(30);
const isServerSelfUpdateError = Schema.is(ServerSelfUpdateError);

const launcherOutcomeIsUnknown = (
  error:
    | ServiceLauncherClient.ServiceLauncherClientError
    | ServiceLauncherClient.ServiceLauncherRejectedError,
): boolean => {
  if (error._tag !== "ServiceLauncherClientError") return false;
  switch (error.operation) {
    case "send":
    case "disconnect":
    case "timeout":
      return true;
    case "decode-context":
    case "version-mismatch":
    case "ipc-unavailable":
    case "unmanaged":
      return false;
  }
};

const launcherFailureReason = (
  error:
    | ServiceLauncherClient.ServiceLauncherClientError
    | ServiceLauncherClient.ServiceLauncherRejectedError,
): string =>
  error._tag === "ServiceLauncherRejectedError"
    ? error.reason
    : launcherOutcomeIsUnknown(error)
      ? "The launcher did not confirm update acceptance; it may still be in progress."
      : error.message;

export function resolveServerSelfUpdateCapability(input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  if (input.desktopManaged) return "desktop-managed" as const;
  return input.launcherManaged ? ("boot-service" as const) : null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("t3/cloud/selfUpdate/ServerSelfUpdate") {}

export const withRunningThreadContinuation = Effect.fn(
  "cloud.server_self_update.withRunningThreadContinuation",
)(function* (input: {
  readonly mode: ServerConfig.RuntimeMode;
  readonly selfUpdate: ServerSelfUpdate["Service"];
  readonly prepare: Effect.Effect<ReadonlyArray<ThreadId>, ServerSelfUpdateError>;
  readonly clear: (
    threadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<void, ServerSelfUpdateError>;
}) {
  const desktopContinuationTokens = yield* Ref.make(HashSet.empty<string>());
  const clearOnError = <A>(
    effect: Effect.Effect<A, ServerSelfUpdateError>,
    threadIds: () => ReadonlyArray<ThreadId>,
    handoffAccepted: () => boolean,
  ): Effect.Effect<A, ServerSelfUpdateError> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        (handoffAccepted() && Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : input.clear(threadIds())
        ).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    );

  const update: ServerSelfUpdate["Service"]["update"] = (
    request,
    reportProgress = () => Effect.void,
  ) => {
    let prepared = false;
    let handoffAccepted = false;
    let continuationThreadIds: ReadonlyArray<ThreadId> = [];
    return clearOnError(
      input.selfUpdate
        .update(
          request,
          (stage) =>
            (request.continueRunningThreads === true &&
            input.mode !== "desktop" &&
            stage === "installing" &&
            !prepared
              ? input.prepare.pipe(
                  Effect.tap((threadIds) =>
                    Effect.sync(() => {
                      prepared = true;
                      continuationThreadIds = threadIds;
                    }),
                  ),
                  Effect.asVoid,
                )
              : Effect.void
            ).pipe(Effect.andThen(reportProgress(stage))),
          () =>
            Effect.sync(() => {
              handoffAccepted = true;
            }),
        )
        .pipe(
          Effect.tap((result) => {
            if (
              result.method === "desktop-app" &&
              result.desktopUpdateToken !== undefined &&
              request.continueRunningThreads === true
            ) {
              return Ref.update(desktopContinuationTokens, HashSet.add(result.desktopUpdateToken));
            }
            return Effect.void;
          }),
        ),
      () => continuationThreadIds,
      () => handoffAccepted,
    );
  };

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId) =>
      Effect.gen(function* () {
        const shouldContinue = yield* Ref.modify(desktopContinuationTokens, (tokens) => [
          HashSet.has(tokens, requestId),
          HashSet.remove(tokens, requestId),
        ]);
        let handoffAccepted = false;
        let continuationThreadIds: ReadonlyArray<ThreadId> = [];
        return yield* clearOnError(
          Effect.gen(function* () {
            continuationThreadIds = shouldContinue ? yield* input.prepare : [];
            return yield* input.selfUpdate.commitDesktopUpdate(requestId, () =>
              Effect.sync(() => {
                handoffAccepted = true;
              }),
            );
          }),
          () => continuationThreadIds,
          () => handoffAccepted,
        ).pipe(
          Effect.catchCause((cause) =>
            (shouldContinue && !handoffAccepted
              ? Ref.update(desktopContinuationTokens, HashSet.add(requestId))
              : Effect.void
            ).pipe(Effect.andThen(Effect.failCause(cause))),
          ),
        );
      }),
  });
});

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const desktopAppUpdate = yield* DesktopAppUpdate.DesktopAppUpdate;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  // Archive-distributed targets download from GitHub Releases; tests inject a
  // client to control that transfer.
  const httpClient = yield* HttpClient.HttpClient;
  const releaseBaseUrl = Option.getOrUndefined(
    yield* Config.String(CLI_RELEASE_BASE_URL_ENV).pipe(Config.option),
  );
  const authority = yield* UpdateAuthority;
  const settings = yield* ServerSettingsService;
  const updateSource = yield* ServiceUpdateSource;
  const updateRuntime = yield* ServiceUpdateRuntime;
  const hostExecutablePath = yield* HostProcessExecutablePath;
  const hostIsExecutable = yield* HostProcessIsExecutable;

  const capability: ServerSelfUpdateCapability | null =
    serverConfig.mode === "desktop" ? "desktop-managed" : launcher.managed ? "boot-service" : null;
  const failWith = (reason: string, cause?: unknown) =>
    cause === undefined
      ? new ServerSelfUpdateError({ reason })
      : new ServerSelfUpdateError({ reason, cause });

  const runPreflight = (
    command: string,
    args: ReadonlyArray<string>,
    targetVersion: string,
    requireProtectedLauncher: boolean,
  ): Effect.Effect<void, PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError> =>
    runner
      .run({
        command,
        args,
        env: {
          [SERVICE_LAUNCHER_CONTEXT_ENV]: undefined,
        },
        timeout: PREFLIGHT_TIMEOUT,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "running the staged service preflight",
              cause,
            }),
        ),
        Effect.flatMap(
          (
            result,
          ): Effect.Effect<
            void,
            PinnedRuntimeInstallError | PinnedRuntimePreflightBlockedError
          > => {
            if (result.code !== 0) {
              return Effect.fail(
                new PinnedRuntimeInstallError({
                  step: "running the staged service preflight",
                  exitCode: Number(result.code),
                  stdoutLength: result.stdout.length,
                  stderrLength: result.stderr.length,
                }),
              );
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(result.stdout.trim());
            } catch (cause) {
              return Effect.fail(
                new PinnedRuntimeInstallError({
                  step: "decoding the staged service preflight",
                  cause,
                }),
              );
            }
            const preflight = decodeServicePreflightResult(parsed);
            const runtimeQualified =
              !requireProtectedLauncher ||
              preflight?.status !== "ready" ||
              (preflight?.status === "ready" &&
                (preflight.runtimeFormat === "bun-standalone" ||
                  preflight.runtimeFormat === "node-sea") &&
                preflight.supportsProtectedLauncher === true);
            if (
              preflight === undefined ||
              preflight.version !== targetVersion ||
              !runtimeQualified
            ) {
              return Effect.fail(
                new PinnedRuntimeInstallError({
                  step: "verifying the staged service preflight",
                }),
              );
            }
            return preflight.status === "ready"
              ? Effect.void
              : Effect.fail(
                  new PinnedRuntimePreflightBlockedError({
                    version: targetVersion,
                    reason: preflight.reason,
                  }),
                );
          },
        ),
      );

  const resolveLegacyNodeExecutable = Effect.fn("cloud.server_self_update.resolve_legacy_node")(
    function* () {
      const nodeExecutable = yield* resolveCommandPath(
        platform === "win32" ? "node.exe" : "node",
      ).pipe(
        Effect.provideService(CommandResolutionCache, new Map()),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "resolving Node for the cached legacy runtime",
              cause,
            }),
        ),
      );
      const hostRealPath = yield* fs.realPath(hostExecutablePath).pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "checking the host executable for the cached legacy runtime",
              cause,
            }),
        ),
      );
      const nodeRealPath = yield* fs.realPath(nodeExecutable).pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "checking the resolved Node executable",
              cause,
            }),
        ),
      );
      if (hostIsExecutable && hostRealPath === nodeRealPath) {
        return yield* new PinnedRuntimeInstallError({
          step: "resolving a separate Node interpreter for the cached legacy runtime",
        });
      }
      const identity = yield* runner
        .run({
          command: nodeExecutable,
          args: [
            "-p",
            "process.release && process.release.name === 'node' && !process.versions.bun ? 'node' : 'other'",
          ],
          timeout: PREFLIGHT_TIMEOUT,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PinnedRuntimeInstallError({
                step: "checking the resolved Node interpreter",
                cause,
              }),
          ),
        );
      if (identity.code !== 0 || identity.stdout.trim() !== "node") {
        return yield* new PinnedRuntimeInstallError({
          step: "checking the resolved Node interpreter",
          exitCode: Number(identity.code),
          stdoutLength: identity.stdout.length,
          stderrLength: identity.stderr.length,
        });
      }
      return nodeExecutable;
    },
  );

  const update: ServerSelfUpdate["Service"]["update"] = Effect.fn(
    "cloud.server_self_update.update",
  )(function* (input, reportProgress = () => Effect.void, onHandoffAccepted = () => Effect.void) {
    if (capability === "desktop-managed") {
      // input.targetVersion is meaningless here: the desktop app's own
      // update feed decides what it downloads, and the result carries what
      // it actually got.
      if (desktopAppUpdate.available) {
        return yield* desktopAppUpdate.run(reportProgress);
      }
      return yield* failWith(
        "This server is managed by the T3 Code desktop app on its machine; update the desktop app to update it.",
      );
    }
    if (capability === null) {
      return yield* failWith(
        "Remote updates require the T3 Code background service. Run `t3 service install` on the server machine.",
      );
    }

    const targetVersion = input.targetVersion.trim();
    if (!isExactServiceVersion(targetVersion)) {
      return yield* failWith(`'${targetVersion}' is not an exact t3 version.`);
    }
    const reserved = yield* authority
      .reserve({ owner: "manual" })
      .pipe(
        Effect.mapError((cause) =>
          failWith("Could not reserve the server update authority.", cause),
        ),
      );
    if (reserved._tag === "busy") {
      return yield* failWith("A server update is already in progress.");
    }
    const lease = reserved.lease;
    let launcherOutcomeUnknown = false;
    let launcherAccepted = false;
    let sourceCapture: import("./serviceUpdateServices.ts").ServiceUpdateSourceCapture | undefined;

    return yield* Effect.gen(function* () {
      yield* reportProgress("downloading");
      const installedRuntime = yield* Effect.tryPromise({
        try: () => resolveInstalledServiceRuntime(serverConfig.baseDir, targetVersion),
        catch: (cause) =>
          new PinnedRuntimeInstallError({
            step: "checking the cached runtime",
            cause,
          }),
      }).pipe(
        Effect.mapError((error) => failWith(`Could not prepare t3@${targetVersion}.`, error)),
      );
      let runtimePath: string;
      if (installedRuntime?.format === "node-entry") {
        const nodeExecutable = yield* resolveLegacyNodeExecutable().pipe(
          Effect.mapError((error) => failWith(`Could not prepare t3@${targetVersion}.`, error)),
        );
        yield* runPreflight(
          nodeExecutable,
          [
            installedRuntime.executablePath,
            "__service-preflight",
            "--database-path",
            serverConfig.dbPath,
            "--launcher-protocol",
            String(SERVICE_LAUNCHER_PROTOCOL),
          ],
          targetVersion,
          false,
        ).pipe(
          Effect.mapError((error) =>
            error._tag === "PinnedRuntimePreflightBlockedError"
              ? failWith(error.reason, error)
              : failWith(`Could not prepare t3@${targetVersion}.`, error),
          ),
        );
        runtimePath = installedRuntime.executablePath;
      } else if (installedRuntime === undefined && isServiceUpdateTargetVersion(targetVersion)) {
        const availability = yield* updateRuntime.availability.pipe(
          Effect.mapError((error) => failWith("Could not prepare the service runtime.", error)),
        );
        if (availability.status === "unsupported") {
          return yield* failWith(
            `Service updates are unavailable on this runtime (${availability.reason}).`,
          );
        }
        const repository = yield* settings.getSettings.pipe(
          Effect.map((current) => current.serviceUpdateRepository),
          Effect.mapError((error) =>
            failWith("Could not read the configured update source.", error),
          ),
        );
        const candidate = yield* updateSource
          .resolveTargetVersion({ repository, targetVersion })
          .pipe(
            Effect.mapError((error) => failWith(`Could not prepare t3@${targetVersion}.`, error)),
          );
        if (candidate.version !== targetVersion) {
          return yield* failWith("The configured update source returned a different version.");
        }
        const staged = yield* updateSource
          .stage(
            {
              attemptId: ServiceUpdateAttemptId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
              candidate,
            },
            () => Effect.void,
          )
          .pipe(
            Effect.mapError((error) => failWith(`Could not prepare t3@${targetVersion}.`, error)),
          );
        sourceCapture = yield* Effect.acquireUseRelease(
          Effect.succeed(staged),
          (stagedRuntime) =>
            Effect.gen(function* () {
              yield* updateRuntime
                .adopt(stagedRuntime)
                .pipe(
                  Effect.mapError((error) =>
                    failWith(`Could not prepare t3@${targetVersion}.`, error),
                  ),
                );
              return yield* updateRuntime
                .captureSource({ fromVersion: ServiceUpdateVersion.make(packageJson.version) })
                .pipe(
                  Effect.mapError((error) =>
                    failWith("Could not identify the active server database.", error),
                  ),
                );
            }),
          (stagedRuntime) =>
            updateSource
              .discard(stagedRuntime)
              .pipe(
                Effect.mapError((error) =>
                  failWith("Could not clean up the staged update.", error),
                ),
              ),
        );
        runtimePath = runtimeInstallPaths(
          serverConfig.baseDir,
          targetVersion,
          "standalone-executable",
        ).executablePath;
      } else {
        const paths = yield* ensurePinnedRuntimeInstalled({
          baseDir: serverConfig.baseDir,
          version: targetVersion,
          fs,
          path,
          runner,
          httpClient,
          platform,
          arch,
          releaseBaseUrl,
          validate: (runtime) => {
            const command = pinnedRuntimeCommand(runtime);
            return runPreflight(
              command.command,
              [
                ...command.args,
                "__service-preflight",
                "--database-path",
                serverConfig.dbPath,
                "--launcher-protocol",
                String(SERVICE_LAUNCHER_PROTOCOL),
              ],
              targetVersion,
              true,
            );
          },
        }).pipe(
          Effect.mapError((error) =>
            error._tag === "PinnedRuntimePreflightBlockedError"
              ? failWith(error.reason, error)
              : failWith(`Could not prepare t3@${targetVersion}.`, error),
          ),
        );
        runtimePath = paths.entryPath;
      }

      yield* reportProgress("installing");
      const handoff =
        sourceCapture === undefined
          ? launcher.requestUpdate({ targetVersion, dbPath: serverConfig.dbPath }).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  launcherOutcomeUnknown = launcherOutcomeIsUnknown(error);
                }),
              ),
              Effect.mapError((error) => failWith(launcherFailureReason(error), error)),
            )
          : updateRuntime
              .requestHandoff({
                targetVersion: ServiceUpdateVersion.make(targetVersion),
                source: sourceCapture,
                authorityLease: lease,
              })
              .pipe(
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    launcherOutcomeUnknown = error.code === "acceptance-unknown";
                  }),
                ),
                Effect.map(({ updateId }) => updateId),
                Effect.mapError((error) =>
                  failWith(
                    error.code === "rejected-before-acceptance"
                      ? "The service launcher rejected the update before acceptance."
                      : error.code === "acceptance-unknown"
                        ? "The launcher did not confirm update acceptance; it may still be in progress."
                        : "Could not hand off the service update.",
                    error,
                  ),
                ),
              );
      const updateId = yield* Effect.uninterruptible(
        lease.enterIrreversible.pipe(
          Effect.mapError((cause) =>
            failWith("Could not make the update handoff irreversible.", cause),
          ),
          Effect.andThen(
            Effect.sync(() => {
              // Once requestUpdate starts, an unexpected failure may have
              // crossed the IPC boundary. Only typed, provably pre-send errors
              // and an explicit rejection make release safe.
              launcherOutcomeUnknown = true;
            }),
          ),
          Effect.andThen(
            handoff.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  launcherAccepted = true;
                }),
              ),
              Effect.tap(() => onHandoffAccepted()),
            ),
          ),
        ),
      );

      yield* Effect.logInfo("Server update prepared; handing off to the service launcher.", {
        updateId,
        targetVersion,
        runtimePath,
      });
      return { targetVersion, method: "boot-service" as const, updateId };
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !launcherAccepted && !launcherOutcomeUnknown
          ? Effect.ignore(lease.release)
          : Effect.void,
      ),
    );
  });

  return ServerSelfUpdate.of({
    update,
    commitDesktopUpdate: (requestId, onHandoffAccepted) =>
      desktopAppUpdate.commit(requestId, onHandoffAccepted),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make()).pipe(
  Layer.provide(ProcessRunner.layer),
  // The scheduler composes this exact module-level Layer as well; its
  // reservation state serializes manual preparation with scheduled updates.
  Layer.provide(UpdateAuthorityLive),
);
