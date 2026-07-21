import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  type OrchestrationSessionStatus,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Runtime from "effect/Runtime";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  formatRemoteWatchResult,
  observeRemoteWatchStream,
  RemoteWatchFailure,
  RemoteWatchTerminalWithoutMessageError,
  RemoteWatchTimeoutError,
  selectFinalAssistantMessage,
  type RemoteWatchTransport,
  watchRemoteThread,
} from "./remoteWatch.ts";

const threadId = ThreadId.make("thread-watch");
const turnId = TurnId.make("turn-watch");

const snapshot = (input: {
  readonly sequence: number;
  readonly status: OrchestrationSessionStatus;
  readonly messageTexts?: ReadonlyArray<{
    readonly text: string;
    readonly turnId?: TurnId;
    readonly streaming?: boolean;
  }>;
}): OrchestrationThreadDetailSnapshot =>
  ({
    snapshotSequence: input.sequence,
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-watch"),
      title: "Watch",
      modelSelection: { instanceId: "codex_personal", model: "gpt-test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feat/watch",
      worktreePath: "/repo/.worktrees/watch",
      latestTurn: {
        turnId,
        state:
          input.status === "running" || input.status === "starting"
            ? "running"
            : input.status === "interrupted"
              ? "interrupted"
              : input.status === "error"
                ? "error"
                : "completed",
        requestedAt: "2026-07-21T00:00:00.000Z",
        startedAt: "2026-07-21T00:00:01.000Z",
        completedAt: input.status === "running" ? null : "2026-07-21T00:01:00.000Z",
        assistantMessageId: null,
      },
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:01:00.000Z",
      archivedAt: null,
      deletedAt: null,
      messages: (input.messageTexts ?? []).map((message, index) => ({
        id: `assistant-${index}`,
        role: "assistant" as const,
        text: message.text,
        turnId: message.turnId ?? turnId,
        streaming: message.streaming ?? false,
        createdAt: `2026-07-21T00:00:${String(index).padStart(2, "0")}.000Z`,
        updatedAt: `2026-07-21T00:00:${String(index).padStart(2, "0")}.000Z`,
      })),
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: {
        threadId,
        status: input.status,
        providerName: "Codex",
        runtimeMode: "full-access",
        activeTurnId: input.status === "running" || input.status === "starting" ? turnId : null,
        lastError: input.status === "error" ? "failed" : null,
        updatedAt: "2026-07-21T00:01:00.000Z",
      },
    },
  }) as unknown as OrchestrationThreadDetailSnapshot;

const sessionEvent = (
  sequence: number,
  status: OrchestrationSessionStatus,
  activeTurnId: TurnId | null = status === "running" ? turnId : null,
): OrchestrationThreadStreamItem =>
  ({
    kind: "event",
    event: {
      sequence,
      eventId: EventId.make(`event-${sequence}-${status}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-07-21T00:01:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.session-set",
      payload: {
        threadId,
        session: {
          threadId,
          status,
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId,
          lastError: status === "error" ? "failed" : null,
          updatedAt: "2026-07-21T00:01:00.000Z",
        },
      },
    },
  }) as OrchestrationThreadStreamItem;

describe("remote thread watch", () => {
  it.effect("subscribes after the exact initial HTTP snapshot sequence", () =>
    Effect.gen(function* () {
      const cursors: number[] = [];
      let reads = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({ sequence: 41, status: "running" })
              : snapshot({ sequence: 43, status: "ready", messageTexts: [{ text: "done" }] });
          }),
        subscribeThread: (input) =>
          Effect.sync(() => {
            cursors.push(input.afterSequence);
            return { status: "ready", lastSequence: 43, observedRunning: true };
          }),
      };

      const result = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 });
      expect(cursors).toEqual([41]);
      expect(reads).toBe(2);
      expect(result.message.text).toBe("done");
    }),
  );

  it.effect("uses terminal session status even when the turn projection is stale", () =>
    Effect.gen(function* () {
      const terminal = snapshot({
        sequence: 44,
        status: "ready",
        messageTexts: [{ text: "authoritative" }],
      });
      const stale = {
        ...terminal,
        thread: {
          ...terminal.thread,
          latestTurn:
            terminal.thread.latestTurn === null
              ? null
              : { ...terminal.thread.latestTurn, state: "running" as const },
        },
      };
      let subscriptions = 0;
      const transport: RemoteWatchTransport = {
        readThread: () => Effect.succeed(stale),
        subscribeThread: () => {
          subscriptions += 1;
          return Effect.never;
        },
      };

      const result = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 });
      expect(subscriptions).toBe(0);
      expect(result.message.text).toBe("authoritative");
    }),
  );

  it.effect("returns an explicitly requested historical turn that has a final message", () =>
    Effect.gen(function* () {
      const historicalTurnId = TurnId.make("turn-historical");
      const historical = snapshot({
        sequence: 45,
        status: "running",
        messageTexts: [{ text: "historical final", turnId: historicalTurnId }],
      });
      let subscriptions = 0;
      const transport: RemoteWatchTransport = {
        readThread: () => Effect.succeed(historical),
        subscribeThread: () => {
          subscriptions += 1;
          return Effect.never;
        },
      };

      const result = yield* watchRemoteThread({
        transport,
        threadId,
        requestedTurnId: historicalTurnId,
        timeoutMs: 10_000,
      });
      expect(subscriptions).toBe(0);
      expect(result.turnId).toBe(historicalTurnId);
      expect(result.message.text).toBe("historical final");
    }),
  );

  it.effect(
    "dedupes replayed sequences and stops only when the watched running session terminates",
    () =>
      Effect.gen(function* () {
        const result = yield* observeRemoteWatchStream({
          stream: Stream.fromIterable([
            sessionEvent(10, "running"),
            sessionEvent(10, "ready"),
            sessionEvent(11, "ready"),
          ]),
          initialSequence: 9,
          targetTurnId: turnId,
          observedRunning: false,
        });

        expect(result).toEqual({ status: "ready", lastSequence: 11, observedRunning: true });
      }),
  );

  it.effect("does not treat a still-running session as terminal", () =>
    Effect.gen(function* () {
      const result = yield* observeRemoteWatchStream({
        stream: Stream.fromIterable([
          sessionEvent(10, "running"),
          sessionEvent(11, "running", TurnId.make("turn-next")),
          sessionEvent(12, "ready"),
        ]),
        initialSequence: 9,
        targetTurnId: turnId,
        observedRunning: false,
      });

      expect(result).toEqual({ status: "ready", lastSequence: 12, observedRunning: true });
    }),
  );

  it.effect("reconnects from the last cursor after a transport failure", () =>
    Effect.gen(function* () {
      const cursors: number[] = [];
      let reads = 0;
      let attempts = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({ sequence: 5, status: "running" })
              : snapshot({ sequence: 8, status: "ready", messageTexts: [{ text: "replayed" }] });
          }),
        subscribeThread: (input) => {
          cursors.push(input.afterSequence);
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new RemoteWatchFailure({
                  kind: "transport",
                  lastSequence: 7,
                  observedRunning: true,
                }),
              )
            : Effect.succeed({
                status: "ready" as const,
                lastSequence: 8,
                observedRunning: true,
              });
        },
      };

      const fiber = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 }).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("100 millis");
      const result = yield* Fiber.join(fiber);
      expect(cursors).toEqual([5, 7]);
      expect(result.message.text).toBe("replayed");
    }),
  );

  it("selects the final non-streaming assistant message for only the watched turn", () => {
    const otherTurn = TurnId.make("turn-other");
    const final = snapshot({
      sequence: 12,
      status: "ready",
      messageTexts: [
        { text: "wrong turn", turnId: otherTurn },
        { text: "partial", streaming: true },
        { text: "first final" },
        { text: "last final" },
      ],
    });

    expect(selectFinalAssistantMessage(final, turnId)?.text).toBe("last final");
  });

  it.effect("returns a distinct terminal-without-message outcome", () =>
    Effect.gen(function* () {
      let reads = 0;
      const transport: RemoteWatchTransport = {
        readThread: () =>
          Effect.sync(() => {
            reads += 1;
            return reads === 1
              ? snapshot({ sequence: 1, status: "running" })
              : snapshot({ sequence: 2, status: "interrupted" });
          }),
        subscribeThread: () =>
          Effect.succeed({ status: "interrupted", lastSequence: 2, observedRunning: true }),
      };

      const error = yield* watchRemoteThread({ transport, threadId, timeoutMs: 10_000 }).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(RemoteWatchTerminalWithoutMessageError);
      expect(error[Runtime.errorExitCode]).toBe(21);
    }),
  );

  it.effect("returns the dedicated timeout outcome", () =>
    Effect.gen(function* () {
      const transport: RemoteWatchTransport = {
        readThread: () => Effect.succeed(snapshot({ sequence: 1, status: "running" })),
        subscribeThread: () => Effect.never,
      };
      const fiber = yield* watchRemoteThread({
        transport,
        threadId,
        timeoutMs: 1_000,
      }).pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const error = yield* Fiber.join(fiber);
      expect(error).toBeInstanceOf(RemoteWatchTimeoutError);
      expect(error[Runtime.errorExitCode]).toBe(23);
    }),
  );

  it("formats text as only message text and JSON as a structured single result", () => {
    const result = {
      threadId,
      turnId,
      status: "ready" as const,
      message: {
        id: "assistant-final",
        text: "only this text",
        createdAt: "2026-07-21T00:01:00.000Z",
      },
    };
    expect(formatRemoteWatchResult(result, "text")).toBe("only this text");
    expect(JSON.parse(formatRemoteWatchResult(result, "json"))).toEqual(result);
  });
});
