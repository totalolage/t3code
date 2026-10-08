import { assert, describe, it } from "@effect/vitest";

import {
  classifyGitWorktreeCreateError,
  sanitizeGitErrorDiagnostic,
} from "./worktreeCreateError.ts";

describe("fork worktree-add diagnostics", () => {
  it("preserves shipped branch, path, and registration classifications", () => {
    const cases = [
      ["fatal: a branch named 'feature' already exists", "branch_exists"],
      ["fatal: '/tmp/target' already exists", "path_exists"],
      ["fatal: 'feature' is already used by worktree at '/tmp/used'", "branch_in_use"],
      ["fatal: 'feature' is already checked out at '/tmp/used'", "branch_in_use"],
      [
        "fatal: '/tmp/target' is a missing but already registered worktree",
        "registration_conflict",
      ],
      ["fatal: '/tmp/target' is a missing but locked worktree", "registration_conflict"],
      ["fatal: worktree '/tmp/target' is locked", "registration_conflict"],
    ] as const;
    for (const [stderr, expected] of cases) {
      const result = classifyGitWorktreeCreateError(
        `Preparing worktree (checking out 'feature')\n${stderr}\n`,
      );
      assert.equal(result.reason, expected);
      assert.notInclude(result.detail, "/tmp/");
      assert.notInclude(result.detail, "'feature'");
    }
  });

  it("retains sanitized unknown diagnostics without inventing new categories", () => {
    const result = classifyGitWorktreeCreateError(
      "fatal: could not create worktree dir '/tmp/private': Permission denied; token=secret-value https://user:password@example.test/private\u001b[31m",
    );
    assert.equal(result.reason, "unknown");
    assert.include(result.detail, "Permission denied");
    for (const secret of [
      "/tmp/private",
      "secret-value",
      "user:password",
      "example.test",
      "\u001b",
    ]) {
      assert.notInclude(result.detail, secret);
    }
    assert.equal(
      classifyGitWorktreeCreateError("fatal: invalid reference: missing").reason,
      "unknown",
    );
  });

  it("bounds unknown output and supplies the shipped empty-output fallback", () => {
    assert.isAtMost(sanitizeGitErrorDiagnostic("problem ".repeat(2000)).length, 512);
    assert.equal(
      sanitizeGitErrorDiagnostic("\u0000\u001b[31m"),
      "Git reported a non-zero exit status without a safe diagnostic.",
    );
  });
});
