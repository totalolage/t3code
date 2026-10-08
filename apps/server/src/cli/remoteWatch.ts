import {
  NonNegativeInt,
  RuntimeRequestId,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export type RemoteWatchTerminalStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back"
>;

export interface RemoteWatchSnapshot extends OrchestrationV2ThreadDetailSnapshot {
  readonly latestRunId: RunId | null;
  readonly activeRunId: RunId | null;
}

export interface RemoteWatchTerminalObservation {
  readonly status: RemoteWatchTerminalStatus;
  readonly lastSequence: number;
  readonly observedRunning: boolean;
}

export const RemoteWatchInteraction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user-input"),
    requestId: RuntimeRequestId,
    prompt: Schema.Struct({
      questionCount: NonNegativeInt,
      questions: Schema.Array(
        Schema.Struct({
          index: NonNegativeInt,
          optionCount: NonNegativeInt,
          multiSelect: Schema.Boolean,
        }),
      ),
      questionsTruncated: Schema.Boolean,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("approval"),
    requestId: RuntimeRequestId,
    prompt: Schema.Struct({ requestKind: Schema.Literal("command") }),
  }),
]);
export type RemoteWatchInteraction = typeof RemoteWatchInteraction.Type;

export interface RemoteWatchInteractionObservation {
  readonly interaction: RemoteWatchInteraction;
  readonly lastSequence: number;
  readonly observedRunning: boolean;
}

export type RemoteWatchObservation =
  | RemoteWatchTerminalObservation
  | RemoteWatchInteractionObservation;

export interface RemoteWatchInteractionResult {
  readonly threadId: ThreadId;
  readonly turnId: RunId;
  readonly interaction: RemoteWatchInteraction;
}

export interface RemoteWatchResult {
  readonly threadId: ThreadId;
  readonly turnId: RunId;
  readonly status: RemoteWatchTerminalStatus;
  readonly message: { readonly id: string; readonly text: string; readonly createdAt: string };
}

export class RemoteWatchNoTurnError extends Schema.TaggedError<RemoteWatchNoTurnError>()(
  "RemoteWatchNoTurnError",
  { threadId: ThreadId },
) {
  override readonly [Runtime.errorExitCode] = 25;
  override get message(): string {
    return `Thread ${this.threadId} has no active or latest run to watch.`;
  }
}

export class RemoteWatchTerminalWithoutMessageError extends Schema.TaggedError<RemoteWatchTerminalWithoutMessageError>()(
  "RemoteWatchTerminalWithoutMessageError",
  {
    threadId: ThreadId,
    turnId: RunId,
    status: Schema.Literals(["completed", "interrupted", "failed", "cancelled", "rolled_back"]),
  },
) {
  override get [Runtime.errorExitCode](): number {
    return this.status === "interrupted" || this.status === "cancelled" ? 21 : 20;
  }
  override get message(): string {
    return `Thread ${this.threadId} reached ${this.status} without a final assistant message for run ${this.turnId}.`;
  }
}

export class RemoteWatchTimeoutError extends Schema.TaggedError<RemoteWatchTimeoutError>()(
  "RemoteWatchTimeoutError",
  { threadId: ThreadId, timeoutMs: Schema.Finite },
) {
  override readonly [Runtime.errorExitCode] = 23;
  override get message(): string {
    return `Timed out waiting for thread ${this.threadId}.`;
  }
}

export class RemoteWatchFailure extends Schema.TaggedError<RemoteWatchFailure>()(
  "RemoteWatchFailure",
  {
    kind: Schema.Literals(["auth", "transport", "protocol", "unavailable"]),
    lastSequence: Schema.optional(NonNegativeInt),
    observedRunning: Schema.optional(Schema.Boolean),
  },
) {
  override readonly [Runtime.errorExitCode] = 24;
  override get message(): string {
    return `Remote thread watch failed (${this.kind}).`;
  }
}

export class RemoteWatchInteractionRequiredError extends Schema.TaggedError<RemoteWatchInteractionRequiredError>()(
  "RemoteWatchInteractionRequiredError",
  { threadId: ThreadId, turnId: RunId, interaction: RemoteWatchInteraction },
) {
  override readonly [Runtime.errorExitCode] = 26;
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return formatRemoteWatchInteractionResult({
      threadId: this.threadId,
      turnId: this.turnId,
      interaction: this.interaction,
    });
  }
}

export interface RemoteWatchTransport {
  readonly readThread: () => Effect.Effect<RemoteWatchSnapshot, RemoteWatchFailure>;
  readonly subscribeThread: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly targetTurnId: RunId;
    readonly observedRunning: boolean;
    readonly interactionAware: boolean;
  }) => Effect.Effect<RemoteWatchObservation, RemoteWatchFailure>;
}

const MAX_SAFE_PROMPT_QUESTIONS = 16;
const MAX_SAFE_INTERACTION_ID_LENGTH = 256;
const WATCH_RECONNECT_DELAYS_MS = [100, 200, 400, 800] as const;
const WATCH_POLL_DELAYS_MS = [250, 500, 1_000, 2_000] as const;
const SafeInteractionRequestId = RuntimeRequestId.check(
  Schema.isMaxLength(MAX_SAFE_INTERACTION_ID_LENGTH),
  Schema.isPattern(/^[^\p{Cc}]+$/u),
);
const decodeSafeRequestId = Schema.decodeUnknownOption(SafeInteractionRequestId);

const isTerminalStatus = (
  status: OrchestrationV2Run["status"],
): status is RemoteWatchTerminalStatus =>
  status === "completed" ||
  status === "interrupted" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "rolled_back";

const activeStatus = (status: OrchestrationV2Run["status"]): boolean =>
  status === "preparing" ||
  status === "queued" ||
  status === "starting" ||
  status === "running" ||
  status === "waiting";

function interactionFromRequest(
  request: OrchestrationV2RuntimeRequest,
  turnItem: OrchestrationV2TurnItem | undefined,
): RemoteWatchInteraction | null {
  const requestId = decodeSafeRequestId(request.id);
  if (Option.isNone(requestId)) return null;
  if (turnItem?.type === "user_input_request") {
    const questions = turnItem.questions;
    return {
      kind: "user-input",
      requestId: requestId.value,
      prompt: {
        questionCount: questions.length,
        questions: questions.slice(0, MAX_SAFE_PROMPT_QUESTIONS).map((question, index) => ({
          index,
          optionCount: question.options.length,
          multiSelect: question.multiSelect === true,
        })),
        questionsTruncated: questions.length > MAX_SAFE_PROMPT_QUESTIONS,
      },
    };
  }
  if (turnItem?.type === "approval_request" && turnItem.requestKind === "command") {
    return {
      kind: "approval",
      requestId: requestId.value,
      prompt: { requestKind: "command" },
    };
  }
  return null;
}

export function selectPendingRemoteWatchInteraction(
  projection: OrchestrationV2ThreadProjection,
  targetRunId: RunId,
): RemoteWatchInteraction | null {
  const candidates = projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .flatMap((request) => {
      const turnItem = projection.turnItems.find(
        (item) =>
          (item.type === "user_input_request" || item.type === "approval_request") &&
          item.requestId === request.id &&
          item.runId === targetRunId,
      );
      const interaction = interactionFromRequest(request, turnItem);
      return interaction === null || turnItem === undefined
        ? []
        : [{ createdAt: request.createdAt, requestId: request.id, interaction }];
    })
    .toSorted(
      (left, right) =>
        DateTime.formatIso(left.createdAt).localeCompare(DateTime.formatIso(right.createdAt)) ||
        left.requestId.localeCompare(right.requestId),
    );
  return candidates[0]?.interaction ?? null;
}

function interactionFromEventRequest(
  request: OrchestrationV2RuntimeRequest,
): RemoteWatchInteraction | null {
  const requestId = decodeSafeRequestId(request.id);
  if (Option.isNone(requestId)) return null;
  if (request.kind === "user_input") {
    return {
      kind: "user-input",
      requestId: requestId.value,
      prompt: { questionCount: 0, questions: [], questionsTruncated: false },
    };
  }
  if (request.kind === "command") {
    return {
      kind: "approval",
      requestId: requestId.value,
      prompt: { requestKind: "command" },
    };
  }
  return null;
}

function runInProjection(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
): OrchestrationV2Run | undefined {
  return projection.runs.find((run) => run.id === runId);
}

function targetIsRunning(snapshot: RemoteWatchSnapshot, targetRunId: RunId): boolean {
  const run = runInProjection(snapshot.projection, targetRunId);
  return run !== undefined && activeStatus(run.status);
}

function terminalStatusFromSnapshot(
  snapshot: RemoteWatchSnapshot,
  targetRunId: RunId,
): RemoteWatchTerminalStatus | null {
  const run = runInProjection(snapshot.projection, targetRunId);
  return run !== undefined && isTerminalStatus(run.status) ? run.status : null;
}

function withWatchContext(
  failure: RemoteWatchFailure,
  lastSequence: number,
  observedRunning: boolean,
): RemoteWatchFailure {
  return new RemoteWatchFailure({
    kind: failure.kind,
    lastSequence: failure.lastSequence ?? lastSequence,
    observedRunning: observedRunning || failure.observedRunning === true,
  });
}

const CONNECTION_LOSS_PATTERN =
  /\b(?:socket|connection|disconnect|closed|aborted|epipe|econnreset|econnrefused|econnaborted)/i;

function classifyWatchDefect(defect: unknown): RemoteWatchFailure["kind"] {
  const raw =
    typeof defect === "object" &&
    defect !== null &&
    typeof (defect as { message?: unknown }).message === "string"
      ? (defect as { message: string }).message
      : "";
  return CONNECTION_LOSS_PATTERN.test(raw.slice(0, 512)) ? "transport" : "protocol";
}

export const observeRemoteWatchStream = Effect.fn("remoteWatch.observeStream")(function* <
  E extends RemoteWatchFailure,
  R,
>(input: {
  readonly stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>;
  readonly initialSequence: number;
  readonly targetTurnId: RunId;
  readonly observedRunning: boolean;
  readonly interactionAware?: boolean;
}): Effect.fn.Return<RemoteWatchObservation, E | RemoteWatchFailure, R> {
  let lastSequence = input.initialSequence;
  let observedRunning = input.observedRunning;
  const terminal = yield* input.stream.pipe(
    Stream.map((item): Option.Option<RemoteWatchObservation> => {
      if (item.kind === "snapshot") {
        lastSequence = item.snapshotSequence;
        const snapshot: RemoteWatchSnapshot = {
          snapshotSequence: item.snapshotSequence,
          projection: item.projection,
          latestRunId: null,
          activeRunId: null,
        };
        const running = targetIsRunning(snapshot, input.targetTurnId);
        if (running) observedRunning = true;
        const status = terminalStatusFromSnapshot(snapshot, input.targetTurnId);
        if (input.interactionAware === true && status === null) {
          const interaction = selectPendingRemoteWatchInteraction(
            item.projection,
            input.targetTurnId,
          );
          if (interaction !== null)
            return Option.some({ interaction, lastSequence, observedRunning });
        }
        return status === null
          ? Option.none()
          : Option.some({ status, lastSequence, observedRunning });
      }
      if (item.kind === "synchronized" || item.kind === "unknown-event") return Option.none();
      if (item.sequence <= lastSequence) return Option.none();
      lastSequence = item.sequence;

      if (item.event.type === "runtime-request.updated" && input.interactionAware === true) {
        if (item.event.payload.status === "pending") {
          const interaction = interactionFromEventRequest(item.event.payload);
          if (interaction !== null)
            return Option.some({ interaction, lastSequence, observedRunning });
        }
        return Option.none();
      }
      if (item.event.type !== "run.updated" || item.event.payload.id !== input.targetTurnId) {
        return Option.none();
      }
      const status = item.event.payload.status;
      if (activeStatus(status)) observedRunning = true;
      return isTerminalStatus(status)
        ? Option.some({ status, lastSequence, observedRunning })
        : Option.none();
    }),
    Stream.filter(Option.isSome),
    Stream.map((item) => item.value),
    Stream.runHead,
    Effect.mapError((error) => {
      const context = withWatchContext(error, lastSequence, observedRunning);
      lastSequence = context.lastSequence ?? lastSequence;
      observedRunning = context.observedRunning ?? observedRunning;
      return context;
    }),
    Effect.catchDefect((defect) =>
      Effect.fail(
        new RemoteWatchFailure({
          kind: classifyWatchDefect(defect),
          lastSequence,
          observedRunning,
        }),
      ),
    ),
  );
  if (Option.isNone(terminal)) {
    return yield* new RemoteWatchFailure({ kind: "transport", lastSequence, observedRunning });
  }
  return terminal.value;
});

export function selectRemoteWatchTurn(
  snapshot: RemoteWatchSnapshot,
  requestedTurnId?: RunId,
): RunId | null {
  return requestedTurnId ?? snapshot.activeRunId ?? snapshot.latestRunId;
}

export function selectFinalAssistantMessage(
  snapshot: Pick<OrchestrationV2ThreadDetailSnapshot, "projection">,
  runId: RunId,
): RemoteWatchResult["message"] | null {
  const item = snapshot.projection.turnItems
    .filter(
      (candidate) =>
        candidate.type === "assistant_message" &&
        candidate.runId === runId &&
        candidate.streaming === false,
    )
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .at(-1);
  return item?.type === "assistant_message"
    ? { id: item.messageId, text: item.text, createdAt: DateTime.formatIso(item.updatedAt) }
    : null;
}

const watchRemoteThreadProgram = Effect.fn("remoteWatch.runProgram")(function* (input: {
  readonly transport: RemoteWatchTransport;
  readonly threadId: ThreadId;
  readonly requestedTurnId?: RunId;
  readonly interactionAware?: boolean;
}): Effect.fn.Return<
  RemoteWatchResult,
  | RemoteWatchNoTurnError
  | RemoteWatchTerminalWithoutMessageError
  | RemoteWatchFailure
  | RemoteWatchInteractionRequiredError
> {
  const initial = yield* input.transport.readThread();
  const targetTurnId = selectRemoteWatchTurn(initial, input.requestedTurnId);
  if (targetTurnId === null) return yield* new RemoteWatchNoTurnError({ threadId: input.threadId });

  let lastSequence = initial.snapshotSequence;
  let observedRunning = targetIsRunning(initial, targetTurnId);
  let terminalStatus = terminalStatusFromSnapshot(initial, targetTurnId);
  if (input.interactionAware === true && terminalStatus === null) {
    const interaction = selectPendingRemoteWatchInteraction(initial.projection, targetTurnId);
    if (interaction !== null) {
      return yield* new RemoteWatchInteractionRequiredError({
        threadId: input.threadId,
        turnId: targetTurnId,
        interaction,
      });
    }
  }

  let polling = false;
  let reconnectAttempt = 0;
  while (terminalStatus === null && !polling) {
    const subscribed = yield* input.transport
      .subscribeThread({
        threadId: input.threadId,
        afterSequence: lastSequence,
        targetTurnId,
        observedRunning,
        interactionAware: input.interactionAware === true,
      })
      .pipe(Effect.result);

    if (subscribed._tag === "Failure") {
      const failure = subscribed.failure;
      lastSequence = failure.lastSequence ?? lastSequence;
      observedRunning = observedRunning || failure.observedRunning === true;
      if (failure.kind === "unavailable") {
        polling = true;
        break;
      }
      if (failure.kind !== "transport" || reconnectAttempt >= WATCH_RECONNECT_DELAYS_MS.length) {
        return yield* withWatchContext(failure, lastSequence, observedRunning);
      }
      yield* Effect.sleep(Duration.millis(WATCH_RECONNECT_DELAYS_MS[reconnectAttempt]!));
      reconnectAttempt += 1;
      continue;
    }

    const observation = subscribed.success;
    lastSequence = observation.lastSequence;
    observedRunning = observedRunning || observation.observedRunning;
    reconnectAttempt = 0;
    if ("interaction" in observation) {
      const observedSequence = lastSequence;
      const current = yield* input.transport
        .readThread()
        .pipe(
          Effect.mapError((failure) => withWatchContext(failure, lastSequence, observedRunning)),
        );
      lastSequence = current.snapshotSequence;
      observedRunning = observedRunning || targetIsRunning(current, targetTurnId);
      if (current.snapshotSequence >= observedSequence) {
        const interaction =
          input.interactionAware === true
            ? selectPendingRemoteWatchInteraction(current.projection, targetTurnId)
            : null;
        if (interaction !== null) {
          return yield* new RemoteWatchInteractionRequiredError({
            threadId: input.threadId,
            turnId: targetTurnId,
            interaction,
          });
        }
        terminalStatus = terminalStatusFromSnapshot(current, targetTurnId);
        continue;
      }
      return yield* new RemoteWatchInteractionRequiredError({
        threadId: input.threadId,
        turnId: targetTurnId,
        interaction: observation.interaction,
      });
    }
    terminalStatus = observation.status;
  }

  let pollAttempt = 0;
  while (terminalStatus === null) {
    const delay = WATCH_POLL_DELAYS_MS[Math.min(pollAttempt, WATCH_POLL_DELAYS_MS.length - 1)];
    yield* Effect.sleep(Duration.millis(delay!));
    const current = yield* input.transport
      .readThread()
      .pipe(Effect.mapError((failure) => withWatchContext(failure, lastSequence, observedRunning)));
    pollAttempt += 1;
    observedRunning = observedRunning || targetIsRunning(current, targetTurnId);
    if (current.snapshotSequence <= lastSequence) continue;
    lastSequence = current.snapshotSequence;
    terminalStatus = terminalStatusFromSnapshot(current, targetTurnId);
    if (input.interactionAware === true && terminalStatus === null) {
      const interaction = selectPendingRemoteWatchInteraction(current.projection, targetTurnId);
      if (interaction !== null) {
        return yield* new RemoteWatchInteractionRequiredError({
          threadId: input.threadId,
          turnId: targetTurnId,
          interaction,
        });
      }
    }
  }

  const finalSnapshot = yield* input.transport
    .readThread()
    .pipe(Effect.mapError((failure) => withWatchContext(failure, lastSequence, observedRunning)));
  if (input.interactionAware === true) {
    const interaction = selectPendingRemoteWatchInteraction(finalSnapshot.projection, targetTurnId);
    if (interaction !== null) {
      return yield* new RemoteWatchInteractionRequiredError({
        threadId: input.threadId,
        turnId: targetTurnId,
        interaction,
      });
    }
  }

  const finalMessage = selectFinalAssistantMessage(finalSnapshot, targetTurnId);
  if (finalMessage === null) {
    return yield* new RemoteWatchTerminalWithoutMessageError({
      threadId: input.threadId,
      turnId: targetTurnId,
      status: terminalStatus ?? "failed",
    });
  }
  return {
    threadId: input.threadId,
    turnId: targetTurnId,
    status: terminalStatus!,
    message: finalMessage,
  };
});

export const watchRemoteThread = Effect.fn("remoteWatch.run")(function* (input: {
  readonly transport: RemoteWatchTransport;
  readonly threadId: ThreadId;
  readonly requestedTurnId?: RunId;
  readonly timeoutMs: number;
  readonly interactionAware?: boolean;
}) {
  return yield* watchRemoteThreadProgram(input).pipe(
    Effect.timeout(Duration.millis(input.timeoutMs)),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.fail(
          new RemoteWatchTimeoutError({ threadId: input.threadId, timeoutMs: input.timeoutMs }),
        ),
    }),
  );
});

export function formatRemoteWatchResult(
  result: RemoteWatchResult,
  format: "text" | "json",
): string {
  return format === "text" ? result.message.text : JSON.stringify(result, null, 2);
}

export function formatRemoteWatchInteractionResult(result: RemoteWatchInteractionResult): string {
  return JSON.stringify({
    threadId: result.threadId,
    turnId: result.turnId,
    interaction: result.interaction,
  });
}
