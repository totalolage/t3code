import {
  AuthOrchestrationReadScope,
  RunId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { DurationFromString } from "./config.ts";
import type { AuthenticatedCliTarget } from "./remoteAuth.ts";
import type { RemoteCliTarget, ResolveCliTargetInput } from "./remoteTarget.ts";
import {
  formatRemoteWatchInteractionResult,
  type RemoteWatchTransport,
  watchRemoteThread,
} from "./remoteWatch.ts";

export const watchFlags = {
  turn: Flag.String("turn").pipe(
    Flag.withDescription("Watch this specific turn instead of the thread's active or latest turn."),
    Flag.optional,
  ),
  timeout: Flag.String("timeout").pipe(
    Flag.withSchema(DurationFromString),
    Flag.withDescription("Give up watching after this duration, e.g. 30s or 10 minutes."),
    Flag.withDefault(Duration.minutes(10)),
  ),
  format: Flag.Literals("format", ["text", "json"]).pipe(
    Flag.withDescription("Print the assistant text (text) or the full watch result (json)."),
    Flag.withDefault("text" as const),
  ),
  interactions: Flag.Boolean("interactions").pipe(
    Flag.withDescription(
      "Stop and report pending approvals or user-input requests instead of waiting through them.",
    ),
    Flag.withDefault(true),
  ),
} as const;

/**
 * The registration step supplies the real target resolution, authentication,
 * and transport construction; tests inject fakes for all three so this module
 * never opens sockets itself.
 */
export const makeRemoteWatchCommand = (input: {
  readonly resolveTarget: (i: ResolveCliTargetInput) => Effect.Effect<RemoteCliTarget>;
  readonly authenticate: (
    target: RemoteCliTarget,
    requiredScope: AuthEnvironmentScope,
  ) => Effect.Effect<AuthenticatedCliTarget>;
  readonly makeTransport: (i: {
    readonly httpBaseUrl: string;
    readonly accessToken: string;
    readonly threadId: ThreadId;
  }) => Effect.Effect<RemoteWatchTransport>;
}) =>
  Command.make("watch", {
    ...watchFlags,
    threadId: Argument.String("thread-id"),
  }).pipe(
    Command.withDescription(
      "Watch a thread on a running T3 Code server until its turn settles, then print the assistant reply.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const target = yield* input.resolveTarget({});
        const authenticated = yield* input.authenticate(target, AuthOrchestrationReadScope);
        const threadId = ThreadId.make(flags.threadId);
        const transport = yield* input.makeTransport({
          httpBaseUrl: target.httpBaseUrl,
          accessToken: authenticated.accessToken,
          threadId,
        });
        const requestedTurn = Option.map(flags.turn, (turn) => RunId.make(turn));

        const result = yield* watchRemoteThread({
          transport,
          threadId,
          ...(Option.isSome(requestedTurn) ? { requestedTurnId: requestedTurn.value } : {}),
          timeoutMs: Duration.toMillis(flags.timeout),
          interactionAware: flags.interactions,
        }).pipe(
          Effect.catchTags({
            RemoteWatchInteractionRequiredError: (error) =>
              Effect.gen(function* () {
                yield* Console.log(
                  formatRemoteWatchInteractionResult({
                    threadId: error.threadId,
                    turnId: error.turnId,
                    interaction: error.interaction,
                  }),
                );
                return yield* error;
              }),
          }),
        );

        yield* Console.log(
          // CLI presentation output for the human running the command.
          // @effect-diagnostics-next-line preferSchemaOverJson:off - CLI JSON output is decoded as a presentation DTO.
          flags.format === "json" ? JSON.stringify(result, null, 2) : result.message.text,
        );
      }),
    ),
  );
