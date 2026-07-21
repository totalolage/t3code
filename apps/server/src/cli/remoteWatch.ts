import {
  type OrchestrationSessionStatus,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  type ThreadId,
  type TurnId,
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

export interface RemoteWatchTransport {
  readonly readThread: () => Effect.Effect<OrchestrationThreadDetailSnapshot, RemoteWatchFailure>;
  readonly subscribeThread: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly targetTurnId: TurnId;
    readonly observedRunning: boolean;
  }) => Effect.Effect<RemoteWatchTerminalObservation, RemoteWatchFailure>;
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
}): Effect.fn.Return<RemoteWatchTerminalObservation, E | RemoteWatchFailure, R> {
  let lastSequence = input.initialSequence;
  let observedRunning = input.observedRunning;
  const terminal = yield* input.stream.pipe(
    Stream.map((item) => {
      if (item.kind === "snapshot") {
        if (item.snapshot.snapshotSequence <= lastSequence) {
          return Option.none<RemoteWatchTerminalObservation>();
        }
        lastSequence = item.snapshot.snapshotSequence;
        const session = item.snapshot.thread.session;
        if (session?.status === "running" && session.activeTurnId === input.targetTurnId) {
          observedRunning = true;
          return Option.none();
        }
        const status = terminalStatusFromSnapshot(
          item.snapshot,
          input.targetTurnId,
          observedRunning,
        );
        return status === null
          ? Option.none()
          : Option.some({ status, lastSequence, observedRunning });
      }
      if (item.event.sequence <= lastSequence) {
        return Option.none();
      }
      lastSequence = item.event.sequence;
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
}): Effect.fn.Return<
  RemoteWatchResult,
  RemoteWatchNoTurnError | RemoteWatchTerminalWithoutMessageError | RemoteWatchFailure
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

  if (terminalStatus === null) {
    let usePolling = false;
    for (let attempt = 0; terminalStatus === null; attempt += 1) {
      const subscribed = yield* input.transport
        .subscribeThread({
          threadId: input.threadId,
          afterSequence: lastSequence,
          targetTurnId,
          observedRunning,
        })
        .pipe(Effect.result);
      if (subscribed._tag === "Success") {
        lastSequence = subscribed.success.lastSequence;
        observedRunning = subscribed.success.observedRunning;
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
