import {
  EFFECT_ELECTRON_RPC_CHANNELS,
  EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY,
  type EffectElectronRpcRendererBridge,
  type EffectElectronRpcRendererFrame,
  isEffectElectronRpcMainFrame,
  isEffectElectronRpcRendererFrame,
} from "./ipc.ts";

export interface ElectronLikeIpcRenderer {
  readonly send: (channel: string, frame: EffectElectronRpcRendererFrame) => void;
  readonly on: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
  readonly off?: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
  readonly removeListener?: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
}

export interface ElectronLikeContextBridge {
  readonly exposeInMainWorld: (apiKey: string, api: EffectElectronRpcRendererBridge) => void;
}

export function makeEffectElectronRpcPreloadBridge(
  electronIpcRenderer: ElectronLikeIpcRenderer,
  channels = EFFECT_ELECTRON_RPC_CHANNELS,
): EffectElectronRpcRendererBridge {
  return {
    send: (frame) => {
      if (!isEffectElectronRpcRendererFrame(frame)) {
        throw new TypeError("Invalid Effect RPC renderer frame");
      }
      electronIpcRenderer.send(channels.rendererToMain, frame);
    },
    subscribe: (listener) => {
      const wrapped = (_event: unknown, frame: unknown) => {
        if (isEffectElectronRpcMainFrame(frame)) {
          listener(frame);
        }
      };

      electronIpcRenderer.on(channels.mainToRenderer, wrapped);
      return () => {
        removeIpcListener(electronIpcRenderer, channels.mainToRenderer, wrapped);
      };
    },
  };
}

export function exposeEffectElectronRpcPreloadBridge(options: {
  readonly contextBridge: ElectronLikeContextBridge;
  readonly ipcRenderer: ElectronLikeIpcRenderer;
  readonly globalKey?: string;
  readonly channels?: typeof EFFECT_ELECTRON_RPC_CHANNELS;
}): void {
  options.contextBridge.exposeInMainWorld(
    options.globalKey ?? EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY,
    makeEffectElectronRpcPreloadBridge(options.ipcRenderer, options.channels),
  );
}

function removeIpcListener<TListener>(
  target: {
    readonly off?: (channel: string, listener: TListener) => unknown;
    readonly removeListener?: (channel: string, listener: TListener) => unknown;
  },
  channel: string,
  listener: TListener,
): void {
  if (target.off) {
    target.off(channel, listener);
    return;
  }
  target.removeListener?.(channel, listener);
}
