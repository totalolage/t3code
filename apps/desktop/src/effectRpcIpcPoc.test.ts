import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  loadDesktopIpcPocSnapshot,
  makeDesktopIpcPocBrowserClient,
} from "./effectRpcIpcPoc/example/browser-client.ts";
import { runDesktopIpcPocRpcServer } from "./effectRpcIpcPoc/example/rpc-server.ts";
import { DESKTOP_IPC_POC_METHODS } from "./effectRpcIpcPoc/example/protocol.ts";
import { EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY } from "effect-electron-rpc/ipc";
import type {
  EffectElectronRpcMainFrame,
  EffectElectronRpcMainSource,
  EffectElectronRpcRendererFrame,
} from "effect-electron-rpc/ipc";

describe("effect RPC over Electron IPC proof of concept", () => {
  it("runs the end-to-end consumer example over the Electron IPC transport", async () => {
    const ipc = new InMemoryEffectElectronRpc();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runDesktopIpcPocRpcServer({
            port: ipc.mainPort,
            appVersion: "1.2.3",
            platform: "test-os",
            now: () => new Date("2026-05-06T12:00:00.000Z"),
          });

          return yield* loadDesktopIpcPocSnapshot({
            globalObject: ipc.rendererGlobal,
            echoText: "hello ipc",
            ticks: 3,
          });
        }),
      ),
    );

    expect(result).toEqual({
      runtimeInfo: {
        appVersion: "1.2.3",
        platform: "test-os",
        ipcTransport: "electron-ipc",
      },
      echo: {
        text: "hello ipc",
        echoedAt: "2026-05-06T12:00:00.000Z",
      },
      ticks: [
        { sequence: 1, label: "tick:1" },
        { sequence: 2, label: "tick:2" },
        { sequence: 3, label: "tick:3" },
      ],
    });
  });

  it("lets browser code consume the generated Effect RPC client directly", async () => {
    const ipc = new InMemoryEffectElectronRpc();

    const ticks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* runDesktopIpcPocRpcServer({
            port: ipc.mainPort,
            appVersion: "0.0.0-test",
            platform: "test-os",
          });

          const client = yield* makeDesktopIpcPocBrowserClient({
            globalObject: ipc.rendererGlobal,
          });

          return yield* client[DESKTOP_IPC_POC_METHODS.subscribeTicks]({ take: 3 }).pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        }),
      ),
    );

    expect(ticks).toEqual([
      { sequence: 1, label: "tick:1" },
      { sequence: 2, label: "tick:2" },
      { sequence: 3, label: "tick:3" },
    ]);
  });
});

class InMemoryEffectElectronRpc {
  private readonly mainListeners = new Set<
    (source: EffectElectronRpcMainSource, frame: EffectElectronRpcRendererFrame) => void
  >();
  private readonly rendererListeners = new Set<(frame: EffectElectronRpcMainFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  readonly source: EffectElectronRpcMainSource = {
    id: 1,
    send: (frame) => {
      queueMicrotask(() => {
        for (const listener of this.rendererListeners) {
          listener(frame);
        }
      });
    },
    isClosed: () => this.closed,
    onClose: (listener) => {
      this.closeListeners.add(listener);
      return () => {
        this.closeListeners.delete(listener);
      };
    },
  };

  readonly mainPort = {
    subscribe: (
      listener: (
        source: EffectElectronRpcMainSource,
        frame: EffectElectronRpcRendererFrame,
      ) => void,
    ) => {
      this.mainListeners.add(listener);
      return () => {
        this.mainListeners.delete(listener);
      };
    },
  };

  readonly rendererPort = {
    send: (frame: EffectElectronRpcRendererFrame) => {
      queueMicrotask(() => {
        for (const listener of this.mainListeners) {
          listener(this.source, frame);
        }
      });
    },
    subscribe: (listener: (frame: EffectElectronRpcMainFrame) => void) => {
      this.rendererListeners.add(listener);
      return () => {
        this.rendererListeners.delete(listener);
      };
    },
  };

  readonly rendererGlobal = {
    [EFFECT_ELECTRON_RPC_RENDERER_BRIDGE_KEY]: this.rendererPort,
  };

  close(): void {
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}
