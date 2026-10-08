import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import * as CliError from "effect/cli/CliError";

import { makeCli } from "./binCli.ts";

const cli = makeCli({ cloudEnabled: false });
const run = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0-test" })(args);

describe("fork commands at the native CLI entry", () => {
  it.effect("offers remote commands alongside the native server commands", () =>
    Effect.gen(function* () {
      yield* run(["--help"]);
      const output = (yield* TestConsole.logLines).join("\n");
      for (const command of ["remote", "project", "serve", "service", "update"]) {
        assert.include(output, command);
      }
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
    ),
  );

  it.effect("reaches the remote send confirmation guard before authentication", () =>
    Effect.gen(function* () {
      const error = yield* run([
        "remote",
        "send",
        "thread-1",
        "hello",
        "--host",
        "https://unused.test",
      ]).pipe(Effect.flip);
      if (!CliError.isCliError(error)) {
        throw new Error("Expected a CLI error from the send confirmation guard.");
      }
      assert.equal(error._tag, "UserError");
      assert.include(error.message, "confirmation-required");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer))),
  );

  it.effect("exposes the shipped local send alias without a host flag", () =>
    Effect.gen(function* () {
      yield* run(["send", "--help"]);
      const output = (yield* TestConsole.logLines).join("\n");
      assert.include(output, "--yes");
      assert.notInclude(output, "--host");
    }).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer)),
    ),
  );
});
