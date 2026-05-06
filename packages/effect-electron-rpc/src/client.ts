import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";

import {
  EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY,
  type EffectElectronRpcMainFrame,
  type EffectElectronRpcRendererBridge,
  type EffectElectronRpcRendererPort,
} from "./ipc.ts";

export interface EffectElectronRpcBrowserGlobal {
  readonly [EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY]?: EffectElectronRpcRendererBridge;
}

export function getEffectElectronRpcRendererBridge(
  globalObject: EffectElectronRpcBrowserGlobal = globalThis as EffectElectronRpcBrowserGlobal,
): EffectElectronRpcRendererBridge {
  const bridge = globalObject[EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY];
  if (!bridge) {
    throw new Error(`Missing preload bridge: window.${EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY}`);
  }
  return bridge;
}

export const makeEffectElectronRpcRendererPort = (
  bridge: EffectElectronRpcRendererBridge,
): EffectElectronRpcRendererPort => bridge;

export const makeEffectElectronRpcRendererProtocol = (
  port: EffectElectronRpcRendererPort,
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make((writeResponse) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const responses = yield* Queue.make<EffectElectronRpcMainFrame>();
      const unsubscribe = port.subscribe((frame) => {
        Queue.offerUnsafe(responses, frame);
      });

      yield* Queue.take(responses).pipe(
        Effect.flatMap((frame) => writeResponse(frame.rendererClientId, frame.message)),
        Effect.forever,
        Effect.forkScoped,
      );

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(responses))),
      );

      return {
        send: (rendererClientId, message) =>
          Effect.sync(() => {
            port.send({
              version: 1,
              rendererClientId,
              message,
            });
          }),
        supportsAck: true,
        supportsTransferables: false,
      };
    }),
  );

export const layerEffectElectronRpcRendererProtocol = (port: EffectElectronRpcRendererPort) =>
  Layer.effect(RpcClient.Protocol, makeEffectElectronRpcRendererProtocol(port));
