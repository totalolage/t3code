import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import { layerMemory } from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ServiceUpdateAdmission from "./ServiceUpdateAdmission.ts";

interface EffectExecutionProbeShape {
  readonly calls: Ref.Ref<ReadonlyArray<string>>;
  readonly claimed: Queue.Queue<{
    readonly effectId: string;
    readonly release: Deferred.Deferred<void>;
  }>;
  readonly started: Queue.Queue<{
    readonly effectId: string;
    readonly release: Deferred.Deferred<void>;
  }>;
}

class EffectExecutionProbe extends Context.Service<
  EffectExecutionProbe,
  EffectExecutionProbeShape
>()("t3/orchestration-v2/EffectOutbox.test/EffectExecutionProbe") {}

const probeLayer = Layer.effect(
  EffectExecutionProbe,
  Effect.gen(function* () {
    return EffectExecutionProbe.of({
      calls: yield* Ref.make<ReadonlyArray<string>>([]),
      claimed: yield* Queue.unbounded<{
        readonly effectId: string;
        readonly release: Deferred.Deferred<void>;
      }>(),
      started: yield* Queue.unbounded<{
        readonly effectId: string;
        readonly release: Deferred.Deferred<void>;
      }>(),
    });
  }),
);

const executorLayer = Layer.effect(
  EffectWorker.OrchestrationEffectExecutorV2,
  Effect.gen(function* () {
    const probe = yield* EffectExecutionProbe;
    return EffectWorker.OrchestrationEffectExecutorV2.of({
      execute: (effect) =>
        Effect.gen(function* () {
          yield* Ref.update(probe.calls, (calls) => [...calls, effect.id]);
          const release = yield* Deferred.make<void>();
          yield* Queue.offer(probe.started, { effectId: effect.id, release });
          yield* Deferred.await(release);
        }),
    });
  }),
);

const executorAndProbe = executorLayer.pipe(Layer.provideMerge(probeLayer));
const outboxClaimBoundaryLayer = Layer.effect(
  EffectOutbox.EffectOutboxV2,
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const probe = yield* EffectExecutionProbe;
    return EffectOutbox.EffectOutboxV2.of({
      ...outbox,
      claimNext: (input) =>
        outbox.claimNext(input).pipe(
          Effect.flatMap((result) =>
            Option.match(result, {
              onNone: () => Effect.succeed(Option.none()),
              onSome: (effect) =>
                Effect.gen(function* () {
                  const release = yield* Deferred.make<void>();
                  yield* Queue.offer(probe.claimed, { effectId: effect.id, release });
                  yield* Deferred.await(release);
                  return Option.some(effect);
                }),
            }),
          ),
        ),
    });
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(EffectOutbox.layer, probeLayer)));
const dependencies = Layer.mergeAll(
  outboxClaimBoundaryLayer,
  executorAndProbe,
  ServiceUpdateAdmission.layer,
);
const testLayer = EffectWorker.layerWithOptions({ workerId: "native-admission-test" }).pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(layerMemory),
);

const startEffect = (name: string) => ({
  id: `effect:${name}`,
  commandId: CommandId.make(`command:${name}`),
  threadId: ThreadId.make(`thread:${name}`),
  request: {
    type: "provider-turn.start" as const,
    runId: RunId.make(`run:${name}`),
  },
});

it.layer(testLayer)("EffectOutbox native admission", (it) => {
  it.effect("settles a claimed native start while scheduled admission is draining", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const probe = yield* EffectExecutionProbe;
      const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      const effect = startEffect("claimed-before-drain");
      yield* outbox.enqueue([effect]);

      const workerFiber = yield* worker.runOnce.pipe(Effect.forkChild);
      const claimed = yield* Queue.take(probe.claimed);
      assert.equal(claimed.effectId, effect.id);
      yield* admission.setState("draining");
      yield* Deferred.succeed(claimed.release, undefined);
      const started = yield* Queue.take(probe.started);
      assert.equal(started.effectId, effect.id);
      yield* Deferred.succeed(started.release, undefined);
      assert.isTrue(yield* Fiber.join(workerFiber));
      assert.equal(Option.getOrThrow(yield* outbox.get(effect.id)).status, "succeeded");
    }),
  );

  it.effect("does not claim private starts after the seal and resumes them when reopened", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const probe = yield* EffectExecutionProbe;
      const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      const effect = startEffect("sealed-then-reopened");
      const callsBefore = yield* Ref.get(probe.calls);
      yield* outbox.enqueue([effect]);
      yield* admission.setState("sealed");

      assert.isFalse(yield* worker.runOnce);
      assert.deepStrictEqual(yield* Ref.get(probe.calls), callsBefore);
      assert.equal(Option.getOrThrow(yield* outbox.get(effect.id)).status, "pending");

      yield* admission.setState("open");
      yield* outbox.notifyAvailable();
      const workerFiber = yield* worker.runOnce.pipe(Effect.forkChild);
      const claimed = yield* Queue.take(probe.claimed);
      assert.equal(claimed.effectId, effect.id);
      yield* Deferred.succeed(claimed.release, undefined);
      const started = yield* Queue.take(probe.started);
      assert.equal(started.effectId, effect.id);
      yield* Deferred.succeed(started.release, undefined);
      assert.isTrue(yield* Fiber.join(workerFiber));
      assert.equal(Option.getOrThrow(yield* outbox.get(effect.id)).status, "succeeded");
    }),
  );
});

it.effect("treats a claimed provider start as dispatch evidence", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const effect = startEffect("recovery-dispatch-evidence");
    yield* outbox.enqueue([effect]);

    assert.isFalse(yield* outbox.hasProviderStartDispatchEvidence(effect.request.runId));
    const claimed = yield* outbox.claimNext({
      workerId: "native-recovery-evidence-test",
      leaseDurationMs: 1000,
    });
    assert.equal(Option.getOrThrow(claimed).id, effect.id);
    assert.isTrue(yield* outbox.hasProviderStartDispatchEvidence(effect.request.runId));
  }).pipe(Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(layerMemory)))),
);
