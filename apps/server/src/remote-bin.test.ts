import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { formatRemoteCliDiagnostic, RemoteCliError } from "./cli/remote.ts";
import { RemoteWatchInteractionRequiredError, RemoteWatchTimeoutError } from "./cli/remoteWatch.ts";
import { cli, handleRemoteCliFailure } from "./remote-bin.ts";

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

it.effect("requires explicit confirmation before any remote interaction write", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        Command.runWith(cli, { version: "1.2.3" })([
          "remote",
          "reject",
          "thread-1",
          "request-1",
          "--host",
          "http://127.0.0.1:1",
          "--idempotency-key",
          "retry-1",
        ]),
      );
      assert.instanceOf(failure, RemoteCliError);
      assert.equal(failure.reason, "confirmation-required");
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

it.effect("does not emit a second diagnostic after safe watch interaction JSON", () =>
  Effect.gen(function* () {
    const error = new RemoteWatchInteractionRequiredError({
      threadId: ThreadId.make("thread-watch"),
      turnId: TurnId.make("turn-watch"),
      interaction: {
        kind: "approval",
        requestId: "approval-watch",
        prompt: { requestKind: "command" },
      },
    });
    let exitCode: number | undefined;

    yield* handleRemoteCliFailure(error, (code) => {
      exitCode = code;
    });

    assert.equal(exitCode, 26);
    assert.deepEqual(yield* TestConsole.errorLines, []);
  }).pipe(Effect.provide(TestConsole.layer)),
);

it.effect("redacts unknown diagnostics while propagating remote watch exit codes", () =>
  Effect.gen(function* () {
    const observedExitCodes: Array<number> = [];

    yield* handleRemoteCliFailure(
      new Error("token=top-secret /home/alice/private stack trace"),
      (code) => observedExitCodes.push(code),
    );
    yield* handleRemoteCliFailure(
      new RemoteWatchTimeoutError({
        threadId: ThreadId.make("thread-watch"),
        timeoutMs: 1_000,
      }),
      (code) => observedExitCodes.push(code),
    );

    assert.deepEqual(observedExitCodes, [1, 23]);
    const diagnostics = yield* TestConsole.errorLines;
    assert.equal(diagnostics[0], "Remote request failed.");
    assert.notInclude(diagnostics.join("\n"), "top-secret");
    assert.notInclude(diagnostics.join("\n"), "/home/alice");
    assert.equal(diagnostics[1], "Timed out waiting for thread thread-watch.");
  }).pipe(Effect.provide(TestConsole.layer)),
);
