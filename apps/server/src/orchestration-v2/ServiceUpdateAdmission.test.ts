import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as ServiceUpdateAdmission from "./ServiceUpdateAdmission.ts";

const testLayer = it.layer(ServiceUpdateAdmission.layer);

testLayer("ServiceUpdateAdmission", (it) => {
  it.effect("keeps shared admissions concurrent and gives a waiting writer the next cut", () =>
    Effect.gen(function* () {
      const gate = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      yield* gate.setState("open");
      const firstEntered = yield* Deferred.make<void>();
      const secondEntered = yield* Deferred.make<void>();
      const releaseReaders = yield* Deferred.make<void>();
      const writerEntered = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const lateReaderEntered = yield* Deferred.make<boolean>();
      const first = yield* Effect.forkChild(
        gate.withAdmission(() =>
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReaders)),
          ),
        ),
        { startImmediately: true },
      );
      const second = yield* Effect.forkChild(
        gate.withAdmission(() =>
          Deferred.succeed(secondEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReaders)),
          ),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(firstEntered);
      yield* Deferred.await(secondEntered);

      const writer = yield* Effect.forkChild(
        gate.withExclusive((_, setState) =>
          setState("draining").pipe(
            Effect.andThen(Deferred.succeed(writerEntered, undefined)),
            Effect.andThen(Deferred.await(releaseWriter)),
          ),
        ),
        { startImmediately: true },
      );
      const lateReader = yield* Effect.forkChild(
        gate.withAdmission((closed) => Deferred.succeed(lateReaderEntered, closed)),
      );

      yield* Deferred.succeed(releaseReaders, undefined);
      yield* Deferred.await(writerEntered);
      yield* Deferred.succeed(releaseWriter, undefined);
      assert.isTrue(yield* Deferred.await(lateReaderEntered));
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(writer)));
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* Fiber.join(lateReader);
      assert.equal(yield* gate.withAdmission((closed) => Effect.succeed(closed)), true);
    }),
  );

  it.effect("releases a cancelled writer waiting for the exclusive cut", () =>
    Effect.gen(function* () {
      const gate = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      yield* gate.setState("open");
      const readerEntered = yield* Deferred.make<void>();
      const releaseReader = yield* Deferred.make<void>();
      const reader = yield* Effect.forkChild(
        gate.withAdmission(() =>
          Deferred.succeed(readerEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseReader)),
          ),
        ),
      );
      yield* Deferred.await(readerEntered);
      const writer = yield* Effect.forkChild(gate.setState("sealed"), { startImmediately: true });
      const interruptor = yield* Effect.forkChild(Fiber.interrupt(writer), {
        startImmediately: true,
      });
      yield* Deferred.succeed(releaseReader, undefined);
      yield* Fiber.join(reader);
      yield* Fiber.join(interruptor);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(writer)));
      assert.isFalse(yield* gate.withPrivateAdmission((sealed) => Effect.succeed(sealed)));
    }),
  );

  it.effect("allows private work during drain and seals it at the handoff cut", () =>
    Effect.gen(function* () {
      const gate = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      yield* gate.setState("open");
      assert.isFalse(yield* gate.withAdmission((closed) => Effect.succeed(closed)));
      assert.isFalse(yield* gate.withPrivateAdmission((sealed) => Effect.succeed(sealed)));

      yield* gate.setState("draining");
      assert.isTrue(yield* gate.withAdmission((closed) => Effect.succeed(closed)));
      assert.isFalse(yield* gate.withPrivateAdmission((sealed) => Effect.succeed(sealed)));

      yield* gate.setState("sealed");
      assert.isTrue(yield* gate.withAdmission((closed) => Effect.succeed(closed)));
      assert.isTrue(yield* gate.withPrivateAdmission((sealed) => Effect.succeed(sealed)));

      yield* gate.setState("open");
      assert.isFalse(yield* gate.withAdmission((closed) => Effect.succeed(closed)));
      assert.isFalse(yield* gate.withPrivateAdmission((sealed) => Effect.succeed(sealed)));
    }),
  );

  it.effect("holds the exclusive permit across the local state decision", () =>
    Effect.gen(function* () {
      const gate = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      yield* gate.setState("open");
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const readerEntered = yield* Deferred.make<boolean>();
      const writer = yield* Effect.forkChild(
        gate.withExclusive((current, setState) =>
          Effect.gen(function* () {
            assert.equal(current, "open");
            yield* setState("sealed");
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(entered);
      const reader = yield* Effect.forkChild(
        gate.withAdmission((closed) => Deferred.succeed(readerEntered, closed)),
        { startImmediately: true },
      );
      yield* Deferred.succeed(release, undefined);
      assert.isTrue(yield* Deferred.await(readerEntered));
      yield* Fiber.join(writer);
      yield* Fiber.join(reader);
    }),
  );
});
