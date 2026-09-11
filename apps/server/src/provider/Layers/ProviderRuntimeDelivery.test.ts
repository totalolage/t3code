import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  makeProviderRuntimeDelivery,
  type ProviderRuntimeDelivery,
  type ProviderRuntimeSource,
  ProviderRuntimeSourceNotOwnedError,
} from "./ProviderRuntimeDelivery.ts";

const OPENCODE = ProviderDriverKind.make("opencode");
const OTHER_PROVIDER = ProviderDriverKind.make("other-provider");
const INSTANCE = ProviderInstanceId.make("opencode-main");
const OTHER_INSTANCE = ProviderInstanceId.make("opencode-other");
const THREAD = ThreadId.make("thread-main");
const OTHER_THREAD = ThreadId.make("thread-other");
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const LIFECYCLE_WAIT = "5 seconds" as const;

class ConsumerReceiptError extends Data.TaggedError("ConsumerReceiptError")<{
  readonly message: string;
}> {}

class ProcessReceiptError extends Data.TaggedError("ProcessReceiptError")<{
  readonly message: string;
}> {}

interface FakeAdapter {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly queue: Queue.Queue<ProviderRuntimeEvent, Cause.Done>;
  readonly streamSubscribed: Deferred.Deferred<void>;
  readonly streamEnded: Deferred.Deferred<void>;
  readonly streamSubscriptionCount: () => number;
  readonly offer: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly end: () => Effect.Effect<void>;
  readonly shutdown: () => Effect.Effect<void>;
}

const makeEvent = (input: {
  readonly eventId: string;
  readonly provider?: ProviderDriverKind;
  readonly threadId?: ThreadId;
  readonly exitKind?: "graceful" | "error";
}): ProviderRuntimeEvent => ({
  eventId: EventId.make(input.eventId),
  provider: input.provider ?? OPENCODE,
  threadId: input.threadId ?? THREAD,
  createdAt: CREATED_AT,
  type: "session.exited",
  payload: input.exitKind === undefined ? {} : { exitKind: input.exitKind },
});

const makeFakeAdapter = Effect.fn("ProviderRuntimeDeliveryTest.makeFakeAdapter")(
  function* (input?: {
    readonly provider?: ProviderDriverKind;
    readonly drainEvents?: () => Effect.Effect<boolean>;
  }): Effect.fn.Return<FakeAdapter> {
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent, Cause.Done>();
    const streamSubscribed = yield* Deferred.make<void>();
    const streamEnded = yield* Deferred.make<void>();
    let streamSubscriptionCount = 0;
    const provider = input?.provider ?? OPENCODE;

    const offer = (event: ProviderRuntimeEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);
    const end = () => Queue.end(queue).pipe(Effect.asVoid);
    const shutdown = () => Queue.shutdown(queue).pipe(Effect.asVoid);
    const streamEvents = Stream.unwrap(
      Effect.sync(() => {
        streamSubscriptionCount += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(streamSubscribed, undefined)),
        Effect.as(Stream.fromQueue(queue)),
      ),
    ).pipe(Stream.ensuring(Deferred.succeed(streamEnded, undefined).pipe(Effect.asVoid)));

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession: () => Effect.die("unused in transport controller test"),
      sendTurn: () => Effect.die("unused in transport controller test"),
      interruptTurn: () => Effect.void,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession: () => Effect.void,
      listSessions: () => Effect.succeed([]),
      hasSession: () => Effect.succeed(false),
      readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      stopAll: () => Effect.void,
      streamEvents,
      ...(input?.drainEvents === undefined ? {} : { drainEvents: input.drainEvents }),
    };

    return {
      adapter,
      queue,
      streamSubscribed,
      streamEnded,
      streamSubscriptionCount: () => streamSubscriptionCount,
      offer,
      end,
      shutdown,
    };
  },
);

function isSome<A>(option: Option.Option<A>): option is Option.Some<A> {
  return Option.isSome(option);
}

const runWithDelivery = <A, E, EController = never>(
  make: (delivery: ProviderRuntimeDelivery<EController>) => Effect.Effect<A, E, Scope.Scope>,
  handlers: {
    readonly processEvent: (
      source: ProviderRuntimeSource,
      event: ProviderRuntimeEvent,
    ) => Effect.Effect<void, EController>;
    readonly onSourceEnded?: () => Effect.Effect<void, EController>;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const delivery = yield* makeProviderRuntimeDelivery({
        processEvent: handlers.processEvent,
        onSourceEnded: handlers.onSourceEnded ?? (() => Effect.void),
      });
      return yield* make(delivery);
    }),
  );

describe("ProviderRuntimeDelivery", () => {
  it.effect("atomically registers one reader for concurrent attachment", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter();

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const first = yield* delivery
              .attach(INSTANCE, adapter.adapter)
              .pipe(Effect.forkChild({ startImmediately: true }));
            const second = yield* delivery
              .attach(INSTANCE, adapter.adapter)
              .pipe(Effect.forkChild({ startImmediately: true }));
            const firstSource = yield* Fiber.join(first);
            const secondSource = yield* Fiber.join(second);
            expect(isSome(firstSource)).toBe(true);
            expect(isSome(secondSource)).toBe(true);
            if (isSome(firstSource) && isSome(secondSource)) {
              expect(secondSource.value).toBe(firstSource.value);
            }
            yield* Deferred.await(adapter.streamSubscribed);
            expect(adapter.streamSubscriptionCount()).toBe(1);
            yield* adapter.shutdown();
          }),
        { processEvent: () => Effect.void },
      );
    }),
  );

  it.effect("fails instead of acknowledging a source owned by another delivery", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter();
      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const foreign = {
              instanceId: INSTANCE,
              adapter: adapter.adapter,
              isAdmitted: () => true,
              isPublishing: () => true,
            } satisfies ProviderRuntimeSource;
            const result = yield* Effect.exit(delivery.flush(foreign));
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) {
              const error = Cause.squash(result.cause);
              expect(error).toBeInstanceOf(ProviderRuntimeSourceNotOwnedError);
              if (error instanceof ProviderRuntimeSourceNotOwnedError) {
                expect(error.message).toBe("Provider runtime source is not owned by this delivery");
              }
            }
          }),
        { processEvent: () => Effect.void },
      );
    }),
  );

  it.effect("keeps old records addressable after withdrawal and drains a missing old source", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter();
      const ended = yield* Deferred.make<void>();
      const result = yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            yield* delivery.beforeClose(INSTANCE, adapter.adapter);
            const source = delivery.get(INSTANCE, adapter.adapter);
            expect(source).toBeDefined();
            if (source === undefined) return yield* Effect.die("missing old source");
            expect(source.isAdmitted()).toBe(false);
            expect(source.isPublishing()).toBe(true);
            yield* Deferred.await(adapter.streamSubscribed);
            yield* adapter.end();
            yield* delivery.afterClose(INSTANCE, adapter.adapter);
            expect(delivery.get(INSTANCE, adapter.adapter)).toBe(source);
            expect(source.isPublishing()).toBe(false);
            expect(delivery.isEventAllowed(makeEvent({ eventId: "retired" }))).toBe(true);
            yield* Deferred.succeed(ended, undefined);
          }),
        {
          processEvent: () => Effect.void,
          onSourceEnded: () => Deferred.succeed(ended, undefined).pipe(Effect.asVoid),
        },
      );
      expect(result).toBeUndefined();
    }),
  );

  it.effect(
    "does not revive stale adapters and admits fresh generation after reader completion",
    () =>
      Effect.gen(function* () {
        const oldAdapter = yield* makeFakeAdapter();
        const newAdapter = yield* makeFakeAdapter();
        const reconciliationStarted = yield* Deferred.make<void>();
        const reconciliationRelease = yield* Deferred.make<void>();
        const sourceEnded = () =>
          Deferred.succeed(reconciliationStarted, undefined).pipe(
            Effect.andThen(Deferred.await(reconciliationRelease)),
          );

        yield* runWithDelivery(
          (delivery) =>
            Effect.gen(function* () {
              const attached = yield* delivery.attach(INSTANCE, oldAdapter.adapter);
              expect(isSome(attached)).toBe(true);
              if (!isSome(attached)) return yield* Effect.die("old source did not attach");
              const oldSource = attached.value;
              yield* Deferred.await(oldAdapter.streamSubscribed);
              yield* delivery.beforeClose(INSTANCE, oldAdapter.adapter);
              yield* oldAdapter.end();

              const afterClose = yield* delivery
                .afterClose(INSTANCE, oldAdapter.adapter)
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Deferred.await(reconciliationStarted);
              expect(delivery.get(INSTANCE, oldAdapter.adapter)).toBe(oldSource);
              expect((yield* delivery.attach(INSTANCE, oldAdapter.adapter))._tag).toBe("None");
              const freshWhileReconciling = yield* delivery.attach(INSTANCE, newAdapter.adapter);
              expect(isSome(freshWhileReconciling)).toBe(true);

              yield* Deferred.succeed(reconciliationRelease, undefined);
              yield* Fiber.join(afterClose);
              const fresh = yield* delivery.attach(INSTANCE, newAdapter.adapter);
              expect(isSome(fresh)).toBe(true);
              expect(delivery.get(INSTANCE, oldAdapter.adapter)).toBe(oldSource);
              yield* newAdapter.shutdown();
            }),
          { processEvent: () => Effect.void, onSourceEnded: sourceEnded },
        );
      }),
  );

  it.effect("keeps an unrelated instance working while an old reader is held", () =>
    Effect.gen(function* () {
      const main = yield* makeFakeAdapter();
      const other = yield* makeFakeAdapter();
      const mainProcessing = yield* Deferred.make<void>();
      const releaseMain = yield* Deferred.make<void>();
      const otherProcessed = yield* Deferred.make<void>();

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const mainSource = yield* delivery.attach(INSTANCE, main.adapter);
            const otherSource = yield* delivery.attach(OTHER_INSTANCE, other.adapter);
            expect(isSome(mainSource)).toBe(true);
            expect(isSome(otherSource)).toBe(true);
            yield* Deferred.await(main.streamSubscribed);
            yield* Deferred.await(other.streamSubscribed);
            yield* delivery.beforeClose(INSTANCE, main.adapter);
            yield* main.offer(makeEvent({ eventId: "main-held" }));
            yield* Deferred.await(mainProcessing);
            yield* other.offer(makeEvent({ eventId: "other-live", threadId: OTHER_THREAD }));
            yield* Deferred.await(otherProcessed);
            expect(delivery.get(OTHER_INSTANCE, other.adapter)).toBeDefined();
            expect(delivery.sources()).toHaveLength(2);
            yield* Deferred.succeed(releaseMain, undefined);
            yield* main.end();
            yield* other.end();
            yield* delivery.afterClose(INSTANCE, main.adapter);
          }),
        {
          processEvent: (_source, event) =>
            event.threadId === THREAD
              ? Deferred.succeed(mainProcessing, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseMain)),
                )
              : Deferred.succeed(otherProcessed, undefined).pipe(Effect.asVoid),
        },
      );
    }),
  );

  it.effect("does not complete afterClose until the in-flight process callback releases", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter();
      const processingStarted = yield* Deferred.make<void>();
      const releaseProcessing = yield* Deferred.make<void>();
      const afterCloseDone = yield* Deferred.make<void>();
      const sourceEnded = yield* Deferred.make<void>();

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            yield* adapter.offer(makeEvent({ eventId: "held-process" }));
            yield* Deferred.await(processingStarted);
            yield* delivery.beforeClose(INSTANCE, adapter.adapter);
            const afterClose = yield* delivery
              .afterClose(INSTANCE, adapter.adapter)
              .pipe(
                Effect.ensuring(Deferred.succeed(afterCloseDone, undefined).pipe(Effect.asVoid)),
                Effect.forkChild({ startImmediately: true }),
              );
            yield* Effect.yieldNow;
            expect(Option.isNone(yield* Deferred.poll(afterCloseDone))).toBe(true);
            expect(attached.value.isPublishing()).toBe(true);
            yield* Deferred.succeed(releaseProcessing, undefined);
            yield* adapter.end();
            yield* Fiber.join(afterClose);
            yield* Deferred.await(sourceEnded);
            expect(attached.value.isPublishing()).toBe(false);
          }),
        {
          processEvent: () =>
            Deferred.succeed(processingStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProcessing)),
            ),
          onSourceEnded: () => Deferred.succeed(sourceEnded, undefined).pipe(Effect.asVoid),
        },
      );
    }),
  );

  it.effect("fails an afterClose timeout while the old reader still blocks admission", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter();
      const replacement = yield* makeFakeAdapter();
      const processingStarted = yield* Deferred.make<void>();
      const releaseProcessing = yield* Deferred.make<void>();
      const afterCloseDone = yield* Deferred.make<void>();
      const sourceEnded = yield* Deferred.make<void>();

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            yield* adapter.offer(makeEvent({ eventId: "timeout-process" }));
            yield* Deferred.await(processingStarted);
            yield* delivery.beforeClose(INSTANCE, adapter.adapter);
            const afterClose = yield* delivery
              .afterClose(INSTANCE, adapter.adapter)
              .pipe(
                Effect.ensuring(Deferred.succeed(afterCloseDone, undefined).pipe(Effect.asVoid)),
                Effect.forkChild({ startImmediately: true }),
              );
            yield* TestClock.adjust("5 seconds");
            yield* Deferred.await(afterCloseDone);
            const afterCloseResult = yield* Effect.exit(Fiber.join(afterClose));
            expect(Exit.isFailure(afterCloseResult)).toBe(true);
            if (Exit.isFailure(afterCloseResult)) {
              expect(Cause.squash(afterCloseResult.cause)).toBeInstanceOf(Cause.TimeoutError);
            }
            expect((yield* delivery.attach(INSTANCE, replacement.adapter))._tag).toBe("None");
            yield* Deferred.succeed(releaseProcessing, undefined);
            yield* adapter.end();
            yield* Deferred.await(sourceEnded);
            yield* Effect.exit(Fiber.join(afterClose));
            const fresh = yield* delivery.attach(INSTANCE, replacement.adapter);
            expect(isSome(fresh)).toBe(true);
          }),
        {
          processEvent: () =>
            Deferred.succeed(processingStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProcessing)),
            ),
          onSourceEnded: () => Deferred.succeed(sourceEnded, undefined).pipe(Effect.asVoid),
        },
      );
    }),
  );

  it.effect("releases the old generation before source-ended reconciliation", () =>
    Effect.gen(function* () {
      const oldAdapter = yield* makeFakeAdapter();
      const freshAdapter = yield* makeFakeAdapter();
      const callbackResult = yield* Deferred.make<Option.Option<ProviderRuntimeSource>>();
      let delivery: ProviderRuntimeDelivery | undefined;
      let attachedFresh = false;

      yield* runWithDelivery(
        (created) => {
          delivery = created;
          return Effect.gen(function* () {
            const attached = yield* created.attach(INSTANCE, oldAdapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("old source did not attach");
            yield* Deferred.await(oldAdapter.streamSubscribed);
            yield* created.beforeClose(INSTANCE, oldAdapter.adapter);
            yield* oldAdapter.end();

            const observed = yield* Deferred.await(callbackResult);
            expect(Option.isSome(observed)).toBe(true);
            yield* Deferred.await(freshAdapter.streamSubscribed);
            yield* freshAdapter.shutdown();
          });
        },
        {
          processEvent: () => Effect.void,
          onSourceEnded: () =>
            Effect.gen(function* () {
              if (attachedFresh || delivery === undefined) return;
              attachedFresh = true;
              const fresh = yield* delivery.attach(INSTANCE, freshAdapter.adapter);
              yield* Deferred.succeed(callbackResult, fresh);
            }),
        },
      );
    }),
  );

  it.effect("allows source-ended reconciliation after a timed-out drain", () =>
    Effect.gen(function* () {
      const drainStarted = yield* Deferred.make<void>();
      const releaseDrain = yield* Deferred.make<void>();
      const drainEnded = yield* Deferred.make<void>();
      const oldAdapter = yield* makeFakeAdapter({
        drainEvents: () =>
          Effect.uninterruptible(
            Deferred.succeed(drainStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDrain)),
              Effect.andThen(Deferred.succeed(drainEnded, undefined)),
              Effect.as(true),
            ),
          ),
      });
      const freshAdapter = yield* makeFakeAdapter();
      const callbackResult = yield* Deferred.make<Option.Option<ProviderRuntimeSource>>();
      let delivery: ProviderRuntimeDelivery | undefined;
      let attachedFresh = false;

      yield* runWithDelivery(
        (created) => {
          delivery = created;
          return Effect.gen(function* () {
            const attached = yield* created.attach(INSTANCE, oldAdapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("old source did not attach");
            yield* Deferred.await(oldAdapter.streamSubscribed);

            const flush = yield* created
              .flush(attached.value)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(drainStarted);
            yield* TestClock.adjust("5 seconds");
            const flushResult = yield* Effect.exit(Fiber.join(flush));
            const timedOut = Exit.isFailure(flushResult);

            yield* oldAdapter.end();
            const observed = yield* Deferred.await(callbackResult);
            expect(Option.isSome(observed)).toBe(true);
            yield* Deferred.succeed(releaseDrain, undefined);
            yield* Deferred.await(drainEnded);
            expect(timedOut).toBe(true);
            yield* Deferred.await(freshAdapter.streamSubscribed);
            yield* freshAdapter.shutdown();
          });
        },
        {
          processEvent: () => Effect.void,
          onSourceEnded: () =>
            Effect.gen(function* () {
              if (attachedFresh || delivery === undefined) return;
              attachedFresh = true;
              const fresh = yield* delivery.attach(INSTANCE, freshAdapter.adapter);
              yield* Deferred.succeed(callbackResult, fresh);
            }),
        },
      );
    }),
  );

  it.effect("continues reading after a process failure and reports it at the next flush", () =>
    Effect.gen(function* () {
      const secondProcessed = yield* Deferred.make<void>();
      const adapter = yield* makeFakeAdapter({
        drainEvents: () => Deferred.await(secondProcessed).pipe(Effect.as(true)),
      });
      const firstError = new ProcessReceiptError({ message: "first process receipt failed" });
      const seen: Array<string> = [];

      yield* runWithDelivery<void, never, ProcessReceiptError>(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            yield* adapter.offer(makeEvent({ eventId: "first-failure" }));
            yield* adapter.offer(makeEvent({ eventId: "second-success" }));
            const flushed = yield* Effect.exit(delivery.flush(attached.value));
            expect(Exit.isFailure(flushed)).toBe(true);
            expect(seen).toEqual(["first-failure", "second-success"]);
            if (Exit.isFailure(flushed)) expect(Cause.squash(flushed.cause)).toBe(firstError);
            yield* adapter.shutdown();
          }),
        {
          processEvent: (_source, event) =>
            Effect.gen(function* () {
              seen.push(String(event.eventId));
              if (seen.length === 1) return yield* firstError;
              yield* Deferred.succeed(secondProcessed, undefined);
            }),
        },
      );
    }),
  );

  it.effect("waits for the real reader callback when drainEvents reports an ended stream", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter({ drainEvents: () => Effect.succeed(false) });
      const processingStarted = yield* Deferred.make<void>();
      const releaseProcessing = yield* Deferred.make<void>();
      const sourceEnded = yield* Deferred.make<void>();
      const flushDone = yield* Deferred.make<void>();

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            yield* adapter.offer(makeEvent({ eventId: "false-ended" }));
            yield* Deferred.await(processingStarted);
            yield* adapter.end();

            const flush = yield* delivery
              .flush(attached.value)
              .pipe(
                Effect.ensuring(Deferred.succeed(flushDone, undefined).pipe(Effect.asVoid)),
                Effect.forkChild,
              );
            yield* Effect.yieldNow;
            expect(Option.isNone(yield* Deferred.poll(flushDone))).toBe(true);
            yield* Deferred.succeed(releaseProcessing, undefined);
            yield* Fiber.join(flush);
            yield* Deferred.await(sourceEnded);
          }),
        {
          processEvent: () =>
            Deferred.succeed(processingStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseProcessing)),
            ),
          onSourceEnded: () => Deferred.succeed(sourceEnded, undefined).pipe(Effect.asVoid),
        },
      );
    }),
  );

  it.effect("uses a true drain barrier only after prior processing completes", () =>
    Effect.gen(function* () {
      const processingDone = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const adapter = yield* makeFakeAdapter({
        drainEvents: () =>
          Effect.sync(() => {
            order.push("drain");
          }).pipe(Effect.andThen(Deferred.await(processingDone)), Effect.as(true)),
      });
      const flushed = yield* Deferred.make<void>();

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            yield* adapter.offer(makeEvent({ eventId: "true-barrier" }));
            const flush = yield* delivery
              .flush(attached.value)
              .pipe(
                Effect.ensuring(Deferred.succeed(flushed, undefined).pipe(Effect.asVoid)),
                Effect.forkChild,
              );
            yield* Deferred.await(processingDone);
            yield* Fiber.join(flush);
            order.push("flushed");
            expect(order.indexOf("drain")).toBeGreaterThanOrEqual(0);
            expect(order.indexOf("flushed")).toBeGreaterThan(order.indexOf("drain"));
          }),
        {
          processEvent: () =>
            Effect.sync(() => {
              order.push("processed");
            }).pipe(Effect.andThen(Deferred.succeed(processingDone, undefined)), Effect.asVoid),
        },
      );
      expect(order.indexOf("processed")).toBeLessThan(order.indexOf("flushed"));
    }),
  );

  it.effect("runs a separate barrier for each concurrent flush", () =>
    Effect.gen(function* () {
      const firstDrainStarted = yield* Deferred.make<void>();
      const secondDrainStarted = yield* Deferred.make<void>();
      const releaseFirstDrain = yield* Deferred.make<void>();
      const releaseSecondDrain = yield* Deferred.make<void>();
      const eventProcessed = yield* Deferred.make<void>();
      const firstFlushDone = yield* Deferred.make<void>();
      const secondFlushDone = yield* Deferred.make<void>();
      let drainCalls = 0;
      const adapter = yield* makeFakeAdapter({
        drainEvents: () =>
          Effect.gen(function* () {
            drainCalls += 1;
            if (drainCalls === 1) {
              yield* Deferred.succeed(firstDrainStarted, undefined);
              yield* Deferred.await(releaseFirstDrain);
            } else {
              yield* Deferred.succeed(secondDrainStarted, undefined);
              yield* Deferred.await(releaseSecondDrain);
            }
            return true;
          }),
      });

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");

            const first = yield* delivery
              .flush(attached.value)
              .pipe(
                Effect.ensuring(Deferred.succeed(firstFlushDone, undefined).pipe(Effect.asVoid)),
                Effect.forkChild({ startImmediately: true }),
              );
            yield* Deferred.await(firstDrainStarted);
            yield* adapter.offer(makeEvent({ eventId: "between-barriers" }));
            yield* Deferred.await(eventProcessed);
            const second = yield* delivery
              .flush(attached.value)
              .pipe(
                Effect.ensuring(Deferred.succeed(secondFlushDone, undefined).pipe(Effect.asVoid)),
                Effect.forkChild({ startImmediately: true }),
              );
            const secondStartedWait = yield* Deferred.await(secondDrainStarted).pipe(
              Effect.timeoutOption("1 second"),
              Effect.forkChild({ startImmediately: true }),
            );
            yield* TestClock.adjust("1 second");
            expect(Option.isSome(yield* Fiber.join(secondStartedWait))).toBe(true);
            expect(drainCalls).toBe(2);
            expect(attached.value.isAdmitted()).toBe(true);

            yield* Deferred.succeed(releaseFirstDrain, undefined);
            yield* Fiber.join(first);
            yield* Deferred.await(firstFlushDone);
            expect(Option.isNone(yield* Deferred.poll(secondFlushDone))).toBe(true);
            yield* Deferred.succeed(releaseSecondDrain, undefined);
            yield* Fiber.join(second);
            expect(attached.value.isAdmitted()).toBe(true);
            yield* adapter.shutdown();
          }),
        {
          processEvent: (_source, event) =>
            Effect.sync(() => {
              if (event.eventId === EventId.make("between-barriers")) {
                return Deferred.succeed(eventProcessed, undefined);
              }
              return Effect.void;
            }).pipe(Effect.flatten, Effect.asVoid),
        },
      );
    }),
  );

  it.effect("bounds a stuck drain without interrupting it or reopening admission", () =>
    Effect.gen(function* () {
      const drainStarted = yield* Deferred.make<void>();
      const releaseDrain = yield* Deferred.make<void>();
      const flushDone = yield* Deferred.make<void>();
      const adapter = yield* makeFakeAdapter({
        drainEvents: () =>
          Effect.uninterruptible(
            Deferred.succeed(drainStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDrain)),
              Effect.as(true),
            ),
          ),
      });
      const replacement = yield* makeFakeAdapter();

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            const flush = yield* delivery
              .flush(attached.value)
              .pipe(
                Effect.ensuring(Deferred.succeed(flushDone, undefined).pipe(Effect.asVoid)),
                Effect.forkChild,
              );
            yield* Deferred.await(drainStarted);
            yield* TestClock.adjust("5 seconds");
            yield* Deferred.await(flushDone);
            expect(attached.value.isAdmitted()).toBe(false);
            expect((yield* delivery.attach(INSTANCE, replacement.adapter))._tag).toBe("None");
            yield* Deferred.succeed(releaseDrain, undefined);
            const flushResult = yield* Effect.exit(Fiber.join(flush));
            expect(Exit.isFailure(flushResult)).toBe(true);
            if (Exit.isFailure(flushResult)) {
              expect(Cause.squash(flushResult.cause)).toBeInstanceOf(Cause.TimeoutError);
            }
            expect(attached.value.isAdmitted()).toBe(true);
            yield* adapter.shutdown();
          }),
        { processEvent: () => Effect.void },
      );
    }),
  );

  it.effect(
    "keeps retiring publication allowed, but closes admission and inherited event guards",
    () =>
      Effect.gen(function* () {
        const adapter = yield* makeFakeAdapter();
        const replacement = yield* makeFakeAdapter();
        const original = makeEvent({ eventId: "guard-original" });
        const derived = makeEvent({ eventId: "guard-derived" });
        const sameObject = makeEvent({ eventId: "guard-same-object" });
        const calls: Array<string> = [];

        yield* runWithDelivery(
          (delivery) =>
            Effect.gen(function* () {
              const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
              expect(isSome(attached)).toBe(true);
              if (!isSome(attached)) return yield* Effect.die("source did not attach");
              const same = yield* delivery.attach(INSTANCE, adapter.adapter);
              expect(isSome(same)).toBe(true);
              if (isSome(same)) expect(same.value).toBe(attached.value);
              expect((yield* delivery.attach(INSTANCE, replacement.adapter))._tag).toBe("None");
              yield* Deferred.await(adapter.streamSubscribed);
              yield* delivery.registerConsumer(() =>
                Effect.sync(() => {
                  calls.push("consumer-1");
                }),
              );
              yield* delivery.registerConsumer(() =>
                Effect.sync(() => {
                  calls.push("consumer-2");
                }),
              );
              delivery.tag(original, attached.value);
              delivery.inheritTag(derived, original);
              delivery.tag(sameObject, attached.value);
              delivery.inheritTag(sameObject, sameObject);
              yield* delivery.deliver(original, (isAllowed) =>
                Effect.sync(() => {
                  expect(isAllowed()).toBe(true);
                  calls.push("publish");
                }),
              );
              expect(calls).toEqual(["consumer-1", "consumer-2", "publish"]);

              yield* delivery.closeAdmission;
              expect(attached.value.isAdmitted()).toBe(false);
              expect(attached.value.isPublishing()).toBe(true);
              yield* delivery.deliver(derived, () =>
                Effect.sync(() => {
                  calls.push("publish-after-admission-close");
                }),
              );
              expect(calls.at(-1)).toBe("publish-after-admission-close");

              yield* delivery.beforeClose(INSTANCE, adapter.adapter);
              expect(attached.value.isAdmitted()).toBe(false);
              expect(attached.value.isPublishing()).toBe(true);
              yield* adapter.end();
              yield* delivery.afterClose(INSTANCE, adapter.adapter);
              expect(attached.value.isPublishing()).toBe(false);
              expect(delivery.isEventAllowed(derived)).toBe(false);
              expect(delivery.isEventAllowed(sameObject)).toBe(false);
              expect(delivery.isEventAllowed(makeEvent({ eventId: "untagged" }))).toBe(true);
            }),
          { processEvent: () => Effect.void },
        );
      }),
  );

  it.effect("continues past a captured consumer that was removed before its turn", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter();
      const consumerScope = yield* Scope.make();
      const calls: Array<string> = [];

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");

            yield* delivery.registerConsumer(() =>
              Effect.gen(function* () {
                calls.push("closer");
                yield* Scope.close(consumerScope, Exit.void);
              }),
            );
            yield* Scope.provide(consumerScope)(
              delivery.registerConsumer(() =>
                Effect.sync(() => {
                  calls.push("removed");
                }),
              ),
            );
            yield* delivery.registerConsumer(() =>
              Effect.sync(() => {
                calls.push("remaining");
              }),
            );

            const event = makeEvent({ eventId: "consumer-removed-before-turn" });
            delivery.tag(event, attached.value);
            yield* delivery.deliver(event, () =>
              Effect.sync(() => {
                calls.push("publish");
              }),
            );
            expect(calls).toEqual(["closer", "remaining", "publish"]);
            yield* adapter.shutdown();
          }),
        { processEvent: () => Effect.void },
      );
    }),
  );

  it.effect("records consumer failures so flush reports the actual downstream error", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFakeAdapter({ drainEvents: () => Effect.succeed(true) });
      const consumerError = new ConsumerReceiptError({
        message: "consumer database receipt failed",
      });
      const event = makeEvent({ eventId: "consumer-failure" });

      yield* runWithDelivery<void, never, ConsumerReceiptError>(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* delivery.registerConsumer(() => Effect.fail(consumerError));
            delivery.tag(event, attached.value);
            const delivered = yield* Effect.exit(delivery.deliver(event, () => Effect.void));
            expect(Exit.isFailure(delivered)).toBe(true);
            const flushed = yield* Effect.exit(delivery.flush(attached.value));
            expect(Exit.isFailure(flushed)).toBe(true);
            if (Exit.isFailure(flushed)) {
              expect(Cause.squash(flushed.cause)).toBe(consumerError);
            }
            yield* adapter.shutdown();
          }),
        { processEvent: () => Effect.void },
      );
    }),
  );

  it.effect("keeps exit intents through flush finalization and preserves body failures", () =>
    Effect.gen(function* () {
      const processed = yield* Deferred.make<void>();
      const seen: Array<ProviderRuntimeEvent> = [];
      const adapter = yield* makeFakeAdapter({
        drainEvents: () => Deferred.await(processed).pipe(Effect.as(true)),
      });
      const bodyError = new Error("stop operation failed");

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            const body = Effect.gen(function* () {
              yield* adapter.offer(makeEvent({ eventId: "intent-graceful", exitKind: "graceful" }));
              yield* adapter.offer(
                makeEvent({
                  eventId: "intent-other-provider",
                  provider: OTHER_PROVIDER,
                  exitKind: "graceful",
                }),
              );
              return yield* Effect.fail(bodyError);
            });
            const result = yield* Effect.exit(
              delivery.withExitIntent(attached.value, THREAD, () => "replace", body),
            );
            expect(Exit.isFailure(result)).toBe(true);
            if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(bodyError);
            expect(seen).toHaveLength(2);
            expect(seen[0]).toMatchObject({
              payload: { exitKind: "graceful", recoverable: true, reason: "Session replaced." },
            });
            const otherProviderEvent = seen[1];
            if (otherProviderEvent === undefined) return yield* Effect.die("missing second event");
            expect(otherProviderEvent).toMatchObject({
              provider: OTHER_PROVIDER,
              payload: { exitKind: "graceful" },
            });
            expect(
              (otherProviderEvent.payload as { readonly recoverable?: boolean }).recoverable,
            ).toBeUndefined();
          }),
        {
          processEvent: (_source, event) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => {
                seen.push(event);
              });
              if (seen.length === 2) yield* Deferred.succeed(processed, undefined);
            }),
        },
      );
    }),
  );

  it.effect("lets an exit-intent flush time out without cancelling the adapter drain", () =>
    Effect.gen(function* () {
      const drainStarted = yield* Deferred.make<void>();
      const releaseDrain = yield* Deferred.make<void>();
      const drainEnded = yield* Deferred.make<void>();
      const adapter = yield* makeFakeAdapter({
        drainEvents: () =>
          Effect.uninterruptible(
            Deferred.succeed(drainStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDrain)),
              Effect.andThen(Deferred.succeed(drainEnded, undefined)),
              Effect.as(true),
            ),
          ),
      });

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");

            const intent = yield* delivery
              .withExitIntent(attached.value, THREAD, () => "stop", Effect.void)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(drainStarted);
            yield* TestClock.adjust("5 seconds");
            const intentResult = yield* Effect.exit(Fiber.join(intent));
            expect(Exit.isFailure(intentResult)).toBe(true);
            if (Exit.isFailure(intentResult)) {
              expect(Cause.squash(intentResult.cause)).toBeInstanceOf(Cause.TimeoutError);
            }
            expect(attached.value.isAdmitted()).toBe(false);

            yield* Deferred.succeed(releaseDrain, undefined);
            yield* Deferred.await(drainEnded);
            yield* Effect.yieldNow;
            expect(attached.value.isAdmitted()).toBe(true);
            yield* adapter.shutdown();
          }),
        { processEvent: () => Effect.void },
      );
    }),
  );

  it.effect("keeps a timed-out exit intent until its own drain actually completes", () =>
    Effect.gen(function* () {
      const heldProcessingStarted = yield* Deferred.make<void>();
      const releaseHeldProcessing = yield* Deferred.make<void>();
      const drainStarted = yield* Deferred.make<void>();
      const releaseDrain = yield* Deferred.make<void>();
      const drainReturned = yield* Deferred.make<void>();
      const lateProcessed = yield* Deferred.make<void>();
      const postProcessed = yield* Deferred.make<void>();
      const seen: Array<ProviderRuntimeEvent> = [];
      const adapter = yield* makeFakeAdapter({
        drainEvents: () =>
          Effect.uninterruptible(
            Deferred.succeed(drainStarted, undefined).pipe(
              Effect.andThen(Deferred.await(lateProcessed)),
              Effect.andThen(Deferred.await(releaseDrain)),
              Effect.andThen(Deferred.succeed(drainReturned, undefined)),
              Effect.as(true),
            ),
          ),
      });

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");
            yield* Deferred.await(adapter.streamSubscribed);
            yield* adapter.offer(makeEvent({ eventId: "held-callback" }));
            yield* Deferred.await(heldProcessingStarted);

            const intent = yield* delivery
              .withExitIntent(
                attached.value,
                THREAD,
                () => "replace",
                adapter.offer(makeEvent({ eventId: "late-graceful", exitKind: "graceful" })),
              )
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(drainStarted);
            yield* TestClock.adjust(LIFECYCLE_WAIT);

            const timedOut = yield* Effect.exit(Fiber.join(intent));
            expect(Exit.isFailure(timedOut)).toBe(true);
            if (Exit.isFailure(timedOut)) {
              expect(Cause.squash(timedOut.cause)).toBeInstanceOf(Cause.TimeoutError);
            }
            expect(seen).toHaveLength(1);

            yield* Deferred.succeed(releaseHeldProcessing, undefined);
            yield* Deferred.await(lateProcessed);
            const late = seen.find((event) => event.eventId === EventId.make("late-graceful"));
            expect(late).toMatchObject({
              payload: { exitKind: "graceful", recoverable: true, reason: "Session replaced." },
            });

            yield* Deferred.succeed(releaseDrain, undefined);
            yield* Deferred.await(drainReturned);
            yield* Effect.yieldNow;
            yield* adapter.offer(makeEvent({ eventId: "after-intent", exitKind: "graceful" }));
            yield* Deferred.await(postProcessed);
            const afterIntent = seen.find(
              (event) => event.eventId === EventId.make("after-intent"),
            );
            if (afterIntent === undefined) return yield* Effect.die("missing post-intent event");
            expect(afterIntent).toMatchObject({ payload: { exitKind: "graceful" } });
            expect((afterIntent.payload as { readonly reason?: string }).reason).toBeUndefined();
            expect(
              (afterIntent.payload as { readonly recoverable?: boolean }).recoverable,
            ).toBeUndefined();
            yield* adapter.shutdown();
          }),
        {
          processEvent: (_source, event) =>
            Effect.gen(function* () {
              seen.push(event);
              if (event.eventId === EventId.make("held-callback")) {
                yield* Deferred.succeed(heldProcessingStarted, undefined);
                yield* Deferred.await(releaseHeldProcessing);
              } else if (event.eventId === EventId.make("late-graceful")) {
                yield* Deferred.succeed(lateProcessed, undefined);
              } else if (event.eventId === EventId.make("after-intent")) {
                yield* Deferred.succeed(postProcessed, undefined);
              }
            }),
        },
      );
    }),
  );

  it.effect("runs the bounded exit-intent flush after the body is interrupted", () =>
    Effect.gen(function* () {
      const bodyStarted = yield* Deferred.make<void>();
      const bodyRelease = yield* Deferred.make<void>();
      const drainStarted = yield* Deferred.make<void>();
      const releaseDrain = yield* Deferred.make<void>();
      const adapter = yield* makeFakeAdapter({
        drainEvents: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(drainStarted, undefined);
            yield* Deferred.await(releaseDrain);
            return true;
          }),
      });

      yield* runWithDelivery(
        (delivery) =>
          Effect.gen(function* () {
            const attached = yield* delivery.attach(INSTANCE, adapter.adapter);
            expect(isSome(attached)).toBe(true);
            if (!isSome(attached)) return yield* Effect.die("source did not attach");

            const intent = yield* delivery
              .withExitIntent(
                attached.value,
                THREAD,
                () => "stop",
                Deferred.succeed(bodyStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(bodyRelease)),
                ),
              )
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(bodyStarted);

            const interrupt = yield* Fiber.interrupt(intent).pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            const drainObserved = yield* Deferred.await(drainStarted).pipe(
              Effect.timeoutOption(LIFECYCLE_WAIT),
              Effect.forkChild({ startImmediately: true }),
            );
            yield* TestClock.adjust(LIFECYCLE_WAIT);
            expect(Option.isSome(yield* Fiber.join(drainObserved))).toBe(true);
            yield* Deferred.succeed(releaseDrain, undefined);
            yield* Fiber.join(interrupt);
            yield* adapter.shutdown();
          }),
        { processEvent: () => Effect.void },
      );
    }),
  );
});
