import { assert, describe, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as NodeEvents from "node:events";
import type * as Electron from "electron";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { beforeEach, vi } from "vite-plus/test";

const { appFocusMock, createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  appFocusMock: vi.fn(),
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

vi.mock("electron", async (importOriginal) => {
  const electron = await importOriginal<typeof import("electron")>();
  return {
    ...electron,
    app: { ...electron.app, focus: appFocusMock },
    screen: { getAllDisplays: vi.fn(() => []) },
  };
});

import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";

let nextWindowId = 1;

function makeFakeBrowserWindow(
  input: {
    readonly loadURL?: (url: string) => Promise<void>;
    readonly executeJavaScript?: (script: string) => Promise<unknown>;
  } = {},
) {
  let minimized = false;
  let visible = false;
  const isMinimized = vi.fn(() => minimized);
  const isVisible = vi.fn(() => visible);
  const restore = vi.fn(() => {
    minimized = false;
  });
  const show = vi.fn(() => {
    visible = true;
  });
  const loadURLReceipts: Promise<void>[] = [];
  const executeJavaScriptReceipts: Promise<unknown>[] = [];
  const executeJavaScript = vi.fn((script: string) => {
    const receipt = input.executeJavaScript?.(script) ?? Promise.resolve(true);
    executeJavaScriptReceipts.push(receipt);
    return receipt;
  });
  const webContents = Object.assign(new NodeEvents.EventEmitter(), {
    executeJavaScript,
    getURL: vi.fn(() => "t3code-dev://app/"),
    getZoomFactor: vi.fn(() => 1),
    isDestroyed: vi.fn(() => false),
    isLoadingMainFrame: vi.fn(() => false),
    openDevTools: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    id: nextWindowId++,
    webContents,
    close: vi.fn(),
    destroy: vi.fn(),
    focus: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized,
    isVisible,
    loadURL: vi.fn((url: string) => {
      const receipt = input.loadURL?.(url) ?? Promise.resolve();
      loadURLReceipts.push(receipt);
      return receipt;
    }),
    maximize: vi.fn(),
    restore,
    setAutoHideCursor: vi.fn(),
    setBackgroundColor: vi.fn(),
    setFullScreen: vi.fn(),
    setOpacity: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    show,
  });

  return {
    window: window as unknown as Electron.BrowserWindow,
    webContents,
    focus: window.focus,
    executeJavaScript,
    isMinimized,
    isVisible,
    restore,
    loadURLReceipts,
    executeJavaScriptReceipts,
    setMinimized: (value: boolean) => {
      minimized = value;
      if (value) visible = false;
    },
    show,
  };
}

type FakeBrowserWindow = ReturnType<typeof makeFakeBrowserWindow>;

const environment = DesktopEnvironment.DesktopEnvironment.of({
  appDataDirectory: "/tmp/t3-clerk-activation-app-data",
  legacyUserDataDirName: "T3 Code (Alpha)",
  path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  stateDir: "/tmp/t3-clerk-activation-state",
  userDataDirName: "t3code",
  isDevelopment: true,
  platform: "darwin",
  preloadPath: "/tmp/t3-clerk-activation-preload.cjs",
  displayName: "T3 Code (Dev)",
} as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

function makeElectronAppLayer(appEvents: NodeEvents.EventEmitter) {
  const on: ElectronApp.ElectronApp["Service"]["on"] = (eventName, listener) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        appEvents.on(eventName, listener);
      }),
      () =>
        Effect.sync(() => {
          appEvents.removeListener(eventName, listener);
        }),
    ).pipe(Effect.asVoid);

  return Layer.mock(ElectronApp.ElectronApp)({
    quit: Effect.void,
    setPath: () => Effect.void,
    on,
  });
}

function makeDesktopClerkLayer(
  appEvents: NodeEvents.EventEmitter,
  electronWindowLayer: ReturnType<typeof makeElectronWindowLayer>,
) {
  return DesktopClerk.layer.pipe(
    Layer.provideMerge(electronWindowLayer),
    Layer.provideMerge(NodePath.layerPosix),
    Layer.provideMerge(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
    Layer.provideMerge(makeElectronAppLayer(appEvents)),
    Layer.provideMerge(
      Layer.mock(ElectronShell.ElectronShell)({
        openExternal: () => Effect.succeed(true),
        openSystemSettings: () => Effect.succeed(true),
        copyText: () => Effect.void,
      }),
    ),
    Layer.provideMerge(FileSystem.layerNoop({ exists: () => Effect.succeed(false) })),
  );
}

function makeElectronWindowLayer(input: {
  readonly plannedWindows: FakeBrowserWindow[];
  readonly createdWindows: FakeBrowserWindow[];
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly reveals: Queue.Queue<Electron.BrowserWindow>;
}) {
  const nativeElectronWindowLayer = Layer.effect(
    ElectronWindow.ElectronWindow,
    ElectronWindow.make,
  ).pipe(Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")));

  const electronWindowLayer = Layer.effect(
    ElectronWindow.ElectronWindow,
    Effect.gen(function* () {
      const nativeElectronWindow = yield* ElectronWindow.ElectronWindow;
      const electronWindow = {
        create: () =>
          Effect.sync(() => {
            const window = input.plannedWindows.shift();
            if (window === undefined) {
              return undefined;
            }
            input.createdWindows.push(window);
            return window.window;
          }).pipe(
            Effect.flatMap((window) =>
              window === undefined
                ? Effect.die("unexpected additional desktop window")
                : Effect.succeed(window),
            ),
          ),
        main: Ref.get(input.mainWindow),
        currentMainOrFirst: Effect.gen(function* () {
          const mainWindow = yield* Ref.get(input.mainWindow);
          return Option.isSome(mainWindow)
            ? mainWindow
            : Option.fromNullishOr(input.createdWindows.at(0)?.window ?? null);
        }),
        focusedMainOrFirst: Ref.get(input.mainWindow),
        setMain: (window: Electron.BrowserWindow) => Ref.set(input.mainWindow, Option.some(window)),
        clearMain: () => Ref.set(input.mainWindow, Option.none()),
        prepareReveal: () => Effect.succeed(false),
        reveal: (window: Electron.BrowserWindow) =>
          nativeElectronWindow
            .reveal(window)
            .pipe(Effect.andThen(Queue.offer(input.reveals, window)), Effect.asVoid),
        sendAll: () => Effect.void,
        destroyAll: Effect.void,
        syncAllAppearance: () => Effect.void,
      } satisfies ElectronWindow.ElectronWindow["Service"];
      return electronWindow;
    }),
  ).pipe(Layer.provide(nativeElectronWindowLayer));

  return electronWindowLayer;
}

function makeDesktopWindowLayer(
  input: {
    readonly appEvents: NodeEvents.EventEmitter;
    readonly plannedWindows: FakeBrowserWindow[];
    readonly createdWindows: FakeBrowserWindow[];
    readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
    readonly reveals: Queue.Queue<Electron.BrowserWindow>;
  },
  electronWindowLayer: ReturnType<typeof makeElectronWindowLayer>,
) {
  const assetsLayer = Layer.mock(DesktopAssets.DesktopAssets)({
    iconPaths: Effect.succeed({
      ico: Option.none<string>(),
      icns: Option.none<string>(),
      png: Option.none<string>(),
    }),
  });
  const settingsLayer = Layer.mock(DesktopAppSettings.DesktopAppSettings)({
    get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
  });
  const clientSettingsLayer = Layer.mock(DesktopClientSettings.DesktopClientSettings)({
    get: Effect.succeed(Option.none()),
  });
  const dialogLayer = Layer.mock(ElectronDialog.ElectronDialog)({
    showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
  });
  const menuLayer = Layer.mock(ElectronMenu.ElectronMenu)({
    popupTemplate: () => Effect.void,
  });
  const shellLayer = Layer.mock(ElectronShell.ElectronShell)({
    openExternal: () => Effect.succeed(true),
    openSystemSettings: () => Effect.succeed(true),
    copyText: () => Effect.void,
  });
  const themeLayer = Layer.mock(ElectronTheme.ElectronTheme)({
    shouldUseDarkColors: Effect.succeed(false),
  });
  const previewLayer = Layer.mock(PreviewManager.PreviewManager)({
    getBrowserSession: () => Effect.succeed({} as Electron.Session),
    setMainWindow: () => Effect.void,
    isBrowserPartition: () => true,
    getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
  });
  const rendererHistoryLayer = Layer.mock(DesktopRendererHistory.DesktopRendererHistory)({
    register: () => Effect.void,
    recordMetrics: () => Effect.void,
    shutdown: Effect.void,
  });

  const desktopWindowLayer = Layer.effect(
    DesktopWindow.DesktopWindow,
    Effect.gen(function* () {
      return yield* DesktopWindow.make;
    }),
  );

  return desktopWindowLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(DesktopState.DesktopState, {
          backendReady: Ref.makeUnsafe(false),
          quitting: Ref.makeUnsafe(false),
        }),
        assetsLayer,
        settingsLayer,
        clientSettingsLayer,
        dialogLayer,
        menuLayer,
        shellLayer,
        themeLayer,
        previewLayer,
        rendererHistoryLayer,
        makeElectronAppLayer(input.appEvents),
        electronWindowLayer,
      ),
    ),
  );
}

const makeActivationScenario = Effect.fn("makeDesktopClerkActivationScenario")(function* (input: {
  readonly plannedWindows: readonly FakeBrowserWindow[];
}) {
  const appEvents = new NodeEvents.EventEmitter();
  const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const reveals = yield* Queue.unbounded<Electron.BrowserWindow>();
  const plannedWindows = [...input.plannedWindows];
  const createdWindows: FakeBrowserWindow[] = [];
  const layerInput = {
    appEvents,
    plannedWindows,
    createdWindows,
    mainWindow,
    reveals,
  };
  const electronWindowLayer = makeElectronWindowLayer(layerInput);

  const layer = Layer.mergeAll(
    makeDesktopClerkLayer(appEvents, electronWindowLayer),
    makeDesktopWindowLayer(layerInput, electronWindowLayer),
  );

  return {
    appEvents,
    layer,
    createdWindows,
    mainWindow,
    plannedWindows,
    reveals,
  } as const;
});

describe("DesktopClerk second-instance activation", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
  });

  it.effect("re-reveals only the startup splash while the backend is unready", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const unusedMain = makeFakeBrowserWindow();
      const scenario = yield* makeActivationScenario({ plannedWindows: [splash, unusedMain] });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* clerk.configure;
          yield* desktopWindow.showConnectingSplash;
          splash.window.emit("ready-to-show");

          scenario.appEvents.emit("second-instance");
          const revealed = yield* Queue.take(scenario.reveals);

          assert.strictEqual(revealed, splash.window);
          assert.equal(scenario.createdWindows.length, 1);
          assert.isTrue(splash.window.isVisible());
        }).pipe(Effect.provide(scenario.layer)),
      );
    }),
  );

  it.effect(
    "reveals the existing main window without duplicating it while its renderer is pending",
    () =>
      Effect.gen(function* () {
        let resolveMainLoad: (() => void) | undefined;
        let resolveInitialPaint: (() => void) | undefined;
        const paintStarted = yield* Queue.unbounded<void>();
        const main = makeFakeBrowserWindow({
          loadURL: () =>
            new Promise<void>((resolve) => {
              resolveMainLoad = resolve;
            }),
          executeJavaScript: () => {
            Queue.offerUnsafe(paintStarted, undefined);
            return new Promise<void>((resolve) => {
              resolveInitialPaint = resolve;
            });
          },
        });
        const duplicate = makeFakeBrowserWindow();
        const scenario = yield* makeActivationScenario({ plannedWindows: [main, duplicate] });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const clerk = yield* DesktopClerk.DesktopClerk;
            const desktopWindow = yield* DesktopWindow.DesktopWindow;
            yield* clerk.configure;
            yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

            const loadReceipt = main.loadURLReceipts.at(-1);
            if (loadReceipt === undefined) {
              return yield* Effect.die("main renderer load receipt was not registered");
            }
            main.webContents.emit("did-finish-load");
            main.window.emit("ready-to-show");
            assert.isFalse(main.window.isVisible());

            scenario.appEvents.emit("second-instance");
            const activationReveal = yield* Queue.take(scenario.reveals);

            assert.strictEqual(activationReveal, main.window);
            assert.equal(scenario.createdWindows.length, 1);
            assert.isTrue(main.window.isVisible());

            resolveMainLoad?.();
            yield* Effect.promise(() => loadReceipt).pipe(Effect.asVoid);
            yield* Queue.take(paintStarted);
            assert.isTrue(main.window.isVisible());

            scenario.appEvents.emit("second-instance");
            const pendingReveal = yield* Queue.take(scenario.reveals);
            assert.strictEqual(pendingReveal, main.window);
            assert.isTrue(main.window.isVisible());

            resolveInitialPaint?.();
            const paintReceipt = main.executeJavaScriptReceipts.at(-1);
            if (paintReceipt === undefined) {
              return yield* Effect.die("main renderer paint receipt was not registered");
            }
            yield* Effect.promise(() => paintReceipt).pipe(Effect.asVoid);
            const revealed = yield* Queue.take(scenario.reveals);
            assert.strictEqual(revealed, main.window);
            assert.isTrue(main.window.isVisible());
          }).pipe(Effect.provide(scenario.layer)),
        );
      }),
  );
  it.effect("restores and focuses the same main window after renderer readiness", () =>
    Effect.gen(function* () {
      let resolveMainLoad: (() => void) | undefined;
      let resolveInitialPaint: (() => void) | undefined;
      const paintStarted = yield* Queue.unbounded<void>();
      const main = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((resolve) => {
            resolveMainLoad = resolve;
          }),
        executeJavaScript: () => {
          Queue.offerUnsafe(paintStarted, undefined);
          return new Promise<void>((resolve) => {
            resolveInitialPaint = resolve;
          });
        },
      });
      const unusedDuplicate = makeFakeBrowserWindow();
      const scenario = yield* makeActivationScenario({ plannedWindows: [main, unusedDuplicate] });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* clerk.configure;
          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

          main.webContents.emit("did-finish-load");
          main.window.emit("ready-to-show");
          assert.isFalse(main.window.isVisible());

          const loadReceipt = main.loadURLReceipts.at(-1);
          if (loadReceipt === undefined) {
            return yield* Effect.die("main renderer load receipt was not registered");
          }
          resolveMainLoad?.();
          yield* Effect.promise(() => loadReceipt).pipe(Effect.asVoid);
          yield* Queue.take(paintStarted);
          assert.isFalse(main.window.isVisible());

          resolveInitialPaint?.();
          const paintReceipt = main.executeJavaScriptReceipts.at(-1);
          if (paintReceipt === undefined) {
            return yield* Effect.die("main renderer paint receipt was not registered");
          }
          yield* Effect.promise(() => paintReceipt).pipe(Effect.asVoid);
          const initialReveal = yield* Queue.take(scenario.reveals);
          assert.strictEqual(initialReveal, main.window);

          main.setMinimized(true);
          scenario.appEvents.emit("second-instance");
          const activationReveal = yield* Queue.take(scenario.reveals);

          assert.strictEqual(activationReveal, main.window);
          assert.equal(scenario.createdWindows.length, 1);
          assert.equal(main.restore.mock.calls.length, 1);
          assert.equal(main.show.mock.calls.length, 2);
          assert.equal(main.focus.mock.calls.length, 2);
          assert.equal(appFocusMock.mock.calls.length, 2);
          assert.isFalse(main.isMinimized());
          assert.isTrue(main.isVisible());
        }).pipe(Effect.provide(scenario.layer)),
      );
    }),
  );

  it.effect("reports activation defects without an unhandled fork failure", () =>
    Effect.gen(function* () {
      const appEvents = new NodeEvents.EventEmitter();
      const logReceipts = yield* Queue.unbounded<{
        readonly message: unknown;
        readonly cause: Cause.Cause<unknown>;
      }>();
      const activationDefect = new Error("activation failed");
      const logger = Logger.make<unknown, void>(({ cause, message }) => {
        Queue.offerUnsafe(logReceipts, {
          message,
          cause,
        });
      });
      const mainWindow = makeFakeBrowserWindow();
      const mockElectronWindow = Layer.mock(ElectronWindow.ElectronWindow)({
        currentMainOrFirst: Effect.succeed(Option.some(mainWindow.window)),
        reveal: () => Effect.die(activationDefect),
      });
      const layer = Layer.mergeAll(
        makeDesktopClerkLayer(appEvents, mockElectronWindow),
        Logger.layer([logger], { mergeWithExisting: false }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          yield* clerk.configure;
          appEvents.emit("second-instance");

          const receipt = yield* Queue.take(logReceipts);
          assert.include(String(receipt.message), "Could not reveal the desktop window");
          assert.include(Cause.pretty(receipt.cause), "activation failed");
        }).pipe(Effect.provide(layer)),
      );
    }),
  );
});
