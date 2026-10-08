import { assert, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import * as BunPtyAdapter from "./BunPtyAdapter.ts";
import * as PtyAdapter from "./PtyAdapter.ts";

it("describes unavailable Bun PTY operations structurally", () => {
  const error = new BunPtyAdapter.BunPtyOperationUnavailableError({
    operation: "resize",
    pid: 42,
  });

  expect(error).toMatchObject({
    _tag: "BunPtyOperationUnavailableError",
    operation: "resize",
    pid: 42,
  });
  expect(error.message).toBe("Bun PTY resize is unavailable for process 42.");
});

it.effect("reports unsupported platforms with a structured startup defect", () =>
  Effect.gen(function* () {
    const exit = yield* BunPtyAdapter.make().pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, BunPtyAdapter.BunPtyUnsupportedPlatformError);
      expect(error).toMatchObject({
        _tag: "BunPtyUnsupportedPlatformError",
        platform: "win32",
      });
      expect(error.message).toBe(
        "Bun PTY terminal support is unavailable on win32. Please use Node.js (e.g. by running `npx t3`) instead.",
      );
    }
  }),
);

it.effect("uses Bun's terminal subprocess through the public PTY adapter", () =>
  Effect.gen(function* () {
    const exited = Promise.withResolvers<number>();
    const terminal = { write: () => {}, resize: () => {} };
    let emitTerminalData: ((data: Uint8Array) => void) | undefined;
    vi.stubGlobal("Bun", {
      spawn: (
        _command: string[],
        options: {
          terminal: {
            data: (_terminal: unknown, data: Uint8Array) => void;
          };
        },
      ) => {
        emitTerminalData = (data) => options.terminal.data(terminal, data);
        return {
          pid: 1234,
          terminal,
          exited: exited.promise,
          signalCode: null,
          kill: () => {},
        };
      },
    });

    try {
      const adapter = yield* BunPtyAdapter.make().pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
      );
      const process = yield* adapter.spawn({
        shell: "/bin/sh",
        args: [],
        cwd: "/tmp",
        cols: 91,
        rows: 37,
        env: { TERM: "xterm-256color" },
      });

      const data: string[] = [];
      const unsubscribeData = process.onData((value) => data.push(value));
      const exitEvents: PtyAdapter.PtyExitEvent[] = [];
      const exitedEvent = Promise.withResolvers<PtyAdapter.PtyExitEvent>();
      process.onExit((event) => {
        exitEvents.push(event);
        exitedEvent.resolve(event);
      });

      const emitData = emitTerminalData;
      assert.isDefined(emitData);
      const encoded = new TextEncoder().encode("reply=café\n");
      const splitAt = encoded.indexOf(0xc3) + 1;
      emitData(encoded.subarray(0, splitAt));
      emitData(encoded.subarray(splitAt));
      expect(data).toEqual(["reply=caf", "é\n"]);

      unsubscribeData();
      emitData(new TextEncoder().encode("detached\n"));
      expect(data).toEqual(["reply=caf", "é\n"]);

      exited.resolve(7);
      const exitEvent = yield* Effect.promise(() => exitedEvent.promise);
      emitData(new TextEncoder().encode("after-exit\n"));

      expect(data).toEqual(["reply=caf", "é\n"]);
      expect(exitEvent).toEqual({ exitCode: 7, signal: null });
      expect(exitEvents).toEqual([{ exitCode: 7, signal: null }]);
    } finally {
      vi.unstubAllGlobals();
    }
  }),
);
