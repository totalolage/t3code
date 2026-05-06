import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import type { FromClientEncoded } from "effect/unstable/rpc/RpcMessage";

import {
  EFFECT_ELECTRON_RPC_CHANNELS,
  type EffectElectronRpcMainFrame,
  type EffectElectronRpcMainPort,
  type EffectElectronRpcMainSource,
  isEffectElectronRpcRendererFrame,
} from "./ipc.ts";

export interface ElectronLikeWebContents {
  readonly id: number;
  readonly send: (channel: string, frame: EffectElectronRpcMainFrame) => void;
  readonly isDestroyed?: () => boolean;
  readonly once?: (event: "destroyed", listener: () => void) => ElectronLikeWebContents;
  readonly off?: (event: "destroyed", listener: () => void) => ElectronLikeWebContents;
  readonly removeListener?: (event: "destroyed", listener: () => void) => ElectronLikeWebContents;
}

export interface ElectronLikeIpcMainEvent {
  readonly sender: ElectronLikeWebContents;
}

export interface ElectronLikeIpcMain {
  readonly on: (
    channel: string,
    listener: (event: ElectronLikeIpcMainEvent, frame: unknown) => void,
  ) => ElectronLikeIpcMain;
  readonly off?: (
    channel: string,
    listener: (event: ElectronLikeIpcMainEvent, frame: unknown) => void,
  ) => ElectronLikeIpcMain;
  readonly removeListener?: (
    channel: string,
    listener: (event: ElectronLikeIpcMainEvent, frame: unknown) => void,
  ) => ElectronLikeIpcMain;
}

export function makeElectronIpcMainPort(
  ipcMain: ElectronLikeIpcMain,
  channels = EFFECT_ELECTRON_RPC_CHANNELS,
): EffectElectronRpcMainPort {
  return {
    subscribe: (listener) => {
      const wrapped = (event: ElectronLikeIpcMainEvent, frame: unknown) => {
        if (!isEffectElectronRpcRendererFrame(frame)) {
          return;
        }

        const source: EffectElectronRpcMainSource = {
          id: event.sender.id,
          send: (responseFrame) => {
            event.sender.send(channels.mainToRenderer, responseFrame);
          },
          isClosed: () => event.sender.isDestroyed?.() === true,
          ...(event.sender.once
            ? {
                onClose: (closeListener) => {
                  event.sender.once?.("destroyed", closeListener);
                  return () => {
                    removeDestroyedListener(event.sender, closeListener);
                  };
                },
              }
            : {}),
        };

        listener(source, frame);
      };

      ipcMain.on(channels.rendererToMain, wrapped);
      return () => {
        removeIpcListener(ipcMain, channels.rendererToMain, wrapped);
      };
    },
  };
}

export const makeEffectElectronRpcMainProtocol = (
  port: EffectElectronRpcMainPort,
): Effect.Effect<RpcServer.Protocol["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const requests = yield* Queue.make<MainProtocolRequest>();
    const disconnects = yield* Queue.make<number>();
    let nextMainClientId = 1;
    const mainClientIds = new Set<number>();
    const clients = new Map<number, MainClientRecord>();
    const mainClientIdByRendererKey = new Map<string, number>();
    const closeUnsubscribers = new Map<number, () => void>();

    const disconnectClient = (mainClientId: number) =>
      Effect.sync(() => {
        const client = clients.get(mainClientId);
        if (!client) {
          return;
        }

        clients.delete(mainClientId);
        mainClientIds.delete(mainClientId);
        mainClientIdByRendererKey.delete(client.key);
        Queue.offerUnsafe(disconnects, mainClientId);
      });

    const disconnectSource = (sourceId: number) => {
      for (const [mainClientId, client] of clients.entries()) {
        if (client.source.id === sourceId) {
          Queue.offerUnsafe(requests, {
            _tag: "disconnect",
            mainClientId,
          });
        }
      }
    };

    const registerClient = (
      source: EffectElectronRpcMainSource,
      rendererClientId: number,
    ): number => {
      const key = `${source.id}:${rendererClientId}`;
      const existingMainClientId = mainClientIdByRendererKey.get(key);
      if (existingMainClientId !== undefined) {
        return existingMainClientId;
      }

      const mainClientId = nextMainClientId;
      nextMainClientId += 1;
      mainClientIds.add(mainClientId);
      mainClientIdByRendererKey.set(key, mainClientId);
      clients.set(mainClientId, {
        key,
        rendererClientId,
        source,
      });

      if (!closeUnsubscribers.has(source.id) && source.onClose) {
        const unsubscribe = source.onClose(() => {
          disconnectSource(source.id);
        });
        closeUnsubscribers.set(source.id, unsubscribe);
      }

      return mainClientId;
    };

    const unsubscribe = port.subscribe((source, frame) => {
      if (source.isClosed?.() === true) {
        return;
      }

      Queue.offerUnsafe(requests, {
        _tag: "request",
        mainClientId: registerClient(source, frame.rendererClientId),
        message: frame.message,
      });
    });

    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        unsubscribe();
        for (const closeUnsubscribe of closeUnsubscribers.values()) {
          closeUnsubscribe();
        }
        closeUnsubscribers.clear();
        clients.clear();
        mainClientIds.clear();
        mainClientIdByRendererKey.clear();
      }).pipe(
        Effect.andThen(Queue.shutdown(requests)),
        Effect.andThen(Queue.shutdown(disconnects)),
      ),
    );

    return RpcServer.Protocol.of({
      run: (writeRequest) =>
        Queue.take(requests).pipe(
          Effect.flatMap((request) => {
            switch (request._tag) {
              case "request":
                return writeRequest(request.mainClientId, request.message);
              case "disconnect":
                return disconnectClient(request.mainClientId);
            }
          }),
          Effect.forever,
        ),
      disconnects,
      send: (mainClientId, message) =>
        Effect.gen(function* () {
          const client = clients.get(mainClientId);
          if (!client) {
            return;
          }

          if (client.source.isClosed?.() === true) {
            yield* disconnectClient(mainClientId);
            return;
          }

          client.source.send({
            version: 1,
            rendererClientId: client.rendererClientId,
            message,
          });
        }),
      end: disconnectClient,
      clientIds: Effect.sync(() => new Set(mainClientIds)),
      initialMessage: Effect.succeed(Option.none()),
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: true,
    });
  });

export const layerEffectElectronRpcMainProtocol = (port: EffectElectronRpcMainPort) =>
  Layer.effect(RpcServer.Protocol, makeEffectElectronRpcMainProtocol(port));

interface MainClientRecord {
  readonly key: string;
  readonly rendererClientId: number;
  readonly source: EffectElectronRpcMainSource;
}

type MainProtocolRequest =
  | {
      readonly _tag: "request";
      readonly mainClientId: number;
      readonly message: FromClientEncoded;
    }
  | {
      readonly _tag: "disconnect";
      readonly mainClientId: number;
    };

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

function removeDestroyedListener(webContents: ElectronLikeWebContents, listener: () => void): void {
  if (webContents.off) {
    webContents.off("destroyed", listener);
    return;
  }
  webContents.removeListener?.("destroyed", listener);
}
