import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { openExternal } from "./window.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";

describe("window IPC", () => {
  it.effect("returns false when Electron rejects an external URL", () => {
    const url = "https://example.com/path";
    const error = new ElectronShell.ElectronShellOpenExternalError({
      urlHostname: "example.com",
      urlLength: url.length,
      urlProtocol: "https:",
      cause: new Error("open failed"),
    });
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronShell.ElectronShell,
        ElectronShell.ElectronShell.of({
          openExternal: () => Effect.fail(error),
          copyText: () => Effect.void,
        }),
      ),
      Logger.layer([], { mergeWithExisting: false }),
    );

    return Effect.gen(function* () {
      const opened = yield* openExternal.handler(url);
      assert.equal(opened, false);
    }).pipe(Effect.provide(layer));
  });
});
