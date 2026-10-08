import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";

import {
  AuthSessionId,
  CommandId,
  EnvironmentThreadCompactionError,
  type OrchestrationCompactRequest,
  type OrchestrationCompactResult,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
  type ThreadCompactCompletionReason,
  ThreadId,
  type RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";

export class ManualCompactionInvalidRequestError extends Schema.TaggedError<ManualCompactionInvalidRequestError>()(
  "ManualCompactionInvalidRequestError",
  { message: Schema.String },
) {}

export class ManualCompactionThreadNotFoundError extends Schema.TaggedError<ManualCompactionThreadNotFoundError>()(
  "ManualCompactionThreadNotFoundError",
  { threadId: ThreadId },
) {}

export type ManualThreadCompactionError =
  | ManualCompactionInvalidRequestError
  | ManualCompactionThreadNotFoundError
  | EnvironmentThreadCompactionError
  | Orchestrator.OrchestratorV2Error
  | CommandReceiptStore.CommandReceiptStoreV2Error
  | EventStore.EventStoreV2Error;

type CompactJob = {
  readonly threadId: ThreadId;
  readonly sessionId: AuthSessionId;
  readonly completion: Deferred.Deferred<
    Exit.Exit<OrchestrationCompactResult, ManualThreadCompactionError>
  >;
};

type CompletionWake =
  | { readonly _tag: "terminal" }
  | { readonly _tag: "stream-ended" }
  | { readonly _tag: "stream-failed" };

const compactCommandId = (sessionId: AuthSessionId, idempotencyKey: string): CommandId => {
  const hash = bytesToHex(
    sha256(new TextEncoder().encode(`${sessionId}\0${idempotencyKey.trim()}`)),
  );
  return CommandId.make(`cli-compact:${hash}`);
};

const isTerminalRunStatus = (status: OrchestrationV2Run["status"]): boolean =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled" ||
  status === "rolled_back";

const runCreatedFor = (
  event: OrchestrationV2DomainEvent,
  threadId: ThreadId,
  commandId: CommandId,
): event is Extract<OrchestrationV2DomainEvent, { readonly type: "run.created" }> =>
  event.type === "run.created" &&
  event.threadId === threadId &&
  event.payload.threadId === threadId &&
  event.payload.purpose === "compaction" &&
  event.payload.requestCommandId === commandId &&
  !("userMessageId" in event.payload);

const isRunUpdated = (
  event: OrchestrationV2DomainEvent,
  runId: RunId,
): event is Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }> =>
  event.type === "run.updated" && event.payload.id === runId;

const receiptRejectionReason = (
  detail: string | null,
  dispatchExit?: Exit.Exit<unknown, Orchestrator.OrchestratorV2Error>,
): ThreadCompactCompletionReason => {
  let rejectionDetail = detail;
  if (dispatchExit !== undefined && Exit.isFailure(dispatchExit)) {
    const dispatchError = Cause.findErrorOption(dispatchExit.cause);
    if (
      Option.isSome(dispatchError) &&
      dispatchError.value._tag === "OrchestratorDispatchError" &&
      typeof dispatchError.value.cause === "string"
    ) {
      rejectionDetail = dispatchError.value.cause;
    }
  }
  const normalized = rejectionDetail?.toLowerCase() ?? "";
  if (
    normalized.includes("active") ||
    normalized.includes("queued") ||
    normalized.includes("background work") ||
    normalized.includes("archived")
  ) {
    return "active-thread";
  }
  if (normalized.includes("codex") || normalized.includes("provider")) {
    return "unsupported-provider";
  }
  return "recovery-required";
};

const runFailureReason = (run: OrchestrationV2Run): ThreadCompactCompletionReason =>
  run.status === "interrupted" || run.status === "cancelled"
    ? "request-interrupted"
    : run.status === "failed"
      ? "provider-rejected"
      : "recovery-required";

export interface ManualThreadCompactionShape {
  readonly compact: (
    sessionId: AuthSessionId,
    request: OrchestrationCompactRequest,
  ) => Effect.Effect<OrchestrationCompactResult, ManualThreadCompactionError>;
}

export class ManualThreadCompaction extends Context.Service<
  ManualThreadCompaction,
  ManualThreadCompactionShape
>()("t3/orchestration-v2/ManualThreadCompaction") {}

export const makeManualThreadCompaction = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const compactionError = (traceId: string, reason: ThreadCompactCompletionReason) =>
    Effect.fail(
      new EnvironmentThreadCompactionError({
        code: "thread_compaction_failed",
        reason,
        traceId,
      }),
    );
  const recoveryRequired = (traceId: string) => compactionError(traceId, "recovery-required");
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const eventStore = yield* EventStore.EventStoreV2;
  const jobScope = yield* Scope.make("sequential");
  const jobs = new Map<CommandId, CompactJob>();
  yield* Effect.addFinalizer(() => Scope.close(jobScope, Exit.void));

  const readCommandEvents = (commandId: CommandId) =>
    Stream.runCollect(eventStore.readByCommandId({ commandId })).pipe(
      Effect.map((events) => Array.from(events)),
    );

  const validateReceipt = (
    receipt: CommandReceiptStore.CommandReceiptV2,
    commandId: CommandId,
    threadId: ThreadId,
  ) => {
    if (
      receipt.commandId !== commandId ||
      receipt.commandType !== "thread.compact" ||
      receipt.threadId !== threadId
    ) {
      return new ManualCompactionInvalidRequestError({
        message: "The compaction idempotency key is already bound to another thread or command.",
      });
    }
    return null;
  };

  const resultFromAcceptedReceipt = (
    receipt: CommandReceiptStore.CommandReceiptV2,
    commandId: CommandId,
    threadId: ThreadId,
    replayed: boolean,
    traceId: string,
  ): Effect.Effect<OrchestrationCompactResult, ManualThreadCompactionError> =>
    Effect.gen(function* () {
      if (receipt.status !== "accepted" || receipt.error !== null || receipt.resultSequence <= 0) {
        return yield* recoveryRequired(traceId);
      }
      const events = yield* readCommandEvents(commandId);
      if (
        events.length === 0 ||
        events.some(
          (stored) => stored.commandId !== commandId || stored.event.threadId !== threadId,
        ) ||
        events.at(-1)?.sequence !== receipt.resultSequence
      ) {
        return yield* recoveryRequired(traceId);
      }
      const created = events.filter((stored) => runCreatedFor(stored.event, threadId, commandId));
      if (created.length !== 1) return yield* recoveryRequired(traceId);
      const runId = created[0]?.event.type === "run.created" ? created[0].event.payload.id : null;
      if (runId === null) return yield* recoveryRequired(traceId);

      const records = yield* orchestrator.getThreadRecords(
        threadId,
        ["runs", "turnItems", "checkpoints"],
        {
          runIds: [runId],
          turnItemRunId: runId,
        },
      );
      const runs = records.runs.filter(
        (run) =>
          run.id === runId && run.purpose === "compaction" && run.requestCommandId === commandId,
      );
      if (runs.length !== 1) return yield* recoveryRequired(traceId);
      const run = runs[0]!;
      if (run.status === "completed") {
        const compactionItems = records.turnItems.filter(
          (item) =>
            item.type === "compaction" &&
            item.status === "completed" &&
            item.runId === run.id &&
            item.nodeId === run.rootNodeId &&
            item.providerThreadId === run.providerThreadId &&
            item.providerTurnId !== null,
        );
        const checkpoint = records.checkpoints.find(
          (candidate) =>
            candidate.id === run.checkpointId &&
            candidate.threadId === threadId &&
            candidate.runId === run.id &&
            candidate.nodeId === run.rootNodeId &&
            candidate.status === "ready",
        );
        if (run.checkpointId === null || compactionItems.length !== 1 || checkpoint === undefined) {
          return yield* recoveryRequired(traceId);
        }
        return {
          threadId,
          commandId,
          sequence: receipt.resultSequence,
          replayed,
        } satisfies OrchestrationCompactResult;
      }
      if (isTerminalRunStatus(run.status)) {
        if (run.status === "failed") {
          const matchingFailure = records.turnItems.some(
            (item) =>
              item.type === "error" &&
              item.status === "failed" &&
              item.runId === run.id &&
              item.nodeId === run.rootNodeId,
          );
          if (!matchingFailure) return yield* recoveryRequired(traceId);
        }
        return yield* compactionError(traceId, runFailureReason(run));
      }
      return yield* recoveryRequired(traceId);
    });

  const replayReceipt = (
    receipt: CommandReceiptStore.CommandReceiptV2,
    commandId: CommandId,
    threadId: ThreadId,
    traceId: string,
  ): Effect.Effect<OrchestrationCompactResult, ManualThreadCompactionError> =>
    Effect.gen(function* () {
      const mismatch = validateReceipt(receipt, commandId, threadId);
      if (mismatch !== null) return yield* mismatch;
      if (receipt.status === "rejected") {
        if (receipt.error === null || (yield* readCommandEvents(commandId)).length > 0) {
          return yield* recoveryRequired(traceId);
        }
        return yield* compactionError(traceId, receiptRejectionReason(receipt.error));
      }
      return yield* resultFromAcceptedReceipt(receipt, commandId, threadId, true, traceId);
    });

  const observeNewRequest = (
    request: OrchestrationCompactRequest,
    commandId: CommandId,
    traceId: string,
  ): Effect.Effect<OrchestrationCompactResult, ManualThreadCompactionError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = yield* orchestrator.getThreadShell(request.threadId);
        if (thread === null)
          return yield* new ManualCompactionThreadNotFoundError({ threadId: request.threadId });
        const afterSequence = yield* orchestrator.getThreadEventSequence(request.threadId);
        const wake = yield* Deferred.make<CompletionWake>();
        const runId = yield* Ref.make<RunId | null>(null);
        const observer = orchestrator
          .streamStoredEventsFrom({ threadId: request.threadId, afterSequence })
          .pipe(
            Stream.runForEach((stored: OrchestrationV2StoredEvent) =>
              Effect.gen(function* () {
                if (stored.commandId === commandId && stored.event.type === "run.created") {
                  if (!runCreatedFor(stored.event, request.threadId, commandId)) {
                    yield* Deferred.succeed(wake, { _tag: "stream-failed" } as const);
                    return;
                  }
                  yield* Ref.set(runId, stored.event.payload.id);
                  return;
                }
                if (stored.event.type !== "run.updated") return;
                const target = yield* Ref.get(runId);
                if (
                  target !== null &&
                  isRunUpdated(stored.event, target) &&
                  isTerminalRunStatus(stored.event.payload.status)
                ) {
                  yield* Deferred.succeed(wake, { _tag: "terminal" } as const);
                }
              }),
            ),
            Effect.exit,
            Effect.flatMap((exit) =>
              Deferred.succeed(
                wake,
                Exit.isSuccess(exit)
                  ? ({ _tag: "stream-ended" } as const)
                  : ({ _tag: "stream-failed" } as const),
              ),
            ),
          );
        const scope = yield* Effect.scope;
        yield* Effect.forkIn(observer, scope, { startImmediately: true });

        const dispatched = yield* Effect.exit(
          orchestrator.dispatch({ type: "thread.compact", commandId, threadId: request.threadId }),
        );
        const storedReceipt = yield* receipts.getByCommandId(commandId);
        if (Option.isNone(storedReceipt)) return yield* recoveryRequired(traceId);
        const receipt = storedReceipt.value;
        const mismatch = validateReceipt(receipt, commandId, request.threadId);
        if (mismatch !== null) return yield* mismatch;
        if (receipt.status === "rejected") {
          if (receipt.error === null || (yield* readCommandEvents(commandId)).length > 0) {
            return yield* recoveryRequired(traceId);
          }
          return yield* compactionError(traceId, receiptRejectionReason(receipt.error, dispatched));
        }
        if (receipt.error !== null || receipt.resultSequence <= 0) {
          return yield* recoveryRequired(traceId);
        }
        if (Exit.isFailure(dispatched)) {
          // The command receipt is authoritative after a dispatch error. An
          // accepted receipt can still have a live native worker to observe.
        }
        const observed = yield* Deferred.await(wake);
        if (observed._tag !== "terminal") return yield* recoveryRequired(traceId);
        return yield* resultFromAcceptedReceipt(
          receipt,
          commandId,
          request.threadId,
          false,
          traceId,
        );
      }),
    );

  const process = (
    request: OrchestrationCompactRequest,
    commandId: CommandId,
    traceId: string,
  ): Effect.Effect<OrchestrationCompactResult, ManualThreadCompactionError> =>
    Effect.gen(function* () {
      const existing = yield* receipts.getByCommandId(commandId);
      if (Option.isSome(existing)) {
        return yield* replayReceipt(existing.value, commandId, request.threadId, traceId);
      }
      if ((yield* readCommandEvents(commandId)).length > 0) return yield* recoveryRequired(traceId);
      return yield* observeNewRequest(request, commandId, traceId);
    });

  const compact: ManualThreadCompactionShape["compact"] = (sessionId, request) =>
    Effect.gen(function* () {
      const commandId = compactCommandId(sessionId, request.idempotencyKey);
      const traceId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const registered = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = jobs.get(commandId);
          if (existing !== undefined) return { job: existing, owner: false } as const;
          const completion =
            yield* Deferred.make<
              Exit.Exit<OrchestrationCompactResult, ManualThreadCompactionError>
            >();
          const job: CompactJob = { threadId: request.threadId, sessionId, completion };
          jobs.set(commandId, job);
          const worker = Effect.interruptible(
            Effect.exit(process(request, commandId, traceId)).pipe(
              Effect.tap((exit) => Deferred.succeed(completion, exit)),
              Effect.ensuring(
                Effect.sync(() => {
                  if (jobs.get(commandId) === job) jobs.delete(commandId);
                }),
              ),
            ),
          );
          const forked = yield* Effect.exit(Effect.forkIn(worker, jobScope));
          if (Exit.isFailure(forked)) {
            jobs.delete(commandId);
            return yield* recoveryRequired(traceId);
          }
          return { job, owner: true } as const;
        }),
      );

      if (registered.job.threadId !== request.threadId || registered.job.sessionId !== sessionId) {
        return yield* new ManualCompactionInvalidRequestError({
          message: "The compaction idempotency key is already bound to another thread or session.",
        });
      }
      const exit = yield* Deferred.await(registered.job.completion);
      const result = registered.owner
        ? exit
        : Exit.map(exit, (value) => ({ ...value, replayed: true }));
      return yield* Exit.match(result, {
        onFailure: Effect.failCause,
        onSuccess: Effect.succeed,
      });
    });

  return { compact } satisfies ManualThreadCompactionShape;
});

export const ManualThreadCompactionLive = Layer.effect(
  ManualThreadCompaction,
  makeManualThreadCompaction,
);
