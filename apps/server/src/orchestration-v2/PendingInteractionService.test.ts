import {
  AuthSessionId,
  CommandId,
  RemoteInteractionRequestId,
  RuntimeRequestId,
  ThreadId,
  type IsoDateTime,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestratorDispatchError, OrchestratorV2 } from "./Orchestrator.ts";
import {
  PendingInteractionService,
  PendingInteractionServiceLive,
} from "./PendingInteractionService.ts";
import {
  PendingInteractionQuery,
  type NativePendingInteraction,
} from "./PendingInteractionQuery.ts";
import {
  PendingInteractionResponseRepository,
  type InteractionRecord,
  type ResponseRecord,
} from "../persistence/Services/PendingInteractionResponses.ts";

const NOW = "2026-07-22T00:00:00.000Z" as IsoDateTime;
const LATER = "2026-07-22T00:00:01.000Z" as IsoDateTime;

type QueryEntry = Readonly<{
  readonly interaction: InteractionRecord;
  readonly responseMode?: "message";
}>;

type ResponseInput = Parameters<PendingInteractionService["Service"]["respond"]>[0];

interface HarnessState {
  readonly entries: Map<string, QueryEntry>;
  readonly archivedInteractions: Map<string, InteractionRecord>;
  readonly responses: Map<string, ResponseRecord>;
  readonly commands: OrchestrationV2ServerCommand[];
  readonly listInputs: Array<{ readonly threadId?: ThreadId }>;
  readonly getInputs: Array<{
    readonly threadId: ThreadId;
    readonly requestId: RemoteInteractionRequestId;
  }>;
  readonly getInteractionInputs: Array<{
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
  }>;
  dispatchError: OrchestratorDispatchError | null;
  dispatchStarted: Deferred.Deferred<void> | null;
  releaseDispatch: Deferred.Deferred<void> | null;
}

function interactionKey(threadId: string, requestId: string): string {
  return `${threadId}\u0000${requestId}`;
}

function responseKey(authSessionId: AuthSessionId, idempotencyKey: string): string {
  return `${authSessionId}\u0000${idempotencyKey}`;
}

function makeUserInteraction(
  key: string,
  overrides: Partial<InteractionRecord> = {},
): InteractionRecord {
  const threadId = ThreadId.make(`thread-${key}`);
  const requestId = RuntimeRequestId.make(`request-${key}`);
  return {
    threadId,
    requestId,
    kind: "user-input",
    status: "pending",
    summary: `Input requested for ${key}`,
    canApprove: false,
    questions: [
      {
        id: `question-${key}`,
        providerQuestionId: `provider-question-${key}`,
        header: "Choose",
        prompt: `Choose a value for ${key}`,
        options: [
          {
            label: "Private",
            description: "Use the private provider value.",
            providerValue: `/private/${key}`,
          },
          {
            label: "Public",
            description: "Use the public provider value.",
            providerValue: `/public/${key}`,
          },
        ],
        multiSelect: false,
        allowsCustomAnswer: false,
      },
    ],
    responseAction: null,
    responseCommandId: null,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
    ...overrides,
  };
}

function makeApprovalInteraction(key: string, canApprove: boolean): InteractionRecord {
  return makeUserInteraction(key, {
    kind: "approval",
    canApprove,
    questions: [],
  });
}

function makeHashInteraction(key = "hash"): InteractionRecord {
  return {
    threadId: ThreadId.make(`thread-${key}`),
    requestId: RuntimeRequestId.make(`request-${key}`),
    kind: "user-input",
    status: "pending",
    summary: "Hash input",
    canApprove: false,
    questions: [
      {
        id: "readable",
        providerQuestionId: "__proto__",
        header: "Readable",
        prompt: "Choose a readable value",
        options: [
          {
            label: "Readable",
            description: "A readable choice",
            providerValue: "provider-readable",
          },
        ],
        multiSelect: false,
        allowsCustomAnswer: false,
      },
      {
        id: "ordered",
        providerQuestionId: "z",
        header: "Ordered",
        prompt: "Keep these values ordered",
        options: [],
        multiSelect: true,
        allowsCustomAnswer: true,
      },
    ],
    responseAction: null,
    responseCommandId: null,
    createdAt: NOW,
    updatedAt: NOW,
    resolvedAt: null,
  };
}

function makeState(): HarnessState {
  return {
    entries: new Map(),
    archivedInteractions: new Map(),
    responses: new Map(),
    commands: [],
    listInputs: [],
    getInputs: [],
    getInteractionInputs: [],
    dispatchError: null,
    dispatchStarted: null,
    releaseDispatch: null,
  };
}

function toQueryEntry(entry: QueryEntry): NativePendingInteraction {
  return {
    interaction: entry.interaction,
    ...(entry.responseMode === undefined ? {} : { responseMode: entry.responseMode }),
  };
}

function makeQuery(state: HarnessState): PendingInteractionQuery["Service"] {
  return {
    list: (input) =>
      Effect.sync(() => {
        state.listInputs.push(input);
        return Array.from(state.entries.values())
          .filter(
            (entry) =>
              input.threadId === undefined || entry.interaction.threadId === input.threadId,
          )
          .map(toQueryEntry);
      }),
    get: (input) =>
      Effect.sync(() => {
        state.getInputs.push(input);
        const entry = state.entries.get(interactionKey(input.threadId, input.requestId));
        return entry === undefined ? Option.none() : Option.some(toQueryEntry(entry));
      }),
  };
}

function makeRepository(state: HarnessState): PendingInteractionResponseRepository["Service"] {
  return {
    getByKey: (input) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(
          state.responses.get(responseKey(input.authSessionId, input.idempotencyKey)),
        ),
      ),
    getInteraction: (input) =>
      Effect.sync(() => {
        state.getInteractionInputs.push(input);
        return Option.fromUndefinedOr(
          state.archivedInteractions.get(interactionKey(input.threadId, input.requestId)),
        );
      }),
    claim: ({ interaction, response }) =>
      Effect.sync(() => {
        const key = responseKey(response.authSessionId, response.idempotencyKey);
        const existingResponse = state.responses.get(key);
        if (existingResponse !== undefined) {
          return existingResponse.threadId === response.threadId &&
            existingResponse.requestId === response.requestId &&
            existingResponse.action === response.action &&
            existingResponse.semanticHash === response.semanticHash
            ? { _tag: "Existing", response: existingResponse }
            : { _tag: "Conflict" };
        }

        const existingInteraction = state.archivedInteractions.get(
          interactionKey(interaction.threadId, interaction.requestId),
        );
        if (existingInteraction !== undefined) {
          return { _tag: "Conflict" };
        }

        state.archivedInteractions.set(
          interactionKey(interaction.threadId, interaction.requestId),
          interaction,
        );
        state.responses.set(key, response);
        return { _tag: "Acquired", response };
      }),
    markDispatched: (input) =>
      Effect.sync(() => {
        const key = responseKey(input.authSessionId, input.idempotencyKey);
        const response = state.responses.get(key);
        if (response === undefined || response.commandId !== input.commandId) return;

        state.responses.set(key, { ...response, dispatchedAt: input.dispatchedAt });
        const interactionKeyValue = interactionKey(response.threadId, response.requestId);
        const interaction = state.archivedInteractions.get(interactionKeyValue);
        if (interaction?.status === "pending") {
          state.archivedInteractions.set(interactionKeyValue, {
            ...interaction,
            status: "responding",
            responseAction: response.action,
            responseCommandId: response.commandId,
            updatedAt: input.dispatchedAt,
          });
        }
      }),
  };
}

function makeOrchestratorLayer(state: HarnessState) {
  return Layer.mock(OrchestratorV2)({
    dispatch: (command) => {
      state.commands.push(command);
      if (state.dispatchError !== null) {
        return Effect.fail(state.dispatchError);
      }
      const dispatchStarted = state.dispatchStarted;
      const releaseDispatch = state.releaseDispatch;
      if (dispatchStarted !== null && releaseDispatch !== null) {
        return Deferred.succeed(dispatchStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseDispatch)),
          Effect.as({ sequence: 1, storedEvents: [] }),
        );
      }
      return Effect.succeed({ sequence: 1, storedEvents: [] });
    },
  });
}

function makeLayer(state: HarnessState) {
  return PendingInteractionServiceLive.pipe(
    Layer.provide(Layer.succeed(PendingInteractionResponseRepository, makeRepository(state))),
    Layer.provide(Layer.succeed(PendingInteractionQuery, makeQuery(state))),
    Layer.provide(makeOrchestratorLayer(state)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function answerInput(
  interaction: InteractionRecord,
  key: string,
  value = "Private",
): ResponseInput {
  const question = interaction.questions[0];
  if (question === undefined) throw new Error("Expected a user-input question");
  return {
    authSessionId: AuthSessionId.make(`session-${key}`),
    threadId: interaction.threadId,
    requestId: RemoteInteractionRequestId.make(interaction.requestId),
    idempotencyKey: `retry-${key}`,
    action: "answer",
    answers: [{ questionId: question.id, values: [value] }],
  };
}

function approvalInput(
  interaction: InteractionRecord,
  key: string,
  action: "approve" | "decline" | "cancel",
): ResponseInput {
  return {
    authSessionId: AuthSessionId.make(`session-${key}`),
    threadId: interaction.threadId,
    requestId: RemoteInteractionRequestId.make(interaction.requestId),
    idempotencyKey: `retry-${key}`,
    action,
  };
}

function addEntry(
  state: HarnessState,
  interaction: InteractionRecord,
  responseMode?: "message",
): void {
  state.entries.set(interactionKey(interaction.threadId, interaction.requestId), {
    interaction,
    ...(responseMode === undefined ? {} : { responseMode }),
  });
}

function errorFrom<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<E, A> {
  return effect.pipe(Effect.flip);
}

describe("PendingInteractionService", () => {
  it.effect("serializes duplicate responses and dispatches exactly once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = makeState();
        const interaction = makeUserInteraction("duplicate");
        addEntry(state, interaction);
        state.dispatchStarted = yield* Deferred.make<void>();
        state.releaseDispatch = yield* Deferred.make<void>();

        const service = yield* Effect.gen(function* () {
          return yield* PendingInteractionService;
        }).pipe(Effect.provide(makeLayer(state)));
        const input = answerInput(interaction, "duplicate");

        const first = yield* service.respond(input).pipe(Effect.forkChild);
        yield* Deferred.await(state.dispatchStarted);
        const second = yield* service.respond(input).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.strictEqual(state.commands.length, 1);

        yield* Deferred.succeed(state.releaseDispatch, undefined);
        const firstResult = yield* Fiber.join(first);
        const secondResult = yield* Fiber.join(second);
        assert.strictEqual(firstResult.replayed, false);
        assert.strictEqual(secondResult.replayed, true);
        assert.strictEqual(state.commands.length, 1);
      }),
    ),
  );

  it.effect("includes native requests that predate this server process", () => {
    const state = makeState();
    const oldInteraction = makeUserInteraction("startup-old");
    const currentInteraction = makeUserInteraction("startup-current");
    addEntry(state, oldInteraction);
    addEntry(state, currentInteraction);

    return Effect.gen(function* () {
      const service = yield* PendingInteractionService;
      const listed = yield* service.list({});
      assert.deepStrictEqual(
        listed.interactions.map(({ requestId }) => requestId),
        [
          RemoteInteractionRequestId.make(oldInteraction.requestId),
          RemoteInteractionRequestId.make(currentInteraction.requestId),
        ],
      );

      yield* service.respond(answerInput(currentInteraction, "startup-current"));
      assert.deepStrictEqual(state.listInputs, [{}]);
      assert.deepStrictEqual(state.getInputs, [
        {
          threadId: currentInteraction.threadId,
          requestId: RemoteInteractionRequestId.make(currentInteraction.requestId),
        },
      ]);
    }).pipe(Effect.provide(makeLayer(state)));
  });

  it.effect("replays an accepted response after restart without querying or dispatching", () => {
    const state = makeState();
    const interaction = makeUserInteraction("restart-accepted");
    addEntry(state, interaction);
    const input = answerInput(interaction, "restart-accepted");

    return Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* service.respond(input);
      }).pipe(Effect.provide(makeLayer(state)));
      assert.strictEqual(first.replayed, false);
      assert.strictEqual(state.commands.length, 1);

      state.getInputs.length = 0;
      const secondState = { ...state, commands: [] } as HarnessState;
      // The response and interaction maps are intentionally shared across the
      // layer boundary; a restarted service must use their durable evidence.
      const second = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* service.respond(input);
      }).pipe(Effect.provide(makeLayer(secondState)));
      assert.strictEqual(second.replayed, true);
      assert.deepStrictEqual(secondState.commands, []);
      assert.deepStrictEqual(state.getInputs, []);
    });
  });

  it.effect("does not redispatch a claimed response after a failed dispatch and restart", () => {
    const state = makeState();
    const interaction = makeUserInteraction("restart-failed");
    addEntry(state, interaction);
    const input = answerInput(interaction, "restart-failed");
    state.dispatchError = new OrchestratorDispatchError({
      commandId: CommandId.make("rejected-command"),
      commandType: "runtime-request.respond",
    });

    return Effect.gen(function* () {
      const firstError = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* errorFrom(service.respond(input));
      }).pipe(Effect.provide(makeLayer(state)));
      assert.strictEqual(firstError._tag, "OrchestratorDispatchError");
      assert.strictEqual(state.commands.length, 1);

      state.dispatchError = null;
      state.getInputs.length = 0;
      const secondState = { ...state, commands: [] } as HarnessState;
      const secondError = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* errorFrom(service.respond(input));
      }).pipe(Effect.provide(makeLayer(secondState)));
      assert.strictEqual(secondError._tag, "PendingInteractionUnavailableError");
      assert.deepStrictEqual(secondState.commands, []);
      assert.deepStrictEqual(state.getInputs, []);
    });
  });

  it.effect("rejects changed answers, action, and thread under one idempotency key", () => {
    const state = makeState();
    const interaction = makeUserInteraction("conflict");
    addEntry(state, interaction);
    const input = answerInput(interaction, "conflict");

    return Effect.gen(function* () {
      const service = yield* PendingInteractionService;
      yield* service.respond(input);

      state.getInteractionInputs.length = 0;
      const changedAnswers = yield* errorFrom(
        service.respond({ ...input, answers: [{ ...input.answers![0]!, values: ["Public"] }] }),
      );
      assert.strictEqual(changedAnswers._tag, "PendingInteractionInvalidResponseError");
      if (changedAnswers._tag === "PendingInteractionInvalidResponseError") {
        assert.strictEqual(changedAnswers.reason, "idempotency_conflict");
      }

      const changedAction = yield* errorFrom(service.respond({ ...input, action: "decline" }));
      assert.strictEqual(changedAction._tag, "PendingInteractionInvalidResponseError");
      const changedThread = yield* errorFrom(
        service.respond({ ...input, threadId: ThreadId.make("thread-other") }),
      );
      assert.strictEqual(changedThread._tag, "PendingInteractionInvalidResponseError");
      assert.deepStrictEqual(state.getInteractionInputs, [
        {
          threadId: interaction.threadId,
          requestId: interaction.requestId,
        },
      ]);
      assert.strictEqual(state.commands.length, 1);
    }).pipe(Effect.provide(makeLayer(state)));
  });

  it.effect("normalizes provider values, preserves value order, and uses the legacy hash", () => {
    const state = makeState();
    const interaction = makeHashInteraction();
    addEntry(state, interaction);
    const input: ResponseInput = {
      authSessionId: AuthSessionId.make("session-hash"),
      threadId: interaction.threadId,
      requestId: RemoteInteractionRequestId.make(interaction.requestId),
      idempotencyKey: "retry-hash",
      action: "answer",
      answers: [
        { questionId: "ordered", values: ["second", "first"] },
        { questionId: "readable", values: ["Readable"] },
      ],
    };

    return Effect.gen(function* () {
      const service = yield* PendingInteractionService;
      yield* service.respond(input);

      assert.strictEqual(state.commands.length, 1);
      const command = state.commands[0];
      if (command?.type !== "runtime-request.respond") {
        throw new Error("Expected a user-input response command");
      }
      assert.deepStrictEqual(
        command.answers,
        Object.fromEntries([
          ["__proto__", ["provider-readable"]],
          ["z", ["second", "first"]],
        ]),
      );
      assert.strictEqual(Object.getPrototypeOf(command.answers), Object.prototype);
      assert.isTrue(Object.prototype.hasOwnProperty.call(command.answers, "__proto__"));

      const response = state.responses.get(responseKey(input.authSessionId, input.idempotencyKey));
      assert.isDefined(response);
      if (response === undefined) return;
      assert.strictEqual(
        response.semanticHash,
        "919ac3234db69f842f6806b55c1160ded3136a4ebc2652e4fa4e7bcad5641915",
      );
    }).pipe(Effect.provide(makeLayer(state)));
  });

  it.effect(
    "dispatches message-mode answers joined while the durable hash stays array-normalized",
    () => {
      const state = makeState();
      const interaction = makeHashInteraction("message");
      addEntry(state, interaction, "message");
      const input: ResponseInput = {
        authSessionId: AuthSessionId.make("session-message"),
        threadId: interaction.threadId,
        requestId: RemoteInteractionRequestId.make(interaction.requestId),
        idempotencyKey: "retry-message",
        action: "answer",
        answers: [
          { questionId: "ordered", values: ["second", "first"] },
          { questionId: "readable", values: ["Readable"] },
        ],
      };

      return Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        yield* service.respond(input);

        assert.strictEqual(state.commands.length, 1);
        const command = state.commands[0];
        if (command?.type !== "runtime-request.respond") {
          throw new Error("Expected a user-input response command");
        }
        // Message-mode commands carry one newline-joined string per question
        // in the submitted value order.
        assert.deepStrictEqual(
          command.answers,
          Object.fromEntries([
            ["__proto__", "provider-readable"],
            ["z", "second\nfirst"],
          ]),
        );

        // A replay re-normalizes from the immutable snapshot with arrays. Its
        // acceptance without a conflict proves the stored semantic hash was
        // computed over the array-normalized form, not the joined strings.
        const replay = yield* service.respond(input);
        assert.strictEqual(replay.replayed, true);
        assert.strictEqual(state.commands.length, 1);
      }).pipe(Effect.provide(makeLayer(state)));
    },
  );

  it.effect(
    "rejects unsafe approvals, wrong kinds, incomplete answers, and never auto-approves",
    () => {
      const state = makeState();
      const unsafeApproval = makeApprovalInteraction("unsafe", false);
      const safeApproval = makeApprovalInteraction("safe", true);
      const userInput = makeUserInteraction("wrong-kind");
      addEntry(state, unsafeApproval);
      addEntry(state, safeApproval);
      addEntry(state, userInput);

      return Effect.gen(function* () {
        const service = yield* PendingInteractionService;

        const unsafeError = yield* errorFrom(
          service.respond(approvalInput(unsafeApproval, "unsafe", "approve")),
        );
        assert.strictEqual(unsafeError._tag, "PendingInteractionInvalidResponseError");
        if (unsafeError._tag === "PendingInteractionInvalidResponseError") {
          assert.strictEqual(unsafeError.reason, "approval_not_safe");
        }

        const safeApprovalError = yield* errorFrom(
          service.respond(approvalInput(safeApproval, "safe-approve", "approve")),
        );
        assert.strictEqual(safeApprovalError._tag, "PendingInteractionInvalidResponseError");
        if (safeApprovalError._tag === "PendingInteractionInvalidResponseError") {
          assert.strictEqual(safeApprovalError.reason, "approval_not_safe");
        }

        const wrongKindError = yield* errorFrom(
          service.respond(approvalInput(userInput, "wrong-kind", "approve")),
        );
        assert.strictEqual(wrongKindError._tag, "PendingInteractionInvalidResponseError");
        if (wrongKindError._tag === "PendingInteractionInvalidResponseError") {
          assert.strictEqual(wrongKindError.reason, "wrong_kind");
        }

        const question = userInput.questions[0]!;
        const invalidAnswers = yield* errorFrom(
          service.respond({
            ...answerInput(userInput, "wrong-kind"),
            answers: [{ questionId: question.id, values: ["not-an-option"] }],
          }),
        );
        assert.strictEqual(invalidAnswers._tag, "PendingInteractionInvalidResponseError");
        if (invalidAnswers._tag === "PendingInteractionInvalidResponseError") {
          assert.strictEqual(invalidAnswers.reason, "invalid_answers");
        }

        const decline = yield* service.respond(approvalInput(safeApproval, "safe", "decline"));
        assert.strictEqual(decline.replayed, false);
        const command = state.commands.at(-1);
        if (command?.type !== "runtime-request.respond") {
          throw new Error("Expected a runtime request response command");
        }
        assert.strictEqual(command.decision, "decline");
        assert.isFalse(
          state.commands.some(
            (entry) => entry.type === "runtime-request.respond" && entry.decision === "accept",
          ),
        );
      }).pipe(Effect.provide(makeLayer(state)));
    },
  );

  it.effect("uses only fresh query data while overlaying responding archive state", () => {
    const state = makeState();
    const responding = makeUserInteraction("overlay", {
      summary: "Fresh summary",
      updatedAt: NOW,
    });
    const stale = makeUserInteraction("omit", { summary: "Omit me" });
    addEntry(state, responding);
    addEntry(state, stale);
    state.archivedInteractions.set(interactionKey(responding.threadId, responding.requestId), {
      ...responding,
      summary: "Archive-only summary",
      status: "responding",
      responseAction: "answer",
      responseCommandId: CommandId.make("archive-command"),
      updatedAt: LATER,
    });
    state.archivedInteractions.set(interactionKey(stale.threadId, stale.requestId), {
      ...stale,
      status: "stale",
    });

    return Effect.gen(function* () {
      const service = yield* PendingInteractionService;
      const result = yield* service.list({});
      assert.strictEqual(result.interactions.length, 1);
      const [entry] = result.interactions;
      assert.strictEqual(entry?.summary, "Fresh summary");
      assert.strictEqual(entry?.status, "responding");
      assert.deepStrictEqual(entry?.allowedActions, []);
      assert.strictEqual(entry?.updatedAt, LATER);
    }).pipe(Effect.provide(makeLayer(state)));
  });

  it.effect("returns unavailable for missing current or archived terminal input", () => {
    const missingState = makeState();
    const missingInteraction = makeUserInteraction("missing");
    const missingInput = answerInput(missingInteraction, "missing");

    return Effect.gen(function* () {
      const missingError = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* errorFrom(service.respond(missingInput));
      }).pipe(Effect.provide(makeLayer(missingState)));
      assert.strictEqual(missingError._tag, "PendingInteractionUnavailableError");

      const archivedState = makeState();
      const archivedInteraction = makeUserInteraction("archived");
      addEntry(archivedState, archivedInteraction);
      archivedState.archivedInteractions.set(
        interactionKey(archivedInteraction.threadId, archivedInteraction.requestId),
        { ...archivedInteraction, status: "resolved" },
      );
      const archivedError = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* errorFrom(service.respond(answerInput(archivedInteraction, "archived")));
      }).pipe(Effect.provide(makeLayer(archivedState)));
      assert.strictEqual(archivedError._tag, "PendingInteractionUnavailableError");
      assert.deepStrictEqual(archivedState.commands, []);
    });
  });

  it.effect("does not let another session reuse an archived pending interaction", () => {
    const state = makeState();
    const interaction = makeUserInteraction("other-session");
    addEntry(state, interaction);
    state.archivedInteractions.set(
      interactionKey(interaction.threadId, interaction.requestId),
      interaction,
    );

    return Effect.gen(function* () {
      const service = yield* PendingInteractionService;
      const error = yield* errorFrom(
        service.respond({
          ...answerInput(interaction, "other-session"),
          authSessionId: AuthSessionId.make("session-different"),
          idempotencyKey: "retry-different",
        }),
      );
      assert.strictEqual(error._tag, "PendingInteractionUnavailableError");
      assert.deepStrictEqual(state.responses, new Map());
      assert.deepStrictEqual(state.commands, []);
    }).pipe(Effect.provide(makeLayer(state)));
  });
});
