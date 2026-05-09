import { assert, it } from "vitest";

import {
  getReviewAsyncStateSnapshot,
  setReviewAsyncError,
  setReviewGitDiffsLoading,
  setReviewTurnDiffLoading,
} from "./reviewState";

it("stores review async loading and error state in atoms", () => {
  const threadKey = `env-local:thread-review-state-${Date.now()}`;

  setReviewGitDiffsLoading(threadKey, true);
  setReviewTurnDiffLoading(threadKey, "turn-1", true);
  setReviewAsyncError(threadKey, "load failed");

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingGitDiffs: true,
    loadingTurnIds: { "turn-1": true },
    error: "load failed",
  });

  setReviewGitDiffsLoading(threadKey, false);
  setReviewTurnDiffLoading(threadKey, "turn-1", false);
  setReviewAsyncError(threadKey, null);

  assert.deepStrictEqual(getReviewAsyncStateSnapshot(threadKey), {
    loadingGitDiffs: false,
    loadingTurnIds: {},
    error: null,
  });
});
