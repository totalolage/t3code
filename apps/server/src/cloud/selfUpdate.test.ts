// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ServerSelfUpdateError, ServiceUpdateAttemptId, ThreadId } from "@t3tools/contracts";
import {
  HostProcessArchitecture,
  HostProcessExecutablePath,
  HostProcessIsExecutable,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as DesktopAppUpdate from "../desktopUpdate/DesktopAppUpdate.ts";
import * as ServiceUpdateAdmission from "../orchestration-v2/ServiceUpdateAdmission.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ServiceLauncherClient from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import {
  ServiceUpdateRuntime,
  ServiceUpdateSource,
  UpdateAuthority,
} from "./serviceUpdateServices.ts";
import * as ServerSelfUpdate from "./selfUpdate.ts";
import { makeUpdateAuthority } from "./updateAuthorityLive.ts";
import { resolveInstalledServiceRuntime, serviceRuntimeFiles } from "./serviceRuntime.ts";
import {
  makePreflightValidate,
  makeServiceUpdateRuntime,
  runtimeInstallPaths,
} from "./serviceUpdateRuntimeLive.ts";
import { makeServiceUpdateSource } from "./serviceUpdateSourceLive.ts";

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly managed?: boolean;
  readonly preflight?: "ready" | "numeric-ready" | "blocked";
  readonly preflightFormat?: "bun-standalone" | "node-sea";
  readonly requestUpdate?: ServiceLauncherClient.ServiceLauncherClient["Service"]["requestUpdate"];
  readonly desktopAppUpdate?: DesktopAppUpdate.DesktopAppUpdate["Service"];
  readonly authority?: UpdateAuthority["Service"];
  readonly hostExecutablePath?: string;
  readonly hostIsExecutable?: boolean;
  readonly executePreflight?: boolean;
  readonly preflightScript?: string;
  readonly preflightVersion?: string;
  readonly serviceUpdateRepository?: string;
  readonly sourceFetch?: typeof globalThis.fetch;
}

// The staged runtime is a release archive: the fake client serves SHA256SUMS
// and the tarball, and the fake runner stands in for tar before it answers
// the staged preflight.
const archiveBytes = new TextEncoder().encode("not really a tarball");
const releaseHttpClient = (order: string[]) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("/SHA256SUMS")) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", archiveBytes));
        const hex = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        return HttpClientResponse.fromWeb(
          request,
          new Response(`${hex}  t3-1.1.0-linux-x64.tar.gz\n`),
        );
      }
      order.push("download");
      return HttpClientResponse.fromWeb(request, new Response(archiveBytes));
    }),
  );

const F8Y_VERSION = "1.2.4-f8y.20260101.2";
const F8Y_TAG = `v${F8Y_VERSION}`;
const F8Y_BINARY_NAME = `t3-${F8Y_VERSION}-linux-x64`;
const F8Y_BINARY_BYTES = new TextEncoder().encode("verified raw F8Y t3 executable");
const F8Y_BINARY_DIGEST = NodeCrypto.createHash("sha256").update(F8Y_BINARY_BYTES).digest("hex");
const makeF8ySourceFetch = (requests: Array<string>): typeof globalThis.fetch =>
  Object.assign(
    async (input: string | Request | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.includes("/releases/tags/")) {
        return new Response(
          JSON.stringify({
            tag_name: F8Y_TAG,
            draft: false,
            prerelease: true,
            assets: [
              {
                name: F8Y_BINARY_NAME,
                browser_download_url: `https://github.com/owner/repo/releases/download/${F8Y_TAG}/${F8Y_BINARY_NAME}`,
              },
              {
                name: `${F8Y_BINARY_NAME}.sha256`,
                browser_download_url: `https://github.com/owner/repo/releases/download/${F8Y_TAG}/${F8Y_BINARY_NAME}.sha256`,
              },
            ],
          }),
        );
      }
      if (url.endsWith(`/${F8Y_BINARY_NAME}.sha256`)) {
        return new Response(`${F8Y_BINARY_DIGEST}  ${F8Y_BINARY_NAME}\n`);
      }
      if (url.endsWith(`/${F8Y_BINARY_NAME}`)) return new Response(F8Y_BINARY_BYTES);
      return new Response(null, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );

const reserveScheduled = (authority: ReturnType<typeof makeUpdateAuthority>) =>
  authority
    .reserve({
      owner: "scheduled",
      attemptId: ServiceUpdateAttemptId.make("11111111-1111-4111-8111-111111111111"),
    })
    .pipe(
      Effect.flatMap((result) =>
        result._tag === "owned"
          ? Effect.succeed(result.lease)
          : Effect.die(new Error("expected an owned scheduled update lease")),
      ),
    );

const makeHarness = Effect.fn("test.make_self_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-self-update-test-" });
  const order: string[] = [];
  const commands: Array<ProcessRunner.ProcessRunInput> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input);
        if (input.command === "tar") {
          order.push("extract");
          const stagingDir = input.args[input.args.indexOf("-C") + 1];
          if (stagingDir === undefined) return yield* Effect.die("missing tar target");
          yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
          return {
            stdout: "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        order.push("preflight");
        if (options.executePreflight === true) {
          const childResult = NodeChildProcess.spawnSync(input.command, [...input.args], {
            encoding: "utf8",
            env: input.env ?? process.env,
          });
          if (childResult.error !== undefined) {
            return yield* new ProcessRunner.ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause: childResult.error,
            });
          }
          return {
            stdout: childResult.stdout ?? "",
            stderr: childResult.stderr ?? "",
            code: ChildProcessSpawner.ExitCode(childResult.status ?? 1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }
        const result =
          options.preflight === "blocked"
            ? {
                status: "blocked",
                version: options.preflightVersion ?? "1.1.0",
                reason: "local update required",
              }
            : options.preflight === "numeric-ready"
              ? {
                  status: "ready",
                  version: options.preflightVersion ?? "1.1.0",
                  launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
                }
              : {
                  status: "ready",
                  version: options.preflightVersion ?? "1.1.0",
                  launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
                  runtimeFormat: options.preflightFormat ?? "bun-standalone",
                  supportsProtectedLauncher: true,
                };
        return {
          stdout: JSON.stringify(result),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  const launcher = ServiceLauncherClient.ServiceLauncherClient.of({
    managed: options.managed ?? true,
    requestUpdate:
      options.requestUpdate ??
      (() =>
        Effect.sync(() => {
          order.push("accept");
          return "launcher-id";
        })),
    prepareTrial: Effect.undefined,
  });
  const authority = options.authority ?? makeUpdateAuthority();
  const nativeContext = yield* Layer.build(ServiceUpdateAdmission.layer);
  const admission = Context.get(nativeContext, ServiceUpdateAdmission.ServiceUpdateAdmission);
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const sourceFetch: typeof globalThis.fetch =
    options.sourceFetch ??
    Object.assign(
      async () => {
        throw new Error("unexpected service update fetch");
      },
      { preconnect: globalThis.fetch.preconnect },
    );
  const updateSource = makeServiceUpdateSource({ fetch: sourceFetch, baseDir });
  const updateRuntime = makeServiceUpdateRuntime({
    launcher: { managed: launcher.managed, requestUpdate: launcher.requestUpdate },
    baseDir,
    dbPath: config.dbPath,
    captureSource: ({ fromVersion }) =>
      Effect.succeed({ databaseIdentity: config.dbPath, fromVersion }),
    desktopManaged: (options.mode ?? "web") === "desktop",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    platform: "linux",
    architecture: "x64",
    validate: makePreflightValidate({
      runner,
      execPath: options.hostExecutablePath ?? process.execPath,
      dbPath: config.dbPath,
    }),
  });
  const selfUpdate = yield* ServerSelfUpdate.make().pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(ServiceLauncherClient.ServiceLauncherClient, launcher),
    Effect.provideService(
      DesktopAppUpdate.DesktopAppUpdate,
      options.desktopAppUpdate ?? {
        available: false,
        run: () => Effect.die("unexpected desktop app update run"),
      },
    ),
    Effect.provideService(HttpClient.HttpClient, releaseHttpClient(order)),
    Effect.provideService(HostProcessPlatform, "linux"),
    Effect.provideService(HostProcessArchitecture, "x64"),
    Effect.provideService(UpdateAuthority, authority),
    Effect.provideService(ServiceUpdateSource, updateSource),
    Effect.provideService(ServiceUpdateRuntime, updateRuntime),
    Effect.provideService(ServiceUpdateAdmission.ServiceUpdateAdmission, admission),
    Effect.provideService(
      HostProcessExecutablePath,
      options.hostExecutablePath ?? process.execPath,
    ),
    Effect.provideService(HostProcessIsExecutable, options.hostIsExecutable ?? false),
    Effect.provide(
      Layer.mergeAll(
        ServerSettingsService.layerTest({
          serviceUpdateRepository: options.serviceUpdateRepository ?? "",
        }),
        ServerConfig.layer({ ...config, mode: options.mode ?? "web" }),
      ),
    ),
  );
  return { selfUpdate, order, commands, authority, baseDir, dbPath: config.dbPath, admission };
});

it.layer(NodeServices.layer)("server self update", (it) => {
  it.effect("marks running threads at the boot-service handoff", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({
                targetVersion: "1.1.0",
                method: "boot-service" as const,
                updateId: "update-id",
              }),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-running")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );

      expect(events).toEqual(["downloading", "prepare", "installing"]);
    }),
  );

  it.effect("marks desktop threads only when the prepared update commits", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-running-desktop");
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(
              Effect.as({
                targetVersion: "1.2.0",
                method: "desktop-app" as const,
                desktopUpdateToken: "desktop-token",
              }),
            ),
          commitDesktopUpdate: () =>
            Effect.sync(() => events.push("commit")).pipe(Effect.andThen(Effect.fail(commitError))),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [threadId];
        }),
        clear: (threadIds) => Effect.sync(() => void events.push(`clear:${threadIds.join(",")}`)),
      });

      yield* selfUpdate.update({ targetVersion: "1.2.0", continueRunningThreads: true }, (stage) =>
        Effect.sync(() => void events.push(stage)),
      );
      expect(events).toEqual(["installing"]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual(["installing", "prepare", "commit", `clear:${threadId}`]);
      expect(yield* selfUpdate.commitDesktopUpdate("desktop-token").pipe(Effect.flip)).toBe(
        commitError,
      );
      expect(events).toEqual([
        "installing",
        "prepare",
        "commit",
        `clear:${threadId}`,
        "prepare",
        "commit",
        `clear:${threadId}`,
      ]);
    }),
  );

  it.effect("reports a failed continuation-marker cleanup", () =>
    Effect.gen(function* () {
      const updateError = new ServerSelfUpdateError({ reason: "update failed" });
      const clearError = new ServerSelfUpdateError({ reason: "marker cleanup failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (_input, reportProgress = () => Effect.void) =>
            reportProgress("installing").pipe(Effect.andThen(Effect.fail(updateError))),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.succeed([ThreadId.make("thread-cleanup-failure")]),
        clear: () => Effect.fail(clearError),
      });

      expect(
        yield* selfUpdate
          .update({ targetVersion: "1.1.0", continueRunningThreads: true })
          .pipe(Effect.flip),
      ).toBe(clearError);
    }),
  );

  it.effect("keeps continuation markers after the boot-service handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "web",
        selfUpdate: {
          update: (
            _input,
            reportProgress = () => Effect.void,
            onHandoffAccepted = () => Effect.void,
          ) =>
            reportProgress("installing").pipe(
              Effect.andThen(onHandoffAccepted()),
              Effect.andThen(Effect.interrupt),
            ),
          commitDesktopUpdate: () => Effect.never,
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-boot-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      const exit = yield* selfUpdate
        .update({ targetVersion: "1.1.0", continueRunningThreads: true })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("keeps continuation markers after the desktop handoff is accepted", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "accepted-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(Effect.andThen(Effect.interrupt)),
        },
        prepare: Effect.sync(() => {
          events.push("prepare");
          return [ThreadId.make("thread-accepted-desktop-handoff")];
        }),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate
        .commitDesktopUpdate("accepted-desktop-token")
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(events).toEqual(["prepare"]);
    }),
  );

  it.effect("clears continuation markers for mixed failure and interrupt causes", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const commitError = new ServerSelfUpdateError({ reason: "install failed" });
      const selfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: "desktop",
        selfUpdate: {
          update: () =>
            Effect.succeed({
              targetVersion: "1.2.0",
              method: "desktop-app" as const,
              desktopUpdateToken: "failed-desktop-token",
            }),
          commitDesktopUpdate: (_requestId, onHandoffAccepted = () => Effect.void) =>
            onHandoffAccepted().pipe(
              Effect.andThen(
                Effect.failCause(
                  Cause.fromReasons([
                    Cause.makeFailReason(commitError),
                    Cause.makeInterruptReason(),
                  ]),
                ),
              ),
            ),
        },
        prepare: Effect.sync(() => [ThreadId.make("thread-failed-desktop-install")]),
        clear: () => Effect.sync(() => void events.push("clear")),
      });

      yield* selfUpdate.update({
        targetVersion: "1.2.0",
        continueRunningThreads: true,
      });
      const exit = yield* selfUpdate.commitDesktopUpdate("failed-desktop-token").pipe(Effect.exit);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
      }
      expect(events).toEqual(["clear"]);
    }),
  );

  it.effect("stages and preflights before asking the launcher for an update ID", () =>
    Effect.gen(function* () {
      const { selfUpdate, order, commands } = yield* makeHarness();
      expect(yield* selfUpdate.update({ targetVersion: "1.1.0" })).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
      expect(commands[1]?.env).toEqual({
        [SERVICE_LAUNCHER_CONTEXT_ENV]: undefined,
      });
    }),
  );

  it.effect("accepts explicit protected Node SEA preflight readiness", () =>
    Effect.gen(function* () {
      const { selfUpdate, order } = yield* makeHarness({ preflightFormat: "node-sea" });

      yield* selfUpdate.update({ targetVersion: "1.1.0" });

      expect(order).toEqual(["download", "extract", "preflight", "accept"]);
    }),
  );

  it.effect("validates and reuses a standalone cache without Node lookup or replacement", () =>
    Effect.gen(function* () {
      const { selfUpdate, commands, baseDir, order } = yield* makeHarness();
      const version = "1.1.0";
      const runtime = serviceRuntimeFiles(baseDir, version);
      const executable = Buffer.from("#!/bin/sh\nexit 0\n");
      NodeFS.mkdirSync(NodePath.dirname(runtime.standaloneExecutablePath), { recursive: true });
      NodeFS.writeFileSync(runtime.standaloneExecutablePath, executable);
      NodeFS.chmodSync(runtime.standaloneExecutablePath, 0o755);
      NodeFS.writeFileSync(runtime.sentinelPath, `${version}\n`);
      const before = {
        executable: NodeFS.readFileSync(runtime.standaloneExecutablePath),
        sentinel: NodeFS.readFileSync(runtime.sentinelPath, "utf8"),
      };

      expect((yield* selfUpdate.update({ targetVersion: version })).method).toBe("boot-service");
      expect(commands).toHaveLength(1);
      expect(commands[0]?.command).toBe(runtime.standaloneExecutablePath);
      expect(commands[0]?.args).toContain("__service-preflight");
      expect(order).toEqual(["preflight", "accept"]);
      expect(NodeFS.readFileSync(runtime.standaloneExecutablePath)).toEqual(before.executable);
      expect(NodeFS.readFileSync(runtime.sentinelPath, "utf8")).toBe(before.sentinel);
      expect(yield* Effect.promise(() => resolveInstalledServiceRuntime(baseDir, version))).toEqual(
        {
          format: "standalone-executable",
          versionDir: runtime.versionDir,
          executablePath: runtime.standaloneExecutablePath,
        },
      );
    }),
  );

  it.effect("uses a resolved Node interpreter for a cached legacy Node runtime", () =>
    Effect.gen(function* () {
      const nodeExecutable = yield* resolveCommandPath("node");
      const { selfUpdate, commands, baseDir } = yield* makeHarness({
        hostExecutablePath: process.execPath,
        hostIsExecutable: false,
        executePreflight: true,
      });
      const runtime = serviceRuntimeFiles(baseDir, "1.1.0");
      NodeFS.mkdirSync(NodePath.dirname(runtime.nodeEntryPath), { recursive: true });
      NodeFS.writeFileSync(
        runtime.nodeEntryPath,
        `if (process.argv[2] === "__service-preflight") {
  process.stdout.write(JSON.stringify({ status: "ready", version: "1.1.0", launcherProtocol: ${SERVICE_LAUNCHER_PROTOCOL} }));
}\n`,
      );
      NodeFS.writeFileSync(runtime.sentinelPath, "1.1.0\n");

      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" })).method).toBe("boot-service");
      expect(commands).toHaveLength(2);
      expect(commands[0]?.command).toBe(nodeExecutable);
      expect(commands[0]?.args[0]).toBe("-p");
      expect(commands[1]?.command).toBe(nodeExecutable);
      expect(commands[1]?.args[0]).toBe(runtime.nodeEntryPath);
      expect(commands[1]?.args.slice(1)).toEqual([
        "__service-preflight",
        "--database-path",
        expect.any(String),
        "--launcher-protocol",
        String(SERVICE_LAUNCHER_PROTOCOL),
      ]);
    }),
  );

  it.effect("rejects invalid versions and desktop-managed servers before staging", () =>
    Effect.gen(function* () {
      const web = yield* makeHarness();
      expect(
        (yield* web.selfUpdate.update({ targetVersion: "latest" }).pipe(Effect.flip)).reason,
      ).toBe("'latest' is not an exact t3 version.");
      const desktop = yield* makeHarness({ mode: "desktop" });
      expect(
        (yield* desktop.selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
      ).toContain("desktop app");
      expect([...web.order, ...desktop.order]).toEqual([]);
    }),
  );

  it.effect("delegates desktop-managed updates to the desktop app when available", () =>
    Effect.gen(function* () {
      const stages: string[] = [];
      const { selfUpdate, order } = yield* makeHarness({
        mode: "desktop",
        desktopAppUpdate: {
          available: true,
          run: (reportProgress) =>
            reportProgress("downloading").pipe(
              Effect.andThen(reportProgress("installing")),
              Effect.as({ targetVersion: "1.2.0", method: "desktop-app" as const }),
            ),
          commit: () => Effect.never,
        },
      });
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" }, (stage) =>
        Effect.sync(() => void stages.push(stage)),
      );
      expect(result).toEqual({ targetVersion: "1.2.0", method: "desktop-app" });
      expect(stages).toEqual(["downloading", "installing"]);
      // The launcher staging path must not run on the desktop path.
      expect(order).toEqual([]);
    }),
  );

  it.effect("preserves the preflight refusal reason", () =>
    Effect.gen(function* () {
      const { selfUpdate } = yield* makeHarness({ preflight: "blocked" });
      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "local update required",
      );
    }),
  );

  it.effect("refuses standalone preflight without protected-launcher capability", () =>
    Effect.gen(function* () {
      let launcherRequests = 0;
      const { selfUpdate, baseDir, order } = yield* makeHarness({
        preflight: "numeric-ready",
        requestUpdate: () =>
          Effect.sync(() => {
            launcherRequests += 1;
            return "unexpected-launcher-update";
          }),
      });

      const error = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
      expect(error.reason).toContain("Could not prepare t3@1.1.0");
      expect(order).toEqual(["download", "extract", "preflight"]);
      expect(launcherRequests).toBe(0);
      expect(NodeFS.existsSync(serviceRuntimeFiles(baseDir, "1.1.0").versionDir)).toBe(false);
    }),
  );

  it.effect("allows only one update at a time", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<string>();
      const { selfUpdate } = yield* makeHarness({
        requestUpdate: () =>
          Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      });
      const first = yield* Effect.forkChild(selfUpdate.update({ targetVersion: "1.1.0" }), {
        startImmediately: true,
      });
      yield* Deferred.await(requested);
      expect((yield* selfUpdate.update({ targetVersion: "1.1.1" }).pipe(Effect.flip)).reason).toBe(
        "A server update is already in progress.",
      );
      yield* Deferred.succeed(accepted, "launcher-id");
      expect((yield* Fiber.join(first)).updateId).toBe("launcher-id");
    }),
  );

  it.effect(
    "busy authority refuses before preflight or launcher IPC for either cached format",
    () =>
      Effect.gen(function* () {
        for (const format of ["node-entry", "standalone-executable"] as const) {
          const authority = makeUpdateAuthority();
          const scheduledLease = yield* reserveScheduled(authority);
          let launcherRequests = 0;
          const { selfUpdate, order, commands, baseDir } = yield* makeHarness({
            authority,
            requestUpdate: () =>
              Effect.sync(() => {
                launcherRequests += 1;
                return "unexpected-launcher-update";
              }),
          });
          const version = "1.1.0";
          const runtime = serviceRuntimeFiles(baseDir, version);
          NodeFS.mkdirSync(runtime.versionDir, { recursive: true });
          NodeFS.writeFileSync(runtime.sentinelPath, `${version}\n`);
          if (format === "node-entry") {
            NodeFS.mkdirSync(NodePath.dirname(runtime.nodeEntryPath), { recursive: true });
            NodeFS.writeFileSync(runtime.nodeEntryPath, "legacy-node-entry-sentinel\n");
          } else {
            const executable = Buffer.from("#!/bin/sh\nexit 0\n");
            NodeFS.mkdirSync(NodePath.dirname(runtime.standaloneExecutablePath), {
              recursive: true,
            });
            NodeFS.writeFileSync(runtime.standaloneExecutablePath, executable);
            NodeFS.chmodSync(runtime.standaloneExecutablePath, 0o755);
          }
          const before = {
            entry:
              format === "node-entry"
                ? NodeFS.readFileSync(runtime.nodeEntryPath)
                : NodeFS.readFileSync(runtime.standaloneExecutablePath),
            sentinel: NodeFS.readFileSync(runtime.sentinelPath, "utf8"),
          };

          expect(
            (yield* selfUpdate.update({ targetVersion: version }).pipe(Effect.flip)).reason,
          ).toBe("A server update is already in progress.");
          expect(order).toEqual([]);
          expect(commands).toEqual([]);
          expect(launcherRequests).toBe(0);
          expect(
            format === "node-entry"
              ? NodeFS.readFileSync(runtime.nodeEntryPath)
              : NodeFS.readFileSync(runtime.standaloneExecutablePath),
          ).toEqual(before.entry);
          expect(NodeFS.readFileSync(runtime.sentinelPath, "utf8")).toBe(before.sentinel);
          yield* scheduledLease.release;
        }
      }),
  );

  it.effect("a definite rejection releases the shared lease for other updates", () =>
    Effect.gen(function* () {
      const authority = makeUpdateAuthority();
      const { selfUpdate } = yield* makeHarness({
        authority,
        requestUpdate: ({ targetVersion }) =>
          Effect.fail(
            new ServiceLauncherClient.ServiceLauncherRejectedError({
              targetVersion,
              reason: "requires local update",
            }),
          ),
      });

      expect((yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason).toBe(
        "requires local update",
      );
      const scheduled = yield* reserveScheduled(authority);
      yield* scheduled.release;
      const manual = yield* authority.reserve({ owner: "manual" });
      expect(manual._tag).toBe("owned");
      if (manual._tag === "owned") yield* manual.lease.release;
    }),
  );

  it.effect("unknown launcher acknowledgements retain authority and report uncertainty", () =>
    Effect.gen(function* () {
      for (const operation of ["send", "disconnect", "timeout"] as const) {
        const authority = makeUpdateAuthority();
        let requestsSent = 0;
        const { selfUpdate, order } = yield* makeHarness({
          authority,
          requestUpdate: () =>
            Effect.sync(() => {
              requestsSent += 1;
            }).pipe(
              Effect.andThen(
                Effect.fail(new ServiceLauncherClient.ServiceLauncherClientError({ operation })),
              ),
            ),
        });

        const error = yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
        expect(error.reason).toContain("did not confirm update acceptance");
        expect(requestsSent).toBe(1);
        expect(
          (yield* authority.reserve({
            owner: "scheduled",
            attemptId: ServiceUpdateAttemptId.make("22222222-2222-4222-8222-222222222222"),
          }))._tag,
        ).toBe("busy");

        const orderBeforeRetry = [...order];
        expect(
          (yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip)).reason,
        ).toBe("A server update is already in progress.");
        expect(requestsSent).toBe(1);
        expect(order).toEqual(orderBeforeRetry);
      }
    }),
  );

  it.effect("pre-send launcher failures release authority", () =>
    Effect.gen(function* () {
      const authority = makeUpdateAuthority();
      const { selfUpdate } = yield* makeHarness({
        authority,
        requestUpdate: () =>
          Effect.fail(
            new ServiceLauncherClient.ServiceLauncherClientError({ operation: "unmanaged" }),
          ),
      });

      yield* selfUpdate.update({ targetVersion: "1.1.0" }).pipe(Effect.flip);
      const scheduled = yield* reserveScheduled(authority);
      yield* scheduled.release;
    }),
  );

  it.effect("accepted handoff retains the old lease and a fresh process has fresh authority", () =>
    Effect.gen(function* () {
      const { selfUpdate, authority } = yield* makeHarness();
      const result = yield* selfUpdate.update({ targetVersion: "1.1.0" });

      // Acceptance is the old process's last update fact; it cannot claim the
      // trial became ready or rolled back.
      expect(result).toEqual({
        targetVersion: "1.1.0",
        method: "boot-service",
        updateId: "launcher-id",
      });
      expect(
        (yield* authority.reserve({
          owner: "scheduled",
          attemptId: ServiceUpdateAttemptId.make("33333333-3333-4333-8333-333333333333"),
        }))._tag,
      ).toBe("busy");

      const nextProcessAuthority = makeUpdateAuthority();
      const nextProcessLease = yield* nextProcessAuthority.reserve({ owner: "manual" });
      expect(nextProcessLease._tag).toBe("owned");
      if (nextProcessLease._tag === "owned") yield* nextProcessLease.lease.release;
    }),
  );

  it.effect(
    "manual F8Y updates stage the configured standalone asset through native adoption",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const launcherRequests: Array<{ readonly targetVersion: string; readonly dbPath: string }> =
          [];
        const { selfUpdate, commands, baseDir, dbPath } = yield* makeHarness({
          serviceUpdateRepository: "owner/repo",
          sourceFetch: makeF8ySourceFetch(requests),
          preflightVersion: F8Y_VERSION,
          requestUpdate: (request) =>
            Effect.sync(() => {
              launcherRequests.push(request);
              return "f8y-update-id";
            }),
        });

        const result = yield* selfUpdate.update({ targetVersion: F8Y_VERSION });
        const runtime = runtimeInstallPaths(baseDir, F8Y_VERSION, "standalone-executable");
        const stagingParent = NodePath.join(baseDir, "runtime", "service-update-staging");

        expect(result).toEqual({
          targetVersion: F8Y_VERSION,
          method: "boot-service",
          updateId: "f8y-update-id",
        });
        expect(requests).toEqual([
          `https://api.github.com/repos/owner/repo/releases/tags/${F8Y_TAG}`,
          `https://github.com/owner/repo/releases/download/${F8Y_TAG}/${F8Y_BINARY_NAME}.sha256`,
          `https://github.com/owner/repo/releases/download/${F8Y_TAG}/${F8Y_BINARY_NAME}`,
        ]);
        expect([...NodeFS.readFileSync(runtime.executablePath)]).toEqual([...F8Y_BINARY_BYTES]);
        expect(NodeFS.readFileSync(runtime.sentinelPath, "utf8")).toBe(`${F8Y_VERSION}\n`);
        expect(NodeFS.statSync(runtime.executablePath).mode & 0o111).toBeGreaterThan(0);
        expect(NodeFS.readdirSync(stagingParent)).toEqual([]);
        expect(commands).toHaveLength(1);
        expect(commands[0]?.command).toMatch(/\/versions\/\.staging-[^/]+\/t3$/u);
        expect(commands[0]?.args).toContain("__service-preflight");
        expect(launcherRequests).toEqual([{ targetVersion: F8Y_VERSION, dbPath }]);
      }),
  );
});
