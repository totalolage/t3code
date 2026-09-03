import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { runStandaloneFffProbe } from "../standaloneFffProbe.ts";

export const standalonePreflightCommand = Command.make("__standalone-preflight").pipe(
  Command.withDescription(
    "Initialize FileFinder in a throwaway workspace and report the result as JSON.",
  ),
  Command.withHidden,
  Command.withHandler(() =>
    Effect.all({ platform: HostProcessPlatform, arch: HostProcessArchitecture }).pipe(
      Effect.flatMap((host) => Effect.promise(() => runStandaloneFffProbe(host))),
      Effect.flatMap((result) =>
        Console.log(JSON.stringify(result)).pipe(
          Effect.asVoid,
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = result.ok ? 0 : 1;
            }),
          ),
        ),
      ),
    ),
  ),
);
