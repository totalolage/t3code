import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  REMOTE_INTERACTION_ANSWER_VALUE_MAX_CHARS,
  REMOTE_INTERACTION_ID_MAX_CHARS,
  REMOTE_INTERACTION_OPTION_MAX_COUNT,
  REMOTE_INTERACTION_QUESTION_MAX_COUNT,
  RemoteInteractionAnswerRequest,
  RemoteInteractionApproveRequest,
  RemoteInteractionRejectRequest,
  RemoteInteractionResponseResult,
  RemotePendingInteractionsQuery,
  RemotePendingInteractionsResult,
  RemotePendingInteraction,
} from "./pendingInteractions.ts";

const decodeRemotePendingInteraction = Schema.decodeUnknownEffect(RemotePendingInteraction);
const decodeRemotePendingInteractionsResult = Schema.decodeUnknownEffect(
  RemotePendingInteractionsResult,
);
const decodeRemoteInteractionAnswerRequest = Schema.decodeUnknownEffect(
  RemoteInteractionAnswerRequest,
);
const decodeRemoteInteractionApproveRequest = Schema.decodeUnknownEffect(
  RemoteInteractionApproveRequest,
);
const decodeRemoteInteractionRejectRequest = Schema.decodeUnknownEffect(
  RemoteInteractionRejectRequest,
);
const decodeRemotePendingInteractionsQuery = Schema.decodeUnknownEffect(
  RemotePendingInteractionsQuery,
);
const decodeRemoteInteractionResponseResult = Schema.decodeUnknownEffect(
  RemoteInteractionResponseResult,
);

const validQuestion = {
  id: "environment",
  header: "Environment",
  prompt: "Which environment should be used?",
  options: [
    { label: "Local", description: "Run against the local environment." },
    { label: "Remote", description: "Run against the connected environment." },
  ],
  multiSelect: false,
  allowsCustomAnswer: true,
} as const;

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

const validUserInput = {
  threadId: "thread-1",
  requestId: "request-2",
  kind: "user-input",
  status: "pending",
  summary: "Input requested",
  canApprove: false,
  allowedActions: ["answer", "cancel"],
  questions: [validQuestion],
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
} as const;

const commonResponse = {
  threadId: "thread-1",
  requestId: "request-2",
  idempotencyKey: "retry-1",
} as const;

it.effect("decodes bounded pending interactions and redacted list results", () =>
  Effect.gen(function* () {
    const interaction = yield* decodeRemotePendingInteraction(validUserInput);
    const result = yield* decodeRemotePendingInteractionsResult({
      interactions: [validApproval, validUserInput],
    });

    assert.deepStrictEqual(interaction.questions, [validQuestion]);
    assert.deepStrictEqual(result as unknown, {
      interactions: [validApproval, validUserInput],
    });
  }),
);

it.effect("decodes answer, approve, reject, query, and response result shapes", () =>
  Effect.gen(function* () {
    const answer = yield* decodeRemoteInteractionAnswerRequest({
      ...commonResponse,
      answers: [{ questionId: "environment", values: ["Remote", "custom"] }],
    });
    const approve = yield* decodeRemoteInteractionApproveRequest(commonResponse);
    const reject = yield* decodeRemoteInteractionRejectRequest({
      ...commonResponse,
      decision: "decline",
    });
    const query = yield* decodeRemotePendingInteractionsQuery({
      threadId: " thread-1 ",
    });
    const result = yield* decodeRemoteInteractionResponseResult({
      ...commonResponse,
      status: "responding",
      action: "answer",
      replayed: false,
    });

    assert.deepStrictEqual(answer.answers, [
      { questionId: "environment", values: ["Remote", "custom"] },
    ]);
    assert.deepStrictEqual(approve as unknown, commonResponse);
    assert.deepStrictEqual(reject as unknown, { ...commonResponse, decision: "decline" });
    assert.strictEqual(query.threadId, "thread-1");
    assert.deepStrictEqual(result as unknown, {
      ...commonResponse,
      status: "responding",
      action: "answer",
      replayed: false,
    });
  }),
);

it.effect("rejects unknown fields at every public boundary, including nested answers", () =>
  Effect.gen(function* () {
    const pendingResultWithExtra = {
      interactions: [{ ...validUserInput, providerEnvelope: {} }],
    };
    const pendingQuestionWithExtra = {
      interactions: [
        {
          ...validUserInput,
          questions: [{ ...validQuestion, providerQuestion: {} }],
        },
      ],
    };
    const answerWithExtra = {
      ...commonResponse,
      answers: [{ questionId: "environment", values: ["Remote"], rawProviderAnswer: true }],
    };

    assert.strictEqual(
      (yield* Effect.exit(decodeRemotePendingInteractionsResult(pendingResultWithExtra)))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(decodeRemotePendingInteractionsResult(pendingQuestionWithExtra)))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(decodeRemoteInteractionAnswerRequest(answerWithExtra)))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeRemoteInteractionApproveRequest({
          ...commonResponse,
          providerEnvelope: {},
        }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeRemoteInteractionRejectRequest({
          ...commonResponse,
          decision: "decline",
          providerEnvelope: {},
        }),
      ))._tag,
      "Failure",
    );
  }),
);

it.effect("rejects identifier, interaction, answer, and result limits", () =>
  Effect.gen(function* () {
    for (const payload of [
      { ...commonResponse, threadId: "../thread" },
      { ...commonResponse, requestId: `t${"x".repeat(REMOTE_INTERACTION_ID_MAX_CHARS)}` },
      { ...commonResponse, idempotencyKey: `t${"x".repeat(128)}` },
    ]) {
      assert.strictEqual(
        (yield* Effect.exit(decodeRemoteInteractionApproveRequest(payload)))._tag,
        "Failure",
      );
    }

    const tooManyAnswers = Array.from(
      { length: REMOTE_INTERACTION_QUESTION_MAX_COUNT + 1 },
      (_, index) => ({ questionId: `question-${index}`, values: ["value"] }),
    );
    const tooManyValues = Array.from(
      { length: REMOTE_INTERACTION_OPTION_MAX_COUNT + 2 },
      (_, index) => `value-${index}`,
    );
    const tooLongValue = "x".repeat(REMOTE_INTERACTION_ANSWER_VALUE_MAX_CHARS + 1);

    for (const payload of [
      { ...commonResponse, answers: [] },
      { ...commonResponse, answers: tooManyAnswers },
      {
        ...commonResponse,
        answers: [{ questionId: "question-1", values: [] }],
      },
      {
        ...commonResponse,
        answers: [{ questionId: "question-1", values: tooManyValues }],
      },
      {
        ...commonResponse,
        answers: [{ questionId: "question-1", values: [tooLongValue] }],
      },
    ]) {
      assert.strictEqual(
        (yield* Effect.exit(decodeRemoteInteractionAnswerRequest(payload)))._tag,
        "Failure",
      );
    }

    assert.strictEqual(
      (yield* Effect.exit(
        decodeRemotePendingInteractionsResult({
          interactions: Array.from({ length: 101 }, () => validApproval),
        }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeRemotePendingInteraction({
          ...validUserInput,
          allowedActions: ["answer", "approve", "decline", "cancel"],
        }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeRemotePendingInteraction({
          ...validUserInput,
          questions: Array.from(
            { length: REMOTE_INTERACTION_QUESTION_MAX_COUNT + 1 },
            () => validQuestion,
          ),
        }),
      ))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeRemotePendingInteraction({
          ...validUserInput,
          questions: [
            {
              ...validQuestion,
              options: Array.from(
                { length: REMOTE_INTERACTION_OPTION_MAX_COUNT + 1 },
                () => validQuestion.options[0],
              ),
            },
          ],
        }),
      ))._tag,
      "Failure",
    );
  }),
);
