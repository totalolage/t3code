import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as HttpClient from "effect/http/HttpClient";

import type * as Electron from "electron";

const electronBadgeMocks = vi.hoisted(() => ({
  setBadgeCount: vi.fn(() => true),
  getFocusedWindow: vi.fn(() => null),
  getAllWindows: vi.fn(() => []),
}));

vi.mock("electron", async (importOriginal) => {
  const electron = await importOriginal<typeof import("electron")>();
  return {
    ...electron,
    app: { ...electron.app, setBadgeCount: electronBadgeMocks.setBadgeCount },
    BrowserWindow: {
      ...electron.BrowserWindow,
      getFocusedWindow: electronBadgeMocks.getFocusedWindow,
      getAllWindows: electronBadgeMocks.getAllWindows,
    },
  };
});

import {
  DATABASE_INCOMPATIBLE_EXIT_CODE,
  type DesktopServerExposureState,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as DesktopApp from "./DesktopApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopCliCommand from "./DesktopCliCommand.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopApplicationMenu from "../window/DesktopApplicationMenu.ts";
import * as DesktopBackendConfiguration from "../backend/DesktopBackendConfiguration.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopLinuxUrlHandler from "./DesktopLinuxUrlHandler.ts";
import * as DesktopPreReadyPlatform from "./DesktopPreReadyPlatform.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopSnapShot from "../snapShot/DesktopSnapShot.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "../ssh/DesktopSshPasswordPrompts.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopWslBackend from "../wsl/DesktopWslBackend.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import * as BrowserImport from "../preview/BrowserImport/BrowserImport.ts";
import * as MacPermissions from "../permissions/MacPermissions.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";
import type {
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "../backend/DesktopBackendManager.ts";

type StartupEvent =
  | "when-ready"
  | "splash"
  | "bootstrap"
  | "error-box"
  | "backend-start"
  | "backend-stop"
  | "shutdown-request"
  | "shutdown-complete"
  | "quit"
  | "exit"
  | "relaunch";

type FailureStage = "shell" | "identity" | "menu" | "updates";

interface HarnessOptions {
  readonly whenReady?: "ready" | "blocked" | "fail";
  readonly bootstrap?: "blocked" | "fail" | "ready";
  readonly messageBox?: "ready" | "blocked" | "fail";
  // "blocked" makes showErrorBox record and queue the box, then wait on an
  // explicit release deferred so the test can observe manager state while the
  // app is still mid-reporting.
  readonly errorBox?: "ready" | "fail" | "blocked";
  readonly response?: number;
  readonly failureStage?: FailureStage;
  readonly development?: boolean;
  readonly activation?: "ready" | "blocked";
  // "process" swaps the stubbed backend pool for the real
  // DesktopBackendPool.layer + DesktopBackendManager, with only the OS child
  // process faked at the ChildProcessSpawner boundary.
  readonly backend?: "stub" | "process";
  // How the fake backend child behaves: "immediate" exits right away; "held"
  // stays alive until its run scope is torn down or its exit gate is released.
  readonly backendChildExit?: "immediate" | "held" | "database-incompatible";
}

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/tmp/t3-desktop-test-home",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const testServerExposureState = {
  mode: "local-only",
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
} satisfies DesktopServerExposureState;

const testBackendConfig = {
  port: 3773,
  bindHost: "127.0.0.1",
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
} satisfies DesktopServerExposure.DesktopServerExposureBackendConfig;

// Process-mode backend harness: the Pool, Manager, and configuration layers
// are real; only the OS child process, HTTP, and GUI surfaces are faked.
const makeProcessBackendHarness = <E>(options: {
  readonly environmentLayer: Layer.Layer<DesktopEnvironment.DesktopEnvironment, E>;
  readonly childExit: "immediate" | "held" | "database-incompatible";
}) =>
  Effect.gen(function* () {
    const spawnCount = yield* Ref.make(0);
    const killedCount = yield* Ref.make(0);
    const childSpawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
    // The manager records the child pid before calling beginSession, so this
    // deferred is the readiness gate for "spawn observed by the manager".
    const childStarted = yield* Deferred.make<void>();
    const childExitGate = yield* Deferred.make<void>();
    const readinessRequested = yield* Deferred.make<void>();
    const releaseReadiness = yield* Deferred.make<void>();

    const terminateChild = Ref.update(killedCount, (count) => count + 1).pipe(
      Effect.andThen(Deferred.succeed(childExitGate, undefined)),
      Effect.asVoid,
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        yield* Ref.update(spawnCount, (count) => count + 1);
        // Kill/cleanup is owned by the child's run scope, mirroring how the
        // real spawner tears down the OS process.
        yield* Scope.addFinalizer(scope, terminateChild);
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode:
            options.childExit === "held"
              ? Deferred.await(childExitGate).pipe(Effect.as(ChildProcessSpawner.ExitCode(0)))
              : options.childExit === "database-incompatible"
                ? Deferred.await(readinessRequested).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(DATABASE_INCOMPATIBLE_EXIT_CODE)),
                  )
                : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(options.childExit === "held"),
          kill: () => terminateChild,
          stdin: Sink.drain,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
        yield* Deferred.succeed(childSpawned, handle);
        return handle;
      }),
    );

    const configurationLayer = DesktopBackendConfiguration.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          options.environmentLayer,
          FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
          Layer.mock(DesktopServerExposure.DesktopServerExposure)({
            backendConfig: Effect.succeed(testBackendConfig),
          }),
          DesktopWslEnvironment.layerTest({}),
          Layer.mock(DesktopWslServerTree.DesktopWslServerTree)({}),
          Layer.mock(DesktopAppSettings.DesktopAppSettings)({
            get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
            load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
          }),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
        ),
      ),
    );

    const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
      beginSession: () => Deferred.succeed(childStarted, undefined).pipe(Effect.asVoid),
      writeOutputChunk: () => Effect.void,
      persistFailureSnapshot: () => Effect.void,
      persistFailure: () => Effect.void,
      discardSession: Effect.void,
    };
    const poolDependencies = Layer.mergeAll(
      configurationLayer,
      FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      // Readiness probing always sees a not-ready backend; the fake child
      // never listens on the port.
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          (options.childExit === "database-incompatible"
            ? Deferred.succeed(readinessRequested, undefined).pipe(
                Effect.andThen(Deferred.await(releaseReadiness)),
                Effect.asVoid,
              )
            : Effect.void
          ).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 503 }))),
          ),
        ),
      ),
      Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
        forInstance: () => Effect.succeed(stubLog),
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
      } satisfies DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]),
      Layer.mock(DesktopBrowserHost.DesktopBrowserHost)({
        attach: () => undefined,
        detach: () => undefined,
        placeDownload: () => false,
      }),
      DesktopWslEnvironment.layerTest({}),
      Layer.mock(DesktopWindow.DesktopWindow)({}),
      Layer.mock(ElectronDialog.ElectronDialog)({}),
      Layer.mock(DesktopAppSettings.DesktopAppSettings)({
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      }),
    );

    // The pool is built once in an explicitly owned scope so the instance's
    // auto-stop finalizer can be released at teardown.
    const poolScope = yield* Scope.make();
    const close = Effect.gen(function* () {
      // Keep the process harness bounded even when bootstrap or an assertion
      // fails before the test reaches its normal close call.
      yield* Deferred.succeed(readinessRequested, undefined);
      yield* Deferred.succeed(releaseReadiness, undefined);
      yield* Deferred.succeed(childExitGate, undefined);
      yield* Scope.close(poolScope, Exit.void).pipe(Effect.ignore);
    });
    yield* Scope.addFinalizer(yield* Scope.Scope, close);
    const poolContext = yield* Layer.build(
      DesktopBackendPool.layer.pipe(Layer.provide(poolDependencies)),
    ).pipe(Scope.provide(poolScope));
    const pool = Context.get(poolContext, DesktopBackendPool.DesktopBackendPool);

    return {
      serviceLayer: Layer.succeed(DesktopBackendPool.DesktopBackendPool, pool),
      pool,
      spawnCount,
      killedCount,
      childSpawned,
      childStarted,
      readinessRequested,
      releaseReadiness,
      poolScope,
      close,
    };
  });

const makeHarness = (input: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<StartupEvent>();
    const whenReadyEntered = yield* Deferred.make<void>();
    const whenReadyRelease = yield* Deferred.make<void>();
    const bootstrapEntered = yield* Deferred.make<void>();
    const bootstrapRelease = yield* Deferred.make<void>();
    const bootstrapInterrupted = yield* Deferred.make<void>();
    const bootstrapCompleted = yield* Deferred.make<void>();
    const backendStarted = yield* Deferred.make<void>();
    const snapshotInitialized = yield* Deferred.make<void>();
    const activationEntered = yield* Deferred.make<void>();
    const activationRelease = yield* Deferred.make<void>();
    const activationInterrupted = yield* Deferred.make<void>();
    const wslReconciled = yield* Deferred.make<void>();
    const messageBoxEntered = yield* Deferred.make<void>();
    const messageBoxRelease = yield* Deferred.make<void>();
    const messageBoxInterrupted = yield* Deferred.make<void>();
    const relaunchCompleted = yield* Deferred.make<void>();
    const exitCompleted = yield* Deferred.make<void>();
    const shutdownRequested = yield* Deferred.make<void>();
    const shutdownCompleted = yield* Deferred.make<void>();
    const splashCount = yield* Ref.make(0);
    const backendStartCount = yield* Ref.make(0);
    const backendStopCount = yield* Ref.make(0);
    const shutdownComplete = yield* Ref.make(false);
    const quitting = yield* Ref.make(false);
    const exitCode = yield* Ref.make<Option.Option<number>>(Option.none());
    const messageBoxes = yield* Queue.unbounded<Electron.MessageBoxOptions>();
    const errorBoxes = yield* Queue.unbounded<{
      readonly title: string;
      readonly content: string;
    }>();
    const errorBoxRelease = yield* Deferred.make<void>();

    const record = (event: StartupEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
    const requestShutdown = record("shutdown-request").pipe(
      Effect.andThen(Deferred.succeed(shutdownRequested, undefined)),
      Effect.asVoid,
    );
    const requestQuit = Ref.set(quitting, true).pipe(
      Effect.andThen(requestShutdown),
      Effect.asVoid,
    );

    const whenReady = record("when-ready").pipe(
      Effect.andThen(Deferred.succeed(whenReadyEntered, undefined)),
      Effect.andThen(
        input.whenReady === "blocked"
          ? Deferred.await(whenReadyRelease)
          : input.whenReady === "fail"
            ? Effect.die(new Error("Electron was not ready"))
            : Effect.void,
      ),
    );
    const bootstrap = record("bootstrap").pipe(
      Effect.andThen(Deferred.succeed(bootstrapEntered, undefined)),
      Effect.andThen(
        input.bootstrap === "blocked"
          ? Deferred.await(bootstrapRelease).pipe(
              Effect.onInterrupt(() => Deferred.succeed(bootstrapInterrupted, undefined)),
            )
          : input.bootstrap === "ready"
            ? Effect.void
            : Effect.die(new Error("bootstrap rejected")),
      ),
      Effect.andThen(Deferred.succeed(bootstrapCompleted, undefined)),
    );

    const primaryBackend = {
      id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
      label: Effect.succeed("primary"),
      start: Ref.update(backendStartCount, (count) => count + 1).pipe(
        Effect.andThen(record("backend-start")),
        Effect.andThen(Deferred.succeed(backendStarted, undefined)),
      ),
      stop: () =>
        Ref.update(backendStopCount, (count) => count + 1).pipe(
          Effect.andThen(record("backend-stop")),
        ),
      currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
      snapshot: Effect.succeed<DesktopBackendSnapshot>({
        desiredRunning: false,
        ready: false,
        activePid: Option.none(),
        restartAttempt: 0,
        restartScheduled: false,
      }),
      waitForReady: () => Effect.succeed(false),
    } satisfies DesktopBackendPool.DesktopBackendInstance;

    const environmentLayer = DesktopEnvironment.layer(environmentInput).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodePath.layerPosix,
          DesktopConfig.layerTest({
            T3CODE_PORT: "3773",
            ...(input.development === true ? { VITE_DEV_SERVER_URL: "http://127.0.0.1:5173" } : {}),
          }),
        ),
      ),
    );
    const lifecycle = DesktopLifecycle.make;
    const lifecycleLayer = Layer.succeed(DesktopLifecycle.DesktopLifecycle, {
      ...lifecycle,
      register: Effect.void,
    });

    const processBackend =
      input.backend === "process"
        ? yield* makeProcessBackendHarness({
            environmentLayer,
            childExit: input.backendChildExit ?? "immediate",
          })
        : undefined;

    const layer = Layer.mergeAll(
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      NodeServices.layer,
      NodePath.layerPosix,
      Layer.mock(BrowserImport.BrowserImport)({}),
      Layer.mock(DesktopAppActivation.DesktopAppActivation)({
        start: Deferred.succeed(activationEntered, undefined).pipe(
          Effect.andThen(
            input.activation === "blocked"
              ? Deferred.await(activationRelease).pipe(
                  Effect.onInterrupt(() => Deferred.succeed(activationInterrupted, undefined)),
                )
              : Effect.void,
          ),
          Effect.asVoid,
        ),
        setRendererReady: () => Effect.void,
        complete: () => Effect.void,
      }),
      Layer.mock(DesktopAppIdentity.DesktopAppIdentity)({
        resolveUserDataPath: Effect.succeed("/tmp/t3-desktop-test-user-data"),
        configure:
          input.failureStage === "identity"
            ? Effect.die(new Error("identity configuration rejected"))
            : Effect.void,
      }),
      Layer.mock(DesktopAppSettings.DesktopAppSettings)({
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
      }),
      Layer.mock(DesktopClientSettings.DesktopClientSettings)({}),
      Layer.mock(DesktopApplicationMenu.DesktopApplicationMenu)({
        configure:
          input.failureStage === "menu"
            ? Effect.die(new Error("menu configuration rejected"))
            : Effect.void,
      }),
      processBackend === undefined
        ? Layer.mock(DesktopBackendPool.DesktopBackendPool)({
            list: Effect.succeed([primaryBackend]),
            primary: Effect.succeed(primaryBackend),
            awaitPrimaryTerminalFailure: Effect.never,
          })
        : processBackend.serviceLayer,
      Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration)({}),
      Layer.mock(DesktopBrowserHost.DesktopBrowserHost)({
        attach: () => undefined,
        detach: () => undefined,
        placeDownload: () => false,
      }),
      Layer.mock(DesktopConnectionCatalogStore.DesktopConnectionCatalogStore)({}),
      Layer.mock(DesktopClerk.DesktopClerk)({ configure: Effect.void }),
      Layer.succeed(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage, {
        load: () => Effect.void,
        take: Effect.succeedNone,
        complete: Effect.void,
      }),
      Layer.mock(DesktopIpc.DesktopIpc)({
        handle: <E, R>(_method: DesktopIpc.DesktopIpcMethod<E, R>) => Effect.void,
        handleSync: <E, R>(_method: DesktopIpc.DesktopSyncIpcMethod<E, R>) => Effect.void,
      }),
      environmentLayer,
      lifecycleLayer,
      Layer.mock(DesktopLinuxUrlHandler.DesktopLinuxUrlHandler)({ register: Effect.void }),
      Layer.mock(DesktopCliCommand.DesktopCliCommand)({}),
      Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth)({}),
      Layer.mock(DesktopPreReadyPlatform.DesktopPreReadyElectronOptions)({
        linux: null,
        linuxPasswordStoreCommandLine: null,
      }),
      Layer.mock(DesktopServerExposure.DesktopServerExposure)({
        configureFromSettings: () => bootstrap.pipe(Effect.as(testServerExposureState)),
        backendConfig: Effect.succeed(testBackendConfig),
        getState: Effect.succeed(testServerExposureState),
      }),
      Layer.mock(DesktopShellEnvironment.DesktopShellEnvironment)({
        installIntoProcess:
          input.failureStage === "shell"
            ? Effect.die(new Error("shell environment installation rejected"))
            : Effect.void,
      }),
      Layer.mock(DesktopShutdown.DesktopShutdown)({
        request: requestShutdown,
        awaitRequest: Deferred.await(shutdownRequested),
        markComplete: Ref.set(shutdownComplete, true).pipe(
          Effect.andThen(record("shutdown-complete")),
          Effect.andThen(Deferred.succeed(shutdownCompleted, undefined)),
          Effect.asVoid,
        ),
        awaitComplete: Deferred.await(shutdownCompleted),
        isComplete: Ref.get(shutdownComplete),
      }),
      Layer.mock(DesktopSnapShot.DesktopSnapShot)({
        initialize: Deferred.succeed(snapshotInitialized, undefined).pipe(Effect.asVoid),
      }),
      Layer.mock(DesktopSshEnvironment.DesktopSshEnvironment)({}),
      Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts)({}),
      Layer.mock(DesktopState.DesktopState)({
        backendReady: Ref.makeUnsafe(false),
        quitting,
      }),
      Layer.mock(DesktopTelemetryPublisher.DesktopTelemetryPublisher)({
        updateRequests: Stream.empty,
        updateCommits: Stream.empty,
        updateCancellations: Stream.empty,
      }),
      Layer.mock(DesktopRendererHistory.DesktopRendererHistory)({ shutdown: Effect.void }),
      Layer.mock(DesktopUpdates.DesktopUpdates)({
        configure:
          input.failureStage === "updates"
            ? Effect.die(new Error("updates configuration rejected"))
            : Effect.void,
        subscribe: Effect.never,
      }),
      Layer.mock(DesktopWindow.DesktopWindow)({
        flushMainWindowBounds: Effect.void,
        showConnectingSplash: Queue.offer(events, "splash").pipe(
          Effect.andThen(Ref.update(splashCount, (count) => count + 1)),
          Effect.asVoid,
        ),
      }),
      Layer.mock(DesktopWslBackend.DesktopWslBackend)({
        reconcile: Deferred.succeed(wslReconciled, undefined).pipe(Effect.asVoid),
        lastPreflightError: Effect.succeedNone,
      }),
      Layer.mock(DesktopWslEnvironment.DesktopWslEnvironment)({}),
      Layer.mock(ElectronMenu.ElectronMenu)({}),
      Layer.mock(ElectronApp.ElectronApp)({
        name: Effect.succeed("T3 Code"),
        whenReady,
        quit: record("quit").pipe(Effect.andThen(requestShutdown)),
        relaunch: () =>
          record("relaunch").pipe(
            Effect.andThen(Deferred.succeed(relaunchCompleted, undefined)),
            Effect.asVoid,
          ),
        exit: (code) =>
          Ref.set(exitCode, Option.some(code)).pipe(
            Effect.andThen(record("exit")),
            Effect.andThen(Deferred.succeed(exitCompleted, undefined)),
            Effect.asVoid,
          ),
        setPath: () => Effect.void,
        on: () => Effect.void,
      }),
      Layer.mock(ElectronProtocol.ElectronProtocol)({
        registerDesktopProtocol: () => Effect.void,
      }),
      Layer.mock(ElectronSafeStorage.ElectronSafeStorage)({
        selectedStorageBackend: Effect.succeedNone,
      }),
      Layer.mock(ElectronShell.ElectronShell)({}),
      Layer.mock(ElectronTheme.ElectronTheme)({
        shouldUseDarkColors: Effect.succeed(false),
      }),
      Layer.mock(ElectronWindow.ElectronWindow)({}),
      FileSystem.layerNoop({}),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die(new Error("unexpected HTTP request in DesktopApp test"))),
      ),
      Layer.mock(MacPermissions.MacPermissions)({}),
      Layer.mock(NetService.NetService)({
        canListenOnHost: () => Effect.succeed(true),
      }),
      Layer.mock(PreviewManager.PreviewManager)({
        isBrowserPartition: () => true,
        subscribeStateChanges: () => Effect.void,
        subscribeRecordingFrames: () => Effect.void,
        subscribeRecordingInputs: () => Effect.void,
        subscribePointerEvents: () => Effect.void,
      }),
      Layer.mock(ElectronDialog.ElectronDialog)({
        showMessageBox: (options) =>
          Queue.offer(messageBoxes, options).pipe(
            Effect.andThen(Deferred.succeed(messageBoxEntered, undefined)),
            Effect.andThen(
              (input.messageBox ?? "ready") === "blocked"
                ? Deferred.await(messageBoxRelease).pipe(
                    Effect.onInterrupt(() => Deferred.succeed(messageBoxInterrupted, undefined)),
                    Effect.andThen(
                      Effect.succeed({
                        response: input.response ?? 1,
                        checkboxChecked: false,
                      }),
                    ),
                  )
                : input.messageBox === "fail"
                  ? Effect.fail(
                      new ElectronDialog.ElectronDialogShowMessageBoxError({
                        type: options.type ?? null,
                        titleLength: options.title?.length ?? null,
                        messageLength: options.message.length,
                        detailLength: options.detail?.length ?? null,
                        buttonCount: options.buttons?.length ?? 0,
                        cause: new Error("message box unavailable"),
                      }),
                    )
                  : Effect.succeed({
                      response: input.response ?? 1,
                      checkboxChecked: false,
                    }),
            ),
          ),
        showErrorBox: (title, content) =>
          record("error-box").pipe(
            Effect.andThen(
              input.errorBox === "fail"
                ? Effect.die(
                    new ElectronDialog.ElectronDialogShowErrorBoxError({
                      titleLength: title.length,
                      contentLength: content.length,
                      cause: new Error("error box unavailable"),
                    }),
                  )
                : Queue.offer(errorBoxes, { title, content }).pipe(
                    Effect.andThen(
                      input.errorBox === "blocked" ? Deferred.await(errorBoxRelease) : Effect.void,
                    ),
                  ),
            ),
            Effect.asVoid,
          ),
      }),
    );

    return {
      start: DesktopApp.program.pipe(Effect.provide(layer)),
      events,
      whenReadyEntered,
      whenReadyRelease,
      bootstrapEntered,
      bootstrapRelease,
      bootstrapInterrupted,
      bootstrapCompleted,
      backendStarted,
      snapshotInitialized,
      activationEntered,
      activationRelease,
      activationInterrupted,
      wslReconciled,
      messageBoxEntered,
      messageBoxRelease,
      messageBoxInterrupted,
      relaunchCompleted,
      exitCompleted,
      requestShutdown,
      requestQuit,
      splashCount,
      backendStartCount,
      backendStopCount,
      shutdownComplete,
      exitCode,
      messageBoxes,
      errorBoxes,
      errorBoxRelease,
      backend:
        processBackend === undefined
          ? undefined
          : {
              pool: processBackend.pool,
              spawnCount: processBackend.spawnCount,
              killedCount: processBackend.killedCount,
              childSpawned: processBackend.childSpawned,
              childStarted: processBackend.childStarted,
              readinessRequested: processBackend.readinessRequested,
              releaseReadiness: processBackend.releaseReadiness,
              close: processBackend.close,
            },
    };
  });

describe("DesktopApp startup", () => {
  it.effect("shows feedback after Electron is ready and before bootstrap can stall", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ bootstrap: "blocked" });
      const fiber = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.raceFirst(
        Deferred.await(harness.bootstrapEntered),
        Queue.take(harness.errorBoxes).pipe(
          Effect.flatMap(({ title, content }) =>
            Effect.die(new Error(`startup failed before bootstrap: ${title}: ${content}`)),
          ),
        ),
      );
      assert.deepEqual(yield* Queue.takeAll(harness.events), ["when-ready", "splash", "bootstrap"]);
      assert.equal(yield* Ref.get(harness.backendStartCount), 0);

      yield* harness.requestQuit;
      yield* Fiber.join(fiber);

      assert.isTrue(yield* Deferred.isDone(harness.bootstrapInterrupted));
      assert.equal(yield* Ref.get(harness.backendStopCount), 1);
      assert.isTrue(yield* Ref.get(harness.shutdownComplete));
    }),
  );

  it.effect("does not show feedback before Electron is ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ whenReady: "blocked", bootstrap: "blocked" });
      const fiber = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(harness.whenReadyEntered);
      assert.equal(yield* Ref.get(harness.splashCount), 0);
      assert.deepEqual(yield* Queue.takeAll(harness.events), ["when-ready"]);

      yield* harness.requestQuit;
      yield* Fiber.join(fiber);

      assert.equal(yield* Ref.get(harness.splashCount), 0);
      assert.equal(yield* Ref.get(harness.backendStartCount), 0);
      assert.equal(yield* Ref.get(harness.backendStopCount), 1);
      assert.equal((yield* Queue.clear(harness.messageBoxes)).length, 0);
      assert.equal((yield* Queue.clear(harness.errorBoxes)).length, 0);
      assert.isTrue(yield* Ref.get(harness.shutdownComplete));
    }),
  );

  it.effect("shows a fatal error and quits when bootstrap fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ bootstrap: "fail" });
      const fiber = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));

      const error = yield* Queue.take(harness.errorBoxes);
      assert.equal(error.title, "T3 Code failed to start");
      assert.include(error.content, "Stage: bootstrap");

      const programExit = yield* Effect.exit(Fiber.join(fiber));
      assert.isTrue(Exit.isSuccess(programExit));
      assert.equal(yield* Ref.get(harness.backendStopCount), 1);
      assert.isTrue(yield* Ref.get(harness.shutdownComplete));
      const events = yield* Queue.takeAll(harness.events);
      assert.isTrue(events.indexOf("error-box") < events.indexOf("quit"));
      assert.notInclude(events, "relaunch");
      assert.equal((yield* Queue.clear(harness.messageBoxes)).length, 0);
    }),
  );

  it.effect("shows the fatal error box and quits on an incompatible backend database", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        bootstrap: "ready",
        backend: "process",
        backendChildExit: "database-incompatible",
      });
      const backend = harness.backend!;
      const fiber = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.raceFirst(
        Deferred.await(backend.childSpawned),
        Queue.take(harness.errorBoxes).pipe(
          Effect.flatMap(({ title, content }) =>
            Effect.die(new Error(`startup failed before backend spawn: ${title}: ${content}`)),
          ),
        ),
      );
      yield* Deferred.await(backend.childStarted);
      yield* Deferred.await(backend.readinessRequested);
      assert.deepEqual(yield* backend.pool.awaitPrimaryTerminalFailure, {
        _tag: "DatabaseIncompatible",
      });
      yield* Deferred.succeed(backend.releaseReadiness, undefined);
      const error = yield* Queue.take(harness.errorBoxes);
      assert.equal(error.title, "T3 Code failed to start");
      assert.include(error.content, "Stage: primary backend");
      assert.include(error.content, "database is incompatible");
      assert.notMatch(error.content, /retry|convert/i);

      const programExit = yield* Effect.exit(Fiber.join(fiber));
      assert.isTrue(Exit.isSuccess(programExit));
      assert.equal((yield* Queue.clear(harness.messageBoxes)).length, 0);
      assert.equal(yield* Ref.get(backend.spawnCount), 1);
      assert.isTrue(yield* Ref.get(harness.shutdownComplete));
      const events = yield* Queue.takeAll(harness.events);
      assert.isTrue(events.indexOf("error-box") < events.indexOf("quit"));
      assert.notInclude(events, "relaunch");

      yield* backend.close;
    }),
  );

  it.effect("uses the pre-ready error box for startup configuration faults", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failureStage: "shell" });
      const fiber = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));

      const error = yield* Queue.take(harness.errorBoxes);
      assert.equal(error.title, "T3 Code failed to start");
      assert.include(error.content, "Stage: shell environment");
      assert.equal((yield* Queue.clear(harness.messageBoxes)).length, 0);

      yield* Fiber.join(fiber);
      assert.equal(yield* Ref.get(harness.backendStopCount), 1);
      assert.isTrue(yield* Ref.get(harness.shutdownComplete));
    }),
  );

  it.effect("kills and cleans up the real backend child when shutdown interrupts readiness", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        bootstrap: "ready",
        backend: "process",
        backendChildExit: "held",
      });
      const backend = harness.backend!;
      const fiber = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.raceFirst(
        Deferred.await(backend.childSpawned),
        Queue.take(harness.errorBoxes).pipe(
          Effect.flatMap(({ title, content }) =>
            Effect.die(new Error(`startup failed before backend spawn: ${title}: ${content}`)),
          ),
        ),
      );
      yield* Deferred.await(backend.childStarted);
      const instance = yield* backend.pool.primary;
      const running = yield* instance.snapshot;
      assert.isTrue(running.desiredRunning);
      assert.equal(Option.getOrUndefined(running.activePid), 123);

      yield* harness.requestQuit;
      const programExit = yield* Effect.exit(Fiber.join(fiber));
      assert.isTrue(Exit.isSuccess(programExit));

      // The captured child handle was killed/cleaned on teardown; no second
      // spawn, no leaked run, and no terminal-failure UI was shown.
      assert.equal(yield* Ref.get(backend.killedCount), 1);
      assert.equal(yield* Ref.get(backend.spawnCount), 1);
      const snapshot = yield* instance.snapshot;
      assert.isFalse(snapshot.desiredRunning);
      assert.isTrue(yield* Ref.get(harness.shutdownComplete));
      assert.equal((yield* Queue.clear(harness.errorBoxes)).length, 0);
      assert.equal((yield* Queue.clear(harness.messageBoxes)).length, 0);
      const events = yield* Queue.takeAll(harness.events);
      assert.notInclude(events, "relaunch");

      yield* backend.close;
    }),
  );
});
