import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthInvalidError,
  EnvironmentConflictError,
  EnvironmentInternalError,
  EnvironmentHttpApi,
  EnvironmentHttpConflictError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
  EnvironmentThreadCompactionError,
  CommandId,
  type MessageId,
  OrchestrationCliDispatchCommand,
  OrchestrationCliSnapshot,
  RunId,
  ThreadId,
  TurnItemId,
  PersistChatAttachmentsError,
  UploadChatAttachment,
  OrchestrationV2AppThreadJson,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderSessionJson,
  OrchestrationV2RunJson,
  OrchestrationV2TurnItemJson,
  type OrchestrationV2Command,
  type OrchestrationV2ServerCommand,
  type OrchestrationProjectShell,
  type ChatAttachment,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestUnheldRun,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as SqlClient from "effect/sql/SqlClient";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  InvalidThreadHistoryCursorError,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as PendingInteractionService from "./PendingInteractionService.ts";
import * as ManualThreadCompaction from "./ManualThreadCompaction.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import { persistChatAttachments } from "../assets/InlineChatAttachments.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { makeHttpCreateCoordinator, HttpCreateStateError } from "./httpCreateCoordinator.ts";
import { HttpCreatePlanError, makeHttpCreatePlanResolver } from "./httpCreatePlan.ts";
import * as HttpCreateOperations from "../persistence/OrchestrationHttpCreateOperations.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventStoreV2 from "./EventStore.ts";
import { buildActiveShellSnapshot } from "./ShellStream.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

const isUploadChatAttachment = Schema.is(UploadChatAttachment);

function isThreadNotFound(error: unknown): boolean {
  return (
    Predicate.hasProperty(error, "cause") &&
    Predicate.hasProperty(error.cause, "_tag") &&
    error.cause._tag === "ProjectionStoreThreadNotFoundError"
  );
}

function selectHistoryPageFromCursorOrError(
  input: Parameters<typeof selectHistoryPageFromCursor>[0],
):
  | { readonly _tag: "ok"; readonly page: ReturnType<typeof selectHistoryPageFromCursor> }
  | { readonly _tag: "invalid_cursor" }
  | { readonly _tag: "error"; readonly cause: unknown } {
  try {
    return { _tag: "ok", page: selectHistoryPageFromCursor(input) };
  } catch (cause) {
    if (cause instanceof InvalidThreadHistoryCursorError) {
      return { _tag: "invalid_cursor" };
    }
    return { _tag: "error", cause };
  }
}

type PayloadRow = { readonly thread_id: string; readonly payload_json: string };

type OrchestrationHttpDispatchError =
  | EnvironmentAuthInvalidError
  | EnvironmentConflictError
  | EnvironmentHttpConflictError
  | EnvironmentInternalError
  | EnvironmentRequestInvalidError
  | EnvironmentResourceNotFoundError
  | EnvironmentScopeRequiredError;

type NativeThreadScopedCommand = Extract<OrchestrationV2Command, { readonly threadId: ThreadId }>;

const decodeAppThreadJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const decodeRunJson = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeProviderSessionJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
const decodePlanArtifactJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifact),
);
const decodeTurnItemJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJson),
);
const decodeCliSnapshot = Schema.decodeUnknownEffect(OrchestrationCliSnapshot);
const isThreadNotFoundError = Schema.is(
  ThreadManagementService.ThreadManagementThreadNotFoundError,
);
const isThreadArchivedError = Schema.is(
  ThreadManagementService.ThreadManagementThreadArchivedError,
);
const isThreadRunNotFoundError = Schema.is(
  ThreadManagementService.ThreadManagementRunNotFoundError,
);
const isThreadNotInterruptibleError = Schema.is(
  ThreadManagementService.ThreadManagementThreadNotInterruptibleError,
);
const isThreadNoSteerableRunError = Schema.is(
  ThreadManagementService.ThreadManagementNoSteerableRunError,
);
const isAttachmentClaimError = Schema.is(AttachmentClaims.AttachmentClaimError);
const isPersistChatAttachmentsError = Schema.is(PersistChatAttachmentsError);
const isOrchestratorDispatchError = Schema.is(Orchestrator.OrchestratorDispatchError);
const isOrchestratorCommandRejectedError = Schema.is(Orchestrator.OrchestratorCommandRejectedError);
const isOrchestratorCommandIdConflictError = Schema.is(
  Orchestrator.OrchestratorCommandIdConflictError,
);
const isOrchestratorCommandPreviouslyRejectedError = Schema.is(
  Orchestrator.OrchestratorCommandPreviouslyRejectedError,
);
const isProjectNotFoundError = Schema.is(ProjectService.ProjectNotFoundError);
const isProjectConflictError = Schema.is(ProjectService.ProjectConflictError);
const isProjectNotEmptyError = Schema.is(ProjectService.ProjectNotEmptyError);
const isManualCompactionInvalidRequestError = Schema.is(
  ManualThreadCompaction.ManualCompactionInvalidRequestError,
);
const isManualCompactionThreadNotFoundError = Schema.is(
  ManualThreadCompaction.ManualCompactionThreadNotFoundError,
);
const isEnvironmentThreadCompactionError = Schema.is(EnvironmentThreadCompactionError);
const isPendingInteractionUnavailableError = Schema.is(
  PendingInteractionService.PendingInteractionUnavailableError,
);
const isPendingInteractionInvalidResponseError = Schema.is(
  PendingInteractionService.PendingInteractionInvalidResponseError,
);
const isHttpCreateStateError = Schema.is(HttpCreateStateError);
const isHttpCreatePlanError = Schema.is(HttpCreatePlanError);

const appendByThread = <A>(rows: Map<string, Array<A>>, threadId: string, value: A) => {
  const current = rows.get(threadId);
  if (current === undefined) rows.set(threadId, [value]);
  else current.push(value);
};

const dateMillis = (value: string | DateTime.Utc): number =>
  typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);

function projectMetadataForWire(row: ProjectStore.ProjectRow) {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    defaultModelSelection: row.defaultModelSelection,
    defaultThreadEnvMode: row.defaultThreadEnvMode,
    autoPull: row.autoPull,
    faviconPath: row.faviconPath,
    projectIcon: row.projectIcon,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

const failEnvironmentCreateConflict = (message: string) =>
  currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentConflictError({
          code: "conflict",
          reason: "idempotency_payload_mismatch",
          message,
          traceId,
        }),
      ),
    ),
  );

const compactErrorResponse = (cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (isManualCompactionInvalidRequestError(error)) {
    return failEnvironmentInvalidRequest("invalid_command");
  }
  if (isManualCompactionThreadNotFoundError(error)) {
    return failEnvironmentNotFound("thread_not_found");
  }
  if (isEnvironmentThreadCompactionError(error)) return Effect.fail(error);
  return failEnvironmentInternal("orchestration_dispatch_failed", error ?? cause);
};

/**
 * Serves orchestration V2 snapshots over HTTP so clients can load the
 * (potentially large) shell and thread projections off the socket; gzip
 * compressible and cacheable — and then resume the WebSocket subscription via
 * `afterSequence`.
 */
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const sql = yield* SqlClient.SqlClient;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const projects = yield* ProjectService.ProjectService;
    const projectEnrichment = yield* ProjectEnrichmentService.ProjectEnrichmentService;
    const storedCreateOperations = yield* Effect.serviceOption(
      HttpCreateOperations.OrchestrationHttpCreateOperations,
    );
    const createOperations = Option.isSome(storedCreateOperations)
      ? storedCreateOperations.value
      : yield* HttpCreateOperations.make;
    const commandReceipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const eventStore = yield* EventStoreV2.EventStoreV2;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const pendingInteractions = yield* PendingInteractionService.PendingInteractionService;
    const pendingInteractionResponse = (
      input: Parameters<
        PendingInteractionService.PendingInteractionService["Service"]["respond"]
      >[0],
    ) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Effect.suspend(() => pendingInteractions.respond(input)));
        if (Exit.isSuccess(exit)) return exit.value;

        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
        if (isPendingInteractionUnavailableError(error)) {
          return yield* failEnvironmentNotFound("pending_interaction_not_found");
        }
        if (isPendingInteractionInvalidResponseError(error)) {
          return yield* failEnvironmentInvalidRequest("invalid_interaction");
        }
        return yield* failEnvironmentInternal(
          "pending_interaction_response_failed",
          error ?? exit.cause,
        );
      });
    const createWorkerScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(createWorkerScope, Exit.void));
    const createCoordinator = makeHttpCreateCoordinator({
      operations: createOperations,
      receipts: commandReceipts,
      eventStore,
      applicationEvents,
      threadLaunch,
      resolvePlan: makeHttpCreatePlanResolver({ projectStore, gitWorkflow }).resolve,
      workerScope: createWorkerScope,
    });
    const configuredManualCompaction = yield* Effect.serviceOption(
      ManualThreadCompaction.ManualThreadCompaction,
    );
    const manualCompaction = Option.isSome(configuredManualCompaction)
      ? configuredManualCompaction.value
      : yield* ManualThreadCompaction.makeManualThreadCompaction;

    const enrichProjectShells = Effect.fn("http.orchestration.enrichProjectShells")(
      (projects: ReadonlyArray<OrchestrationProjectShell>) =>
        Effect.forEach(
          projects,
          (project) =>
            // Use immediately available enrichment only. Awaiting git-backed
            // identity resolution can exceed the client shell-snapshot budget
            // (ProcessRunner allows probes up to one minute). Background workers
            // plus the WS enrichment subscription fill in repositoryIdentity.
            projectEnrichment.getAvailable(project.workspaceRoot).pipe(
              Effect.map((enrichment) => ({
                ...project,
                repositoryIdentity: enrichment.repositoryIdentity,
              })),
            ),
          { concurrency: 16 },
        ),
    );

    const dispatchConflict = (message: string) =>
      Effect.fail(new EnvironmentHttpConflictError({ message }));
    const dispatchAccepted = (sequence: number) => ({ sequence });
    const readThreadReceipt = (commandId: CommandId, uncertain: boolean) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.suspend(() => commandReceipts.getByCommandId(commandId)),
        );
        if (Exit.isFailure(exit)) {
          return yield* failEnvironmentInternal(
            uncertain ? "orchestration_send_outcome_unknown" : "orchestration_dispatch_failed",
            exit.cause,
          );
        }
        return exit.value;
      });
    const readProjectReceipt = (commandId: CommandId) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.suspend(() => commandReceipts.getProjectByCommandId(commandId)),
        );
        if (Exit.isFailure(exit)) {
          return yield* failEnvironmentInternal("orchestration_dispatch_failed", exit.cause);
        }
        return exit.value;
      });
    const replayThreadReceipt = (
      receipt: CommandReceiptStore.CommandReceiptV2,
      commandId: CommandId,
      threadId: ThreadId,
      commandType: string,
    ) =>
      Effect.gen(function* () {
        if (
          receipt.commandId !== commandId ||
          receipt.commandType !== commandType ||
          receipt.threadId !== threadId
        ) {
          return yield* failEnvironmentCreateConflict(
            "This command id was already used for different orchestration work.",
          );
        }
        if (receipt.status === "accepted" && receipt.error === null) {
          return dispatchAccepted(receipt.resultSequence);
        }
        if (receipt.status === "rejected" && receipt.error !== null) {
          return yield* dispatchConflict("The orchestration command was rejected.");
        }
        return yield* failEnvironmentInternal(
          "orchestration_dispatch_failed",
          "Contradictory native orchestration receipt.",
        );
      });
    const replayProjectReceipt = (
      receipt: CommandReceiptStore.ProjectCommandReceiptV2,
      commandId: CommandId,
      projectId: string,
      commandType: string,
    ) =>
      Effect.gen(function* () {
        if (
          receipt.commandId !== commandId ||
          receipt.commandType !== commandType ||
          receipt.projectId !== projectId
        ) {
          return yield* failEnvironmentCreateConflict(
            "This command id was already used for different project work.",
          );
        }
        if (receipt.status === "accepted" && receipt.error === null) {
          return dispatchAccepted(receipt.resultSequence);
        }
        if (receipt.status === "rejected" && receipt.error !== null) {
          return yield* dispatchConflict("The project command was rejected.");
        }
        return yield* failEnvironmentInternal(
          "orchestration_dispatch_failed",
          "Contradictory native project receipt.",
        );
      });
    const mapDispatchFailure = (
      error: unknown,
      sendOutcomeUncertain = false,
    ): Effect.Effect<never, OrchestrationHttpDispatchError> => {
      if (isPersistChatAttachmentsError(error)) {
        return error.cause === undefined
          ? failEnvironmentInvalidRequest("invalid_command")
          : failEnvironmentInternal("orchestration_dispatch_failed", error);
      }
      if (isAttachmentClaimError(error)) {
        return failEnvironmentInvalidRequest("invalid_command");
      }
      if (isThreadNotFoundError(error) || isThreadNotFound(error)) {
        return failEnvironmentNotFound("thread_not_found");
      }
      if (isThreadNotInterruptibleError(error) || isThreadArchivedError(error)) {
        return dispatchConflict("The thread changed before this command could be applied.");
      }
      if (isThreadRunNotFoundError(error) || isThreadNoSteerableRunError(error)) {
        return dispatchConflict("The requested run is no longer available.");
      }
      if (isProjectNotFoundError(error)) return failEnvironmentNotFound("project_not_found");
      if (isProjectConflictError(error) || isProjectNotEmptyError(error)) {
        return dispatchConflict("The project changed before this command could be applied.");
      }
      if (
        isOrchestratorCommandIdConflictError(error) ||
        isOrchestratorCommandPreviouslyRejectedError(error)
      ) {
        return failEnvironmentCreateConflict(
          "This command id was already used for different orchestration work.",
        );
      }
      if (isOrchestratorCommandRejectedError(error)) {
        return failEnvironmentInvalidRequest("invalid_command");
      }
      if (sendOutcomeUncertain && isOrchestratorDispatchError(error)) {
        return failEnvironmentInternal("orchestration_send_outcome_unknown", error);
      }
      if (isOrchestratorDispatchError(error)) {
        return dispatchConflict("The command conflicts with the current thread state.");
      }
      if (Predicate.hasProperty(error, "operation") && error.operation === "resolve-project") {
        return failEnvironmentNotFound("project_not_found");
      }
      return failEnvironmentInternal("orchestration_dispatch_failed", error);
    };
    const dispatchThreadOperation = <E, R>(
      input: {
        readonly commandId: CommandId;
        readonly threadId: ThreadId;
        readonly commandType: string;
        readonly sendOutcomeUncertain?: boolean;
      },
      operation: () => Effect.Effect<number, E, R>,
    ) =>
      Effect.gen(function* () {
        const before = yield* readThreadReceipt(
          input.commandId,
          input.sendOutcomeUncertain === true,
        );
        if (Option.isSome(before)) {
          return yield* replayThreadReceipt(
            before.value,
            input.commandId,
            input.threadId,
            input.commandType,
          );
        }
        const dispatched = yield* Effect.exit(Effect.suspend(operation));
        const after = yield* readThreadReceipt(
          input.commandId,
          input.sendOutcomeUncertain === true,
        );
        if (Option.isSome(after)) {
          return yield* replayThreadReceipt(
            after.value,
            input.commandId,
            input.threadId,
            input.commandType,
          );
        }
        if (Exit.isSuccess(dispatched)) {
          return yield* failEnvironmentInternal(
            "orchestration_dispatch_failed",
            "The orchestration operation completed without a native receipt.",
          );
        }
        const error = Option.getOrUndefined(Cause.findErrorOption(dispatched.cause));
        return yield* mapDispatchFailure(error ?? dispatched.cause, input.sendOutcomeUncertain);
      });
    const persistInlineAttachments = (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly attachments: ReadonlyArray<UploadChatAttachment | ChatAttachment>;
    }) =>
      Effect.gen(function* () {
        const uploads: Array<{
          readonly attachment: UploadChatAttachment;
          readonly index: number;
        }> = [];
        input.attachments.forEach((attachment, index) => {
          if (isUploadChatAttachment(attachment)) {
            uploads.push({ attachment, index });
          }
        });
        if (uploads.length === 0) {
          const existing: Array<ChatAttachment> = [];
          for (const attachment of input.attachments) {
            if (isUploadChatAttachment(attachment)) {
              return yield* Effect.die(new Error("Inline attachment indexing lost an upload."));
            }
            existing.push(attachment);
          }
          return existing;
        }

        const persisted = yield* persistChatAttachments({
          threadId: input.threadId,
          messageId: input.messageId,
          attachments: uploads.map(({ attachment }) => attachment),
          attachmentIndices: uploads.map(({ index }) => index),
        });
        const byMessageIndex = new Map<number, ChatAttachment>();
        uploads.forEach(({ index, attachment }, uploadIndex) => {
          const stored = persisted[uploadIndex];
          if (stored !== undefined) {
            byMessageIndex.set(
              index,
              attachment.source === undefined ? stored : { ...stored, source: attachment.source },
            );
          }
        });
        const normalized: Array<ChatAttachment> = [];
        for (const [index, attachment] of input.attachments.entries()) {
          if (isUploadChatAttachment(attachment)) {
            const stored = byMessageIndex.get(index);
            if (stored === undefined) {
              return yield* Effect.die(new Error("Inline attachment persistence lost an upload."));
            }
            normalized.push(stored);
          } else {
            normalized.push(attachment);
          }
        }
        return normalized;
      });
    const dispatchProjectOperation = <E, R>(
      input: {
        readonly commandId: CommandId;
        readonly projectId: string;
        readonly commandType: string;
      },
      operation: () => Effect.Effect<unknown, E, R>,
    ) =>
      Effect.gen(function* () {
        const before = yield* readProjectReceipt(input.commandId);
        if (Option.isSome(before)) {
          return yield* replayProjectReceipt(
            before.value,
            input.commandId,
            input.projectId,
            input.commandType,
          );
        }
        const dispatched = yield* Effect.exit(Effect.suspend(operation));
        const after = yield* readProjectReceipt(input.commandId);
        if (Option.isSome(after)) {
          return yield* replayProjectReceipt(
            after.value,
            input.commandId,
            input.projectId,
            input.commandType,
          );
        }
        if (Exit.isFailure(dispatched)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(dispatched.cause));
          return yield* mapDispatchFailure(error ?? dispatched.cause);
        }
        return yield* failEnvironmentInternal(
          "orchestration_dispatch_failed",
          "The project operation completed without a native receipt.",
        );
      });

    const dispatchNativeCommand = (command: OrchestrationV2ServerCommand) =>
      command.type === "message.dispatch" || command.type === "queued-run.edit"
        ? ThreadMessageIntake.dispatchCommand(command)
        : threadManagement.dispatch(command);

    const dispatchDirectThreadCommand = (command: NativeThreadScopedCommand) =>
      dispatchThreadOperation(
        {
          commandId: command.commandId,
          threadId: command.threadId,
          commandType: command.type,
        },
        () => dispatchNativeCommand(command).pipe(Effect.map((result) => result.sequence)),
      );

    const dispatchCheckpointRevert = (
      command: Extract<
        OrchestrationCliDispatchCommand,
        { type: "thread.checkpoint.revert" | "thread.conversation.revert" }
      >,
    ) =>
      Effect.gen(function* () {
        const nativeType = "checkpoint.rollback";
        const before = yield* readThreadReceipt(command.commandId, false);
        if (Option.isSome(before)) {
          return yield* replayThreadReceipt(
            before.value,
            command.commandId,
            command.threadId,
            nativeType,
          );
        }

        const recordsExit = yield* Effect.exit(
          threadManagement.getThreadRecords(command.threadId, [
            "runs",
            "providerThreads",
            "checkpointScopes",
            "checkpoints",
          ]),
        );
        if (Exit.isFailure(recordsExit)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(recordsExit.cause));
          return yield* mapDispatchFailure(error ?? recordsExit.cause);
        }
        const records = recordsExit.value;
        let targetScope: (typeof records.checkpointScopes)[number] | undefined;
        let targetCheckpoint: (typeof records.checkpoints)[number] | undefined;
        if (command.turnCount === 0) {
          const activeProviderThread = records.providerThreads.find(
            (providerThread) => providerThread.id === records.thread.activeProviderThreadId,
          );
          if (activeProviderThread === undefined) {
            return yield* dispatchConflict("No active provider lineage is available for rollback.");
          }
          const projectExit = yield* Effect.exit(projectStore.get(records.thread.projectId));
          if (Exit.isFailure(projectExit)) {
            return yield* failEnvironmentInternal(
              "orchestration_dispatch_failed",
              projectExit.cause,
            );
          }
          const project = projectExit.value;
          if (Option.isNone(project)) {
            return yield* failEnvironmentNotFound("project_not_found");
          }
          const workspaceRoot = records.thread.worktreePath ?? project.value.workspaceRoot;
          const baselineScopes = records.checkpointScopes.filter((scope) => {
            if (
              scope.kind !== "root_run" ||
              scope.providerThreadId !== activeProviderThread.id ||
              scope.cwd !== workspaceRoot ||
              scope.runId === null
            ) {
              return false;
            }
            return records.runs.some(
              (run) =>
                run.id === scope.runId &&
                run.providerThreadId === activeProviderThread.id &&
                run.rootNodeId === scope.nodeId,
            );
          });
          const baselines = baselineScopes.flatMap((scope) => {
            const checkpoint = records.checkpoints.find(
              (candidate) =>
                candidate.scopeId === scope.id &&
                candidate.ordinalWithinScope === 0 &&
                candidate.runId === null &&
                candidate.appRunOrdinal === null &&
                candidate.status === "ready",
            );
            return checkpoint === undefined ? [] : [{ scope, checkpoint }];
          });
          if (baselines.length !== 1) {
            return yield* dispatchConflict(
              "The current workspace has no unique ready baseline checkpoint.",
            );
          }
          targetScope = baselines[0]?.scope;
          targetCheckpoint = baselines[0]?.checkpoint;
        } else {
          const rootUserRuns = records.runs
            .filter(
              (run) =>
                run.purpose !== "compaction" &&
                run.status !== "rolled_back" &&
                run.userMessageId !== undefined &&
                run.rootNodeId !== null,
            )
            .toSorted((left, right) => left.ordinal - right.ordinal);
          const targetRun = rootUserRuns[command.turnCount - 1];
          if (targetRun === undefined) {
            return yield* dispatchConflict("The requested user-turn checkpoint is unavailable.");
          }
          const activeProviderThread = records.providerThreads.find(
            (providerThread) => providerThread.id === records.thread.activeProviderThreadId,
          );
          if (activeProviderThread === undefined) {
            return yield* dispatchConflict("No active provider lineage is available for rollback.");
          }
          const projectExit = yield* Effect.exit(projectStore.get(records.thread.projectId));
          if (Exit.isFailure(projectExit)) {
            return yield* failEnvironmentInternal(
              "orchestration_dispatch_failed",
              projectExit.cause,
            );
          }
          const project = projectExit.value;
          if (Option.isNone(project)) {
            return yield* failEnvironmentNotFound("project_not_found");
          }
          const workspaceRoot = records.thread.worktreePath ?? project.value.workspaceRoot;
          if (targetRun.providerThreadId !== activeProviderThread.id) {
            return yield* dispatchConflict("The requested user-turn checkpoint is unavailable.");
          }
          const rootScopes = records.checkpointScopes.filter(
            (scope) =>
              scope.kind === "root_run" &&
              scope.providerThreadId === activeProviderThread.id &&
              scope.cwd === workspaceRoot &&
              scope.parentScopeId === null &&
              scope.advancesAppRunCount,
          );
          const candidates = rootScopes.flatMap((scope) => {
            const checkpoint = records.checkpoints.find(
              (candidate) =>
                candidate.scopeId === scope.id &&
                candidate.runId === targetRun.id &&
                candidate.appRunOrdinal === targetRun.ordinal &&
                candidate.nodeId === targetRun.rootNodeId &&
                candidate.status === "ready",
            );
            return checkpoint === undefined ? [] : [{ scope, checkpoint }];
          });
          if (candidates.length !== 1) {
            return yield* dispatchConflict("The requested user-turn checkpoint is unavailable.");
          }
          targetScope = candidates[0]?.scope;
          targetCheckpoint = candidates[0]?.checkpoint;
        }
        if (targetScope === undefined || targetCheckpoint === undefined) {
          return yield* dispatchConflict("The requested checkpoint is unavailable.");
        }

        return yield* dispatchThreadOperation(
          {
            commandId: command.commandId,
            threadId: command.threadId,
            commandType: nativeType,
          },
          () =>
            dispatchNativeCommand({
              type: nativeType,
              commandId: command.commandId,
              threadId: command.threadId,
              scopeId: targetScope.id,
              checkpointId: targetCheckpoint.id,
              restoreFiles: command.type !== "thread.conversation.revert",
            }).pipe(Effect.map((result) => result.sequence)),
        );
      });

    const dispatchTurnStart = (
      command: Extract<OrchestrationCliDispatchCommand, { type: "thread.turn.start" }>,
    ) => {
      const bootstrap = command.bootstrap;
      if (bootstrap === undefined) {
        const plainSend =
          command.message.attachments.length === 0 &&
          command.message.context === undefined &&
          command.modelSelection === undefined &&
          command.titleSeed === undefined &&
          command.sourceProposedPlan === undefined;
        return dispatchThreadOperation(
          {
            commandId: command.commandId,
            threadId: command.threadId,
            commandType: "message.dispatch",
            sendOutcomeUncertain: true,
          },
          () =>
            Effect.gen(function* () {
              if (plainSend) {
                const target = yield* threadManagement.getThreadRecords(command.threadId, []);
                const sent = yield* threadManagement.sendToThread({
                  projectId: target.thread.projectId,
                  commandId: command.commandId,
                  threadId: command.threadId,
                  messageId: command.message.messageId,
                  text: command.message.text,
                  attachments: [],
                  mode: "auto",
                  createdBy: "user",
                  creationSource: "server",
                });
                return sent.dispatch.sequence;
              }
              const attachments = yield* persistInlineAttachments({
                threadId: command.threadId,
                messageId: command.message.messageId,
                attachments: command.message.attachments,
              });
              const result = yield* ThreadMessageIntake.dispatchCommand({
                type: "message.dispatch",
                commandId: command.commandId,
                threadId: command.threadId,
                messageId: command.message.messageId,
                text: command.message.text,
                attachments,
                ...(command.message.context === undefined
                  ? {}
                  : { context: command.message.context }),
                ...(command.modelSelection === undefined
                  ? {}
                  : { modelSelection: command.modelSelection }),
                ...(command.titleSeed === undefined ? {} : { titleSeed: command.titleSeed }),
                ...(command.sourceProposedPlan === undefined
                  ? {}
                  : { sourcePlanRef: command.sourceProposedPlan }),
                deliveryIntent: "auto",
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "server",
              });
              return result.sequence;
            }),
        );
      }

      return Effect.gen(function* () {
        const createThread = bootstrap.createThread;
        if (createThread === undefined) {
          return yield* failEnvironmentInvalidRequest("invalid_command");
        }
        const initialMessageCommandId = CommandId.make(`${command.commandId}:initial-message`);
        const priorMessage = yield* readThreadReceipt(initialMessageCommandId, true);
        if (Option.isSome(priorMessage)) {
          return yield* replayThreadReceipt(
            priorMessage.value,
            initialMessageCommandId,
            command.threadId,
            "message.dispatch",
          );
        }
        const workspaceStrategy =
          bootstrap.prepareWorktree !== undefined
            ? {
                type: "worktree" as const,
                baseRef: bootstrap.prepareWorktree.baseBranch,
                ...(bootstrap.prepareWorktree.branch === undefined
                  ? {}
                  : { branch: bootstrap.prepareWorktree.branch }),
                ...(bootstrap.prepareWorktree.startFromOrigin === undefined
                  ? {}
                  : { startFromOrigin: bootstrap.prepareWorktree.startFromOrigin }),
                runSetupScript: bootstrap.runSetupScript === true,
              }
            : createThread.worktreePath === null
              ? {
                  type: "root" as const,
                  ...(createThread.branch === null ? {} : { branch: createThread.branch }),
                  runSetupScript: bootstrap.runSetupScript === true,
                }
              : {
                  type: "existing_worktree" as const,
                  worktreePath: createThread.worktreePath,
                  ...(createThread.branch === null ? {} : { branch: createThread.branch }),
                  runSetupScript: bootstrap.runSetupScript === true,
                };
        const launch = yield* Effect.exit(
          Effect.gen(function* () {
            const attachments = yield* persistInlineAttachments({
              threadId: command.threadId,
              messageId: command.message.messageId,
              attachments: command.message.attachments,
            });
            return yield* ThreadMessageIntake.launchThread({
              commandId: command.commandId,
              threadId: command.threadId,
              projectId: createThread.projectId,
              title: command.titleSeed ?? createThread.title,
              generateTitle: command.titleSeed !== undefined,
              modelSelection: createThread.modelSelection,
              runtimeMode: createThread.runtimeMode,
              interactionMode: createThread.interactionMode,
              workspaceStrategy,
              initialMessage: {
                messageId: command.message.messageId,
                text: command.message.text,
                attachments,
                ...(command.message.context === undefined
                  ? {}
                  : { context: command.message.context }),
                ...(command.sourceProposedPlan === undefined
                  ? {}
                  : { sourcePlanRef: command.sourceProposedPlan }),
              },
              createdBy: "user",
              creationSource: "server",
            });
          }),
        );
        const afterMessage = yield* readThreadReceipt(initialMessageCommandId, true);
        if (Option.isSome(afterMessage)) {
          return yield* replayThreadReceipt(
            afterMessage.value,
            initialMessageCommandId,
            command.threadId,
            "message.dispatch",
          );
        }
        if (Exit.isFailure(launch)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(launch.cause));
          if (isPersistChatAttachmentsError(error) || isAttachmentClaimError(error)) {
            return yield* mapDispatchFailure(error);
          }
          if (
            Predicate.hasProperty(error, "operation") &&
            (error.operation === "resolve-project" || error.operation === "read-receipt")
          ) {
            return yield* mapDispatchFailure(error);
          }
          return yield* failEnvironmentInternal(
            "orchestration_send_outcome_unknown",
            error ?? launch.cause,
          );
        }
        return yield* failEnvironmentInternal(
          "orchestration_send_outcome_unknown",
          "The launch returned without an accepted initial-message receipt.",
        );
      });
    };

    const dispatchCliCommand = (command: OrchestrationCliDispatchCommand) => {
      switch (command.type) {
        case "project.create":
          return dispatchProjectOperation(
            {
              commandId: command.commandId,
              projectId: command.projectId,
              commandType: command.type,
            },
            () =>
              projects
                .create({
                  commandId: command.commandId,
                  projectId: command.projectId,
                  title: command.title,
                  workspaceRoot: command.workspaceRoot,
                  ...(command.createWorkspaceRootIfMissing === undefined
                    ? {}
                    : { createWorkspaceRootIfMissing: command.createWorkspaceRootIfMissing }),
                })
                .pipe(Effect.as(undefined)),
          );
        case "project.meta.update":
          return dispatchProjectOperation(
            {
              commandId: command.commandId,
              projectId: command.projectId,
              commandType: command.type,
            },
            () => projects.update(command).pipe(Effect.as(undefined)),
          );
        case "project.delete":
          return dispatchProjectOperation(
            {
              commandId: command.commandId,
              projectId: command.projectId,
              commandType: command.type,
            },
            () =>
              projects
                .delete({
                  commandId: command.commandId,
                  projectId: command.projectId,
                  ...(command.force === undefined ? {} : { force: command.force }),
                })
                .pipe(Effect.as(undefined)),
          );
        case "thread.create":
          return dispatchThreadOperation(
            {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: command.type,
            },
            () =>
              dispatchNativeCommand({
                type: "thread.create",
                commandId: command.commandId,
                threadId: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: command.branch,
                worktreePath: command.worktreePath,
                createdBy: "user",
                creationSource: "server",
              }).pipe(Effect.map((result) => result.sequence)),
          );
        case "thread.delete":
        case "thread.archive":
        case "thread.unarchive":
        case "thread.settle":
        case "thread.hide":
        case "thread.unhide":
        case "thread.pin":
        case "thread.unpin":
          return dispatchDirectThreadCommand({
            type: command.type,
            commandId: command.commandId,
            threadId: command.threadId,
          });
        case "thread.unsettle":
          return dispatchDirectThreadCommand({
            type: command.type,
            commandId: command.commandId,
            threadId: command.threadId,
            reason: command.reason,
          });
        case "thread.snooze":
          return dispatchDirectThreadCommand({
            type: command.type,
            commandId: command.commandId,
            threadId: command.threadId,
            snoozedUntil: command.snoozedUntil,
          });
        case "thread.unsnooze":
          return dispatchDirectThreadCommand({
            type: command.type,
            commandId: command.commandId,
            threadId: command.threadId,
            reason: command.reason,
          });
        case "thread.pin.reorder":
        case "thread.active.reorder":
          return dispatchDirectThreadCommand({
            type: command.type,
            commandId: command.commandId,
            threadId: command.threadId,
            orderKey: command.orderKey,
          });
        case "thread.turn.start":
          return dispatchTurnStart(command);
        case "thread.turn.interrupt":
          return dispatchThreadOperation(
            {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: "run.interrupt",
            },
            () =>
              Effect.gen(function* () {
                const explicitRunId =
                  command.turnId === undefined ? undefined : RunId.make(command.turnId);
                const records = yield* threadManagement.getThreadRecords(command.threadId, [
                  "runs",
                ]);
                if (
                  explicitRunId !== undefined &&
                  records.runs.filter((run) => run.id === explicitRunId).length !== 1
                ) {
                  return yield* dispatchConflict(
                    "The requested turn is not available on this thread.",
                  );
                }
                const interrupted = yield* threadManagement.interruptThread({
                  projectId: records.thread.projectId,
                  threadId: command.threadId,
                  commandId: command.commandId,
                  ...(explicitRunId === undefined ? {} : { runId: explicitRunId }),
                });
                if (interrupted.type === "interrupt_requested") {
                  return interrupted.dispatch.sequence;
                }
                return yield* new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: "run.interrupt",
                  cause:
                    interrupted.type === "no_active_run"
                      ? "No active turn is available to interrupt."
                      : "The requested turn has already ended.",
                });
              }),
          );
        case "thread.checkpoint.revert":
        case "thread.conversation.revert":
          return dispatchCheckpointRevert(command);
        case "thread.session.stop":
          return dispatchThreadOperation(
            {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: command.type,
            },
            () =>
              dispatchNativeCommand({
                type: "thread.session.stop",
                commandId: command.commandId,
                threadId: command.threadId,
                createdAt: DateTime.makeUnsafe(command.createdAt),
                ...(command.onlyIfSettled === undefined
                  ? {}
                  : { onlyIfSettled: command.onlyIfSettled }),
              }).pipe(Effect.map((result) => result.sequence)),
          );
        case "thread.meta.update": {
          const { type: _type, ...metadata } = command;
          return dispatchThreadOperation(
            {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: "thread.metadata.update",
            },
            () =>
              dispatchNativeCommand({
                ...metadata,
                type: "thread.metadata.update",
              }).pipe(Effect.map((result) => result.sequence)),
          );
        }
        case "thread.runtime-mode.set":
          return dispatchThreadOperation(
            {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: command.type,
            },
            () =>
              dispatchNativeCommand({
                type: command.type,
                commandId: command.commandId,
                threadId: command.threadId,
                runtimeMode: command.runtimeMode,
              }).pipe(Effect.map((result) => result.sequence)),
          );
        case "thread.interaction-mode.set":
          return dispatchThreadOperation(
            {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: command.type,
            },
            () =>
              dispatchNativeCommand({
                type: command.type,
                commandId: command.commandId,
                threadId: command.threadId,
                interactionMode: command.interactionMode,
              }).pipe(Effect.map((result) => result.sequence)),
          );
        case "thread.auto-settle":
          return dispatchThreadOperation(
            {
              commandId: command.commandId,
              threadId: command.threadId,
              commandType: command.type,
            },
            () =>
              dispatchNativeCommand({
                ...command,
                settledAt: DateTime.makeUnsafe(command.settledAt),
              }).pipe(Effect.map((result) => result.sequence)),
          );
        case "thread.pull-request.link":
        case "thread.pull-request.unlink":
          return dispatchDirectThreadCommand(command);
        case "thread.compact":
        case "thread.approval.respond":
        case "thread.user-input.respond":
        case "thread.user-input.dismiss":
          return failEnvironmentInvalidRequest("invalid_command");
        default:
          return failEnvironmentInvalidRequest("invalid_command");
      }
    };

    const loadShellSnapshot = Effect.fn("http.orchestration.loadShellSnapshot")(function* () {
      const base = yield* sql.withTransaction(
        Effect.gen(function* () {
          const threads = yield* threadManagement.getShellSnapshot({ location: "active" });
          return buildActiveShellSnapshot({
            projects: yield* projectStore.listShells(),
            threads,
            snapshotSequence: yield* applicationEvents.latestApplicationSequence,
          });
        }),
      );
      const projects = yield* enrichProjectShells(base.projects);
      return { ...base, projects };
    });

    const loadCliSnapshot = Effect.fn("http.orchestration.loadCliSnapshot")(function* () {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const [projectRows, threadRows, runRows, sessionRows, planRows, snapshotSequence] =
            yield* Effect.all([
              projectStore.list({ includeDeleted: true }),
              sql<PayloadRow>`
                SELECT thread_id, payload_json
                FROM orchestration_v2_projection_threads
                ORDER BY created_at ASC, thread_id ASC
              `,
              sql<PayloadRow>`
                SELECT thread_id, payload_json
                FROM orchestration_v2_projection_runs
                ORDER BY thread_id ASC, ordinal ASC, run_id ASC
              `,
              sql<PayloadRow>`
                SELECT bindings.thread_id, sessions.payload_json
                FROM orchestration_v2_projection_provider_session_bindings AS bindings
                INNER JOIN orchestration_v2_projection_provider_sessions AS sessions
                  ON sessions.provider_session_id = bindings.provider_session_id
                ORDER BY bindings.thread_id ASC, sessions.updated_at ASC, sessions.provider_session_id ASC
              `,
              sql<PayloadRow>`
                SELECT thread_id, payload_json
                FROM orchestration_v2_projection_plans
                ORDER BY thread_id ASC, plan_id ASC
              `,
              applicationEvents.latestApplicationSequence,
            ]);

          const [threads, runs, providerSessions, plans] = yield* Effect.all([
            Effect.forEach(threadRows, (row) => decodeAppThreadJson(row.payload_json)),
            Effect.forEach(runRows, (row) => decodeRunJson(row.payload_json)),
            Effect.forEach(sessionRows, (row) => decodeProviderSessionJson(row.payload_json)),
            Effect.forEach(planRows, (row) => decodePlanArtifactJson(row.payload_json)),
          ]);

          const runsByThread = new Map<string, typeof runs>();
          for (const [index, row] of runRows.entries()) {
            const decoded = runs[index];
            if (decoded !== undefined) appendByThread(runsByThread, row.thread_id, decoded);
          }
          const sessionsByThread = new Map<string, typeof providerSessions>();
          for (const [index, row] of sessionRows.entries()) {
            const decoded = providerSessions[index];
            if (decoded !== undefined) appendByThread(sessionsByThread, row.thread_id, decoded);
          }
          const plansByThread = new Map<string, typeof plans>();
          for (const [index, row] of planRows.entries()) {
            const decoded = plans[index];
            if (decoded !== undefined) appendByThread(plansByThread, row.thread_id, decoded);
          }

          const failedLatestRuns = threads.flatMap((thread) => {
            const latestExecuted = latestExecutedRun(runsByThread.get(thread.id) ?? []);
            return latestExecuted?.status === "failed" && latestExecuted.rootNodeId !== null
              ? [
                  {
                    threadId: thread.id,
                    runId: latestExecuted.id,
                    nodeId: latestExecuted.rootNodeId,
                  },
                ]
              : [];
          });
          const failedRootErrors =
            failedLatestRuns.length === 0
              ? []
              : yield* sql<PayloadRow>`
                  SELECT thread_id, payload_json
                  FROM orchestration_v2_projection_turn_items
                  WHERE type = 'error' AND status = 'failed'
                    AND ${sql.or(
                      failedLatestRuns.map((failed) =>
                        sql.and([
                          sql`thread_id = ${failed.threadId}`,
                          sql`run_id = ${failed.runId}`,
                          sql`node_id = ${failed.nodeId}`,
                        ]),
                      ),
                    )}
                  ORDER BY thread_id ASC, updated_at ASC, ordinal ASC, turn_item_id ASC
                `;
          const decodedFailures = yield* Effect.forEach(failedRootErrors, (row) =>
            decodeTurnItemJson(row.payload_json),
          );
          const failuresByThread = new Map<string, typeof decodedFailures>();
          for (const [index, row] of failedRootErrors.entries()) {
            const decoded = decodedFailures[index];
            if (decoded !== undefined && decoded.type === "error") {
              appendByThread(failuresByThread, row.thread_id, decoded);
            }
          }

          const projects = projectRows.map(projectMetadataForWire);
          const threadMetadata = threads.map((thread) => {
            const threadRuns = runsByThread.get(thread.id) ?? [];
            const threadSessions = sessionsByThread.get(thread.id) ?? [];
            const threadPlans = plansByThread.get(thread.id) ?? [];
            const defaultProviderSession = threadSessions
              .filter((session) => session.providerInstanceId === thread.providerInstanceId)
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
              )[0];
            const latestRun =
              usageLimitRunPresentedAsLatest(
                threadRuns,
                failuresByThread.get(thread.id) ?? [],
                defaultProviderSession?.lastError ?? null,
              ) ?? latestUnheldRun(threadRuns);
            const activeRun = threadRuns
              .filter(
                (run) =>
                  run.status === "preparing" ||
                  run.status === "starting" ||
                  run.status === "running",
              )
              .toSorted((left, right) => right.ordinal - left.ordinal)[0];
            return {
              ...thread,
              latestRunId: latestRun?.id ?? null,
              activeRunId: activeRun?.id ?? null,
              plans: threadPlans,
              providerSessions: threadSessions,
              messages: [],
              activities: [],
              checkpoints: [],
            };
          });

          const persistedUpdatedAt = [
            ...projectRows.map((project) => project.updatedAt),
            ...threads.map((thread) => DateTime.formatIso(thread.updatedAt)),
          ].toSorted((left, right) => dateMillis(right) - dateMillis(left))[0];
          const eventTimeRows =
            persistedUpdatedAt === undefined
              ? yield* sql<{ readonly occurred_at: string }>`
                  SELECT occurred_at
                  FROM orchestration_events
                  WHERE aggregate_kind = 'project'
                    OR (aggregate_kind = 'thread' AND application_event_version = 2)
                  ORDER BY sequence DESC
                  LIMIT 1
                `
              : [];
          const updatedAt = persistedUpdatedAt ?? eventTimeRows[0]?.occurred_at ?? null;

          return yield* decodeCliSnapshot({
            snapshotSequence,
            projects,
            threads: threadMetadata,
            updatedAt,
          });
        }),
      );
    });

    const loadThreadSnapshot = Effect.fn("http.orchestration.loadThreadSnapshot")(function* (
      threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
      failureReason:
        | "orchestration_thread_snapshot_failed"
        | "orchestration_thread_bounded_snapshot_failed"
        | "orchestration_thread_history_failed",
    ) {
      return yield* threadManagement.getThreadSnapshot(threadId).pipe(
        Effect.map((snapshot) => ({
          ...snapshot,
          projection: projectThreadProjectionForWire(snapshot.projection),
        })),
        Effect.catch(
          Effect.fnUntraced(function* (error) {
            if (isThreadNotFound(error)) {
              return yield* failEnvironmentNotFound("thread_not_found");
            }
            return yield* failEnvironmentInternal(failureReason, error);
          }),
        ),
      );
    });

    const loadThreadSnapshotWindow = Effect.fn("http.orchestration.loadThreadSnapshotWindow")(
      function* (
        threadId: Parameters<typeof threadManagement.getThreadSnapshot>[0],
        anchorItemId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorItemId"],
        anchorThreadId?: Parameters<
          typeof threadManagement.getThreadSnapshotWindow
        >[1]["anchorThreadId"],
      ) {
        return yield* threadManagement
          .getThreadSnapshotWindow(threadId, {
            rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
            userTurnLimit:
              anchorItemId === undefined
                ? THREAD_HISTORY_PAGE_POLICY.maxUserTurns
                : OLDER_THREAD_USER_TURN_LIMIT,
            ...(anchorItemId === undefined ? {} : { anchorItemId }),
            ...(anchorThreadId === undefined ? {} : { anchorThreadId }),
          })
          .pipe(
            Effect.map((snapshot) => ({
              ...snapshot,
              projection: projectThreadProjectionForWire(snapshot.projection),
            })),
            Effect.catch(
              Effect.fnUntraced(function* (error) {
                if (isThreadNotFound(error)) {
                  return yield* failEnvironmentNotFound("thread_not_found");
                }
                return yield* failEnvironmentInternal("orchestration_thread_history_failed", error);
              }),
            ),
          );
      },
    );

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadCliSnapshot().pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* dispatchCliCommand(args.payload);
        }),
      )
      .handle(
        "create",
        Effect.fn("environment.orchestration.create")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const result = yield* Effect.exit(
            createCoordinator.create(principal.sessionId, args.payload),
          );
          if (Exit.isSuccess(result)) return result.value;
          const cause = Option.getOrUndefined(Cause.findErrorOption(result.cause));
          if (isHttpCreateStateError(cause)) {
            if (cause.reason === "payload_mismatch") {
              return yield* failEnvironmentCreateConflict(cause.message);
            }
            return yield* Effect.fail(new EnvironmentHttpConflictError({ message: cause.message }));
          }
          if (isHttpCreatePlanError(cause)) {
            return yield* Effect.fail(new EnvironmentHttpConflictError({ message: cause.message }));
          }
          return yield* failEnvironmentInternal(
            "orchestration_dispatch_failed",
            cause ?? result.cause,
          );
        }),
      )
      .handle(
        "compact",
        Effect.fn("environment.orchestration.compact")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const exit = yield* Effect.exit(
            Effect.suspend(() => manualCompaction.compact(principal.sessionId, args.payload)),
          );
          if (Exit.isSuccess(exit)) return exit.value;
          return yield* compactErrorResponse(exit.cause);
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* loadShellSnapshot().pipe(
            traceLocalHandlerWork,
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshot(
            args.params.threadId,
            "orchestration_thread_snapshot_failed",
          ).pipe(traceLocalHandlerWork);
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: snapshot.projection,
          };
        }),
      )
      .handle(
        "threadBoundedSnapshot",
        Effect.fn("environment.orchestration.threadBoundedSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* loadThreadSnapshotWindow(args.params.threadId).pipe(
            traceLocalHandlerWork,
          );
          const bounded = buildBoundedThreadProjection({
            projection: snapshot.projection,
            snapshotSequence: snapshot.snapshotSequence,
          });
          return {
            snapshotSequence: snapshot.snapshotSequence,
            projection: bounded.projection,
            historyCursor: bounded.historyCursor,
            hasMoreHistory: bounded.hasMoreHistory,
            latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
            payloadBudgetExceeded: bounded.payloadBudgetExceeded,
          };
        }),
      )
      .handle(
        "threadHistoryPage",
        Effect.fn("environment.orchestration.threadHistoryPage")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          let anchorItemId;
          try {
            anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(args.query.cursor).si);
          } catch (cause) {
            if (cause instanceof InvalidThreadHistoryCursorError) {
              return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
            }
            return yield* failEnvironmentInternal("orchestration_thread_history_failed", cause);
          }
          const decodedCursor = decodeThreadHistoryCursor(args.query.cursor);
          const snapshot = yield* loadThreadSnapshotWindow(
            args.params.threadId,
            anchorItemId,
            ThreadId.make(decodedCursor.st),
          ).pipe(traceLocalHandlerWork);
          const pageOrError = selectHistoryPageFromCursorOrError({
            items: snapshot.projection.visibleTurnItems,
            cursor: args.query.cursor,
            snapshotSequence: snapshot.snapshotSequence,
          });
          if (pageOrError._tag === "invalid_cursor") {
            return yield* failEnvironmentInvalidRequest("invalid_history_cursor");
          }
          if (pageOrError._tag === "error") {
            return yield* failEnvironmentInternal(
              "orchestration_thread_history_failed",
              pageOrError.cause,
            );
          }
          return {
            snapshotSequence: snapshot.snapshotSequence,
            items: pageOrError.page.items,
            nextCursor: pageOrError.page.nextCursor,
            hasMoreHistory: pageOrError.page.hasMoreHistory,
          };
        }),
      )
      .handle(
        "pendingInteractions",
        Effect.fn("environment.orchestration.pendingInteractions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* pendingInteractions
            .list(
              args.query.threadId === undefined
                ? {}
                : { threadId: ThreadId.make(args.query.threadId) },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("pending_interactions_read_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "answerPendingInteraction",
        Effect.fn("environment.orchestration.answerPendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* pendingInteractionResponse({
            authSessionId: principal.sessionId,
            threadId: ThreadId.make(args.payload.threadId),
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: "answer",
            answers: args.payload.answers,
          });
        }),
      )
      .handle(
        "approvePendingInteraction",
        Effect.fn("environment.orchestration.approvePendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* pendingInteractionResponse({
            authSessionId: principal.sessionId,
            threadId: ThreadId.make(args.payload.threadId),
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: "approve",
          });
        }),
      )
      .handle(
        "rejectPendingInteraction",
        Effect.fn("environment.orchestration.rejectPendingInteraction")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* pendingInteractionResponse({
            authSessionId: principal.sessionId,
            threadId: ThreadId.make(args.payload.threadId),
            requestId: args.payload.requestId,
            idempotencyKey: args.payload.idempotencyKey,
            action: args.payload.decision,
          });
        }),
      );
  }),
);
