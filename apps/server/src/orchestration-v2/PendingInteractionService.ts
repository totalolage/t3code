import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";

import {
  CommandId,
  REMOTE_INTERACTION_OPTION_MAX_COUNT,
  RemoteInteractionRequestId,
  RemoteInteractionResponseResult,
  RuntimeRequestId,
} from "@t3tools/contracts";
import type {
  AuthSessionId,
  ProviderUserInputAnswers,
  RemoteInteractionAnswer,
  RemoteInteractionIdempotencyKey,
  RemotePendingInteractionAction,
  RemotePendingInteractionsResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  PendingInteractionResponseRepository,
  type InteractionRecord,
  type ResponseRecord,
} from "../persistence/Services/PendingInteractionResponses.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import {
  PendingInteractionQuery,
  type PendingInteractionQueryError,
} from "./PendingInteractionQuery.ts";
import { toRemotePendingInteraction } from "./PendingInteractionPresentation.ts";

export class PendingInteractionUnavailableError extends Schema.TaggedError<PendingInteractionUnavailableError>()(
  "PendingInteractionUnavailableError",
  {},
) {}

export class PendingInteractionInvalidResponseError extends Schema.TaggedError<PendingInteractionInvalidResponseError>()(
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

type PendingInteractionReadError = PendingInteractionQueryError;
type PendingInteractionResponseError =
  | PendingInteractionUnavailableError
  | PendingInteractionInvalidResponseError
  | PendingInteractionQueryError
  | OrchestratorV2Error
  | PlatformError.PlatformError;

export interface PendingInteractionServiceShape {
  readonly list: (input: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<RemotePendingInteractionsResult, PendingInteractionReadError>;
  readonly respond: (input: {
    readonly authSessionId: AuthSessionId;
    readonly threadId: ThreadId;
    readonly requestId: RemoteInteractionRequestId;
    readonly idempotencyKey: RemoteInteractionIdempotencyKey;
    readonly action: RemotePendingInteractionAction;
    readonly answers?: readonly RemoteInteractionAnswer[];
  }) => Effect.Effect<RemoteInteractionResponseResult, PendingInteractionResponseError>;
}

type RespondInput = Parameters<PendingInteractionServiceShape["respond"]>[0];
type NormalizedRespondInput = Omit<RespondInput, "requestId"> & {
  readonly requestId: RuntimeRequestId;
  readonly publicRequestId: RemoteInteractionRequestId;
};

export class PendingInteractionService extends Context.Service<
  PendingInteractionService,
  PendingInteractionServiceShape
>()("t3/orchestration-v2/PendingInteractionService") {}

// The normalized form is keyed by provider question ID with ordered
// string-array values. It is both the version-1 semantic-hash form and the
// native callback answer form; message-mode commands convert it at the
// dispatch boundary only.
type NormalizedAnswers = Record<string, ReadonlyArray<string>>;

function normalizeAnswers(
  interaction: InteractionRecord,
  answers: ReadonlyArray<RemoteInteractionAnswer>,
): NormalizedAnswers | null {
  if (interaction.kind !== "user-input" || answers.length !== interaction.questions.length) {
    return null;
  }

  const questionIds = interaction.questions.map((question) => question.id);
  const providerQuestionIds = interaction.questions.map(
    (question) => question.providerQuestionId ?? question.id,
  );
  if (
    new Set(questionIds).size !== questionIds.length ||
    new Set(providerQuestionIds).size !== providerQuestionIds.length
  ) {
    return null;
  }

  const submitted = new Map(answers.map((answer) => [answer.questionId, answer.values]));
  if (submitted.size !== answers.length) {
    return null;
  }

  const normalizedEntries: Array<readonly [string, ReadonlyArray<string>]> = [];
  for (const question of interaction.questions) {
    const values = submitted.get(question.id);
    if (
      values === undefined ||
      values.length === 0 ||
      values.length > REMOTE_INTERACTION_OPTION_MAX_COUNT + 1 ||
      (!question.multiSelect && values.length !== 1)
    ) {
      return null;
    }

    const providerValues = new Map(
      question.options.map((option) => [option.label, option.providerValue ?? option.label]),
    );
    if (!question.allowsCustomAnswer && values.some((value) => !providerValues.has(value))) {
      return null;
    }

    normalizedEntries.push([
      question.providerQuestionId ?? question.id,
      values.map((value) => providerValues.get(value) ?? value),
    ]);
  }

  // Object.fromEntries creates an own data property for keys such as
  // "__proto__"; assigning into a plain object here would mutate its prototype.
  return Object.fromEntries(normalizedEntries);
}

function semanticHash(input: {
  readonly threadId: ThreadId;
  readonly requestId: RuntimeRequestId;
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

  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          threadId: input.threadId,
          requestId: input.requestId,
          action: input.action,
          ...(answers === undefined ? {} : { answers }),
        }),
      ),
    ),
  );
}

const decodeResponseResult = Schema.decodeUnknownSync(RemoteInteractionResponseResult);
const decodeRuntimeRequestId = Schema.decodeUnknownOption(RuntimeRequestId);

function responseResult(
  input: NormalizedRespondInput,
  replayed: boolean,
): RemoteInteractionResponseResult {
  return decodeResponseResult({
    threadId: input.threadId,
    requestId: input.publicRequestId,
    status: "responding",
    action: input.action,
    idempotencyKey: input.idempotencyKey,
    replayed,
  });
}

function responseMatches(
  response: ResponseRecord,
  input: NormalizedRespondInput,
  expectedSemanticHash: string,
): boolean {
  return (
    response.threadId === input.threadId &&
    response.requestId === input.requestId &&
    response.action === input.action &&
    response.semanticHash === expectedSemanticHash
  );
}

function responseForExisting(
  response: ResponseRecord,
  input: NormalizedRespondInput,
  expectedSemanticHash: string,
): Effect.Effect<
  RemoteInteractionResponseResult,
  PendingInteractionUnavailableError | PendingInteractionInvalidResponseError
> {
  if (!responseMatches(response, input, expectedSemanticHash)) {
    return Effect.fail(
      new PendingInteractionInvalidResponseError({ reason: "idempotency_conflict" }),
    );
  }
  if (response.dispatchedAt === null) {
    return Effect.fail(new PendingInteractionUnavailableError());
  }
  return Effect.succeed(responseResult(input, true));
}

type ResponseValidation =
  | { readonly _tag: "valid"; readonly answers?: NormalizedAnswers }
  | { readonly _tag: "invalid"; readonly error: PendingInteractionInvalidResponseError };

function validateNewResponse(
  interaction: InteractionRecord,
  input: NormalizedRespondInput,
): ResponseValidation {
  if (input.action === "answer") {
    if (interaction.kind !== "user-input") {
      return {
        _tag: "invalid",
        error: new PendingInteractionInvalidResponseError({ reason: "wrong_kind" }),
      };
    }
    const normalized = normalizeAnswers(interaction, input.answers ?? []);
    if (normalized === null) {
      return {
        _tag: "invalid",
        error: new PendingInteractionInvalidResponseError({ reason: "invalid_answers" }),
      };
    }
    return { _tag: "valid", answers: normalized };
  }

  if (interaction.kind !== "approval") {
    return {
      _tag: "invalid",
      error: new PendingInteractionInvalidResponseError({ reason: "wrong_kind" }),
    };
  }
  if (input.action === "approve" && interaction.canApprove !== true) {
    return {
      _tag: "invalid",
      error: new PendingInteractionInvalidResponseError({ reason: "approval_not_safe" }),
    };
  }
  return { _tag: "valid" };
}

function normalizedForExisting(
  interaction: InteractionRecord,
  input: NormalizedRespondInput,
): ResponseValidation {
  if (input.action !== "answer") {
    if (input.action === "approve") {
      return {
        _tag: "invalid",
        error: new PendingInteractionInvalidResponseError({ reason: "approval_not_safe" }),
      };
    }
    return interaction.kind === "approval"
      ? { _tag: "valid" }
      : {
          _tag: "invalid",
          error: new PendingInteractionInvalidResponseError({ reason: "wrong_kind" }),
        };
  }
  if (interaction.kind !== "user-input") {
    return {
      _tag: "invalid",
      error: new PendingInteractionInvalidResponseError({ reason: "wrong_kind" }),
    };
  }
  const normalized = normalizeAnswers(interaction, input.answers ?? []);
  if (normalized === null) {
    return {
      _tag: "invalid",
      error: new PendingInteractionInvalidResponseError({ reason: "invalid_answers" }),
    };
  }
  return { _tag: "valid", answers: normalized };
}

export const PendingInteractionServiceLive = Layer.effect(
  PendingInteractionService,
  Effect.gen(function* () {
    const responseRepository = yield* PendingInteractionResponseRepository;
    const pendingInteractionQuery = yield* PendingInteractionQuery;
    const orchestrator = yield* OrchestratorV2;
    const crypto = yield* Crypto.Crypto;
    const respondSemaphore = yield* Semaphore.make(1);

    const list: PendingInteractionServiceShape["list"] = Effect.fn(
      "PendingInteractionService.list",
    )(function* (input) {
      const queried = yield* pendingInteractionQuery.list(input);
      const interactions = [];

      for (const entry of queried.slice(0, 100)) {
        const archived = yield* responseRepository.getInteraction({
          threadId: entry.interaction.threadId,
          requestId: entry.interaction.requestId,
        });
        if (Option.isNone(archived)) {
          interactions.push(toRemotePendingInteraction(entry.interaction));
          continue;
        }

        if (archived.value.status !== "responding") {
          continue;
        }

        // The query result remains authoritative for provider payloads. Only
        // response lifecycle fields come from the archive, which may contain
        // old or otherwise untrusted data.
        interactions.push(
          toRemotePendingInteraction({
            ...entry.interaction,
            status: "responding",
            responseAction: archived.value.responseAction,
            responseCommandId: archived.value.responseCommandId,
            updatedAt: archived.value.updatedAt,
          }),
        );
      }

      return { interactions } satisfies RemotePendingInteractionsResult;
    });

    const respondUnlocked = Effect.fn("PendingInteractionService.respondUnlocked")(function* (
      input: NormalizedRespondInput,
    ) {
      const responseKey = {
        authSessionId: input.authSessionId,
        idempotencyKey: input.idempotencyKey,
      };
      const prior = yield* responseRepository.getByKey(responseKey);

      if (Option.isSome(prior)) {
        if (
          prior.value.threadId !== input.threadId ||
          prior.value.requestId !== input.requestId ||
          prior.value.action !== input.action
        ) {
          return yield* new PendingInteractionInvalidResponseError({
            reason: "idempotency_conflict",
          });
        }

        const snapshot = yield* responseRepository.getInteraction({
          threadId: prior.value.threadId,
          requestId: input.requestId,
        });
        if (Option.isNone(snapshot)) {
          return yield* new PendingInteractionUnavailableError();
        }

        const normalizedResponse = normalizedForExisting(snapshot.value, input);
        if (normalizedResponse._tag === "invalid") {
          return yield* normalizedResponse.error;
        }
        const normalizedAnswers = normalizedResponse.answers;
        const expectedSemanticHash = semanticHash({
          threadId: input.threadId,
          requestId: input.requestId,
          action: input.action,
          ...(normalizedAnswers === undefined ? {} : { answers: normalizedAnswers }),
        });
        return yield* responseForExisting(prior.value, input, expectedSemanticHash);
      }

      const current = yield* pendingInteractionQuery.get({
        threadId: input.threadId,
        requestId: input.publicRequestId,
      });
      if (Option.isNone(current) || current.value.interaction.status !== "pending") {
        return yield* new PendingInteractionUnavailableError();
      }

      const archived = yield* responseRepository.getInteraction({
        threadId: input.threadId,
        requestId: input.requestId,
      });
      if (Option.isSome(archived)) {
        return yield* new PendingInteractionUnavailableError();
      }

      const validatedResponse = validateNewResponse(current.value.interaction, input);
      if (validatedResponse._tag === "invalid") {
        return yield* validatedResponse.error;
      }
      if (input.action === "approve") {
        return yield* new PendingInteractionInvalidResponseError({ reason: "approval_not_safe" });
      }
      const normalizedAnswers = validatedResponse.answers;
      const expectedSemanticHash = semanticHash({
        threadId: input.threadId,
        requestId: input.requestId,
        action: input.action,
        ...(normalizedAnswers === undefined ? {} : { answers: normalizedAnswers }),
      });
      // Message-mode questions take one newline-joined string per question at
      // the native command boundary. The durable claim and semantic hash keep
      // the array-normalized form, so an accepted claim replays without the
      // query or any dispatch-time conversion evidence.
      const dispatchAnswers: ProviderUserInputAnswers | undefined =
        normalizedAnswers === undefined
          ? undefined
          : current.value.responseMode === "message"
            ? Object.fromEntries(
                Object.entries(normalizedAnswers).map(([key, values]) => [key, values.join("\n")]),
              )
            : normalizedAnswers;
      const commandCreatedAt = DateTime.formatIso(yield* DateTime.now);
      const response: ResponseRecord = {
        authSessionId: input.authSessionId,
        idempotencyKey: input.idempotencyKey,
        threadId: input.threadId,
        requestId: input.requestId,
        action: input.action,
        semanticHash: expectedSemanticHash,
        commandId: CommandId.make(`remote-interaction:${yield* crypto.randomUUIDv4}`),
        commandCreatedAt,
        dispatchedAt: null,
      };

      const claimed = yield* responseRepository.claim({
        interaction: current.value.interaction,
        response,
      });
      if (claimed._tag === "Conflict") {
        const raced = yield* responseRepository.getByKey(responseKey);
        if (Option.isNone(raced)) {
          return yield* new PendingInteractionUnavailableError();
        }
        return yield* responseForExisting(raced.value, input, expectedSemanticHash);
      }
      if (claimed._tag === "Existing") {
        return yield* responseForExisting(claimed.response, input, expectedSemanticHash);
      }

      if (input.action === "answer") {
        if (dispatchAnswers === undefined) {
          return yield* new PendingInteractionInvalidResponseError({ reason: "invalid_answers" });
        }
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: claimed.response.commandId,
          threadId: input.threadId,
          requestId: current.value.interaction.requestId,
          answers: dispatchAnswers,
        });
      } else if (input.action === "decline" || input.action === "cancel") {
        yield* orchestrator.dispatch({
          type: "runtime-request.respond",
          commandId: claimed.response.commandId,
          threadId: input.threadId,
          requestId: current.value.interaction.requestId,
          decision: input.action,
        });
      } else {
        return yield* new PendingInteractionInvalidResponseError({ reason: "approval_not_safe" });
      }

      const dispatchedAt = DateTime.formatIso(yield* DateTime.now);
      yield* responseRepository.markDispatched({
        authSessionId: input.authSessionId,
        idempotencyKey: input.idempotencyKey,
        commandId: claimed.response.commandId,
        dispatchedAt,
      });
      return responseResult(input, false);
    });

    const respond: PendingInteractionServiceShape["respond"] = (input) => {
      const requestId = decodeRuntimeRequestId(input.requestId);
      if (Option.isNone(requestId)) return Effect.fail(new PendingInteractionUnavailableError());
      return respondSemaphore.withPermits(1)(
        respondUnlocked({ ...input, publicRequestId: input.requestId, requestId: requestId.value }),
      );
    };

    return PendingInteractionService.of({ list, respond });
  }),
);
