import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { threadHidingUnavailableReason } from "../lib/connection";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";

const EMPTY_THREAD_HIDING_UNAVAILABLE_REASON_ATOM = Atom.make<string | null>(null).pipe(
  Atom.withLabel("mobile:thread-hiding-unavailable-reason:empty"),
);

const threadHidingUnavailableReasonFamily = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) =>
    threadHidingUnavailableReason(get(environmentPresentations.presentationAtom(environmentId))),
  ).pipe(Atom.withLabel(`mobile:thread-hiding-unavailable-reason:${environmentId}`)),
);

export function threadHidingUnavailableReasonAtom(
  environmentId: EnvironmentId | null,
): Atom.Atom<string | null> {
  return environmentId === null
    ? EMPTY_THREAD_HIDING_UNAVAILABLE_REASON_ATOM
    : threadHidingUnavailableReasonFamily(environmentId);
}

export function useThreadHidingUnavailableReason(
  environmentId: EnvironmentId | null,
): string | null {
  return useAtomValue(threadHidingUnavailableReasonAtom(environmentId));
}

export function getThreadHidingUnavailableReason(environmentId: EnvironmentId): string | null {
  return appAtomRegistry.get(threadHidingUnavailableReasonAtom(environmentId));
}
