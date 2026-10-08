import {
  AuthSessionId,
  OrchestrationCliCreateRequest,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import {
  HttpCreateOperation,
  type HttpCreateOperation as HttpCreateOperationType,
  type OrchestrationHttpCreateOperations as OrchestrationHttpCreateOperationsType,
} from "../persistence/OrchestrationHttpCreateOperations.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStore from "./EventStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import { getHttpCreateIdentity, getHttpCreateSemanticHash } from "./httpCreatePlan.ts";
import { HttpCreateStateError, makeHttpCreateCoordinator } from "./httpCreateCoordinator.ts";

const SESSION_ID = AuthSessionId.make("session-http-create-native-coordinator");
const decodeRequest = Schema.decodeUnknownSync(OrchestrationCliCreateRequest);
const decodeOperation = Schema.decodeUnknownSync(HttpCreateOperation);
const isHttpCreateStateError = Schema.is(HttpCreateStateError);

const makeRequest = (overrides: Record<string, unknown> = {}) =>
  decodeRequest({
    project: "project-http-create-native",
    message: "Create a native thread",
    idempotencyKey: "native-recovery-key",
    ...overrides,
  });

const makeOperation = (request: ReturnType<typeof makeRequest>): HttpCreateOperationType => {
  const identity = getHttpCreateIdentity(SESSION_ID, request.idempotencyKey);
  return decodeOperation({
    keyHash: identity.keyHash,
    sessionId: SESSION_ID,
    semanticHash: getHttpCreateSemanticHash(request),
    launchPlan: {
      commandId: identity.commandId,
      threadId: identity.threadId,
      messageId: identity.messageId,
      projectId: ProjectId.make("project-http-create-native"),
      title: "Create a native thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: identity.messageId,
        text: request.message,
        attachments: [],
      },
      createdBy: "user",
      creationSource: "web",
    },
    phase: "running",
    attempts: [{ ordinal: 1, commandId: identity.commandId, kind: "launch" }],
    runId: null,
    sequence: null,
    failure: null,
  });
};

const makeFixture = (operation: HttpCreateOperationType) =>
  Effect.gen(function* () {
    let reads = 0;
    let resolverCalls = 0;
    let launchCalls = 0;
    const operations: OrchestrationHttpCreateOperationsType["Service"] = {
      get: (keyHash) =>
        Effect.sync(() => {
          reads += 1;
          return keyHash === operation.keyHash ? Option.some(operation) : Option.none();
        }),
      insert: () => Effect.die("Unexpected HTTP create insert."),
      claim: () => Effect.die("Unexpected HTTP create claim."),
      checkpointRun: () => Effect.die("Unexpected HTTP create run checkpoint."),
      markRetryReady: () => Effect.die("Unexpected HTTP create retry-ready transition."),
      reserveRetry: () => Effect.die("Unexpected HTTP create retry reservation."),
      complete: () => Effect.die("Unexpected HTTP create completion."),
    };
    const receipts: CommandReceiptStore.CommandReceiptStoreV2["Service"] = {
      insertIfAbsent: () => Effect.die("Unexpected native receipt insert."),
      upsert: () => Effect.die("Unexpected native receipt upsert."),
      getByCommandId: () => Effect.succeed(Option.none()),
      getProjectByCommandId: () => Effect.succeed(Option.none()),
    };
    const eventStore: EventStore.EventStoreV2["Service"] = {
      append: () => Effect.die("Unexpected native event append."),
      appendProjectEvent: () => Effect.die("Unexpected project event append."),
      read: () => Stream.empty,
      readByCommandId: () => Stream.empty,
      latestSequence: () => Effect.succeed(0),
      latestApplicationSequence: Effect.succeed(0),
      publishCommitted: () => Effect.void,
    };
    const threadLaunch: ThreadLaunchService.ThreadLaunchService["Service"] = {
      launch: () =>
        Effect.sync(() => {
          launchCalls += 1;
        }).pipe(Effect.andThen(Effect.die("Unexpected native launch."))),
      retryPreparation: () => Effect.die("Unexpected native preparation retry."),
      observePreparations: Effect.succeed({ active: [], changes: Stream.empty }),
      awaitPreparation: () => Effect.void,
    };
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const workerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(workerScope, Exit.void));
    const coordinator = makeHttpCreateCoordinator({
      operations,
      receipts,
      eventStore,
      applicationEvents,
      threadLaunch,
      resolvePlan: () =>
        Effect.sync(() => {
          resolverCalls += 1;
        }).pipe(Effect.andThen(Effect.die("Unexpected HTTP create plan resolution."))),
      workerScope,
    });
    return {
      coordinator,
      get reads() {
        return reads;
      },
      get resolverCalls() {
        return resolverCalls;
      },
      get launchCalls() {
        return launchCalls;
      },
    };
  }).pipe(Effect.provide(Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({})));

it.effect("fails closed for a running durable operation after its live worker is lost", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = makeRequest();
      const fixture = yield* makeFixture(makeOperation(request));
      const error = yield* Effect.flip(fixture.coordinator.create(SESSION_ID, request));

      expect(isHttpCreateStateError(error)).toBe(true);
      if (isHttpCreateStateError(error)) expect(error.reason).toBe("incomplete");
      expect(fixture.reads).toBe(1);
      expect(fixture.resolverCalls).toBe(0);
      expect(fixture.launchCalls).toBe(0);
    }),
  ),
);

it.effect("rejects a changed semantic payload before native work can be replayed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const storedRequest = makeRequest();
      const changedRequest = makeRequest({ message: "Changed semantic payload" });
      const fixture = yield* makeFixture(makeOperation(storedRequest));
      const error = yield* Effect.flip(fixture.coordinator.create(SESSION_ID, changedRequest));

      expect(isHttpCreateStateError(error)).toBe(true);
      if (isHttpCreateStateError(error)) expect(error.reason).toBe("payload_mismatch");
      expect(fixture.reads).toBe(1);
      expect(fixture.resolverCalls).toBe(0);
      expect(fixture.launchCalls).toBe(0);
    }),
  ),
);
