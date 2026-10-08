import { DEFAULT_TAILSCALE_SERVE_PORT } from "@t3tools/tailscale";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import { resolveBaseDir } from "../os-jank.ts";
import {
  isProcessAlive,
  readPersistedServerRuntimeState,
  type PersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  makeRemoteCliApi,
  normalizeRemoteHttpBaseUrl,
  requestRemoteCli,
  RemoteCliError,
} from "./remoteHttp.ts";

export { RemoteCliError } from "./remoteHttp.ts";

import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";

const LOCAL_DESCRIPTOR_TIMEOUT = Duration.seconds(1);
const DEV_VARIANT_PLACEHOLDER_URL = new URL("http://localhost");

type RemoteCliTargetCommon = {
  readonly httpBaseUrl: string;
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly tokenStateDirectory: string;
  readonly tokenKey: string;
};

export type RemoteCliTarget =
  | (RemoteCliTargetCommon & { readonly kind: "remote" })
  | (RemoteCliTargetCommon & {
      readonly kind: "local";
      readonly serverConfig: ServerConfig.ServerConfig["Service"];
    });

export interface ResolveCliTargetInput {
  readonly host?: string;
  readonly baseDir?: string;
}

type LocalTargetCandidate = {
  readonly baseDir: string;
  readonly variant: "userdata" | "dev";
  readonly derivedPaths: ServerConfig.ServerDerivedPaths;
  readonly state: PersistedServerRuntimeState;
};

const fetchEnvironmentDescriptor = (httpBaseUrl: string, timeout?: Duration.Duration) =>
  Effect.gen(function* () {
    const api = yield* Effect.try({
      try: () => makeRemoteCliApi(httpBaseUrl),
      catch: () => new RemoteCliError({ reason: "request-failed" }),
    }).pipe(Effect.flatten);
    const request = yield* Effect.try({
      try: () => requestRemoteCli(api.metadata.descriptor()),
      catch: () => new RemoteCliError({ reason: "request-failed" }),
    });
    const normalizedRequest = request.pipe(
      Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })),
    );
    if (timeout === undefined) {
      return yield* normalizedRequest;
    }

    return yield* normalizedRequest.pipe(
      Effect.timeoutOption(timeout),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new RemoteCliError({ reason: "request-failed" })),
          onSome: Effect.succeed,
        }),
      ),
    );
  });

const resolveCandidateBaseDirs = Effect.fn("remoteCli.resolveCandidateBaseDirs")(function* (
  explicitBaseDir: string | undefined,
) {
  const baseDirs: Array<string> = [];
  if (explicitBaseDir !== undefined && explicitBaseDir.trim().length > 0) {
    baseDirs.push(yield* resolveBaseDir(explicitBaseDir));
    return baseDirs;
  }

  const worktreeHome = yield* resolveWorktreeT3Home(process.cwd());
  if (worktreeHome !== undefined) {
    baseDirs.push(worktreeHome);
  }

  const environment = yield* HostProcessEnvironment;
  baseDirs.push(yield* resolveBaseDir(environment.T3CODE_HOME));
  return [...new Set(baseDirs)];
});

const makePinnedLocalServerConfig = Effect.fn("remoteCli.makePinnedLocalServerConfig")(function* (
  input: LocalTargetCandidate,
) {
  const devUrl = yield* Effect.try({
    try: () => (input.state.devUrl === undefined ? undefined : new URL(input.state.devUrl)),
    catch: () => new RemoteCliError({ reason: "local-server-mismatch" }),
  });

  return ServerConfig.make({
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: input.state.port,
    host: input.state.host,
    cwd: process.cwd(),
    baseDir: input.baseDir,
    ...input.derivedPaths,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
  });
});

const resolveLocalTarget = Effect.fn("remoteCli.resolveLocalTarget")(function* (
  explicitBaseDir: string | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDirs = yield* resolveCandidateBaseDirs(explicitBaseDir);
  let foundMismatch = false;

  for (const baseDir of baseDirs) {
    for (const variant of ["userdata", "dev"] as const) {
      const derivedPaths = yield* ServerConfig.deriveServerPaths(
        baseDir,
        variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
        {},
      );
      const persisted = yield* readPersistedServerRuntimeState(
        derivedPaths.serverRuntimeStatePath,
      ).pipe(Effect.provideService(References.MinimumLogLevel, "Error"));
      if (Option.isNone(persisted) || !isProcessAlive(persisted.value.pid)) {
        continue;
      }

      const descriptor = yield* Effect.result(
        fetchEnvironmentDescriptor(persisted.value.origin, LOCAL_DESCRIPTOR_TIMEOUT),
      );
      if (descriptor._tag === "Failure") {
        continue;
      }

      const environmentId = yield* fileSystem.readFileString(derivedPaths.environmentIdPath).pipe(
        Effect.map((value) => value.trim()),
        Effect.orElseSucceed(() => ""),
      );
      if (environmentId.length === 0 || descriptor.success.environmentId !== environmentId) {
        foundMismatch = true;
        continue;
      }

      const candidate = {
        baseDir,
        variant,
        derivedPaths,
        state: persisted.value,
      } satisfies LocalTargetCandidate;
      const serverConfig = yield* Effect.result(makePinnedLocalServerConfig(candidate));
      if (serverConfig._tag === "Failure") {
        foundMismatch = true;
        continue;
      }

      return {
        kind: "local",
        httpBaseUrl: persisted.value.origin,
        environment: descriptor.success,
        tokenStateDirectory: path.join(derivedPaths.stateDir, "local-cli"),
        tokenKey: `environment:${descriptor.success.environmentId}`,
        serverConfig: serverConfig.success,
      } satisfies RemoteCliTarget;
    }
  }

  return yield* new RemoteCliError({
    reason: foundMismatch ? "local-server-mismatch" : "local-server-not-running",
  });
});

const resolveRemoteTarget = Effect.fn("remoteCli.resolveRemoteTarget")(function* (
  input: ResolveCliTargetInput & { readonly host: string },
) {
  const path = yield* Path.Path;
  const baseDir = yield* resolveBaseDir(input.baseDir);
  const httpBaseUrl = yield* normalizeRemoteHttpBaseUrl(input.host);
  const environment = yield* fetchEnvironmentDescriptor(httpBaseUrl);
  const tokenKey = new URL(httpBaseUrl).origin;

  return {
    kind: "remote",
    httpBaseUrl,
    environment,
    tokenStateDirectory: path.join(baseDir, "remote-cli"),
    tokenKey,
  } satisfies RemoteCliTarget;
});

export const resolveCliTarget = Effect.fn("remoteCli.resolveCliTarget")(function* (
  input: ResolveCliTargetInput = {},
) {
  if (input.host !== undefined) {
    return yield* resolveRemoteTarget({ ...input, host: input.host });
  }
  return yield* resolveLocalTarget(input.baseDir);
});
