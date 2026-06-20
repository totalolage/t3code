import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ConnectionPersistenceError } from "./persistence.ts";

describe("ConnectionPersistenceError", () => {
  it("retains resource context and the exact underlying failure", () => {
    const cause = new Error("disk unavailable");
    const error = new ConnectionPersistenceError({
      operation: "load-thread",
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
      cause,
    });

    expect(error).toMatchObject({
      operation: "load-thread",
      environmentId: "environment-1",
      threadId: "thread-1",
      cause,
    });
    expect(error.message).toBe("Could not load thread.");
  });
});
