import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "./remote-bin.ts";

it.effect("exposes the remote orchestration commands without the local server commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "1.2.3" })(["--help"]);
      const output = (yield* TestConsole.logLines).join("\n");

      assert.include(output, "Interact with remote T3 Code agents.");
      assert.include(output, "remote");
      assert.notInclude(output, "serve");
      assert.notInclude(output, "connect");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);
