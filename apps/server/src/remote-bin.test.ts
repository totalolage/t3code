import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { ThreadId, TurnId } from "@t3tools/contracts";

import { formatRemoteCliDiagnostic, RemoteCliError } from "./cli/remote.ts";
import { RemoteWatchInteractionRequiredError } from "./cli/remoteWatch.ts";
import { cli, reportRemoteCliFailure } from "./remote-bin.ts";

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

it.effect("exposes additive pending commands without changing watch availability", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Command.runWith(cli, { version: "1.2.3" })(["remote", "--help"]);
      const output = (yield* TestConsole.logLines).join("\n");

      for (const command of ["pending", "answer", "approve", "reject", "watch"]) {
        assert.include(output, command);
      }
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);

it.effect(
  "documents interaction inspection, response syntax, and acknowledgement in CLI help",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const command of ["watch", "pending", "answer", "approve", "reject"]) {
          yield* Command.runWith(cli, { version: "1.2.3" })(["remote", command, "--help"]);
        }
        const output = (yield* TestConsole.logLines).join("\n");

        assert.include(output, "next actionable interaction");
        assert.include(output, "one-line redacted JSON");
        assert.include(output, "sanitized pending/responding interactions");
        assert.include(output, "operate authorization and explicit --yes");
        assert.include(output, "--answers-json");
        assert.include(output, "--decision");
        assert.include(output, "--idempotency-key");
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);

it.effect(
  "requires explicit confirmation before answer, approve, or reject can make a request",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = [
          ["answer", "--answers-json", '[{"questionId":"question-1","values":["yes"]}]'],
          ["approve"],
          ["reject"],
        ] as const;
        for (const [command, ...extraFlags] of commands) {
          const failure = yield* Effect.flip(
            Command.runWith(cli, { version: "1.2.3" })([
              "remote",
              command,
              "thread-1",
              "request-1",
              "--host",
              "http://127.0.0.1:1",
              "--idempotency-key",
              `retry-${command}`,
              ...extraFlags,
            ]),
          );
          assert.instanceOf(failure, RemoteCliError);
          assert.equal(failure.reason, "confirmation-required");
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);

it.effect("rejects non-strict answer JSON before making a remote request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Command.runWith(cli, { version: "1.2.3" })([
          "remote",
          "answer",
          "thread-1",
          "request-1",
          "--host",
          "http://127.0.0.1:1",
          "--idempotency-key",
          "retry-1",
          "--answers-json",
          '[{"questionId":"question-1","values":["yes"],"providerEnvelope":{}}]',
          "--yes",
        ]),
      );
      assert.instanceOf(failure, RemoteCliError);
      assert.equal(failure.reason, "invalid-input");
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer))),
);

it("never formats unknown remote failures with raw diagnostic content", () => {
  const diagnostic = formatRemoteCliDiagnostic(
    new Error("token=top-secret /home/alice/private stack trace"),
  );
  assert.equal(diagnostic, "Remote request failed.");
  assert.notInclude(diagnostic, "top-secret");
  assert.notInclude(diagnostic, "/home/alice");
});

it.effect("exits cleanly after watch has emitted its machine-readable interaction result", () =>
  Effect.gen(function* () {
    let exitCode: number | undefined;
    yield* reportRemoteCliFailure(
      new RemoteWatchInteractionRequiredError({
        threadId: ThreadId.make("thread-1"),
        turnId: TurnId.make("turn-1"),
        interaction: {
          kind: "approval",
          requestId: "request-1",
          prompt: { requestKind: "command" },
        },
      }),
      (code) => {
        exitCode = code;
      },
    );

    assert.equal(exitCode, 26);
    assert.deepEqual(yield* TestConsole.errorLines, []);
  }).pipe(Effect.provide(TestConsole.layer)),
);
