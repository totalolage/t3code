import { Effect, Stream } from "effect";
import { RpcServer } from "effect/unstable/rpc";

import type { EffectElectronRpcMainPort } from "effect-electron-rpc/ipc";
import { makeEffectElectronRpcMainProtocol } from "effect-electron-rpc/main";
import { DESKTOP_IPC_POC_METHODS, DesktopIpcPocRpcGroup } from "./protocol.ts";

export interface DesktopIpcPocMainOptions {
  readonly port: EffectElectronRpcMainPort;
  readonly appVersion?: string;
  readonly platform?: string;
  readonly now?: () => Date;
}

export const makeDesktopIpcPocHandlersLayer = (options: DesktopIpcPocMainOptions) => {
  const now = options.now ?? (() => new Date());

  return DesktopIpcPocRpcGroup.toLayer(
    DesktopIpcPocRpcGroup.of({
      [DESKTOP_IPC_POC_METHODS.getRuntimeInfo]: () =>
        Effect.succeed({
          appVersion: options.appVersion ?? "0.0.0-poc",
          platform: options.platform ?? process.platform,
          ipcTransport: "electron-ipc" as const,
        }),
      [DESKTOP_IPC_POC_METHODS.echo]: (input) =>
        Effect.sync(() => ({
          text: input.text,
          echoedAt: now().toISOString(),
        })),
      [DESKTOP_IPC_POC_METHODS.subscribeTicks]: (input) =>
        Stream.fromIterable(
          Array.from({ length: Math.max(0, Math.floor(input.take)) }, (_, index) => ({
            sequence: index + 1,
            label: `tick:${index + 1}`,
          })),
        ),
    }),
  );
};

export const runDesktopIpcPocRpcServer = (options: DesktopIpcPocMainOptions) =>
  Effect.gen(function* () {
    const mainProtocol = yield* makeEffectElectronRpcMainProtocol(options.port);

    yield* RpcServer.make(DesktopIpcPocRpcGroup).pipe(
      Effect.provideService(RpcServer.Protocol, mainProtocol),
      Effect.provide(makeDesktopIpcPocHandlersLayer(options)),
      Effect.forkScoped,
    );
  });
