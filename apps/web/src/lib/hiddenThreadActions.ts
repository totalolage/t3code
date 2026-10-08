import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readEnvironmentSupportsHiding } from "../state/entities";
import { environmentPresentations } from "../state/presentation";

export type HiddenThreadActionBlockReason = "missing-environment" | "disconnected" | "unsupported";

export type HiddenThreadActionEligibility =
  | {
      readonly canUnhide: true;
      readonly reason: null;
      readonly guidance: null;
    }
  | {
      readonly canUnhide: false;
      readonly reason: HiddenThreadActionBlockReason;
      readonly guidance: string;
    };

export function getHiddenThreadActionEligibility(
  supportsHiding: boolean,
  connectionPhase: EnvironmentConnectionPhase | null,
): HiddenThreadActionEligibility {
  if (connectionPhase === null) {
    return {
      canUnhide: false,
      reason: "missing-environment",
      guidance: "Connect this environment to unhide.",
    };
  }
  if (connectionPhase !== "connected") {
    return {
      canUnhide: false,
      reason: "disconnected",
      guidance: "Connect this environment to unhide.",
    };
  }
  if (!supportsHiding) {
    return {
      canUnhide: false,
      reason: "unsupported",
      guidance: "Update T3 Code on that environment to manage hidden threads.",
    };
  }
  return { canUnhide: true, reason: null, guidance: null };
}

export type HiddenThreadUnhideMutation<Result> = (target: ScopedThreadRef) => Promise<Result>;

export type HiddenThreadUnhideRequest<Result> =
  | {
      readonly _tag: "Blocked";
      readonly eligibility: Extract<HiddenThreadActionEligibility, { canUnhide: false }>;
    }
  | {
      readonly _tag: "Mutated";
      readonly result: Result;
    };

/** Re-check the target environment immediately before dispatching an unhide request. */
export async function requestHiddenThreadUnhide<Result>(
  target: ScopedThreadRef,
  mutate: HiddenThreadUnhideMutation<Result>,
): Promise<HiddenThreadUnhideRequest<Result>> {
  const presentation = appAtomRegistry.get(
    environmentPresentations.presentationAtom(target.environmentId),
  );
  const eligibility = getHiddenThreadActionEligibility(
    readEnvironmentSupportsHiding(target.environmentId),
    presentation?.connection.phase ?? null,
  );
  if (!eligibility.canUnhide) {
    return { _tag: "Blocked", eligibility };
  }
  return { _tag: "Mutated", result: await mutate(target) };
}
