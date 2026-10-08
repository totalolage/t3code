import * as Effect from "effect/Effect";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "./chatAttachment.ts";

import {
  EnvironmentAuthInvalidError,
  EnvironmentHttpConflictError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  EnvironmentHttpCommonError,
  EnvironmentThreadCompactionError,
  OrchestrationCliCreateRequest,
  OrchestrationCliCreateResult,
  OrchestrationCompactRequest,
  OrchestrationCompactResult,
  ThreadCompactCompletionReason,
} from "./environmentHttp.ts";

const traceId = "trace-1";
const encodeConflictError = Schema.encodeUnknownSync(EnvironmentHttpConflictError);
const decodeConflictError = Schema.decodeUnknownSync(EnvironmentHttpConflictError);
const encodeThreadCompactionError = Schema.encodeUnknownSync(EnvironmentThreadCompactionError);
const decodeThreadCompactionError = Schema.decodeUnknownSync(EnvironmentThreadCompactionError);
const decodeCommonError = Schema.decodeUnknownSync(EnvironmentHttpCommonError);
const decodeCliCreateRequest = Schema.decodeUnknownSync(OrchestrationCliCreateRequest);
const decodeCliCreateResult = Schema.decodeUnknownSync(OrchestrationCliCreateResult);
const decodeCompactRequest = Schema.decodeUnknownSync(OrchestrationCompactRequest);
const decodeCompactResult = Schema.decodeUnknownSync(OrchestrationCompactResult);
const decodeCompactCompletionReason = Schema.decodeUnknownSync(ThreadCompactCompletionReason);

describe("environment HTTP orchestration DTOs", () => {
  it("normalizes CLI create requests and preserves optional policy fields", () => {
    expect(
      decodeCliCreateRequest({
        project: " project-1 ",
        message: " create this ",
        idempotencyKey: " delivery-1 ",
        title: " New thread ",
        branch: " feature/example ",
        runtimeMode: "auto",
        interactionMode: "plan",
      }),
    ).toEqual({
      project: "project-1",
      message: "create this",
      idempotencyKey: "delivery-1",
      title: "New thread",
      branch: "feature/example",
      runtimeMode: "auto",
      interactionMode: "plan",
    });
  });

  it("enforces the CLI create idempotency, message, and title bounds", () => {
    const validRequest = {
      project: "project-1",
      message: "create this",
      idempotencyKey: "delivery-1",
    };

    expect(
      decodeCliCreateRequest({ ...validRequest, idempotencyKey: "k".repeat(256) }).idempotencyKey,
    ).toHaveLength(256);
    expect(() => decodeCliCreateRequest(validRequest)).not.toThrow();

    for (const request of [
      { project: "project-1", message: "create this" },
      { ...validRequest, idempotencyKey: " " },
      { ...validRequest, idempotencyKey: "k".repeat(257) },
      { ...validRequest, message: "m".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1) },
      { ...validRequest, title: "t".repeat(257) },
    ]) {
      expect(() => decodeCliCreateRequest(request)).toThrow();
    }
  });

  it("decodes create and compact results with nonnegative sequences", () => {
    expect(
      decodeCliCreateResult({
        threadId: " thread-1 ",
        commandId: " command-1 ",
        turnId: " run-1 ",
        sequence: 0,
        replayed: true,
      }),
    ).toEqual({
      threadId: "thread-1",
      commandId: "command-1",
      turnId: "run-1",
      sequence: 0,
      replayed: true,
    });
    expect(
      decodeCompactResult({
        threadId: "thread-1",
        commandId: "command-2",
        sequence: 12,
        replayed: false,
      }),
    ).toEqual({ threadId: "thread-1", commandId: "command-2", sequence: 12, replayed: false });
    expect(() =>
      decodeCompactResult({
        threadId: "thread-1",
        commandId: "command-2",
        sequence: -1,
        replayed: false,
      }),
    ).toThrow();
  });

  it("normalizes compact idempotency keys and enforces their bound", () => {
    expect(
      decodeCompactRequest({ threadId: " thread-1 ", idempotencyKey: " request-key " }),
    ).toEqual({ threadId: "thread-1", idempotencyKey: "request-key" });
    expect(
      decodeCompactRequest({ threadId: "thread-1", idempotencyKey: "k".repeat(256) })
        .idempotencyKey,
    ).toHaveLength(256);

    for (const idempotencyKey of ["", " ", "k".repeat(257)]) {
      expect(() => decodeCompactRequest({ threadId: "thread-1", idempotencyKey })).toThrow();
    }
  });

  it("accepts only the established thread compaction completion reasons", () => {
    for (const reason of [
      "active-thread",
      "unsupported-provider",
      "provider-rejected",
      "request-interrupted",
      "recovery-required",
    ]) {
      expect(decodeCompactCompletionReason(reason)).toBe(reason);
    }
    expect(() => decodeCompactCompletionReason("unknown-reason")).toThrow();
  });
});

describe("environment HTTP errors", () => {
  it.effect("round-trips a worktree conflict reason and responds with status 409", () =>
    Effect.gen(function* () {
      const error = decodeConflictError(
        encodeConflictError(
          new EnvironmentHttpConflictError({
            message: "The requested worktree path already exists.",
            worktreeReason: "path_exists",
          }),
        ),
      );

      expect(error._tag).toBe("EnvironmentHttpConflictError");
      expect(error.message).toBe("The requested worktree path already exists.");
      expect(error.worktreeReason).toBe("path_exists");
      const response = yield* HttpServerRespondable.toResponse(error);
      const webResponse = HttpServerResponse.toWeb(response);
      expect(webResponse.status).toBe(409);
      expect(yield* Effect.promise(() => webResponse.json())).toEqual({
        _tag: "EnvironmentHttpConflictError",
        message: "The requested worktree path already exists.",
        worktreeReason: "path_exists",
      });
    }),
  );

  it("decodes deployed message-only conflict errors", () => {
    const error = decodeConflictError({
      _tag: "EnvironmentHttpConflictError",
      message: "The requested worktree could not be created.",
    });

    expect(error._tag).toBe("EnvironmentHttpConflictError");
    expect(error.message).toBe("The requested worktree could not be created.");
    expect(error.worktreeReason).toBeUndefined();
  });

  it.effect(
    "round-trips thread compaction errors through the common contract and responds with 409",
    () =>
      Effect.gen(function* () {
        const error = new EnvironmentThreadCompactionError({
          code: "thread_compaction_failed",
          reason: "provider-rejected",
          traceId,
        });
        const encoded = encodeThreadCompactionError(error);
        const decoded = decodeThreadCompactionError(encoded);
        const commonDecoded = decodeCommonError(encoded);

        expect(decoded._tag).toBe("EnvironmentThreadCompactionError");
        expect(decoded.code).toBe("thread_compaction_failed");
        expect(decoded.reason).toBe("provider-rejected");
        expect(decoded.traceId).toBe(traceId);
        if (commonDecoded._tag === "EnvironmentThreadCompactionError") {
          expect(commonDecoded.reason).toBe("provider-rejected");
        }
        expect(encoded).not.toHaveProperty("cause");
        expect(encoded).not.toHaveProperty("diagnostic");

        const response = yield* HttpServerRespondable.toResponse(decoded);
        const webResponse = HttpServerResponse.toWeb(response);
        expect(webResponse.status).toBe(409);
        expect(yield* Effect.promise(() => webResponse.json())).toEqual({
          _tag: "EnvironmentThreadCompactionError",
          code: "thread_compaction_failed",
          reason: "provider-rejected",
          traceId,
        });
      }),
  );

  it("derives a safe static message for every compaction failure reason", () => {
    const messages = {
      "active-thread": "The thread is active and cannot be compacted.",
      "unsupported-provider": "The selected provider does not support thread compaction.",
      "provider-rejected": "The provider rejected thread compaction.",
      "request-interrupted": "Thread compaction was interrupted.",
      "recovery-required": "Thread compaction requires recovery before it can continue.",
    } as const;

    for (const [reason, message] of Object.entries(messages)) {
      expect(
        new EnvironmentThreadCompactionError({
          code: "thread_compaction_failed",
          reason: reason as keyof typeof messages,
          traceId,
        }).message,
      ).toBe(message);
    }
  });

  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });
});
