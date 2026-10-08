/**
 * Live `UpdateAuthority`: a single in-process update reservation.
 *
 * Exactly one live lease exists per server process. A second concurrent
 * `reserve` is `busy`; the live lease's `enterIrreversible` is one-shot (the
 * commit point) and its `release` is idempotent. `UpdateAuthorityLive` is the
 * single production singleton (module-level reservation state); tests build
 * isolated authorities through `makeUpdateAuthority`.
 *
 * @module UpdateAuthorityLive
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  UpdateAuthority,
  UpdateAuthorityError,
  type UpdateAuthorityLease,
  type UpdateAuthorityReserveInput,
  type UpdateAuthorityReserveResult,
} from "./serviceUpdateServices.ts";

export type LeasePhase = "free" | "held" | "irreversible" | "released";

export interface AuthorityState {
  readonly phase: LeasePhase;
  /** Id of the most recently issued lease; 0 when none was ever issued. */
  readonly leaseId: number;
}

const initialState: AuthorityState = { phase: "free", leaseId: 0 };

const stale = () => new UpdateAuthorityError({ code: "stale-lease" });
const retained = () => new UpdateAuthorityError({ code: "retained-lease" });

const isBusy = (phase: LeasePhase): boolean => phase === "held" || phase === "irreversible";

export interface UpdateAuthorityShape {
  readonly reserve: (
    input: UpdateAuthorityReserveInput,
  ) => Effect.Effect<UpdateAuthorityReserveResult, UpdateAuthorityError>;
}

/**
 * One authority over an in-process reservation `Ref`. `reserve` hands out at
 * most one live lease; every lease operation is checked against the live
 * lease id so a superseded lease fails `stale-lease` instead of acting.
 */
export function makeUpdateAuthority(
  state: Ref.Ref<AuthorityState> = Ref.makeUnsafe(initialState),
): UpdateAuthorityShape {
  const reserve: UpdateAuthorityShape["reserve"] = (input) =>
    Ref.modify(state, (current): readonly [UpdateAuthorityReserveResult, AuthorityState] => {
      if (isBusy(current.phase)) return [{ _tag: "busy" }, current];
      const leaseId = current.leaseId + 1;
      const lease: UpdateAuthorityLease = {
        owner: input.owner,
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        enterIrreversible: Ref.modify(
          state,
          (live): readonly [true | UpdateAuthorityError, AuthorityState] => {
            if (live.leaseId !== leaseId) return [stale(), live];
            if (live.phase === "irreversible") return [retained(), live];
            if (live.phase !== "held") return [stale(), live];
            return [true, { ...live, phase: "irreversible" }];
          },
        ).pipe(Effect.flatMap((result) => (result === true ? Effect.void : Effect.fail(result)))),
        release: Ref.modify(
          state,
          (
            live,
          ): readonly ["released" | "already-released" | UpdateAuthorityError, AuthorityState] => {
            if (live.leaseId !== leaseId) return [stale(), live];
            if (live.phase === "released") return ["already-released", live];
            // Held and irreversible alike end here: `release` is idempotent and
            // every abort path can free the reservation.
            return ["released", { ...live, phase: "released" }];
          },
        ).pipe(
          Effect.flatMap((result) =>
            result instanceof UpdateAuthorityError ? Effect.fail(result) : Effect.succeed(result),
          ),
        ),
      };
      return [
        { _tag: "owned", lease },
        { phase: "held", leaseId },
      ];
    });
  return { reserve };
}

/** Single production reservation state for this server process. */
const singletonState = Ref.makeUnsafe(initialState);

/**
 * Single production singleton per server process. Compose once when wiring;
 * tests use `makeUpdateAuthority` for isolated authorities.
 */
export const UpdateAuthorityLive = Layer.sync(UpdateAuthority, () =>
  UpdateAuthority.of(makeUpdateAuthority(singletonState)),
);
