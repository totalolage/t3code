import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadOutboxFailureAction,
  shouldRetryThreadOutboxDelivery,
} from "./thread-outbox-model";

const decodeDispatchCommandError = Schema.decodeUnknownSync(OrchestrationDispatchCommandError);

describe("thread outbox failure decisions", () => {
  it("restores after a decoded non-retryable bootstrap rejection while keeping its reason", () => {
    const error = decodeDispatchCommandError({
      _tag: "OrchestrationDispatchCommandError",
      message: "The requested worktree path already exists.",
      bootstrapThreadDisposition: "deleted",
    });

    expect(error.message).toBe("The requested worktree path already exists.");
    expect(shouldRetryThreadOutboxDelivery(error)).toBe(false);
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error,
        interrupted: false,
      }),
    ).toBe("restore");
  });
});
