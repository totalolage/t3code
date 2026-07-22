import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import * as Runtime from "effect/Runtime";
import { Command } from "effect/unstable/cli";

import packageJson from "../package.json" with { type: "json" };
import { formatRemoteCliDiagnostic, remoteCommand } from "./cli/remote.ts";

export const cli = Command.make("t3").pipe(
  Command.withDescription("Interact with remote T3 Code agents."),
  Command.withSubcommands([remoteCommand]),
);

if (import.meta.main) {
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.catch((error) =>
      Console.error(formatRemoteCliDiagnostic(error)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const safeExitCode =
              typeof error === "object" &&
              error !== null &&
              Runtime.errorExitCode in error &&
              typeof error[Runtime.errorExitCode] === "number"
                ? error[Runtime.errorExitCode]
                : 1;
            process.exitCode = safeExitCode;
          }),
        ),
      ),
    ),
    NodeRuntime.runMain,
  );
}
