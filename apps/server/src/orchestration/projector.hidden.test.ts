import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

it.effect("projects hidden thread lifecycle events", () =>
  Effect.gen(function* () {
    const createdAt = "2026-01-01T00:00:00.000Z";
    const hiddenAt = "2026-01-02T00:00:00.000Z";
    const created = yield* projectEvent(
      createEmptyReadModel(createdAt),
      makeEvent({
        sequence: 1,
        type: "thread.created",
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Thread",
          modelSelection: { provider: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
      }),
    );
    expect(created.threads[0]?.hiddenAt ?? null).toBeNull();

    const hidden = yield* projectEvent(
      created,
      makeEvent({
        sequence: 2,
        type: "thread.hidden",
        payload: { threadId: ThreadId.make("thread-1"), hiddenAt, updatedAt: hiddenAt },
      }),
    );
    expect(hidden.threads[0]?.hiddenAt).toBe(hiddenAt);

    const unhidden = yield* projectEvent(
      hidden,
      makeEvent({
        sequence: 3,
        type: "thread.unhidden",
        payload: { threadId: ThreadId.make("thread-1"), updatedAt: hiddenAt },
      }),
    );
    expect(unhidden.threads[0]?.hiddenAt).toBeNull();
  }),
);
