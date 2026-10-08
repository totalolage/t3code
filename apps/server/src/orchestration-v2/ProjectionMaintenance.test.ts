import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { layerMemory } from "../persistence/Sqlite.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const databaseLayer = layerMemory;
const eventStoreLayer = EventStore.layer.pipe(Layer.provideMerge(databaseLayer));
const projectionStoreLayer = ProjectionStore.layer.pipe(Layer.provideMerge(databaseLayer));
const storesLayer = Layer.mergeAll(databaseLayer, eventStoreLayer, projectionStoreLayer);
const maintenanceLayer = ProjectionMaintenance.layer.pipe(Layer.provide(storesLayer));
const testLayer = Layer.mergeAll(storesLayer, maintenanceLayer);

const providerInstanceId = ProviderInstanceId.make("codex");
const now = DateTime.makeUnsafe("2026-10-05T00:00:00.000Z");

it.layer(testLayer)("ProjectionMaintenance run acceptance provenance", (it) => {
  it.effect("rebuilds the exact run.created global sequence", () =>
    Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-accepted-sequence-rebuild");
      const runId = RunId.make("run-accepted-sequence-rebuild");
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-accepted-sequence-rebuild"),
        title: "Rebuilt acceptance sequence",
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
      const run: OrchestrationV2Run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection: thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message-accepted-sequence-rebuild"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "preparing",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const stored = yield* eventStore.append({
        events: [
          {
            id: EventId.make("event-accepted-sequence-rebuild-thread"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
          {
            id: EventId.make("event-accepted-sequence-rebuild-run"),
            type: "run.created",
            threadId,
            runId,
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("event-accepted-sequence-rebuild-queued"),
            type: "run.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: { ...run, status: "queued" },
          },
        ],
      });
      const createdEvent = stored.find(
        (event) => event.event.type === "run.created" && event.event.runId === runId,
      );
      assert.isDefined(createdEvent);
      if (createdEvent === undefined) return;

      assert.isTrue((yield* maintenance.rebuild).valid);
      const rows = yield* sql<{
        readonly status: string;
        readonly accepted_sequence: number | null;
      }>`
        SELECT status, accepted_sequence
        FROM orchestration_v2_projection_runs
        WHERE run_id = ${runId}
      `;
      assert.deepStrictEqual(rows, [
        { status: "queued", accepted_sequence: createdEvent.sequence },
      ]);
    }),
  );
});
