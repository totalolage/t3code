import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const HIDDEN_AT = "2025-12-31T00:00:00.000Z";

function makeReadModel(input: {
  readonly hiddenAt?: string | null;
  readonly archivedAt?: string | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: input.archivedAt ?? null,
        settledOverride: null,
        settledAt: null,
        hiddenAt: input.hiddenAt ?? null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("hidden thread decider", (it) => {
  it.effect("hides a thread without changing any lifecycle state", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.hide",
          commandId: CommandId.make("cmd-hide"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      });
      const events = "type" in result ? [result] : result;
      expect(events).toHaveLength(1);
      const event = events[0];
      if (
        event?.type === "thread.hidden" &&
        "hiddenAt" in event.payload &&
        "updatedAt" in event.payload
      ) {
        expect(event.payload.hiddenAt).toBe(event.payload.updatedAt);
      } else {
        expect.fail("Expected thread.hidden");
      }
    }),
  );

  it.effect("re-hiding preserves the original timestamps", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.hide",
          commandId: CommandId.make("cmd-hide-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ hiddenAt: HIDDEN_AT }),
      });
      const events = "type" in result ? [result] : result;
      expect(events).toHaveLength(1);
      const event = events[0];
      if (
        event?.type === "thread.hidden" &&
        "hiddenAt" in event.payload &&
        "updatedAt" in event.payload
      ) {
        expect(event.payload.hiddenAt).toBe(HIDDEN_AT);
        expect(event.payload.updatedAt).toBe(NOW);
      } else {
        expect.fail("Expected thread.hidden");
      }
    }),
  );

  it.effect("unhides a hidden thread", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unhide",
          commandId: CommandId.make("cmd-unhide"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ hiddenAt: HIDDEN_AT }),
      });
      const events = "type" in result ? [result] : result;
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.unhidden");
    }),
  );

  it.effect("keeps a hidden thread hidden when a turn starts", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: MessageId.make("message-1"),
            role: "user",
            text: "Run the automation",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: makeReadModel({ hiddenAt: HIDDEN_AT }),
      });
      const events = "type" in result ? [result] : result;
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.turn-start-requested",
      ]);
    }),
  );

  it.effect("rejects hiding or unhiding an archived thread", () =>
    Effect.gen(function* () {
      for (const type of ["thread.hide", "thread.unhide"] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type,
            commandId: CommandId.make(`cmd-${type}`),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel({ archivedAt: NOW }),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
});
