import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { runStandaloneFffProbe } from "./standaloneFffProbe.ts";

it.effect("initializes FileFinder and lists and greps a scratch workspace", () =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() =>
      // Without embedded files the platform only steers the unsupported-platform
      // check; FileFinder resolves from node_modules in tests.
      runStandaloneFffProbe({ platform: "linux", arch: "x64" }),
    );

    assert.equal(result.error, undefined);
    assert.equal(result.ok, true);
    // Outside a compiled binary the library resolves from node_modules and
    // no materialized copy exists.
    assert.equal(result.libraryPath, null);
  }),
);
