import { OrchestrationDispatchCommandError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { isExpectedClientDispatchError } from "./OrchestrationCommandDispatcher.ts";

describe("OrchestrationCommandDispatcher error classification", () => {
  it("classifies cause-free domain invariants as expected client errors", () => {
    const invariant = new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "Thread does not exist.",
    });

    expect(
      isExpectedClientDispatchError(
        new OrchestrationDispatchCommandError({
          message: invariant.message,
          cause: invariant,
        }),
      ),
    ).toBe(true);
  });

  it("keeps infrastructure failures wrapped as invariants in the internal-error category", () => {
    const invariant = new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "Failed to generate an event identifier.",
      cause: new Error("crypto unavailable"),
    });

    expect(
      isExpectedClientDispatchError(
        new OrchestrationDispatchCommandError({
          message: invariant.message,
          cause: invariant,
        }),
      ),
    ).toBe(false);
  });
});
