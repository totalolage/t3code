import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ServiceUpdateAdmission from "./ServiceUpdateAdmission.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import { layerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");
const adapter: ProviderAdapter.ProviderAdapterV2Shape = {
  instanceId: providerInstanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("A cut-queued message must not open a provider session."),
};
const registryLayer = Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistryV2, {
  get: () => Effect.succeed(adapter),
  list: () => Effect.succeed([providerInstanceId]),
});
const makeServiceUpdateTestLayer = (name: string) =>
  layerWithRegistry({ name }, registryLayer, {
    runEffectWorker: false,
  });

const testLayer = makeServiceUpdateTestLayer("service-update-admission");
const compactRefusalTestLayer = makeServiceUpdateTestLayer("service-update-compact-refusal");

it.layer(testLayer)("Orchestrator service-update admission", (it) => {
  it.effect(
    "queues native messages during updater admission and resumes them after cancellation",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("service-update-admission-project");
        const threadId = ThreadId.make("service-update-admission-thread");
        const now = DateTime.formatIso(yield* DateTime.now);

        yield* projects.apply({
          sequence: 0,
          eventId: EventId.make("service-update-admission-project-created"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: "Updater admission",
            workspaceRoot: "/work/service-update-admission",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("service-update-admission-thread-created"),
          createdBy: "user",
          creationSource: "web",
          threadId,
          projectId,
          title: "Updater admission",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });

        yield* admission.setState("draining");
        const commandId = CommandId.make("service-update-admission-message");
        const messageId = MessageId.make("service-update-admission-message");
        const accepted = yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId,
          text: "The native queue retains work accepted during updater admission.",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
        assert.isDefined(queued);
        if (queued === undefined)
          return yield* Effect.die(new Error("The queued run was not created."));
        assert.equal(queued.status, "queued");
        assert.equal(queued.userMessageId, messageId);
        assert.isTrue(accepted.storedEvents.some((stored) => stored.event.type === "run.created"));
        assert.isFalse(
          (yield* outbox.listByCommandId(commandId)).some(
            (entry) => entry.request.type === "provider-turn.start",
          ),
        );
        const [marker] = yield* sql<{ readonly service_update_resume_after_update: number }>`
        SELECT service_update_resume_after_update
        FROM orchestration_v2_projection_runs WHERE run_id = ${queued.id}
      `;
        assert.equal(marker?.service_update_resume_after_update, 1);
        assert.isTrue(yield* admission.withAdmission((closed) => Effect.succeed(closed)));

        yield* admission.setState("open");
        assert.equal(yield* orchestrator.resumeQueuedRuns, 1);
        const started = (yield* orchestrator.getThreadProjection(threadId)).runs[0];
        assert.isDefined(started);
        assert.equal(started.status, "starting");
        const [clearedMarker] = yield* sql<{ readonly service_update_resume_after_update: number }>`
        SELECT service_update_resume_after_update
        FROM orchestration_v2_projection_runs WHERE run_id = ${queued.id}
      `;
        assert.equal(clearedMarker?.service_update_resume_after_update, 0);
        assert.isTrue(
          (yield* outbox.listByCommandId(
            CommandId.make(`command:system:start-queued:${queued.id}`),
          )).some((entry) => entry.request.type === "provider-turn.start"),
        );
      }),
  );
});

it.layer(compactRefusalTestLayer)("Orchestrator service-update compact refusal", (it) => {
  it.effect("refuses native compaction before writing while updater admission is closed", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const admission = yield* ServiceUpdateAdmission.ServiceUpdateAdmission;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const projectId = ProjectId.make("service-update-compact-refusal-project");
      const threadId = ThreadId.make("service-update-compact-refusal-thread");
      const now = DateTime.formatIso(yield* DateTime.now);

      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make("service-update-compact-refusal-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Compact refusal",
          workspaceRoot: "/work/service-update-compact-refusal",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("service-update-compact-refusal-thread-created"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId,
        title: "Compact refusal",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });

      yield* admission.setState("draining");
      const cleanup = admission.setState("open");
      yield* Effect.gen(function* () {
        const commandId = CommandId.make("service-update-compact-refusal-command");
        const sequenceBefore = yield* eventSink.latestSequence();
        const error = yield* Effect.flip(
          orchestrator.dispatch({ type: "thread.compact", commandId, threadId }),
        );
        if (error._tag !== "OrchestratorDispatchError") {
          throw new Error(`Expected dispatch error, got ${error._tag}.`);
        }
        assert.equal(error.commandType, "thread.compact");
        assert.equal(yield* eventSink.latestSequence(), sequenceBefore);
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runs, []);
        assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
      }).pipe(Effect.ensuring(cleanup));
    }),
  );
});
