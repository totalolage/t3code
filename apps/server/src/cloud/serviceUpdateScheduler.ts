// @effect-diagnostics nodeBuiltinImport:off
/**
 * ServiceUpdateScheduler - the cancellable server-authoritative update cycle.
 *
 * Cycle: poll (release check) → stage (artifact) → wait-drain (native queue
 * diversion + all-work quiescence) → activate (stable launcher adoption).
 *
 * Cancellation is deterministic. Cancellation and the commit transition are
 * serialized through ONE per-attempt gate decision (`open` → `cancelled` or
 * `open` → `committing`); an accepted cancellation wakes the attempt through
 * a Deferred and is honored immediately before every irreversible side
 * effect (drain entry, adoption, commit/handoff). Once the gate has claimed
 * the commit the attempt is no longer cancellable, and a cancelled response
 * can never be followed by a handoff.
 *
 * The launcher owns writer shutdown, no-escape proof, database backup, trial,
 * and recovery. This scheduler only drains work, adopts the immutable runtime,
 * and reports launcher acceptance; it never quiesces its own writer.
 *
 * @module ServiceUpdateScheduler
 */
import {
  MessageId,
  ServiceUpdateAttemptId,
  ServiceUpdateVersion,
  ServerSelfUpdateError,
  ThreadId,
  type ServiceUpdateState as PublicServiceUpdateState,
  type ServerSelfUpdateProgressStage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as SqlClient from "effect/sql/SqlClient";
import { forkParked } from "../serverActivation.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ServiceUpdateDrain,
  ServiceUpdateError,
  ServiceUpdateOperationError,
  type ServiceUpdateDrainLease,
  ServiceUpdateRuntime,
  ServiceUpdateSource,
  StagedServiceRuntime,
  UpdateAuthority,
  UpdateAuthorityError,
  type UpdateAuthorityLease,
} from "./serviceUpdateServices.ts";

const decodeAttemptId = Schema.decodeSync(ServiceUpdateAttemptId);
const isServerSelfUpdateError = Schema.is(ServerSelfUpdateError);

export class ServiceUpdateAttemptBusyError extends Schema.TaggedError<ServiceUpdateAttemptBusyError>()(
  "ServiceUpdateAttemptBusyError",
  {},
) {}

type CycleError = ServiceUpdateError | ServiceUpdateAttemptBusyError | UpdateAuthorityError;

interface ManualServiceUpdateRequest {
  readonly targetVersion: string;
  readonly reportProgress: (
    stage: ServerSelfUpdateProgressStage,
  ) => Effect.Effect<void, ServerSelfUpdateError>;
  readonly onHandoffAccepted: () => Effect.Effect<void>;
}

type ServiceUpdateAttemptInput =
  | { readonly currentVersion: string }
  | { readonly manual: ManualServiceUpdateRequest };

interface ManualServiceUpdateResult {
  readonly targetVersion: string;
  readonly updateId: string;
}

/** Internal sentinel: the attempt's gate decided `cancelled` before commit. */
class ServiceUpdateCancelled {
  readonly _tag = "ServiceUpdateCancelled" as const;
}

/** The single serialization point between cancellation and the commit. */
type AttemptGate = "open" | "cancelled" | "committing" | "finished";

interface AttemptHandle {
  readonly gate: Ref.Ref<AttemptGate>;
  /** Completes the moment cancellation is accepted; wakes unbounded waits. */
  readonly wake: Deferred.Deferred<void>;
  /** Completes after a checking request and its abort finalizers have settled. */
  readonly checkSettled: Deferred.Deferred<void>;
}

interface DrainCounts {
  readonly queued: number;
  readonly claimed: number;
  readonly activeTurns: number;
  readonly startingOperations: number;
}

interface QueuedTurnRow {
  readonly thread_id: string;
  readonly message_id: string;
}

interface QueuedTurn {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}

const sameQueuedTurns = (
  left: ReadonlyArray<QueuedTurn>,
  right: ReadonlyArray<QueuedTurn>,
): boolean =>
  left.length === right.length &&
  left.every(
    (turn, index) =>
      turn.threadId === right[index]?.threadId && turn.messageId === right[index]?.messageId,
  );

export interface ServiceUpdateSchedulerShape {
  /** Run the scheduled newest-release cycle or one exact manual release update. */
  readonly beginAttempt: (
    input: ServiceUpdateAttemptInput,
  ) => Effect.Effect<void | ManualServiceUpdateResult, CycleError | ServerSelfUpdateError>;

  /**
   * Fork the production periodic trigger (`forkParked` +
   * `Effect.repeat(Schedule.spaced("15 minutes"))`). The job calls
   * `beginAttempt` when a `serviceUpdateRepository` is configured and idles
   * otherwise. `forkParked` blocks on `ServerActivation` so a launcher trial
   * cannot fire while the previous server is torn down.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Best-effort public cancellation of the current pre-commit attempt. */
  readonly cancelCurrent: () => Effect.Effect<{ readonly cancelled: boolean }>;
}

export class ServiceUpdateScheduler extends Context.Service<
  ServiceUpdateScheduler,
  ServiceUpdateSchedulerShape
>()("t3/cloud/serviceUpdateScheduler") {}

const CYCLE_ERROR_TAGS: ReadonlySet<string> = new Set([
  "ServiceUpdateError",
  "ServiceUpdateAttemptBusyError",
  "UpdateAuthorityError",
]);

const toCycleError = (error: unknown): CycleError =>
  error !== null &&
  typeof error === "object" &&
  "_tag" in error &&
  CYCLE_ERROR_TAGS.has((error as { readonly _tag: string })._tag)
    ? (error as CycleError)
    : toWireError("runtime", error);

const toWireError = (stage: ServiceUpdateError["stage"], error: unknown): ServiceUpdateError =>
  new ServiceUpdateError({
    stage,
    code: "operation-failed",
    detail: error instanceof Error ? error.message.slice(0, 512) : "update operation failed",
  });

const toHandoffWireError = (error: unknown): ServiceUpdateError => {
  if (
    error instanceof ServiceUpdateOperationError &&
    (error.code === "rejected-before-acceptance" || error.code === "acceptance-unknown")
  ) {
    return new ServiceUpdateError({
      stage: "authority",
      code: error.code,
      detail:
        error.code === "rejected-before-acceptance"
          ? "The service launcher rejected the update before acceptance."
          : "The service launcher did not confirm update acceptance.",
    });
  }
  return toWireError("authority", error);
};

export const ServiceUpdateSchedulerLive = Layer.effect(
  ServiceUpdateScheduler,
  Effect.gen(function* () {
    const source = yield* ServiceUpdateSource;
    const runtime = yield* ServiceUpdateRuntime;
    const drainService = yield* ServiceUpdateDrain;
    const sql = yield* SqlClient.SqlClient;
    const authority = yield* UpdateAuthority;
    const settings = yield* ServerSettingsService;
    const crypto = yield* Crypto.Crypto;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;

    const currentAttempt = yield* Ref.make<AttemptHandle | null>(null);
    const retainedAuthorityLease = yield* Ref.make<UpdateAuthorityLease | null>(null);
    const lifecycleStartedAt = yield* Ref.make<string | null>(null);

    const queueCounts = sql<{ readonly queued: number; readonly claimed: number }>`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS queued,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS claimed
      FROM orchestration_v2_effect_outbox
      WHERE status IN ('pending', 'running')
    `.pipe(
      Effect.map((rows) => ({ queued: rows[0]?.queued ?? 0, claimed: rows[0]?.claimed ?? 0 })),
      Effect.orDie,
    );

    const readQueuedTurns = sql<QueuedTurnRow>`
      SELECT
        run.thread_id,
        json_extract(run.payload_json, '$.userMessageId') AS message_id
      FROM orchestration_v2_projection_runs AS run
      WHERE run.status = 'queued'
        AND json_type(run.payload_json, '$.userMessageId') = 'text'
        AND json_extract(run.payload_json, '$.purpose') IS NOT 'compaction'
      ORDER BY run.accepted_sequence, run.ordinal, run.thread_id
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          threadId: ThreadId.make(row.thread_id),
          messageId: MessageId.make(row.message_id),
        })),
      ),
      Effect.orDie,
    );

    const publishIdle = () =>
      Effect.gen(function* () {
        yield* Ref.set(lifecycleStartedAt, null);
        yield* lifecycleEvents.publish({
          version: 1,
          type: "serviceUpdate",
          payload: { status: "idle" },
        });
      }).pipe(Effect.asVoid);

    const publishActive = (
      status: "draining" | "activating",
      targetVersion: string,
      counts: DrainCounts,
      queuedTurns?: ReadonlyArray<QueuedTurn>,
    ) =>
      Effect.gen(function* () {
        let startedAt = yield* Ref.get(lifecycleStartedAt);
        if (startedAt === null) {
          startedAt = DateTime.formatIso(yield* DateTime.now);
          yield* Ref.set(lifecycleStartedAt, startedAt);
        }
        const currentQueuedTurns = queuedTurns ?? (yield* readQueuedTurns);
        const payload: PublicServiceUpdateState =
          status === "draining"
            ? {
                status,
                targetVersion: ServiceUpdateVersion.make(targetVersion),
                activeTurnCount: counts.activeTurns,
                queuedTurnCount: currentQueuedTurns.length,
                queuedTurns: currentQueuedTurns,
                startedAt,
              }
            : {
                status,
                targetVersion: ServiceUpdateVersion.make(targetVersion),
                queuedTurnCount: currentQueuedTurns.length,
                queuedTurns: currentQueuedTurns,
                startedAt,
              };
        yield* lifecycleEvents.publish({ version: 1, type: "serviceUpdate", payload });
      }).pipe(Effect.asVoid);

    const cancelCurrent = () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(currentAttempt);
        if (current === null) return { cancelled: false };
        const accepted = yield* Ref.modify(current.gate, (gate): readonly [boolean, AttemptGate] =>
          gate === "open" ? [true, "cancelled"] : [false, gate],
        );
        if (!accepted) return { cancelled: false };
        // Wake the attempt deterministically out of any unbounded wait.
        yield* Deferred.succeed(current.wake, undefined);
        yield* publishIdle();
        // The request's abort finalizers settle before the cancellation
        // response, rather than leaving source.check live in the background.
        yield* Deferred.await(current.checkSettled);
        return { cancelled: true };
      });

    const service: ServiceUpdateSchedulerShape = {
      cancelCurrent,

      beginAttempt: (input) =>
        Effect.gen(function* () {
          const isManual = "manual" in input;
          const currentVersion = isManual ? packageJson.version : input.currentVersion;
          const attemptId = decodeAttemptId(yield* crypto.randomUUIDv4);
          const repository = (yield* settings.getSettings.pipe(
            Effect.mapError((error) => toWireError("settings", error)),
          )).serviceUpdateRepository;
          const availability = yield* Effect.mapError(runtime.availability, (error) =>
            toWireError("runtime", error),
          );
          if (availability.status === "unsupported") {
            yield* publishIdle();
            if (isManual) {
              return yield* new ServiceUpdateError({
                stage: "runtime",
                code: "unsupported",
                detail: `Service updates are unavailable on this runtime (${availability.reason}).`,
              });
            }
            return;
          }

          if (isManual && input.manual.targetVersion === currentVersion) {
            return yield* new ServiceUpdateError({
              stage: "source",
              code: "invalid-input",
              detail: "The requested F8Y version is already running.",
            });
          }

          const reserved = yield* authority.reserve(
            isManual ? { owner: "manual", attemptId } : { owner: "scheduled", attemptId },
          );
          if (reserved._tag === "busy") {
            return yield* new ServiceUpdateAttemptBusyError();
          }
          const lease: UpdateAuthorityLease = reserved.lease;

          const gate = yield* Ref.make<AttemptGate>("open");
          const wake = yield* Deferred.make<void>();
          const checkSettled = yield* Deferred.make<void>();
          const handle: AttemptHandle = { gate, wake, checkSettled };
          yield* Ref.set(currentAttempt, handle);

          const cancelledSentinel = new ServiceUpdateCancelled();
          const cancelWake: Effect.Effect<never, ServiceUpdateCancelled> = Effect.flatMap(
            Deferred.await(wake),
            () => Effect.fail(cancelledSentinel),
          );
          // Honored immediately before every irreversible side effect.
          const ensureLive: Effect.Effect<void, ServiceUpdateCancelled> = Effect.flatMap(
            Ref.get(gate),
            (gateState) =>
              gateState === "cancelled" ? Effect.fail(cancelledSentinel) : Effect.void,
          );
          // The commit decision itself: serialized against cancellation
          // through the same gate. Losing the race here means the attempt
          // was cancelled — never commit, never handoff.
          const claimCommit: Effect.Effect<void, ServiceUpdateCancelled> = Effect.flatMap(
            Ref.modify(gate, (gateState) =>
              gateState === "open" ? [true, "committing" as const] : [false, gateState],
            ),
            (claimed) => (claimed ? Effect.void : Effect.fail(cancelledSentinel)),
          );

          let ownedStage: StagedServiceRuntime | undefined;
          let drainLease: ServiceUpdateDrainLease | undefined;
          let sourceCleanupFailure: ServiceUpdateError | undefined;
          let sourceStageFailure: ServiceUpdateError | undefined;
          let handoffNotSent: ServiceUpdateError | undefined;
          let handoffRejection: ServiceUpdateError | undefined;
          let cleanupRetentionRecorded = false;
          let handoffAccepted = false;
          let committed = false;
          let handoffStatusCounts: DrainCounts | undefined;
          let attemptTargetVersion: string | undefined;
          const discardOwnedStage = () =>
            Effect.suspend(() => {
              const staged = ownedStage;
              if (staged === undefined) return Effect.void;
              ownedStage = undefined;
              return source.discard(staged).pipe(
                Effect.mapError((error) => {
                  const wire = toWireError("source", error);
                  sourceCleanupFailure = wire;
                  return wire;
                }),
              );
            });

          // Abort paths that run before the commit point. After commit the
          // lease is irreversible: only containment-gated rollback applies.
          const abortBeforeCommit = () =>
            Effect.gen(function* () {
              yield* Ref.set(currentAttempt, null);
              yield* publishIdle();
            });

          const resumeUncommittedUpdate = () =>
            drainLease === undefined ? Effect.void : drainLease.cancel;

          const retainAfterCleanupFailure = (cause: unknown) =>
            Effect.gen(function* () {
              cleanupRetentionRecorded = true;
              yield* Ref.set(retainedAuthorityLease, lease);
              yield* Ref.set(currentAttempt, null);
              return yield* Effect.fail(toWireError("drain", cause));
            });

          const releaseUncommittedAuthority = () =>
            Effect.gen(function* () {
              const resumeExit = yield* Effect.exit(resumeUncommittedUpdate());
              if (Exit.isFailure(resumeExit)) {
                return yield* retainAfterCleanupFailure(Cause.squash(resumeExit.cause));
              }
              const releaseExit = yield* Effect.exit(lease.release);
              if (Exit.isFailure(releaseExit)) {
                return yield* retainAfterCleanupFailure(Cause.squash(releaseExit.cause));
              }
              yield* abortBeforeCommit();
            });

          const recordAcceptedHandoff = (accepted: {
            readonly updateId: string;
            readonly targetVersion: string;
          }) =>
            Effect.gen(function* () {
              const manualResult = isManual
                ? { targetVersion: accepted.targetVersion, updateId: accepted.updateId }
                : undefined;
              if (isManual) yield* input.manual.onHandoffAccepted();
              yield* publishActive(
                "activating",
                accepted.targetVersion,
                handoffStatusCounts ?? {
                  queued: 0,
                  claimed: 0,
                  activeTurns: 0,
                  startingOperations: 0,
                },
              );
              return manualResult;
            });

          const attempt = Effect.gen(function* () {
            const candidate = yield* Effect.raceFirst(
              Effect.gen(function* () {
                yield* ensureLive;
                if (isManual) yield* input.manual.reportProgress("downloading");
                return yield* (
                  isManual
                    ? source.resolveTargetVersion({
                        repository,
                        targetVersion: input.manual.targetVersion,
                      })
                    : source.check({ repository, currentVersion })
                ).pipe(Effect.mapError((error) => toWireError("source", error)));
              }).pipe(Effect.ensuring(Effect.asVoid(Deferred.succeed(checkSettled, undefined)))),
              cancelWake,
            );
            yield* ensureLive;
            if (candidate === null) {
              if (isManual) {
                return yield* new ServiceUpdateError({
                  stage: "source",
                  code: "operation-failed",
                  detail: "The requested F8Y release is unavailable.",
                });
              }
              const finished = yield* Ref.modify(gate, (gateState) =>
                gateState === "open" ? [true, "finished" as const] : [false, gateState],
              );
              if (!finished) return yield* Effect.fail(cancelledSentinel);

              yield* lease.release;
              yield* Ref.set(currentAttempt, null);
              yield* publishIdle();
              return;
            }
            attemptTargetVersion = candidate.version;
            // The staged artifact remains private until the runtime handoff.
            const staged: StagedServiceRuntime = yield* Effect.raceFirst(
              source
                .stage({ attemptId, candidate }, () => Effect.void)
                .pipe(
                  Effect.mapError((error) => {
                    const wire = toWireError("source", error);
                    if (error.cleanupFailure) sourceCleanupFailure = wire;
                    else sourceStageFailure = wire;
                    return wire;
                  }),
                ),
              cancelWake,
            );
            ownedStage = staged;

            if (isManual) yield* input.manual.reportProgress("installing");

            yield* ensureLive;
            const capturedSource = yield* runtime
              .captureSource({ fromVersion: ServiceUpdateVersion.make(currentVersion) })
              .pipe(Effect.mapError((error) => toWireError("runtime", error)));
            yield* ensureLive;

            const activeDrainLease = yield* Effect.uninterruptibleMask((restoreAcquire) =>
              restoreAcquire(
                drainService.acquire.pipe(Effect.mapError((error) => toWireError("drain", error))),
              ).pipe(
                Effect.tap((lease) =>
                  Effect.sync(() => {
                    drainLease = lease;
                  }),
                ),
              ),
            );
            const initialQueuedTurns = yield* readQueuedTurns;
            yield* publishActive(
              "draining",
              staged.version,
              {
                queued: 0,
                claimed: 0,
                activeTurns: 0,
                startingOperations: 0,
              },
              initialQueuedTurns,
            );
            // Drain counts can stay flat while a native queued run appears, so
            // compare the projected queue on every event-driven observation.
            const lastCounts = yield* Ref.make<DrainCounts | null>(null);
            const lastQueuedTurns = yield* Ref.make(initialQueuedTurns);
            const countObserver = Stream.runForEach(
              Stream.mapEffect(activeDrainLease.observations, (observation) => {
                const next: DrainCounts = {
                  queued: observation.queued,
                  claimed: observation.claimed,
                  activeTurns: observation.activeTurns,
                  startingOperations: observation.startingOperations,
                };
                return Effect.gen(function* () {
                  const previous = yield* Ref.get(lastCounts);
                  const previousQueuedTurns = yield* Ref.get(lastQueuedTurns);
                  const queuedTurns = yield* readQueuedTurns;
                  const changed =
                    previous === null ||
                    previous.queued !== next.queued ||
                    previous.claimed !== next.claimed ||
                    previous.activeTurns !== next.activeTurns ||
                    previous.startingOperations !== next.startingOperations ||
                    !sameQueuedTurns(previousQueuedTurns, queuedTurns);
                  if (!changed) {
                    return;
                  }
                  yield* Ref.set(lastCounts, next);
                  yield* Ref.set(lastQueuedTurns, queuedTurns);
                  yield* publishActive("draining", staged.version, next, queuedTurns);
                });
              }),
              () => Effect.void,
            );
            const observerFiber = yield* Effect.forkChild(Effect.ignore(countObserver));

            return yield* Effect.uninterruptibleMask((restoreWait) =>
              Effect.gen(function* () {
                // Drain once before adoption to preserve the cancellable
                // stage → quiescence → adoption ordering. This pass releases
                // the admission cut without publishing intent; the final pass
                // below rechecks after all fallible preparation.
                yield* restoreWait(
                  Effect.raceFirst(
                    activeDrainLease
                      .withQuiescence(() => Effect.void)
                      .pipe(Effect.mapError((error) => toWireError("drain", error))),
                    cancelWake,
                  ),
                );
                yield* ensureLive;
                yield* restoreWait(
                  Effect.raceFirst(
                    runtime
                      .adopt(staged)
                      .pipe(Effect.mapError((error) => toWireError("runtime", error))),
                    cancelWake,
                  ),
                );
                yield* discardOwnedStage();
                const counts = yield* restoreWait(Effect.raceFirst(queueCounts, cancelWake));
                handoffStatusCounts = {
                  ...counts,
                  activeTurns: 0,
                  startingOperations: 0,
                };
                const outcome = yield* restoreWait(
                  Effect.raceFirst(
                    activeDrainLease
                      .withQuiescence((setAdmissionState) =>
                        Effect.uninterruptibleMask((restoreCommit) =>
                          Effect.gen(function* () {
                            yield* restoreCommit(
                              publishActive(
                                "activating",
                                staged.version,
                                handoffStatusCounts ?? {
                                  queued: 0,
                                  claimed: 0,
                                  activeTurns: 0,
                                  startingOperations: 0,
                                },
                              ),
                            );
                            yield* restoreCommit(claimCommit);
                            committed = true;
                            const irreversible = yield* Effect.exit(lease.enterIrreversible);
                            if (Exit.isFailure(irreversible)) {
                              const authorityFailure = Cause.findErrorOption(irreversible.cause);
                              if (
                                Option.isNone(authorityFailure) ||
                                !(authorityFailure.value instanceof UpdateAuthorityError)
                              ) {
                                return yield* Effect.failCause(irreversible.cause);
                              }
                              handoffNotSent = toWireError("authority", authorityFailure.value);
                              return {
                                _tag: "not-sent" as const,
                                error: handoffNotSent,
                              };
                            }
                            yield* setAdmissionState("sealed");

                            const requestExit = yield* Effect.exit(
                              runtime.requestHandoff({
                                targetVersion: ServiceUpdateVersion.make(staged.version),
                                source: capturedSource,
                                authorityLease: lease,
                              }),
                            );
                            if (Exit.isFailure(requestExit)) {
                              const failure = Cause.squash(requestExit.cause);
                              const error =
                                failure instanceof ServiceUpdateOperationError
                                  ? toHandoffWireError(failure)
                                  : toWireError("authority", failure);
                              if (
                                failure instanceof ServiceUpdateOperationError &&
                                (failure.code === "rejected-before-acceptance" ||
                                  failure.code === "unavailable")
                              ) {
                                handoffRejection = error;
                                return { _tag: "rejected" as const, error };
                              }
                              return { _tag: "unknown" as const, error };
                            }

                            const accepted = requestExit.value;
                            handoffAccepted = true;
                            yield* Ref.set(retainedAuthorityLease, lease);
                            return {
                              _tag: "accepted" as const,
                              value: yield* recordAcceptedHandoff({
                                updateId: accepted.updateId,
                                targetVersion: staged.version,
                              }),
                            };
                          }),
                        ),
                      )
                      .pipe(
                        Effect.mapError((error) =>
                          error instanceof ServiceUpdateCancelled
                            ? error
                            : toWireError("drain", error),
                        ),
                      ),
                    cancelWake,
                  ).pipe(Effect.ensuring(Effect.ignore(Fiber.interrupt(observerFiber)))),
                );

                if (outcome._tag === "accepted") return outcome.value;
                if (outcome._tag === "unknown") return yield* Effect.fail(outcome.error);

                if (outcome._tag === "not-sent") handoffNotSent = outcome.error;

                const resumeExit = yield* Effect.exit(activeDrainLease.cancel);
                if (Exit.isFailure(resumeExit)) {
                  return yield* retainAfterCleanupFailure(Cause.squash(resumeExit.cause));
                }
                const releaseExit = yield* Effect.exit(lease.release);
                if (Exit.isFailure(releaseExit)) {
                  return yield* retainAfterCleanupFailure(Cause.squash(releaseExit.cause));
                }
                committed = false;
                yield* Ref.set(retainedAuthorityLease, null);
                yield* publishIdle();
                return yield* Effect.fail(outcome.error);
              }),
            );
          }).pipe(Effect.ensuring(Effect.asVoid(Deferred.succeed(checkSettled, undefined))));

          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const exit = yield* restore(
                attempt.pipe(Effect.ensuring(Effect.ignore(discardOwnedStage()))),
              ).pipe(Effect.exit);
              if (sourceCleanupFailure !== undefined) {
                const cleanupError = sourceCleanupFailure;
                const resumeExit = yield* Effect.exit(resumeUncommittedUpdate());
                if (Exit.isFailure(resumeExit)) {
                  return yield* retainAfterCleanupFailure(Cause.squash(resumeExit.cause));
                }
                const releaseExit = yield* Effect.exit(lease.release);
                if (Exit.isFailure(releaseExit)) {
                  return yield* retainAfterCleanupFailure(Cause.squash(releaseExit.cause));
                }
                yield* Ref.set(currentAttempt, null);
                committed = false;
                yield* publishIdle();

                if (Exit.isFailure(exit)) {
                  const primaryFailure: unknown = Cause.squash(exit.cause);
                  const primaryTag =
                    typeof primaryFailure === "object" &&
                    primaryFailure !== null &&
                    "_tag" in primaryFailure
                      ? (primaryFailure as { readonly _tag: string })._tag
                      : undefined;
                  if (primaryFailure !== cleanupError) {
                    if (primaryTag === "ServiceUpdateCancelled") {
                      return yield* Effect.fail(
                        new ServiceUpdateError({
                          stage: "authority",
                          code: "operation-failed",
                          detail: "Update cancelled before completion.",
                        }),
                      );
                    }
                    if (isServerSelfUpdateError(primaryFailure)) {
                      return yield* Effect.fail(primaryFailure);
                    }
                    if (sourceStageFailure !== undefined) {
                      return yield* Effect.fail(sourceStageFailure);
                    }
                    return yield* Effect.fail(toCycleError(primaryFailure));
                  }
                }
                return yield* Effect.fail(cleanupError);
              }
              if (Exit.isSuccess(exit)) {
                yield* Ref.set(currentAttempt, null);
                return exit.value;
              }
              if (handoffAccepted && Cause.hasInterruptsOnly(exit.cause)) {
                // The caller may disconnect after launcher acceptance. Preserve the
                // accepted state and authority instead of turning that interruption
                // into a fictitious unknown handoff.
                yield* Ref.set(currentAttempt, null);
                return yield* Effect.failCause(exit.cause);
              }
              const failure: unknown = Cause.squash(exit.cause);
              const failureTag =
                typeof failure === "object" && failure !== null && "_tag" in failure
                  ? (failure as { readonly _tag: string })._tag
                  : undefined;
              if (failureTag === "ServiceUpdateCancelled") {
                // The gate rejected the commit, so no handoff can follow.
                const resumeExit = yield* Effect.exit(resumeUncommittedUpdate());
                if (Exit.isFailure(resumeExit)) {
                  return yield* retainAfterCleanupFailure(Cause.squash(resumeExit.cause));
                }
                const releaseExit = yield* Effect.exit(lease.release);
                if (Exit.isFailure(releaseExit)) {
                  return yield* retainAfterCleanupFailure(Cause.squash(releaseExit.cause));
                }
                committed = false;
                yield* Ref.set(retainedAuthorityLease, null);
                yield* Ref.set(currentAttempt, null);
                yield* publishIdle();
                return yield* Effect.fail(
                  new ServiceUpdateError({
                    stage: "authority",
                    code: "operation-failed",
                    detail: "Update cancelled before completion.",
                  }),
                );
              }
              if (failureTag === "ServiceUpdateAttemptBusyError") {
                const releaseExit = yield* Effect.exit(lease.release);
                if (Exit.isFailure(releaseExit)) {
                  return yield* retainAfterCleanupFailure(Cause.squash(releaseExit.cause));
                }
                return yield* Effect.fail(failure as ServiceUpdateAttemptBusyError);
              }

              const definiteNoHandoff = handoffNotSent ?? handoffRejection;
              if (definiteNoHandoff !== undefined) {
                if (committed) {
                  if (cleanupRetentionRecorded) {
                    yield* Ref.set(currentAttempt, null);
                    return yield* Effect.failCause(exit.cause);
                  }
                  // A disconnect can be delivered after a definite rejection
                  // but before withQuiescence returns it. The source did not
                  // hand off, so reopen admission and resume native queued runs
                  // before releasing the writer authority.
                  const resumeExit = yield* Effect.exit(resumeUncommittedUpdate());
                  if (Exit.isFailure(resumeExit)) {
                    return yield* retainAfterCleanupFailure(Cause.squash(resumeExit.cause));
                  }
                  const targetVersion = attemptTargetVersion;
                  if (targetVersion === undefined) {
                    return yield* retainAfterCleanupFailure(
                      new Error("The committed update has no captured target version."),
                    );
                  }
                  const releaseExit = yield* Effect.exit(lease.release);
                  if (Exit.isFailure(releaseExit)) {
                    return yield* retainAfterCleanupFailure(Cause.squash(releaseExit.cause));
                  }
                  yield* Ref.set(currentAttempt, null);
                  committed = false;
                  yield* Ref.set(retainedAuthorityLease, null);
                  yield* publishIdle();
                  return yield* Effect.failCause(exit.cause);
                }
                yield* Ref.set(currentAttempt, null);
                return yield* Effect.fail(definiteNoHandoff);
              }

              if (!committed) {
                // Pre-commit failure: end the drain, resolve native queued
                // starts, then release the writer authority.
                if (failureTag === "ServiceUpdateError") {
                  const wire = failure as ServiceUpdateError;
                  yield* releaseUncommittedAuthority();
                  return yield* Effect.fail(wire);
                }
                if (isServerSelfUpdateError(failure)) {
                  yield* releaseUncommittedAuthority();
                  return yield* Effect.fail(failure);
                }
                const wire = toWireError("runtime", failure);
                yield* releaseUncommittedAuthority();
                return yield* Effect.fail(wire);
              }

              yield* Ref.set(currentAttempt, null);
              const handoffTargetVersion = attemptTargetVersion;
              if (handoffTargetVersion === undefined) {
                return yield* retainAfterCleanupFailure(
                  new Error("The committed update has no captured target version."),
                );
              }

              if (handoffAccepted) {
                // The launcher accepted the handoff. A later status or caller
                // failure cannot turn that into an unknown handoff.
                return yield* Effect.fail(toCycleError(failure));
              }

              // The launcher owns the transition after request acceptance. This
              // process cannot infer whether it stopped, backed up, or restored.
              // Keep the local admission closed and report activating until this
              // process exits; the replacement process starts from a fresh idle
              // state and the native launcher owns recovery.
              yield* Ref.set(retainedAuthorityLease, lease);
              yield* publishActive(
                "activating",
                handoffTargetVersion,
                handoffStatusCounts ?? {
                  queued: 0,
                  claimed: 0,
                  activeTurns: 0,
                  startingOperations: 0,
                },
              );
              return yield* Effect.fail(failure as CycleError);
            }),
          );
        }).pipe(
          Effect.mapError((error) =>
            isServerSelfUpdateError(error) ? error : toCycleError(error),
          ),
        ),
      start: () =>
        forkParked(
          Effect.gen(function* () {
            const repository = yield* settings.getSettings.pipe(
              Effect.map((s) => s.serviceUpdateRepository),
              Effect.catch(() => Effect.succeed("")),
            );
            if (repository.trim() !== "") {
              yield* service.beginAttempt({ currentVersion: packageJson.version });
            }
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("scheduled service update check failed", { error }),
            ),
            Effect.repeat(Schedule.spaced("15 minutes")),
          ),
        ),
    };

    yield* lifecycleEvents.publish({
      version: 1,
      type: "serviceUpdate",
      payload: { status: "idle" },
    });

    // Production F09 trigger: beginAttempt actually fires on the schedule.
    yield* service.start();
    return ServiceUpdateScheduler.of(service);
  }),
);
