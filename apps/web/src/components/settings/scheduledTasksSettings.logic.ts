import {
  EnvironmentId,
  type ProjectId,
  ScheduledTaskId,
  type ScheduledTask,
  MAX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  type ScheduledTaskUpsertSchedule,
  type ScheduledTaskWebhookSignature,
  type ModelSelection,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ServerSettings,
} from "@t3tools/contracts";
import { parseMaxDeliveryAge } from "@t3tools/client-runtime/scheduled-task-webhook";

import {
  resolveProjectSettings,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";

import type { ResolvedSettingsScope } from "./settingsScope";

/** Project IDs belong to an environment, including when a grouped project spans machines. */
export function matchesScheduledTaskScope(
  scope: ResolvedSettingsScope,
  environmentId: EnvironmentId,
  projectId: ProjectId,
): boolean {
  if (scope.kind === "unavailable" || !scope.environmentIds.includes(environmentId)) return false;
  if (scope.kind === "project" || scope.kind === "checkout") {
    return scope.members.some(
      (member) => member.environmentId === environmentId && member.id === projectId,
    );
  }
  return true;
}

export function validateScheduledTasksSearch(raw: Record<string, unknown>) {
  return {
    ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.taskId === "string" && raw.taskId.trim()
      ? { taskId: ScheduledTaskId.make(raw.taskId) }
      : {}),
  };
}

export type ScheduleMode = "fixed" | "interval" | "webhook";
export type WorkspaceMode = "root" | "worktree" | "existing_worktree";
export type DeliveryIdMode = "off" | "header" | "body";

export interface DraftState {
  readonly editingId: string | null;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: boolean;
  readonly scheduleMode: ScheduleMode;
  readonly intervalMinutes: string;
  readonly timeOfDay: string;
  readonly weekdays: ReadonlySet<number>;
  readonly projectId: string;
  readonly threadId: string;
  readonly workspaceMode: WorkspaceMode;
  readonly baseRef: string;
  readonly startFromOrigin: boolean;
  readonly existingWorktreePath: string;
  readonly modelKey: string;
  /** Not editable in the dialog, but preserved so editing an agent-created task keeps its modes. */
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  /**
   * The task's original model selection. The picker only edits
   * `instanceId:model`; keeping the source object preserves provider options
   * (reasoning, temperature, …) when the model itself is left unchanged.
   */
  readonly baseModelSelection: ModelSelection | null;
  readonly signatureEnabled: boolean;
  readonly signatureScheme: ScheduledTaskWebhookSignature["scheme"];
  /** Header, encoding and prefix apply to the HMAC scheme only. */
  readonly signatureHeader: string;
  readonly signatureEncoding: "hex" | "base64";
  readonly signaturePrefix: string;
  /** Write-only: empty keeps the secret already stored on the server. */
  readonly signatureSecret: string;
  /** Minutes as typed; empty runs every held request regardless of age. */
  readonly maxDeliveryAgeMinutes: string;
  /** Where the sender puts its delivery id; a repeated id does not run again. */
  readonly deliveryIdMode: DeliveryIdMode;
  readonly deliveryIdHeader: string;
  readonly deliveryIdPath: string;
  /** Body path of the sender's send time; empty turns the freshness check off. */
  readonly deliveryTimestampPath: string;
  readonly deliveryTimestampToleranceSeconds: string;
}

/** GitHub's signature settings, the most common sender. */
export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureScheme: "hmac_sha256",
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

/** Replay protection starts off; GitHub's delivery header is the most common id. */
export const WEBHOOK_REPLAY_DEFAULTS = {
  deliveryIdMode: "off",
  deliveryIdHeader: "x-github-delivery",
  deliveryIdPath: "",
  deliveryTimestampPath: "",
  deliveryTimestampToleranceSeconds: "300",
} as const;

/** Standard Webhooks signs its `webhook-id`; other senders default to GitHub's header. */
export function defaultDeliveryIdHeader(draft: DraftState): string {
  return draft.signatureEnabled && draft.signatureScheme === "standard_webhooks"
    ? "webhook-id"
    : WEBHOOK_REPLAY_DEFAULTS.deliveryIdHeader;
}

/**
 * Switches where the delivery id comes from. Choosing a header fills in the
 * signature scheme's usual one unless the user already typed their own.
 */
export function withDeliveryIdMode(draft: DraftState, value: string | null): DraftState {
  const deliveryIdMode: DeliveryIdMode = value === "header" || value === "body" ? value : "off";
  const untouched = ["", WEBHOOK_REPLAY_DEFAULTS.deliveryIdHeader, "webhook-id"].includes(
    draft.deliveryIdHeader.trim(),
  );
  return {
    ...draft,
    deliveryIdMode,
    ...(deliveryIdMode === "header" && untouched
      ? { deliveryIdHeader: defaultDeliveryIdHeader(draft) }
      : {}),
  };
}

function parseTimestampTolerance(value: string): number | undefined {
  const seconds = Number(value.trim());
  return value.trim() !== "" &&
    Number.isInteger(seconds) &&
    seconds > 0 &&
    seconds <= MAX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    ? seconds
    : undefined;
}

/** Why the draft's replay settings cannot be saved, or null when they can. */
export function webhookReplayDraftProblem(draft: DraftState): string | null {
  if (draft.scheduleMode !== "webhook") return null;
  if (draft.deliveryIdMode === "header" && !draft.deliveryIdHeader.trim()) {
    return "Enter the header that carries the delivery id.";
  }
  if (draft.deliveryIdMode === "body" && !draft.deliveryIdPath.trim()) {
    return "Enter the body field that carries the delivery id.";
  }
  if (
    draft.deliveryTimestampPath.trim() &&
    parseTimestampTolerance(draft.deliveryTimestampToleranceSeconds) === undefined
  ) {
    return `Enter a tolerance of whole seconds from 1 to ${MAX_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS}.`;
  }
  return null;
}

/**
 * Null when the draft's webhook age limit or replay settings are invalid; the
 * caller reports them and does not save. Replay settings are always sent,
 * null when off, because the server keeps stored ones on omission.
 */
export function scheduleFromDraft(draft: DraftState): ScheduledTaskUpsertSchedule | null {
  if (draft.scheduleMode === "webhook") {
    const maxDeliveryAgeMinutes = parseMaxDeliveryAge(draft.maxDeliveryAgeMinutes);
    if (maxDeliveryAgeMinutes === undefined || webhookReplayDraftProblem(draft) !== null) {
      return null;
    }
    const timestampPath = draft.deliveryTimestampPath.trim();
    const toleranceSeconds = parseTimestampTolerance(draft.deliveryTimestampToleranceSeconds);
    const secret = draft.signatureSecret.trim();
    return {
      type: "webhook",
      signature: !draft.signatureEnabled
        ? null
        : draft.signatureScheme === "standard_webhooks"
          ? { scheme: "standard_webhooks", ...(secret ? { secret } : {}) }
          : {
              scheme: "hmac_sha256",
              header: draft.signatureHeader.trim(),
              encoding: draft.signatureEncoding,
              prefix: draft.signaturePrefix,
              ...(secret ? { secret } : {}),
            },
      maxDeliveryAgeMinutes,
      deliveryId:
        draft.deliveryIdMode === "header"
          ? { type: "header", name: draft.deliveryIdHeader.trim().toLowerCase() }
          : draft.deliveryIdMode === "body"
            ? { type: "body", path: draft.deliveryIdPath.trim() }
            : null,
      deliveryTimestamp:
        timestampPath && toleranceSeconds !== undefined
          ? { path: timestampPath, toleranceSeconds }
          : null,
    };
  }
  if (draft.scheduleMode === "interval") {
    const everyMs = Math.round(Number(draft.intervalMinutes) * 60_000);
    return { type: "interval", everyMs };
  }
  const selectedEveryDay = draft.weekdays.size === 0 || draft.weekdays.size === 7;
  return {
    type: "fixed_time",
    timeOfDay: draft.timeOfDay || "09:00",
    ...(selectedEveryDay ? {} : { weekdays: [...draft.weekdays].toSorted() }),
  };
}

export function taskToDraft(task: ScheduledTask): DraftState {
  const schedule = task.schedule;
  const weekdays =
    schedule.type === "fixed_time" && schedule.weekdays && schedule.weekdays.length > 0
      ? new Set(schedule.weekdays)
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  return {
    editingId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    scheduleMode:
      schedule.type === "interval" ? "interval" : schedule.type === "webhook" ? "webhook" : "fixed",
    intervalMinutes:
      schedule.type === "interval" ? String(Math.max(1, schedule.everyMs / 60_000)) : "15",
    timeOfDay: schedule.type === "fixed_time" ? schedule.timeOfDay : "09:00",
    weekdays,
    projectId: task.projectId,
    threadId: task.threadId ?? "",
    workspaceMode: task.workspaceStrategy.type,
    baseRef: task.workspaceStrategy.type === "worktree" ? task.workspaceStrategy.baseRef : "main",
    startFromOrigin:
      task.workspaceStrategy.type === "worktree"
        ? (task.workspaceStrategy.startFromOrigin ?? false)
        : true,
    existingWorktreePath:
      task.workspaceStrategy.type === "existing_worktree"
        ? task.workspaceStrategy.worktreePath
        : "",
    modelKey: `${task.modelSelection.instanceId}:${task.modelSelection.model}`,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
    baseModelSelection: task.modelSelection,
    ...(schedule.type !== "webhook" || schedule.signature === null
      ? { signatureEnabled: false, ...WEBHOOK_SIGNATURE_DEFAULTS }
      : schedule.signature.scheme === "standard_webhooks"
        ? {
            ...WEBHOOK_SIGNATURE_DEFAULTS,
            signatureEnabled: true,
            signatureScheme: "standard_webhooks",
          }
        : {
            signatureEnabled: true,
            signatureScheme: "hmac_sha256",
            signatureHeader: schedule.signature.header,
            signatureEncoding: schedule.signature.encoding,
            signaturePrefix: schedule.signature.prefix,
          }),
    signatureSecret: "",
    maxDeliveryAgeMinutes:
      schedule.type === "webhook" && schedule.maxDeliveryAgeMinutes != null
        ? String(schedule.maxDeliveryAgeMinutes)
        : "",
    ...WEBHOOK_REPLAY_DEFAULTS,
    ...(schedule.type === "webhook" && schedule.deliveryId
      ? schedule.deliveryId.type === "header"
        ? { deliveryIdMode: "header", deliveryIdHeader: schedule.deliveryId.name }
        : { deliveryIdMode: "body", deliveryIdPath: schedule.deliveryId.path }
      : {}),
    ...(schedule.type === "webhook" && schedule.deliveryTimestamp
      ? {
          deliveryTimestampPath: schedule.deliveryTimestamp.path,
          deliveryTimestampToleranceSeconds: String(schedule.deliveryTimestamp.toleranceSeconds),
        }
      : {}),
  };
}

/** Use configured defaults before the catalog's advertised default model. */
export function scheduledTaskDefaultModel(
  settings: ServerSettings,
  project: (LegacyProjectSettingsFields & { readonly id: ProjectId }) | null,
  entries: readonly ProviderInstanceEntry[],
): ModelSelection | null {
  const available = entries.filter(
    (entry) =>
      entry.enabled &&
      entry.installed &&
      entry.isAvailable &&
      entry.snapshot.auth.status !== "unauthenticated",
  );
  const configured = resolveProjectSettings(settings, project?.id ?? null, project).settings
    .defaultModelSelection;
  for (const selection of [configured, settings.defaultModelSelection]) {
    if (
      selection &&
      available.some(
        (entry) =>
          entry.instanceId === selection.instanceId &&
          entry.models.find((model) => model.slug === selection.model)?.isLegacy !== true,
      )
    )
      return selection;
  }
  const models = available.flatMap((entry) =>
    entry.models
      .filter((model) => !model.isLegacy)
      .map((model) => ({ instanceId: entry.instanceId, model })),
  );
  const fallback = models.find(({ model }) => model.isDefault) ?? models[0];
  return fallback ? { instanceId: fallback.instanceId, model: fallback.model.slug } : null;
}
