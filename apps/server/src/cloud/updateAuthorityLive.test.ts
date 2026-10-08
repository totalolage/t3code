import { ServiceUpdateAttemptId } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { UpdateAuthority, UpdateAuthorityError } from "./serviceUpdateServices.ts";
import { makeUpdateAuthority, UpdateAuthorityLive } from "./updateAuthorityLive.ts";

const attemptId = ServiceUpdateAttemptId.make("11111111-1111-4111-8111-111111111111");

const reserveOwned = (authority: ReturnType<typeof makeUpdateAuthority>) =>
  authority
    .reserve({ owner: "scheduled", attemptId })
    .pipe(
      Effect.flatMap((result) =>
        result._tag === "owned"
          ? Effect.succeed(result.lease)
          : Effect.die(new Error("expected an owned lease")),
      ),
    );

const expectError = (
  run: Effect.Effect<unknown, UpdateAuthorityError>,
  code: UpdateAuthorityError["code"],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const result = yield* Effect.result(run);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(UpdateAuthorityError);
      assert.equal(result.failure.code, code);
    }
  });

it.effect("hands out exactly one live lease at a time", () =>
  Effect.gen(function* () {
    const authority = makeUpdateAuthority();
    const lease = yield* reserveOwned(authority);
    assert.equal(lease.owner, "scheduled");
    assert.equal(lease.attemptId, attemptId);

    const second = yield* authority.reserve({ owner: "manual" });
    assert.equal(second._tag, "busy");

    // Concurrent reserve against the live lease is busy as well.
    const concurrent = yield* Effect.all([
      authority.reserve({ owner: "manual" }),
      authority.reserve({ owner: "scheduled", attemptId }),
    ]);
    assert.deepEqual(
      concurrent.map((result) => result._tag),
      ["busy", "busy"],
    );

    yield* lease.release;
    const afterRelease = yield* authority.reserve({ owner: "manual" });
    assert.equal(afterRelease._tag, "owned");
  }),
);

it.effect("enterIrreversible is one-shot", () =>
  Effect.gen(function* () {
    const authority = makeUpdateAuthority();
    const lease = yield* reserveOwned(authority);
    yield* lease.enterIrreversible;
    yield* expectError(lease.enterIrreversible, "retained-lease");
  }),
);

it.effect("release is idempotent", () =>
  Effect.gen(function* () {
    const authority = makeUpdateAuthority();
    const lease = yield* reserveOwned(authority);
    assert.equal(yield* lease.release, "released");
    assert.equal(yield* lease.release, "already-released");
    assert.equal(yield* lease.release, "already-released");
  }),
);

it.effect("a stale lease is rejected instead of acting", () =>
  Effect.gen(function* () {
    const authority = makeUpdateAuthority();
    const lease = yield* reserveOwned(authority);
    yield* lease.release;
    yield* expectError(lease.enterIrreversible, "stale-lease");

    // A superseded lease (a newer reserve owns the authority now) is stale.
    const replacement = yield* reserveOwned(authority);
    yield* expectError(lease.release, "stale-lease");
    yield* replacement.release;
  }),
);

it.effect("release after enterIrreversible frees the reservation", () =>
  Effect.gen(function* () {
    const authority = makeUpdateAuthority();
    const lease = yield* reserveOwned(authority);
    yield* lease.enterIrreversible;
    assert.equal(yield* lease.release, "released");
    const next = yield* authority.reserve({ owner: "scheduled", attemptId });
    assert.equal(next._tag, "owned");
  }),
);

it.effect("the production layer is a working singleton binding", () =>
  Effect.gen(function* () {
    const program = Effect.gen(function* () {
      const authority = yield* UpdateAuthority;
      const lease = yield* reserveOwned(authority as ReturnType<typeof makeUpdateAuthority>);
      const busy = yield* authority.reserve({ owner: "manual" });
      assert.equal(busy._tag, "busy");
      yield* lease.release;
    });
    yield* Effect.provide(program, UpdateAuthorityLive);
  }),
);
