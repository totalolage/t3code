import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

/**
 * Derivation of workflow-run view models from thread activities.
 *
 * Workflow state arrives as three activity kinds emitted by the server:
 * - `task.started` / `task.completed` — lifecycle (shared with plain tasks)
 * - `task.workflow-updated` — cumulative snapshot (phases, agents, logs),
 *   upserted under a stable activity id per task
 * - `task.workflow-meta` — run handles (script path, transcript dir, run id)
 *
 * Everything here parses `activity.payload` defensively: payloads are
 * `unknown` end-to-end and originate from an undocumented SDK surface, so a
 * malformed field must degrade to less detail, never throw.
 */

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error";

export interface WorkflowRunAgent {
  index: number;
  status: WorkflowAgentStatus;
  state: string;
  label?: string | undefined;
  phaseIndex?: number | undefined;
  phaseTitle?: string | undefined;
  agentId?: string | undefined;
  agentType?: string | undefined;
  model?: string | undefined;
  isolation?: "worktree" | "remote" | undefined;
  attempt?: number | undefined;
  queuedAt?: number | undefined;
  startedAt?: number | undefined;
  lastProgressAt?: number | undefined;
  cached?: boolean | undefined;
  remoteSessionId?: string | undefined;
  lastToolName?: string | undefined;
  lastToolSummary?: string | undefined;
  promptPreview?: string | undefined;
  resultPreview?: string | undefined;
  error?: string | undefined;
}

export interface WorkflowRunPhase {
  index: number;
  title: string;
  kind?: string | undefined;
  agents: WorkflowRunAgent[];
}

export interface WorkflowRunUsage {
  totalTokens?: number | undefined;
  toolUses?: number | undefined;
  durationMs?: number | undefined;
}

export interface WorkflowRunHandlesView {
  runId?: string | undefined;
  taskType?: string | undefined;
  scriptPath?: string | undefined;
  transcriptDir?: string | undefined;
  sessionUrl?: string | undefined;
  warning?: string | undefined;
}

export type WorkflowRunStatus = "running" | "completed" | "failed" | "stopped";

export interface WorkflowRun {
  taskId: string;
  status: WorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
  /** Monotonic per-derivation change counter — bumped on every applied
   * workflow activity so renderers can cheaply detect content changes even
   * when timestamps collide at millisecond precision. */
  revision: number;
  turnId: TurnId | null;
  name?: string | undefined;
  description?: string | undefined;
  completionSummary?: string | undefined;
  phases: WorkflowRunPhase[];
  logs: string[];
  usage?: WorkflowRunUsage | undefined;
  handles?: WorkflowRunHandlesView | undefined;
  agentCounts: {
    total: number;
    queued: number;
    running: number;
    done: number;
    error: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function deriveWorkflowAgentStatus(input: {
  state: string;
  startedAt?: number;
}): WorkflowAgentStatus {
  if (input.state === "done") {
    return "done";
  }
  if (input.state === "error") {
    return "error";
  }
  // "start" plus any state a future SDK adds: running once work has begun.
  return input.startedAt !== undefined ? "running" : "queued";
}

function parseAgentEntry(entry: Record<string, unknown>): WorkflowRunAgent | undefined {
  const index = asNumber(entry.index);
  const state = asString(entry.state);
  if (index === undefined || state === undefined) {
    return undefined;
  }
  const startedAt = asNumber(entry.startedAt);
  const isolation =
    entry.isolation === "worktree" || entry.isolation === "remote" ? entry.isolation : undefined;
  return {
    index,
    state,
    status: deriveWorkflowAgentStatus({ state, ...(startedAt !== undefined ? { startedAt } : {}) }),
    ...(asString(entry.label) !== undefined ? { label: asString(entry.label) } : {}),
    ...(asNumber(entry.phaseIndex) !== undefined ? { phaseIndex: asNumber(entry.phaseIndex) } : {}),
    ...(asString(entry.phaseTitle) !== undefined ? { phaseTitle: asString(entry.phaseTitle) } : {}),
    ...(asString(entry.agentId) !== undefined ? { agentId: asString(entry.agentId) } : {}),
    ...(asString(entry.agentType) !== undefined ? { agentType: asString(entry.agentType) } : {}),
    ...(asString(entry.model) !== undefined ? { model: asString(entry.model) } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(asNumber(entry.attempt) !== undefined ? { attempt: asNumber(entry.attempt) } : {}),
    ...(asNumber(entry.queuedAt) !== undefined ? { queuedAt: asNumber(entry.queuedAt) } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(asNumber(entry.lastProgressAt) !== undefined
      ? { lastProgressAt: asNumber(entry.lastProgressAt) }
      : {}),
    ...(entry.cached === true ? { cached: true } : {}),
    ...(asString(entry.remoteSessionId) !== undefined
      ? { remoteSessionId: asString(entry.remoteSessionId) }
      : {}),
    ...(asString(entry.lastToolName) !== undefined
      ? { lastToolName: asString(entry.lastToolName) }
      : {}),
    ...(asString(entry.lastToolSummary) !== undefined
      ? { lastToolSummary: asString(entry.lastToolSummary) }
      : {}),
    ...(asString(entry.promptPreview) !== undefined
      ? { promptPreview: asString(entry.promptPreview) }
      : {}),
    ...(asString(entry.resultPreview) !== undefined
      ? { resultPreview: asString(entry.resultPreview) }
      : {}),
    ...(asString(entry.error) !== undefined ? { error: asString(entry.error) } : {}),
  };
}

interface ParsedWorkflowProgress {
  phases: Array<{ index: number; title: string; kind?: string | undefined }>;
  agents: WorkflowRunAgent[];
  logs: string[];
}

function parseWorkflowProgress(value: unknown): ParsedWorkflowProgress {
  const parsed: ParsedWorkflowProgress = { phases: [], agents: [], logs: [] };
  if (!Array.isArray(value)) {
    return parsed;
  }
  // Later entries for the same index win: snapshots are cumulative and the
  // runner may re-emit an agent slot on retry.
  const agentsByIndex = new Map<number, WorkflowRunAgent>();
  const phasesByIndex = new Map<
    number,
    { index: number; title: string; kind?: string | undefined }
  >();
  for (const raw of value) {
    const entry = asRecord(raw);
    if (!entry) {
      continue;
    }
    switch (entry.type) {
      case "workflow_agent": {
        const agent = parseAgentEntry(entry);
        if (agent) {
          agentsByIndex.set(agent.index, agent);
        }
        break;
      }
      case "workflow_phase": {
        const index = asNumber(entry.index);
        const title = asString(entry.title);
        if (index !== undefined && title !== undefined) {
          phasesByIndex.set(index, {
            index,
            title,
            ...(asString(entry.kind) !== undefined ? { kind: asString(entry.kind) } : {}),
          });
        }
        break;
      }
      case "workflow_log": {
        const message = asString(entry.message);
        if (message !== undefined) {
          parsed.logs.push(message);
        }
        break;
      }
      default:
        break;
    }
  }
  parsed.agents = [...agentsByIndex.values()].toSorted((a, b) => a.index - b.index);
  parsed.phases = [...phasesByIndex.values()].toSorted((a, b) => a.index - b.index);
  return parsed;
}

function parseUsage(value: unknown): WorkflowRunUsage | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const totalTokens = asNumber(record.total_tokens);
  const toolUses = asNumber(record.tool_uses);
  const durationMs = asNumber(record.duration_ms);
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export function groupWorkflowAgentsByPhase(parsed: {
  phases: ReadonlyArray<{ index: number; title: string; kind?: string | undefined }>;
  agents: ReadonlyArray<WorkflowRunAgent>;
}): WorkflowRunPhase[] {
  const phases = new Map<number, WorkflowRunPhase>();
  for (const phase of parsed.phases) {
    phases.set(phase.index, { ...phase, agents: [] });
  }
  const UNPHASED = -1;
  for (const agent of parsed.agents) {
    const phaseIndex = agent.phaseIndex ?? UNPHASED;
    let phase = phases.get(phaseIndex);
    if (!phase) {
      phase = {
        index: phaseIndex,
        title: agent.phaseTitle ?? (phaseIndex === UNPHASED ? "Agents" : `Phase ${phaseIndex}`),
        agents: [],
      };
      phases.set(phaseIndex, phase);
    }
    phase.agents.push(agent);
  }
  return [...phases.values()]
    .filter(
      (phase) => phase.agents.length > 0 || parsed.phases.some((p) => p.index === phase.index),
    )
    .toSorted((a, b) => a.index - b.index);
}

type MutableWorkflowRun = WorkflowRun;

function isWorkflowTaskStartedPayload(payload: Record<string, unknown>): boolean {
  return payload.taskType === "local_workflow" || asString(payload.workflowName) !== undefined;
}

/** Task ids owned by a workflow run — used to suppress duplicate work-log rows. */
export function collectWorkflowTaskIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Set<string> {
  const taskIds = new Set<string>();
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    const taskId = payload ? asString(payload.taskId) : undefined;
    if (!taskId) {
      continue;
    }
    if (
      activity.kind === "task.workflow-updated" ||
      activity.kind === "task.workflow-meta" ||
      (activity.kind === "task.started" &&
        payload !== undefined &&
        isWorkflowTaskStartedPayload(payload))
    ) {
      taskIds.add(taskId);
    }
  }
  return taskIds;
}

/**
 * Millisecond timestamps collide, so equal-time activities are ordered by
 * provider sequence when present, then by lifecycle rank — a task.completed
 * must never be applied before the task.started that creates its run.
 */
const WORKFLOW_ACTIVITY_RANK: Record<string, number> = {
  "task.started": 0,
  "task.workflow-meta": 1,
  "task.workflow-updated": 1,
  "task.completed": 2,
};

function compareWorkflowActivityOrder(
  a: OrchestrationThreadActivity,
  b: OrchestrationThreadActivity,
): number {
  if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) {
    return byTime;
  }
  const byRank = (WORKFLOW_ACTIVITY_RANK[a.kind] ?? 1) - (WORKFLOW_ACTIVITY_RANK[b.kind] ?? 1);
  if (byRank !== 0) {
    return byRank;
  }
  return a.id.localeCompare(b.id);
}

export function deriveWorkflowRuns(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly sessionActive?: boolean | undefined },
): WorkflowRun[] {
  const ordered = [...activities].toSorted(compareWorkflowActivityOrder);
  const runs = new Map<string, MutableWorkflowRun>();

  const ensureRun = (taskId: string, activity: OrchestrationThreadActivity): MutableWorkflowRun => {
    const existing = runs.get(taskId);
    if (existing) {
      return existing;
    }
    const run: MutableWorkflowRun = {
      taskId,
      status: "running",
      createdAt: activity.createdAt,
      updatedAt: activity.createdAt,
      turnId: activity.turnId,
      revision: 0,
      phases: [],
      logs: [],
      agentCounts: { total: 0, queued: 0, running: 0, done: 0, error: 0 },
    };
    runs.set(taskId, run);
    return run;
  };

  for (const activity of ordered) {
    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }
    const taskId = asString(payload.taskId);
    if (!taskId) {
      continue;
    }

    switch (activity.kind) {
      case "task.started": {
        if (!isWorkflowTaskStartedPayload(payload) && !runs.has(taskId)) {
          break;
        }
        const run = ensureRun(taskId, activity);
        run.revision += 1;
        run.createdAt = activity.createdAt;
        run.turnId = activity.turnId;
        const name = asString(payload.workflowName);
        if (name !== undefined) {
          run.name = name;
        }
        const detail = asString(payload.detail);
        if (detail !== undefined) {
          run.description = detail;
        }
        break;
      }
      case "task.workflow-updated": {
        const run = ensureRun(taskId, activity);
        run.revision += 1;
        run.updatedAt = activity.createdAt;
        const description = asString(payload.description);
        if (description !== undefined && run.description === undefined) {
          run.description = description;
        }
        const parsed = parseWorkflowProgress(payload.workflowProgress);
        run.phases = groupWorkflowAgentsByPhase(parsed);
        run.logs = parsed.logs;
        run.agentCounts = {
          total: parsed.agents.length,
          queued: parsed.agents.filter((agent) => agent.status === "queued").length,
          running: parsed.agents.filter((agent) => agent.status === "running").length,
          done: parsed.agents.filter((agent) => agent.status === "done").length,
          error: parsed.agents.filter((agent) => agent.status === "error").length,
        };
        const usage = parseUsage(payload.usage);
        if (usage !== undefined) {
          run.usage = usage;
        }
        break;
      }
      case "task.workflow-meta": {
        const run = ensureRun(taskId, activity);
        run.revision += 1;
        run.updatedAt = activity.createdAt;
        const name = asString(payload.workflowName);
        if (name !== undefined) {
          run.name = name;
        }
        run.handles = {
          ...(asString(payload.runId) !== undefined ? { runId: asString(payload.runId) } : {}),
          ...(asString(payload.taskType) !== undefined
            ? { taskType: asString(payload.taskType) }
            : {}),
          ...(asString(payload.scriptPath) !== undefined
            ? { scriptPath: asString(payload.scriptPath) }
            : {}),
          ...(asString(payload.transcriptDir) !== undefined
            ? { transcriptDir: asString(payload.transcriptDir) }
            : {}),
          ...(asString(payload.sessionUrl) !== undefined
            ? { sessionUrl: asString(payload.sessionUrl) }
            : {}),
          ...(asString(payload.warning) !== undefined
            ? { warning: asString(payload.warning) }
            : {}),
        };
        break;
      }
      case "task.completed": {
        const run = runs.get(taskId);
        if (!run) {
          break;
        }
        run.revision += 1;
        run.updatedAt = activity.createdAt;
        run.status =
          payload.status === "failed"
            ? "failed"
            : payload.status === "stopped"
              ? "stopped"
              : "completed";
        const detail = asString(payload.detail);
        if (detail !== undefined) {
          run.completionSummary = detail;
        }
        break;
      }
      default:
        break;
    }
  }

  // A workflow cannot outlive its provider session: when the session is gone
  // and no task_notification ever arrived (crash, interrupt, app restart),
  // surface the run as stopped instead of running forever. Runs derived only
  // from snapshot/meta activities (no task.started — e.g. after a checkpoint
  // revert trimmed it) are kept intentionally: partial history still renders.
  const sessionActive = options?.sessionActive ?? true;
  return [...runs.values()]
    .map((run) =>
      run.status === "running" && !sessionActive ? terminalizeInterruptedRun(run) : run,
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
}

/**
 * Settle a run whose session died before a terminal task notification:
 * the run becomes "stopped" and its in-flight agents settle to "error" so
 * nothing keeps rendering (or polling) as live work.
 */
function terminalizeInterruptedRun(run: WorkflowRun): WorkflowRun {
  const settleAgent = (agent: WorkflowRunAgent): WorkflowRunAgent =>
    agent.status === "running" || agent.status === "queued"
      ? { ...agent, status: "error", error: agent.error ?? "Interrupted before completion" }
      : agent;
  const phases = run.phases.map((phase) => ({ ...phase, agents: phase.agents.map(settleAgent) }));
  const agents = phases.flatMap((phase) => phase.agents);
  return {
    ...run,
    status: "stopped",
    phases,
    agentCounts: {
      total: agents.length,
      queued: agents.filter((agent) => agent.status === "queued").length,
      running: agents.filter((agent) => agent.status === "running").length,
      done: agents.filter((agent) => agent.status === "done").length,
      error: agents.filter((agent) => agent.status === "error").length,
    },
  };
}

export function isRemoteWorkflowRun(run: WorkflowRun): boolean {
  return run.handles?.taskType === "remote_agent" || run.handles?.sessionUrl !== undefined;
}

export function workflowRunTitle(run: WorkflowRun): string {
  return run.name ?? run.description ?? "Workflow";
}

export function formatWorkflowDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function formatWorkflowTokens(totalTokens: number): string {
  if (totalTokens < 1000) {
    return `${totalTokens}`;
  }
  if (totalTokens < 1_000_000) {
    return `${(totalTokens / 1000).toFixed(totalTokens < 10_000 ? 1 : 0)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}
