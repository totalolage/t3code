import { EnvironmentConflictError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";

describe("connection errors", () => {
  it("preserves sanitized environment conflict details", () => {
    const error = mapRemoteEnvironmentError(
      new EnvironmentConflictError({
        code: "conflict",
        reason: "worktree_ref_in_use",
        message:
          "The requested branch is already checked out in another worktree. Archive or remove that worktree, or choose a different branch.",
        traceId: "trace-worktree-conflict",
      }),
    );

    expect(error).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "configuration",
      detail:
        "The requested branch is already checked out in another worktree. Archive or remove that worktree, or choose a different branch.",
      traceId: "trace-worktree-conflict",
    });
  });
});
