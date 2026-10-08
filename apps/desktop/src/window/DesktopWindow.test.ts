import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import { DesktopSnapShotId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Electron from "electron";
import * as NodeEvents from "node:events";
import { vi } from "vite-plus/test";

vi.mock("electron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("electron")>()),
  session: {
    fromPartition: vi.fn(() => ({
      getUserAgent: vi.fn(() => "Mozilla/5.0 Electron/41.5.0 t3code/1.2.3"),
      setPermissionRequestHandler: vi.fn(),
      setUserAgent: vi.fn(),
    })),
  },
  screen: {
    getAllDisplays: vi.fn(() => [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    ]),
  },
}));

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../app/DesktopShutdown.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  MENU_ACTION_CHANNEL,
  SNAP_SHOT_EVENT_CHANNEL,
  TRACKPAD_SCROLL_END_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";
import * as DesktopServerExposure from "../backend/DesktopServerExposure.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import * as PreviewManager from "../preview/Manager.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

function makeFakeBrowserWindow(
  input: {
    readonly loadURL?: (url: string) => Promise<void>;
    readonly executeJavaScript?: (script: string) => Promise<unknown>;
  } = {},
) {
  const windowListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const webContentsOnceListeners = new Map<string, (...args: readonly unknown[]) => void>();
  const loadURLReceipts: Promise<void>[] = [];
  const executeJavaScriptReceipts: Promise<unknown>[] = [];
  let zoomLevel = 0;
  const executeJavaScript = vi.fn((script: string) => {
    const receipt = input.executeJavaScript?.(script) ?? Promise.resolve(true);
    executeJavaScriptReceipts.push(receipt);
    return receipt;
  });
  const webContents = {
    copyImageAt: vi.fn(),
    executeJavaScript,
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => "t3code-dev://app/"),
    getZoomLevel: vi.fn(() => zoomLevel),
    getZoomFactor: vi.fn(() => 1.2 ** zoomLevel),
    setZoomLevel: vi.fn((level: number) => {
      zoomLevel = level;
    }),
    isLoadingMainFrame: vi.fn(() => false),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsListeners.set(eventName, listener);
    }),
    once: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      webContentsOnceListeners.set(eventName, listener);
    }),
    openDevTools: vi.fn(),
    reload: vi.fn(),
    replaceMisspelling: vi.fn(),
    send: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };

  const window = {
    close: vi.fn(),
    destroy: vi.fn(),
    focus: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    getNormalBounds: vi.fn(() => ({ x: 0, y: 0, width: 1100, height: 780 })),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    loadURL: vi.fn((url: string) => {
      const receipt = input.loadURL?.(url) ?? Promise.resolve();
      loadURLReceipts.push(receipt);
      return receipt;
    }),
    maximize: vi.fn(),
    on: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    once: vi.fn((eventName: string, listener: (...args: readonly unknown[]) => void) => {
      windowListeners.set(eventName, listener);
    }),
    restore: vi.fn(),
    setBackgroundColor: vi.fn(),
    setAutoHideCursor: vi.fn(),
    setFullScreen: vi.fn(),
    setOpacity: vi.fn(),
    setTitle: vi.fn(),
    setTitleBarOverlay: vi.fn(),
    setWindowButtonPosition: vi.fn(),
    show: vi.fn(),
    webContents,
  };

  return {
    window: window as unknown as Electron.BrowserWindow,
    close: window.close,
    focus: window.focus,
    getBounds: window.getBounds,
    getNormalBounds: window.getNormalBounds,
    isDestroyed: window.isDestroyed,
    isFullScreen: window.isFullScreen,
    isMaximized: window.isMaximized,
    isMinimized: window.isMinimized,
    isVisible: window.isVisible,
    loadURL: window.loadURL,
    destroy: window.destroy,
    executeJavaScript: webContents.executeJavaScript,
    maximize: window.maximize,
    openDevTools: webContents.openDevTools,
    reload: webContents.reload,
    restore: window.restore,
    send: webContents.send,
    setZoomLevel: webContents.setZoomLevel,
    setWindowButtonPosition: window.setWindowButtonPosition,
    setBackgroundThrottling: webContents.setBackgroundThrottling,
    show: window.show,
    setAutoHideCursor: window.setAutoHideCursor,
    setFullScreen: window.setFullScreen,
    setOpacity: window.setOpacity,
    webContentsListeners,
    webContentsOnce: webContents.once,
    webContentsOnceListeners,
    windowListeners,
    loadURLReceipts,
    executeJavaScriptReceipts,
    webContents,
  };
}

const layerDesktopClientSettings = Layer.mock(DesktopClientSettings.DesktopClientSettings)({
  get: Effect.succeedNone,
});

const desktopAssetsLayer = Layer.succeed(DesktopAssets.DesktopAssets, {
  iconPaths: Effect.succeed({
    ico: Option.none<string>(),
    icns: Option.none<string>(),
    png: Option.none<string>(),
  }),
  resolveResourcePath: () => Effect.succeed(Option.none<string>()),
} satisfies DesktopAssets.DesktopAssets["Service"]);

const layerDesktopServerExposure = Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
  getState: Effect.die("unexpected getState"),
  backendConfig: Effect.succeed({
    port: 3773,
    bindHost: "127.0.0.1",
    httpBaseUrl: new URL("http://127.0.0.1:3773"),
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
  configureFromSettings: () => Effect.die("unexpected configureFromSettings"),
  setMode: () => Effect.die("unexpected setMode"),
  setTailscaleServeEnabled: () => Effect.die("unexpected setTailscaleServeEnabled"),
  getAdvertisedEndpoints: Effect.die("unexpected getAdvertisedEndpoints"),
} satisfies DesktopServerExposure.DesktopServerExposure["Service"]);

const layerElectronMenu = Layer.succeed(ElectronMenu.ElectronMenu, {
  setApplicationMenu: () => Effect.void,
  popupTemplate: () => Effect.void,
  showContextMenu: () => Effect.succeedNone,
} satisfies ElectronMenu.ElectronMenu["Service"]);

const layerElectronTheme = Layer.succeed(ElectronTheme.ElectronTheme, {
  shouldUseDarkColors: Effect.succeed(false),
  setSource: () => Effect.void,
  onUpdated: () => Effect.void,
} satisfies ElectronTheme.ElectronTheme["Service"]);

const layerDesktopRendererHistory = Layer.succeed(DesktopRendererHistory.DesktopRendererHistory, {
  register: () => Effect.void,
  recordMetrics: () => Effect.void,
  shutdown: Effect.void,
});

const makeDesktopEnvironmentLayer = (input: DesktopEnvironment.MakeDesktopEnvironmentInput) =>
  DesktopEnvironment.layer(input).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_PORT: "3773",
          VITE_DEV_SERVER_URL: input.isPackaged ? undefined : "http://127.0.0.1:5733",
        }),
      ),
    ),
  );

const desktopWindowBoundsEquivalence = Schema.toEquivalence(
  DesktopAppSettings.DesktopWindowBoundsSchema,
);

function layerTest(input: {
  readonly window: Electron.BrowserWindow;
  readonly createCount: Ref.Ref<number>;
  readonly mainWindow: Ref.Ref<Option.Option<Electron.BrowserWindow>>;
  readonly createdWindowOptions?: Electron.BrowserWindowConstructorOptions[];
  readonly desktopSettings?: DesktopAppSettings.DesktopSettings;
  readonly mainWindowBoundsUpdates?: DesktopAppSettings.DesktopWindowBounds[];
  readonly mainWindowMaximizedUpdates?: boolean[];
  readonly beforeMainWindowBoundsUpdate?: (
    bounds: DesktopAppSettings.DesktopWindowBounds,
  ) => Effect.Effect<void>;
  readonly openedExternalUrls?: unknown[];
  readonly copiedTexts?: string[];
  readonly onPopupTemplate?: (input: ElectronMenu.ElectronMenuTemplateInput) => Effect.Effect<void>;
  readonly previewZoomReapplies?: number[];
  readonly onReveal?: (window: Electron.BrowserWindow) => void;
  readonly beforeCreate?: () => Effect.Effect<void>;
  readonly beforeMainWindowPreparation?: () => Effect.Effect<void>;
  readonly beforeMainWindowPublication?: (window: Electron.BrowserWindow) => Effect.Effect<void>;
  readonly auxiliaryWindow?: Electron.BrowserWindow;
  readonly environment?: DesktopEnvironment.MakeDesktopEnvironmentInput;
  readonly desktopState?: DesktopState.DesktopState["Service"];
  readonly onQuit?: () => Effect.Effect<void>;
  readonly onShowMessageBox?: (
    options: Electron.MessageBoxOptions,
  ) => Effect.Effect<
    Electron.MessageBoxReturnValue,
    ElectronDialog.ElectronDialogShowMessageBoxError
  >;
}) {
  let desktopSettings = input.desktopSettings ?? DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS;
  const layerDesktopAppSettings = Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
    get: Effect.sync(() => desktopSettings),
    load: Effect.sync(() => desktopSettings),
    setMainWindowBounds: (bounds, isMaximized) =>
      Effect.gen(function* () {
        if (input.beforeMainWindowBoundsUpdate) {
          yield* input.beforeMainWindowBoundsUpdate(bounds);
        }
        const changed =
          desktopSettings.mainWindowBounds === null ||
          !desktopWindowBoundsEquivalence(desktopSettings.mainWindowBounds, bounds) ||
          desktopSettings.mainWindowMaximized !== isMaximized;
        if (changed) {
          desktopSettings = {
            ...desktopSettings,
            mainWindowBounds: bounds,
            mainWindowMaximized: isMaximized,
          };
          input.mainWindowBoundsUpdates?.push(bounds);
          input.mainWindowMaximizedUpdates?.push(isMaximized);
        }
        return { settings: desktopSettings, changed };
      }),
    setServerExposureMode: () => Effect.die("unexpected server exposure update"),
    setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
    setUpdateChannel: () => Effect.die("unexpected update channel change"),
    setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
    setWslDistro: () => Effect.die("unexpected WSL distro change"),
    setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
    setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
    applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
    applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
  } satisfies DesktopAppSettings.DesktopAppSettings["Service"]);

  const layerElectronWindow = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: (options) =>
      Effect.sync(() => {
        input.createdWindowOptions?.push(options);
      }).pipe(
        Effect.andThen(Ref.update(input.createCount, (count) => count + 1)),
        Effect.andThen(input.beforeCreate?.() ?? Effect.void),
        Effect.as(input.window),
      ),
    main: Ref.get(input.mainWindow),
    currentMainOrFirst: Effect.map(Ref.get(input.mainWindow), (mainWindow) =>
      Option.isSome(mainWindow) ? mainWindow : Option.fromNullishOr(input.auxiliaryWindow ?? null),
    ),
    focusedMainOrFirst: Effect.map(Ref.get(input.mainWindow), (mainWindow) =>
      Option.isSome(mainWindow) ? mainWindow : Option.fromNullishOr(input.auxiliaryWindow ?? null),
    ),
    setMain: (window) =>
      (input.beforeMainWindowPublication?.(window) ?? Effect.void).pipe(
        Effect.andThen(Ref.set(input.mainWindow, Option.some(window))),
      ),
    clearMain: () => Ref.set(input.mainWindow, Option.none()),
    prepareReveal: () => Effect.succeed(false),
    reveal: (window) => Effect.sync(() => input.onReveal?.(window)),
    sendAll: () => Effect.void,
    destroyAll: Effect.void,
    syncAllAppearance: (sync) => sync(input.window),
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const desktopStateLayer =
    input.desktopState === undefined
      ? DesktopState.layer
      : Layer.succeed(DesktopState.DesktopState, input.desktopState);

  const desktopWindowWithDependencies = DesktopWindow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        desktopAssetsLayer,
        makeDesktopEnvironmentLayer(input.environment ?? environmentInput),
        layerDesktopAppSettings,
        layerDesktopClientSettings,
        layerDesktopServerExposure,
        layerDesktopRendererHistory,
        desktopStateLayer,
        Layer.mock(ElectronApp.ElectronApp)({ quit: input.onQuit?.() ?? Effect.void }),
        Layer.mock(ElectronDialog.ElectronDialog)({
          showMessageBox:
            input.onShowMessageBox ??
            (() => Effect.succeed({ response: 0, checkboxChecked: false })),
          showErrorBox: () => Effect.void,
        }),
        Layer.succeed(ElectronMenu.ElectronMenu, {
          setApplicationMenu: () => Effect.void,
          showContextMenu: () => Effect.succeedNone,
          popupTemplate: input.onPopupTemplate ?? (() => Effect.void),
        }),
        Layer.succeed(ElectronShell.ElectronShell, {
          openExternal: (url) =>
            Effect.sync(() => {
              input.openedExternalUrls?.push(url);
              return true;
            }),
          openSystemSettings: () => Effect.succeed(true),
          copyText: (text) =>
            Effect.sync(() => {
              input.copiedTexts?.push(text);
            }),
        } satisfies ElectronShell.ElectronShell["Service"]),
        layerElectronTheme,
        layerElectronWindow,
        Layer.mock(PreviewManager.PreviewManager)({
          getBrowserSession: () =>
            (input.beforeMainWindowPreparation?.() ?? Effect.void).pipe(
              Effect.as({} as Electron.Session),
            ),
          setMainWindow: () => Effect.void,
          prepareWebview: () => Effect.void,
          isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
          getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
          reapplyZoom: () =>
            Effect.sync(() => {
              input.previewZoomReapplies?.push(input.window.webContents.getZoomLevel());
            }),
        }),
      ),
    ),
  );
  return desktopWindowWithDependencies;
}

// Builds a DesktopWindow over a fake ElectronWindow whose `create` returns the
// given outcomes in order (null => simulated open failure), and whose
// currentMainOrFirst mirrors the real fallback to the first live window (the
// splash, before any main is registered). Reveal targets are recorded so tests
// can assert what activation actually surfaced.
const makeSplashScenario = (
  createOutcomes: readonly (Electron.BrowserWindow | null)[],
  input: {
    readonly environment?: DesktopEnvironment.MakeDesktopEnvironmentInput;
    readonly includeLifecycle?: boolean;
    readonly appListeners?: NodeEvents.EventEmitter;
    readonly onQuit?: () => Effect.Effect<void>;
    readonly onReveal?: (window: Electron.BrowserWindow) => void;
    readonly onShowMessageBox?: (
      options: Electron.MessageBoxOptions,
    ) => Effect.Effect<
      Electron.MessageBoxReturnValue,
      ElectronDialog.ElectronDialogShowMessageBoxError
    >;
    readonly onShowErrorBox?: (title: string, content: string) => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const createdWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const createCalls = yield* Ref.make(0);
    const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const revealedWindows = yield* Ref.make<Electron.BrowserWindow[]>([]);
    const fallbackWindow = createOutcomes.find(
      (window): window is Electron.BrowserWindow => window !== null,
    );

    const currentMainOrFirst = Effect.gen(function* () {
      const registered = yield* Ref.get(mainWindow);
      if (Option.isSome(registered)) {
        return registered;
      }
      const created = yield* Ref.get(createdWindows);
      return Option.fromNullishOr(created[0] ?? null);
    });

    const electronWindowShape = {
      create: () =>
        Effect.gen(function* () {
          const index = yield* Ref.getAndUpdate(createCalls, (count) => count + 1);
          const outcome = createOutcomes[index] ?? null;
          if (outcome === null) {
            return yield* new ElectronWindow.ElectronWindowCreateError({
              options: {
                title: null,
                width: null,
                height: null,
                minWidth: null,
                minHeight: null,
                show: null,
                modal: null,
                frame: null,
                transparent: null,
                backgroundColor: null,
                webPreferences: {
                  preload: null,
                  partition: null,
                  backgroundThrottling: null,
                  sandbox: null,
                  contextIsolation: null,
                  nodeIntegration: null,
                  webviewTag: null,
                },
              },
              cause: new Error("simulated window-open failure"),
            });
          }
          yield* Ref.update(createdWindows, (windows) => [...windows, outcome]);
          return outcome;
        }),
      main: Ref.get(mainWindow),
      currentMainOrFirst,
      focusedMainOrFirst: currentMainOrFirst,
      setMain: (window) => Ref.set(mainWindow, Option.some(window)),
      clearMain: () => Ref.set(mainWindow, Option.none()),
      prepareReveal: () => Effect.succeed(false),
      reveal: (window) =>
        Ref.update(revealedWindows, (windows) => [...windows, window]).pipe(
          Effect.andThen(Effect.sync(() => input.onReveal?.(window))),
        ),
      sendAll: () => Effect.void,
      destroyAll: Effect.void,
      syncAllAppearance: (sync) => (fallbackWindow ? sync(fallbackWindow) : Effect.void),
    } satisfies ElectronWindow.ElectronWindow["Service"];

    const registerAppListener = <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          input.appListeners?.on(eventName, listener);
        }),
        () =>
          Effect.sync(() => {
            input.appListeners?.removeListener(eventName, listener);
          }),
      ).pipe(Effect.asVoid);
    const electronAppLayer = Layer.mock(ElectronApp.ElectronApp)({
      quit: input.onQuit?.() ?? Effect.void,
      ...(input.appListeners === undefined
        ? {}
        : {
            onBeforeQuitForUpdate: (listener: () => void) =>
              registerAppListener("before-quit-for-update", listener),
            on: <Args extends ReadonlyArray<unknown>>(
              eventName: string,
              listener: (...args: Args) => void,
            ) => registerAppListener(eventName, listener),
          }),
    });
    const dependencyLayer = Layer.mergeAll(
      desktopAssetsLayer,
      makeDesktopEnvironmentLayer(input.environment ?? environmentInput),
      DesktopAppSettings.layerTest(),
      layerDesktopClientSettings,
      layerDesktopServerExposure,
      layerDesktopRendererHistory,
      DesktopState.layer,
      electronAppLayer,
      Layer.mock(ElectronDialog.ElectronDialog)({
        showMessageBox:
          input.onShowMessageBox ?? (() => Effect.succeed({ response: 0, checkboxChecked: false })),
        showErrorBox: input.onShowErrorBox ?? (() => Effect.void),
      }),
      layerElectronMenu,
      Layer.succeed(ElectronShell.ElectronShell, {
        openExternal: () => Effect.succeed(true),
        openSystemSettings: () => Effect.succeed(true),
        copyText: () => Effect.void,
      } satisfies ElectronShell.ElectronShell["Service"]),
      layerElectronTheme,
      Layer.succeed(ElectronWindow.ElectronWindow, electronWindowShape),
      Layer.mock(PreviewManager.PreviewManager)({
        getBrowserSession: () => Effect.succeed({} as Electron.Session),
        setMainWindow: () => Effect.void,
        isBrowserPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
        getBrowserPartition: () => Effect.succeed("persist:t3code-preview-test"),
      }),
    );
    const desktopWindowWithDependencies = DesktopWindow.layer.pipe(
      Layer.provideMerge(dependencyLayer),
    );
    const lifecycleLayer = DesktopLifecycle.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(desktopWindowWithDependencies, DesktopShutdown.layer)),
    );
    const layer = input.includeLifecycle ? lifecycleLayer : desktopWindowWithDependencies;

    return { layer, lifecycleLayer, createCalls, mainWindow, revealedWindows } as const;
  });

const captureOne = DesktopSnapShotId.make("11111111-1111-4111-8111-111111111111");
const captureTwo = DesktopSnapShotId.make("22222222-2222-4222-8222-222222222222");

function decodeDataUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("expected a data URL");
  }
  const separator = value.indexOf(",");
  if (separator < 0) {
    throw new Error("expected a data URL payload");
  }
  return decodeURIComponent(value.slice(separator + 1));
}

function completeMainRendererLoad(
  fakeWindow: ReturnType<typeof makeFakeBrowserWindow>,
): Effect.Effect<void> {
  const loadURLReceipt = fakeWindow.loadURLReceipts.at(-1);
  if (loadURLReceipt === undefined) {
    return Effect.die("main renderer load receipt was not registered");
  }
  return Effect.promise(() => loadURLReceipt).pipe(Effect.asVoid);
}

function completeMainRendererStartup(
  fakeWindow: ReturnType<typeof makeFakeBrowserWindow>,
): Effect.Effect<void> {
  return completeMainRendererLoad(fakeWindow).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const paintReceipt = fakeWindow.executeJavaScriptReceipts.at(-1);
        return paintReceipt === undefined
          ? Effect.die("main renderer paint receipt was not registered")
          : Effect.promise(() => paintReceipt).pipe(Effect.asVoid);
      }),
    ),
  );
}

describe("DesktopWindow", () => {
  it.effect("shows native context menus for browser guests and sign-in popups", () =>
    Effect.gen(function* () {
      const host = makeFakeBrowserWindow();
      const popup = makeFakeBrowserWindow();
      let focusedContents: unknown = host.window.webContents;
      const makeContents = () => {
        const contents = Object.assign(new NodeEvents.EventEmitter(), {
          isDestroyed: vi.fn(() => false),
          focus: vi.fn(() => {
            focusedContents = contents;
          }),
          copyImageAt: vi.fn(),
          replaceMisspelling: vi.fn(),
        });
        return contents;
      };
      const guest = makeContents();
      const popupContents = makeContents();
      const popupWindow = { ...popup.window, webContents: popupContents };
      const menus = yield* Queue.unbounded<{
        input: ElectronMenu.ElectronMenuTemplateInput;
        focusedContents: unknown;
      }>();
      const copiedTexts: string[] = [];
      const layer = layerTest({
        window: host.window,
        createCount: yield* Ref.make(0),
        mainWindow: yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none()),
        copiedTexts,
        onPopupTemplate: (input) =>
          Queue.offer(menus, { input, focusedContents }).pipe(Effect.asVoid),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const attach = host.webContentsListeners.get("did-attach-webview");
        assert.isDefined(attach);
        attach({}, guest);
        attach({}, guest);
        guest.emit("did-create-window", popupWindow);
        guest.emit("did-create-window", popupWindow);

        for (const [contents, owner] of [
          [guest, host.window],
          [popupContents, popupWindow],
        ] as const) {
          const frame = { routingId: 7 } as Electron.WebFrameMain;
          const preventDefault = vi.fn();
          const params = {
            frame,
            x: 12,
            y: 34,
            misspelledWord: "helo",
            dictionarySuggestions: ["hello"],
            linkURL: "",
            mediaType: "none",
            editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true },
          };
          focusedContents = host.window.webContents;
          contents.emit("context-menu", { preventDefault }, params);
          const menu = yield* Queue.take(menus);
          assert.strictEqual(menu.input.window, owner);
          assert.strictEqual(menu.input.frame, frame);
          assert.strictEqual(menu.focusedContents, contents);
          assert.equal(preventDefault.mock.calls.length, 1);
          assert.deepEqual(
            menu.input.template.filter((item) => item.role),
            [
              { role: "cut", enabled: false },
              { role: "copy", enabled: true },
              { role: "paste", enabled: true },
              { role: "selectAll", enabled: true },
            ],
          );
          const correction = menu.input.template.find((item) => item.label === "hello");
          assert.isDefined(correction?.click);
          correction.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          assert.deepEqual(contents.replaceMisspelling.mock.calls, [["hello"]]);

          contents.emit(
            "context-menu",
            { preventDefault },
            {
              ...params,
              frame: null,
              misspelledWord: "",
              dictionarySuggestions: [],
              mediaType: "image",
              linkURL: "https://example.com/image.png",
            },
          );
          const imageMenu = (yield* Queue.take(menus)).input;
          assert.isUndefined(imageMenu.frame);
          const copyImage = imageMenu.template.find((item) => item.label === "Copy Image");
          const copyLink = imageMenu.template.find((item) => item.label === "Copy Link");
          assert.isDefined(copyImage?.click);
          assert.isDefined(copyLink?.click);
          copyImage.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          copyLink.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          assert.deepEqual(contents.copyImageAt.mock.calls, [[12, 34]]);
          assert.equal(copiedTexts.at(-1), "https://example.com/image.png");

          contents.isDestroyed.mockReturnValue(true);
          correction.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          copyImage.click({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
          assert.equal(contents.replaceMisspelling.mock.calls.length, 1);
          assert.equal(contents.copyImageAt.mock.calls.length, 1);
          assert.equal(yield* Queue.size(menus), 0);
        }
      }).pipe(Effect.provide(layer));
    }),
  );

  it("leaves fullscreen before concealing a pending quit", () => {
    const fakeWindow = makeFakeBrowserWindow();

    DesktopWindow.concealPendingQuitWindow(fakeWindow.window);
    assert.deepEqual(fakeWindow.setOpacity.mock.calls, [[0]]);

    fakeWindow.setOpacity.mockClear();
    fakeWindow.isFullScreen.mockReturnValue(true);
    DesktopWindow.concealPendingQuitWindow(fakeWindow.window);
    assert.deepEqual(fakeWindow.setFullScreen.mock.calls, [[false]]);
    assert.deepEqual(fakeWindow.setOpacity.mock.calls, [[0]]);

    fakeWindow.setOpacity.mockClear();
    fakeWindow.isFullScreen.mockReturnValue(false);
    fakeWindow.isDestroyed.mockReturnValue(true);
    DesktopWindow.concealPendingQuitWindow(fakeWindow.window);
    assert.equal(fakeWindow.setOpacity.mock.calls.length, 0);
  });

  it("restores bounds only when the window fits within a connected display", () => {
    const persistedBounds = { x: 2040, y: 80, width: 1320, height: 880 };
    const displays = [
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ];

    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, displays),
      persistedBounds,
    );
    assert.deepEqual(
      DesktopWindow.resolveInitialMainWindowBounds(persistedBounds, [displays[0]!]),
      DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE,
    );
  });

  it("recognizes only same-origin renderer navigations", () => {
    assert.isTrue(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "t3code://app/settings/connections",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "t3code-dev://app/",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "https://accounts.microsoft.com/oauth",
      }),
    );
    assert.isFalse(
      DesktopWindow.isSameOriginRendererNavigation({
        applicationUrl: "t3code://app/",
        navigationUrl: "not a url",
      }),
    );
  });

  it.effect("does not open a development window until the backend is ready", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.activate;
        assert.equal(yield* Ref.get(createCount), 0);

        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(createdWindowOptions[0]?.width, 1100);
        assert.equal(createdWindowOptions[0]?.height, 780);
        assert.isUndefined(createdWindowOptions[0]?.x);
        assert.isUndefined(createdWindowOptions[0]?.y);
        assert.isTrue(createdWindowOptions[0]?.disableAutoHideCursor);
        assert.isFalse(createdWindowOptions[0]?.webPreferences?.backgroundThrottling);
        assert.deepEqual(fakeWindow.setAutoHideCursor.mock.calls, [[false]]);
        assert.deepEqual(fakeWindow.loadURL.mock.calls[0], ["t3code-dev://app/"]);
        assert.equal(fakeWindow.openDevTools.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "opens and reopens the window without backend readiness when local execution is disabled",
    () =>
      Effect.gen(function* () {
        const fakeWindow = makeFakeBrowserWindow();
        const createCount = yield* Ref.make(0);
        const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
        const layer = layerTest({
          window: fakeWindow.window,
          createCount,
          mainWindow,
          createdWindowOptions: [],
          desktopSettings: {
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: false,
          },
        });
        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          yield* desktopWindow.createMainIfBackendReady;
          assert.equal(yield* Ref.get(createCount), 1);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(createCount), 2);
          yield* Ref.set(mainWindow, Option.none());
          yield* desktopWindow.dispatchMenuAction("new-thread");
          assert.equal(yield* Ref.get(createCount), 3);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("shows a static startup splash once with the ordinary startup label", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.showConnectingSplash;

        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(createdWindowOptions[0]?.frame, true);
        assert.include(decodeDataUrl(fakeWindow.loadURL.mock.calls[0]?.[0]), "Starting T3 Code…");
        const splashHtml = decodeDataUrl(fakeWindow.loadURL.mock.calls[0]?.[0]);
        assert.notInclude(splashHtml, "animation");
        assert.notInclude(splashHtml, "@keyframes");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("labels the startup splash as connecting to WSL for WSL-only startup", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          wslBackendEnabled: true,
          wslOnly: true,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;

        assert.include(decodeDataUrl(fakeWindow.loadURL.mock.calls[0]?.[0]), "Connecting to WSL…");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("shows the startup splash after its slow load completes", () =>
    Effect.gen(function* () {
      let resolveLoad: (() => void) | undefined;
      const fakeWindow = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((resolve) => {
            resolveLoad = resolve;
          }),
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        if (!readyToShow) {
          return yield* Effect.die("splash ready-to-show listener was not registered");
        }

        readyToShow();
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(fakeWindow.show.mock.calls.length, 0);

        resolveLoad?.();
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(fakeWindow.show.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("activating while the main renderer is pending reveals only the splash", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.activate;

        assert.equal(yield* Ref.get(scenario.createCalls), 2);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [splash.window]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("activating after renderer readiness reuses the same main window", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* completeMainRendererStartup(main);

        yield* desktopWindow.activate;

        assert.equal(yield* Ref.get(scenario.createCalls), 2);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [main.window, main.window]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("serializes concurrent activation and readiness window creation", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createStarted = yield* Deferred.make<void>();
      const allowCreate = yield* Deferred.make<void>();
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        beforeCreate: () =>
          Deferred.succeed(createStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowCreate)),
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const readinessFiber = yield* desktopWindow
          .handleBackendReady(new URL("http://127.0.0.1:3773"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(createStarted);

        const activationFiber = yield* desktopWindow.activate.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(createCount), 1);

        yield* Deferred.succeed(allowCreate, undefined);
        yield* Fiber.join(readinessFiber);
        yield* Fiber.join(activationFiber);
        assert.equal(yield* Ref.get(createCount), 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("serializes concurrent ensure and backend-ready main creation", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const preparationStarted = yield* Deferred.make<void>();
      const allowPreparation = yield* Deferred.make<void>();
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        beforeMainWindowPreparation: () =>
          Deferred.succeed(preparationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowPreparation)),
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const ensureFiber = yield* desktopWindow.ensureMain.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.await(preparationStarted);

        const backendReadyFiber = yield* desktopWindow
          .handleBackendReady(new URL("http://127.0.0.1:3773"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(createCount), 0);

        yield* Deferred.succeed(allowPreparation, undefined);
        yield* Fiber.join(ensureFiber);
        yield* Fiber.join(backendReadyFiber);

        assert.equal(yield* Ref.get(createCount), 1);
        assert.isTrue(Option.isSome(yield* Ref.get(mainWindow)));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not publish a main created after quitting during preparation", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const preparationStarted = yield* Deferred.make<void>();
      const allowPreparation = yield* Deferred.make<void>();
      const quitting = yield* Ref.make(false);
      const desktopState = {
        backendReady: yield* Ref.make(false),
        quitting,
      } satisfies DesktopState.DesktopState["Service"];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopState,
        beforeMainWindowPreparation: () =>
          Deferred.succeed(preparationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowPreparation)),
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const backendReadyFiber = yield* desktopWindow
          .handleBackendReady(new URL("http://127.0.0.1:3773"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(preparationStarted);

        yield* Ref.set(quitting, true);
        yield* Deferred.succeed(allowPreparation, undefined);
        yield* Fiber.join(backendReadyFiber);

        assert.equal(yield* Ref.get(createCount), 0);
        assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
        assert.equal(fakeWindow.destroy.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("destroys an unpublished main when quitting races publication", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const publicationStarted = yield* Deferred.make<void>();
      const allowPublication = yield* Deferred.make<void>();
      const quitting = yield* Ref.make(false);
      const desktopState = {
        backendReady: yield* Ref.make(false),
        quitting,
      } satisfies DesktopState.DesktopState["Service"];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopState,
        beforeMainWindowPublication: () =>
          Deferred.succeed(publicationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowPublication)),
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const backendReadyFiber = yield* desktopWindow
          .handleBackendReady(new URL("http://127.0.0.1:3773"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(publicationStarted);

        yield* Ref.set(quitting, true);
        yield* Deferred.succeed(allowPublication, undefined);
        yield* Fiber.join(backendReadyFiber);

        assert.equal(yield* Ref.get(createCount), 1);
        assert.isTrue(Option.isNone(yield* Ref.get(mainWindow)));
        assert.equal(fakeWindow.destroy.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not dispatch a menu action on did-finish-load before first reveal", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      let resolveMainLoad: (() => void) | undefined;
      const main = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((resolve) => {
            resolveMainLoad = resolve;
          }),
      });
      const scenario = yield* makeSplashScenario([splash.window, main.window]);
      const sends = yield* Queue.unbounded<void>();
      main.send.mockImplementation(() => {
        Queue.offerUnsafe(sends, undefined);
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        main.webContents.isLoadingMainFrame.mockReturnValue(true);

        yield* desktopWindow.dispatchMenuAction("open-settings");
        assert.equal(main.send.mock.calls.length, 0);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), []);

        const didFinishLoad = main.webContentsListeners.get("did-finish-load");
        if (!didFinishLoad) {
          return yield* Effect.die("main renderer load listener was not registered");
        }
        main.webContents.isLoadingMainFrame.mockReturnValue(false);
        didFinishLoad();
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(main.send.mock.calls.length, 0);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), []);

        resolveMainLoad?.();
        yield* completeMainRendererStartup(main);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [main.window]);
        yield* Queue.take(sends);
        assert.deepEqual(main.send.mock.calls, [[MENU_ACTION_CHANNEL, "open-settings"]]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("revealOrCreateMain re-reveals only the splash while main is pending", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.revealOrCreateMain;

        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [splash.window]);
        assert.equal(yield* Ref.get(scenario.createCalls), 2);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("does not maximize or throttle after a late load callback while quitting", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const quitting = yield* Ref.make(false);
      const desktopState = {
        backendReady: yield* Ref.make(false),
        quitting,
      } satisfies DesktopState.DesktopState["Service"];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopState,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowMaximized: true,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const didFinishLoad = fakeWindow.webContentsListeners.get("did-finish-load");
        if (!didFinishLoad) {
          return yield* Effect.die("main renderer load listener was not registered");
        }

        yield* Ref.set(quitting, true);
        didFinishLoad();
        yield* completeMainRendererLoad(fakeWindow);

        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.maximize.mock.calls.length, 0);
        assert.equal(fakeWindow.setBackgroundThrottling.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retries a failed first reveal and dismisses the splash after activation", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      let failFirstMainReveal = true;
      const scenario = yield* makeSplashScenario([splash.window, main.window], {
        onReveal: (window) => {
          if (window === main.window && failFirstMainReveal) {
            failFirstMainReveal = false;
            throw new Error("simulated first reveal failure");
          }
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* completeMainRendererStartup(main);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [main.window]);
        assert.equal(splash.close.mock.calls.length, 0);

        yield* desktopWindow.activate;

        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [main.window, main.window]);
        assert.equal(splash.close.mock.calls.length, 1);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("does not treat an auxiliary window as the main window", () =>
    Effect.gen(function* () {
      const auxiliaryWindow = makeFakeBrowserWindow();
      const mainWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const registeredMain = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: mainWindow.window,
        createCount,
        mainWindow: registeredMain,
        auxiliaryWindow: auxiliaryWindow.window,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        const created = yield* desktopWindow.ensureMain;

        assert.strictEqual(created, mainWindow.window);
        assert.equal(yield* Ref.get(createCount), 1);
        assert.strictEqual(Option.getOrThrow(yield* Ref.get(registeredMain)), mainWindow.window);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not hand off on did-finish-load before the load attempt fulfills", () =>
    Effect.gen(function* () {
      let resolveMainLoad: (() => void) | undefined;
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((resolve) => {
            resolveMainLoad = resolve;
          }),
      });
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const didFinishLoad = main.webContentsListeners.get("did-finish-load");
        if (!didFinishLoad) {
          return yield* Effect.die("main renderer load listener was not registered");
        }
        didFinishLoad();
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), []);

        resolveMainLoad?.();
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("waits for a successful renderer load before handing off from the splash", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      let resolveMainLoad: (() => void) | undefined;
      let resolveInitialPaint: (() => void) | undefined;
      const main = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((resolve) => {
            resolveMainLoad = resolve;
          }),
        executeJavaScript: () =>
          new Promise<void>((resolve) => {
            resolveInitialPaint = resolve;
          }),
      });
      const quitCalls: void[] = [];
      const scenario = yield* makeSplashScenario([splash.window, main.window], {
        onQuit: () =>
          Effect.sync(() => {
            quitCalls.push(undefined);
          }),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        if (main.loadURLReceipts.length !== 1) {
          return yield* Effect.die("renderer load receipt was not registered");
        }

        resolveMainLoad?.();
        yield* completeMainRendererLoad(main);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), []);
        assert.equal(splash.close.mock.calls.length, 0);
        assert.equal(main.executeJavaScript.mock.calls.length, 1);
        assert.equal(
          main.executeJavaScript.mock.calls[0]?.[0],
          "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );

        resolveInitialPaint?.();
        const paintReceipt = main.executeJavaScriptReceipts.at(-1);
        if (paintReceipt === undefined) {
          return yield* Effect.die("renderer paint receipt was not registered");
        }
        yield* Effect.promise(() => paintReceipt).pipe(Effect.asVoid);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [main.window]);
        assert.equal(splash.close.mock.calls.length, 1);
        assert.equal(quitCalls.length, 0);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("uses a successful renderer load as the Linux reveal fallback", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const revealedWindows: Electron.BrowserWindow[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        environment: { ...environmentInput, platform: "linux" },
        onReveal: (window) => {
          revealedWindows.push(window);
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererLoad(fakeWindow);
        assert.equal(fakeWindow.executeJavaScript.mock.calls.length, 0);
        assert.deepEqual(revealedWindows, [fakeWindow.window]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not hand off when the loaded document has another authority", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      main.webContents.getURL.mockReturnValue("t3code-dev://other/");
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(main);

        assert.equal(main.executeJavaScript.mock.calls.length, 1);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), []);
        assert.equal(splash.close.mock.calls.length, 0);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("does not revive an attempt after its current main-frame failure", () =>
    Effect.gen(function* () {
      let resolveMainLoad: (() => void) | undefined;
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((resolve) => {
            resolveMainLoad = resolve;
          }),
      });
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const didFailLoad = main.webContentsListeners.get("did-fail-load");
        if (!didFailLoad) {
          return yield* Effect.die("renderer failure listener was not registered");
        }

        didFailLoad({}, -3, "ERR_ABORTED", "t3code-dev://app/", true);
        resolveMainLoad?.();
        const loadReceipt = main.loadURLReceipts[0];
        if (!loadReceipt) {
          return yield* Effect.die("renderer load receipt was not registered");
        }
        yield* Effect.promise(() => loadReceipt);

        assert.equal(main.executeJavaScript.mock.calls.length, 0);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), []);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("does not probe paint or reveal again after the initial handoff", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const nativeReveal = vi.fn((window: Electron.BrowserWindow) => {
        if (window.isMinimized()) {
          window.restore();
        }
        if (!window.isVisible()) {
          window.show();
        }
        window.focus();
      });
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onReveal: nativeReveal,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);
        assert.equal(fakeWindow.executeJavaScript.mock.calls.length, 1);
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(nativeReveal.mock.calls.length, 1);

        fakeWindow.restore.mockClear();
        fakeWindow.show.mockClear();
        fakeWindow.focus.mockClear();
        fakeWindow.isMinimized.mockReturnValue(true);
        fakeWindow.isVisible.mockReturnValue(false);

        const renderProcessGone = fakeWindow.webContentsListeners.get("render-process-gone");
        if (!renderProcessGone) {
          return yield* Effect.die("render process recovery listener was not registered");
        }
        renderProcessGone({}, { reason: "crashed", exitCode: 1 });
        yield* TestClock.adjust(500);
        yield* completeMainRendererLoad(fakeWindow);

        assert.equal(fakeWindow.loadURL.mock.calls.length, 2);
        assert.equal(fakeWindow.executeJavaScript.mock.calls.length, 1);
        assert.equal(nativeReveal.mock.calls.length, 1);
        assert.equal(fakeWindow.restore.mock.calls.length, 0);
        assert.equal(fakeWindow.show.mock.calls.length, 0);
        assert.equal(fakeWindow.focus.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("retains a rejected splash hidden and ignores late readiness", () =>
    Effect.gen(function* () {
      let rejectLoad: ((cause: unknown) => void) | undefined;
      let resolveLoad: (() => void) | undefined;
      const fakeWindow = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((resolve, reject) => {
            resolveLoad = resolve;
            rejectLoad = reject;
          }),
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      let revealCalls = 0;
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onReveal: () => {
          revealCalls += 1;
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        const readyToShow = fakeWindow.windowListeners.get("ready-to-show");
        const didFinishLoad = fakeWindow.webContentsOnceListeners.get("did-finish-load");
        if (!readyToShow || !didFinishLoad) {
          return yield* Effect.die("splash readiness listeners were not registered");
        }

        rejectLoad?.(new Error("splash rejected"));
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(fakeWindow.close.mock.calls.length, 0);

        readyToShow();
        didFinishLoad();
        resolveLoad?.();
        yield* Effect.promise(() => Promise.resolve());
        assert.equal(fakeWindow.show.mock.calls.length, 0);
        yield* desktopWindow.activate;
        assert.equal(revealCalls, 0);
        yield* desktopWindow.showConnectingSplash;
        assert.equal(yield* Ref.get(createCount), 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not quit through the lifecycle when the splash load fails", () =>
    Effect.gen(function* () {
      let rejectLoad: ((cause: unknown) => void) | undefined;
      const splash = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          }),
      });
      const appListeners = new NodeEvents.EventEmitter();
      const quitRequested = yield* Deferred.make<void>();
      const quitCalls: void[] = [];
      const markDestroyed = () => {
        splash.isDestroyed.mockReturnValue(true);
        if (splash.isDestroyed()) {
          appListeners.emit("window-all-closed");
        }
      };
      splash.close.mockImplementation(markDestroyed);
      splash.destroy.mockImplementation(markDestroyed);
      const scenario = yield* makeSplashScenario([splash.window], {
        environment: { ...environmentInput, platform: "linux" },
        includeLifecycle: true,
        appListeners,
        onQuit: () =>
          Effect.sync(() => {
            quitCalls.push(undefined);
          }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined))),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
          const desktopWindow = yield* DesktopWindow.DesktopWindow;
          assert.isAbove(appListeners.listenerCount("window-all-closed"), 0);

          yield* desktopWindow.showConnectingSplash;
          rejectLoad?.(new Error("splash rejected"));
          yield* Effect.promise(() => Promise.resolve());

          assert.equal(splash.close.mock.calls.length, 0);
          assert.equal(splash.destroy.mock.calls.length, 0);
          assert.equal(quitCalls.length, 0);
          assert.isFalse(yield* Deferred.isDone(quitRequested));
        }),
      ).pipe(Effect.provide(scenario.lifecycleLayer));
    }),
  );

  it.effect("closes a failed splash after main handoff without quitting", () =>
    Effect.gen(function* () {
      let rejectLoad: ((cause: unknown) => void) | undefined;
      const splash = makeFakeBrowserWindow({
        loadURL: () =>
          new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          }),
      });
      const main = makeFakeBrowserWindow();
      const appListeners = new NodeEvents.EventEmitter();
      const quitCalls: void[] = [];
      const markSplashDestroyed = () => {
        splash.isDestroyed.mockReturnValue(true);
        if (splash.isDestroyed() && main.isDestroyed()) {
          appListeners.emit("window-all-closed");
        }
      };
      splash.close.mockImplementation(markSplashDestroyed);
      splash.destroy.mockImplementation(markSplashDestroyed);
      const scenario = yield* makeSplashScenario([splash.window, main.window], {
        environment: { ...environmentInput, platform: "linux" },
        includeLifecycle: true,
        appListeners,
        onQuit: () =>
          Effect.sync(() => {
            quitCalls.push(undefined);
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          yield* desktopWindow.showConnectingSplash;
          rejectLoad?.(new Error("splash rejected"));
          yield* Effect.promise(() => Promise.resolve());
          assert.equal(splash.close.mock.calls.length, 0);

          yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
          yield* completeMainRendererLoad(main);

          assert.equal(splash.close.mock.calls.length, 1);
          assert.equal(quitCalls.length, 0);
          assert.isFalse(main.isDestroyed());
        }),
      ).pipe(Effect.provide(scenario.lifecycleLayer));
    }),
  );

  it.effect("requests quit for a user-closed startup splash", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const quitRequested = yield* Deferred.make<void>();
      const quitCalls: void[] = [];
      const quitting = yield* Ref.make(false);
      const desktopState = {
        backendReady: yield* Ref.make(false),
        quitting,
      } satisfies DesktopState.DesktopState["Service"];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopState,
        onQuit: () =>
          Effect.sync(() => {
            quitCalls.push(undefined);
          }).pipe(Effect.andThen(Deferred.succeed(quitRequested, undefined))),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("splash close listener was not registered");
        }

        close();
        yield* Deferred.await(quitRequested);
        assert.equal(quitCalls.length, 1);
        assert.isTrue(yield* Ref.get(quitting));
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not create or reveal startup windows after quitting", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const quitting = yield* Ref.make(true);
      const desktopState = {
        backendReady: yield* Ref.make(false),
        quitting,
      } satisfies DesktopState.DesktopState["Service"];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopState,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.activate;
        yield* desktopWindow.createMainIfBackendReady;
        assert.equal(yield* Ref.get(createCount), 0);
        assert.equal(fakeWindow.show.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("blocks only repeated Cmd+W input before it reaches the native window menu", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const beforeInput = fakeWindow.webContentsListeners.get("before-input-event");
        if (!beforeInput) {
          return yield* Effect.die("before-input-event listener was not registered");
        }

        let prevented = false;
        const event = { preventDefault: () => (prevented = true) };
        const input = {
          type: "keyDown",
          isAutoRepeat: true,
          key: "W",
          meta: true,
          control: false,
          alt: false,
          shift: false,
        };
        beforeInput(event, input);
        assert.isTrue(prevented);

        prevented = false;
        beforeInput(event, { ...input, isAutoRepeat: false });
        assert.isFalse(prevented);

        prevented = false;
        beforeInput(event, { ...input, meta: false });
        assert.isFalse(prevented);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("forwards native trackpad release to the renderer", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const send = vi.spyOn(fakeWindow.window.webContents, "send");
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        const onInput = fakeWindow.webContentsListeners.get("input-event");
        if (!onInput) return yield* Effect.die("input-event listener was not registered");
        onInput({}, { type: "gestureScrollUpdate" });
        assert.notInclude(
          send.mock.calls.map(([channel]) => channel),
          TRACKPAD_SCROLL_END_CHANNEL,
        );
        onInput({}, { type: "gestureScrollEnd" });
        assert.isTrue(send.mock.calls.some(([channel]) => channel === TRACKPAD_SCROLL_END_CHANNEL));
      }).pipe(Effect.provide(layer));
    }),
  );

  // Chromium hands the main window's zoom level down to embedded preview
  // guests, so every app zoom has to put the preview browser back at its own
  // zoom or zooming the UI drags the previewed page with it.
  it.effect("restores the preview browser's own zoom after zooming the app", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const previewZoomReapplies: number[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        previewZoomReapplies,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("out");
        yield* desktopWindow.zoomMain("in");
        yield* desktopWindow.zoomMain("reset");

        assert.deepEqual(
          fakeWindow.setZoomLevel.mock.calls.map(([level]) => level),
          [-0.5, -1, -0.5, 0],
        );
        // Recorded after the window level moved, so the preview is put back at
        // its own zoom on every step rather than left on the inherited one.
        assert.deepEqual(previewZoomReapplies, [-0.5, -1, -0.5, 0]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("keeps macOS window buttons centered when zooming and leaving fullscreen", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        for (const direction of ["in", "in", "out", "reset", "out"] as const) {
          yield* desktopWindow.zoomMain(direction);
          const position = fakeWindow.setWindowButtonPosition.mock.lastCall?.[0];
          assert.isDefined(position);
          // The 14-point native buttons should share the zoomed 52px header's center.
          const headerCenter = 26 * fakeWindow.window.webContents.getZoomFactor();
          assert.isAtMost(Math.abs(position.y + 7 - headerCenter), 0.5);
          assert.equal(position.x, 16);
        }

        fakeWindow.isFullScreen.mockReturnValue(true);
        fakeWindow.setWindowButtonPosition.mockClear();
        yield* desktopWindow.zoomMain("reset");
        assert.equal(fakeWindow.setWindowButtonPosition.mock.calls.length, 0);

        fakeWindow.isFullScreen.mockReturnValue(false);
        fakeWindow.windowListeners.get("leave-full-screen")?.();
        assert.deepEqual(fakeWindow.setWindowButtonPosition.mock.lastCall, [{ x: 16, y: 19 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("uses the persisted main window bounds when opening the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(createdWindowOptions[0]?.width, 1320);
        assert.equal(createdWindowOptions[0]?.height, 880);
        assert.equal(createdWindowOptions[0]?.x, 120);
        assert.equal(createdWindowOptions[0]?.y, 80);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("restores the persisted maximized state", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
          mainWindowMaximized: true,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(fakeWindow.maximize.mock.calls.length, 0);
        yield* completeMainRendererStartup(fakeWindow);
        assert.equal(fakeWindow.maximize.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves saved maximized state when a pending main closes before reveal", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 120, y: 80, width: 1320, height: 880 },
          mainWindowMaximized: true,
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("pending main close listener was not registered");
        }

        close();
        yield* desktopWindow.flushMainWindowBounds;
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);
        assert.deepEqual(mainWindowMaximizedUpdates, []);
        assert.equal(fakeWindow.maximize.mock.calls.length, 0);

        yield* completeMainRendererStartup(fakeWindow);
        assert.equal(fakeWindow.maximize.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  // The window boots hidden with throttling disabled so first paint runs at
  // full speed; the first reveal must hand it back to normal hidden-window
  // throttling or a minimized window stays expensive forever.
  it.effect("re-enables background throttling on first reveal", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        assert.equal(fakeWindow.setBackgroundThrottling.mock.calls.length, 0);
        yield* completeMainRendererStartup(fakeWindow);
        assert.deepEqual(fakeWindow.setBackgroundThrottling.mock.calls, [[true]]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("debounces move and resize bounds updates", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const move = fakeWindow.windowListeners.get("move");
        const resize = fakeWindow.windowListeners.get("resize");
        if (!move || !resize) {
          return yield* Effect.die("window bounds listeners were not registered");
        }

        fakeWindow.getBounds.mockReturnValue({ x: 120, y: 80, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(250);

        fakeWindow.getBounds.mockReturnValue({ x: 160, y: 100, width: 1360, height: 900 });
        resize();
        yield* TestClock.adjust(499);
        assert.deepEqual(mainWindowBoundsUpdates, []);

        yield* TestClock.adjust(1);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 160, y: 100, width: 1360, height: 900 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists normal bounds and state for a maximized window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.isMaximized.mockReturnValue(true);
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("persists normal bounds and state from the native maximize event", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const mainWindowMaximizedUpdates: boolean[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        mainWindowMaximizedUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const maximize = fakeWindow.windowListeners.get("maximize");
        if (!maximize) {
          return yield* Effect.die("window maximize listener was not registered");
        }

        fakeWindow.isMaximized.mockReturnValue(true);
        fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
        fakeWindow.getNormalBounds.mockReturnValue({ x: 220, y: 140, width: 1380, height: 920 });
        maximize();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 220, y: 140, width: 1380, height: 920 }]);
        assert.deepEqual(mainWindowMaximizedUpdates, [true]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("does not persist bounds that fail the domain schema", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 100.4, y: 80.2, width: 839.4, height: 619.4 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());

        assert.deepEqual(mainWindowBoundsUpdates, []);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("preserves unrestorable bounds until the user changes the window", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        desktopSettings: {
          ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
          mainWindowBounds: { x: 2040, y: 80, width: 1320, height: 880 },
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const close = fakeWindow.windowListeners.get("close");
        const move = fakeWindow.windowListeners.get("move");
        if (!close || !move) {
          return yield* Effect.die("window lifecycle listeners were not registered");
        }

        close();
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, []);

        fakeWindow.getBounds.mockReturnValue({ x: 80, y: 60, width: 1280, height: 840 });
        move();
        yield* TestClock.adjust(500);
        yield* Effect.promise(() => Promise.resolve());
        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 80, y: 60, width: 1280, height: 840 }]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when fullscreen before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 0, y: 0, width: 1920, height: 1080 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 200, y: 130, width: 1400, height: 940 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isFullScreen.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 200, y: 130, width: 1400, height: 940 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("flushes normal bounds when minimized before the debounce completes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: -32_000, y: -32_000, width: 160, height: 28 });
      fakeWindow.getNormalBounds.mockReturnValue({ x: 180, y: 120, width: 1440, height: 960 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const resize = fakeWindow.windowListeners.get("resize");
        if (!resize) {
          return yield* Effect.die("window resize listener was not registered");
        }
        resize();
        yield* TestClock.adjust(250);
        fakeWindow.isMinimized.mockReturnValue(true);

        yield* desktopWindow.flushMainWindowBounds;

        assert.deepEqual(mainWindowBoundsUpdates, [{ x: 180, y: 120, width: 1440, height: 960 }]);
        assert.equal(fakeWindow.getBounds.mock.calls.length, 0);
        assert.equal(fakeWindow.getNormalBounds.mock.calls.length, 1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("logs display lookup failures before falling back to the default size", () =>
    Effect.gen(function* () {
      const displayLookupFailure = new Error("screen API unavailable");
      vi.mocked(Electron.screen.getAllDisplays).mockImplementationOnce(() => {
        throw displayLookupFailure;
      });
      const logRecords: Array<{
        readonly message: unknown;
        readonly annotations: Readonly<Record<string, unknown>>;
      }> = [];
      const logger = Logger.make(({ fiber, message }) => {
        logRecords.push({
          message,
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const createdWindowOptions: Electron.BrowserWindowConstructorOptions[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        createdWindowOptions,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
      }).pipe(
        Effect.provide(Layer.mergeAll(layer, Logger.layer([logger], { mergeWithExisting: false }))),
      );

      const warning = logRecords.find(
        (record) =>
          Array.isArray(record.message) &&
          record.message[0] === "failed to read connected displays; using defaults",
      );
      assert.isDefined(warning);
      assert.strictEqual(warning.annotations.cause, displayLookupFailure);
      assert.equal(createdWindowOptions[0]?.width, 1100);
      assert.equal(createdWindowOptions[0]?.height, 780);
      assert.isUndefined(createdWindowOptions[0]?.x);
      assert.isUndefined(createdWindowOptions[0]?.y);
    }),
  );

  it.effect("persists the current main window bounds before the window closes", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.getBounds.mockReturnValue({ x: 240, y: 160, width: 1410, height: 930 });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const mainWindowBoundsUpdates: DesktopAppSettings.DesktopWindowBounds[] = [];
      const writeStarted = yield* Deferred.make<void>();
      const allowWrite = yield* Deferred.make<void>();
      const flushCompleted = yield* Deferred.make<void>();
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        mainWindowBoundsUpdates,
        beforeMainWindowBoundsUpdate: () =>
          Deferred.succeed(writeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(allowWrite)),
            Effect.asVoid,
          ),
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);

        const close = fakeWindow.windowListeners.get("close");
        if (!close) {
          return yield* Effect.die("window close listener was not registered");
        }
        close();
        yield* Deferred.await(writeStarted);
        fakeWindow.isDestroyed.mockReturnValue(true);

        const flushFiber = yield* desktopWindow.flushMainWindowBounds.pipe(
          Effect.andThen(Deferred.succeed(flushCompleted, undefined)),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.yieldNow;
        assert.isFalse(yield* Deferred.isDone(flushCompleted));

        yield* Deferred.succeed(allowWrite, undefined);
        yield* Fiber.join(flushFiber);
        assert.isTrue(yield* Deferred.isDone(flushCompleted));

        assert.deepEqual(mainWindowBoundsUpdates, [
          {
            x: 240,
            y: 160,
            width: 1410,
            height: 930,
          },
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("publishes native macOS fullscreen changes to the renderer", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const enterFullscreen = fakeWindow.windowListeners.get("enter-full-screen");
        const leaveFullscreen = fakeWindow.windowListeners.get("leave-full-screen");
        if (!enterFullscreen || !leaveFullscreen) {
          return yield* Effect.die("fullscreen listeners were not registered");
        }

        enterFullscreen();
        leaveFullscreen();
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [WINDOW_FULLSCREEN_STATE_CHANNEL, true],
          [WINDOW_FULLSCREEN_STATE_CHANNEL, false],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("opens safe off-origin renderer navigations in the system browser", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const openedExternalUrls: unknown[] = [];
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        openedExternalUrls,
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        const willNavigate = fakeWindow.webContentsListeners.get("will-navigate");
        if (!willNavigate) {
          return yield* Effect.die("will-navigate listener was not registered");
        }
        let prevented = false;
        willNavigate(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "https://accounts.microsoft.com/oauth",
        );
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(openedExternalUrls, ["https://accounts.microsoft.com/oauth"]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "re-reveals the connecting splash on activate while the backend is still cold-booting",
    () =>
      Effect.gen(function* () {
        const splash = makeFakeBrowserWindow();
        // Only the splash is ever created; the backend never reports ready.
        const scenario = yield* makeSplashScenario([splash.window]);

        yield* Effect.gen(function* () {
          const desktopWindow = yield* DesktopWindow.DesktopWindow;

          yield* desktopWindow.showConnectingSplash;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);

          // Taskbar/dock activation during cold boot must bring the splash back
          // rather than no-op and leave it hidden until the backend finishes.
          yield* desktopWindow.activate;
          assert.equal(yield* Ref.get(scenario.createCalls), 1);
          assert.deepEqual(yield* Ref.get(scenario.revealedWindows), [splash.window]);
        }).pipe(Effect.provide(scenario.layer));
      }),
  );

  it.effect("does not dispatch menu actions to the splash before the backend is ready", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, main.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;

        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.dispatchMenuAction("open-settings");

        assert.equal(yield* Ref.get(scenario.createCalls), 1);
        assert.equal(splash.send.mock.calls.length, 0);
        assert.equal(main.send.mock.calls.length, 0);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("dispatches menu actions after backend readiness when no main window exists", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const main = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window, main.window]);
      const sends = yield* Queue.unbounded<void>();
      main.send.mockImplementation(() => {
        Queue.offerUnsafe(sends, undefined);
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;

        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));

        yield* desktopWindow.dispatchMenuAction("open-settings");
        yield* completeMainRendererStartup(main);
        yield* Effect.promise(() => Promise.resolve());
        yield* Queue.take(sends);

        assert.equal(yield* Ref.get(scenario.createCalls), 2);
        assert.deepEqual(main.send.mock.calls, [[MENU_ACTION_CHANNEL, "open-settings"]]);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("delivers capture completion and late errors without taking focus back", () =>
    Effect.gen(function* () {
      const operations: Array<string> = [];
      let foreground = "Discord";
      const fakeWindow = makeFakeBrowserWindow();
      fakeWindow.send.mockImplementation(() => {
        operations.push("send");
      });
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onReveal: () => {
          foreground = "T3 Code";
          operations.push("reveal");
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);
        operations.length = 0;
        yield* desktopWindow.dispatchSnapShotEvent({ type: "started", id: captureOne });
        assert.equal(foreground, "T3 Code");
        foreground = "Explorer";
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });
        yield* desktopWindow.dispatchSnapShotEvent({ type: "failed", id: captureTwo });

        assert.equal(foreground, "Explorer");
        assert.deepEqual(operations, ["send", "reveal", "send", "send"]);
        assert.deepEqual(fakeWindow.send.mock.calls, [
          [SNAP_SHOT_EVENT_CHANNEL, { type: "started", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "ready", id: captureOne }],
          [SNAP_SHOT_EVENT_CHANNEL, { type: "failed", id: captureTwo }],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("delivers the renderer event even when the reveal fails", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      let revealAttempts = 0;
      const layer = layerTest({
        window: fakeWindow.window,
        createCount,
        mainWindow,
        onReveal: () => {
          revealAttempts += 1;
          if (revealAttempts > 1) {
            throw new Error("another process kept the foreground");
          }
        },
      });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        yield* completeMainRendererStartup(fakeWindow);
        yield* Effect.exit(
          desktopWindow.dispatchSnapShotEvent({ type: "started", id: captureOne }),
        );

        assert.deepEqual(fakeWindow.send.mock.calls, [
          [SNAP_SHOT_EVENT_CHANNEL, { type: "started", id: captureOne }],
        ]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("leaves a completed capture pending while only the connecting splash exists", () =>
    Effect.gen(function* () {
      const splash = makeFakeBrowserWindow();
      const scenario = yield* makeSplashScenario([splash.window]);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.showConnectingSplash;
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });

        assert.equal(yield* Ref.get(scenario.createCalls), 1);
        assert.equal(splash.send.mock.calls.length, 0);
        assert.deepEqual(yield* Ref.get(scenario.revealedWindows), []);
      }).pipe(Effect.provide(scenario.layer));
    }),
  );

  it.effect("does not reopen a closed main window for a completed capture", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const onReveal = vi.fn();
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow, onReveal });

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.handleBackendReady(new URL("http://127.0.0.1:3773"));
        fakeWindow.isDestroyed.mockReturnValue(true);
        yield* Ref.set(mainWindow, Option.none());
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });

        assert.equal(yield* Ref.get(createCount), 1);
        assert.equal(fakeWindow.send.mock.calls.length, 0);
        assert.equal(onReveal.mock.calls.length, 0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("waits for a loading renderer without foregrounding it when capture is ready", () =>
    Effect.gen(function* () {
      const fakeWindow = makeFakeBrowserWindow();
      const createCount = yield* Ref.make(0);
      const mainWindow = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(
        Option.some(fakeWindow.window),
      );
      const onReveal = vi.fn();
      const layer = layerTest({ window: fakeWindow.window, createCount, mainWindow, onReveal });
      vi.mocked(fakeWindow.window.webContents.isLoadingMainFrame).mockReturnValue(true);

      yield* Effect.gen(function* () {
        const desktopWindow = yield* DesktopWindow.DesktopWindow;
        yield* desktopWindow.dispatchSnapShotEvent({ type: "ready", id: captureOne });
        assert.equal(fakeWindow.send.mock.calls.length, 0);
        const onLoad = fakeWindow.webContentsOnce.mock.calls.find(
          ([event]) => event === "did-finish-load",
        )?.[1];
        assert.isDefined(onLoad);
        onLoad?.();

        assert.deepEqual(fakeWindow.send.mock.calls, [
          [SNAP_SHOT_EVENT_CHANNEL, { type: "ready", id: captureOne }],
        ]);
        assert.equal(onReveal.mock.calls.length, 0);
        assert.equal(yield* Ref.get(createCount), 0);
      }).pipe(Effect.provide(layer));
    }),
  );
});
