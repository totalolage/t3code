import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ClearAutomaticProjectModelDefaults", (it) => {
  it.effect("clears create-time seeds and preserves explicit project defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          default_thread_env_mode,
          favicon_path,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          ('project-auto', 'Auto', '/tmp/auto', '{"instanceId":"codex","model":"gpt-5.6-sol"}', NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', NULL),
          ('project-title-only', 'Title only', '/tmp/title-only', '{"instanceId":"codex","model":"gpt-5.6-sol"}', NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL),
          ('project-explicit', 'Explicit', '/tmp/explicit', '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}', NULL, NULL, '[]', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL)
      `;

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          ('event-auto-create', 'project', 'project-auto', 0, 'project.created', '2026-08-01T00:00:00.000Z', 'command-auto-create', NULL, 'command-auto-create', 'client', '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}', '{}'),
          ('event-title-create', 'project', 'project-title-only', 0, 'project.created', '2026-08-01T00:00:00.000Z', 'command-title-create', NULL, 'command-title-create', 'client', '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}', '{}'),
          ('event-title-update', 'project', 'project-title-only', 1, 'project.meta-updated', '2026-08-02T00:00:00.000Z', 'command-title-update', NULL, 'command-title-update', 'client', '{"title":"Renamed"}', '{}'),
          ('event-explicit-create', 'project', 'project-explicit', 0, 'project.created', '2026-08-01T00:00:00.000Z', 'command-explicit-create', NULL, 'command-explicit-create', 'client', '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol"}}', '{}'),
          ('event-explicit-update', 'project', 'project-explicit', 1, 'project.meta-updated', '2026-08-02T00:00:00.000Z', 'command-explicit-update', NULL, 'command-explicit-update', 'client', '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}}', '{}')
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const projects = yield* sql<{
        readonly projectId: string;
        readonly selection: string | null;
      }>`
        SELECT
          project_id AS "projectId",
          default_model_selection_json AS "selection"
        FROM projection_projects
        ORDER BY project_id
      `;
      assert.deepStrictEqual(projects, [
        { projectId: "project-auto", selection: null },
        {
          projectId: "project-explicit",
          selection:
            '{"instanceId":"codex","model":"gpt-5.6-sol","options":[{"id":"reasoningEffort","value":"high"}]}',
        },
        { projectId: "project-title-only", selection: null },
      ]);

      const createdEvents = yield* sql<{
        readonly streamId: string;
        readonly model: string | null;
      }>`
        SELECT
          stream_id AS "streamId",
          json_extract(payload_json, '$.defaultModelSelection.model') AS "model"
        FROM orchestration_events
        WHERE event_type = 'project.created'
        ORDER BY stream_id
      `;
      assert.deepStrictEqual(createdEvents, [
        { streamId: "project-auto", model: null },
        { streamId: "project-explicit", model: "gpt-5.6-sol" },
        { streamId: "project-title-only", model: null },
      ]);
    }),
  );
});
