import {
  ProviderSessionId,
  RemoteInteractionRequestId,
  RemoteInteractionThreadId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { PendingInteractionQuery, PendingInteractionQueryLive } from "./PendingInteractionQuery.ts";
import { layerMemory } from "../persistence/Sqlite.ts";

const ACTIVE_SESSION_ID = ProviderSessionId.make("session-active-query-test");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const remoteThreadId = Schema.decodeUnknownSync(RemoteInteractionThreadId);
const remoteRequestId = Schema.decodeUnknownSync(RemoteInteractionRequestId);

const layer = it.layer(
  PendingInteractionQueryLive.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: (providerSessionId) =>
          Effect.succeed(
            providerSessionId === ACTIVE_SESSION_ID ? Option.some({} as never) : Option.none(),
          ),
      }),
    ),
    Layer.provideMerge(layerMemory),
  ),
);

type Seed = {
  readonly threadId?: string;
  readonly requestId: string;
  readonly kind?: "user_input" | "command" | "file-read" | "permission";
  readonly requestStatus?: "pending" | "resolved" | "expired" | "cancelled";
  readonly capability?:
    | { readonly type: "message" }
    | { readonly type: "live"; readonly providerSessionId: string }
    | { readonly type: "not_resumable"; readonly reason: string };
  readonly itemType?: "user_input_request" | "approval_request";
  readonly itemStatus?: "waiting" | "completed" | "cancelled";
  readonly itemRequestId?: string;
  readonly questions?: ReadonlyArray<{
    readonly id: string;
    readonly header: string;
    readonly question: string;
    readonly options: ReadonlyArray<{
      readonly label: string;
      readonly description: string;
      readonly value?: string;
    }>;
    readonly allowCustomAnswer?: boolean;
    readonly multiSelect?: boolean;
  }>;
  readonly createdAt?: string;
  readonly deletedAt?: string | null;
  readonly archivedAt?: string | null;
  readonly bindSession?: boolean;
};

const defaultQuestions = [
  {
    id: "provider-question",
    header: "Target",
    question: "Which target should be used?",
    options: [{ label: "Local", description: "Use the local target.", value: "private/local" }],
    allowCustomAnswer: false,
    multiSelect: false,
  },
] as const;

const clearProjectionTables = (sql: SqlClient.SqlClient) =>
  Effect.all([
    sql`DELETE FROM pending_interaction_responses`,
    sql`DELETE FROM pending_interactions`,
    sql`DELETE FROM orchestration_v2_projection_turn_items`,
    sql`DELETE FROM orchestration_v2_projection_runtime_requests`,
    sql`DELETE FROM orchestration_v2_projection_nodes`,
    sql`DELETE FROM orchestration_v2_projection_provider_session_bindings`,
    sql`DELETE FROM orchestration_v2_projection_provider_sessions`,
    sql`DELETE FROM orchestration_v2_projection_threads`,
  ]);

function createdAtFor(index: number): string {
  return DateTime.formatIso(
    DateTime.add(DateTime.makeUnsafe("2026-09-12T00:00:00.000Z"), { seconds: index }),
  );
}

const insertCandidate = (sql: SqlClient.SqlClient, seed: Seed) =>
  Effect.gen(function* () {
    const threadId = seed.threadId ?? "thread-query-native";
    const requestId = seed.requestId;
    const kind = seed.kind ?? "user_input";
    const requestStatus = seed.requestStatus ?? "pending";
    const capability = seed.capability ?? { type: "message" as const };
    const itemType =
      seed.itemType ?? (kind === "user_input" ? "user_input_request" : "approval_request");
    const itemStatus = seed.itemStatus ?? "waiting";
    const nodeId = `node-${requestId}`;
    const itemId = `item-${requestId}`;
    const createdAt = seed.createdAt ?? createdAtFor(1);
    const sessionId = capability.type === "live" ? capability.providerSessionId : null;

    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, 'project-query-native', 'Query native', 'codex', 'full-access', 'default',
        NULL, ${createdAt}, ${createdAt}, ${seed.archivedAt ?? null}, ${seed.deletedAt ?? null}, '{}'
      ) ON CONFLICT(thread_id) DO NOTHING
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_nodes (
        node_id, thread_id, run_id, parent_node_id, root_node_id, kind, status,
        provider_thread_id, provider_turn_id, runtime_request_id, checkpoint_scope_id,
        started_at, completed_at, payload_json
      ) VALUES (
        ${nodeId}, ${threadId}, NULL, NULL, ${nodeId}, 'agent', 'waiting',
        NULL, NULL, ${requestId}, NULL, ${createdAt}, NULL, '{}'
      )
    `;

    const requestPayload = {
      id: requestId,
      nodeId,
      providerTurnId: null,
      nativeRequestRef: null,
      kind,
      status: requestStatus,
      responseCapability: capability,
      createdAt,
      resolvedAt: requestStatus === "pending" ? null : createdAt,
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests (
        runtime_request_id, thread_id, node_id, provider_turn_id, kind, status,
        created_at, resolved_at, payload_json
      ) VALUES (
        ${requestId}, ${threadId}, ${nodeId}, NULL, ${kind}, ${requestStatus},
        ${createdAt}, ${requestStatus === "pending" ? null : createdAt}, ${encodeJson(requestPayload)}
      )
    `;

    if (sessionId !== null && seed.bindSession !== false) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_session_bindings (
          provider_session_id, thread_id
        ) VALUES (${sessionId}, ${threadId})
      `;
    }

    const itemPayload = {
      id: itemId,
      threadId,
      runId: null,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: itemStatus,
      title: null,
      startedAt: createdAt,
      completedAt: itemStatus === "waiting" ? null : createdAt,
      updatedAt: createdAt,
      type: itemType,
      requestId: seed.itemRequestId ?? requestId,
      ...(itemType === "user_input_request"
        ? {
            questions: seed.questions ?? defaultQuestions,
            responseMode: capability.type === "message" ? "message" : undefined,
          }
        : { requestKind: kind }),
    };
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items (
        turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        parent_item_id, ordinal, type, status, updated_at, payload_json
      ) VALUES (
        ${itemId}, ${threadId}, NULL, ${nodeId}, NULL, NULL,
        NULL, 0, ${itemType}, ${itemStatus}, ${createdAt}, ${encodeJson(itemPayload)}
      )
    `;
  });

layer("PendingInteractionQuery", (it) => {
  it.effect("lists native questions and approvals with server-only answer mappings", () =>
    Effect.gen(function* () {
      const query = yield* PendingInteractionQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* clearProjectionTables(sql);
      yield* insertCandidate(sql, {
        requestId: "request-native-message",
        createdAt: createdAtFor(1),
      });
      yield* insertCandidate(sql, {
        requestId: "request-native-approval",
        kind: "command",
        capability: { type: "live", providerSessionId: ACTIVE_SESSION_ID },
        createdAt: createdAtFor(2),
      });
      yield* insertCandidate(sql, {
        requestId: "request-native-permission",
        kind: "permission",
        createdAt: createdAtFor(3),
      });

      const listed = yield* query.list({ threadId: remoteThreadId("thread-query-native") });
      assert.deepStrictEqual(
        listed.map(({ interaction }) => ({
          kind: interaction.kind,
          requestId: interaction.requestId,
          summary: interaction.summary,
          canApprove: interaction.canApprove,
        })),
        [
          {
            kind: "user-input",
            requestId: RuntimeRequestId.make("request-native-message"),
            summary: "User input requested",
            canApprove: false,
          },
          {
            kind: "approval",
            requestId: RuntimeRequestId.make("request-native-approval"),
            summary: "Command approval requested",
            canApprove: false,
          },
          {
            kind: "approval",
            requestId: RuntimeRequestId.make("request-native-permission"),
            summary: "Permission approval requested",
            canApprove: false,
          },
        ],
      );
      assert.equal(listed[0]?.responseMode, "message");
      assert.equal(listed[0]?.interaction.questions[0]?.providerQuestionId, "provider-question");
      assert.equal(listed[0]?.interaction.questions[0]?.options[0]?.providerValue, "private/local");
    }),
  );

  it.effect(
    "excludes terminal, mismatched, malformed, and inactive live candidates before filling the list",
    () =>
      Effect.gen(function* () {
        const query = yield* PendingInteractionQuery;
        const sql = yield* SqlClient.SqlClient;
        yield* clearProjectionTables(sql);
        yield* insertCandidate(sql, {
          requestId: "request-terminal",
          requestStatus: "resolved",
        });
        yield* insertCandidate(sql, {
          requestId: "request-item-mismatch",
          itemRequestId: "request-other",
        });
        yield* insertCandidate(sql, {
          requestId: "bad/request-id",
        });
        yield* insertCandidate(sql, {
          requestId: "request-unresumable",
          capability: { type: "not_resumable", reason: "server restarted" },
        });

        for (let index = 0; index < 100; index += 1) {
          yield* insertCandidate(sql, {
            requestId: `request-inactive-${String(index).padStart(3, "0")}`,
            capability: {
              type: "live",
              providerSessionId: `session-inactive-${String(index).padStart(3, "0")}`,
            },
            createdAt: createdAtFor(index + 1),
          });
        }
        yield* insertCandidate(sql, {
          requestId: "request-message-after-inactive",
          createdAt: createdAtFor(150),
        });

        const listed = yield* query.list({});
        assert.deepStrictEqual(
          listed.map(({ interaction }) => interaction.requestId),
          [RuntimeRequestId.make("request-message-after-inactive")],
        );
      }),
  );

  it.effect("bounds public results while exact lookup remains independent of the list cap", () =>
    Effect.gen(function* () {
      const query = yield* PendingInteractionQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* clearProjectionTables(sql);
      for (let index = 0; index < 101; index += 1) {
        yield* insertCandidate(sql, {
          requestId: `request-page-${String(index).padStart(3, "0")}`,
          createdAt: createdAtFor(index),
        });
      }

      const listed = yield* query.list({ threadId: remoteThreadId("thread-query-native") });
      assert.equal(listed.length, 100);
      assert.equal(listed[0]?.interaction.requestId, RuntimeRequestId.make("request-page-000"));
      assert.equal(listed.at(-1)?.interaction.requestId, RuntimeRequestId.make("request-page-099"));

      const exact = yield* query.get({
        threadId: remoteThreadId("thread-query-native"),
        requestId: remoteRequestId("request-page-100"),
      });
      assert.equal(exact._tag, "Some");
      if (Option.isSome(exact)) {
        assert.equal(exact.value.interaction.requestId, RuntimeRequestId.make("request-page-100"));
      }
    }),
  );

  it.effect(
    "requires a current session for live requests but keeps message requests after startup",
    () =>
      Effect.gen(function* () {
        const query = yield* PendingInteractionQuery;
        const sql = yield* SqlClient.SqlClient;
        yield* clearProjectionTables(sql);
        yield* insertCandidate(sql, {
          requestId: "request-live-active",
          capability: { type: "live", providerSessionId: ACTIVE_SESSION_ID },
        });
        yield* insertCandidate(sql, {
          requestId: "request-live-inactive",
          capability: { type: "live", providerSessionId: "session-not-running" },
        });
        yield* insertCandidate(sql, {
          requestId: "request-durable-message",
          capability: { type: "message" },
        });

        const listed = yield* query.list({});
        assert.deepStrictEqual(
          listed.map(({ interaction }) => interaction.requestId),
          [
            RuntimeRequestId.make("request-durable-message"),
            RuntimeRequestId.make("request-live-active"),
          ],
        );
        assert.isTrue(
          Option.isSome(
            yield* query.get({
              threadId: remoteThreadId("thread-query-native"),
              requestId: remoteRequestId("request-durable-message"),
            }),
          ),
        );
      }),
  );

  it.effect(
    "hides claimed list entries but leaves exact lookup available to reject the claim",
    () =>
      Effect.gen(function* () {
        const query = yield* PendingInteractionQuery;
        const sql = yield* SqlClient.SqlClient;
        yield* clearProjectionTables(sql);
        yield* insertCandidate(sql, { requestId: "request-claimed" });
        yield* sql`
        INSERT INTO pending_interactions (
          thread_id, request_id, kind, status, summary, can_approve, questions_json,
          response_action, response_command_id, created_at, updated_at, resolved_at
        ) VALUES (
          'thread-query-native', 'request-claimed', 'user-input', 'pending', 'claimed', 0,
          '[]', NULL, NULL, ${createdAtFor(1)}, ${createdAtFor(1)}, NULL
        )
      `;

        assert.deepStrictEqual(yield* query.list({}), []);
        assert.isTrue(
          Option.isSome(
            yield* query.get({
              threadId: remoteThreadId("thread-query-native"),
              requestId: remoteRequestId("request-claimed"),
            }),
          ),
        );
      }),
  );
});
