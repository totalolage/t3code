import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

/**
 * Shared IPC envelope for the Electron transport.
 *
 * Electron IPC already gives us framing and structured clone, so the transport
 * can pass Effect RPC's encoded message objects directly instead of wrapping
 * them in JSON-RPC text.
 */

export const EFFECT_ELECTRON_RPC_CHANNELS = {
  rendererToMain: "effect-electron-rpc:renderer-to-main",
  mainToRenderer: "effect-electron-rpc:main-to-renderer",
} as const;

export const EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY = "effectElectronRpc" as const;

export interface EffectElectronRpcRendererFrame {
  readonly version: 1;
  readonly rendererClientId: number;
  readonly message: FromClientEncoded;
}

export interface EffectElectronRpcMainFrame {
  readonly version: 1;
  readonly rendererClientId: number;
  readonly message: FromServerEncoded;
}

export interface EffectElectronRpcRendererPort {
  readonly send: (frame: EffectElectronRpcRendererFrame) => void;
  readonly subscribe: (listener: (frame: EffectElectronRpcMainFrame) => void) => () => void;
}

export type EffectElectronRpcRendererBridge = EffectElectronRpcRendererPort;

export interface EffectElectronRpcMainSource {
  readonly id: number;
  readonly send: (frame: EffectElectronRpcMainFrame) => void;
  readonly isClosed?: () => boolean;
  readonly onClose?: (listener: () => void) => () => void;
}

export interface EffectElectronRpcMainPort {
  readonly subscribe: (
    listener: (source: EffectElectronRpcMainSource, frame: EffectElectronRpcRendererFrame) => void,
  ) => () => void;
}

export function isEffectElectronRpcRendererFrame(
  value: unknown,
): value is EffectElectronRpcRendererFrame {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.rendererClientId === "number" &&
    isRecord(value.message)
  );
}

export function isEffectElectronRpcMainFrame(value: unknown): value is EffectElectronRpcMainFrame {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.rendererClientId === "number" &&
    isRecord(value.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
