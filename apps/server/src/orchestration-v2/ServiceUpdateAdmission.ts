import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

const ADMISSION_PERMITS = Number.MAX_SAFE_INTEGER;

export type ServiceUpdateAdmissionState = "open" | "draining" | "sealed";

export interface ServiceUpdateAdmissionShape {
  /** Ordinary dispatch takes one shared admission before acquiring its thread lock. */
  readonly withAdmission: <A, E, R>(
    use: (closed: boolean) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Private work may register during drain, but not after the handoff seal. */
  readonly withPrivateAdmission: <A, E, R>(
    use: (sealed: boolean) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Hold the fair exclusive cut across a fresh observation and short decision. */
  readonly withExclusive: <A, E, R>(
    use: (
      current: ServiceUpdateAdmissionState,
      setState: (state: ServiceUpdateAdmissionState) => Effect.Effect<void>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Change the process-local admission phase under the same fair exclusive cut. */
  readonly setState: (state: ServiceUpdateAdmissionState) => Effect.Effect<void>;
}

export class ServiceUpdateAdmission extends Context.Service<
  ServiceUpdateAdmission,
  ServiceUpdateAdmissionShape
>()("t3/orchestration-v2/ServiceUpdateAdmission") {}

export const layer: Layer.Layer<ServiceUpdateAdmission> = Layer.effect(
  ServiceUpdateAdmission,
  Effect.gen(function* () {
    const state = yield* Ref.make<ServiceUpdateAdmissionState>("open");
    const turnstile = yield* Semaphore.make(1);
    const admissions = yield* Semaphore.make(ADMISSION_PERMITS);

    const withPhaseAdmission = <A, E, R>(
      isClosed: (state: ServiceUpdateAdmissionState) => boolean,
      use: (closed: boolean) => Effect.Effect<A, E, R>,
      installAtomically = false,
    ) =>
      Effect.uninterruptibleMask((restore) =>
        restore(turnstile.withPermit(admissions.take(1))).pipe(
          Effect.flatMap(() =>
            Ref.get(state).pipe(
              Effect.flatMap((current) =>
                Effect.ensuring(
                  installAtomically
                    ? Effect.uninterruptible(use(isClosed(current)))
                    : restore(use(isClosed(current))),
                  admissions.release(1),
                ),
              ),
            ),
          ),
        ),
      );

    const withExclusive: ServiceUpdateAdmissionShape["withExclusive"] = (use) =>
      Effect.uninterruptibleMask((restore) =>
        restore(
          turnstile.withPermit(
            admissions.withPermits(ADMISSION_PERMITS)(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                return yield* use(current, (next) => Ref.set(state, next));
              }),
            ),
          ),
        ),
      );

    return ServiceUpdateAdmission.of({
      withAdmission: (use) => withPhaseAdmission((current) => current !== "open", use),
      // The callback only installs an owner handle, so protect it through permit release.
      withPrivateAdmission: (use) =>
        withPhaseAdmission((current) => current === "sealed", use, true),
      withExclusive,
      setState: (next) => withExclusive((_, set) => set(next)),
    });
  }),
);
