import {
  AuthSessionId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "./Sqlite.ts";
import {
  HttpCreateOperation,
  OrchestrationHttpCreateOperationPersistenceError,
  OrchestrationHttpCreateOperations,
  layer as orchestrationHttpCreateOperationsLayer,
} from "./OrchestrationHttpCreateOperations.ts";

const testLayer = it.layer(
  Layer.fresh(orchestrationHttpCreateOperationsLayer.pipe(Layer.provideMerge(layerMemory))),
);

const makeOperation = (suffix: string): typeof HttpCreateOperation.Type => {
  const commandId = CommandId.make(`cli-create:${suffix}`);
  const threadId = ThreadId.make(`cli-thread:${suffix}`);
  const messageId = MessageId.make(`cli-create:${suffix}`);
  return {
    keyHash: `key-${suffix}`,
    sessionId: AuthSessionId.make(`session-${suffix}`),
    semanticHash: `semantic-${suffix}`,
    launchPlan: {
      commandId,
      threadId,
      messageId,
      projectId: ProjectId.make(`project-${suffix}`),
      title: "Native HTTP creation",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex-personal"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId, text: "Create a native thread", attachments: [] },
      createdBy: "user",
      creationSource: "web",
    },
    phase: "ready",
    attempts: [{ ordinal: 1, commandId, kind: "launch" }],
    runId: null,
    sequence: null,
    failure: null,
  };
};

const failure = {
  class: "provider_error",
  message: "Workspace preparation failed",
  code: "workspace_preparation_failed",
  retryable: true,
} as const;
const isCreateOperationPersistenceError = Schema.is(
  OrchestrationHttpCreateOperationPersistenceError,
);

const assertPersistenceFailure = (exit: Exit.Exit<unknown, unknown>) => {
  assert.equal(exit._tag, "Failure");
  if (Exit.isFailure(exit)) {
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    assert.isTrue(isCreateOperationPersistenceError(error));
  }
};

testLayer("OrchestrationHttpCreateOperations", (test) => {
  test.effect("persists create identities through a native retry and completion", () =>
    Effect.gen(function* () {
      const operations = yield* OrchestrationHttpCreateOperations;
      const operation = makeOperation("retry");
      const runId = RunId.make("run-retry");
      assert.isTrue(yield* operations.insert(operation));
      assert.isFalse(yield* operations.insert(operation));

      const inserted = yield* operations.get(operation.keyHash);
      assert.deepEqual(Option.getOrUndefined(inserted), operation);
      assert.isTrue(yield* operations.claim(operation.keyHash));
      assert.isFalse(yield* operations.claim(operation.keyHash));

      yield* operations.checkpointRun({
        keyHash: operation.keyHash,
        commandId: operation.launchPlan.commandId,
        runId,
      });
      yield* operations.markRetryReady({
        keyHash: operation.keyHash,
        commandId: operation.launchPlan.commandId,
        failure,
      });
      const retryReady = yield* operations.get(operation.keyHash);
      assert.equal(Option.getOrUndefined(retryReady)?.phase, "retry-ready");
      assert.deepEqual(Option.getOrUndefined(retryReady)?.failure, failure);

      const retryCommandId = CommandId.make(`${operation.launchPlan.commandId}:retry:1`);
      assert.isTrue(
        yield* operations.reserveRetry({
          keyHash: operation.keyHash,
          commandId: operation.launchPlan.commandId,
          attempt: { ordinal: 2, commandId: retryCommandId, kind: "retry" },
        }),
      );
      yield* operations.checkpointRun({
        keyHash: operation.keyHash,
        commandId: retryCommandId,
        runId,
      });
      yield* operations.complete({
        keyHash: operation.keyHash,
        commandId: retryCommandId,
        runId,
        sequence: 18,
      });

      const completed = yield* operations.get(operation.keyHash);
      const originalAttempt = operation.attempts[0];
      assert.isDefined(originalAttempt);
      assert.deepEqual(Option.getOrUndefined(completed), {
        ...operation,
        phase: "completed",
        attempts: [originalAttempt, { ordinal: 2, commandId: retryCommandId, kind: "retry" }],
        runId,
        sequence: 18,
      });
    }),
  );

  test.effect("rejects stale retry claims and identity changes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const operations = yield* OrchestrationHttpCreateOperations;
      const operation = makeOperation("immutable");
      const runId = RunId.make("run-immutable");
      assert.isTrue(yield* operations.insert(operation));
      assert.isTrue(yield* operations.claim(operation.keyHash));
      yield* operations.checkpointRun({
        keyHash: operation.keyHash,
        commandId: operation.launchPlan.commandId,
        runId,
      });
      yield* operations.markRetryReady({
        keyHash: operation.keyHash,
        commandId: operation.launchPlan.commandId,
        failure,
      });

      assert.isFalse(
        yield* operations.reserveRetry({
          keyHash: operation.keyHash,
          commandId: CommandId.make("stale-command"),
          attempt: {
            ordinal: 2,
            commandId: CommandId.make("retry-command"),
            kind: "retry",
          },
        }),
      );

      const immutableUpdate = yield* sql`
          UPDATE orchestration_http_create_operations
          SET message_id = 'rewritten-message'
          WHERE key_hash = ${operation.keyHash}
        `.pipe(Effect.exit);
      assert.equal(immutableUpdate._tag, "Failure");
      const stored = yield* operations.get(operation.keyHash);
      assert.equal(
        Option.getOrUndefined(stored)?.launchPlan.messageId,
        operation.launchPlan.messageId,
      );
    }),
  );

  test.effect("detects contradictory persisted attempt ordinals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const operations = yield* OrchestrationHttpCreateOperations;
      const operation = makeOperation("corrupt");
      assert.isTrue(yield* operations.insert(operation));
      yield* sql`
        UPDATE orchestration_http_create_operations
        SET attempts_json = '[{"ordinal":2,"commandId":"bad","kind":"launch"}]'
        WHERE key_hash = ${operation.keyHash}
      `;
      assertPersistenceFailure(yield* operations.get(operation.keyHash).pipe(Effect.exit));
    }),
  );
});
