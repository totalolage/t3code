import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { ProviderSessionSupersededError } from "../Errors.ts";

const START_WAIT = "5 seconds";
const STOP_PERMIT_TIMEOUT_DETAIL =
  "Timed out waiting for the provider thread permit; stop ownership was released.";

export type ProviderSessionLease = {
  readonly threadId: ThreadId;
  readonly source: object;
  readonly isCurrent: () => boolean;
  readonly isStopping: () => boolean;
};

export type ProviderSessionStopTicket = {
  readonly threadId: ThreadId;
  readonly source?: object;
  readonly isCurrent: () => boolean;
};

export type ProviderSessionOperationToken = {
  readonly threadId: ThreadId;
  readonly source: object;
  readonly isCurrent: () => boolean;
};

type ProviderSessionStartInput<A, E, R> = {
  readonly threadId: ThreadId;
  readonly source: object;
  readonly isSourceActive: () => boolean;
  readonly operation: (lease: ProviderSessionLease) => Effect.Effect<A, E, R>;
  readonly cleanup: (lease: ProviderSessionLease) => Effect.Effect<void, unknown>;
};

export type ProviderSessionOperations = {
  readonly start: <A, E, R>(
    input: ProviderSessionStartInput<A, E, R>,
  ) => Effect.Effect<A, E | ProviderSessionSupersededError, R>;
  readonly beginStop: (threadId: ThreadId) => Effect.Effect<ProviderSessionStopTicket>;
  readonly settleStop: <E, R>(
    ticket: ProviderSessionStopTicket,
    input: {
      readonly succeeded: boolean;
      readonly isSourceCurrent: () => boolean;
      readonly commit: Effect.Effect<void, E, R>;
    },
  ) => Effect.Effect<void, E | ProviderSessionSupersededError, R>;
  readonly capture: (
    threadId: ThreadId,
    source: object,
  ) => Effect.Effect<ProviderSessionOperationToken>;
  readonly commitIfCurrent: <A, E, R>(
    token: ProviderSessionOperationToken,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E | ProviderSessionSupersededError, R>;
  readonly retireSource: (source: object) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly drainStarts: (source?: object) => Effect.Effect<void>;
  readonly isClosed: () => boolean;
  readonly startingSource: (threadId: ThreadId) => object | undefined;
};

type StartRecord = {
  readonly thread: ThreadState;
  readonly threadId: ThreadId;
  readonly source: object;
  readonly isSourceActive: () => boolean;
  readonly stopRevision: number;
  readonly sourceStopRevision: number;
  readonly completion: Deferred.Deferred<void>;
  generation: Generation | undefined;
  fiber: Fiber.Fiber<unknown, unknown> | undefined;
  permitOwner: PermitOwner;
  cancelRequested: boolean;
  finalized: boolean;
};

type PermitOwner = "unacquired" | "bracket" | "body" | "released";

type StopRecord = {
  readonly thread: ThreadState;
  readonly generation: Generation;
  settled: boolean;
};

type Generation = {
  readonly thread: ThreadState;
  readonly threadId: ThreadId;
  readonly source: object | undefined;
  readonly starts: Set<StartRecord>;
  readonly stops: Set<StopRecord>;
  readonly placeholder: boolean;
  stopping: boolean;
};

type PermitUser = {
  readonly generation: Generation;
  acquired: boolean;
  released: boolean;
};

type ThreadState = {
  readonly threadId: ThreadId;
  readonly semaphore: Semaphore.Semaphore;
  readonly permitUsers: Set<PermitUser>;
  readonly starts: Set<StartRecord>;
  readonly generations: Set<Generation>;
  readonly sourceStopRevisions: WeakMap<object, number>;
  current: Generation | undefined;
  stopRevision: number;
};

type StartAdmission =
  | { readonly _tag: "rejected"; readonly error: ProviderSessionSupersededError }
  | { readonly _tag: "accepted"; readonly record: StartRecord };

type BodyAdmission =
  | { readonly _tag: "rejected"; readonly error: ProviderSessionSupersededError }
  | {
      readonly _tag: "accepted";
      readonly generation: Generation;
      readonly fibersToInterrupt: ReadonlyArray<Fiber.Fiber<unknown, unknown>>;
    };

type StopDecision =
  | { readonly _tag: "stale" }
  | { readonly _tag: "settled"; readonly exit: Exit.Exit<void, unknown> };

const superseded = (
  operation: string,
  threadId: ThreadId,
  detail: string,
): ProviderSessionSupersededError =>
  new ProviderSessionSupersededError({
    operation,
    threadId,
    detail,
  });

const finishDeferred = (deferred: Deferred.Deferred<void>): Effect.Effect<void> =>
  Deferred.succeed(deferred, undefined).pipe(Effect.asVoid);

/**
 * The state is deliberately held in this module rather than in a provider
 * adapter. Adapters only receive leases and callbacks; ownership and ordering
 * stay the same for every provider.
 */
export const makeProviderSessionOperations: Effect.Effect<
  ProviderSessionOperations,
  never,
  Scope.Scope
> = Effect.gen(function* () {
  const serviceScope = yield* Scope.Scope;
  const threads = new Map<ThreadId, ThreadState>();
  const retiredSources = new WeakSet<object>();
  const stopTickets = new WeakMap<ProviderSessionStopTicket, StopRecord>();
  const operationTokens = new WeakMap<ProviderSessionOperationToken, Generation | undefined>();
  let closed = false;

  const getThread = (threadId: ThreadId): ThreadState => {
    const existing = threads.get(threadId);
    if (existing !== undefined) return existing;
    const created: ThreadState = {
      threadId,
      semaphore: Semaphore.makeUnsafe(1),
      permitUsers: new Set(),
      starts: new Set(),
      generations: new Set(),
      sourceStopRevisions: new WeakMap(),
      current: undefined,
      stopRevision: 0,
    };
    threads.set(threadId, created);
    return created;
  };

  const sourceRevision = (thread: ThreadState, source: object): number =>
    thread.sourceStopRevisions.get(source) ?? 0;

  const makeGeneration = (
    thread: ThreadState,
    source: object | undefined,
    placeholder: boolean,
    stopping: boolean,
  ): Generation => {
    const generation: Generation = {
      thread,
      threadId: thread.threadId,
      source,
      starts: new Set(),
      stops: new Set(),
      placeholder,
      stopping,
    };
    thread.generations.add(generation);
    return generation;
  };

  const generationIsCurrent = (generation: Generation): boolean =>
    !closed && generation.thread.current === generation;

  const generationCanCommit = (generation: Generation): boolean =>
    generationIsCurrent(generation) &&
    !generation.stopping &&
    (generation.source === undefined || !retiredSources.has(generation.source));

  const removeThreadIfUnused = (thread: ThreadState): void => {
    if (
      thread.current === undefined &&
      thread.permitUsers.size === 0 &&
      thread.starts.size === 0 &&
      thread.generations.size === 0 &&
      threads.get(thread.threadId) === thread
    ) {
      threads.delete(thread.threadId);
    }
  };

  const removeGenerationIfUnused = (generation: Generation): void => {
    const thread = generation.thread;
    if (generation.starts.size !== 0 || generation.stops.size !== 0) return;

    const canRemoveCurrent =
      generation.stopping ||
      closed ||
      (generation.source !== undefined && retiredSources.has(generation.source));
    if (thread.current === generation && !canRemoveCurrent) return;

    if (thread.current === generation) {
      thread.current = undefined;
    }
    thread.generations.delete(generation);
    removeThreadIfUnused(thread);
  };

  const releasePermitUser = (permitUser: PermitUser, acquired: boolean): Effect.Effect<void> =>
    Effect.uninterruptibleMask(() =>
      Effect.suspend(() => {
        if (permitUser.released) return Effect.void;
        permitUser.released = true;
        permitUser.acquired ||= acquired;
        const release = permitUser.acquired
          ? Semaphore.release(permitUser.generation.thread.semaphore, 1).pipe(Effect.asVoid)
          : Effect.void;
        return release.pipe(
          Effect.andThen(
            Effect.sync(() => {
              const thread = permitUser.generation.thread;
              thread.permitUsers.delete(permitUser);
              removeGenerationIfUnused(permitUser.generation);
            }),
          ),
        );
      }),
    );

  const requestInterruptions = (
    fibers: ReadonlyArray<Fiber.Fiber<unknown, unknown>>,
  ): Effect.Effect<void> =>
    Effect.forEach(
      fibers,
      (fiber) => Fiber.interrupt(fiber).pipe(Effect.forkDetach, Effect.asVoid),
      { concurrency: "unbounded", discard: true },
    );

  const requestRecordCancellation = (
    record: StartRecord,
  ): Fiber.Fiber<unknown, unknown> | undefined => {
    record.cancelRequested = true;
    return record.fiber;
  };

  const releaseStartPermit = (
    record: StartRecord,
    owner: "body" | "bracket",
  ): Effect.Effect<void> =>
    Effect.uninterruptibleMask(() =>
      Effect.suspend(() => {
        if (
          record.permitOwner === "released" ||
          (owner === "bracket" && record.permitOwner === "body") ||
          (owner === "body" && record.permitOwner !== "body")
        ) {
          return Effect.void;
        }
        record.permitOwner = "released";
        return Semaphore.release(record.thread.semaphore, 1).pipe(Effect.asVoid);
      }),
    );

  const takeThreadPermit = (thread: ThreadState): Effect.Effect<Option.Option<number>> =>
    Semaphore.take(thread.semaphore, 1).pipe(Effect.timeoutOption(START_WAIT));

  const withPermitUser = <A, E, R>(
    generation: Generation,
    use: (
      restore: <B, E2, R2>(effect: Effect.Effect<B, E2, R2>) => Effect.Effect<B, E2, R2>,
      permit: Option.Option<number>,
    ) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ProviderSessionSupersededError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const permitUser: PermitUser = {
            generation,
            acquired: false,
            released: false,
          };
          generation.thread.permitUsers.add(permitUser);
          return permitUser;
        }),
        (permitUser) =>
          Effect.acquireUseRelease(
            restore(takeThreadPermit(generation.thread)),
            (permit) => {
              permitUser.acquired = Option.isSome(permit);
              return use(restore, permit);
            },
            (permit) => releasePermitUser(permitUser, Option.isSome(permit)),
          ),
        (permitUser) => releasePermitUser(permitUser, false),
      ),
    );

  const takeThreadPermitOrSupersede = (
    thread: ThreadState,
    operation: string,
    detail: string,
  ): Effect.Effect<number, ProviderSessionSupersededError> =>
    takeThreadPermit(thread).pipe(
      Effect.flatMap((permit) =>
        Option.isNone(permit) ? superseded(operation, thread.threadId, detail) : Effect.succeed(1),
      ),
    );

  const markGenerationStopping = (generation: Generation): Fiber.Fiber<unknown, unknown>[] => {
    generation.stopping = true;
    const fibers: Fiber.Fiber<unknown, unknown>[] = [];
    for (const record of generation.starts) {
      const fiber = requestRecordCancellation(record);
      if (fiber !== undefined) fibers.push(fiber);
    }
    return fibers;
  };

  const settleStartRecord = (record: StartRecord): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.sync(() => {
        if (record.finalized) return;
        record.finalized = true;
        record.thread.starts.delete(record);
        if (record.generation !== undefined) {
          record.generation.starts.delete(record);
          removeGenerationIfUnused(record.generation);
        }
      }).pipe(Effect.andThen(finishDeferred(record.completion))),
    );

  const startIsSuperseded = (record: StartRecord): boolean => {
    const generation = record.generation;
    return (
      closed ||
      record.cancelRequested ||
      generation === undefined ||
      !generationIsCurrent(generation) ||
      generation.stopping ||
      retiredSources.has(record.source)
    );
  };

  const invalidatedSinceAdmission = (record: StartRecord): boolean => {
    const currentSourceRevision = sourceRevision(record.thread, record.source);
    return (
      record.stopRevision !== record.thread.stopRevision ||
      record.sourceStopRevision !== currentSourceRevision
    );
  };

  const registerStart = (
    input: Pick<
      ProviderSessionStartInput<unknown, unknown, unknown>,
      "threadId" | "source" | "isSourceActive"
    >,
  ): Effect.Effect<StartAdmission> =>
    Effect.sync(() => {
      if (closed) {
        return {
          _tag: "rejected" as const,
          error: superseded(
            "ProviderSessionOperations.start",
            input.threadId,
            "Provider session operations are closed.",
          ),
        };
      }
      if (retiredSources.has(input.source) || !input.isSourceActive()) {
        return {
          _tag: "rejected" as const,
          error: superseded(
            "ProviderSessionOperations.start",
            input.threadId,
            "The provider session source is no longer active.",
          ),
        };
      }

      const thread = getThread(input.threadId);
      const record: StartRecord = {
        thread,
        threadId: input.threadId,
        source: input.source,
        isSourceActive: input.isSourceActive,
        stopRevision: thread.stopRevision,
        sourceStopRevision: sourceRevision(thread, input.source),
        completion: Deferred.makeUnsafe<void>(),
        generation: undefined,
        fiber: undefined,
        permitOwner: "unacquired",
        cancelRequested: false,
        finalized: false,
      };
      thread.starts.add(record);
      return { _tag: "accepted" as const, record };
    });

  const admitStartBody = (record: StartRecord): Effect.Effect<BodyAdmission> =>
    Effect.sync(() => {
      if (
        closed ||
        record.cancelRequested ||
        retiredSources.has(record.source) ||
        !record.isSourceActive() ||
        invalidatedSinceAdmission(record)
      ) {
        return {
          _tag: "rejected" as const,
          error: superseded(
            "ProviderSessionOperations.start",
            record.threadId,
            "The start was superseded while waiting for the thread permit.",
          ),
        };
      }

      const previous = record.thread.current;
      const generation = makeGeneration(record.thread, record.source, false, false);
      record.thread.current = generation;
      record.generation = generation;
      generation.starts.add(record);

      const fibersToInterrupt: Fiber.Fiber<unknown, unknown>[] = [];
      if (previous !== undefined && previous !== generation && previous.stopping) {
        fibersToInterrupt.push(...markGenerationStopping(previous));
      }
      if (previous !== undefined && previous !== generation) {
        removeGenerationIfUnused(previous);
      }
      return {
        _tag: "accepted" as const,
        generation,
        fibersToInterrupt,
      };
    });

  const makeStartBody = <A, E, R>(
    record: StartRecord,
    input: ProviderSessionStartInput<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    const generation = record.generation;
    if (generation === undefined || generation.source === undefined) {
      return Effect.die("ProviderSessionOperations.start body has no generation");
    }

    const lease: ProviderSessionLease = {
      threadId: record.threadId,
      source: generation.source,
      isCurrent: () => generationIsCurrent(generation),
      isStopping: () =>
        closed || record.cancelRequested || generation.stopping || !record.isSourceActive(),
    };

    const operation = Effect.suspend(() => {
      if (record.cancelRequested || closed || generation.stopping || !record.isSourceActive()) {
        return Effect.interrupt;
      }
      return input.operation(lease);
    });

    const body = Effect.onExit(operation, () =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const sourceActiveExit = yield* Effect.exit(Effect.sync(() => record.isSourceActive()));
          if (Exit.isSuccess(sourceActiveExit) && !sourceActiveExit.value) {
            generation.stopping = true;
          }
          const shouldCleanup =
            closed ||
            record.cancelRequested ||
            generation.stopping ||
            !generationIsCurrent(generation) ||
            retiredSources.has(record.source);
          if (shouldCleanup) {
            const cleanupExit = yield* Effect.exit(Effect.suspend(() => input.cleanup(lease)));
            if (Exit.isFailure(cleanupExit)) {
              yield* Effect.logWarning("provider.session.operations.cleanup-failed", {
                threadId: record.threadId,
                cause: cleanupExit.cause,
              });
            }
          }
        }).pipe(Effect.ensuring(settleStartRecord(record))),
      ),
    );

    return body.pipe(Effect.ensuring(releaseStartPermit(record, "body")));
  };

  const handleCallerExit = <A, E>(
    record: StartRecord,
    exit: Exit.Exit<A, E | ProviderSessionSupersededError>,
  ): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const fiberToInterrupt = yield* Effect.sync(() => {
          if (record.finalized) return undefined;
          if (record.generation === undefined) {
            record.thread.starts.delete(record);
            return undefined;
          }
          if (record.fiber === undefined) {
            record.cancelRequested = true;
            record.generation.stopping = true;
            return undefined;
          }
          if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
            return requestRecordCancellation(record);
          }
          return undefined;
        });
        if (fiberToInterrupt !== undefined) {
          yield* Fiber.interrupt(fiberToInterrupt).pipe(Effect.forkDetach, Effect.asVoid);
        }
        if (record.generation === undefined && !record.finalized) {
          record.finalized = true;
          yield* finishDeferred(record.completion);
          removeThreadIfUnused(record.thread);
        } else if (record.generation !== undefined && record.fiber === undefined) {
          yield* settleStartRecord(record);
        }
      }),
    );

  const runStart = <A, E, R>(
    record: StartRecord,
    input: ProviderSessionStartInput<A, E, R>,
  ): Effect.Effect<A, E | ProviderSessionSupersededError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.acquireUseRelease(
        restore(
          takeThreadPermitOrSupersede(
            record.thread,
            "ProviderSessionOperations.start",
            "Timed out waiting for the provider thread permit.",
          ),
        ),
        () =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              if (record.permitOwner === "unacquired") {
                record.permitOwner = "bracket";
              }
            });
            const bodyAdmission = yield* admitStartBody(record);
            if (bodyAdmission._tag === "rejected") {
              yield* settleStartRecord(record);
              return yield* bodyAdmission.error;
            }

            yield* requestInterruptions(bodyAdmission.fibersToInterrupt);
            const body = makeStartBody(record, input);
            yield* Effect.sync(() => {
              record.permitOwner = "body";
            });
            const bodyFiber = yield* Effect.onExit(
              Effect.forkDetach(body, {
                startImmediately: true,
                uninterruptible: false,
              }),
              (exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit) && record.permitOwner === "body") {
                    record.permitOwner = "bracket";
                  }
                }),
            );
            const interruptImmediately = yield* Effect.sync(() => {
              record.fiber = bodyFiber;
              return record.cancelRequested;
            });
            if (interruptImmediately) {
              yield* Fiber.interrupt(bodyFiber).pipe(Effect.forkDetach, Effect.asVoid);
            }

            const bodyExit = yield* restore(Fiber.await(bodyFiber));
            if (startIsSuperseded(record)) {
              return yield* superseded(
                "ProviderSessionOperations.start",
                record.threadId,
                "The provider session start lost ownership before completion.",
              );
            }
            if (Exit.isSuccess(bodyExit)) return bodyExit.value;
            return yield* Effect.failCause(bodyExit.cause);
          }),
        () => releaseStartPermit(record, "bracket"),
      ),
    );

  const start = <A, E, R>(
    input: ProviderSessionStartInput<A, E, R>,
  ): Effect.Effect<A, E | ProviderSessionSupersededError, R> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const admission = yield* registerStart(input);
        if (admission._tag === "rejected") return yield* admission.error;

        const record = admission.record;
        return yield* Effect.onExit(restore(runStart(record, input)), (exit) =>
          handleCallerExit(record, exit),
        );
      }),
    );

  const beginStop = (threadId: ThreadId): Effect.Effect<ProviderSessionStopTicket> =>
    Effect.gen(function* () {
      const result = yield* Effect.sync(() => {
        const thread = getThread(threadId);
        let generation = thread.current;
        if (generation === undefined) {
          generation = makeGeneration(thread, undefined, true, true);
          thread.current = generation;
        } else {
          generation.stopping = true;
        }
        thread.stopRevision += 1;
        const fibers: Fiber.Fiber<unknown, unknown>[] = [];
        for (const record of thread.starts) {
          const fiber = requestRecordCancellation(record);
          if (fiber !== undefined) fibers.push(fiber);
        }
        for (const record of generation.starts) {
          const fiber = requestRecordCancellation(record);
          if (fiber !== undefined) fibers.push(fiber);
        }
        const stop: StopRecord = {
          thread,
          generation,
          settled: false,
        };
        generation.stops.add(stop);
        const ticket: ProviderSessionStopTicket = {
          threadId,
          ...(generation.source === undefined ? {} : { source: generation.source }),
          isCurrent: () => generationIsCurrent(generation),
        };
        stopTickets.set(ticket, stop);
        return { ticket, fibers };
      });
      yield* Effect.uninterruptible(requestInterruptions(result.fibers));
      return result.ticket;
    });

  const releaseStopTicket = (stop: StopRecord): void => {
    if (stop.settled) return;
    stop.settled = true;
    stop.generation.stops.delete(stop);
    removeGenerationIfUnused(stop.generation);
  };

  const clearFailedStopIfLast = (stop: StopRecord): void => {
    const generation = stop.generation;
    if (
      generation.thread.current === generation &&
      generation.stops.size === 1 &&
      generation.stops.has(stop) &&
      !closed &&
      (generation.source === undefined || !retiredSources.has(generation.source))
    ) {
      generation.stopping = false;
    }
  };

  const settleStop = <E, R>(
    ticket: ProviderSessionStopTicket,
    input: {
      readonly succeeded: boolean;
      readonly isSourceCurrent: () => boolean;
      readonly commit: Effect.Effect<void, E, R>;
    },
  ): Effect.Effect<void, E | ProviderSessionSupersededError, R> =>
    Effect.gen(function* () {
      const stop = stopTickets.get(ticket);
      if (stop === undefined) {
        return yield* superseded(
          "ProviderSessionOperations.settleStop",
          ticket.threadId,
          "The stop ticket is not owned by this helper.",
        );
      }
      if (stop.settled) return;

      const decision = yield* withPermitUser(stop.generation, (restore, permit) =>
        Effect.gen(function* () {
          if (Option.isNone(permit)) {
            // Admission expiry is terminal for this ticket. The generation keeps
            // its stopping state; a later start may replace it, but this ticket
            // must not retain the generation forever.
            releaseStopTicket(stop);
            return yield* superseded(
              "ProviderSessionOperations.settleStop",
              ticket.threadId,
              STOP_PERMIT_TIMEOUT_DETAIL,
            );
          }
          if (stop.settled || stop.thread.current !== stop.generation || !input.isSourceCurrent()) {
            releaseStopTicket(stop);
            return { _tag: "stale" as const } satisfies StopDecision;
          }

          const commitExit = yield* Effect.exit(restore(input.commit));

          if (input.succeeded) {
            // The identity check is the ownership boundary. A replacement may
            // have become current only after this permit was released, and it
            // must never be removed by this old stop.
            if (stop.thread.current === stop.generation) {
              stop.generation.stopping = true;
              stop.thread.current = undefined;
            }
            releaseStopTicket(stop);
          } else {
            clearFailedStopIfLast(stop);
            releaseStopTicket(stop);
          }
          return {
            _tag: "settled" as const,
            exit: commitExit,
          } satisfies StopDecision;
        }),
      );

      if (decision._tag === "stale") return;
      if (Exit.isSuccess(decision.exit)) return;
      return yield* Effect.failCause(decision.exit.cause);
    });

  const capture = (
    threadId: ThreadId,
    source: object,
  ): Effect.Effect<ProviderSessionOperationToken> =>
    Effect.sync(() => {
      if (closed || retiredSources.has(source)) {
        const token: ProviderSessionOperationToken = {
          threadId,
          source,
          isCurrent: () => false,
        };
        operationTokens.set(token, undefined);
        return token;
      }

      const thread = getThread(threadId);
      const current = thread.current;
      const generation =
        current ?? makeGeneration(thread, source, true, closed || retiredSources.has(source));
      if (current === undefined) {
        thread.current = generation;
      }

      const token: ProviderSessionOperationToken = {
        threadId,
        source,
        isCurrent: () => generationCanCommit(generation) && generation.source === source,
      };
      operationTokens.set(token, generation);
      return token;
    });

  const commitIfCurrent = <A, E, R>(
    token: ProviderSessionOperationToken,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<Option.Option<A>, E | ProviderSessionSupersededError, R> =>
    Effect.gen(function* () {
      if (!operationTokens.has(token)) {
        return yield* superseded(
          "ProviderSessionOperations.commitIfCurrent",
          token.threadId,
          "The operation token is not owned by this helper.",
        );
      }
      const generation = operationTokens.get(token);
      if (generation === undefined) return Option.none<A>();
      const result = yield* withPermitUser(generation, (restore, permit) =>
        Effect.gen(function* () {
          if (Option.isNone(permit)) {
            return yield* superseded(
              "ProviderSessionOperations.commitIfCurrent",
              token.threadId,
              "Timed out waiting for the provider thread permit.",
            );
          }
          if (!generationCanCommit(generation) || generation.source !== token.source) {
            return Option.none<A>();
          }
          return Option.some(yield* restore(effect));
        }),
      );
      return result;
    });

  const retireSource = (source: object): Effect.Effect<void> =>
    Effect.gen(function* () {
      const fibers = yield* Effect.sync(() => {
        retiredSources.add(source);
        const fibersToInterrupt: Fiber.Fiber<unknown, unknown>[] = [];
        for (const thread of threads.values()) {
          let matched = false;
          const generations = [...thread.generations];
          for (const generation of generations) {
            if (generation.source !== source) continue;
            matched = true;
            fibersToInterrupt.push(...markGenerationStopping(generation));
          }
          for (const record of thread.starts) {
            if (record.source !== source) continue;
            matched = true;
            const fiber = requestRecordCancellation(record);
            if (fiber !== undefined) fibersToInterrupt.push(fiber);
          }
          if (matched) {
            thread.sourceStopRevisions.set(source, sourceRevision(thread, source) + 1);
          }
          for (const generation of generations) {
            if (generation.source === source) removeGenerationIfUnused(generation);
          }
        }
        return fibersToInterrupt;
      });
      yield* Effect.uninterruptible(requestInterruptions(fibers));
    });

  const close = Effect.gen(function* () {
    const fibers = yield* Effect.sync(() => {
      if (closed) return [] as ReadonlyArray<Fiber.Fiber<unknown, unknown>>;
      closed = true;
      const fibersToInterrupt: Fiber.Fiber<unknown, unknown>[] = [];
      for (const thread of threads.values()) {
        thread.stopRevision += 1;
        for (const generation of thread.generations) {
          fibersToInterrupt.push(...markGenerationStopping(generation));
        }
        for (const record of thread.starts) {
          const fiber = requestRecordCancellation(record);
          if (fiber !== undefined) fibersToInterrupt.push(fiber);
        }
      }
      return fibersToInterrupt;
    });
    yield* Effect.uninterruptible(requestInterruptions(fibers));
  });

  const drainStarts = (source?: object): Effect.Effect<void> =>
    Effect.gen(function* () {
      const completions = yield* Effect.sync(() => {
        const values: Array<Deferred.Deferred<void>> = [];
        for (const thread of threads.values()) {
          for (const record of thread.starts) {
            if (source === undefined || record.source === source) {
              values.push(record.completion);
            }
          }
        }
        return values;
      });
      yield* Effect.forEach(completions, Deferred.await, {
        concurrency: "unbounded",
        discard: true,
      });
    });

  const startingSource = (threadId: ThreadId): object | undefined => {
    const thread = threads.get(threadId);
    if (thread === undefined) return undefined;
    for (const record of thread.starts) {
      if (record.generation === undefined) return record.source;
    }
    for (const record of thread.starts) return record.source;
    return undefined;
  };

  yield* Scope.addFinalizer(serviceScope, close);

  return {
    start,
    beginStop,
    settleStop,
    capture,
    commitIfCurrent,
    retireSource,
    close,
    drainStarts,
    isClosed: () => closed,
    startingSource,
  } satisfies ProviderSessionOperations;
});
