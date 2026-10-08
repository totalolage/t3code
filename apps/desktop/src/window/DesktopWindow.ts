import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import { type DesktopSnapShotEvent, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import {
  MENU_ACTION_CHANNEL,
  QUIT_SHORTCUT_CHANNEL,
  SNAP_SHOT_EVENT_CHANNEL,
  TRACKPAD_SCROLL_END_CHANNEL,
  WINDOW_FULLSCREEN_STATE_CHANNEL,
} from "../ipc/channels.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopRendererHistory from "../telemetry/DesktopRendererHistory.ts";
import { makeQuitShortcutHandler } from "./QuitHold.ts";

const TITLEBAR_HEIGHT = 40;
// Matches --workspace-topbar-height in apps/web/src/index.css. Native macOS
// buttons are 14 points tall and do not scale with the renderer's zoom.
const MACOS_WORKSPACE_TOPBAR_HEIGHT = 52;
const MACOS_WINDOW_BUTTON_RADIUS = 7;

function syncMacosWindowButtons(window: Electron.BrowserWindow): void {
  if (window.isDestroyed() || window.isFullScreen()) return;
  window.setWindowButtonPosition({
    x: 16,
    y: Math.round(
      (MACOS_WORKSPACE_TOPBAR_HEIGHT * window.webContents.getZoomFactor()) / 2 -
        MACOS_WINDOW_BUTTON_RADIUS,
    ),
  });
}

const TITLEBAR_COLOR = "#01000000"; // #00000000 does not work correctly on Linux
const TITLEBAR_LIGHT_SYMBOL_COLOR = "#1f2937";
const TITLEBAR_DARK_SYMBOL_COLOR = "#f8fafc";
const MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS = 500;
// Renderer crash (usually V8 OOM on long sessions) recovery: reload after a
// short delay, at most MAX_ATTEMPTS times per rolling WINDOW so a renderer
// that dies on boot cannot reload-loop forever.
const RENDERER_RECOVERY_RELOAD_DELAY_MS = 500;
const RENDERER_RECOVERY_MAX_ATTEMPTS = 3;
const RENDERER_RECOVERY_WINDOW_MS = 60_000;

type WindowTitleBarOptions = Pick<
  Electron.BrowserWindowConstructorOptions,
  "titleBarOverlay" | "titleBarStyle" | "trafficLightPosition"
>;

type DesktopWindowRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopAssets.DesktopAssets
  | DesktopState.DesktopState
  | DesktopAppSettings.DesktopAppSettings
  | DesktopClientSettings.DesktopClientSettings
  | ElectronApp.ElectronApp
  | ElectronMenu.ElectronMenu
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | DesktopRendererHistory.DesktopRendererHistory
  | PreviewManager.PreviewManager;

type MainWindowReadiness = {
  readonly ready: Deferred.Deferred<void, never>;
  readonly requestReveal: (revealSplash: boolean) => Effect.Effect<void>;
  readonly isHandoffComplete: () => boolean;
  readonly isClosed: () => boolean;
};

type ApplicationLoadAttempt = {
  terminalFailure: boolean;
};

const INITIAL_RENDERER_PAINT_SCRIPT =
  "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

export type DesktopWindowError =
  | ElectronWindow.ElectronWindowCreateError
  | PreviewManager.PreviewManagerError;

export type MainWindowZoomDirection = "in" | "out" | "reset";

export class DesktopWindow extends Context.Service<
  DesktopWindow,
  {
    readonly createMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly ensureMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly revealOrCreateMain: Effect.Effect<Electron.BrowserWindow, DesktopWindowError>;
    readonly activate: Effect.Effect<void, DesktopWindowError>;
    readonly createMainIfBackendReady: Effect.Effect<void, DesktopWindowError>;
    // Show a lightweight startup splash before the backend that serves the
    // renderer is ready. Its label reflects whether WSL-only startup is active,
    // and it is dismissed automatically once the real main window reveals.
    readonly showConnectingSplash: Effect.Effect<void>;
    // Marks the primary backend as ready so `createMainIfBackendReady` and the
    // macOS "activate without windows" path may open the real main window. The
    // renderer now always loads the local client URL (getDesktopUrl) and connects
    // to the backend through the connection layer, so the reported httpBaseUrl is
    // no longer used to point the window at the backend — it is kept only for the
    // readiness log and to preserve the callback contract the backend pool drives.
    readonly handleBackendReady: (httpBaseUrl: URL) => Effect.Effect<void, DesktopWindowError>;
    // Called when the backend transitions back to "not ready" (clean stop,
    // restart, crash). Clears the latch that lets `activate` auto-create a
    // window so a "macOS dock click" while the backend is down doesn't
    // produce a stranded window pointing at nothing.
    readonly handleBackendNotReady: Effect.Effect<void>;
    readonly flushMainWindowBounds: Effect.Effect<void>;
    readonly prepareCaptureReveal: Effect.Effect<void>;
    readonly dispatchMenuAction: (
      action: string,
      options?: { readonly reveal?: boolean },
    ) => Effect.Effect<void, DesktopWindowError>;
    /**
     * Push a capture lifecycle event to the renderer. Only `started` reveals the
     * window; the rest must not interrupt the app the user has switched to.
     */
    readonly dispatchSnapShotEvent: (
      event: DesktopSnapShotEvent,
    ) => Effect.Effect<void, DesktopWindowError>;
    // Zooms the main window's own webContents. The Electron `zoomIn`/`zoomOut`
    // menu roles act on whichever webContents has keyboard focus, so with an
    // embedded preview WebContentsView (or DevTools) focused they zoom the
    // guest page instead of the app UI. The menu routes here to always target
    // the main window.
    readonly zoomMain: (direction: MainWindowZoomDirection) => Effect.Effect<void>;
    readonly syncAppearance: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopWindow") {}

const { logInfo: logWindowInfo, logWarning: logWindowWarning } =
  makeComponentLogger("desktop-window");

function getIconOption(
  iconPaths: DesktopAssets.DesktopIconPaths,
  platform: NodeJS.Platform,
): { icon: string } | Record<string, never> {
  if (platform === "darwin") return {}; // macOS uses .icns from app bundle
  const ext = platform === "win32" ? "ico" : "png";
  return Option.match(iconPaths[ext], {
    onNone: () => ({}),
    onSome: (icon) => ({ icon }),
  });
}

function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}

type DisplayBounds = Pick<Electron.Rectangle, "x" | "y" | "width" | "height">;

function windowFitsWithinDisplay(
  windowBounds: DesktopAppSettings.DesktopWindowBounds,
  displayBounds: DisplayBounds,
): boolean {
  return (
    windowBounds.x >= displayBounds.x &&
    windowBounds.y >= displayBounds.y &&
    windowBounds.x + windowBounds.width <= displayBounds.x + displayBounds.width &&
    windowBounds.y + windowBounds.height <= displayBounds.y + displayBounds.height
  );
}

function windowBoundsEqual(
  left: DesktopAppSettings.DesktopWindowBounds,
  right: DesktopAppSettings.DesktopWindowBounds,
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveInitialMainWindowBounds(
  persistedBounds: DesktopAppSettings.DesktopWindowBounds | null,
  displays: readonly DisplayBounds[],
): DesktopAppSettings.DesktopWindowBounds | typeof DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE {
  if (
    persistedBounds !== null &&
    displays.some((display) => windowFitsWithinDisplay(persistedBounds, display))
  ) {
    return persistedBounds;
  }
  return DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE;
}

// A self-contained startup splash, shown before the backend and renderer are
// ready. Inlined as a data URL so it needs no bundled asset or backend — pure
// CSS, no JS.
function buildConnectingSplashDataUrl(
  shouldUseDarkColors: boolean,
  labelText: "Connecting to WSL…" | "Starting T3 Code…",
): string {
  const background = getInitialWindowBackgroundColor(shouldUseDarkColors);
  const label = shouldUseDarkColors ? "#9ca3af" : "#6b7280";
  const accent = shouldUseDarkColors ? "#f8fafc" : "#1f2937";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%}body{background:${background};color:${label};font-family:system-ui,-apple-system,'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;-webkit-user-select:none;user-select:none;-webkit-app-region:drag}.mark{width:18px;height:18px;border-radius:6px;background:${accent}}.label{font-size:13px}</style></head><body><div class="mark"></div><div class="label">${labelText}</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export function isSameOriginRendererNavigation(input: {
  readonly applicationUrl: string;
  readonly navigationUrl: string;
}): boolean {
  try {
    const applicationUrl = new URL(input.applicationUrl);
    const navigationUrl = new URL(input.navigationUrl);
    if (applicationUrl.origin === "null" || navigationUrl.origin === "null") {
      // URL.origin is "null" for the custom t3code:// and t3code-dev://
      // schemes, so comparing origin alone would incorrectly treat the two
      // application protocols as interchangeable.
      return (
        applicationUrl.protocol === navigationUrl.protocol &&
        applicationUrl.host === navigationUrl.host
      );
    }
    return applicationUrl.origin === navigationUrl.origin;
  } catch {
    return false;
  }
}

export function concealPendingQuitWindow(
  window: Pick<
    Electron.BrowserWindow,
    "isDestroyed" | "isFullScreen" | "setFullScreen" | "setOpacity"
  >,
): void {
  if (window.isDestroyed()) return;
  if (window.isFullScreen()) {
    window.setFullScreen(false);
  }
  // Electron implements window opacity on macOS and Windows. Linux keeps the
  // release-gated quit behavior but cannot make the pending window disappear.
  window.setOpacity(0);
}

function getWindowTitleBarOptions(
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): WindowTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: {
        x: 16,
        y: MACOS_WORKSPACE_TOPBAR_HEIGHT / 2 - MACOS_WINDOW_BUTTON_RADIUS,
      },
    };
  }

  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor: shouldUseDarkColors ? TITLEBAR_DARK_SYMBOL_COLOR : TITLEBAR_LIGHT_SYMBOL_COLOR,
    },
  };
}

function syncWindowAppearance(
  window: Electron.BrowserWindow,
  shouldUseDarkColors: boolean,
  platform: NodeJS.Platform,
): Effect.Effect<void> {
  return Effect.sync(() => {
    if (window.isDestroyed()) {
      return;
    }

    window.setBackgroundColor(getInitialWindowBackgroundColor(shouldUseDarkColors));
    const { titleBarOverlay } = getWindowTitleBarOptions(shouldUseDarkColors, platform);
    if (typeof titleBarOverlay === "object") {
      window.setTitleBarOverlay(titleBarOverlay);
    }
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const previewManager = yield* PreviewManager.PreviewManager;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  const desktopState = yield* DesktopState.DesktopState;
  // Window-side latch for the primary backend's readiness. Set by
  // handleBackendReady (driven by the pool's onReady callback), cleared
  // by handleBackendNotReady (driven by onShutdown). Only consumed by
  // createMainIfBackendReady, which gates the post-readiness window
  // open in development and the macOS "activate without windows" path.
  const backendReadyRef = yield* Ref.make(false);
  // The transient startup splash window, tracked separately so it is never
  // mistaken for the real main window. Keep the classification after the ref is
  // cleared: successful handoff closes the splash asynchronously, and Electron
  // can still list it until its close event has finished.
  const splashWindowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const splashWindows = new WeakSet<Electron.BrowserWindow>();
  const failedSplashWindows = new WeakSet<Electron.BrowserWindow>();
  const programmaticSplashCloses = new WeakSet<Electron.BrowserWindow>();
  const mainWindowReadiness = new WeakMap<Electron.BrowserWindow, MainWindowReadiness>();
  const mainCreationMutex = yield* Semaphore.make(1);
  const context = yield* Effect.context<DesktopWindowRuntimeServices>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  let flushMainWindowBounds: Effect.Effect<void> = Effect.void;

  const closeSplashWindow = (splash: Electron.BrowserWindow): void => {
    if (splash.isDestroyed()) return;
    programmaticSplashCloses.add(splash);
    try {
      splash.close();
    } catch {
      try {
        splash.destroy();
      } catch {
        // Best-effort startup UI must not make shutdown fail.
      }
    }
  };

  const requestQuit = (): void => {
    void runPromise(
      Effect.gen(function* () {
        const wasQuitting = yield* Ref.getAndSet(desktopState.quitting, true);
        if (!wasQuitting) {
          yield* electronApp.quit;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          logWindowWarning("failed to quit after startup splash close", { cause }),
        ),
      ),
    );
  };

  const dismissConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.getAndSet(splashWindowRef, Option.none());
    if (Option.isSome(splash) && !splash.value.isDestroyed()) {
      closeSplashWindow(splash.value);
    }
  });

  const liveRegisteredMainWindow = Effect.gen(function* () {
    const main = yield* electronWindow.main;
    if (Option.isNone(main) || main.value.isDestroyed()) {
      return Option.none<Electron.BrowserWindow>();
    }
    return main;
  });
  const currentMainWindow = liveRegisteredMainWindow;
  const focusedMainWindow = liveRegisteredMainWindow;

  const revealConnectingSplash = Effect.gen(function* () {
    const splash = yield* Ref.get(splashWindowRef);
    if (
      Option.isNone(splash) ||
      !splashWindows.has(splash.value) ||
      failedSplashWindows.has(splash.value) ||
      programmaticSplashCloses.has(splash.value) ||
      splash.value.isDestroyed() ||
      (yield* Ref.get(desktopState.quitting))
    ) {
      return;
    }
    yield* electronWindow.reveal(splash.value);
  });

  const requestMainReveal = (
    window: Electron.BrowserWindow,
    revealSplash = true,
  ): Effect.Effect<void> =>
    mainWindowReadiness.get(window)?.requestReveal(revealSplash) ?? Effect.void;

  const createWindow = Effect.fn("desktop.window.createWindow")(function* (
    onAllocated: (window: Electron.BrowserWindow) => void,
  ): Effect.fn.Return<Option.Option<Electron.BrowserWindow>, DesktopWindowError> {
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    yield* previewManager.getBrowserSession();
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const iconPaths = yield* assets.iconPaths;
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    const iconOption = getIconOption(iconPaths, environment.platform);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    const persistedSettings = yield* desktopSettings.get;
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    const persistedBounds = persistedSettings.mainWindowBounds;
    const displayBoundsResult = yield* Effect.sync(() => {
      try {
        return {
          _tag: "Success" as const,
          bounds: Electron.screen.getAllDisplays().map((display) => display.bounds),
        };
      } catch (cause) {
        return { _tag: "Failure" as const, cause };
      }
    });
    const displayBounds =
      displayBoundsResult._tag === "Success"
        ? displayBoundsResult.bounds
        : yield* logWindowWarning("failed to read connected displays; using defaults", {
            cause: displayBoundsResult.cause,
          }).pipe(Effect.as<readonly Electron.Rectangle[]>([]));
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    const initialBounds = resolveInitialMainWindowBounds(persistedBounds, displayBounds);
    const restoredPersistedBounds = persistedBounds !== null && initialBounds === persistedBounds;
    if (persistedBounds !== null && initialBounds === DesktopAppSettings.DEFAULT_MAIN_WINDOW_SIZE) {
      yield* logWindowWarning("saved main window bounds could not be restored; using defaults");
    }
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    const window = yield* electronWindow.create({
      ...initialBounds,
      minWidth: 840,
      minHeight: 620,
      show: false,
      autoHideMenuBar: true,
      ...(environment.platform === "darwin" ? { disableAutoHideCursor: true } : {}),
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      ...iconOption,
      title: environment.displayName,
      ...getWindowTitleBarOptions(shouldUseDarkColors, environment.platform),
      webPreferences: {
        preload: environment.preloadPath,
        // The window boots hidden (show: false until first reveal), and
        // Chromium throttles hidden renderers: timers coalesce and rAF stops,
        // which stalls first paint. Boot unthrottled; the first-reveal trigger
        // re-enables throttling so a hidden or minimized window goes back to
        // being cheap after it has been shown once.
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: true,
      },
    });
    onAllocated(window);
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }

    yield* rendererHistory.register(window.webContents, { surface: "main" });
    if (environment.platform === "darwin") {
      window.setAutoHideCursor(false);
    }
    let boundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let pendingBoundsPersistFiber: Fiber.Fiber<void, never> | undefined;
    let initialRevealCompleted = false;
    let boundsPersistenceEnabled = persistedBounds === null || restoredPersistedBounds;
    const readPersistableBounds = (): DesktopAppSettings.DesktopWindowBounds | null => {
      if (window.isDestroyed()) {
        return null;
      }
      const bounds =
        window.isFullScreen() || window.isMaximized() || window.isMinimized()
          ? window.getNormalBounds()
          : window.getBounds();
      return DesktopAppSettings.normalizeMainWindowBounds({
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      });
    };
    const fallbackWindowBounds = boundsPersistenceEnabled ? null : readPersistableBounds();
    const fallbackWindowMaximized = persistedSettings.mainWindowMaximized;
    const persistCurrentBounds = (): Fiber.Fiber<void, never> | undefined => {
      if (!initialRevealCompleted || !boundsPersistenceEnabled) {
        return pendingBoundsPersistFiber;
      }
      const bounds = readPersistableBounds();
      if (bounds === null) {
        return pendingBoundsPersistFiber;
      }
      pendingBoundsPersistFiber = runFork(
        desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(
          Effect.asVoid,
          Effect.catch((error) =>
            logWindowWarning("failed to persist main window bounds", {
              message: error.message,
            }),
          ),
        ),
      );
      return pendingBoundsPersistFiber;
    };
    const scheduleBoundsPersist = () => {
      if (!initialRevealCompleted) {
        return;
      }
      if (!boundsPersistenceEnabled) {
        const currentBounds = readPersistableBounds();
        if (
          currentBounds === null ||
          (fallbackWindowBounds !== null &&
            windowBoundsEqual(currentBounds, fallbackWindowBounds) &&
            window.isMaximized() === fallbackWindowMaximized)
        ) {
          return;
        }
      }
      boundsPersistenceEnabled = true;
      if (boundsPersistFiber !== undefined) {
        const fiber = boundsPersistFiber;
        boundsPersistFiber = undefined;
        runFork(Fiber.interrupt(fiber));
      }
      boundsPersistFiber = runFork(
        Effect.sleep(MAIN_WINDOW_BOUNDS_PERSIST_DEBOUNCE_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              boundsPersistFiber = undefined;
              void persistCurrentBounds();
            }),
          ),
        ),
      );
    };
    const clearBoundsPersist = () => {
      if (boundsPersistFiber === undefined) {
        return;
      }
      const fiber = boundsPersistFiber;
      boundsPersistFiber = undefined;
      runFork(Fiber.interrupt(fiber));
    };
    const flushBoundsPersist = Effect.sync(() => {
      clearBoundsPersist();
      return persistCurrentBounds();
    }).pipe(
      Effect.flatMap((fiber) =>
        fiber === undefined ? Effect.void : Fiber.join(fiber).pipe(Effect.asVoid),
      ),
    );
    flushMainWindowBounds = flushBoundsPersist;

    yield* previewManager.setMainWindow(window);
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none();
    }
    window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (
        typeof params.partition !== "string" ||
        !previewManager.isBrowserPartition(params.partition)
      ) {
        event.preventDefault();
        return;
      }
      webPreferences.sandbox = true;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = false;
    });

    const contextMenuContents = new WeakSet<Electron.WebContents>();
    const installContextMenu = (
      ownerWindow: Electron.BrowserWindow,
      contents: Electron.WebContents,
    ): void => {
      if (contextMenuContents.has(contents)) return;
      contextMenuContents.add(contents);
      contents.on("context-menu", (event, params) => {
        event.preventDefault();
        if (contents.isDestroyed() || ownerWindow.isDestroyed()) return;
        // Native editing roles act on the focused contents, which may still be
        // the host renderer when the user right-clicks inside a browser guest.
        contents.focus();

        const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

        if (params.misspelledWord) {
          for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
            menuTemplate.push({
              label: suggestion,
              click: () => {
                if (!contents.isDestroyed()) contents.replaceMisspelling(suggestion);
              },
            });
          }
          if (params.dictionarySuggestions.length === 0) {
            menuTemplate.push({ label: "No suggestions", enabled: false });
          }
          menuTemplate.push({ type: "separator" });
        }

        if (Option.isSome(ElectronShell.parseSafeExternalUrl(params.linkURL))) {
          menuTemplate.push(
            {
              label: "Copy Link",
              click: () => {
                void runPromise(electronShell.copyText(params.linkURL));
              },
            },
            { type: "separator" },
          );
        }

        if (params.mediaType === "image") {
          menuTemplate.push({
            label: "Copy Image",
            click: () => {
              if (!contents.isDestroyed()) contents.copyImageAt(params.x, params.y);
            },
          });
          menuTemplate.push({ type: "separator" });
        }

        menuTemplate.push(
          { role: "cut", enabled: params.editFlags.canCut },
          { role: "copy", enabled: params.editFlags.canCopy },
          { role: "paste", enabled: params.editFlags.canPaste },
          { role: "selectAll", enabled: params.editFlags.canSelectAll },
        );

        void runPromise(
          electronMenu.popupTemplate({
            window: ownerWindow,
            template: menuTemplate,
            ...(params.frame ? { frame: params.frame } : {}),
          }),
        );
      });
      contents.on("did-create-window", (popup) => {
        installContextMenu(popup, popup.webContents);
      });
    };
    installContextMenu(window, window.webContents);
    window.webContents.on("did-attach-webview", (_event, contents) => {
      installContextMenu(window, contents);
      void runPromise(previewManager.prepareWebview(contents));
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (
        isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: url,
        })
      ) {
        return;
      }

      event.preventDefault();
      if (Option.isSome(ElectronShell.parseSafeExternalUrl(url))) {
        void runPromise(electronShell.openExternal(url));
      }
    });

    // Electron's windowMenu close role owns CmdOrCtrl+W. Holding the
    // close-terminal shortcut can outlive the terminal that handled its first
    // press, so reject repeats before they reach the native window accelerator.
    // Deliberate presses still flow through the renderer or native menu.
    // Intercept the quit accelerator before the native menu sees it and apply
    // the configured direct, hold, or double-press behavior.
    const quitShortcutHandler = makeQuitShortcutHandler({
      platform: environment.platform,
      getMode: () =>
        runPromise(
          Effect.map(
            clientSettings.get,
            Option.match({
              onNone: () => DEFAULT_CLIENT_SETTINGS.confirmQuit,
              onSome: (settings) => settings.confirmQuit,
            }),
          ),
        ),
      notify: (hint) => {
        if (!window.isDestroyed()) {
          window.webContents.send(QUIT_SHORTCUT_CHANNEL, hint);
        }
      },
      // Keep the transparent window focused until the physical shortcut is
      // released so its remaining repeats cannot reach the next app.
      concealWindow: () => concealPendingQuitWindow(window),
      quit: () => {
        void runPromise(electronApp.quit);
      },
    });
    window.webContents.on("before-input-event", (event, input) => {
      quitShortcutHandler(event, input);
      if (input.type !== "keyDown" || !input.isAutoRepeat) return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;
      if (modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w") {
        event.preventDefault();
      }
    });
    window.webContents.on("input-event", (_event, input) => {
      if (input.type === "gestureScrollEnd") window.webContents.send(TRACKPAD_SCROLL_END_CHANNEL);
    });

    window.on("page-title-updated", (event) => {
      event.preventDefault();
      window.setTitle(environment.displayName);
    });
    window.on("resize", scheduleBoundsPersist);
    window.on("move", scheduleBoundsPersist);
    window.on("maximize", scheduleBoundsPersist);
    window.on("unmaximize", scheduleBoundsPersist);
    window.on("close", () => {
      runFork(flushBoundsPersist);
    });

    if (environment.platform === "darwin") {
      window.on("enter-full-screen", () => {
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, true);
      });
      window.on("leave-full-screen", () => {
        syncMacosWindowButtons(window);
        window.webContents.send(WINDOW_FULLSCREEN_STATE_CHANNEL, false);
      });
    }

    let rendererRecoveryTimestamps: number[] = [];
    let applicationLoadSucceeded = false;
    let startupHandoffComplete = false;
    let firstRevealInFlight = false;
    let firstRevealRequestQueued = false;
    let windowClosed = false;
    const mainReady = yield* Deferred.make<void>();
    let currentApplicationLoadAttempt: ApplicationLoadAttempt | undefined;
    let loadApplication: () => void;
    const isCurrentApplicationLoadAttempt = (attempt: ApplicationLoadAttempt): boolean =>
      currentApplicationLoadAttempt === attempt && !windowClosed && !window.isDestroyed();

    const handleApplicationLoadFailure = (
      attempt: ApplicationLoadAttempt,
      cause: unknown,
      errorCode?: number,
      errorDescription?: string,
    ): void => {
      if (!isCurrentApplicationLoadAttempt(attempt) || attempt.terminalFailure) {
        return;
      }
      attempt.terminalFailure = true;
      if (!startupHandoffComplete) {
        applicationLoadSucceeded = false;
      }
      void runPromise(
        Effect.gen(function* () {
          if (!isCurrentApplicationLoadAttempt(attempt) || (yield* Ref.get(desktopState.quitting)))
            return;
          yield* logWindowWarning("main window failed to load", {
            ...(errorCode === undefined ? {} : { errorCode }),
            ...(errorDescription === undefined ? {} : { errorDescription }),
            ...(cause instanceof Error ? { cause: cause.message } : { cause }),
          });
        }),
      );
    };

    const finishApplicationLoad = (attempt: ApplicationLoadAttempt): void => {
      if (
        !isCurrentApplicationLoadAttempt(attempt) ||
        attempt.terminalFailure ||
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      applicationLoadSucceeded = true;
      window.setTitle(environment.displayName);
      if (environment.platform === "darwin") syncMacosWindowButtons(window);
      if (!startupHandoffComplete) {
        scheduleReveal();
      }
    };

    const beginInitialRendererPaint = (attempt: ApplicationLoadAttempt): void => {
      if (!isCurrentApplicationLoadAttempt(attempt) || attempt.terminalFailure) {
        return;
      }
      let paintReceipt: Promise<unknown>;
      try {
        paintReceipt = window.webContents.executeJavaScript(INITIAL_RENDERER_PAINT_SCRIPT);
      } catch (cause) {
        handleApplicationLoadFailure(attempt, cause);
        return;
      }
      void paintReceipt.then(
        () => {
          void runPromise(
            Effect.gen(function* () {
              if (
                !isCurrentApplicationLoadAttempt(attempt) ||
                attempt.terminalFailure ||
                (yield* Ref.get(desktopState.quitting))
              )
                return;
              finishApplicationLoad(attempt);
            }),
          );
        },
        (cause) => {
          handleApplicationLoadFailure(attempt, cause);
        },
      );
    };

    const handleApplicationLoadSuccess = (attempt: ApplicationLoadAttempt): void => {
      if (!isCurrentApplicationLoadAttempt(attempt) || attempt.terminalFailure) {
        return;
      }
      void runPromise(
        Effect.gen(function* () {
          if (
            !isCurrentApplicationLoadAttempt(attempt) ||
            attempt.terminalFailure ||
            (yield* Ref.get(desktopState.quitting))
          )
            return;
          if (startupHandoffComplete || environment.platform === "linux") {
            finishApplicationLoad(attempt);
            return;
          }
          beginInitialRendererPaint(attempt);
        }),
      );
    };

    loadApplication = () => {
      if (window.isDestroyed()) {
        return;
      }
      const attempt: ApplicationLoadAttempt = {
        terminalFailure: false,
      };
      currentApplicationLoadAttempt = attempt;
      applicationLoadSucceeded = false;
      try {
        void window.loadURL(applicationUrl).then(
          () => handleApplicationLoadSuccess(attempt),
          (cause) => handleApplicationLoadFailure(attempt, cause),
        );
      } catch (cause) {
        handleApplicationLoadFailure(attempt, cause);
      }
    };

    window.webContents.on("did-finish-load", () => {
      if (window.isDestroyed()) {
        return;
      }
      if (
        !isSameOriginRendererNavigation({
          applicationUrl,
          navigationUrl: window.webContents.getURL(),
        })
      ) {
        return;
      }
      window.setTitle(environment.displayName);
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || window.isDestroyed()) {
          return;
        }
        if (
          isSameOriginRendererNavigation({
            applicationUrl,
            navigationUrl: validatedURL,
          })
        ) {
          const attempt = currentApplicationLoadAttempt;
          if (attempt !== undefined) {
            handleApplicationLoadFailure(attempt, undefined, errorCode, errorDescription);
            return;
          }
        }
        void runPromise(
          logWindowWarning("main window failed to load", {
            errorCode,
            errorDescription,
            url: validatedURL,
          }),
        );
      },
    );
    window.webContents.on("render-process-gone", (_event, details) => {
      const recoverable =
        details.reason === "crashed" ||
        details.reason === "oom" ||
        details.reason === "abnormal-exit";
      // Long sessions can OOM the renderer (V8 heap exhaustion from
      // accumulated thread state). Without a reload the user is left staring
      // at a dead white window while agents keep running invisibly, so
      // recover by reloading — the renderer rehydrates from the backend,
      // which is unaffected. Recovery attempts are bounded so a renderer
      // that dies immediately on boot cannot reload-loop forever.
      runFork(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          rendererRecoveryTimestamps = rendererRecoveryTimestamps.filter(
            (timestamp) => now - timestamp < RENDERER_RECOVERY_WINDOW_MS,
          );
          const shouldRecover =
            recoverable &&
            !window.isDestroyed() &&
            rendererRecoveryTimestamps.length < RENDERER_RECOVERY_MAX_ATTEMPTS;
          yield* logWindowWarning("main window render process gone", {
            reason: details.reason,
            exitCode: details.exitCode,
            recovering: shouldRecover,
          });
          if (!shouldRecover) {
            return;
          }
          rendererRecoveryTimestamps.push(now);
          yield* Effect.sleep(RENDERER_RECOVERY_RELOAD_DELAY_MS);
          if (!window.isDestroyed() && !(yield* Ref.get(desktopState.quitting))) {
            loadApplication();
          }
        }),
      );
    });

    const revealMain = (revealSplash: boolean) =>
      Effect.suspend(() => {
        if (windowClosed || window.isDestroyed()) {
          return Effect.void;
        }
        if (startupHandoffComplete) {
          return Ref.get(desktopState.quitting).pipe(
            Effect.flatMap((quitting) =>
              quitting || windowClosed || window.isDestroyed()
                ? Effect.void
                : electronWindow.reveal(window),
            ),
          );
        }
        if (!applicationLoadSucceeded) {
          return revealSplash ? revealConnectingSplash : Effect.void;
        }
        if (firstRevealInFlight) {
          return Effect.void;
        }
        firstRevealInFlight = true;
        return Effect.gen(function* () {
          if (windowClosed || window.isDestroyed() || (yield* Ref.get(desktopState.quitting))) {
            return;
          }
          // Boot is done; hand the window back to normal hidden-window throttling
          // (see the backgroundThrottling comment on the create options above).
          window.webContents.setBackgroundThrottling(true);
          if (windowClosed || window.isDestroyed() || (yield* Ref.get(desktopState.quitting))) {
            return;
          }
          if (persistedSettings.mainWindowMaximized) {
            window.maximize();
          }
          if (windowClosed || window.isDestroyed() || (yield* Ref.get(desktopState.quitting))) {
            return;
          }
          yield* electronWindow.reveal(window);
          if (windowClosed || window.isDestroyed() || (yield* Ref.get(desktopState.quitting))) {
            return;
          }
          startupHandoffComplete = true;
          initialRevealCompleted = true;
          yield* Deferred.succeed(mainReady, undefined);
          // Reveal the real window, then close the startup splash (if any) so
          // the two don't overlap and there is no blank gap between them.
          yield* dismissConnectingSplash;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              firstRevealInFlight = false;
            }),
          ),
        );
      });
    const requestReveal = (revealSplash: boolean): Effect.Effect<void> => {
      const firstRevealEligible = !startupHandoffComplete && applicationLoadSucceeded;
      if (firstRevealEligible) {
        if (firstRevealRequestQueued) {
          return Effect.void;
        }
        firstRevealRequestQueued = true;
      }
      return revealMain(revealSplash).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!startupHandoffComplete) {
              firstRevealRequestQueued = false;
            }
          }),
        ),
        Effect.catchCause((cause) =>
          logWindowWarning("failed to reveal main window after renderer load", { cause }),
        ),
      );
    };
    const scheduleReveal = () => {
      void runPromise(
        requestReveal(false).pipe(
          Effect.catchCause((cause) =>
            logWindowWarning("failed to reveal main window after renderer load", { cause }),
          ),
        ),
      );
    };
    mainWindowReadiness.set(window, {
      ready: mainReady,
      requestReveal,
      isHandoffComplete: () => startupHandoffComplete,
      isClosed: () => windowClosed,
    });

    loadApplication();
    if (environment.isDevelopment) {
      window.webContents.openDevTools({ mode: "detach" });
    }

    window.on("closed", () => {
      windowClosed = true;
      void runPromise(Deferred.succeed(mainReady, undefined).pipe(Effect.asVoid));
      clearBoundsPersist();
      void runPromise(electronWindow.clearMain(Option.some(window)));
    });

    return Option.some(window);
  });

  const createMainUnlocked = Effect.gen(function* () {
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) {
      return Option.some(existingWindow.value);
    }
    if (yield* Ref.get(desktopState.quitting)) {
      return Option.none<Electron.BrowserWindow>();
    }

    let allocatedWindow: Electron.BrowserWindow | undefined;
    let published = false;
    return yield* Effect.gen(function* () {
      const maybeWindow = yield* createWindow((window) => {
        allocatedWindow = window;
      });
      if (Option.isNone(maybeWindow)) {
        return Option.none<Electron.BrowserWindow>();
      }
      const window = maybeWindow.value;
      if (yield* Ref.get(desktopState.quitting)) {
        return Option.none<Electron.BrowserWindow>();
      }
      yield* electronWindow.setMain(window);
      if (yield* Ref.get(desktopState.quitting)) {
        yield* electronWindow.clearMain(Option.some(window));
        return Option.none<Electron.BrowserWindow>();
      }
      published = true;
      yield* logWindowInfo("main window created");
      return Option.some(window);
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          if (published || allocatedWindow === undefined) {
            return Effect.void;
          }
          const window = allocatedWindow;
          return Effect.gen(function* () {
            yield* electronWindow.clearMain(Option.some(window));
            if (!window.isDestroyed()) {
              try {
                window.destroy();
              } catch {
                // Best-effort cleanup must not mask the creation failure.
              }
            }
          });
        }),
      ),
    );
  });
  const mainCreationBoundary = mainCreationMutex.withPermits(1)(createMainUnlocked);

  const requireMain = (main: Option.Option<Electron.BrowserWindow>) =>
    Option.match(main, {
      onNone: () => Effect.interrupt,
      onSome: Effect.succeed,
    });
  const createMain = mainCreationBoundary.pipe(
    Effect.flatMap(requireMain),
    Effect.withSpan("desktop.window.createMain"),
  );
  const ensureMain = mainCreationBoundary.pipe(
    Effect.flatMap(requireMain),
    Effect.withSpan("desktop.window.ensureMain"),
  );

  const revealOrCreateMain = Effect.gen(function* () {
    const window = yield* ensureMain;
    yield* requestMainReveal(window);
    return window;
  }).pipe(Effect.withSpan("desktop.window.revealOrCreateMain"));

  // With the local environment disabled there is no backend to wait for: the
  // renderer is served from bundled assets and only talks to remote environments.
  const waitingForBackend = Effect.gen(function* () {
    if (yield* Ref.get(backendReadyRef)) return false;
    return (yield* desktopSettings.get).localEnvironmentEnabled;
  });

  const createMainIfBackendReady = Effect.gen(function* () {
    if (yield* waitingForBackend) return;
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) return;
    yield* mainCreationBoundary.pipe(Effect.asVoid);
  }).pipe(Effect.withSpan("desktop.window.createMainIfBackendReady"));

  const showConnectingSplash = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return;

    // Only when nothing is shown yet: no real window, no existing splash.
    const existingSplash = yield* Ref.get(splashWindowRef);
    if (Option.isSome(existingSplash)) {
      if (!existingSplash.value.isDestroyed()) return;
      yield* Ref.set(splashWindowRef, Option.none());
    }
    const existingWindow = yield* currentMainWindow;
    if (Option.isSome(existingWindow)) return;

    const settings = yield* desktopSettings.get;
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    if (yield* Ref.get(desktopState.quitting)) return;
    const splash = yield* electronWindow.create({
      width: 360,
      height: 220,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: true,
      center: true,
      show: false,
      skipTaskbar: false,
      backgroundColor: getInitialWindowBackgroundColor(shouldUseDarkColors),
      title: environment.displayName,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    yield* rendererHistory.register(splash.webContents, { surface: "splash" });
    splashWindows.add(splash);
    if (splash.isDestroyed() || (yield* Ref.get(desktopState.quitting))) {
      closeSplashWindow(splash);
      return;
    }
    yield* Ref.set(splashWindowRef, Option.some(splash));
    splash.once("closed", () => {
      programmaticSplashCloses.delete(splash);
      void runPromise(
        Ref.update(splashWindowRef, (current) =>
          Option.isSome(current) && current.value === splash ? Option.none() : current,
        ),
      );
    });
    let splashCloseRequested = false;
    splash.on("close", () => {
      if (!programmaticSplashCloses.has(splash)) {
        splashCloseRequested = true;
        requestQuit();
      }
    });

    let splashLoadSucceeded = false;
    let splashLoadFailed = false;
    let splashShown = false;
    const revealSplash = (): void => {
      if (
        splashShown ||
        splashLoadFailed ||
        !splashLoadSucceeded ||
        splashCloseRequested ||
        splash.isDestroyed()
      )
        return;
      splashShown = true;
      void runPromise(
        Effect.gen(function* () {
          if (splash.isDestroyed() || (yield* Ref.get(desktopState.quitting))) return;
          splash.show();
        }).pipe(
          Effect.catchCause((cause) =>
            logWindowWarning("failed to reveal connecting splash", { cause }),
          ),
        ),
      );
    };
    splash.once("ready-to-show", revealSplash);
    splash.webContents.once("did-finish-load", () => {
      if (splashLoadFailed) return;
      splashLoadSucceeded = true;
      revealSplash();
    });

    const handleSplashLoadFailure = (cause: unknown): void => {
      if (splashLoadFailed) return;
      splashLoadFailed = true;
      splashLoadSucceeded = false;
      failedSplashWindows.add(splash);
      void runPromise(
        logWindowWarning("failed to load connecting splash", {
          cause: cause instanceof Error ? cause.message : cause,
        }),
      );
    };

    const splashUrl = buildConnectingSplashDataUrl(
      shouldUseDarkColors,
      settings.wslOnly && settings.wslBackendEnabled ? "Connecting to WSL…" : "Starting T3 Code…",
    );
    try {
      void splash.loadURL(splashUrl).then(() => {
        if (splashLoadFailed) return;
        splashLoadSucceeded = true;
        revealSplash();
      }, handleSplashLoadFailure);
    } catch (cause) {
      handleSplashLoadFailure(cause);
    }
    yield* logWindowInfo("connecting splash shown");
  }).pipe(
    // The splash is best-effort UX — never let it fail startup.
    Effect.catch((error) =>
      logWindowWarning("failed to show connecting splash", {
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    Effect.withSpan("desktop.window.showConnectingSplash"),
  );

  const dispatchRendererEvent = Effect.fn("desktop.window.dispatchRendererEvent")(function* (
    channel: string,
    payload: unknown,
    { reveal = true }: { readonly reveal?: boolean } = {},
  ) {
    const existingWindow = yield* reveal ? focusedMainWindow : electronWindow.main;
    if (Option.isNone(existingWindow) && (!reveal || (yield* waitingForBackend))) return;
    const targetWindow = Option.isSome(existingWindow) ? existingWindow.value : yield* ensureMain;
    if (targetWindow.isDestroyed()) return;
    const send = Effect.sync(() => {
      if (!targetWindow.isDestroyed()) {
        targetWindow.webContents.send(channel, payload);
      }
    });
    const readiness = mainWindowReadiness.get(targetWindow);
    if (readiness !== undefined && !readiness.isHandoffComplete()) {
      void runPromise(
        readiness.requestReveal(false).pipe(
          Effect.ignoreCause,
          Effect.andThen(
            Effect.gen(function* () {
              yield* Deferred.await(readiness.ready);
            }),
          ),
          Effect.andThen(
            Effect.suspend(() =>
              readiness.isClosed() ||
              targetWindow.isDestroyed() ||
              readiness.isHandoffComplete() === false
                ? Effect.void
                : Ref.get(desktopState.quitting).pipe(
                    Effect.flatMap((quitting) => (quitting ? Effect.void : send)),
                  ),
            ),
          ),
          Effect.catchCause((cause) =>
            logWindowWarning("failed to dispatch renderer event after main reveal", { cause }),
          ),
        ),
      );
      return;
    }
    const dispatch = send.pipe(
      Effect.andThen(
        reveal
          ? Ref.get(desktopState.quitting).pipe(
              Effect.flatMap((quitting) =>
                quitting ? Effect.void : requestMainReveal(targetWindow).pipe(Effect.ignoreCause),
              ),
            )
          : Effect.void,
      ),
    );
    if (targetWindow.webContents.isLoadingMainFrame()) {
      targetWindow.webContents.once(
        "did-finish-load",
        () =>
          void runPromise(
            dispatch.pipe(
              Effect.catchCause((cause) =>
                logWindowWarning("failed to dispatch renderer event after renderer load", {
                  cause,
                }),
              ),
            ),
          ),
      );
      return;
    }
    yield* dispatch;
  });

  return DesktopWindow.of({
    createMain,
    ensureMain,
    revealOrCreateMain,
    prepareCaptureReveal: Effect.gen(function* () {
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* electronWindow.prepareReveal(existingWindow.value);
      }
    }),
    activate: Effect.gen(function* () {
      if (yield* Ref.get(desktopState.quitting)) return;
      const existingWindow = yield* currentMainWindow;
      if (Option.isSome(existingWindow)) {
        yield* requestMainReveal(existingWindow.value);
        return;
      }
      // During local backend startup, activation should re-reveal the splash.
      // With the local environment disabled, the bundled renderer can open
      // immediately without waiting for a backend.
      if (yield* waitingForBackend) {
        yield* revealConnectingSplash;
        return;
      }
      yield* createMainIfBackendReady;
      const createdWindow = yield* currentMainWindow;
      if (Option.isSome(createdWindow)) {
        yield* requestMainReveal(createdWindow.value);
      }
    }).pipe(Effect.withSpan("desktop.window.activate")),
    createMainIfBackendReady,
    showConnectingSplash,
    handleBackendReady: Effect.fn("desktop.window.handleBackendReady")(function* (httpBaseUrl) {
      if (yield* Ref.get(desktopState.quitting)) return;
      yield* Ref.set(backendReadyRef, true);
      yield* logWindowInfo("backend ready", { source: "http", url: httpBaseUrl.href });
      yield* createMainIfBackendReady;
    }),
    handleBackendNotReady: Ref.set(backendReadyRef, false).pipe(
      Effect.withSpan("desktop.window.handleBackendNotReady"),
    ),
    flushMainWindowBounds: Effect.suspend(() => flushMainWindowBounds).pipe(
      Effect.withSpan("desktop.window.flushMainWindowBounds"),
    ),
    dispatchMenuAction: Effect.fn("desktop.window.dispatchMenuAction")(function* (action, options) {
      yield* Effect.annotateCurrentSpan({ action });
      yield* dispatchRendererEvent(MENU_ACTION_CHANNEL, action, options);
    }),
    dispatchSnapShotEvent: Effect.fn("desktop.window.dispatchSnapShotEvent")(function* (event) {
      yield* Effect.annotateCurrentSpan({
        event: event.type,
        captureId: "id" in event ? (event.id ?? null) : null,
      });
      yield* dispatchRendererEvent(SNAP_SHOT_EVENT_CHANNEL, event, {
        reveal: event.type === "started",
      });
    }),
    zoomMain: Effect.fn("desktop.window.zoomMain")(function* (direction) {
      yield* Effect.annotateCurrentSpan({ direction });
      const window = yield* focusedMainWindow;
      if (Option.isNone(window) || window.value.isDestroyed()) {
        return;
      }
      const webContents = window.value.webContents;
      // Same step size as the Electron zoomIn/zoomOut menu roles.
      webContents.setZoomLevel(
        direction === "reset" ? 0 : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
      );
      if (environment.platform === "darwin") syncMacosWindowButtons(window.value);
      // Chromium pushes the new level down to embedded guests, which would zoom
      // the previewed page along with the app UI. The preview browser keeps its
      // own zoom, so put each guest back where the preview left it.
      yield* previewManager.reapplyZoom();
    }),
    syncAppearance: Effect.gen(function* () {
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window) =>
        syncWindowAppearance(window, shouldUseDarkColors, environment.platform),
      );
    }).pipe(Effect.withSpan("desktop.window.syncAppearance")),
  });
});

export const layer = Layer.effect(DesktopWindow, make);
