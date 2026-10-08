import {
  AuthSessionId,
  CommandId,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  OrchestrationCliCreateResult,
  type OrchestrationCliCreateRequest as OrchestrationCliCreateRequestType,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type RunId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import type { OrchestrationEventStoreError } from "../persistence/Errors.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStore from "./EventStore.ts";
import {
  OrchestrationHttpCreateOperations,
  type HttpCreateOperation,
  type HttpCreatePreparationAttempt,
  type OrchestrationHttpCreateOperationPersistenceError,
} from "../persistence/OrchestrationHttpCreateOperations.ts";
import {
  getHttpCreateIdentity,
  getHttpCreateSemanticHash,
  HttpCreatePlanError,
  makeHttpCreatePlanResolver,
  type HttpCreateIdentity,
} from "./httpCreatePlan.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";

export class HttpCreateStateError extends Schema.TaggedError<HttpCreateStateError>()(
  "HttpCreateStateError",
  {
    reason: Schema.Literals(["payload_mismatch", "incomplete", "invalid_operation"]),
    message: Schema.String,
  },
) {}

export interface HttpCreateCoordinatorDependencies {
  readonly operations: OrchestrationHttpCreateOperations["Service"];
  readonly receipts: CommandReceiptStore.CommandReceiptStoreV2["Service"];
  readonly eventStore: EventStore.EventStoreV2["Service"];
  readonly applicationEvents: OrchestrationEventStore.OrchestrationEventStore["Service"];
  readonly threadLaunch: ThreadLaunch.ThreadLaunchService["Service"];
  readonly resolvePlan: ReturnType<typeof makeHttpCreatePlanResolver>["resolve"];
  readonly workerScope: Scope.Scope;
}

type HttpCreatePlanResolverError = Effect.Error<
  ReturnType<HttpCreateCoordinatorDependencies["resolvePlan"]>
>;
type ThreadLaunchRetryError = Effect.Error<
  ReturnType<HttpCreateCoordinatorDependencies["threadLaunch"]["retryPreparation"]>
>;

export type HttpCreateCoordinatorError =
  | HttpCreateStateError
  | HttpCreatePlanError
  | OrchestrationHttpCreateOperationPersistenceError
  | CommandReceiptStore.CommandReceiptStoreV2Error
  | EventStore.EventStoreV2Error
  | OrchestrationEventStoreError
  | ThreadLaunch.ThreadLaunchError
  | ThreadLaunchRetryError
  | HttpCreatePlanResolverError;

type AttemptOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "released"; readonly sequence: number }
  | { readonly kind: "failed"; readonly failure: OrchestrationV2ProviderFailure };

type CreateExit = Exit.Exit<OrchestrationCliCreateResult, HttpCreateCoordinatorError>;
type ActiveJob = {
  readonly sessionId: string;
  readonly semanticHash: string;
  readonly completion: Deferred.Deferred<CreateExit>;
};

const stateError = (
  reason: HttpCreateStateError["reason"],
  message: string,
): HttpCreateStateError => new HttpCreateStateError({ reason, message });

const isPositiveSequence = (sequence: number): boolean =>
  Number.isSafeInteger(sequence) && sequence > 0;

const commandId = (value: string): CommandId => CommandId.make(value);

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const attemptCommandId = (attempt: HttpCreatePreparationAttempt, suffix: "release" | "fail") =>
  commandId(`${attempt.commandId}:${suffix}`);

const isUserRunForMessage = (
  run: OrchestrationV2Run,
  messageId: HttpCreateOperation["launchPlan"]["messageId"],
): boolean =>
  run.purpose !== "compaction" && "userMessageId" in run && run.userMessageId === messageId;

const isRunUpdated = (
  event: OrchestrationV2DomainEvent,
  runId: RunId,
): event is Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }> =>
  event.type === "run.updated" && event.payload.id === runId;

const result = (
  operation: HttpCreateOperation,
  runId: RunId,
  sequence: number,
  replayed: boolean,
): OrchestrationCliCreateResult => ({
  threadId: operation.launchPlan.threadId,
  commandId: operation.launchPlan.commandId,
  turnId: runId,
  sequence,
  replayed,
});

const operationMismatch = (
  operation: HttpCreateOperation,
  identity: HttpCreateIdentity,
  sessionId: string,
  semanticHash: string,
): HttpCreateStateError | null => {
  if (operation.sessionId !== sessionId || operation.semanticHash !== semanticHash) {
    return stateError(
      "payload_mismatch",
      "The HTTP create idempotency key belongs to a different session or payload.",
    );
  }
  if (
    operation.keyHash !== identity.keyHash ||
    operation.launchPlan.commandId !== identity.commandId ||
    operation.launchPlan.threadId !== identity.threadId ||
    operation.launchPlan.messageId !== identity.messageId ||
    operation.launchPlan.initialMessage.messageId !== identity.messageId
  ) {
    return stateError(
      "invalid_operation",
      "The stored HTTP create operation contains contradictory identities.",
    );
  }
  return null;
};

export const makeHttpCreateCoordinator = (dependencies: HttpCreateCoordinatorDependencies) => {
  const registry = new Map<string, ActiveJob>();
  const registrySemaphore = Semaphore.makeUnsafe(1);

  const runForKey = (
    sessionId: AuthSessionId,
    request: OrchestrationCliCreateRequestType,
    identity: HttpCreateIdentity,
    semanticHash: string,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      const registration = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const candidate = yield* Deferred.make<CreateExit>();
          const registered = yield* registrySemaphore.withPermit(
            Effect.sync(() => {
              const current = registry.get(identity.keyHash);
              if (current !== undefined) {
                return { job: current, owner: false } as const;
              }
              const job: ActiveJob = { sessionId, semanticHash, completion: candidate };
              registry.set(identity.keyHash, job);
              return { job, owner: true } as const;
            }),
          );
          if (!registered.owner) return registered;

          const worker = Effect.interruptible(
            Effect.exit(process(sessionId, request, identity, semanticHash)).pipe(
              Effect.tap((completion) => Deferred.succeed(registered.job.completion, completion)),
              Effect.ensuring(
                registrySemaphore.withPermit(
                  Effect.sync(() => {
                    if (registry.get(identity.keyHash) === registered.job) {
                      registry.delete(identity.keyHash);
                    }
                  }),
                ),
              ),
            ),
          );
          const forked = yield* Effect.exit(Effect.forkIn(worker, dependencies.workerScope));
          if (Exit.isFailure(forked)) {
            yield* registrySemaphore.withPermit(
              Effect.sync(() => {
                if (registry.get(identity.keyHash) === registered.job) {
                  registry.delete(identity.keyHash);
                }
              }),
            );
            return yield* stateError(
              "incomplete",
              "The HTTP create worker scope closed before the operation could start.",
            );
          }
          return registered;
        }),
      );

      if (
        registration.job.sessionId !== sessionId ||
        registration.job.semanticHash !== semanticHash
      ) {
        return yield* stateError(
          "payload_mismatch",
          "The HTTP create idempotency key belongs to a different session or payload.",
        );
      }

      const completed = yield* Deferred.await(registration.job.completion);
      const result = registration.owner
        ? completed
        : Exit.map(completed, (value) => ({ ...value, replayed: true }));
      return yield* Exit.match(result, {
        onFailure: Effect.failCause,
        onSuccess: Effect.succeed,
      });
    });

  const create = (
    sessionId: AuthSessionId,
    request: OrchestrationCliCreateRequestType,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> => {
    const identity = getHttpCreateIdentity(sessionId, request.idempotencyKey);
    const semanticHash = getHttpCreateSemanticHash(request);
    return runForKey(sessionId, request, identity, semanticHash);
  };

  const process = (
    sessionId: AuthSessionId,
    request: OrchestrationCliCreateRequestType,
    identity: HttpCreateIdentity,
    semanticHash: string,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      const stored = yield* dependencies.operations.get(identity.keyHash);
      if (Option.isSome(stored)) {
        const operation = stored.value;
        const mismatch = operationMismatch(operation, identity, sessionId, semanticHash);
        if (mismatch !== null) return yield* mismatch;
        if (operation.phase === "running") {
          return yield* recoverRunning(operation);
        }
        if (operation.phase === "completed") {
          return yield* replayCompleted(operation);
        }
        if (operation.phase === "retry-ready") {
          return yield* retryFailed(operation);
        }
        return yield* launchReady(operation);
      }

      if ((yield* dependencies.eventStore.latestSequence({ threadId: identity.threadId })) > 0) {
        return yield* stateError(
          "incomplete",
          "A prior HTTP create attempt left durable thread events without its operation record.",
        );
      }
      const initialReceipt = yield* dependencies.receipts.getByCommandId(identity.commandId);
      const initialMessageReceipt = yield* dependencies.receipts.getByCommandId(
        commandId(`${identity.commandId}:initial-message`),
      );
      if (Option.isSome(initialReceipt) || Option.isSome(initialMessageReceipt)) {
        return yield* stateError(
          "incomplete",
          "A prior HTTP create attempt left a native receipt without its operation record.",
        );
      }

      const launchPlan = yield* dependencies.resolvePlan(request, identity);
      const operation: HttpCreateOperation = {
        keyHash: identity.keyHash,
        sessionId,
        semanticHash,
        launchPlan,
        phase: "ready",
        attempts: [{ ordinal: 1, commandId: identity.commandId, kind: "launch" }],
        runId: null,
        sequence: null,
        failure: null,
      };
      const inserted = yield* dependencies.operations.insert(operation);
      if (!inserted) {
        const raced = yield* dependencies.operations.get(identity.keyHash);
        if (Option.isSome(raced)) {
          const mismatch = operationMismatch(raced.value, identity, sessionId, semanticHash);
          if (mismatch !== null) return yield* mismatch;
          if (raced.value.phase === "ready") return yield* launchReady(raced.value);
          if (raced.value.phase === "retry-ready") return yield* retryFailed(raced.value);
          if (raced.value.phase === "completed") return yield* replayCompleted(raced.value);
        }
        return yield* stateError(
          "incomplete",
          "Another HTTP create coordinator claimed this operation but its durable state is unavailable.",
        );
      }
      return yield* launchReady(operation);
    });

  const findOriginalRunId = (
    operation: HttpCreateOperation,
  ): Effect.Effect<Option.Option<RunId>, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      const initialMessageCommandId = commandId(
        `${operation.launchPlan.commandId}:initial-message`,
      );
      const events = Array.from(
        yield* Stream.runCollect(
          dependencies.eventStore.readByCommandId({ commandId: initialMessageCommandId }),
        ),
      );
      const created = events.filter((stored) => stored.event.type === "run.created");
      if (created.length === 0) return Option.none();
      if (created.length !== 1 || created[0]?.event.type !== "run.created") {
        return yield* stateError(
          "incomplete",
          "The frozen initial-message command does not identify one original user run.",
        );
      }
      const original = created[0].event;
      if (
        original.threadId !== operation.launchPlan.threadId ||
        !isUserRunForMessage(original.payload, operation.launchPlan.messageId)
      ) {
        return yield* stateError(
          "incomplete",
          "The original native user run does not match the frozen thread and message identities.",
        );
      }
      return Option.some(original.payload.id);
    });

  const verifyOriginalRun = (
    operation: HttpCreateOperation,
    runId: RunId,
  ): Effect.Effect<void, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      const originalRunId = yield* findOriginalRunId(operation);
      if (Option.isNone(originalRunId) || originalRunId.value !== runId) {
        return yield* stateError(
          "invalid_operation",
          "The original native user run does not match the stored launch identities.",
        );
      }
    });

  const inspectAttempt = (
    operation: HttpCreateOperation,
    attempt: HttpCreatePreparationAttempt,
    runId: RunId,
  ): Effect.Effect<AttemptOutcome, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      const releaseId = attemptCommandId(attempt, "release");
      const failureId = attemptCommandId(attempt, "fail");
      const [releaseReceipt, failureReceipt] = yield* Effect.all([
        dependencies.receipts.getByCommandId(releaseId),
        dependencies.receipts.getByCommandId(failureId),
      ]);

      if (Option.isSome(releaseReceipt) && Option.isSome(failureReceipt)) {
        return yield* stateError(
          "invalid_operation",
          "A native preparation attempt has contradictory release and failure receipts.",
        );
      }
      if (Option.isNone(releaseReceipt) && Option.isNone(failureReceipt)) {
        return { kind: "missing" } as const;
      }

      const isRelease = Option.isSome(releaseReceipt);
      const receipt = Option.getOrUndefined(isRelease ? releaseReceipt : failureReceipt);
      if (receipt === undefined) {
        return yield* stateError(
          "invalid_operation",
          "The preparation attempt is missing its exclusive native receipt.",
        );
      }
      const expectedCommandId = isRelease ? releaseId : failureId;
      const expectedType = isRelease ? "prepared-run.release" : "prepared-run.fail";
      if (
        receipt.commandId !== expectedCommandId ||
        receipt.threadId !== operation.launchPlan.threadId ||
        receipt.commandType !== expectedType ||
        receipt.status !== "accepted" ||
        receipt.error !== null ||
        !isPositiveSequence(receipt.resultSequence)
      ) {
        return yield* stateError(
          "incomplete",
          "The native preparation receipt is rejected or does not match the stored attempt.",
        );
      }

      const events = Array.from(
        yield* Stream.runCollect(
          dependencies.eventStore.readByCommandId({ commandId: expectedCommandId }),
        ),
      );
      const finalEvent = events.at(-1);
      const highWater = yield* dependencies.eventStore.latestApplicationSequence;
      if (
        events.length === 0 ||
        events.some((stored) => stored.event.threadId !== operation.launchPlan.threadId) ||
        finalEvent?.sequence !== receipt.resultSequence ||
        receipt.resultSequence > highWater
      ) {
        return yield* stateError(
          "invalid_operation",
          "The native preparation receipt does not bind its persisted events.",
        );
      }

      const runUpdates = events.flatMap((stored) =>
        isRunUpdated(stored.event, runId) ? [{ stored, event: stored.event }] : [],
      );
      const finalRun = runUpdates.at(-1);
      if (
        finalRun === undefined ||
        !isUserRunForMessage(finalRun.event.payload, operation.launchPlan.messageId)
      ) {
        return yield* stateError(
          "invalid_operation",
          "The native preparation events do not identify the stored user run.",
        );
      }

      if (isRelease) {
        const hasCheckpointScope = events.some(
          (stored) =>
            stored.event.type === "checkpoint-scope.created" && stored.event.runId === runId,
        );
        if (
          !hasCheckpointScope ||
          (finalRun.event.payload.status !== "starting" &&
            finalRun.event.payload.status !== "queued")
        ) {
          return yield* stateError(
            "invalid_operation",
            "The native release receipt is missing its checkpoint or accepted run transition.",
          );
        }
        return { kind: "released", sequence: receipt.resultSequence } as const;
      }

      if (finalRun.event.payload.status !== "failed") {
        return yield* stateError(
          "invalid_operation",
          "The native failure receipt does not contain the failed user run.",
        );
      }
      const failures = events.flatMap((stored) => {
        const event = stored.event;
        if (event.type !== "turn-item.updated") return [];
        const item = event.payload;
        return item.type === "error" &&
          item.status === "failed" &&
          item.runId === runId &&
          item.nodeId === finalRun.event.payload.rootNodeId &&
          item.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE
          ? [item.failure]
          : [];
      });
      if (failures.length !== 1) {
        return yield* stateError(
          "invalid_operation",
          "The native failure receipt does not contain one exact workspace-preparation failure.",
        );
      }
      return { kind: "failed", failure: failures[0]! } as const;
    });

  const recoverRunning = (
    operation: HttpCreateOperation,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      const attempt = operation.attempts.at(-1);
      if (attempt === undefined) {
        return yield* stateError("incomplete", "The running HTTP create operation has no attempt.");
      }

      const originalRunId = yield* findOriginalRunId(operation);
      if (Option.isNone(originalRunId)) {
        return yield* stateError(
          "incomplete",
          "The frozen initial-message command has no durable original user-run identity.",
        );
      }
      const runId = originalRunId.value;
      if (operation.runId !== null && operation.runId !== runId) {
        return yield* stateError(
          "incomplete",
          "The stored run identity contradicts the frozen initial-message command.",
        );
      }

      const outcome = yield* inspectAttempt(operation, attempt, runId);
      if (outcome.kind !== "released") {
        return yield* stateError(
          "incomplete",
          outcome.kind === "failed"
            ? "The native attempt failed but durable retry permission was not recorded."
            : "The current native attempt has no authoritative accepted release evidence.",
        );
      }

      // Native receipts and events are the acceptance authority. The HTTP
      // operation row is only a replay index, so its repair cannot erase a
      // release that already passed the exact run, thread, message and scope checks.
      yield* Effect.exit(
        dependencies.operations.complete({
          keyHash: operation.keyHash,
          commandId: attempt.commandId,
          runId,
          sequence: outcome.sequence,
        }),
      );
      return result(operation, runId, outcome.sequence, true);
    });

  const replayCompleted = (
    operation: HttpCreateOperation,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      if (operation.runId === null || operation.sequence === null) {
        return yield* stateError(
          "invalid_operation",
          "The completed HTTP create operation is incomplete.",
        );
      }
      yield* verifyOriginalRun(operation, operation.runId);
      const attempt = operation.attempts.at(-1);
      if (attempt === undefined) {
        return yield* stateError(
          "invalid_operation",
          "The completed HTTP create operation has no attempt.",
        );
      }
      const outcome = yield* inspectAttempt(operation, attempt, operation.runId);
      if (outcome.kind !== "released" || outcome.sequence !== operation.sequence) {
        return yield* stateError(
          "invalid_operation",
          "The completed HTTP create operation has no matching release.",
        );
      }
      return result(operation, operation.runId, operation.sequence, true);
    });

  const launchReady = (
    operation: HttpCreateOperation,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      const claimed = yield* dependencies.operations.claim(operation.keyHash);
      if (!claimed) {
        const current = yield* dependencies.operations.get(operation.keyHash);
        if (Option.isSome(current) && current.value.phase === "completed") {
          return yield* replayCompleted(current.value);
        }
        return yield* stateError(
          "incomplete",
          "The HTTP create operation is no longer ready to launch.",
        );
      }
      const attempt = operation.attempts[0];
      if (attempt === undefined) {
        return yield* stateError(
          "invalid_operation",
          "The HTTP create operation has no launch attempt.",
        );
      }
      return yield* runAttempt(operation, attempt, false);
    });

  const retryFailed = (
    operation: HttpCreateOperation,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> =>
    Effect.gen(function* () {
      if (operation.runId === null || operation.failure === null) {
        return yield* stateError(
          "invalid_operation",
          "The retry-ready HTTP create operation is incomplete.",
        );
      }
      const priorAttempt = operation.attempts.at(-1);
      if (
        priorAttempt === undefined ||
        (priorAttempt.kind !== "launch" && priorAttempt.kind !== "retry")
      ) {
        return yield* stateError(
          "invalid_operation",
          "The retry-ready HTTP create operation has no failed attempt.",
        );
      }
      const failed = yield* inspectAttempt(operation, priorAttempt, operation.runId);
      if (
        failed.kind !== "failed" ||
        stableJson(failed.failure) !== stableJson(operation.failure)
      ) {
        return yield* stateError(
          "incomplete",
          "The persisted retry permission does not match the exact native preparation failure.",
        );
      }
      yield* verifyOriginalRun(operation, operation.runId);

      const nextAttempt: HttpCreatePreparationAttempt = {
        ordinal: operation.attempts.length + 1,
        commandId: commandId(
          `${operation.launchPlan.commandId}:retry:${operation.attempts.length}`,
        ),
        kind: "retry",
      };
      const reserved = yield* dependencies.operations.reserveRetry({
        keyHash: operation.keyHash,
        commandId: priorAttempt.commandId,
        attempt: nextAttempt,
      });
      if (!reserved) {
        return yield* stateError(
          "incomplete",
          "The HTTP create retry was claimed by another coordinator.",
        );
      }
      return yield* runAttempt(
        {
          ...operation,
          attempts: [...operation.attempts, nextAttempt],
          phase: "running",
          failure: null,
        },
        nextAttempt,
        true,
      );
    });

  const runAttempt = (
    operation: HttpCreateOperation,
    attempt: HttpCreatePreparationAttempt,
    retry: boolean,
  ): Effect.Effect<OrchestrationCliCreateResult, HttpCreateCoordinatorError> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Both feeds are established before native dispatch. The preparation
        // observer is subscribe-before-snapshot; the global event cursor then
        // provides durable replay-to-live coverage across its snapshot gap.
        const preparation = yield* dependencies.threadLaunch.observePreparations;
        if (preparation.active.some((activity) => activity.commandId === attempt.commandId)) {
          return yield* stateError(
            "incomplete",
            "This preparation attempt is already active outside its HTTP job.",
          );
        }
        const afterSequence = yield* dependencies.eventStore.latestApplicationSequence;
        const releaseSignal = yield* Deferred.make<true, HttpCreateCoordinatorError>();
        const discoveredRunId = yield* Ref.make<RunId | null>(retry ? operation.runId : null);
        const observer = dependencies.applicationEvents
          .streamApplicationEvents({ afterSequence })
          .pipe(
            Stream.runForEach((stored) =>
              Effect.gen(function* () {
                if (!("event" in stored) || stored.event.threadId !== operation.launchPlan.threadId)
                  return;
                const event = stored.event;
                if (
                  event.type === "run.created" &&
                  isUserRunForMessage(event.payload, operation.launchPlan.messageId)
                ) {
                  yield* Ref.set(discoveredRunId, event.payload.id);
                  return;
                }
                if (event.type !== "run.updated") return;
                const runId = yield* Ref.get(discoveredRunId);
                if (
                  runId !== null &&
                  event.payload.id === runId &&
                  isUserRunForMessage(event.payload, operation.launchPlan.messageId) &&
                  (event.payload.status === "starting" || event.payload.status === "queued")
                ) {
                  yield* Deferred.succeed(releaseSignal, true);
                }
              }),
            ),
            Effect.catchCause((cause) =>
              Deferred.failCause(releaseSignal, cause).pipe(Effect.asVoid),
            ),
          );
        yield* Effect.forkScoped(observer);

        let runId = operation.runId;
        if (!retry) {
          const launched = yield* dependencies.threadLaunch.launch({
            commandId: operation.launchPlan.commandId,
            threadId: operation.launchPlan.threadId,
            projectId: operation.launchPlan.projectId,
            title: operation.launchPlan.title,
            modelSelection: operation.launchPlan.modelSelection,
            runtimeMode: operation.launchPlan.runtimeMode,
            interactionMode: operation.launchPlan.interactionMode,
            workspaceStrategy: operation.launchPlan.workspaceStrategy,
            initialMessage: operation.launchPlan.initialMessage,
            createdBy: operation.launchPlan.createdBy,
            creationSource: operation.launchPlan.creationSource,
          });
          const matchingRuns = launched.projection.runs.filter((run) =>
            isUserRunForMessage(run, operation.launchPlan.messageId),
          );
          if (
            launched.threadId !== operation.launchPlan.threadId ||
            matchingRuns.length !== 1 ||
            matchingRuns[0] === undefined
          ) {
            return yield* stateError(
              "invalid_operation",
              "Native launch returned a contradictory user run.",
            );
          }
          runId = matchingRuns[0].id;
          yield* verifyOriginalRun(operation, runId);
          yield* dependencies.operations.checkpointRun({
            keyHash: operation.keyHash,
            commandId: attempt.commandId,
            runId,
          });
        }
        if (runId === null) {
          return yield* stateError(
            "invalid_operation",
            "The retry operation lost its native run id.",
          );
        }

        if (retry) {
          yield* dependencies.threadLaunch
            .retryPreparation({
              commandId: attempt.commandId,
              threadId: operation.launchPlan.threadId,
              runId,
            })
            .pipe(Effect.asVoid);
        }

        const signal = yield* Effect.race(
          Deferred.await(releaseSignal),
          dependencies.threadLaunch.awaitPreparation(attempt.commandId).pipe(Effect.as(false)),
        );
        const outcome = yield* inspectAttempt(operation, attempt, runId);
        if (outcome.kind === "released") {
          yield* dependencies.operations.complete({
            keyHash: operation.keyHash,
            commandId: attempt.commandId,
            runId,
            sequence: outcome.sequence,
          });
          return result(operation, runId, outcome.sequence, false);
        }
        if (outcome.kind === "failed") {
          yield* dependencies.operations.markRetryReady({
            keyHash: operation.keyHash,
            commandId: attempt.commandId,
            failure: outcome.failure,
          });
          return yield* stateError(
            "incomplete",
            `Workspace preparation failed and is ready for an explicit retry: ${outcome.failure.message}`,
          );
        }
        return yield* stateError(
          "incomplete",
          signal
            ? "The native release event has no accepted correlated receipt."
            : "Workspace preparation ended without an accepted release or durable failure receipt; retry is disabled.",
        );
      }),
    );

  return { create };
};
