import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const threadId = ThreadId.make("thread-accepted-sequence-event-sink");
const projectId = ProjectId.make("project-accepted-sequence-event-sink");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-05T00:00:00.000Z");
const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId,
  title: "Accepted sequence",
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  hiddenAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const runId = RunId.make("run-accepted-sequence-event-sink");
const preparingRun: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: thread.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message-accepted-sequence-event-sink"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "preparing",
  requestedAt: now,
  startedAt: now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};

const makeRun = (
  nextRunId: RunId,
  nextThreadId: ThreadId,
  status: OrchestrationV2Run["status"],
  ordinal = 1,
): OrchestrationV2Run => ({
  ...preparingRun,
  id: nextRunId,
  threadId: nextThreadId,
  ordinal,
  userMessageId: MessageId.make(`message-${nextRunId}`),
  status,
  completedAt: status === "failed" ? now : null,
});

const databaseLayer = layerMemory;
const storesLayer = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provide(databaseLayer),
);
const eventSinkLayer = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(storesLayer, databaseLayer)),
);
const testLayer = Layer.mergeAll(storesLayer, eventSinkLayer, databaseLayer);

it.layer(testLayer)("EventSink run acceptance provenance", (it) => {
  it.effect("marks admission-held queued work in the same committed transaction", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const enrolledThreadId = ThreadId.make("thread-event-sink-enrollment");
      const enrolledThread: OrchestrationV2AppThread = {
        ...thread,
        id: enrolledThreadId,
        projectId: ProjectId.make("project-event-sink-enrollment"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: enrolledThreadId,
        },
      };
      const enrolledRunId = RunId.make("run-event-sink-enrollment");
      yield* eventSink.commitCommand({
        commandId: CommandId.make("command-event-sink-enrollment"),
        threadId: enrolledThreadId,
        commandType: "test.updater-queued-run",
        acceptedAt: now,
        serviceUpdateAdmissionClosed: true,
        events: [
          {
            id: EventId.make("event-event-sink-enrollment-thread"),
            type: "thread.created",
            threadId: enrolledThreadId,
            occurredAt: now,
            payload: enrolledThread,
          },
          {
            id: EventId.make("event-event-sink-enrollment-run"),
            type: "run.created",
            threadId: enrolledThreadId,
            runId: enrolledRunId,
            occurredAt: now,
            payload: makeRun(enrolledRunId, enrolledThreadId, "queued"),
          },
        ],
        effects: [],
      });

      const queued = yield* sql<{
        readonly status: string;
        readonly service_update_resume_after_update: number;
      }>`
        SELECT status, service_update_resume_after_update
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${enrolledRunId}
      `;
      assert.deepStrictEqual(queued, [{ status: "queued", service_update_resume_after_update: 1 }]);

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event-event-sink-enrollment-run-started"),
            type: "run.updated",
            threadId: enrolledThreadId,
            runId: enrolledRunId,
            providerInstanceId,
            occurredAt: now,
            payload: { ...makeRun(enrolledRunId, enrolledThreadId, "starting"), startedAt: now },
          },
        ],
      });
      const started = yield* sql<{ readonly service_update_resume_after_update: number }>`
        SELECT service_update_resume_after_update
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${enrolledRunId}
      `;
      assert.deepStrictEqual(started, [{ service_update_resume_after_update: 0 }]);
    }),
  );

  it.effect("preserves existing manual queue holds at the admission cut", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const heldThreadId = ThreadId.make("thread-event-sink-held");
      const heldThread: OrchestrationV2AppThread = {
        ...thread,
        id: heldThreadId,
        projectId: ProjectId.make("project-event-sink-held"),
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: heldThreadId },
      };
      const heldRunId = RunId.make("run-event-sink-held");
      const queuedRun = makeRun(heldRunId, heldThreadId, "queued");
      yield* eventSink.commitCommand({
        commandId: CommandId.make("command-event-sink-held"),
        threadId: heldThreadId,
        commandType: "test.manually-held-run",
        acceptedAt: now,
        serviceUpdateAdmissionClosed: true,
        events: [
          {
            id: EventId.make("event-event-sink-held-thread"),
            type: "thread.created",
            threadId: heldThreadId,
            occurredAt: now,
            payload: heldThread,
          },
          {
            id: EventId.make("event-event-sink-held-run"),
            type: "run.created",
            threadId: heldThreadId,
            runId: heldRunId,
            occurredAt: now,
            payload: { ...queuedRun, queueHeld: true },
          },
        ],
        effects: [],
      });

      const held = yield* sql<{
        readonly queue_held: number | null;
        readonly service_update_resume_after_update: number;
      }>`
        SELECT
          json_extract(payload_json, '$.queueHeld') AS queue_held,
          service_update_resume_after_update
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${heldRunId}
      `;
      assert.deepStrictEqual(held, [{ queue_held: 1, service_update_resume_after_update: 0 }]);
    }),
  );

  it.effect("keeps run.created sequence instead of receipt sequence", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const unrelatedThreadId = ThreadId.make("thread-accepted-sequence-unrelated");
      const unrelatedThread: OrchestrationV2AppThread = {
        ...thread,
        id: unrelatedThreadId,
        projectId: ProjectId.make("project-accepted-sequence-unrelated"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: unrelatedThreadId,
        },
      };

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event-accepted-sequence-unrelated-thread"),
            type: "thread.created",
            threadId: unrelatedThreadId,
            occurredAt: now,
            payload: unrelatedThread,
          },
        ],
      });

      const queuedRun: OrchestrationV2Run = { ...preparingRun, status: "queued" };
      const result = yield* eventSink.commitCommand({
        commandId: CommandId.make("command-accepted-sequence-event-sink"),
        threadId,
        commandType: "test.run-acceptance",
        acceptedAt: now,
        events: [
          {
            id: EventId.make("event-accepted-sequence-thread"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
          {
            id: EventId.make("event-accepted-sequence-run-created"),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: preparingRun,
          },
          {
            id: EventId.make("event-accepted-sequence-run-queued"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: queuedRun,
          },
        ],
        effects: [],
      });

      const createdEvent = result.storedEvents.find(
        (stored) => stored.event.type === "run.created",
      );
      assert.isDefined(createdEvent);
      if (createdEvent === undefined) return;
      assert.isTrue(createdEvent.sequence < result.receipt.resultSequence);

      const rows = yield* sql<{ readonly accepted_sequence: number | null }>`
        SELECT accepted_sequence
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${runId}
      `;
      assert.deepStrictEqual(rows, [{ accepted_sequence: createdEvent.sequence }]);
    }),
  );

  it.effect("recovers and orders queued runs by original creation across active threads", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const firstThreadId = ThreadId.make("thread-accepted-sequence-first");
      const secondThreadId = ThreadId.make("thread-accepted-sequence-second");
      const firstThread = {
        ...thread,
        id: firstThreadId,
        projectId: ProjectId.make("project-accepted-sequence-first"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: firstThreadId,
        },
      } satisfies OrchestrationV2AppThread;
      const secondThread = {
        ...thread,
        id: secondThreadId,
        projectId: ProjectId.make("project-accepted-sequence-second"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: secondThreadId,
        },
      } satisfies OrchestrationV2AppThread;
      const firstRunId = RunId.make("run-accepted-sequence-first");
      const retriedRun = makeRun(firstRunId, firstThreadId, "preparing");
      const failedRetry = { ...retriedRun, status: "failed" as const, completedAt: now };
      const queuedRetry = { ...retriedRun, status: "queued" as const };
      const secondRunId = RunId.make("run-accepted-sequence-second");
      const secondRun = makeRun(secondRunId, secondThreadId, "queued");
      const activeRun = makeRun(
        RunId.make("run-accepted-sequence-active"),
        firstThreadId,
        "running",
        2,
      );

      const stored = yield* eventSink.write({
        events: [
          {
            id: EventId.make("event-accepted-sequence-first-thread"),
            type: "thread.created",
            threadId: firstThreadId,
            occurredAt: now,
            payload: firstThread,
          },
          {
            id: EventId.make("event-accepted-sequence-first-run-created"),
            type: "run.created",
            threadId: firstThreadId,
            runId: firstRunId,
            occurredAt: now,
            payload: retriedRun,
          },
          {
            id: EventId.make("event-accepted-sequence-second-thread"),
            type: "thread.created",
            threadId: secondThreadId,
            occurredAt: now,
            payload: secondThread,
          },
          {
            id: EventId.make("event-accepted-sequence-second-run-created"),
            type: "run.created",
            threadId: secondThreadId,
            runId: secondRunId,
            occurredAt: now,
            payload: secondRun,
          },
          {
            id: EventId.make("event-accepted-sequence-first-run-failed"),
            type: "run.updated",
            threadId: firstThreadId,
            runId: firstRunId,
            occurredAt: now,
            payload: failedRetry,
          },
          {
            id: EventId.make("event-accepted-sequence-first-run-requeued"),
            type: "run.updated",
            threadId: firstThreadId,
            runId: firstRunId,
            occurredAt: now,
            payload: queuedRetry,
          },
          {
            id: EventId.make("event-accepted-sequence-active-run-created"),
            type: "run.created",
            threadId: firstThreadId,
            runId: activeRun.id,
            occurredAt: now,
            payload: activeRun,
          },
        ],
      });
      const firstCreated = stored.find(
        (event) => event.event.type === "run.created" && event.event.runId === firstRunId,
      );
      const secondCreated = stored.find(
        (event) => event.event.type === "run.created" && event.event.runId === secondRunId,
      );
      assert.isDefined(firstCreated);
      assert.isDefined(secondCreated);
      if (firstCreated === undefined || secondCreated === undefined) return;
      assert.equal(
        stored.filter(
          (event) => event.event.type === "run.created" && event.event.runId === firstRunId,
        ).length,
        1,
      );
      assert.isTrue(firstCreated.sequence < secondCreated.sequence);

      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET accepted_sequence = NULL
        WHERE run_id = ${firstRunId}
      `;

      const queued = yield* ProjectionStore.getQueuedRunAcceptanceOrder({});
      const candidates = queued.filter(
        ({ run: candidate }) => candidate.id === firstRunId || candidate.id === secondRunId,
      );
      assert.deepStrictEqual(
        candidates.map(({ run: candidate, acceptedSequence, blockedReason }) => ({
          runId: candidate.id,
          acceptedSequence,
          blockedReason,
        })),
        [
          {
            runId: firstRunId,
            acceptedSequence: firstCreated.sequence,
            blockedReason: null,
          },
          {
            runId: secondRunId,
            acceptedSequence: secondCreated.sequence,
            blockedReason: null,
          },
        ],
      );
    }),
  );

  it.effect("persists outbox effects from command and direct EventSink writes", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const commandId = CommandId.make("command-outbox-origin-accepted");
      const commandThreadId = ThreadId.make("thread-outbox-origin-accepted");
      const commandThread: OrchestrationV2AppThread = {
        ...thread,
        id: commandThreadId,
        projectId: ProjectId.make("project-outbox-origin-accepted"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: commandThreadId,
        },
      };
      const commandRunId = RunId.make("run-outbox-origin-accepted");
      const commandSecondRunId = RunId.make("run-outbox-origin-accepted-second");
      yield* eventSink.commitCommand({
        commandId,
        threadId: commandThreadId,
        commandType: "test.outbox-origin",
        acceptedAt: now,
        events: [
          {
            id: EventId.make("event-outbox-origin-command-thread"),
            type: "thread.created",
            threadId: commandThreadId,
            occurredAt: now,
            payload: commandThread,
          },
          {
            id: EventId.make("event-outbox-origin-command-run"),
            type: "run.created",
            threadId: commandThreadId,
            runId: commandRunId,
            occurredAt: now,
            payload: makeRun(commandRunId, commandThreadId, "starting"),
          },
          {
            id: EventId.make("event-outbox-origin-command-second-run"),
            type: "run.created",
            threadId: commandThreadId,
            runId: commandSecondRunId,
            occurredAt: now,
            payload: makeRun(commandSecondRunId, commandThreadId, "starting", 2),
          },
        ],
        effects: [
          {
            id: "effect-outbox-origin-command",
            commandId,
            threadId: commandThreadId,
            request: { type: "provider-turn.start", runId: commandRunId },
          },
          {
            id: "effect-outbox-origin-command-second",
            commandId,
            threadId: commandThreadId,
            request: { type: "provider-turn.start", runId: commandSecondRunId },
          },
        ],
      });

      const directThreadId = ThreadId.make("thread-outbox-origin-direct");
      const directThread: OrchestrationV2AppThread = {
        ...thread,
        id: directThreadId,
        projectId: ProjectId.make("project-outbox-origin-direct"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: directThreadId,
        },
      };
      const directRunId = RunId.make("run-outbox-origin-direct");
      const directCommandId = CommandId.make("command-outbox-origin-direct");
      yield* eventSink.writeWithEffects({
        commandId: directCommandId,
        events: [
          {
            id: EventId.make("event-outbox-origin-direct-thread"),
            type: "thread.created",
            threadId: directThreadId,
            occurredAt: now,
            payload: directThread,
          },
          {
            id: EventId.make("event-outbox-origin-direct-run"),
            type: "run.created",
            threadId: directThreadId,
            runId: directRunId,
            occurredAt: now,
            payload: makeRun(directRunId, directThreadId, "starting"),
          },
        ],
        effects: [
          {
            id: "effect-outbox-origin-direct",
            commandId: directCommandId,
            threadId: directThreadId,
            request: { type: "provider-turn.start", runId: directRunId },
          },
        ],
      });

      const effects = yield* sql<{
        readonly effect_id: string;
        readonly command_id: string;
      }>`
        SELECT effect_id, command_id
        FROM orchestration_v2_effect_outbox
        WHERE effect_id IN (
          'effect-outbox-origin-command',
          'effect-outbox-origin-command-second',
          'effect-outbox-origin-direct'
        )
        ORDER BY effect_id
      `;
      assert.deepStrictEqual(effects, [
        {
          effect_id: "effect-outbox-origin-command",
          command_id: commandId,
        },
        {
          effect_id: "effect-outbox-origin-command-second",
          command_id: commandId,
        },
        {
          effect_id: "effect-outbox-origin-direct",
          command_id: directCommandId,
        },
      ]);
    }),
  );

  it.effect("blocks queued runs with missing or contradictory creation evidence", () =>
    Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const missingThreadId = ThreadId.make("thread-accepted-sequence-missing");
      const contradictoryThreadId = ThreadId.make("thread-accepted-sequence-contradictory");
      const missingThread = {
        ...thread,
        id: missingThreadId,
        projectId: ProjectId.make("project-accepted-sequence-missing"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: missingThreadId,
        },
      } satisfies OrchestrationV2AppThread;
      const contradictoryThread = {
        ...thread,
        id: contradictoryThreadId,
        projectId: ProjectId.make("project-accepted-sequence-contradictory"),
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: contradictoryThreadId,
        },
      } satisfies OrchestrationV2AppThread;
      const missingRunId = RunId.make("run-accepted-sequence-missing");
      const contradictoryRunId = RunId.make("run-accepted-sequence-contradictory");
      const stored = yield* eventSink.write({
        events: [
          {
            id: EventId.make("event-accepted-sequence-missing-thread"),
            type: "thread.created",
            threadId: missingThreadId,
            occurredAt: now,
            payload: missingThread,
          },
          {
            id: EventId.make("event-accepted-sequence-missing-created"),
            type: "run.created",
            threadId: missingThreadId,
            runId: missingRunId,
            occurredAt: now,
            payload: makeRun(missingRunId, missingThreadId, "queued"),
          },
          {
            id: EventId.make("event-accepted-sequence-contradictory-thread"),
            type: "thread.created",
            threadId: contradictoryThreadId,
            occurredAt: now,
            payload: contradictoryThread,
          },
          {
            id: EventId.make("event-accepted-sequence-contradictory-created"),
            type: "run.created",
            threadId: contradictoryThreadId,
            runId: contradictoryRunId,
            occurredAt: now,
            payload: makeRun(contradictoryRunId, contradictoryThreadId, "queued"),
          },
        ],
      });
      const missingCreated = stored.find(
        (event) => event.event.type === "run.created" && event.event.runId === missingRunId,
      );
      const contradictoryCreated = stored.find(
        (event) => event.event.type === "run.created" && event.event.runId === contradictoryRunId,
      );
      assert.isDefined(missingCreated);
      assert.isDefined(contradictoryCreated);
      if (missingCreated === undefined || contradictoryCreated === undefined) return;
      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET accepted_sequence = NULL
        WHERE run_id IN (${missingRunId}, ${contradictoryRunId})
      `;
      yield* sql`
        DELETE FROM orchestration_events WHERE sequence = ${missingCreated.sequence}
      `;
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = json_set(payload_json, '$.id', 'run-wrong-identity')
        WHERE sequence = ${contradictoryCreated.sequence}
      `;

      const queued = yield* ProjectionStore.getQueuedRunAcceptanceOrder({});
      const candidates = queued.filter(
        ({ run: candidate }) =>
          candidate.id === missingRunId || candidate.id === contradictoryRunId,
      );
      assert.deepStrictEqual(
        candidates.map(({ run: candidate, acceptedSequence, blockedReason }) => ({
          runId: candidate.id,
          acceptedSequence,
          blockedReason,
        })),
        [
          {
            runId: contradictoryRunId,
            acceptedSequence: null,
            blockedReason: "contradictory-run-created",
          },
          {
            runId: missingRunId,
            acceptedSequence: null,
            blockedReason: "missing-run-created",
          },
        ],
      );
    }),
  );
});
