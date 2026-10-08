import {
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2TurnItemJson,
  ProviderRequestKind,
  REMOTE_INTERACTION_ID_MAX_CHARS,
  RemoteInteractionRequestId,
  RemoteInteractionThreadId,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import {
  InteractionRecord,
  PendingInteractionKind,
  type InteractionRecord as InteractionRecordType,
  type PendingInteractionQuestion,
} from "../persistence/Services/PendingInteractionResponses.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { questionsFromNative } from "./PendingInteractionPresentation.ts";

const PENDING_INTERACTION_QUERY_LIMIT = 100;
const PENDING_INTERACTION_QUERY_PAGE_SIZE = 100;

// The public identifier schema accepts these ASCII characters after trimming.
// SQL applies the same checks before a malformed native projection row can use
// one of the bounded result slots.
const REMOTE_ID_TRIM_CHARACTERS =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const REMOTE_ID_FIRST_GLOB = "[A-Za-z0-9]*";
const REMOTE_ID_INVALID_GLOB = "*[^A-Za-z0-9._:-]*";

export const PendingInteractionListInput = Schema.Struct({
  threadId: Schema.optionalKey(RemoteInteractionThreadId),
});
export type PendingInteractionListInput = typeof PendingInteractionListInput.Type;

export const PendingInteractionGetInput = Schema.Struct({
  threadId: RemoteInteractionThreadId,
  requestId: RemoteInteractionRequestId,
});
export type PendingInteractionGetInput = typeof PendingInteractionGetInput.Type;

export type NativePendingInteraction = Readonly<{
  readonly interaction: InteractionRecordType;
  /** Private dispatch hint; never included in the public interaction DTO. */
  readonly responseMode?: "message";
}>;

export type PendingInteractionQueryError =
  | ProjectionRepositoryError
  | ProviderSessionManager.ProviderSessionManagerV2Error;

export interface PendingInteractionQueryShape {
  readonly list: (
    input: PendingInteractionListInput,
  ) => Effect.Effect<readonly NativePendingInteraction[], PendingInteractionQueryError>;
  readonly get: (
    input: PendingInteractionGetInput,
  ) => Effect.Effect<Option.Option<NativePendingInteraction>, PendingInteractionQueryError>;
}

export class PendingInteractionQuery extends Context.Service<
  PendingInteractionQuery,
  PendingInteractionQueryShape
>()("t3/orchestration-v2/PendingInteractionQuery") {}

const PendingInteractionDbRow = Schema.Struct({
  threadId: Schema.String,
  requestId: Schema.String,
  createdAt: Schema.String,
  requestPayloadJson: Schema.String,
  itemPayloadJson: Schema.String,
});

type PendingInteractionDbRow = typeof PendingInteractionDbRow.Type;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const decodeProviderRequestKind = Schema.decodeUnknownOption(ProviderRequestKind);
const decodeRuntimeRequestId = Schema.decodeUnknownOption(RuntimeRequestId);
const decodeRuntimeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJson),
);
const decodeTurnItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodeInteraction = Schema.decodeUnknownOption(InteractionRecord);

function approvalSummary(requestKind: string): string {
  const decodedRequestKind = decodeProviderRequestKind(requestKind);
  if (Option.isNone(decodedRequestKind)) return "Approval requested";

  switch (decodedRequestKind.value) {
    case "command":
      return "Command approval requested";
    case "file-read":
      return "File-read approval requested";
    case "file-change":
      return "File-change approval requested";
    case "mcp-elicitation":
      return "App access approval requested";
    case "permission":
      return "Permission approval requested";
  }
}

function copyQuestions(
  questions: ReadonlyArray<PendingInteractionQuestion>,
): ReadonlyArray<PendingInteractionQuestion> {
  return questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option })),
  }));
}

function toNativePendingInteraction(
  row: PendingInteractionDbRow,
): Option.Option<NativePendingInteraction> {
  const requestOption = decodeRuntimeRequest(row.requestPayloadJson);
  const itemOption = decodeTurnItem(row.itemPayloadJson);
  const requestId = decodeRuntimeRequestId(row.requestId);
  if (Option.isNone(requestOption) || Option.isNone(itemOption) || Option.isNone(requestId)) {
    return Option.none();
  }

  const request = requestOption.value;
  const item = itemOption.value;
  if (
    request.status !== "pending" ||
    request.id !== requestId.value ||
    item.threadId !== row.threadId ||
    item.nodeId !== request.nodeId ||
    item.status !== "waiting" ||
    (item.type !== "user_input_request" && item.type !== "approval_request") ||
    item.requestId !== request.id
  ) {
    return Option.none();
  }

  let kind: PendingInteractionKind;
  let summary: string;
  let questions: ReadonlyArray<PendingInteractionQuestion>;
  if (item.type === "user_input_request") {
    if (request.kind !== "user_input") return Option.none();
    const parsedQuestions = questionsFromNative(item.questions);
    if (parsedQuestions === null) return Option.none();
    kind = "user-input";
    summary = "User input requested";
    questions = copyQuestions(parsedQuestions);
  } else {
    if (request.kind !== item.requestKind) return Option.none();
    kind = "approval";
    summary = approvalSummary(item.requestKind);
    questions = [];
  }

  const interaction = decodeInteraction({
    threadId: row.threadId,
    requestId: request.id,
    kind,
    status: "pending",
    summary,
    canApprove: false,
    questions,
    responseAction: null,
    responseCommandId: null,
    createdAt: DateTime.formatIso(request.createdAt),
    updatedAt: DateTime.formatIso(item.updatedAt),
    resolvedAt: null,
  });

  return Option.map(interaction, (value) => ({
    interaction: value,
    ...(request.responseCapability.type === "message" ? { responseMode: "message" as const } : {}),
  }));
}

const makePendingInteractionQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;

  const listPageRequest = Schema.Struct({
    threadId: Schema.optionalKey(RemoteInteractionThreadId),
    afterCreatedAt: Schema.optionalKey(Schema.String),
    afterRequestId: Schema.optionalKey(Schema.String),
  });

  const findCandidateRows = SqlSchema.findAll({
    Request: listPageRequest,
    Result: PendingInteractionDbRow,
    execute: ({ threadId, afterCreatedAt, afterRequestId }) => {
      const threadFilter =
        threadId === undefined ? sql`` : sql`AND request.thread_id = ${threadId}`;
      const cursorFilter =
        afterCreatedAt === undefined || afterRequestId === undefined
          ? sql``
          : sql`AND (request.created_at, request.runtime_request_id) > (${afterCreatedAt}, ${afterRequestId})`;

      return sql`
        WITH candidate_rows AS (
          SELECT
            request.thread_id AS thread_id,
            request.runtime_request_id AS request_id,
            request.created_at AS created_at,
            request.payload_json AS request_payload_json,
            item.payload_json AS item_payload_json,
            ROW_NUMBER() OVER (
              PARTITION BY request.runtime_request_id
              ORDER BY item.ordinal ASC, item.turn_item_id ASC
            ) AS item_rank
          FROM orchestration_v2_projection_runtime_requests AS request
            INDEXED BY orchestration_v2_projection_runtime_requests_thread_status_idx
          INNER JOIN orchestration_v2_projection_nodes AS node
            ON node.thread_id = request.thread_id
            AND node.node_id = request.node_id
          INNER JOIN orchestration_v2_projection_turn_items AS item
            INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
            ON item.thread_id = request.thread_id
            AND item.node_id = request.node_id
            AND item.status = 'waiting'
            AND item.type IN ('approval_request', 'user_input_request')
            AND json_valid(item.payload_json) = 1
            AND json_extract(item.payload_json, '$.threadId') = request.thread_id
            AND json_extract(item.payload_json, '$.nodeId') = request.node_id
            AND json_extract(item.payload_json, '$.requestId') = request.runtime_request_id
          INNER JOIN orchestration_v2_projection_threads AS thread
            ON thread.thread_id = request.thread_id
          WHERE request.status = 'pending'
            AND json_valid(request.payload_json) = 1
            AND json_extract(request.payload_json, '$.id') = request.runtime_request_id
            AND json_extract(request.payload_json, '$.nodeId') = request.node_id
            AND json_extract(request.payload_json, '$.status') = 'pending'
            AND json_extract(request.payload_json, '$.responseCapability.type') IN ('live', 'message')
            AND length(request.thread_id) BETWEEN 1 AND ${REMOTE_INTERACTION_ID_MAX_CHARS}
            AND request.thread_id = trim(request.thread_id, ${REMOTE_ID_TRIM_CHARACTERS})
            AND request.thread_id GLOB ${REMOTE_ID_FIRST_GLOB}
            AND request.thread_id NOT GLOB ${REMOTE_ID_INVALID_GLOB}
            AND instr(request.thread_id, char(0)) = 0
            AND length(request.runtime_request_id) BETWEEN 1 AND ${REMOTE_INTERACTION_ID_MAX_CHARS}
            AND request.runtime_request_id = trim(request.runtime_request_id, ${REMOTE_ID_TRIM_CHARACTERS})
            AND request.runtime_request_id GLOB ${REMOTE_ID_FIRST_GLOB}
            AND request.runtime_request_id NOT GLOB ${REMOTE_ID_INVALID_GLOB}
            AND instr(request.runtime_request_id, char(0)) = 0
            AND (
              (
                item.type = 'user_input_request'
                AND request.kind = 'user_input'
                AND json_extract(item.payload_json, '$.status') = 'waiting'
                AND json_type(item.payload_json, '$.questions') = 'array'
                AND json_array_length(item.payload_json, '$.questions') BETWEEN 1 AND 3
              )
              OR (
                item.type = 'approval_request'
                AND request.kind = json_extract(item.payload_json, '$.requestKind')
                AND json_extract(item.payload_json, '$.status') = 'waiting'
              )
            )
            AND (
              json_extract(request.payload_json, '$.responseCapability.type') = 'message'
              OR EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_provider_session_bindings AS binding
                WHERE binding.thread_id = request.thread_id
                  AND binding.provider_session_id = json_extract(
                    request.payload_json,
                    '$.responseCapability.providerSessionId'
                  )
              )
            )
            ${threadFilter}
            ${cursorFilter}
            AND NOT EXISTS (
              SELECT 1
              FROM pending_interactions AS archived
              WHERE archived.thread_id = request.thread_id
                AND archived.request_id = request.runtime_request_id
                AND archived.status <> 'responding'
            )
        )
        SELECT
          thread_id AS "threadId",
          request_id AS "requestId",
          created_at AS "createdAt",
          request_payload_json AS "requestPayloadJson",
          item_payload_json AS "itemPayloadJson"
        FROM candidate_rows
        WHERE item_rank = 1
        ORDER BY created_at ASC, request_id ASC
        LIMIT ${PENDING_INTERACTION_QUERY_PAGE_SIZE}
      `;
    },
  });

  const findExactCandidateRows = SqlSchema.findAll({
    Request: PendingInteractionGetInput,
    Result: PendingInteractionDbRow,
    execute: ({ threadId, requestId }) => sql`
      SELECT
        request.thread_id AS "threadId",
        request.runtime_request_id AS "requestId",
        request.created_at AS "createdAt",
        request.payload_json AS "requestPayloadJson",
        item.payload_json AS "itemPayloadJson"
      FROM orchestration_v2_projection_runtime_requests AS request
        INDEXED BY orchestration_v2_projection_runtime_requests_thread_status_idx
      INNER JOIN orchestration_v2_projection_nodes AS node
        ON node.thread_id = request.thread_id AND node.node_id = request.node_id
      INNER JOIN orchestration_v2_projection_turn_items AS item
        INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
        ON item.thread_id = request.thread_id
        AND item.node_id = request.node_id
        AND item.status = 'waiting'
        AND item.type IN ('approval_request', 'user_input_request')
        AND json_valid(item.payload_json) = 1
        AND json_extract(item.payload_json, '$.threadId') = request.thread_id
        AND json_extract(item.payload_json, '$.nodeId') = request.node_id
        AND json_extract(item.payload_json, '$.requestId') = request.runtime_request_id
      INNER JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = request.thread_id
      WHERE request.thread_id = ${threadId}
        AND request.runtime_request_id = ${requestId}
        AND request.status = 'pending'
        AND json_valid(request.payload_json) = 1
        AND json_extract(request.payload_json, '$.id') = request.runtime_request_id
        AND json_extract(request.payload_json, '$.nodeId') = request.node_id
        AND json_extract(request.payload_json, '$.status') = 'pending'
        AND json_extract(request.payload_json, '$.responseCapability.type') IN ('live', 'message')
        AND length(request.thread_id) BETWEEN 1 AND ${REMOTE_INTERACTION_ID_MAX_CHARS}
        AND request.thread_id = trim(request.thread_id, ${REMOTE_ID_TRIM_CHARACTERS})
        AND request.thread_id GLOB ${REMOTE_ID_FIRST_GLOB}
        AND request.thread_id NOT GLOB ${REMOTE_ID_INVALID_GLOB}
        AND instr(request.thread_id, char(0)) = 0
        AND length(request.runtime_request_id) BETWEEN 1 AND ${REMOTE_INTERACTION_ID_MAX_CHARS}
        AND request.runtime_request_id = trim(request.runtime_request_id, ${REMOTE_ID_TRIM_CHARACTERS})
        AND request.runtime_request_id GLOB ${REMOTE_ID_FIRST_GLOB}
        AND request.runtime_request_id NOT GLOB ${REMOTE_ID_INVALID_GLOB}
        AND instr(request.runtime_request_id, char(0)) = 0
        AND (
          (
            item.type = 'user_input_request'
            AND request.kind = 'user_input'
            AND json_extract(item.payload_json, '$.status') = 'waiting'
            AND json_type(item.payload_json, '$.questions') = 'array'
            AND json_array_length(item.payload_json, '$.questions') BETWEEN 1 AND 3
          )
          OR (
            item.type = 'approval_request'
            AND request.kind = json_extract(item.payload_json, '$.requestKind')
            AND json_extract(item.payload_json, '$.status') = 'waiting'
          )
        )
        AND (
          json_extract(request.payload_json, '$.responseCapability.type') = 'message'
          OR EXISTS (
            SELECT 1
            FROM orchestration_v2_projection_provider_session_bindings AS binding
            WHERE binding.thread_id = request.thread_id
              AND binding.provider_session_id = json_extract(
                request.payload_json,
                '$.responseCapability.providerSessionId'
              )
          )
        )
      ORDER BY item.ordinal ASC, item.turn_item_id ASC
      LIMIT 100
    `,
  });

  const activeSessionsFor = (rows: ReadonlyArray<PendingInteractionDbRow>) =>
    Effect.gen(function* () {
      const activeById = new Map<string, boolean>();
      const entries: NativePendingInteraction[] = [];
      for (const row of rows) {
        const candidate = toNativePendingInteraction(row);
        if (Option.isNone(candidate)) continue;

        const request = Option.getOrUndefined(decodeRuntimeRequest(row.requestPayloadJson));
        if (request === undefined) continue;
        if (request.responseCapability.type === "live") {
          const sessionId = request.responseCapability.providerSessionId;
          let active = activeById.get(sessionId);
          if (active === undefined) {
            active = Option.isSome(yield* providerSessions.get(sessionId));
            activeById.set(sessionId, active);
          }
          if (!active) continue;
        }
        entries.push(candidate.value);
      }
      return entries;
    });

  const list: PendingInteractionQueryShape["list"] = (input) =>
    Effect.gen(function* () {
      const entries: NativePendingInteraction[] = [];
      let cursor: { readonly afterCreatedAt: string; readonly afterRequestId: string } | undefined;

      while (entries.length < PENDING_INTERACTION_QUERY_LIMIT) {
        const rows = yield* findCandidateRows({
          ...input,
          ...cursor,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "PendingInteractionQuery.list:query",
              "PendingInteractionQuery.list:decodeRows",
            ),
          ),
        );
        if (rows.length === 0) break;

        const active = yield* activeSessionsFor(rows);
        entries.push(...active.slice(0, PENDING_INTERACTION_QUERY_LIMIT - entries.length));

        const last = rows.at(-1)!;
        cursor = { afterCreatedAt: last.createdAt, afterRequestId: last.requestId };
        if (rows.length < PENDING_INTERACTION_QUERY_PAGE_SIZE) break;
      }

      return entries;
    });

  const get: PendingInteractionQueryShape["get"] = (input) =>
    findExactCandidateRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PendingInteractionQuery.get:query",
          "PendingInteractionQuery.get:decodeRows",
        ),
      ),
      Effect.flatMap(activeSessionsFor),
      Effect.map((entries) => Option.fromUndefinedOr(entries[0])),
    );

  return PendingInteractionQuery.of({ list, get });
});

export const PendingInteractionQueryLive = Layer.effect(
  PendingInteractionQuery,
  makePendingInteractionQuery,
);
