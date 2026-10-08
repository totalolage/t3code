import {
  AuthSessionId,
  ChatAttachment,
  CommandId,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  PositiveInt,
  ProjectId,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export const HttpCreateLaunchPlan = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  initialMessage: Schema.Struct({
    messageId: MessageId,
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
  }),
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
});
export type HttpCreateLaunchPlan = typeof HttpCreateLaunchPlan.Type;

export const HttpCreatePreparationAttempt = Schema.Struct({
  ordinal: PositiveInt,
  commandId: CommandId,
  kind: Schema.Literals(["launch", "retry"]),
});
export type HttpCreatePreparationAttempt = typeof HttpCreatePreparationAttempt.Type;

export const HttpCreateOperationPhase = Schema.Literals([
  "ready",
  "running",
  "retry-ready",
  "completed",
]);

export const HttpCreateOperation = Schema.Struct({
  keyHash: TrimmedNonEmptyString,
  sessionId: AuthSessionId,
  semanticHash: TrimmedNonEmptyString,
  launchPlan: HttpCreateLaunchPlan,
  phase: HttpCreateOperationPhase,
  attempts: Schema.Array(HttpCreatePreparationAttempt),
  runId: Schema.NullOr(RunId),
  sequence: Schema.NullOr(NonNegativeInt),
  failure: Schema.NullOr(OrchestrationV2ProviderFailure),
});
export type HttpCreateOperation = typeof HttpCreateOperation.Type;

export class OrchestrationHttpCreateOperationPersistenceError extends Schema.TaggedError<OrchestrationHttpCreateOperationPersistenceError>()(
  "OrchestrationHttpCreateOperationPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    keyHash: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.keyHash === undefined
      ? `${this.detail} (${this.operation})`
      : `${this.detail} (${this.operation}, key ${this.keyHash})`;
  }
}

export { OrchestrationHttpCreateOperationPersistenceError as OrchestrationHttpCreateOperationError };

const KeyHashInput = Schema.Struct({ keyHash: TrimmedNonEmptyString });
const AttemptInput = Schema.Struct({
  keyHash: TrimmedNonEmptyString,
  commandId: CommandId,
});
const RunIdInput = Schema.Struct({
  ...AttemptInput.fields,
  runId: RunId,
});
const RetryReadyInput = Schema.Struct({
  ...AttemptInput.fields,
  failure: OrchestrationV2ProviderFailure,
});
const RetryReservationInput = Schema.Struct({
  ...AttemptInput.fields,
  attempt: HttpCreatePreparationAttempt,
});
const CompleteInput = Schema.Struct({
  ...RunIdInput.fields,
  sequence: NonNegativeInt,
});

const OperationRow = Schema.Struct({
  keyHash: TrimmedNonEmptyString,
  sessionId: AuthSessionId,
  semanticHash: TrimmedNonEmptyString,
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  launchPlan: Schema.fromJsonString(HttpCreateLaunchPlan),
  phase: HttpCreateOperationPhase,
  attempts: Schema.fromJsonString(Schema.Array(HttpCreatePreparationAttempt)),
  runId: Schema.NullOr(RunId),
  sequence: Schema.NullOr(NonNegativeInt),
  failure: Schema.NullOr(Schema.fromJsonString(OrchestrationV2ProviderFailure)),
});
const InsertedRow = Schema.Struct({ keyHash: TrimmedNonEmptyString });
const isPersistenceError = Schema.is(OrchestrationHttpCreateOperationPersistenceError);

function toPersistenceError(operation: string, keyHash?: string) {
  return (cause: unknown) =>
    new OrchestrationHttpCreateOperationPersistenceError({
      operation,
      detail: Schema.isSchemaError(cause)
        ? "Stored HTTP create operation is invalid"
        : "SQLite operation failed",
      ...(keyHash === undefined ? {} : { keyHash }),
      cause,
    });
}

const decodeRow = Effect.fn("HttpCreateOperations.decodeRow")(function* (
  row: typeof OperationRow.Type,
) {
  const latestAttempt = row.attempts.at(-1);
  const valid =
    row.commandId === row.launchPlan.commandId &&
    row.threadId === row.launchPlan.threadId &&
    row.messageId === row.launchPlan.messageId &&
    row.launchPlan.initialMessage.messageId === row.messageId &&
    row.attempts.length > 0 &&
    row.attempts.every((attempt, index) => attempt.ordinal === index + 1) &&
    latestAttempt !== undefined &&
    ((row.phase === "ready" &&
      row.attempts.length === 1 &&
      row.runId === null &&
      row.sequence === null) ||
      (row.phase === "running" && row.sequence === null) ||
      (row.phase === "retry-ready" &&
        row.runId !== null &&
        row.failure !== null &&
        row.sequence === null) ||
      (row.phase === "completed" &&
        row.runId !== null &&
        row.sequence !== null &&
        row.failure === null));
  if (!valid) {
    return yield* new OrchestrationHttpCreateOperationPersistenceError({
      operation: "OrchestrationHttpCreateOperations.get:decodeRow",
      detail: "Stored HTTP create operation has contradictory identities or state",
      keyHash: row.keyHash,
    });
  }
  return {
    keyHash: row.keyHash,
    sessionId: row.sessionId,
    semanticHash: row.semanticHash,
    launchPlan: row.launchPlan,
    phase: row.phase,
    attempts: row.attempts,
    runId: row.runId,
    sequence: row.sequence,
    failure: row.failure,
  } satisfies HttpCreateOperation;
});

export class OrchestrationHttpCreateOperations extends Context.Service<
  OrchestrationHttpCreateOperations,
  {
    readonly get: (
      keyHash: string,
    ) => Effect.Effect<
      Option.Option<HttpCreateOperation>,
      OrchestrationHttpCreateOperationPersistenceError
    >;
    readonly insert: (
      operation: HttpCreateOperation,
    ) => Effect.Effect<boolean, OrchestrationHttpCreateOperationPersistenceError>;
    readonly claim: (
      keyHash: string,
    ) => Effect.Effect<boolean, OrchestrationHttpCreateOperationPersistenceError>;
    readonly checkpointRun: (input: {
      readonly keyHash: string;
      readonly commandId: CommandId;
      readonly runId: RunId;
    }) => Effect.Effect<void, OrchestrationHttpCreateOperationPersistenceError>;
    readonly markRetryReady: (input: {
      readonly keyHash: string;
      readonly commandId: CommandId;
      readonly failure: typeof OrchestrationV2ProviderFailure.Type;
    }) => Effect.Effect<void, OrchestrationHttpCreateOperationPersistenceError>;
    readonly reserveRetry: (input: {
      readonly keyHash: string;
      readonly commandId: CommandId;
      readonly attempt: HttpCreatePreparationAttempt;
    }) => Effect.Effect<boolean, OrchestrationHttpCreateOperationPersistenceError>;
    readonly complete: (input: {
      readonly keyHash: string;
      readonly commandId: CommandId;
      readonly runId: RunId;
      readonly sequence: number;
    }) => Effect.Effect<void, OrchestrationHttpCreateOperationPersistenceError>;
  }
>()("t3/persistence/OrchestrationHttpCreateOperations") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: KeyHashInput,
    Result: OperationRow,
    execute: ({ keyHash }) => sql`
      SELECT
        key_hash AS "keyHash",
        session_id AS "sessionId",
        semantic_hash AS "semanticHash",
        command_id AS "commandId",
        thread_id AS "threadId",
        message_id AS "messageId",
        launch_plan_json AS "launchPlan",
        phase,
        attempts_json AS attempts,
        run_id AS "runId",
        result_sequence AS sequence,
        failure_json AS failure
      FROM orchestration_http_create_operations
      WHERE key_hash = ${keyHash}
    `,
  });

  const insertRow = SqlSchema.findAll({
    Request: HttpCreateOperation,
    Result: InsertedRow,
    execute: (operation) => sql`
      INSERT INTO orchestration_http_create_operations (
        key_hash, session_id, semantic_hash, command_id, thread_id, message_id,
        launch_plan_json, phase, attempts_json, run_id, result_sequence, failure_json
      ) VALUES (
        ${operation.keyHash}, ${operation.sessionId}, ${operation.semanticHash},
        ${operation.launchPlan.commandId}, ${operation.launchPlan.threadId},
        ${operation.launchPlan.messageId}, ${JSON.stringify(operation.launchPlan)},
        ${operation.phase}, ${JSON.stringify(operation.attempts)}, ${operation.runId},
        ${operation.sequence},
        ${operation.failure === null ? null : JSON.stringify(operation.failure)}
      )
      ON CONFLICT DO NOTHING
      RETURNING key_hash AS "keyHash"
    `,
  });

  const claimRow = SqlSchema.findAll({
    Request: KeyHashInput,
    Result: InsertedRow,
    execute: ({ keyHash }) => sql`
      UPDATE orchestration_http_create_operations
      SET phase = 'running'
      WHERE key_hash = ${keyHash} AND phase = 'ready'
      RETURNING key_hash AS "keyHash"
    `,
  });

  const checkpointRunRow = SqlSchema.findAll({
    Request: RunIdInput,
    Result: InsertedRow,
    execute: ({ keyHash, commandId, runId }) => sql`
      UPDATE orchestration_http_create_operations
      SET run_id = ${runId}
      WHERE key_hash = ${keyHash} AND phase = 'running'
        AND json_extract(attempts_json, '$[#-1].commandId') = ${commandId}
        AND (run_id IS NULL OR run_id = ${runId})
      RETURNING key_hash AS "keyHash"
    `,
  });

  const markRetryReadyRow = SqlSchema.findAll({
    Request: RetryReadyInput,
    Result: InsertedRow,
    execute: ({ keyHash, commandId, failure }) => sql`
      UPDATE orchestration_http_create_operations
      SET phase = 'retry-ready', failure_json = ${JSON.stringify(failure)}
      WHERE key_hash = ${keyHash} AND phase = 'running' AND run_id IS NOT NULL
        AND json_extract(attempts_json, '$[#-1].commandId') = ${commandId}
        AND result_sequence IS NULL
      RETURNING key_hash AS "keyHash"
    `,
  });

  const reserveRetryRow = SqlSchema.findAll({
    Request: RetryReservationInput,
    Result: InsertedRow,
    execute: ({ keyHash, commandId, attempt }) => sql`
      UPDATE orchestration_http_create_operations
      SET phase = 'running',
        attempts_json = json_insert(attempts_json, '$[#]', json(${JSON.stringify(attempt)})),
        failure_json = NULL
      WHERE key_hash = ${keyHash} AND phase = 'retry-ready'
        AND json_extract(attempts_json, '$[#-1].commandId') = ${commandId}
        AND run_id IS NOT NULL AND result_sequence IS NULL AND failure_json IS NOT NULL
        AND ${attempt.ordinal} = json_array_length(attempts_json) + 1
      RETURNING key_hash AS "keyHash"
    `,
  });

  const completeRow = SqlSchema.findAll({
    Request: CompleteInput,
    Result: InsertedRow,
    execute: ({ keyHash, commandId, runId, sequence }) => sql`
      UPDATE orchestration_http_create_operations
      SET phase = 'completed', run_id = ${runId}, result_sequence = ${sequence}, failure_json = NULL
      WHERE key_hash = ${keyHash} AND phase = 'running'
        AND json_extract(attempts_json, '$[#-1].commandId') = ${commandId}
        AND (run_id IS NULL OR run_id = ${runId})
        AND result_sequence IS NULL
      RETURNING key_hash AS "keyHash"
    `,
  });

  const get: OrchestrationHttpCreateOperations["Service"]["get"] = (keyHash) =>
    getRow({ keyHash }).pipe(
      Effect.mapError(toPersistenceError("OrchestrationHttpCreateOperations.get", keyHash)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (row) => decodeRow(row).pipe(Effect.asSome),
        }),
      ),
      Effect.mapError((cause) =>
        isPersistenceError(cause)
          ? cause
          : toPersistenceError("OrchestrationHttpCreateOperations.get:decode", keyHash)(cause),
      ),
    );

  const insert: OrchestrationHttpCreateOperations["Service"]["insert"] = (operation) =>
    insertRow(operation).pipe(
      Effect.mapError(
        toPersistenceError("OrchestrationHttpCreateOperations.insert", operation.keyHash),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const requireUpdated = <E, R>(
    operation: string,
    keyHash: string,
    update: Effect.Effect<ReadonlyArray<typeof InsertedRow.Type>, E, R>,
  ) =>
    update.pipe(
      Effect.mapError(toPersistenceError(operation, keyHash)),
      Effect.flatMap((rows) =>
        rows.length > 0
          ? Effect.void
          : Effect.fail(
              new OrchestrationHttpCreateOperationPersistenceError({
                operation,
                detail: "HTTP create operation changed before the conditional update",
                keyHash,
              }),
            ),
      ),
    );

  const claim: OrchestrationHttpCreateOperations["Service"]["claim"] = (keyHash) =>
    claimRow({ keyHash }).pipe(
      Effect.mapError(toPersistenceError("OrchestrationHttpCreateOperations.claim", keyHash)),
      Effect.map((rows) => rows.length > 0),
    );

  const checkpointRun: OrchestrationHttpCreateOperations["Service"]["checkpointRun"] = (input) =>
    requireUpdated(
      "OrchestrationHttpCreateOperations.checkpointRun",
      input.keyHash,
      checkpointRunRow(input),
    );

  const markRetryReady: OrchestrationHttpCreateOperations["Service"]["markRetryReady"] = (input) =>
    requireUpdated(
      "OrchestrationHttpCreateOperations.markRetryReady",
      input.keyHash,
      markRetryReadyRow(input),
    );

  const reserveRetry: OrchestrationHttpCreateOperations["Service"]["reserveRetry"] = (input) =>
    reserveRetryRow(input).pipe(
      Effect.mapError(
        toPersistenceError("OrchestrationHttpCreateOperations.reserveRetry", input.keyHash),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const complete: OrchestrationHttpCreateOperations["Service"]["complete"] = (input) =>
    requireUpdated("OrchestrationHttpCreateOperations.complete", input.keyHash, completeRow(input));

  return {
    get,
    insert,
    claim,
    checkpointRun,
    markRetryReady,
    reserveRetry,
    complete,
  } satisfies OrchestrationHttpCreateOperations["Service"];
});

export const layer = Layer.effect(OrchestrationHttpCreateOperations, make);
