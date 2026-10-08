import {
  DATABASE_INCOMPATIBLE_EXIT_CODE,
  type DesktopBackendTerminalFailure,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

const terminalBackendConfig: DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  extendEnv: true,
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopTelemetryFd: 4,
    desktopTelemetryControlFd: 5,
  },
  bootstrapDelivery: "fd3",
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

function makeTerminalProcess(
  exitCode: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>,
): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode,
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

function makeStubInstance(
  id: DesktopBackendPool.BackendInstanceId,
  label: string,
): DesktopBackendPool.DesktopBackendInstance {
  const snapshot: DesktopBackendSnapshot = {
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  };
  return {
    id,
    label: Effect.succeed(label),
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

function makePoolLayer(
  labelRef: Ref.Ref<string>,
  options: {
    readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
    readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
    readonly outputLogFactoryLayer?: Layer.Layer<DesktopObservability.DesktopBackendOutputLogFactory>;
    readonly configurationLayer?: Layer.Layer<DesktopBackendConfiguration.DesktopBackendConfiguration>;
  } = {},
): Layer.Layer<DesktopBackendPool.DesktopBackendPool> {
  return DesktopBackendPool.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        FileSystem.layerNoop({
          exists: () => Effect.succeed(true),
        }),
        options.spawnerLayer ??
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() => Effect.die("unexpected child process spawn")),
          ),
        options.httpClientLayer ??
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected HTTP request")),
          ),
        options.outputLogFactoryLayer ??
          Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
            forInstance: () =>
              Effect.succeed({
                beginSession: () => Effect.void,
                writeOutputChunk: () => Effect.void,
                persistFailureSnapshot: () => Effect.void,
                persistFailure: () => Effect.void,
                discardSession: Effect.void,
              } satisfies DesktopObservability.DesktopBackendOutputLogShape),
          } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
        Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
          latest: Effect.succeedNone,
          changes: Stream.empty,
          encoded: Stream.empty,
          handleControlForSource: () => Effect.void,
          removeControlSource: () => Effect.void,
          publishUpdateReport: () => Effect.void,
          updateRequests: Stream.empty,
          updateCommits: Stream.empty,
          updateCancellations: Stream.empty,
        }),
        DesktopBrowserHost.layer,
        options.configurationLayer ??
          Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
            resolvePrimary: Effect.die("unexpected primary config resolve"),
            resolvePrimaryLabel: Ref.get(labelRef),
            resolveWsl: () => Effect.die("unexpected WSL config resolve"),
            currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
          } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
        DesktopAppSettings.layerTest(),
        DesktopWslEnvironment.layerTest(),
        ElectronDialog.layer,
        Layer.succeed(DesktopWindow.DesktopWindow, {
          createMain: Effect.die("unexpected window create"),
          ensureMain: Effect.die("unexpected window ensure"),
          revealOrCreateMain: Effect.die("unexpected window reveal"),
          activate: Effect.die("unexpected window activate"),
          createMainIfBackendReady: Effect.die("unexpected window create"),
          showConnectingSplash: Effect.void,
          handleBackendReady: () => Effect.void,
          handleBackendNotReady: Effect.void,
          flushMainWindowBounds: Effect.void,
          prepareCaptureReveal: Effect.void,
          dispatchMenuAction: () => Effect.die("unexpected menu action"),
          dispatchSnapShotEvent: () => Effect.void,
          zoomMain: () => Effect.die("unexpected zoom"),
          syncAppearance: Effect.void,
        } satisfies DesktopWindow.DesktopWindow["Service"]),
      ),
    ),
  );
}

describe("DesktopBackendPool", () => {
  it.effect("layerTest exposes registered instances by id", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const fetchedPrimary = yield* pool.get(DesktopBackendPool.PRIMARY_INSTANCE_ID);
      const fetchedWsl = yield* pool.get(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"));
      const fetchedMissing = yield* pool.get(DesktopBackendPool.BackendInstanceId("missing"));
      const all = yield* pool.list;
      const resolvedPrimary = yield* pool.primary;

      assert.equal(yield* Option.getOrThrow(fetchedPrimary).label, "Windows");
      assert.equal(yield* Option.getOrThrow(fetchedWsl).label, "WSL (Ubuntu)");
      assert.isTrue(Option.isNone(fetchedMissing));
      assert.lengthOf(all, 2);
      // First instance becomes primary in layerTest so single-instance
      // stubs don't have to wire an explicit primary.
      assert.equal(resolvedPrimary.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
          makeStubInstance(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"), "WSL (Ubuntu)"),
        ]),
      ),
    ),
  );

  it.effect("layerTest dies when no instances are supplied", () =>
    Effect.exit(
      DesktopBackendPool.DesktopBackendPool.pipe(Effect.provide(DesktopBackendPool.layerTest([]))),
    ).pipe(Effect.map((exit) => assert.equal(exit._tag, "Failure"))),
  );

  it.effect("resolves the primary label lazily after pool layer construction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const pool = yield* DesktopBackendPool.DesktopBackendPool.pipe(
          Effect.provide(makePoolLayer(labelRef)),
        );
        const primary = yield* pool.primary;

        yield* Ref.set(labelRef, "WSL (Ubuntu)");

        assert.equal(yield* primary.label, "WSL (Ubuntu)");
      }),
    ),
  );

  it.effect("completes the terminal receipt only for the primary instance", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const labelRef = yield* Ref.make("Windows");
        const readinessRequests = yield* Queue.unbounded<void>();
        const primaryExit = yield* Deferred.make<void>();
        const secondaryExit = yield* Deferred.make<void>();
        const persistedFailures = yield* Queue.unbounded<string>();
        let spawnCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            const exit = spawnCount === 0 ? primaryExit : secondaryExit;
            spawnCount += 1;
            return Effect.succeed(
              makeTerminalProcess(
                Deferred.await(exit).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(DATABASE_INCOMPATIBLE_EXIT_CODE)),
                ),
              ),
            );
          }),
        );
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Queue.offer(readinessRequests, void 0).pipe(Effect.andThen(Effect.never)),
          ),
        );
        const outputLogFactoryLayer = Layer.succeed(
          DesktopObservability.DesktopBackendOutputLogFactory,
          {
            forInstance: (id) =>
              Effect.succeed({
                beginSession: () => Effect.void,
                writeOutputChunk: () => Effect.void,
                persistFailureSnapshot: () => Effect.void,
                persistFailure: ({ details }) =>
                  Queue.offer(persistedFailures, `${id}:${details}`).pipe(Effect.asVoid),
                discardSession: Effect.void,
              } satisfies DesktopObservability.DesktopBackendOutputLogShape),
          } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"],
        );
        const configurationLayer = Layer.succeed(
          DesktopBackendConfiguration.DesktopBackendConfiguration,
          {
            resolvePrimary: Effect.succeed(terminalBackendConfig),
            resolvePrimaryLabel: Effect.succeed("Windows"),
            resolveWsl: () => Effect.succeed(terminalBackendConfig),
            currentBootstrapToken: Effect.die("unexpected bootstrap token read"),
          } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"],
        );

        yield* Effect.gen(function* () {
          const pool = yield* DesktopBackendPool.DesktopBackendPool;
          const primary = yield* pool.primary;
          const primaryFailure = yield* pool.awaitPrimaryTerminalFailure.pipe(Effect.forkChild);

          yield* primary.start;
          yield* Queue.take(readinessRequests);

          const secondary = yield* pool.register({
            id: DesktopBackendPool.BackendInstanceId("wsl:Ubuntu"),
            label: Effect.succeed("WSL (Ubuntu)"),
            configResolve: Effect.succeed(terminalBackendConfig),
          });
          yield* secondary.start;
          yield* Queue.take(readinessRequests);
          yield* Deferred.succeed(secondaryExit, void 0);
          assert.equal(
            yield* Queue.take(persistedFailures),
            `wsl:Ubuntu:pid=123 code=${DATABASE_INCOMPATIBLE_EXIT_CODE}`,
          );
          const stoppedSecondary = yield* secondary.snapshot;
          assert.equal(stoppedSecondary.desiredRunning, false);
          assert.equal(stoppedSecondary.ready, false);
          assert.isTrue(Option.isNone(stoppedSecondary.activePid));
          assert.equal(stoppedSecondary.restartScheduled, false);
          assert.isUndefined(primaryFailure.pollUnsafe());

          yield* Deferred.succeed(primaryExit, void 0);
          assert.deepEqual(yield* Fiber.join(primaryFailure), {
            _tag: "DatabaseIncompatible",
          } satisfies DesktopBackendTerminalFailure);
          assert.equal(
            yield* Queue.take(persistedFailures),
            `primary:pid=123 code=${DATABASE_INCOMPATIBLE_EXIT_CODE}`,
          );
          const stoppedPrimary = yield* primary.snapshot;
          assert.equal(stoppedPrimary.desiredRunning, false);
          assert.equal(stoppedPrimary.ready, false);
          assert.isTrue(Option.isNone(stoppedPrimary.activePid));
          assert.equal(stoppedPrimary.restartScheduled, false);

          // The Deferred is durable: a later await observes the original
          // primary receipt instead of waiting for another process run.
          assert.deepEqual(yield* pool.awaitPrimaryTerminalFailure, {
            _tag: "DatabaseIncompatible",
          });
        }).pipe(
          Effect.provide(
            makePoolLayer(labelRef, {
              spawnerLayer,
              httpClientLayer,
              outputLogFactoryLayer,
              configurationLayer,
            }),
          ),
        );
      }),
    ),
  );
});
