import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  REMOTE_INTERACTION_ANSWER_VALUE_MAX_CHARS,
  REMOTE_INTERACTION_ID_MAX_CHARS,
  REMOTE_INTERACTION_QUESTION_MAX_COUNT,
  RemoteInteractionAnswerRequest,
  RemoteInteractionApproveRequest,
  RemotePendingInteraction,
} from "./pendingInteractions.ts";

const validApproval = {
  threadId: "thread-1",
  requestId: "request-1",
  kind: "approval",
  status: "pending",
  summary: "Approval requested",
  canApprove: false,
  allowedActions: ["decline", "cancel"],
  questions: [],
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
} as const;

const decodeRemotePendingInteraction = Schema.decodeUnknownEffect(RemotePendingInteraction);

it.effect("decodes bounded pending interaction DTOs with arrays always present", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeRemotePendingInteraction(validApproval);
    assert.deepStrictEqual(decoded.allowedActions, ["decline", "cancel"]);
    assert.deepStrictEqual(decoded.questions, []);
  }),
);

it.effect("rejects path-like, oversized, and excess request identifiers", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(RemoteInteractionApproveRequest);
    for (const payload of [
      { threadId: "../thread", requestId: "request-1", idempotencyKey: "retry-1" },
      {
        threadId: `t${"x".repeat(REMOTE_INTERACTION_ID_MAX_CHARS)}`,
        requestId: "request-1",
        idempotencyKey: "retry-1",
      },
      {
        threadId: "thread-1",
        requestId: "request-1",
        idempotencyKey: "retry-1",
        providerEnvelope: {},
      },
    ]) {
      assert.strictEqual((yield* Effect.exit(decode(payload)))._tag, "Failure");
    }
  }),
);

it.effect("rejects oversized or malformed answer documents before forwarding", () =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(RemoteInteractionAnswerRequest);
    const common = {
      threadId: "thread-1",
      requestId: "request-1",
      idempotencyKey: "retry-1",
    };
    const tooManyAnswers = Array.from(
      { length: REMOTE_INTERACTION_QUESTION_MAX_COUNT + 1 },
      (_, index) => ({ questionId: `question-${index}`, values: ["value"] }),
    );
    const tooLongValue = "x".repeat(REMOTE_INTERACTION_ANSWER_VALUE_MAX_CHARS + 1);

    assert.strictEqual(
      (yield* Effect.exit(decode({ ...common, answers: tooManyAnswers })))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decode({ ...common, answers: [{ questionId: "question-1", values: [tooLongValue] }] }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decode({
          ...common,
          answers: [{ questionId: "question-1", values: ["value"], rawProviderAnswer: true }],
        }),
      ))._tag,
      "Failure",
    );
  }),
);
