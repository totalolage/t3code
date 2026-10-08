import {
  EnvironmentAuthInvalidError,
  EnvironmentConflictError,
  EnvironmentThreadCompactionError,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";

import { PrimaryEnvironmentRequestError, retryTransientBootstrap } from "./auth";

describe("primary auth error status mapping", () => {
  it("maps EnvironmentConflictError to HTTP 409", () => {
    const cause = new EnvironmentConflictError({
      code: "conflict",
      reason: "worktree_branch_exists",
      message: "branch already exists",
      traceId: "trace-1",
    });

    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause,
    });

    expect(error.status).toBe(409);
    expect(error.message).toContain("HTTP 409");
  });

  it("maps EnvironmentThreadCompactionError to HTTP 409", () => {
    const cause = new EnvironmentThreadCompactionError({
      code: "thread_compaction_failed",
      reason: "active-thread",
      traceId: "trace-4",
    });

    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "fetch-session-state",
      cause,
    });

    expect(error.status).toBe(409);
    expect(error.message).toContain("HTTP 409");
  });

  it("keeps mapping invalid credentials to HTTP 401", () => {
    const cause = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-2",
    });

    const error = PrimaryEnvironmentRequestError.fromCause({
      operation: "exchange-bootstrap-credential",
      cause,
    });

    expect(error.status).toBe(401);
  });

  it("does not retry conflicts like it retries transient bootstrap failures", async () => {
    const cause = new EnvironmentConflictError({
      code: "conflict",
      reason: "idempotency_payload_mismatch",
      message: "payload mismatch",
      traceId: "trace-3",
    });
    const operation = vi.fn().mockRejectedValue(
      PrimaryEnvironmentRequestError.fromCause({
        operation: "fetch-session-state",
        cause,
      }),
    );

    await expect(retryTransientBootstrap(operation)).rejects.toMatchObject({ status: 409 });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
