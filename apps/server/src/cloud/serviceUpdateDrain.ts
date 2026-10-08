/** Native orchestration quiescence for the protected service update handoff. */
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as ServiceUpdateAdmission from "../orchestration-v2/ServiceUpdateAdmission.ts";
import { markQueuedRunsForUpdate } from "../orchestration-v2/ServiceUpdateQueuedRuns.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import {
  ServiceUpdateDrain,
  ServiceUpdateOperationError,
  type ServiceUpdateDrainLease,
  type ServiceUpdateDrainObservation,
} from "./serviceUpdateServices.ts";

interface OutboxDrainRow {
  readonly effect_id: string;
  readonly effect_type: string;
  readonly status: "pending" | "running";
  readonly lease_owner: string | null;
}

const serviceUpdateOperationError = (code: ServiceUpdateOperationError["code"], cause: unknown) =>
  new ServiceUpdateOperationError({ stage: "drain", code, cause });

export const ServiceUpdateDrainLive = Layer.effect(
  ServiceUpdateDrain,
  Effect.gen(function* () {
    const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
    const eventSink = yield* EventSink.EventSinkV2;
    const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const runs = yield* RunExecutionService.RunExecutionServiceV2;
    const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const preparations = yield* ThreadLaunchService.ThreadLaunchService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sql = yield* SqlClient.SqlClient;

    const readRows = () =>
      sql<OutboxDrainRow>`
        SELECT effect_id, effect_type, status, lease_owner
        FROM orchestration_v2_effect_outbox
        WHERE status IN ('pending', 'running')
      `.pipe(Effect.mapError((cause) => serviceUpdateOperationError("io", cause)));

    const readSnapshot = (input: {
      readonly worker: EffectWorker.EffectWorkerObservation;
      readonly runs: RunExecutionService.RunExecutionObservation;
      readonly sessions: ProviderSessionManager.ProviderSessionObservation;
      readonly preparations: ThreadLaunchService.ThreadLaunchPreparationObservation;
    }): Effect.Effect<ServiceUpdateDrainObservation, ServiceUpdateOperationError> =>
      Effect.gen(function* () {
        const rows = yield* readRows();
        const pending = rows.filter((row) => row.status === "pending");
        const running = rows.filter((row) => row.status === "running");
        const activeEffectIds = new Set(
          input.worker.active.flatMap((activity) =>
            activity.effectId === null ? [] : [activity.effectId],
          ),
        );
        const activeWorkerIds = new Set(input.worker.active.map((activity) => activity.workerId));
        const unresolvedClaims = running.filter(
          (row) =>
            !activeEffectIds.has(row.effect_id) &&
            (row.lease_owner === null || !activeWorkerIds.has(row.lease_owner)),
        ).length;
        if (unresolvedClaims > 0) {
          return yield* Effect.fail(
            serviceUpdateOperationError(
              "unavailable",
              new Error("A running orchestration effect has no active worker owner."),
            ),
          );
        }

        const providerSessionIds = new Set(
          input.sessions.active.map((activity) => activity.providerSessionId),
        );
        const openingSessions = input.sessions.active.filter(
          (activity) => activity.kind === "opening",
        ).length;
        return {
          activeTurns: providerSessionIds.size,
          startingOperations:
            input.runs.active.length + openingSessions + input.preparations.active.length,
          queued: pending.length,
          claimed: running.length,
          unresolvedClaims,
        };
      });

    const isQuiescent = (
      observation: ServiceUpdateDrainObservation,
      input: {
        readonly worker: EffectWorker.EffectWorkerObservation;
        readonly runs: RunExecutionService.RunExecutionObservation;
        readonly sessions: ProviderSessionManager.ProviderSessionObservation;
        readonly preparations: ThreadLaunchService.ThreadLaunchPreparationObservation;
      },
      rows: ReadonlyArray<OutboxDrainRow>,
    ) =>
      observation.unresolvedClaims === 0 &&
      input.worker.active.length === 0 &&
      input.runs.active.length === 0 &&
      input.sessions.active.length === 0 &&
      input.preparations.active.length === 0 &&
      rows.length === 0;

    const observeCurrent = () =>
      Effect.scoped(
        Effect.gen(function* () {
          const workerObservation = yield* worker.observeActive;
          const runObservation = yield* runs.observeActive;
          const sessionObservation = yield* sessions.observeActive;
          const preparationObservation = yield* preparations.observePreparations;
          return yield* readSnapshot({
            worker: workerObservation,
            runs: runObservation,
            sessions: sessionObservation,
            preparations: preparationObservation,
          });
        }),
      );

    const waitForObservation = () =>
      Effect.scoped(
        Effect.gen(function* () {
          const workerObservation = yield* worker.observeActive;
          const runObservation = yield* runs.observeActive;
          const sessionObservation = yield* sessions.observeActive;
          const preparationObservation = yield* preparations.observePreparations;
          const sequence = yield* eventSink
            .latestSequence()
            .pipe(Effect.mapError((cause) => serviceUpdateOperationError("io", cause)));
          const workerWake = yield* Effect.forkChild(Stream.runHead(workerObservation.changes));
          const runWake = yield* Effect.forkChild(Stream.runHead(runObservation.changes));
          const sessionWake = yield* Effect.forkChild(Stream.runHead(sessionObservation.changes));
          const preparationWake = yield* Effect.forkChild(
            Stream.runHead(preparationObservation.changes),
          );
          const eventWake = yield* Effect.forkChild(
            Stream.runHead(
              eventSink
                .stream({ afterSequence: sequence })
                .pipe(Stream.mapError((cause) => serviceUpdateOperationError("io", cause))),
            ),
          );
          const outboxWake = yield* Effect.forkChild(effectOutbox.awaitAvailable);
          const stopWaiters = Effect.all(
            [
              Fiber.interrupt(workerWake),
              Fiber.interrupt(runWake),
              Fiber.interrupt(sessionWake),
              Fiber.interrupt(preparationWake),
              Fiber.interrupt(eventWake),
              Fiber.interrupt(outboxWake),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.asVoid);
          return yield* Effect.ensuring(
            Effect.gen(function* () {
              const snapshot = yield* readSnapshot({
                worker: workerObservation,
                runs: runObservation,
                sessions: sessionObservation,
                preparations: preparationObservation,
              });
              const rows = yield* readRows();
              const observations = {
                worker: workerObservation,
                runs: runObservation,
                sessions: sessionObservation,
                preparations: preparationObservation,
              };
              if (isQuiescent(snapshot, observations, rows)) return snapshot;
              yield* Effect.raceFirst(
                Fiber.join(workerWake),
                Effect.raceFirst(
                  Fiber.join(runWake),
                  Effect.raceFirst(
                    Fiber.join(sessionWake),
                    Effect.raceFirst(
                      Fiber.join(preparationWake),
                      Effect.raceFirst(Fiber.join(eventWake), Fiber.join(outboxWake)),
                    ),
                  ),
                ),
              );
              return snapshot;
            }),
            stopWaiters,
          );
        }),
      );

    const makeObservations = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const workerObservation = yield* worker.observeActive;
          const runObservation = yield* runs.observeActive;
          const sessionObservation = yield* sessions.observeActive;
          const preparationObservation = yield* preparations.observePreparations;
          const sequence = yield* eventSink
            .latestSequence()
            .pipe(Effect.mapError((cause) => serviceUpdateOperationError("io", cause)));
          const changes = Stream.merge(
            workerObservation.changes,
            Stream.merge(
              runObservation.changes,
              Stream.merge(
                sessionObservation.changes,
                Stream.merge(
                  preparationObservation.changes,
                  Stream.merge(
                    eventSink.stream({ afterSequence: sequence }).pipe(
                      Stream.map(() => undefined),
                      Stream.mapError((cause) => serviceUpdateOperationError("io", cause)),
                    ),
                    Stream.fromEffectRepeat(effectOutbox.awaitAvailable),
                  ),
                ),
              ),
            ),
          );
          const initial = yield* readSnapshot({
            worker: workerObservation,
            runs: runObservation,
            sessions: sessionObservation,
            preparations: preparationObservation,
          });
          return Stream.concat(
            Stream.succeed(initial),
            Stream.mapEffect(changes, () => observeCurrent()),
          );
        }),
      );

    const acquire: ServiceUpdateDrain["Service"]["acquire"] = Effect.gen(function* () {
      const cancel = Effect.gen(function* () {
        yield* admission.setState("open");
        yield* orchestrator.resumeQueuedRuns;
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof ServiceUpdateOperationError
            ? cause
            : serviceUpdateOperationError("io", cause),
        ),
      );

      const withQuiescence: ServiceUpdateDrainLease["withQuiescence"] = (use) =>
        Effect.gen(function* () {
          while (true) {
            yield* waitForObservation();
            const check = yield* admission.withExclusive((current, setAdmissionState) =>
              Effect.scoped(
                Effect.gen(function* () {
                  if (current !== "draining") {
                    return yield* Effect.fail(
                      serviceUpdateOperationError(
                        "unavailable",
                        new Error("The service update admission cut changed before handoff."),
                      ),
                    );
                  }
                  const workerObservation = yield* worker.observeActive;
                  const runObservation = yield* runs.observeActive;
                  const sessionObservation = yield* sessions.observeActive;
                  const preparationObservation = yield* preparations.observePreparations;
                  const observations = {
                    worker: workerObservation,
                    runs: runObservation,
                    sessions: sessionObservation,
                    preparations: preparationObservation,
                  };
                  const snapshot = yield* readSnapshot(observations);
                  const rows = yield* readRows();
                  if (!isQuiescent(snapshot, observations, rows)) {
                    return { _tag: "retry" as const };
                  }
                  return {
                    _tag: "done" as const,
                    value: yield* use(setAdmissionState),
                  };
                }),
              ),
            );
            if (check._tag === "done") return check.value;
          }
        });

      const lease = {
        observations: makeObservations(),
        cancel,
        withQuiescence,
      } satisfies ServiceUpdateDrainLease;

      yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let ownsDraining = false;
          const acquisition = yield* Effect.exit(
            restore(
              admission.withExclusive((current, setAdmissionState) =>
                Effect.uninterruptibleMask((restoreMarkerWrite) =>
                  Effect.gen(function* () {
                    if (current !== "open") {
                      return yield* Effect.fail(
                        serviceUpdateOperationError(
                          "unavailable",
                          new Error("The service update admission gate is already closed."),
                        ),
                      );
                    }
                    yield* setAdmissionState("draining");
                    ownsDraining = true;
                    yield* restoreMarkerWrite(markQueuedRunsForUpdate(sql));
                  }),
                ),
              ),
            ),
          );
          if (Exit.isSuccess(acquisition)) return acquisition.value;
          if (!ownsDraining) return yield* Effect.failCause(acquisition.cause);

          const reopen = yield* Effect.exit(
            admission.withExclusive((current, setAdmissionState) =>
              current === "draining"
                ? setAdmissionState("open").pipe(Effect.as(true))
                : Effect.succeed(current === "open"),
            ),
          );
          if (Exit.isFailure(reopen)) {
            return yield* Effect.failCause(Cause.combine(acquisition.cause, reopen.cause));
          }
          if (reopen.value) {
            const resume = yield* Effect.exit(orchestrator.resumeQueuedRuns);
            if (Exit.isFailure(resume)) {
              return yield* Effect.failCause(Cause.combine(acquisition.cause, resume.cause));
            }
          }
          return yield* Effect.failCause(acquisition.cause);
        }),
      );

      return lease;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof ServiceUpdateOperationError
          ? cause
          : serviceUpdateOperationError("io", cause),
      ),
    );

    return ServiceUpdateDrain.of({ acquire });
  }),
);
