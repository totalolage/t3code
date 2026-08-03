import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";

import { runServicePreflight } from "../cloud/servicePreflight.ts";

export const servicePreflightCommand = Command.make("__service-preflight", {
  databasePath: Flag.string("database-path"),
  launcherProtocol: Flag.integer("launcher-protocol"),
}).pipe(
  Command.withHidden,
  Command.withHandler(({ databasePath, launcherProtocol }) =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        runServicePreflight({ databasePath, launcherProtocol }),
      );
      // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned protocol DTO.
      yield* Console.log(JSON.stringify(result));
    }),
  ),
);
