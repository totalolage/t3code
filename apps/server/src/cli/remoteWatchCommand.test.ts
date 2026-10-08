import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  RunId,
  type AuthEnvironmentScope,
  type AuthSessionState,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NetService from "@t3tools/shared/Net";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import type { AuthenticatedCliTarget } from "./remoteAuth.ts";
import type { RemoteCliTarget } from "./remoteTarget.ts";
import {
  RemoteWatchFailure,
  RemoteWatchInteractionRequiredError,
  RemoteWatchNoTurnError,
  RemoteWatchTimeoutError,
  type RemoteWatchTransport,
} from "./remoteWatch.ts";
import { makeRemoteWatchCommand, watchFlags } from "./remoteWatchCommand.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer, TestConsole.layer);

const isRemoteWatchFailure = Schema.is(RemoteWatchFailure);

const threadId = ThreadId.make("thread-command");
const turnId = RunId.make("run-command");
const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");

const runCli = <Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  args: ReadonlyArray<string>,
) => Command.runWith(command, { version: "0.0.0" })([...args]);

const asRun = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provide(effect, CliRuntimeLayer);

const fakeTarget = {
  kind: "remote",
  httpBaseUrl: "https://fake.example",
  tokenStateDirectory: "/tmp/watch-command-test",
  tokenKey: "watch-command-test",
} as unknown as RemoteCliTarget;

const fakeAuthenticated: AuthenticatedCliTarget = {
  target: fakeTarget,
  accessToken: "test-access-token",
  session: {
    authenticated: true,
    auth: { mode: "pairing" },
  } as unknown as AuthSessionState,
};

const makeRun = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: turnId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex-personal"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex-personal"), model: "gpt-5.4" },
  providerThreadId: null,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: status === "preparing" || status === "queued" ? null : now,
  completedAt:
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rolled_back"
      ? now
      : null,
  checkpointId: null,
  contextHandoffId: null,
  purpose: "user",
  userMessageId: MessageId.make("user-command"),
});

const projection = (
  run: OrchestrationV2Run,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem> = [],
  runtimeRequests: ReadonlyArray<import("@t3tools/contracts").OrchestrationV2RuntimeRequest> = [],
): OrchestrationV2ThreadProjection =>
  ({
    thread: {} as OrchestrationV2ThreadProjection["thread"],
    runs: [run],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [...runtimeRequests],
    messages: [],
    plans: [],
    turnItems: [...turnItems],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: now,
  }) satisfies OrchestrationV2ThreadProjection;

const runningSnapshot = {
  snapshotSequence: 5,
  projection: projection(makeRun("running")),
  latestRunId: turnId,
  activeRunId: turnId,
};

const readySnapshot = (text: string) => ({
  snapshotSequence: 6,
  projection: projection(makeRun("completed"), [
    {
      id: TurnItemId.make("item-assistant-final"),
      threadId,
      runId: turnId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make("assistant-final"),
      text,
      streaming: false,
    },
  ]),
  latestRunId: turnId,
  activeRunId: null,
});

const readRunningThenReady = (text: string): RemoteWatchTransport["readThread"] => {
  let reads = 0;
  return () =>
    Effect.sync(() => {
      reads += 1;
      return (reads === 1 ? runningSnapshot : readySnapshot(text)) as never;
    });
};

const interactionObservation = {
  interaction: {
    kind: "approval" as const,
    requestId: RuntimeRequestId.make("approval-command"),
    prompt: { requestKind: "command" as const },
  },
  lastSequence: 6,
  observedRunning: true,
};

const readyObservation = {
  status: "completed" as const,
  lastSequence: 7,
  observedRunning: true,
};

const interactionAwareSwitchTransport = (text: string): RemoteWatchTransport => ({
  readThread: readRunningThenReady(text),
  subscribeThread: (i) =>
    i.interactionAware === true
      ? Effect.succeed(interactionObservation)
      : Effect.succeed(readyObservation),
});

interface Harness {
  resolveCalls: number;
  authenticateCalls: Array<AuthEnvironmentScope>;
  transportInputs: Array<{
    readonly httpBaseUrl: string;
    readonly accessToken: string;
    readonly threadId: ThreadId;
  }>;
}

const makeHarness = (transport: RemoteWatchTransport) => {
  const harness: Harness = {
    resolveCalls: 0,
    authenticateCalls: [],
    transportInputs: [],
  };
  const watchCommand = makeRemoteWatchCommand({
    resolveTarget: () =>
      Effect.sync(() => {
        harness.resolveCalls += 1;
        return fakeTarget;
      }),
    authenticate: (_target, requiredScope) =>
      Effect.sync(() => {
        harness.authenticateCalls.push(requiredScope);
        return fakeAuthenticated;
      }),
    makeTransport: (i) =>
      Effect.sync(() => {
        harness.transportInputs.push(i);
        return transport;
      }),
  });
  return {
    command: Command.make("t3").pipe(Command.withSubcommands([watchCommand])),
    harness,
  };
};

const capturedOutput = Effect.gen(function* () {
  const lines = yield* TestConsole.logLines;
  return lines.filter((line): line is string => typeof line === "string");
});

describe("remote watch command", () => {
  it("exposes exactly the prescribed watch flags", () => {
    assert.deepEqual(Object.keys(watchFlags).toSorted(), [
      "format",
      "interactions",
      "timeout",
      "turn",
    ]);
  });

  it.effect("prints assistant text on success and authenticates with orchestration:read", () =>
    Effect.gen(function* () {
      const { command, harness } = makeHarness(interactionAwareSwitchTransport("polled reply"));

      yield* asRun(runCli(command, ["watch", "thread-command"]));
      assert.deepEqual(yield* capturedOutput, ["polled reply"]);
      assert.equal(harness.resolveCalls, 1);
      assert.deepEqual(harness.authenticateCalls, ["orchestration:read"]);
      assert.equal(harness.transportInputs.length, 1);
      assert.equal(harness.transportInputs[0]?.httpBaseUrl, "https://fake.example");
      assert.equal(harness.transportInputs[0]?.accessToken, "test-access-token");
      assert.equal(harness.transportInputs[0]?.threadId, "thread-command");
    }),
  );

  it.effect("prints the full result as pretty JSON with --format json", () =>
    Effect.gen(function* () {
      const { command, harness } = makeHarness(interactionAwareSwitchTransport("polled reply"));

      yield* asRun(runCli(command, ["watch", "thread-command", "--format", "json"]));
      const output = yield* capturedOutput;
      assert.equal(output.length, 1);
      // Test assertion decodes the command's presentation DTO.
      const parsed = JSON.parse(output[0]!) as { threadId: string; message: { text: string } };
      assert.equal(parsed.threadId, "thread-command");
      assert.equal(parsed.message.text, "polled reply");
      assert.equal(harness.authenticateCalls.length, 1);
    }),
  );

  it.effect("exits 25 when the thread has no turn to watch", () =>
    Effect.gen(function* () {
      const noTurnSnapshot = {
        snapshotSequence: 1,
        projection: projection(makeRun("completed")),
        latestRunId: null,
        activeRunId: null,
      };
      const { command, harness } = makeHarness({
        readThread: () => Effect.succeed(noTurnSnapshot as never),
        subscribeThread: () => Effect.die("must not subscribe"),
      });

      const error = yield* asRun(runCli(command, ["watch", "thread-command"]).pipe(Effect.flip));
      assert.instanceOf(error, RemoteWatchNoTurnError);
      assert.equal(error[Runtime.errorExitCode], 25);
      assert.equal(harness.authenticateCalls.length, 1);
    }),
  );

  it.effect("exits 24 when the watch fails", () =>
    Effect.gen(function* () {
      const { command, harness } = makeHarness({
        readThread: () => Effect.succeed(runningSnapshot as never),
        subscribeThread: () => Effect.fail(new RemoteWatchFailure({ kind: "auth" })),
      });

      const error = yield* asRun(runCli(command, ["watch", "thread-command"]).pipe(Effect.flip));
      assert.isTrue(isRemoteWatchFailure(error));
      if (!isRemoteWatchFailure(error)) return yield* Effect.die("expected RemoteWatchFailure");
      assert.equal(error.kind, "auth");
      assert.equal(error[Runtime.errorExitCode], 24);
      assert.equal(harness.transportInputs.length, 1);
    }),
  );

  it.effect("exits 21 when the turn is interrupted without a final message", () =>
    Effect.gen(function* () {
      const { command } = makeHarness({
        readThread: () => Effect.succeed(runningSnapshot as never),
        subscribeThread: () =>
          Effect.succeed({
            status: "interrupted" as const,
            lastSequence: 6,
            observedRunning: true,
          }),
      });

      const error = yield* asRun(runCli(command, ["watch", "thread-command"]).pipe(Effect.flip));
      assert.equal(error[Runtime.errorExitCode], 21);
    }),
  );

  it.effect("prints one interaction line and exits 26", () =>
    Effect.gen(function* () {
      const { command, harness } = makeHarness({
        readThread: () =>
          Effect.succeed({
            ...runningSnapshot,
            projection: projection(
              makeRun("running"),
              [],
              [
                {
                  id: RuntimeRequestId.make("approval-command"),
                  nodeId: NodeId.make("node-approval"),
                  providerTurnId: null,
                  nativeRequestRef: null,
                  kind: "command",
                  status: "pending",
                  responseCapability: {
                    type: "live",
                    providerSessionId: ProviderSessionId.make("provider-session"),
                  },
                  createdAt: now,
                  resolvedAt: null,
                },
              ],
            ),
          }),
        subscribeThread: () => Effect.succeed(interactionObservation),
      });

      const error = yield* asRun(runCli(command, ["watch", "thread-command"]).pipe(Effect.flip));
      assert.instanceOf(error, RemoteWatchInteractionRequiredError);
      assert.equal(error[Runtime.errorExitCode], 26);
      const output = yield* capturedOutput;
      assert.equal(output.length, 1);
      // Test assertion decodes the command's presentation DTO.
      const parsed = JSON.parse(output[0]!) as { interaction: { kind: string } };
      assert.equal(parsed.interaction.kind, "approval");
      assert.equal(harness.authenticateCalls.length, 1);
    }),
  );

  it.effect("runs to completion with --no-interactions on the same stream", () =>
    Effect.gen(function* () {
      const { command } = makeHarness(interactionAwareSwitchTransport("polled reply"));

      yield* asRun(runCli(command, ["watch", "thread-command", "--no-interactions"]));
      assert.deepEqual(yield* capturedOutput, ["polled reply"]);
    }),
  );

  it.effect("exits 23 on timeout", () =>
    Effect.gen(function* () {
      const { command } = makeHarness({
        readThread: () => Effect.succeed(runningSnapshot as never),
        subscribeThread: () => Effect.fail(new RemoteWatchFailure({ kind: "unavailable" })),
      });

      const fiber = yield* asRun(
        runCli(command, ["watch", "thread-command"]).pipe(Effect.flip, Effect.forkChild),
      );
      yield* TestClock.adjust("10 minutes");
      const error = yield* Fiber.join(fiber);
      assert.instanceOf(error, RemoteWatchTimeoutError);
      assert.equal(error[Runtime.errorExitCode], 23);
    }),
  );

  it.effect("rejects --yes without resolving or authenticating", () =>
    Effect.gen(function* () {
      const { command, harness } = makeHarness({
        readThread: () => Effect.succeed(runningSnapshot as never),
        subscribeThread: () => Effect.die("must not subscribe"),
      });

      yield* asRun(runCli(command, ["watch", "thread-command", "--yes"]).pipe(Effect.flip));
      assert.equal(harness.resolveCalls, 0);
      assert.equal(harness.authenticateCalls.length, 0);
      assert.equal(harness.transportInputs.length, 0);
    }),
  );

  it.effect("fails flag parsing before resolving or authenticating", () =>
    Effect.gen(function* () {
      const { command, harness } = makeHarness({
        readThread: () => Effect.succeed(runningSnapshot as never),
        subscribeThread: () => Effect.die("must not subscribe"),
      });

      yield* asRun(
        runCli(command, ["watch", "thread-command", "--format", "yaml"]).pipe(Effect.flip),
      );
      assert.equal(harness.resolveCalls, 0);
      assert.equal(harness.authenticateCalls.length, 0);
      assert.equal(harness.transportInputs.length, 0);
    }),
  );
});
