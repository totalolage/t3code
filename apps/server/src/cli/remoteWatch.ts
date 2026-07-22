import {
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export type RemoteWatchTerminalStatus = Exclude<OrchestrationSessionStatus, "starting" | "running">;

export interface RemoteWatchTerminalObservation {
  readonly status: RemoteWatchTerminalStatus;
  readonly lastSequence: number;
  readonly observedRunning: boolean;
}

export const RemoteWatchInteraction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user-input"),
    requestId: Schema.String,
    prompt: Schema.Struct({
      questionCount: Schema.Number,
      questions: Schema.Array(
        Schema.Struct({
          index: Schema.Number,
          optionCount: Schema.Number,
          multiSelect: Schema.Boolean,
        }),
      ),
      questionsTruncated: Schema.Boolean,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("approval"),
    requestId: Schema.String,
    prompt: Schema.Struct({
      requestKind: Schema.Literal("command"),
    }),
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
  readonly turnId: TurnId;
  readonly interaction: RemoteWatchInteraction;
}

export interface RemoteWatchResult {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly status: RemoteWatchTerminalStatus;
  readonly message: {
    readonly id: string;
    readonly text: string;
    readonly createdAt: string;
  };
}

export class RemoteWatchNoTurnError extends Schema.TaggedErrorClass<RemoteWatchNoTurnError>()(
  "RemoteWatchNoTurnError",
  { threadId: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = 25;
  override get message(): string {
    return `Thread ${this.threadId} has no active or latest turn to watch.`;
  }
}

export class RemoteWatchTerminalWithoutMessageError extends Schema.TaggedErrorClass<RemoteWatchTerminalWithoutMessageError>()(
  "RemoteWatchTerminalWithoutMessageError",
  {
    threadId: Schema.String,
    turnId: Schema.String,
    status: Schema.Literals(["idle", "ready", "interrupted", "stopped", "error"]),
  },
) {
  override get [Runtime.errorExitCode](): number {
    return this.status === "interrupted" ? 21 : this.status === "error" ? 22 : 20;
  }
  override get message(): string {
    return `Thread ${this.threadId} reached ${this.status} without a final assistant message for turn ${this.turnId}.`;
  }
}

export class RemoteWatchTimeoutError extends Schema.TaggedErrorClass<RemoteWatchTimeoutError>()(
  "RemoteWatchTimeoutError",
  {
    threadId: Schema.String,
    timeoutMs: Schema.Number,
  },
) {
  override readonly [Runtime.errorExitCode] = 23;
  override get message(): string {
    return `Timed out waiting for thread ${this.threadId}.`;
  }
}

export class RemoteWatchFailure extends Schema.TaggedErrorClass<RemoteWatchFailure>()(
  "RemoteWatchFailure",
  {
    kind: Schema.Literals(["auth", "transport", "protocol", "unavailable"]),
    lastSequence: Schema.optional(Schema.Number),
    observedRunning: Schema.optional(Schema.Boolean),
  },
) {
  override readonly [Runtime.errorExitCode] = 24;
  override get message(): string {
    return `Remote thread watch failed (${this.kind}).`;
  }
}

export class RemoteWatchInteractionRequiredError extends Schema.TaggedErrorClass<RemoteWatchInteractionRequiredError>()(
  "RemoteWatchInteractionRequiredError",
  {
    threadId: ThreadId,
    turnId: TurnId,
    interaction: RemoteWatchInteraction,
  },
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
  readonly readThread: () => Effect.Effect<OrchestrationThreadDetailSnapshot, RemoteWatchFailure>;
  readonly subscribeThread: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly targetTurnId: TurnId;
    readonly observedRunning: boolean;
    readonly interactionAware: boolean;
  }) => Effect.Effect<RemoteWatchObservation, RemoteWatchFailure>;
}

const MAX_SAFE_PROMPT_QUESTIONS = 16;
const MAX_SAFE_INTERACTION_ID_LENGTH = 256;

function activityOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  const createdAtOrder = left.createdAt.localeCompare(right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }
  const lifecycleOrder = activityLifecycleRank(left.kind) - activityLifecycleRank(right.kind);
  return lifecycleOrder || left.id.localeCompare(right.id);
}

function activityLifecycleRank(kind: string): number {
  if (kind.endsWith(".resolved")) {
    return 2;
  }
  return kind.endsWith(".requested") ? 0 : 1;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) {
      return true;
    }
  }
  return false;
}

function activityPayload(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function safeInteractionRequestId(payload: Record<string, unknown> | null): string | null {
  const requestId = payload?.requestId;
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    requestId.length > MAX_SAFE_INTERACTION_ID_LENGTH ||
    requestId.trim() !== requestId ||
    containsControlCharacter(requestId)
  ) {
    return null;
  }
  return requestId;
}

function isCommandApproval(payload: Record<string, unknown> | null): boolean {
  return (
    payload?.requestKind === "command" ||
    payload?.requestType === "command_execution_approval" ||
    payload?.requestType === "exec_command_approval" ||
    payload?.requestType === "dynamic_tool_call"
  );
}

function isStaleInteractionFailure(activity: OrchestrationThreadActivity): boolean {
  const detail = activityPayload(activity)?.detail;
  if (typeof detail !== "string") {
    return false;
  }
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

function staleInteractionFailureKind(
  activity: OrchestrationThreadActivity,
): RemoteWatchInteraction["kind"] | null {
  if (!isStaleInteractionFailure(activity)) {
    return null;
  }
  if (activity.kind === "provider.user-input.respond.failed") {
    return "user-input";
  }
  return activity.kind === "provider.approval.respond.failed" ? "approval" : null;
}

function safeUserInputInteraction(
  requestId: string,
  payload: Record<string, unknown> | null,
): RemoteWatchInteraction {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  return {
    kind: "user-input",
    requestId,
    prompt: {
      questionCount: questions.length,
      questions: questions.slice(0, MAX_SAFE_PROMPT_QUESTIONS).map((question, index) => {
        const record =
          typeof question === "object" && question !== null
            ? (question as Record<string, unknown>)
            : null;
        return {
          index,
          optionCount: Array.isArray(record?.options) ? record.options.length : 0,
          multiSelect: record?.multiSelect === true,
        };
      }),
      questionsTruncated: questions.length > MAX_SAFE_PROMPT_QUESTIONS,
    },
  };
}

export function selectPendingRemoteWatchInteraction(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  targetTurnId: TurnId,
): RemoteWatchInteraction | null {
  const pending = new Map<
    string,
    {
      readonly interaction: RemoteWatchInteraction;
      readonly requestedAt: string;
      readonly requestedSequence: number | undefined;
    }
  >();
  const ordered = activities
    .filter(
      (activity) =>
        (activity.turnId === targetTurnId || activity.turnId === null) &&
        staleInteractionFailureKind(activity) === null,
    )
    .toSorted(activityOrder);

  for (const activity of ordered) {
    const payload = activityPayload(activity);
    const requestId = safeInteractionRequestId(payload);
    if (requestId === null) {
      continue;
    }
    if (activity.kind === "user-input.requested") {
      pending.set(requestId, {
        interaction: safeUserInputInteraction(requestId, payload),
        requestedAt: activity.createdAt,
        requestedSequence: activity.sequence,
      });
      continue;
    }
    if (activity.kind === "approval.requested" && isCommandApproval(payload)) {
      pending.set(requestId, {
        interaction: {
          kind: "approval",
          requestId,
          prompt: { requestKind: "command" },
        },
        requestedAt: activity.createdAt,
        requestedSequence: activity.sequence,
      });
      continue;
    }
    if (activity.kind === "user-input.resolved" || activity.kind === "approval.resolved") {
      pending.delete(requestId);
      continue;
    }
  }

  const staleFailures = activities
    .filter(
      (activity) =>
        (activity.turnId === targetTurnId || activity.turnId === null) &&
        staleInteractionFailureKind(activity) !== null,
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  for (const failure of staleFailures) {
    const requestId = safeInteractionRequestId(activityPayload(failure));
    const staleKind = staleInteractionFailureKind(failure);
    const open = requestId === null ? undefined : pending.get(requestId);
    const failureFollowsRequest =
      failure.sequence !== undefined &&
      open?.requestedSequence !== undefined &&
      failure.sequence !== open.requestedSequence
        ? failure.sequence > open.requestedSequence
        : open !== undefined && failure.createdAt.localeCompare(open.requestedAt) >= 0;
    if (
      requestId !== null &&
      staleKind !== null &&
      open?.interaction.kind === staleKind &&
      failureFollowsRequest
    ) {
      pending.delete(requestId);
    }
  }

  return pending.values().next().value?.interaction ?? null;
}

function terminalStatusFromSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
  targetTurnId: TurnId,
  observedRunning: boolean,
): RemoteWatchTerminalStatus | null {
  const session = snapshot.thread.session;
  const latest = snapshot.thread.latestTurn;
  if (session?.status === "running" && session.activeTurnId === targetTurnId) {
    return null;
  }
  if (observedRunning) {
    return session === null ? null : sessionTerminalStatus(session.status);
  }
  const activeTurnId = session?.activeTurnId ?? null;
  const targetWasSuperseded =
    (latest !== null && latest.turnId !== targetTurnId) ||
    (activeTurnId !== null && activeTurnId !== targetTurnId);
  if (targetWasSuperseded && selectFinalAssistantMessage(snapshot, targetTurnId) !== null) {
    return "ready";
  }
  if (session !== null && latest?.turnId === targetTurnId) {
    return sessionTerminalStatus(session.status);
  }
  if (latest?.turnId !== targetTurnId || latest.state === "running") {
    return null;
  }
  return latest.state === "completed" ? "ready" : latest.state;
}

function sessionTerminalStatus(
  status: OrchestrationSessionStatus,
): RemoteWatchTerminalStatus | null {
  return status === "starting" || status === "running" ? null : status;
}

export const observeRemoteWatchStream = Effect.fn("remoteWatch.observeStream")(function* <
  E extends RemoteWatchFailure,
  R,
>(input: {
  readonly stream: Stream.Stream<OrchestrationThreadStreamItem, E, R>;
  readonly initialSequence: number;
  readonly targetTurnId: TurnId;
  readonly observedRunning: boolean;
  readonly interactionAware?: boolean;
}): Effect.fn.Return<RemoteWatchObservation, E | RemoteWatchFailure, R> {
  let lastSequence = input.initialSequence;
  let observedRunning = input.observedRunning;
  const terminal = yield* input.stream.pipe(
    Stream.map((item): Option.Option<RemoteWatchObservation> => {
      if (item.kind === "snapshot") {
        if (item.snapshot.snapshotSequence <= lastSequence) {
          return Option.none();
        }
        lastSequence = item.snapshot.snapshotSequence;
        const session = item.snapshot.thread.session;
        if (session?.status === "running" && session.activeTurnId === input.targetTurnId) {
          observedRunning = true;
        }
        const status = terminalStatusFromSnapshot(
          item.snapshot,
          input.targetTurnId,
          observedRunning,
        );
        if (input.interactionAware === true && status === null) {
          const interaction = selectPendingRemoteWatchInteraction(
            item.snapshot.thread.activities,
            input.targetTurnId,
          );
          if (interaction !== null) {
            return Option.some({ interaction, lastSequence, observedRunning });
          }
        }
        if (session?.status === "running" && session.activeTurnId === input.targetTurnId) {
          return Option.none();
        }
        return status === null
          ? Option.none()
          : Option.some({ status, lastSequence, observedRunning });
      }
      if (item.event.sequence <= lastSequence) {
        return Option.none();
      }
      lastSequence = item.event.sequence;
      if (input.interactionAware === true && item.event.type === "thread.activity-appended") {
        const interaction = selectPendingRemoteWatchInteraction(
          [item.event.payload.activity],
          input.targetTurnId,
        );
        if (interaction !== null) {
          return Option.some({ interaction, lastSequence, observedRunning });
        }
      }
      if (item.event.type !== "thread.session-set") {
        return Option.none();
      }
      const session = item.event.payload.session;
      if (session.status === "running" && session.activeTurnId === input.targetTurnId) {
        observedRunning = true;
        return Option.none();
      }
      const status = observedRunning ? sessionTerminalStatus(session.status) : null;
      return status === null
        ? Option.none()
        : Option.some({ status, lastSequence, observedRunning });
    }),
    Stream.filter(Option.isSome),
    Stream.map((item) => item.value),
    Stream.runHead,
    Effect.mapError(
      (error) =>
        new RemoteWatchFailure({
          kind: error.kind,
          lastSequence,
          observedRunning,
        }),
    ),
  );
  if (Option.isNone(terminal)) {
    return yield* new RemoteWatchFailure({ kind: "transport" });
  }
  return terminal.value;
});

export function selectRemoteWatchTurn(
  snapshot: OrchestrationThreadDetailSnapshot,
  requestedTurnId?: TurnId,
): TurnId | null {
  return (
    requestedTurnId ??
    snapshot.thread.session?.activeTurnId ??
    snapshot.thread.latestTurn?.turnId ??
    null
  );
}

export function selectFinalAssistantMessage(
  snapshot: OrchestrationThreadDetailSnapshot,
  turnId: TurnId,
): RemoteWatchResult["message"] | null {
  const messages = snapshot.thread.messages.filter(
    (message) =>
      message.role === "assistant" && message.turnId === turnId && message.streaming === false,
  );
  const message = messages.at(-1);
  return message === undefined
    ? null
    : { id: message.id, text: message.text, createdAt: message.createdAt };
}

const WATCH_RECONNECT_DELAYS_MS = [100, 200, 400, 800] as const;
const WATCH_POLL_DELAYS_MS = [250, 500, 1_000, 2_000] as const;

const watchRemoteThreadProgram = Effect.fn("remoteWatch.runProgram")(function* (input: {
  readonly transport: RemoteWatchTransport;
  readonly threadId: ThreadId;
  readonly requestedTurnId?: TurnId;
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
  if (targetTurnId === null) {
    return yield* new RemoteWatchNoTurnError({ threadId: input.threadId });
  }
  let lastSequence = initial.snapshotSequence;
  let observedRunning =
    initial.thread.session?.status === "running" &&
    initial.thread.session.activeTurnId === targetTurnId;
  let terminalStatus = terminalStatusFromSnapshot(initial, targetTurnId, observedRunning);

  if (input.interactionAware === true && terminalStatus === null) {
    const interaction = selectPendingRemoteWatchInteraction(
      initial.thread.activities,
      targetTurnId,
    );
    if (interaction !== null) {
      return yield* new RemoteWatchInteractionRequiredError({
        threadId: input.threadId,
        turnId: targetTurnId,
        interaction,
      });
    }
  }

  if (terminalStatus === null) {
    let usePolling = false;
    for (let attempt = 0; terminalStatus === null; attempt += 1) {
      const subscribed = yield* input.transport
        .subscribeThread({
          threadId: input.threadId,
          afterSequence: lastSequence,
          targetTurnId,
          observedRunning,
          interactionAware: input.interactionAware === true,
        })
        .pipe(Effect.result);
      if (subscribed._tag === "Success") {
        lastSequence = subscribed.success.lastSequence;
        observedRunning = subscribed.success.observedRunning;
        if ("interaction" in subscribed.success) {
          return yield* new RemoteWatchInteractionRequiredError({
            threadId: input.threadId,
            turnId: targetTurnId,
            interaction: subscribed.success.interaction,
          });
        }
        terminalStatus = subscribed.success.status;
        break;
      }
      const failure = subscribed.failure;
      lastSequence = Math.max(lastSequence, failure.lastSequence ?? lastSequence);
      observedRunning = failure.observedRunning ?? observedRunning;
      if (failure.kind === "unavailable") {
        usePolling = true;
        break;
      }
      if (failure.kind !== "transport" || attempt >= WATCH_RECONNECT_DELAYS_MS.length) {
        return yield* failure;
      }
      yield* Effect.sleep(Duration.millis(WATCH_RECONNECT_DELAYS_MS[attempt] ?? 1_000));
    }

    if (usePolling) {
      let pollAttempt = 0;
      while (terminalStatus === null) {
        yield* Effect.sleep(
          Duration.millis(
            WATCH_POLL_DELAYS_MS[Math.min(pollAttempt, WATCH_POLL_DELAYS_MS.length - 1)] ?? 2_000,
          ),
        );
        const snapshot = yield* input.transport.readThread();
        lastSequence = Math.max(lastSequence, snapshot.snapshotSequence);
        if (
          snapshot.thread.session?.status === "running" &&
          snapshot.thread.session.activeTurnId === targetTurnId
        ) {
          observedRunning = true;
        }
        terminalStatus = terminalStatusFromSnapshot(snapshot, targetTurnId, observedRunning);
        if (input.interactionAware === true && terminalStatus === null) {
          const interaction = selectPendingRemoteWatchInteraction(
            snapshot.thread.activities,
            targetTurnId,
          );
          if (interaction !== null) {
            return yield* new RemoteWatchInteractionRequiredError({
              threadId: input.threadId,
              turnId: targetTurnId,
              interaction,
            });
          }
        }
        pollAttempt += 1;
      }
    }
  }

  const finalSnapshot = yield* input.transport.readThread();
  const finalMessage = selectFinalAssistantMessage(finalSnapshot, targetTurnId);
  if (finalMessage === null) {
    return yield* new RemoteWatchTerminalWithoutMessageError({
      threadId: input.threadId,
      turnId: targetTurnId,
      status: terminalStatus ?? "error",
    });
  }
  return {
    threadId: input.threadId,
    turnId: targetTurnId,
    status: terminalStatus ?? "ready",
    message: finalMessage,
  };
});

export const watchRemoteThread = Effect.fn("remoteWatch.run")(function* (input: {
  readonly transport: RemoteWatchTransport;
  readonly threadId: ThreadId;
  readonly requestedTurnId?: TurnId;
  readonly timeoutMs: number;
  readonly interactionAware?: boolean;
}) {
  return yield* watchRemoteThreadProgram(input).pipe(
    Effect.timeout(Duration.millis(input.timeoutMs)),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new RemoteWatchTimeoutError({
          threadId: input.threadId,
          timeoutMs: input.timeoutMs,
        }),
      ),
    ),
  );
});

export function formatRemoteWatchResult(
  result: RemoteWatchResult,
  format: "text" | "json",
): string {
  return format === "text" ? result.message.text : JSON.stringify(result, null, 2);
}

export function formatRemoteWatchInteractionResult(result: RemoteWatchInteractionResult): string {
  return JSON.stringify(result);
}
