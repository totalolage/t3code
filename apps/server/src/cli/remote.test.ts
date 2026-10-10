// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises Node HTTP and filesystem boundaries.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { ThreadId } from "@t3tools/contracts";

import { localOrchestrationCommands, remoteCommand, renderWatchError } from "./remote.ts";
import { writeRemoteToken } from "./remoteTokenStore.ts";
import { RemoteWatchTimeoutError } from "./remoteWatch.ts";

const testCli = Command.make("t3").pipe(
  Command.withSubcommands([remoteCommand, ...localOrchestrationCommands]),
);

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(testCli, { version: "0.0.0-test" })(args);

const captureOutput = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const result = yield* runCli(args);
    const output = (yield* TestConsole.logLines).join("\n");
    return { result, output };
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)));

const recordingFetch = (requests: Array<Request>, response: Response): typeof globalThis.fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    return response.clone();
  }) as typeof globalThis.fetch;

const fakeHttpLayer = (fetch: typeof globalThis.fetch) =>
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const descriptorJson = {
  environmentId: "environment-1",
  label: "Remote test environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: false },
};

const snapshotAt = "2026-01-01T00:00:00.000Z";
const threadJson = {
  createdBy: "user",
  creationSource: "web",
  id: "thread-1",
  projectId: "project-1",
  title: "Thread one",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  forkedFrom: null,
  createdAt: snapshotAt,
  updatedAt: snapshotAt,
  archivedAt: null,
  hiddenAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const makeRunJson = (runId: string, status: string) => ({
  id: runId,
  threadId: "thread-1",
  ordinal: 1,
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
  providerThreadId: null,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: snapshotAt,
  startedAt: status === "preparing" || status === "queued" ? null : snapshotAt,
  completedAt: status === "completed" ? snapshotAt : null,
  checkpointId: null,
  contextHandoffId: null,
  purpose: "user",
  userMessageId: `message-${runId}`,
});

const makeThreadSnapshotJson = (input: {
  readonly runId?: string;
  readonly status?: string;
  readonly runtimeRequests?: ReadonlyArray<unknown>;
  readonly turnItems?: ReadonlyArray<unknown>;
}) => {
  const runId = input.runId;
  const status = input.status;
  const run = runId === undefined || status === undefined ? [] : [makeRunJson(runId, status)];
  const activeRunId =
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
      ? (runId ?? null)
      : null;
  return {
    detail: {
      snapshotSequence: 999,
      projection: {
        thread: threadJson,
        runs: run,
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [...(input.runtimeRequests ?? [])],
        messages: [],
        plans: [],
        turnItems: [...(input.turnItems ?? [])],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: snapshotAt,
      },
    },
    metadata: {
      snapshotSequence: 999,
      projects: [],
      threads: [
        {
          ...threadJson,
          latestRunId: runId ?? null,
          activeRunId,
          plans: [],
          providerSessions: [],
          messages: [],
          activities: [],
          checkpoints: [],
        },
      ],
      updatedAt: snapshotAt,
    },
  };
};

const emptyThreadSnapshotJson = makeThreadSnapshotJson({});
const threadSnapshotRoutes = (
  fixture: ReturnType<typeof makeThreadSnapshotJson> = emptyThreadSnapshotJson,
) => ({
  "/api/orchestration/threads/thread-1": () => jsonResponse(fixture.detail),
  "/api/orchestration/snapshot": () => jsonResponse(fixture.metadata),
});

const makeInteractionSnapshot = (runId: string) =>
  makeThreadSnapshotJson({
    runId,
    status: "running",
    runtimeRequests: [
      {
        id: "request-1",
        nodeId: "node-1",
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: snapshotAt,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        id: "item-request-1",
        threadId: "thread-1",
        runId,
        nodeId: "node-1",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "waiting",
        title: null,
        startedAt: snapshotAt,
        completedAt: null,
        updatedAt: snapshotAt,
        type: "approval_request",
        requestId: "request-1",
        requestKind: "command",
      },
    ],
  });

const sessionJson = {
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "t3-session",
  },
  sessionMethod: "bearer-access-token",
  scopes: ["orchestration:read", "orchestration:operate"],
  principal: { sessionId: "session-1", subject: "local-cli:environment-1" },
};

const requestIdBody = (requests: ReadonlyArray<Request>, needle: string) =>
  Effect.gen(function* () {
    const request = requests.find((candidate) => candidate.url.includes(needle));
    return yield* Effect.promise(() =>
      request === undefined ? Promise.resolve("") : (request.clone().text() as Promise<string>),
    );
  });

const fakeRoutingLayer = (
  requests: Array<Request>,
  routes: Record<string, (request: Request) => Response | Promise<Response>>,
) =>
  fakeHttpLayer((async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    for (const [needle, respond] of Object.entries(routes)) {
      if (request.url.includes(needle)) {
        return respond(request);
      }
    }
    return Promise.reject(new Error(`unexpected fake route ${request.url}`));
  }) as typeof globalThis.fetch);

const makeTokenedHome = Effect.fn("remoteCliTest.tokenedHome")(function* () {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-remote-ops-"));
  yield* writeRemoteToken(`${home}/remote-cli`, "https://fake.test", {
    accessToken: "access-secret",
    expiresAtEpochMs: 4_102_444_800_000,
  });
  return home;
});

describe("remote command registration", () => {
  it.effect("lists all implemented remote subcommands", () =>
    Effect.gen(function* () {
      const { output } = yield* captureOutput(["remote", "--help"]);

      for (const name of [
        "environment",
        "auth",
        "session",
        "shell",
        "snapshot",
        "thread",
        "watch",
        "send",
        "create",
        "compact",
        "pending",
      ]) {
        assert.include(output, name);
      }
    }),
  );

  it.effect("registers local aliases without --host alongside the remote host flag", () =>
    Effect.gen(function* () {
      const localSend = yield* captureOutput(["send", "--help"]);
      assert.include(localSend.output, "--base-dir");
      assert.notInclude(localSend.output, "--host");

      const localSession = yield* captureOutput(["session", "--help"]);
      assert.notInclude(localSession.output, "--host");

      const remoteSend = yield* captureOutput(["remote", "send", "--help"]);
      assert.include(remoteSend.output, "--host");
    }),
  );

  it.effect("fails send without --yes before any network traffic", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const error = yield* runCli(["send", "thread-1", "hello"]).pipe(Effect.flip);

      assert.equal(error._tag, "UserError");
      assert.include(error.message, "confirmation-required");
      assert.lengthOf(requests, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          fakeHttpLayer(
            recordingFetch(
              requests,
              new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("compacts a thread, trimming the key, and prints the receipt", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const { output } = yield* captureOutput([
        "remote",
        "compact",
        "thread-1",
        "--idempotency-key",
        "  k1  ",
        "--yes",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]);

      assert.include(output, '"sequence": 7');
      assert.include(output, '"replayed": false');
      const body = yield* requestIdBody(requests, "/api/orchestration/compact");
      assert.isTrue(body.includes('"k1"'));
      assert.isFalse(body.includes("  k1  "));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            "/api/orchestration/compact": () =>
              jsonResponse({
                threadId: "thread-1",
                commandId: "cli-compact:test",
                sequence: 7,
                replayed: false,
              }),
          }),
        ),
      ),
    );
  });

  it.effect("surfaces a typed compaction conflict with sanitized output", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "compact",
        "thread-1",
        "--idempotency-key",
        "k1",
        "--yes",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "UserError");
      assert.include(error.message, "thread_compaction_failed");
      assert.include(error.message, "active-thread");
      assert.isFalse(error.message.includes("access-secret"));
      const errorLines = yield* TestConsole.errorLines;
      assert.equal(
        errorLines.filter((line) => String(line).includes("thread_compaction_failed")).length,
        1,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            "/api/orchestration/compact": () =>
              jsonResponse(
                {
                  _tag: "EnvironmentThreadCompactionError",
                  code: "thread_compaction_failed",
                  reason: "active-thread",
                  traceId: "0123456789abcdef0123456789abcdef",
                },
                409,
              ),
          }),
        ),
      ),
    );
  });

  it.effect("sanitizes a garbage 409 compaction body with zero leakage", () => {
    const requests: Array<Request> = [];
    const garbage = "raw-garbage-body <not json>";
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "compact",
        "thread-1",
        "--idempotency-key",
        "k1",
        "--yes",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "UserError");
      assert.include(error.message, "request-failed");
      assert.isFalse(error.message.includes(garbage));
      assert.isFalse(error.message.includes("access-secret"));
      const errorLines = yield* TestConsole.errorLines;
      assert.equal(errorLines.filter((line) => String(line).includes("request-failed")).length, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            "/api/orchestration/compact": () =>
              new Response(garbage, {
                status: 409,
                headers: { "content-type": "application/json" },
              }),
          }),
        ),
      ),
    );
  });

  it.effect("creates a thread and prints the create receipt", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const { output } = yield* captureOutput([
        "remote",
        "create",
        "hello world",
        "--project",
        "proj-1",
        "--idempotency-key",
        "k1",
        "--yes",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]);

      assert.include(output, '"threadId": "thread-9"');
      assert.include(output, '"replayed": true');
      const body = yield* requestIdBody(requests, "/api/orchestration/create");
      assert.isTrue(body.includes("hello world"));
      assert.isTrue(body.includes("proj-1"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            "/api/orchestration/create": () =>
              jsonResponse({
                threadId: "thread-9",
                commandId: "cli-create:test",
                turnId: "run-9",
                sequence: 3,
                replayed: true,
              }),
          }),
        ),
      ),
    );
  });

  it.effect("lists and approves pending interactions with replayed passthrough", () => {
    const requests: Array<Request> = [];
    const approvalInteraction = {
      threadId: "thread-1",
      requestId: "request-1",
      kind: "approval",
      status: "pending",
      summary: "Approval requested",
      canApprove: true,
      allowedActions: ["approve"],
      questions: [],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const listed = yield* captureOutput([
        "remote",
        "pending",
        "list",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]);
      assert.include(listed.output, '"summary": "Approval requested"');

      const approved = yield* captureOutput([
        "remote",
        "pending",
        "approve",
        "thread-1",
        "request-1",
        "--idempotency-key",
        "k1",
        "--yes",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]);
      assert.include(approved.output, '"action": "approve"');
      assert.include(approved.output, '"replayed": true');
      assert.isTrue(
        requests.some((request) => request.url.includes("/pending-interactions/approve")),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            "/pending-interactions/approve": () =>
              jsonResponse({
                threadId: "thread-1",
                requestId: "request-1",
                status: "responding",
                action: "approve",
                idempotencyKey: "k1",
                replayed: true,
              }),
            "/api/orchestration/pending-interactions": (request) =>
              request.method === "GET"
                ? jsonResponse({ interactions: [approvalInteraction] })
                : new Response("unexpected", { status: 404 }),
          }),
        ),
      ),
    );
  });

  it.effect("watch with --host targets that host, not local discovery", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "watch",
        "thread-1",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "RemoteWatchNoTurnError");
      assert.equal(Runtime.getErrorExitCode(error), 25);
      const errorLines = (yield* TestConsole.errorLines).map((line) => String(line));
      assert.equal(errorLines.filter((line) => line.includes("watch-no-turn")).length, 1);
      assert.isTrue(requests.every((request) => request.url.includes("fake.test")));
      assert.isFalse(requests.some((request) => request.url.includes("127.0.0.1")));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            ...threadSnapshotRoutes(),
          }),
        ),
      ),
    );
  });

  it.effect("watch setup auth failure renders one sanitized line and exits 1", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-watch-noauth-"));
      const error = yield* runCli([
        "remote",
        "watch",
        "thread-1",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "UserError");
      assert.equal(Runtime.getErrorExitCode(error), 1);
      assert.include(error.message, "authentication-required");
      const errorLines = (yield* TestConsole.errorLines).map((line) => String(line));
      assert.equal(errorLines.filter((line) => line.includes("authentication-required")).length, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
          }),
        ),
      ),
    );
  });

  it.effect("watch interaction-required prints one interaction line and exits 26", () => {
    const requests: Array<Request> = [];
    const runningTurnDetail = makeInteractionSnapshot("turn-1");
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "watch",
        "thread-1",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "RemoteWatchInteractionRequiredError");
      assert.equal(Runtime.getErrorExitCode(error), 26);
      const logLines = (yield* TestConsole.logLines).map((line) => String(line));
      assert.equal(logLines.filter((line) => line.includes("approval")).length, 1);
      const errorLines = (yield* TestConsole.errorLines).map((line) => String(line));
      assert.equal(errorLines.filter((line) => line.includes("approval")).length, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            ...threadSnapshotRoutes(runningTurnDetail),
          }),
        ),
      ),
    );
  });

  it("renders timeout failures as sanitized JSON with exit code 23", () => {
    const error = new RemoteWatchTimeoutError({
      threadId: ThreadId.make("thread-1"),
      timeoutMs: 5_000,
    });
    const rendered = renderWatchError(error);
    assert.include(rendered, "watch-timeout");
    assert.equal(Runtime.getErrorExitCode(error), 23);
  });

  it.effect("malformed pending answers fail as one sanitized invalid-input line", () => {
    const requests: Array<Request> = [];
    const sentinel = "SENTINEL-SECRET-VALUE";
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "pending",
        "answer",
        "thread-1",
        "request-1",
        "--idempotency-key",
        "k1",
        "--answers",
        `[{"questionId":"q1","values":["${sentinel}"]}`,
        "--yes",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "UserError");
      assert.include(error.message, "invalid-input");
      assert.isFalse(error.message.includes(sentinel));
      assert.lengthOf(requests, 0);
      const errorLines = (yield* TestConsole.errorLines).map((line) => String(line));
      assert.equal(errorLines.filter((line) => line.includes("invalid-input")).length, 1);
      assert.equal(errorLines.filter((line) => line.includes(sentinel)).length, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, TestConsole.layer, fakeRoutingLayer(requests, {})),
      ),
    );
  });

  it.effect("invalid pending interaction ids fail as one sanitized invalid-input line", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "pending",
        "approve",
        "thread-1",
        "request/../secret-id",
        "--idempotency-key",
        "k1",
        "--yes",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "UserError");
      assert.include(error.message, "invalid-input");
      assert.isFalse(error.message.includes("secret-id"));
      assert.lengthOf(requests, 0);
      const errorLines = (yield* TestConsole.errorLines).map((line) => String(line));
      assert.equal(errorLines.filter((line) => line.includes("invalid-input")).length, 1);
      assert.equal(errorLines.filter((line) => line.includes("secret-id")).length, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, TestConsole.layer, fakeRoutingLayer(requests, {})),
      ),
    );
  });

  const SENTINEL_TURN_ID = `turn-${"x".repeat(480)}-https://evil.example?token=secret`;

  const makeTerminalWithoutMessageDetail = (runId: string) =>
    makeThreadSnapshotJson({ runId, status: "completed" });

  const makeRunningTurnDetail = (runId: string) =>
    makeThreadSnapshotJson({ runId, status: "running" });

  it.effect("hostile turn ids are omitted from terminal-without-message output", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "watch",
        "thread-1",
        "--no-interactions",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "RemoteWatchTerminalWithoutMessageError");
      assert.equal(Runtime.getErrorExitCode(error), 20);
      const errorLines = (yield* TestConsole.errorLines).map((line) => String(line));
      const logLines = (yield* TestConsole.logLines).map((line) => String(line));
      const all = [...errorLines, ...logLines].join("\n");
      assert.isTrue(errorLines.some((line) => line.includes("watch-terminal-without-message")));
      assert.equal(errorLines.filter((line) => line.includes("watch-")).length, 1);
      assert.isFalse(all.includes("evil.example"));
      assert.isFalse(all.includes("token=secret"));
      assert.isFalse(all.includes("xxxxx"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            ...threadSnapshotRoutes(makeTerminalWithoutMessageDetail(SENTINEL_TURN_ID)),
          }),
        ),
      ),
    );
  });

  it.effect("hostile thread/turn ids are omitted from interaction-required output", () => {
    const requests: Array<Request> = [];
    const runningTurnDetail = makeInteractionSnapshot(SENTINEL_TURN_ID);
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "watch",
        "thread-1",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "RemoteWatchInteractionRequiredError");
      assert.equal(Runtime.getErrorExitCode(error), 26);
      const logLines = (yield* TestConsole.logLines).map((line) => String(line));
      const interactionLines = logLines.filter((line) => line.includes("request-1"));
      assert.equal(interactionLines.length, 1);
      assert.isFalse(interactionLines[0]?.includes("evil.example"));
      assert.isFalse(interactionLines[0]?.includes("token=secret"));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            ...threadSnapshotRoutes(runningTurnDetail),
          }),
        ),
      ),
    );
  });

  it.live("watch timeout renders exactly one sanitized watch-timeout line and exits 23", () => {
    const requests: Array<Request> = [];
    return Effect.gen(function* () {
      const home = yield* makeTokenedHome();
      const error = yield* runCli([
        "remote",
        "watch",
        "thread-1",
        "--no-interactions",
        "--timeout",
        "500ms",
        "--host",
        "https://fake.test",
        "--base-dir",
        home,
      ]).pipe(Effect.flip);

      assert.equal(error._tag, "RemoteWatchTimeoutError");
      assert.equal(Runtime.getErrorExitCode(error), 23);
      const errorLines = (yield* TestConsole.errorLines).map((line) => String(line));
      assert.equal(errorLines.filter((line) => line.includes("watch-timeout")).length, 1);
      assert.equal(errorLines.filter((line) => line.includes("watch-")).length, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          TestConsole.layer,
          fakeRoutingLayer(requests, {
            "/.well-known/t3/environment": () => jsonResponse(descriptorJson),
            "/api/auth/session": () => jsonResponse(sessionJson),
            "/api/auth/websocket-ticket": () => new Promise<Response>(() => {}),
            ...threadSnapshotRoutes(makeRunningTurnDetail("turn-1")),
          }),
        ),
      ),
    );
  });
});
