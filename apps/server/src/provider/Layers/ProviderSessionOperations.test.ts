import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { ProviderSessionSupersededError } from "../Errors.ts";
import {
  makeProviderSessionOperations,
  type ProviderSessionOperations,
} from "./ProviderSessionOperations.ts";

const thread = ThreadId.make("provider-session-operations-thread");

const withOperations = <A, E, R>(
  use: (operations: ProviderSessionOperations) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const operations = yield* makeProviderSessionOperations;
      return yield* use(operations);
    }),
  );

const isSuperseded = (exit: Exit.Exit<unknown, unknown>): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) => reason._tag === "Fail" && reason.error instanceof ProviderSessionSupersededError,
  );

const successValue = <A, E>(exit: Exit.Exit<A, E>): A => {
  assert.isTrue(
    Exit.isSuccess(exit),
    Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "unexpected success",
  );
  if (Exit.isFailure(exit)) throw new Error(Cause.pretty(exit.cause));
  return exit.value;
};

describe("ProviderSessionOperations", () => {
  it.effect("does not let an old stop settle after a replacement start commits", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const oldSource = {};
        const replacementSource = {};
        const oldStarted = yield* Deferred.make<void>();
        const oldRelease = yield* Deferred.make<void>();
        const replacementStarted = yield* Deferred.make<void>();
        const replacementRelease = yield* Deferred.make<void>();
        const oldCleanup = { value: 0 };
        const replacementCleanup = { value: 0 };
        const oldCommit = { value: 0 };

        const oldFiber = yield* operations
          .start({
            threadId: thread,
            source: oldSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(oldStarted, undefined);
                yield* Effect.uninterruptible(Deferred.await(oldRelease));
                return "old";
              }),
            cleanup: () =>
              Effect.sync(() => {
                oldCleanup.value += 1;
              }),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(oldStarted);

        const ticket = yield* operations.beginStop(thread);
        yield* Deferred.succeed(oldRelease, undefined);

        const replacementFiber = yield* operations
          .start({
            threadId: thread,
            source: replacementSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(replacementStarted, undefined);
                yield* Deferred.await(replacementRelease);
                return "replacement";
              }),
            cleanup: () =>
              Effect.sync(() => {
                replacementCleanup.value += 1;
              }),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(replacementStarted);

        const stopFiber = yield* operations
          .settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.sync(() => {
              oldCommit.value += 1;
            }),
          })
          .pipe(Effect.forkChild);

        yield* Deferred.succeed(replacementRelease, undefined);
        const replacementExit = yield* Fiber.await(replacementFiber);
        const stopExit = yield* Fiber.await(stopFiber);
        const oldExit = yield* Fiber.await(oldFiber);

        assert.strictEqual(successValue(replacementExit), "replacement");
        assert.isTrue(Exit.isSuccess(stopExit));
        assert.isTrue(isSuperseded(oldExit));
        assert.strictEqual(oldCommit.value, 0);
        assert.strictEqual(oldCleanup.value, 1);
        assert.strictEqual(replacementCleanup.value, 0);
        assert.isFalse(ticket.isCurrent());
      }),
    ),
  );

  it.effect("releases a start permit when a synchronous body finishes during fork", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const firstSource = {};
        const secondSource = {};
        const firstCleanup = { value: 0 };

        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: firstSource,
            isSourceActive: () => true,
            operation: () => Effect.sync(() => "first"),
            cleanup: () =>
              Effect.sync(() => {
                firstCleanup.value += 1;
              }),
          }),
          "first",
        );
        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: secondSource,
            isSourceActive: () => true,
            operation: () => Effect.sync(() => "second"),
            cleanup: () => Effect.void,
          }),
          "second",
        );
        assert.strictEqual(firstCleanup.value, 0);
      }),
    ),
  );

  it.effect("keeps a held commit on the thread semaphore during retirement", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const oldSource = {};
        const replacementSource = {};
        const callbackStarted = yield* Deferred.make<void>();
        const releaseCallback = yield* Deferred.make<void>();
        const replacementStarted = yield* Deferred.make<void>();
        const writes: Array<string> = [];
        const oldToken = yield* operations.capture(thread, oldSource);

        const oldCommitFiber = yield* operations
          .commitIfCurrent(
            oldToken,
            Effect.gen(function* () {
              yield* Deferred.succeed(callbackStarted, undefined);
              yield* Deferred.await(releaseCallback);
              writes.push("old");
              return "old";
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(callbackStarted);

        yield* operations.retireSource(oldSource);
        const replacementFiber = yield* operations
          .start({
            threadId: thread,
            source: replacementSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(replacementStarted, undefined);
                writes.push("replacement");
                return "replacement";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        assert.strictEqual(writes.length, 0);
        assert.isTrue(Option.isNone(yield* Deferred.poll(replacementStarted)));
        yield* Deferred.succeed(releaseCallback, undefined);

        const oldExit = yield* Fiber.await(oldCommitFiber);
        const replacementExit = yield* Fiber.await(replacementFiber);
        const oldResult = successValue(oldExit);
        assert.isTrue(Option.isSome(oldResult));
        if (Option.isSome(oldResult)) assert.strictEqual(oldResult.value, "old");
        assert.strictEqual(successValue(replacementExit), "replacement");
        assert.deepStrictEqual(writes, ["old", "replacement"]);
      }),
    ),
  );

  it.effect("keeps a first stop settlement alive when a duplicate times out", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const replacementSource = {};
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const replacementStarted = yield* Deferred.make<void>();
        const writes: Array<string> = [];

        yield* operations.start({
          threadId: thread,
          source,
          isSourceActive: () => true,
          operation: () => Effect.succeed("running"),
          cleanup: () => Effect.void,
        });
        const ticket = yield* operations.beginStop(thread);
        const firstFiber = yield* operations
          .settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.gen(function* () {
              yield* Deferred.succeed(firstStarted, undefined);
              yield* Deferred.await(releaseFirst);
              writes.push("first");
            }),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);

        const duplicateFiber = yield* operations
          .settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.sync(() => {
              writes.push("duplicate");
            }),
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const duplicateExit = yield* Fiber.await(duplicateFiber);
        assert.isTrue(isSuperseded(duplicateExit));

        const replacementFiber = yield* operations
          .start({
            threadId: thread,
            source: replacementSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(replacementStarted, undefined);
                writes.push("replacement");
                return "replacement";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.isTrue(Option.isNone(yield* Deferred.poll(replacementStarted)));

        yield* Deferred.succeed(releaseFirst, undefined);
        const firstExit = yield* Fiber.await(firstFiber);
        const replacementExit = yield* Fiber.await(replacementFiber);
        assert.isTrue(Exit.isSuccess(firstExit));
        assert.strictEqual(successValue(replacementExit), "replacement");
        assert.deepStrictEqual(writes, ["first", "replacement"]);
      }),
    ),
  );

  it.effect("prunes an old stop generation while another generation commits", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const oldSource = {};
        const currentSource = {};
        const freshSource = {};
        const currentStarted = yield* Deferred.make<void>();
        const releaseCurrent = yield* Deferred.make<void>();
        const oldCommit = { value: 0 };

        yield* operations.start({
          threadId: thread,
          source: oldSource,
          isSourceActive: () => true,
          operation: () => Effect.succeed("old"),
          cleanup: () => Effect.void,
        });
        const oldTicket = yield* operations.beginStop(thread);
        yield* operations.start({
          threadId: thread,
          source: currentSource,
          isSourceActive: () => true,
          operation: () => Effect.succeed("current"),
          cleanup: () => Effect.void,
        });
        const currentToken = yield* operations.capture(thread, currentSource);
        const currentFiber = yield* operations
          .commitIfCurrent(
            currentToken,
            Effect.gen(function* () {
              yield* Deferred.succeed(currentStarted, undefined);
              yield* Deferred.await(releaseCurrent);
              return "current";
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(currentStarted);

        const oldSettleFiber = yield* operations
          .settleStop(oldTicket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.sync(() => {
              oldCommit.value += 1;
            }),
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const oldSettleExit = yield* Fiber.await(oldSettleFiber);
        assert.isTrue(isSuperseded(oldSettleExit));
        assert.strictEqual(oldCommit.value, 0);

        yield* Deferred.succeed(releaseCurrent, undefined);
        const currentExit = yield* Fiber.await(currentFiber);
        const currentResult = successValue(currentExit);
        assert.isTrue(Option.isSome(currentResult));
        if (Option.isSome(currentResult)) assert.strictEqual(currentResult.value, "current");

        const currentTicket = yield* operations.beginStop(thread);
        yield* operations.settleStop(currentTicket, {
          succeeded: true,
          isSourceCurrent: () => true,
          commit: Effect.void,
        });
        const freshToken = yield* operations.capture(thread, freshSource);
        const freshResult = yield* operations.commitIfCurrent(freshToken, Effect.succeed("fresh"));
        assert.isTrue(Option.isSome(freshResult));
        if (Option.isSome(freshResult)) assert.strictEqual(freshResult.value, "fresh");
      }),
    ),
  );

  it.effect("cleans up a canceled settlement before retiring and reusing the thread", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const oldSource = {};
        const freshSource = {};
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const staleCommit = { value: 0 };

        const startFiber = yield* operations
          .start({
            threadId: thread,
            source: oldSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.uninterruptible(Deferred.await(release));
                return "old";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        const ticket = yield* operations.beginStop(thread);
        const settleFiber = yield* operations
          .settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(settleFiber);
        const settleExit = yield* Fiber.await(settleFiber);
        assert.isTrue(Exit.isFailure(settleExit));

        yield* operations.retireSource(oldSource);
        yield* Deferred.succeed(release, undefined);
        yield* operations.drainStarts(oldSource);
        const startExit = yield* Fiber.await(startFiber);
        assert.isTrue(isSuperseded(startExit));

        const staleSettle = yield* Effect.exit(
          operations.settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => false,
            commit: Effect.sync(() => {
              staleCommit.value += 1;
            }),
          }),
        );
        assert.isTrue(Exit.isSuccess(staleSettle));
        assert.strictEqual(staleCommit.value, 0);

        const freshToken = yield* operations.capture(thread, freshSource);
        const freshResult = yield* operations.commitIfCurrent(freshToken, Effect.succeed("fresh"));
        assert.isTrue(Option.isSome(freshResult));
        if (Option.isSome(freshResult)) assert.strictEqual(freshResult.value, "fresh");
      }),
    ),
  );

  it.effect("replaces a healthy current generation and rejects its old token", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const firstSource = {};
        const secondSource = {};
        const failedSource = {};
        const firstCleanup = { value: 0 };
        const secondCleanup = { value: 0 };
        const failedCleanup = { value: 0 };
        const staleCommit = { value: 0 };

        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: firstSource,
            isSourceActive: () => true,
            operation: () => Effect.succeed("first"),
            cleanup: () =>
              Effect.sync(() => {
                firstCleanup.value += 1;
              }),
          }),
          "first",
        );
        const oldToken = yield* operations.capture(thread, firstSource);

        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: secondSource,
            isSourceActive: () => true,
            operation: () => Effect.succeed("second"),
            cleanup: () =>
              Effect.sync(() => {
                secondCleanup.value += 1;
              }),
          }),
          "second",
        );

        const failedExit = yield* Effect.exit(
          operations.start({
            threadId: thread,
            source: failedSource,
            isSourceActive: () => true,
            operation: () => Effect.fail("healthy-error"),
            cleanup: () =>
              Effect.sync(() => {
                failedCleanup.value += 1;
              }),
          }),
        );

        const staleResult = yield* operations.commitIfCurrent(
          oldToken,
          Effect.sync(() => {
            staleCommit.value += 1;
            return "stale";
          }),
        );

        assert.strictEqual(firstCleanup.value, 0);
        assert.strictEqual(secondCleanup.value, 0);
        assert.strictEqual(failedCleanup.value, 0);
        assert.isTrue(Exit.isFailure(failedExit));
        assert.strictEqual(staleCommit.value, 0);
        assert.isTrue(Option.isNone(staleResult));
        assert.isFalse(oldToken.isCurrent());
      }),
    ),
  );

  it.effect("commits a genuine stop once and rejects stale compaction", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const started = yield* Deferred.make<void>();
        const cleanup = { value: 0 };
        const stopCalls = { value: 0 };
        const staleCompactionCalls = { value: 0 };

        const startExit = yield* Effect.exit(
          operations.start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: () => Deferred.succeed(started, undefined).pipe(Effect.as("started")),
            cleanup: () =>
              Effect.sync(() => {
                cleanup.value += 1;
              }),
          }),
        );
        successValue(startExit);
        yield* Deferred.await(started);
        assert.strictEqual(cleanup.value, 0);

        const token = yield* operations.capture(thread, source);
        const ticket = yield* operations.beginStop(thread);
        yield* operations.settleStop(ticket, {
          succeeded: true,
          isSourceCurrent: () => true,
          commit: Effect.sync(() => {
            stopCalls.value += 1;
          }),
        });
        yield* operations.settleStop(ticket, {
          succeeded: true,
          isSourceCurrent: () => true,
          commit: Effect.sync(() => {
            stopCalls.value += 1;
          }),
        });

        const compaction = yield* operations.commitIfCurrent(
          token,
          Effect.sync(() => {
            staleCompactionCalls.value += 1;
            return "stale";
          }),
        );

        assert.strictEqual(stopCalls.value, 1);
        assert.strictEqual(staleCompactionCalls.value, 0);
        assert.isTrue(Option.isNone(compaction));
        assert.isFalse(token.isCurrent());
      }),
    ),
  );

  it.effect("runs failed-stop commits only for the current generation", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const replacementSource = {};
        const failedCommit = { value: 0 };
        const staleCommit = { value: 0 };

        yield* operations.start({
          threadId: thread,
          source,
          isSourceActive: () => true,
          operation: () => Effect.succeed("first"),
          cleanup: () => Effect.void,
        });
        const failedTicket = yield* operations.beginStop(thread);
        yield* operations.settleStop(failedTicket, {
          succeeded: false,
          isSourceCurrent: () => true,
          commit: Effect.sync(() => {
            failedCommit.value += 1;
          }),
        });
        assert.strictEqual(failedCommit.value, 1);

        yield* operations.start({
          threadId: thread,
          source,
          isSourceActive: () => true,
          operation: () => Effect.succeed("second"),
          cleanup: () => Effect.void,
        });
        const staleTicket = yield* operations.beginStop(thread);
        yield* operations.start({
          threadId: thread,
          source: replacementSource,
          isSourceActive: () => true,
          operation: () => Effect.succeed("replacement"),
          cleanup: () => Effect.void,
        });

        const staleExit = yield* Effect.exit(
          operations.settleStop(staleTicket, {
            succeeded: false,
            isSourceCurrent: () => true,
            commit: Effect.sync(() => {
              staleCommit.value += 1;
            }),
          }),
        );

        assert.isTrue(Exit.isSuccess(staleExit));
        assert.strictEqual(failedCommit.value, 1);
        assert.strictEqual(staleCommit.value, 0);
      }),
    ),
  );

  it.effect("releases the stop permit when its current commit is interrupted", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const commitStarted = yield* Deferred.make<void>();
        const commitRelease = yield* Deferred.make<void>();

        const startFiber = yield* operations
          .start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.uninterruptible(Deferred.await(release));
                return "started";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        const ticket = yield* operations.beginStop(thread);
        const settleFiber = yield* operations
          .settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.gen(function* () {
              yield* Deferred.succeed(commitStarted, undefined);
              yield* Deferred.await(commitRelease);
            }),
          })
          .pipe(Effect.forkChild);

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(commitStarted);
        yield* Fiber.interrupt(settleFiber);
        const settleExit = yield* Fiber.await(settleFiber);
        const startExit = yield* Fiber.await(startFiber);

        assert.isTrue(Exit.isFailure(settleExit));
        assert.isTrue(isSuperseded(startExit));
        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: {},
            isSourceActive: () => true,
            operation: () => Effect.succeed("after-stop-commit"),
            cleanup: () => Effect.void,
          }),
          "after-stop-commit",
        );
      }),
    ),
  );

  it.effect("releases the compaction permit when its callback is interrupted", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const commitStarted = yield* Deferred.make<void>();
        const commitRelease = yield* Deferred.make<void>();

        const startFiber = yield* operations
          .start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.uninterruptible(Deferred.await(release));
                return "started";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const token = yield* operations.capture(thread, source);

        const commitFiber = yield* operations
          .commitIfCurrent(
            token,
            Effect.gen(function* () {
              yield* Deferred.succeed(commitStarted, undefined);
              yield* Deferred.await(commitRelease);
              return "committed";
            }),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(commitStarted);
        yield* Fiber.interrupt(commitFiber);
        const commitExit = yield* Fiber.await(commitFiber);
        const startExit = yield* Fiber.await(startFiber);

        assert.isTrue(Exit.isFailure(commitExit));
        assert.strictEqual(successValue(startExit), "started");
        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: {},
            isSourceActive: () => true,
            operation: () => Effect.succeed("after-compaction"),
            cleanup: () => Effect.void,
          }),
          "after-compaction",
        );
      }),
    ),
  );

  it.effect("retires a source, cleans a late uninterruptible start, and blocks reuse", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const cleanup = { value: 0 };

        const startFiber = yield* operations
          .start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.uninterruptible(Deferred.await(release));
                return "late";
              }),
            cleanup: () =>
              Effect.sync(() => {
                cleanup.value += 1;
              }),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        yield* operations.retireSource(source);
        const blocked = yield* Effect.exit(
          operations.start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: () => Effect.succeed("must-not-run"),
            cleanup: () => Effect.void,
          }),
        );
        assert.isTrue(isSuperseded(blocked));
        assert.strictEqual(cleanup.value, 0);

        yield* Deferred.succeed(release, undefined);
        yield* operations.drainStarts(source);
        const lateExit = yield* Fiber.await(startFiber);

        assert.isTrue(isSuperseded(lateExit));
        assert.strictEqual(cleanup.value, 1);
        const lateToken = yield* operations.capture(thread, source);
        assert.isFalse(lateToken.isCurrent());
      }),
    ),
  );

  it.effect("drops an idle retired generation before a later capture", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const replacementSource = {};

        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: () => Effect.succeed("started"),
            cleanup: () => Effect.void,
          }),
          "started",
        );
        yield* operations.retireSource(source);

        const retiredToken = yield* operations.capture(thread, source);
        assert.isFalse(retiredToken.isCurrent());
        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: replacementSource,
            isSourceActive: () => true,
            operation: () => Effect.succeed("replacement"),
            cleanup: () => Effect.void,
          }),
          "replacement",
        );
      }),
    ),
  );

  it.effect("keeps retired captures stale without blocking a fresh capture", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const retiredSource = {};
        const freshSource = {};
        const staleRan = { value: false };

        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: retiredSource,
            isSourceActive: () => true,
            operation: () => Effect.succeed("started"),
            cleanup: () => Effect.void,
          }),
          "started",
        );
        yield* operations.retireSource(retiredSource);

        const staleToken = yield* operations.capture(thread, retiredSource);
        assert.isFalse(staleToken.isCurrent());
        const staleResult = yield* operations.commitIfCurrent(
          staleToken,
          Effect.sync(() => {
            staleRan.value = true;
            return "stale";
          }),
        );
        assert.isTrue(Option.isNone(staleResult));
        assert.isFalse(staleRan.value);

        const freshToken = yield* operations.capture(thread, freshSource);
        assert.isTrue(freshToken.isCurrent());
        const freshResult = yield* operations.commitIfCurrent(freshToken, Effect.succeed("fresh"));
        assert.isTrue(Option.isSome(freshResult));
        if (Option.isSome(freshResult)) assert.strictEqual(freshResult.value, "fresh");
      }),
    ),
  );

  it.effect("returns caller interruption without joining late cleanup", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const cleanup = { value: 0 };

        const startFiber = yield* operations
          .start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.uninterruptible(Deferred.await(release));
                return "interrupted";
              }),
            cleanup: () =>
              Effect.sync(() => {
                cleanup.value += 1;
              }),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);

        yield* Fiber.interrupt(startFiber);
        assert.strictEqual(cleanup.value, 0);

        yield* Deferred.succeed(release, undefined);
        yield* operations.drainStarts(source);
        const callerExit = yield* Fiber.await(startFiber);

        assert.isTrue(Exit.isFailure(callerExit));
        assert.isFalse(isSuperseded(callerExit));
        assert.strictEqual(cleanup.value, 1);
      }),
    ),
  );

  it.effect("does not execute a queued start admitted before a stop", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const firstSource = {};
        const queuedSource = {};
        const firstStarted = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondRan = { value: false };

        const firstFiber = yield* operations
          .start({
            threadId: thread,
            source: firstSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Effect.uninterruptible(Deferred.await(firstRelease));
                return "first";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);

        const queuedFiber = yield* operations
          .start({
            threadId: thread,
            source: queuedSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.sync(() => {
                secondRan.value = true;
                return "queued";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(operations.startingSource(thread), queuedSource);

        yield* operations.beginStop(thread);
        yield* Deferred.succeed(firstRelease, undefined);
        const firstExit = yield* Fiber.await(firstFiber);
        const queuedExit = yield* Fiber.await(queuedFiber);

        assert.isTrue(isSuperseded(firstExit));
        assert.isTrue(isSuperseded(queuedExit));
        assert.isFalse(secondRan.value);
      }),
    ),
  );

  it.effect("interrupting a queued start does not consume the thread permit", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const firstSource = {};
        const queuedSource = {};
        const nextSource = {};
        const firstStarted = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const queuedRan = { value: false };

        const firstFiber = yield* operations
          .start({
            threadId: thread,
            source: firstSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Effect.uninterruptible(Deferred.await(firstRelease));
                return "first";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);

        const queuedFiber = yield* operations
          .start({
            threadId: thread,
            source: queuedSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.sync(() => {
                queuedRan.value = true;
                return "queued";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(operations.startingSource(thread), queuedSource);

        yield* Fiber.interrupt(queuedFiber);
        const queuedExit = yield* Fiber.await(queuedFiber);
        assert.isTrue(Exit.isFailure(queuedExit));

        yield* Deferred.succeed(firstRelease, undefined);
        const firstExit = yield* Fiber.await(firstFiber);
        assert.strictEqual(successValue(firstExit), "first");

        assert.strictEqual(
          yield* operations.start({
            threadId: thread,
            source: nextSource,
            isSourceActive: () => true,
            operation: () => Effect.succeed("next"),
            cleanup: () => Effect.void,
          }),
          "next",
        );
        assert.isFalse(queuedRan.value);
      }),
    ),
  );

  it.effect("keeps unrelated sources and threads moving", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const retiredSource = {};
        const otherSource = {};
        const independentSource = {};
        const retiredStarted = yield* Deferred.make<void>();
        const retiredRelease = yield* Deferred.make<void>();
        const otherStarted = yield* Deferred.make<void>();
        const independentStarted = yield* Deferred.make<void>();

        const retiredFiber = yield* operations
          .start({
            threadId: thread,
            source: retiredSource,
            isSourceActive: () => true,
            operation: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(retiredStarted, undefined);
                yield* Effect.uninterruptible(Deferred.await(retiredRelease));
                return "retired";
              }),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(retiredStarted);

        const otherFiber = yield* operations
          .start({
            threadId: thread,
            source: otherSource,
            isSourceActive: () => true,
            operation: () => Deferred.succeed(otherStarted, undefined).pipe(Effect.as("other")),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);
        const independentFiber = yield* operations
          .start({
            threadId: ThreadId.make("provider-session-operations-other-thread"),
            source: independentSource,
            isSourceActive: () => true,
            operation: () =>
              Deferred.succeed(independentStarted, undefined).pipe(Effect.as("independent")),
            cleanup: () => Effect.void,
          })
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        yield* operations.retireSource(retiredSource);
        yield* Deferred.await(independentStarted);
        yield* Deferred.succeed(retiredRelease, undefined);
        yield* Deferred.await(otherStarted);

        const retiredExit = yield* Fiber.await(retiredFiber);
        const otherExit = yield* Fiber.await(otherFiber);
        const independentExit = yield* Fiber.await(independentFiber);
        assert.isTrue(isSuperseded(retiredExit));
        assert.strictEqual(successValue(otherExit), "other");
        assert.strictEqual(successValue(independentExit), "independent");
      }),
    ),
  );

  it.effect("fails a busy stop commit at the admission deadline and keeps cleanup owned", () =>
    withOperations((operations) =>
      Effect.gen(function* () {
        const source = {};
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const cleanup = { value: 0 };
        const commit = { value: 0 };
        const stoppingAfterTimeout = { value: false };

        const startFiber = yield* operations
          .start({
            threadId: thread,
            source,
            isSourceActive: () => true,
            operation: (lease) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(started, undefined);
                yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    yield* Deferred.await(release);
                    stoppingAfterTimeout.value = true;
                    assert.isTrue(lease.isStopping());
                  }),
                );
                return "busy";
              }),
            cleanup: () =>
              Effect.sync(() => {
                cleanup.value += 1;
              }),
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const ticket = yield* operations.beginStop(thread);
        const settleFiber = yield* operations
          .settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.sync(() => {
              commit.value += 1;
            }),
          })
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const settleExit = yield* Fiber.await(settleFiber);
        assert.isTrue(isSuperseded(settleExit));
        assert.strictEqual(commit.value, 0);
        assert.strictEqual(cleanup.value, 0);

        yield* Deferred.succeed(release, undefined);
        yield* operations.drainStarts(source);
        const startExit = yield* Fiber.await(startFiber);
        assert.isTrue(isSuperseded(startExit));
        assert.strictEqual(cleanup.value, 1);
        assert.isTrue(stoppingAfterTimeout.value);

        const retryCommit = { value: 0 };
        const retryExit = yield* Effect.exit(
          operations.settleStop(ticket, {
            succeeded: true,
            isSourceCurrent: () => true,
            commit: Effect.sync(() => {
              retryCommit.value += 1;
            }),
          }),
        );
        assert.isTrue(Exit.isSuccess(retryExit));
        assert.strictEqual(retryCommit.value, 0);
      }),
    ),
  );
});
