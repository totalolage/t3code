import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import { scopedThreadKey } from "../../lib/scopedEntities";

export type ThreadVisibilityAction = "hide" | "unhide";

export type ThreadVisibilityTarget = Pick<EnvironmentThreadShell, "environmentId" | "id">;

type ThreadVisibilityMutation = (input: {
  readonly environmentId: ThreadVisibilityTarget["environmentId"];
  readonly input: { readonly threadId: ThreadVisibilityTarget["id"] };
}) => Promise<AtomCommandResult<unknown, unknown>>;

export function createThreadVisibilityActions(input: {
  readonly hide: ThreadVisibilityMutation;
  readonly unhide: ThreadVisibilityMutation;
  readonly getUnavailableReason: (
    targetEnvironmentId: ThreadVisibilityTarget["environmentId"],
  ) => string | null;
  readonly onUnavailable: (reason: string) => void;
  readonly onStarted?: () => void;
  readonly onFailure: (
    action: ThreadVisibilityAction,
    cause: Extract<AtomCommandResult<unknown, unknown>, { readonly _tag: "Failure" }>["cause"],
  ) => void;
  readonly onSucceeded: (environmentId: ThreadVisibilityTarget["environmentId"]) => void;
}): {
  readonly hideThread: (thread: ThreadVisibilityTarget) => Promise<boolean>;
  readonly unhideThread: (thread: ThreadVisibilityTarget) => Promise<boolean>;
} {
  const inFlightThreadKeys = new Set<string>();

  const execute = async (
    action: ThreadVisibilityAction,
    thread: ThreadVisibilityTarget,
  ): Promise<boolean> => {
    const unavailableReason = input.getUnavailableReason(thread.environmentId);
    if (unavailableReason !== null) {
      input.onUnavailable(unavailableReason);
      return false;
    }

    const key = scopedThreadKey(thread.environmentId, thread.id);
    if (inFlightThreadKeys.has(key)) {
      return false;
    }

    inFlightThreadKeys.add(key);
    input.onStarted?.();
    try {
      const result = await (action === "hide" ? input.hide : input.unhide)({
        environmentId: thread.environmentId,
        input: { threadId: thread.id },
      });
      if (result._tag === "Failure") {
        input.onFailure(action, result.cause);
        return false;
      }

      input.onSucceeded(thread.environmentId);
      return true;
    } finally {
      inFlightThreadKeys.delete(key);
    }
  };

  return {
    hideThread: (thread) => execute("hide", thread),
    unhideThread: (thread) => execute("unhide", thread),
  };
}
