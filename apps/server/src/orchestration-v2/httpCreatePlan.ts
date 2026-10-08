import {
  AuthSessionId,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  OrchestrationCliCreateRequest,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCliCreateRequest as OrchestrationCliCreateRequestType,
} from "@t3tools/contracts";
import { bytesToHex } from "@noble/hashes/utils";
import { sha256 } from "@noble/hashes/sha2";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { ProjectRow, ProjectStoreV2 } from "./ProjectStore.ts";
import { HttpCreateLaunchPlan } from "../persistence/OrchestrationHttpCreateOperations.ts";

export type HttpCreateIdentity = {
  readonly keyHash: string;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
};

export class HttpCreatePlanError extends Schema.TaggedError<HttpCreatePlanError>()(
  "HttpCreatePlanError",
  {
    message: Schema.String,
  },
) {}

const decodeCreateRequest = Schema.decodeUnknownSync(OrchestrationCliCreateRequest);
const decodeCreateRequestEffect = Schema.decodeUnknownEffect(OrchestrationCliCreateRequest);
const decodeHttpCreateLaunchPlan = Schema.decodeUnknownEffect(HttpCreateLaunchPlan);

const sha256Utf8 = (value: string): string => bytesToHex(sha256(new TextEncoder().encode(value)));

export function getHttpCreateIdentity(
  sessionId: AuthSessionId,
  idempotencyKey: string,
): HttpCreateIdentity {
  const trimmedKey = idempotencyKey.trim();
  const keyHash = sha256Utf8(`${sessionId}\u0000${trimmedKey}`);

  return {
    keyHash,
    commandId: CommandId.make(`cli-create:${keyHash}`),
    threadId: ThreadId.make(`cli-thread:${keyHash}`),
    messageId: MessageId.make(`cli-create:${keyHash}`),
  };
}

export function getHttpCreateSemanticHash(request: OrchestrationCliCreateRequestType): string {
  const normalized = decodeCreateRequest(request);
  const payload = {
    project: normalized.project,
    message: normalized.message,
    title: normalized.title ?? null,
    branch: normalized.branch ?? null,
    baseBranch: normalized.baseBranch ?? null,
    startFromOrigin: normalized.startFromOrigin ?? true,
    runtimeMode: normalized.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: normalized.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
  };

  return sha256Utf8(JSON.stringify(payload));
}

type HttpCreatePlanResolverDependencies = {
  readonly projectStore: Pick<ProjectStoreV2["Service"], "list">;
  readonly gitWorkflow: Pick<GitWorkflowService["Service"], "listRefs" | "localStatus">;
};

const planError = (message: string): HttpCreatePlanError => new HttpCreatePlanError({ message });

const titleFromMessage = (message: string): string => {
  const firstLine = message.split(/\r\n|\n|\r/u)[0]?.trim() ?? "";
  const source = firstLine.length > 0 ? firstLine : message.trim();
  return source.slice(0, 256).trim();
};

export const makeHttpCreatePlanResolver = (deps: HttpCreatePlanResolverDependencies) => {
  const resolveLocalBaseBranch = Effect.fn("HttpCreatePlanResolver.resolveLocalBaseBranch")(
    function* (workspaceRoot: string) {
      let cursor: number | undefined;
      const seenCursors = new Set<number>();

      while (true) {
        const page = yield* deps.gitWorkflow.listRefs({
          cwd: workspaceRoot,
          refKind: "local",
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!page.isRepo) {
          return yield* planError(`Project workspace is not a repository: ${workspaceRoot}`);
        }

        const defaultRef = page.refs.find(
          (ref) => ref.isRemote !== true && ref.isDefault && ref.name.trim().length > 0,
        );
        if (defaultRef !== undefined) {
          return defaultRef.name;
        }

        if (page.nextCursor === null) {
          break;
        }
        if (seenCursors.has(page.nextCursor)) {
          return yield* planError("Git ref pagination returned a repeated cursor.");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }

      const localStatus = yield* deps.gitWorkflow.localStatus({ cwd: workspaceRoot });
      if (!localStatus.isRepo) {
        return yield* planError(`Project workspace is not a repository: ${workspaceRoot}`);
      }
      const currentBranch = localStatus.refName?.trim() ?? "";
      if (currentBranch.length === 0) {
        return yield* planError(`Project workspace has no usable local branch: ${workspaceRoot}`);
      }
      return currentBranch;
    },
  );

  const resolveProject = Effect.fn("HttpCreatePlanResolver.resolveProject")(function* (
    request: OrchestrationCliCreateRequestType,
  ) {
    const projects = yield* deps.projectStore.list({ includeDeleted: true });
    const matchesById = new Map<string, ProjectRow>();

    for (const project of projects) {
      if (
        project.deletedAt === null &&
        (project.projectId === request.project ||
          project.title === request.project ||
          project.workspaceRoot === request.project)
      ) {
        matchesById.set(project.projectId, project);
      }
    }

    const matches = [...matchesById.values()];
    if (matches.length === 0) {
      return yield* planError(`No active project matches "${request.project}".`);
    }
    if (matches.length > 1) {
      return yield* planError(`Multiple active projects match "${request.project}".`);
    }
    const project = matches[0];
    if (project === undefined) {
      return yield* planError(`No active project matches "${request.project}".`);
    }
    return project;
  });

  const resolve = Effect.fn("HttpCreatePlanResolver.resolve")(function* (
    request: OrchestrationCliCreateRequestType,
    identity: HttpCreateIdentity,
  ) {
    const normalizedRequest = yield* decodeCreateRequestEffect(request).pipe(
      Effect.mapError(() => planError("HTTP create request failed schema validation.")),
    );
    const project = yield* resolveProject(normalizedRequest);
    const baseRef =
      normalizedRequest.baseBranch ?? (yield* resolveLocalBaseBranch(project.workspaceRoot));
    const modelSelection = project.defaultModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    };
    const runtimeMode = normalizedRequest.runtimeMode ?? DEFAULT_RUNTIME_MODE;
    const interactionMode = normalizedRequest.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
    const branch = normalizedRequest.branch ?? `t3/${identity.keyHash.slice(0, 12)}`;
    const title = normalizedRequest.title ?? titleFromMessage(normalizedRequest.message);

    const plan = {
      commandId: identity.commandId,
      threadId: identity.threadId,
      messageId: identity.messageId,
      projectId: project.projectId,
      title,
      modelSelection,
      runtimeMode,
      interactionMode,
      workspaceStrategy: {
        type: "worktree" as const,
        baseRef,
        branch,
        startFromOrigin: normalizedRequest.startFromOrigin ?? true,
        runSetupScript: project.scripts.some((script) => script.runOnWorktreeCreate),
      },
      initialMessage: {
        messageId: identity.messageId,
        text: normalizedRequest.message,
        attachments: [],
      },
      createdBy: "user" as const,
      creationSource: "web" as const,
    };

    return yield* decodeHttpCreateLaunchPlan(plan).pipe(
      Effect.mapError(() =>
        planError("Resolved HTTP create launch plan failed schema validation."),
      ),
    );
  });

  return { resolve };
};
