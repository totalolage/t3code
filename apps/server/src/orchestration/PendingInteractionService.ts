import * as NodeCrypto from "node:crypto";

import {
  ApprovalRequestId,
  AuthSessionId,
  CommandId,
  type ProviderUserInputAnswers,
  type RemoteInteractionAnswer,
  type RemoteInteractionIdempotencyKey,
  type RemoteInteractionResponseResult,
  type RemotePendingInteraction,
  type RemotePendingInteractionAction,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PendingInteractionRepository,
  type PendingInteractionRow,
} from "../persistence/Services/PendingInteractions.ts";
import type { OrchestrationCommandDispatcherShape } from "./Services/OrchestrationCommandDispatcher.ts";
import { sanitizeRemoteInteractionText } from "./pendingInteractionSanitizer.ts";

export class PendingInteractionUnavailableError extends Schema.TaggedErrorClass<PendingInteractionUnavailableError>()(
  "PendingInteractionUnavailableError",
  {},
) {}

export class PendingInteractionInvalidResponseError extends Schema.TaggedErrorClass<PendingInteractionInvalidResponseError>()(
  "PendingInteractionInvalidResponseError",
  {
    reason: Schema.Literals([
      "wrong_kind",
      "approval_not_safe",
      "invalid_answers",
      "idempotency_conflict",
    ]),
  },
) {}

function allowedActions(row: PendingInteractionRow): ReadonlyArray<RemotePendingInteractionAction> {
  if (row.status === "responding") {
    return [];
  }
  if (row.kind === "user-input") {
    return ["answer"];
  }
  return row.canApprove ? ["approve", "decline", "cancel"] : ["decline", "cancel"];
}

export function toRemotePendingInteraction(row: PendingInteractionRow): RemotePendingInteraction {
  const questions =
    row.kind === "user-input"
      ? row.questions.map((question) => ({
          id: question.id,
          header: sanitizeRemoteInteractionText(question.header, "Input needed").slice(0, 64),
          prompt: sanitizeRemoteInteractionText(question.prompt, "The agent needs input."),
          options: question.options.map((option) => ({
            label: sanitizeRemoteInteractionText(option.label, "Option").slice(0, 160),
            description: sanitizeRemoteInteractionText(
              option.description,
              "Available choice",
            ).slice(0, 160),
          })),
          multiSelect: question.multiSelect,
          allowsCustomAnswer: question.allowsCustomAnswer,
        }))
      : [];
  return {
    threadId: row.threadId,
    requestId: row.requestId,
    kind: row.kind,
    status: row.status === "responding" ? "responding" : "pending",
    summary: sanitizeRemoteInteractionText(row.summary, "Interaction requested"),
    canApprove: row.kind === "approval" && row.canApprove,
    allowedActions: [...allowedActions(row)],
    questions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeAnswers(
  row: PendingInteractionRow,
  answers: ReadonlyArray<RemoteInteractionAnswer>,
): ProviderUserInputAnswers | null {
  if (row.kind !== "user-input" || answers.length !== row.questions.length) {
    return null;
  }
  const submitted = new Map(answers.map((answer) => [answer.questionId, answer.values]));
  if (submitted.size !== answers.length) {
    return null;
  }
  const normalized: Record<string, ReadonlyArray<string>> = {};
  for (const question of row.questions) {
    const values = submitted.get(question.id);
    if (!values || values.length === 0 || (!question.multiSelect && values.length !== 1)) {
      return null;
    }
    const providerValues = new Map(
      question.options.map((option) => [option.label, option.providerValue ?? option.label]),
    );
    if (!question.allowsCustomAnswer && values.some((value) => !providerValues.has(value))) {
      return null;
    }
    normalized[question.providerQuestionId ?? question.id] = values.map(
      (value) => providerValues.get(value) ?? value,
    );
  }
  return normalized;
}

function semanticHash(input: {
  readonly threadId: ThreadId;
  readonly requestId: ApprovalRequestId;
  readonly action: RemotePendingInteractionAction;
  readonly answers?: ProviderUserInputAnswers;
}): string {
  const answers =
    input.answers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.answers)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, values]) => [key, values]),
        );
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        threadId: input.threadId,
        requestId: input.requestId,
        action: input.action,
        ...(answers === undefined ? {} : { answers }),
      }),
    )
    .digest("hex");
}

export const listRemotePendingInteractions = Effect.fn("pendingInteractions.list")(function* (
  input: { readonly threadId?: ThreadId } = {},
) {
  const repository = yield* PendingInteractionRepository;
  const rows = yield* repository.listOpen(input);
  return {
    interactions: rows.slice(0, 100).map(toRemotePendingInteraction),
  };
});

export const respondToRemotePendingInteraction = Effect.fn("pendingInteractions.respond")(
  function* (input: {
    readonly authSessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly idempotencyKey: RemoteInteractionIdempotencyKey;
    readonly action: RemotePendingInteractionAction;
    readonly answers?: ReadonlyArray<RemoteInteractionAnswer>;
    readonly dispatcher: OrchestrationCommandDispatcherShape;
  }) {
    const repository = yield* PendingInteractionRepository;
    const rowOption = yield* repository.get({
      threadId: input.threadId,
      requestId: input.requestId,
    });
    if (Option.isNone(rowOption)) {
      return yield* new PendingInteractionUnavailableError();
    }
    const row = rowOption.value;
    const interactionOpen = row.status === "pending" || row.status === "responding";

    let answers: ProviderUserInputAnswers | undefined;
    if (input.action === "answer") {
      answers = normalizeAnswers(row, input.answers ?? []) ?? undefined;
      if (answers === undefined) {
        return yield* interactionOpen
          ? new PendingInteractionInvalidResponseError({ reason: "invalid_answers" })
          : new PendingInteractionUnavailableError();
      }
    } else {
      if (row.kind !== "approval") {
        return yield* interactionOpen
          ? new PendingInteractionInvalidResponseError({ reason: "wrong_kind" })
          : new PendingInteractionUnavailableError();
      }
      if (input.action === "approve" && !row.canApprove) {
        return yield* interactionOpen
          ? new PendingInteractionInvalidResponseError({ reason: "approval_not_safe" })
          : new PendingInteractionUnavailableError();
      }
    }

    const crypto = yield* Crypto.Crypto;
    const commandId = CommandId.make(`remote-interaction:${yield* crypto.randomUUIDv4}`);
    const commandCreatedAt = DateTime.formatIso(yield* DateTime.now);
    const claimed = yield* repository.claimResponse({
      authSessionId: input.authSessionId,
      idempotencyKey: input.idempotencyKey,
      threadId: input.threadId,
      requestId: input.requestId,
      action: input.action,
      semanticHash: semanticHash({
        threadId: input.threadId,
        requestId: input.requestId,
        action: input.action,
        ...(answers === undefined ? {} : { answers }),
      }),
      commandId,
      commandCreatedAt,
    });
    if (claimed._tag === "conflict") {
      return yield* interactionOpen
        ? new PendingInteractionInvalidResponseError({ reason: "idempotency_conflict" })
        : new PendingInteractionUnavailableError();
    }
    if (claimed._tag === "unavailable") {
      return yield* new PendingInteractionUnavailableError();
    }

    if (!claimed.dispatchAccepted) {
      yield* input.dispatcher.dispatch(
        input.action === "answer"
          ? {
              type: "thread.user-input.respond",
              commandId: claimed.commandId,
              threadId: input.threadId,
              requestId: input.requestId,
              answers: answers!,
              createdAt: claimed.commandCreatedAt,
            }
          : {
              type: "thread.approval.respond",
              commandId: claimed.commandId,
              threadId: input.threadId,
              requestId: input.requestId,
              decision: input.action === "approve" ? "accept" : input.action,
              createdAt: claimed.commandCreatedAt,
            },
      );
      yield* repository.markDispatchAccepted({
        authSessionId: input.authSessionId,
        idempotencyKey: input.idempotencyKey,
        commandId: claimed.commandId,
        dispatchedAt: DateTime.formatIso(yield* DateTime.now),
      });
    }
    return {
      threadId: input.threadId,
      requestId: input.requestId,
      status: "responding",
      action: input.action,
      idempotencyKey: input.idempotencyKey,
      replayed: claimed._tag === "replayed",
    } satisfies RemoteInteractionResponseResult;
  },
);
