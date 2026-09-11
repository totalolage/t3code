import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

type ProviderRuntimeAdapter = ProviderAdapterShape<ProviderAdapterError>;
type ProcessEvent<E> = (
  source: ProviderRuntimeSource,
  event: ProviderRuntimeEvent,
) => Effect.Effect<void, E>;
type SourceConsumer<E> = (event: ProviderRuntimeEvent) => Effect.Effect<void, E>;
type PublishEvent<E> = (isAllowed: () => boolean) => Effect.Effect<void, E>;
type ReaderExit<E> = Exit.Exit<void, E>;

const OPEN_CODE = ProviderDriverKind.make("opencode");
const LIFECYCLE_WAIT = "5 seconds" as const;

type SourceStatus = "active" | "retiring" | "retired";

interface ExitIntentRegistration {
  readonly sequence: number;
  readonly intent: () => "stop" | "replace";
}

interface FlushOperation<E> {
  worker: Fiber.Fiber<void, E> | undefined;
  completed: boolean;
  readonly onComplete: (() => void) | undefined;
}

interface SourceEntry<E> {
  readonly instanceId: ProviderInstanceId;
  readonly adapter: ProviderRuntimeAdapter;
  readonly source: ProviderRuntimeSource;
  readonly readerCompletion: Deferred.Deferred<ReaderExit<E>>;
  readonly pendingFlushes: Set<FlushOperation<E>>;
  readonly timedOutFlushes: Set<FlushOperation<E>>;
  processFailure: Cause.Cause<E> | undefined;
  readonly state: {
    status: SourceStatus;
  };
  reader: Fiber.Fiber<void, never> | undefined;
  readerEnded: boolean;
}

interface InstanceEntries<E> {
  readonly byAdapter: WeakMap<ProviderRuntimeAdapter, SourceEntry<E>>;
  /** Entries stay here until their adapter reader has actually completed. */
  readonly unfinished: Set<SourceEntry<E>>;
  /** Retired entries stay here only while detached flush workers are running. */
  readonly pendingFlushEntries: Set<SourceEntry<E>>;
}

interface EntryRegistration<E> {
  readonly entry: SourceEntry<E>;
  readonly created: boolean;
}

export interface ProviderRuntimeSource {
  readonly instanceId: ProviderInstanceId;
  readonly adapter: ProviderRuntimeAdapter;
  readonly isAdmitted: () => boolean;
  readonly isPublishing: () => boolean;
}

export class ProviderRuntimeSourceNotOwnedError extends Data.TaggedError(
  "ProviderRuntimeSourceNotOwnedError",
)<{
  readonly message: string;
}> {}

export interface ProviderRuntimeDeliveryHandlers<E = never> {
  readonly processEvent: ProcessEvent<E>;
  readonly onSourceEnded: () => Effect.Effect<void, E>;
}

export interface ProviderRuntimeDelivery<E = never> {
  readonly attach: (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) => Effect.Effect<Option.Option<ProviderRuntimeSource>>;
  readonly get: (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) => ProviderRuntimeSource | undefined;
  readonly sources: () => ReadonlyArray<ProviderRuntimeSource>;
  readonly beforeClose: (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) => Effect.Effect<void>;
  readonly afterClose: (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) => Effect.Effect<void, E | Cause.TimeoutError>;
  readonly closeAdmission: Effect.Effect<void>;
  readonly registerConsumer: (
    consumer: SourceConsumer<E>,
  ) => Effect.Effect<void, never, Scope.Scope>;
  readonly tag: (event: ProviderRuntimeEvent, source: ProviderRuntimeSource) => void;
  readonly inheritTag: (derived: ProviderRuntimeEvent, original: ProviderRuntimeEvent) => void;
  readonly isEventAllowed: (event: ProviderRuntimeEvent) => boolean;
  readonly deliver: (
    event: ProviderRuntimeEvent,
    publish: PublishEvent<E>,
  ) => Effect.Effect<void, E>;
  readonly withExitIntent: <A, EBody, R>(
    source: ProviderRuntimeSource,
    threadId: ThreadId,
    intent: () => "stop" | "replace",
    effect: Effect.Effect<A, EBody, R>,
  ) => Effect.Effect<A, EBody | E | Cause.TimeoutError | ProviderRuntimeSourceNotOwnedError, R>;
  readonly flush: (
    source: ProviderRuntimeSource,
  ) => Effect.Effect<void, E | Cause.TimeoutError | ProviderRuntimeSourceNotOwnedError>;
}

function fromExit<A, E>(exit: Exit.Exit<A, E>): Effect.Effect<A, E> {
  return Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause);
}

/**
 * Owns one sequential reader per instance/adapter generation. Reader and
 * flush fibers are detached so scope shutdown requests interruption without
 * joining callbacks that may be uninterruptible.
 */
export const makeProviderRuntimeDelivery = Effect.fn("makeProviderRuntimeDelivery")(function* <E>(
  handlers: ProviderRuntimeDeliveryHandlers<E>,
): Effect.fn.Return<ProviderRuntimeDelivery<E>, never, Scope.Scope> {
  const controllerScope = yield* Scope.Scope;
  const entriesByInstance = new Map<ProviderInstanceId, InstanceEntries<E>>();
  const liveEntries = new Set<SourceEntry<E>>();
  const sourceEntries = new WeakMap<ProviderRuntimeSource, SourceEntry<E>>();
  const eventTags = new WeakMap<object, ProviderRuntimeSource>();
  const consumers = new Set<{ readonly consumer: SourceConsumer<E> }>();
  const exitIntents = new WeakMap<
    ProviderRuntimeSource,
    Map<ThreadId, Map<number, ExitIntentRegistration>>
  >();

  let admissionClosed = false;
  let nextExitIntentSequence = 0;

  const getInstanceEntries = (instanceId: ProviderInstanceId): InstanceEntries<E> => {
    const existing = entriesByInstance.get(instanceId);
    if (existing !== undefined) return existing;
    const created: InstanceEntries<E> = {
      byAdapter: new WeakMap(),
      unfinished: new Set(),
      pendingFlushEntries: new Set(),
    };
    entriesByInstance.set(instanceId, created);
    return created;
  };

  const hasUnfinishedEntry = (instanceId: ProviderInstanceId, except?: SourceEntry<E>): boolean => {
    const instanceEntries = entriesByInstance.get(instanceId);
    if (instanceEntries === undefined) return false;
    for (const entry of instanceEntries.unfinished) {
      if (entry !== except) return true;
    }
    return false;
  };

  const makeEntry = (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
    status: SourceStatus,
  ): SourceEntry<E> => {
    const readerCompletion = Deferred.makeUnsafe<ReaderExit<E>>();
    const pendingFlushes = new Set<FlushOperation<E>>();
    const timedOutFlushes = new Set<FlushOperation<E>>();
    const state = { status };
    const source: ProviderRuntimeSource = {
      instanceId,
      adapter,
      isAdmitted: () => state.status === "active" && timedOutFlushes.size === 0 && !admissionClosed,
      isPublishing: () => state.status !== "retired",
    };
    return {
      instanceId,
      adapter,
      source,
      readerCompletion,
      pendingFlushes,
      timedOutFlushes,
      processFailure: undefined,
      state,
      reader: undefined,
      readerEnded: false,
    };
  };

  const registerEntry = (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
    status: SourceStatus,
  ): EntryRegistration<E> => {
    const instanceEntries = getInstanceEntries(instanceId);
    const existing = instanceEntries.byAdapter.get(adapter);
    if (existing !== undefined) return { entry: existing, created: false };

    const entry = makeEntry(instanceId, adapter, status);
    instanceEntries.byAdapter.set(adapter, entry);
    instanceEntries.unfinished.add(entry);
    sourceEntries.set(entry.source, entry);
    liveEntries.add(entry);
    return { entry, created: true };
  };

  const rollbackEntry = (entry: SourceEntry<E>): void => {
    if (entry.reader !== undefined || entry.readerEnded) return;
    const instanceEntries = entriesByInstance.get(entry.instanceId);
    if (instanceEntries?.byAdapter.get(entry.adapter) !== entry) return;
    instanceEntries.byAdapter.delete(entry.adapter);
    instanceEntries.unfinished.delete(entry);
    instanceEntries.pendingFlushEntries.delete(entry);
    sourceEntries.delete(entry.source);
    liveEntries.delete(entry);
  };

  const recordProcessFailure = (entry: SourceEntry<E>, cause: Cause.Cause<E>): void => {
    if (entry.processFailure === undefined) entry.processFailure = cause;
  };

  const findExitIntent = (
    source: ProviderRuntimeSource,
    threadId: ThreadId,
  ): ExitIntentRegistration | undefined => {
    const byThread = exitIntents.get(source)?.get(threadId);
    if (byThread === undefined) return undefined;

    let selected: ExitIntentRegistration | undefined;
    for (const registration of byThread.values()) {
      if (selected === undefined || registration.sequence > selected.sequence) {
        selected = registration;
      }
    }
    return selected;
  };

  const applyExitIntent = (
    source: ProviderRuntimeSource,
    event: ProviderRuntimeEvent,
  ): ProviderRuntimeEvent => {
    if (
      source.adapter.provider !== OPEN_CODE ||
      event.provider !== OPEN_CODE ||
      event.type !== "session.exited" ||
      event.payload.exitKind !== "graceful"
    ) {
      return event;
    }

    const registration = findExitIntent(source, event.threadId);
    if (registration === undefined) return event;

    const intent = registration.intent();
    const derived: ProviderRuntimeEvent = {
      ...event,
      payload: {
        ...event.payload,
        reason: intent === "replace" ? "Session replaced." : "Session stopped.",
        recoverable: intent === "replace",
      },
    };
    eventTags.set(derived, source);
    return derived;
  };

  const finishEntry = Effect.fn("ProviderRuntimeDelivery.finishEntry")(function* (
    entry: SourceEntry<E>,
    streamExit: ReaderExit<E>,
  ) {
    const shouldFinish = yield* Effect.sync(() => {
      if (entry.readerEnded) return false;
      entry.readerEnded = true;
      entry.state.status = "retired";
      liveEntries.delete(entry);
      entriesByInstance.get(entry.instanceId)?.unfinished.delete(entry);
      return true;
    });
    if (!shouldFinish) return;

    // Reader completion is the lifecycle fence. Reconciliation runs after it
    // so it can attach a fresh generation without waiting on itself.
    yield* Deferred.succeed(entry.readerCompletion, streamExit);

    if (Exit.isFailure(streamExit) && !Cause.hasInterruptsOnly(streamExit.cause)) {
      yield* Effect.logWarning("provider.runtime.delivery.reader-failed", {
        instanceId: String(entry.instanceId),
        provider: String(entry.adapter.provider),
        cause: streamExit.cause,
      });
    }

    yield* Effect.suspend(handlers.onSourceEnded).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.runtime.delivery.source-ended-failed", {
          instanceId: String(entry.instanceId),
          provider: String(entry.adapter.provider),
          cause,
        }),
      ),
    );
  });

  const processOne = Effect.fn("ProviderRuntimeDelivery.processOne")(function* (
    entry: SourceEntry<E>,
    event: ProviderRuntimeEvent,
  ) {
    yield* Effect.sync(() => eventTags.set(event, entry.source));
    const result = yield* Effect.exit(
      Effect.gen(function* () {
        const prepared = yield* Effect.sync(() => applyExitIntent(entry.source, event));
        yield* Effect.suspend(() => handlers.processEvent(entry.source, prepared));
      }),
    );
    if (Exit.isSuccess(result)) return;

    if (Cause.hasInterruptsOnly(result.cause)) {
      return yield* Effect.failCause(result.cause);
    }

    yield* Effect.sync(() => recordProcessFailure(entry, result.cause));
    yield* Effect.logWarning("provider.runtime.delivery.process-event-failed", {
      instanceId: String(entry.instanceId),
      provider: String(entry.adapter.provider),
      eventId: String(event.eventId),
      cause: result.cause,
    });
  });

  const startReader = Effect.fn("ProviderRuntimeDelivery.startReader")(function* (
    entry: SourceEntry<E>,
  ) {
    const streamEffect = Effect.suspend(() =>
      Stream.runForEach(entry.adapter.streamEvents, (event) => processOne(entry, event)),
    );
    const readerProgram = Effect.gen(function* () {
      const streamExit = yield* Effect.exit(streamEffect);
      yield* Effect.uninterruptible(finishEntry(entry, streamExit));
    });
    return yield* Effect.forkDetach(readerProgram, {
      startImmediately: true,
      uninterruptible: false,
    });
  });

  const startRegisteredReader = (registration: EntryRegistration<E>): Effect.Effect<void> => {
    if (!registration.created) return Effect.void;
    const entry = registration.entry;
    return Effect.uninterruptible(
      startReader(entry).pipe(
        Effect.tap((reader) =>
          Effect.sync(() => {
            entry.reader = reader;
            return (
              admissionClosed ||
              entriesByInstance.get(entry.instanceId)?.byAdapter.get(entry.adapter) !== entry
            );
          }).pipe(
            Effect.flatMap((interrupt) =>
              interrupt
                ? Fiber.interrupt(reader).pipe(
                    Effect.forkDetach({ startImmediately: true }),
                    Effect.asVoid,
                  )
                : Effect.void,
            ),
          ),
        ),
        Effect.asVoid,
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Effect.sync(() => rollbackEntry(entry)) : Effect.void,
        ),
      ),
    );
  };

  const registerAttach = (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ): EntryRegistration<E> | undefined => {
    if (admissionClosed) return undefined;

    const instanceEntries = entriesByInstance.get(instanceId);
    const existing = instanceEntries?.byAdapter.get(adapter);
    if (existing !== undefined) {
      if (
        existing.state.status === "active" &&
        existing.source.isAdmitted() &&
        !hasUnfinishedEntry(instanceId, existing)
      ) {
        return { entry: existing, created: false };
      }
      return undefined;
    }

    if (hasUnfinishedEntry(instanceId)) return undefined;
    return registerEntry(instanceId, adapter, "active");
  };

  const ensureOldEntry = Effect.fn("ProviderRuntimeDelivery.ensureOldEntry")(function* (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) {
    const registration = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* Effect.sync(() => {
          const instanceEntries = entriesByInstance.get(instanceId);
          const existing = instanceEntries?.byAdapter.get(adapter);
          if (existing !== undefined) {
            if (existing.state.status === "active") existing.state.status = "retiring";
            return { entry: existing, created: false } satisfies EntryRegistration<E>;
          }
          return registerEntry(instanceId, adapter, "retiring");
        });
        yield* startRegisteredReader(result);
        return result;
      }),
    );
    return registration.entry;
  });

  const attach = Effect.fn("ProviderRuntimeDelivery.attach")(function* (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) {
    const registration = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const result = yield* Effect.sync(() => registerAttach(instanceId, adapter));
        if (result === undefined) return undefined;
        yield* startRegisteredReader(result);
        return result;
      }),
    );
    if (registration === undefined || !registration.entry.source.isAdmitted()) {
      return Option.none<ProviderRuntimeSource>();
    }
    return Option.some(registration.entry.source);
  });

  const beforeClose = Effect.fn("ProviderRuntimeDelivery.beforeClose")(function* (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) {
    yield* ensureOldEntry(instanceId, adapter);
  });

  const afterClose = Effect.fn("ProviderRuntimeDelivery.afterClose")(function* (
    instanceId: ProviderInstanceId,
    adapter: ProviderRuntimeAdapter,
  ) {
    const entry = yield* ensureOldEntry(instanceId, adapter);
    const completed = yield* Deferred.await(entry.readerCompletion).pipe(
      Effect.timeoutOption(LIFECYCLE_WAIT),
    );
    if (Option.isNone(completed)) {
      yield* Effect.logWarning("provider.runtime.delivery.after-close-timeout", {
        instanceId: String(instanceId),
        provider: String(adapter.provider),
        timeout: LIFECYCLE_WAIT,
      });
      return yield* Effect.fail(new Cause.TimeoutError("Provider runtime source did not finish"));
    }
  });

  const closeAdmission = Effect.sync(() => {
    admissionClosed = true;
  });

  const registerConsumer = Effect.fn("ProviderRuntimeDelivery.registerConsumer")(function* (
    consumer: SourceConsumer<E>,
  ) {
    const registration = { consumer };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        consumers.add(registration);
      }),
      () => Effect.sync(() => consumers.delete(registration)),
    );
  });

  const tag = (event: ProviderRuntimeEvent, source: ProviderRuntimeSource): void => {
    eventTags.set(event, source);
  };

  const inheritTag = (derived: ProviderRuntimeEvent, original: ProviderRuntimeEvent): void => {
    if (derived === original) return;
    const source = eventTags.get(original);
    eventTags.delete(derived);
    if (source !== undefined) eventTags.set(derived, source);
  };

  const isEventAllowed = (event: ProviderRuntimeEvent): boolean => {
    const source = eventTags.get(event);
    return source === undefined || source.isPublishing();
  };

  const deliver = Effect.fn("ProviderRuntimeDelivery.deliver")(function* (
    event: ProviderRuntimeEvent,
    publish: PublishEvent<E>,
  ) {
    if (!isEventAllowed(event)) return;

    const source = eventTags.get(event);
    const snapshot = Array.from(consumers);
    for (const registration of snapshot) {
      if (!consumers.has(registration)) continue;
      if (!isEventAllowed(event)) return;

      const result = yield* Effect.exit(Effect.suspend(() => registration.consumer(event)));
      if (Exit.isSuccess(result)) continue;

      if (source !== undefined && !Cause.hasInterruptsOnly(result.cause)) {
        const entry = sourceEntries.get(source);
        if (entry !== undefined) {
          yield* Effect.sync(() => recordProcessFailure(entry, result.cause));
          yield* Effect.logWarning("provider.runtime.delivery.consumer-failed", {
            instanceId: String(entry.instanceId),
            provider: String(entry.adapter.provider),
            eventId: String(event.eventId),
            cause: result.cause,
          });
        }
      }
      return yield* Effect.failCause(result.cause);
    }

    if (!isEventAllowed(event)) return;
    yield* Effect.suspend(() => publish(() => isEventAllowed(event)));
  });

  const completeFlush = (entry: SourceEntry<E>, operation: FlushOperation<E>): void => {
    if (operation.completed) return;
    operation.completed = true;
    entry.pendingFlushes.delete(operation);
    entry.timedOutFlushes.delete(operation);
    if (entry.pendingFlushes.size === 0) {
      entriesByInstance.get(entry.instanceId)?.pendingFlushEntries.delete(entry);
    }
    operation.onComplete?.();
  };

  const startFlush = Effect.fn("ProviderRuntimeDelivery.startFlush")(function* (
    entry: SourceEntry<E>,
    onComplete: (() => void) | undefined,
  ) {
    let operation: FlushOperation<E> | undefined;
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const registered = yield* Effect.sync(() => {
          const created: FlushOperation<E> = {
            worker: undefined,
            completed: false,
            onComplete,
          };
          entry.pendingFlushes.add(created);
          entriesByInstance.get(entry.instanceId)?.pendingFlushEntries.add(entry);
          return created;
        });
        operation = registered;

        const runFlush = Effect.gen(function* () {
          const drain = entry.adapter.drainEvents;
          if (drain === undefined) return;

          const drained = yield* Effect.suspend(drain);
          if (drained) return;

          const readerExit = yield* Deferred.await(entry.readerCompletion);
          return yield* fromExit(readerExit);
        });
        const workerProgram = Effect.uninterruptibleMask((restore) =>
          Effect.ensuring(
            restore(runFlush),
            Effect.sync(() => completeFlush(entry, registered)),
          ),
        );
        const worker = yield* Effect.forkDetach(workerProgram, {
          startImmediately: true,
          uninterruptible: true,
        });
        const interrupt = yield* Effect.sync(() => {
          registered.worker = worker;
          return admissionClosed;
        });
        if (interrupt) {
          yield* Fiber.interrupt(worker).pipe(
            Effect.forkDetach({ startImmediately: true }),
            Effect.asVoid,
          );
        }
        return registered;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.suspend(() => {
            if (!Exit.isFailure(exit)) return Effect.void;
            const pending = operation;
            if (pending === undefined || pending.worker !== undefined) return Effect.void;
            return Effect.sync(() => completeFlush(entry, pending));
          }),
        ),
      ),
    );
  });

  const flushEntry = Effect.fn("ProviderRuntimeDelivery.flushEntry")(function* (
    source: ProviderRuntimeSource,
    onComplete: (() => void) | undefined,
  ) {
    const entry = sourceEntries.get(source);
    if (entry === undefined) {
      onComplete?.();
      return yield* new ProviderRuntimeSourceNotOwnedError({
        message: "Provider runtime source is not owned by this delivery",
      });
    }

    if (entry.adapter.drainEvents === undefined) {
      const processFailure = yield* Effect.sync(() => entry.processFailure);
      onComplete?.();
      if (processFailure !== undefined) return yield* Effect.failCause(processFailure);
      return;
    }

    const operation = yield* startFlush(entry, onComplete);
    const worker = operation.worker;
    if (worker === undefined) {
      yield* Effect.sync(() => completeFlush(entry, operation));
      return yield* Effect.die("flush worker was not installed");
    }

    const completed = yield* Fiber.await(worker).pipe(Effect.timeoutOption(LIFECYCLE_WAIT));
    if (Option.isNone(completed)) {
      yield* Effect.sync(() => {
        if (!operation.completed) {
          entry.timedOutFlushes.add(operation);
        }
      });
      yield* Effect.logWarning("provider.runtime.delivery.flush-timeout", {
        instanceId: String(entry.instanceId),
        provider: String(entry.adapter.provider),
        timeout: LIFECYCLE_WAIT,
      });
      return yield* Effect.fail(new Cause.TimeoutError("Provider runtime flush timed out"));
    }

    const outcome = completed.value;
    if (Exit.isFailure(outcome)) {
      const processFailure = yield* Effect.sync(() => entry.processFailure);
      yield* Effect.logWarning("provider.runtime.delivery.flush-failed", {
        instanceId: String(entry.instanceId),
        provider: String(entry.adapter.provider),
        cause: outcome.cause,
      });
      if (processFailure !== undefined) return yield* Effect.failCause(processFailure);
      return yield* Effect.failCause(outcome.cause);
    }

    const processFailure = yield* Effect.sync(() => entry.processFailure);
    if (processFailure !== undefined) return yield* Effect.failCause(processFailure);
  });

  const flush = Effect.fn("ProviderRuntimeDelivery.flush")(function* (
    source: ProviderRuntimeSource,
  ) {
    yield* flushEntry(source, undefined);
  });

  const addExitIntent = (
    source: ProviderRuntimeSource,
    threadId: ThreadId,
    intent: () => "stop" | "replace",
  ): (() => void) => {
    let byThread = exitIntents.get(source);
    if (byThread === undefined) {
      byThread = new Map();
      exitIntents.set(source, byThread);
    }
    let registrations = byThread.get(threadId);
    if (registrations === undefined) {
      registrations = new Map();
      byThread.set(threadId, registrations);
    }
    const registration: ExitIntentRegistration = {
      sequence: ++nextExitIntentSequence,
      intent,
    };
    registrations.set(registration.sequence, registration);
    return () => {
      if (registrations?.get(registration.sequence) !== registration) return;
      registrations.delete(registration.sequence);
      if (registrations.size === 0) byThread?.delete(threadId);
      if (byThread?.size === 0) exitIntents.delete(source);
    };
  };

  const withExitIntent: ProviderRuntimeDelivery<E>["withExitIntent"] = (
    source,
    threadId,
    intent,
    effect,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const remove = yield* Effect.sync(() => addExitIntent(source, threadId, intent));
        const bodyExit = yield* Effect.exit(restore(effect));
        const flushExit = yield* Effect.exit(flushEntry(source, remove));

        if (Exit.isFailure(bodyExit)) return yield* Effect.failCause(bodyExit.cause);
        if (Exit.isFailure(flushExit)) return yield* Effect.failCause(flushExit.cause);
        return bodyExit.value;
      }),
    );

  const closeController = Effect.gen(function* () {
    const fibers = yield* Effect.sync(() => {
      admissionClosed = true;
      const entries = new Set<SourceEntry<E>>(liveEntries);
      for (const instanceEntries of entriesByInstance.values()) {
        for (const entry of instanceEntries.unfinished) entries.add(entry);
        for (const entry of instanceEntries.pendingFlushEntries) entries.add(entry);
      }

      const fibersToInterrupt = new Set<Fiber.Fiber<void, E>>();
      for (const entry of entries) {
        entry.state.status = "retired";
        liveEntries.delete(entry);
        if (entry.reader !== undefined) fibersToInterrupt.add(entry.reader);
        for (const operation of entry.pendingFlushes) {
          if (operation.worker !== undefined) fibersToInterrupt.add(operation.worker);
        }
      }
      return Array.from(fibersToInterrupt);
    });

    for (const fiber of fibers) {
      yield* Fiber.interrupt(fiber).pipe(
        Effect.forkDetach({ startImmediately: true }),
        Effect.asVoid,
      );
    }
  });
  yield* Scope.addFinalizer(controllerScope, closeController);

  return {
    attach,
    get: (instanceId, adapter) => entriesByInstance.get(instanceId)?.byAdapter.get(adapter)?.source,
    sources: () => Array.from(liveEntries, (entry) => entry.source),
    beforeClose,
    afterClose,
    closeAdmission,
    registerConsumer,
    tag,
    inheritTag,
    isEventAllowed,
    deliver,
    withExitIntent,
    flush,
  } satisfies ProviderRuntimeDelivery<E>;
});
