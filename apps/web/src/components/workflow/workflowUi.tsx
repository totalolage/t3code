import type { ReactElement, ReactNode } from "react";

import { cn } from "~/lib/utils";
import type {
  WorkflowAgentStatus,
  WorkflowRun,
  WorkflowRunAgent,
  WorkflowRunPhase,
  WorkflowRunStatus,
} from "~/workflow-logic";

// ---------------------------------------------------------------------------
// Run-level status chip
// ---------------------------------------------------------------------------

interface RunStatusVisual {
  label: string;
  dotClass: string;
  textClass: string;
  pulse: boolean;
}

const RUN_STATUS_VISUALS: Record<WorkflowRunStatus, RunStatusVisual> = {
  running: { label: "Running", dotClass: "bg-info", textClass: "text-info", pulse: true },
  completed: {
    label: "Completed",
    dotClass: "bg-success",
    textClass: "text-success",
    pulse: false,
  },
  failed: {
    label: "Failed",
    dotClass: "bg-destructive",
    textClass: "text-destructive",
    pulse: false,
  },
  stopped: {
    label: "Stopped",
    dotClass: "bg-muted-foreground",
    textClass: "text-muted-foreground",
    pulse: false,
  },
};

export function WorkflowStatusChip({ status }: { status: WorkflowRunStatus }): ReactElement {
  const visual = RUN_STATUS_VISUALS[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 font-medium text-[11px]",
        visual.textClass,
      )}
    >
      <span className="relative flex size-1.5">
        {visual.pulse && (
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full opacity-60",
              visual.dotClass,
            )}
          />
        )}
        <span className={cn("relative inline-flex size-1.5 rounded-full", visual.dotClass)} />
      </span>
      {visual.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Agent-level presentation
// ---------------------------------------------------------------------------

const AGENT_STATUS_DOT: Record<WorkflowAgentStatus, string> = {
  queued: "bg-muted-foreground/50",
  running: "bg-info animate-pulse",
  done: "bg-success",
  error: "bg-destructive",
};

export function AgentStatusDot({ status }: { status: WorkflowAgentStatus }): ReactElement {
  return <span className={cn("size-1.5 shrink-0 rounded-full", AGENT_STATUS_DOT[status])} />;
}

export function agentDisplayLabel(agent: WorkflowRunAgent): string {
  return agent.label ?? agent.agentType ?? `agent ${agent.index}`;
}

export function agentPreviewText(agent: WorkflowRunAgent): string | undefined {
  switch (agent.status) {
    case "error":
      return agent.error ?? agent.resultPreview;
    case "done":
      return agent.resultPreview;
    case "running":
      return agent.lastToolSummary ?? agent.promptPreview;
    default:
      return agent.promptPreview;
  }
}

function AgentMetaBadges({ agent }: { agent: WorkflowRunAgent }): ReactElement | null {
  const badges: string[] = [];
  if (agent.cached) {
    badges.push("cached");
  }
  if (agent.attempt !== undefined && agent.attempt > 1) {
    badges.push(`retry ${agent.attempt}`);
  }
  if (badges.length === 0) {
    return null;
  }
  return (
    <>
      {badges.map((badge) => (
        <span
          key={badge}
          className="shrink-0 rounded-sm bg-muted px-1 text-[10px] text-muted-foreground/80 leading-4"
        >
          {badge}
        </span>
      ))}
    </>
  );
}

/** The shared inner content of an agent row: dot, label, badges, dimmed preview. */
export function AgentRowContent({
  agent,
  leading,
}: {
  agent: WorkflowRunAgent;
  leading?: ReactNode;
}): ReactElement {
  const preview = agentPreviewText(agent);
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5">
      {leading}
      <AgentStatusDot status={agent.status} />
      <span
        className={cn(
          "shrink-0 truncate font-medium",
          agent.status === "error" ? "text-destructive" : "text-foreground/82",
        )}
      >
        {agentDisplayLabel(agent)}
      </span>
      <AgentMetaBadges agent={agent} />
      {preview !== undefined && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70">{preview}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase header + rollup helpers
// ---------------------------------------------------------------------------

/**
 * Only web URLs may reach an anchor href. The server already filters the
 * scheme at ingestion; this guards payloads persisted before that filter
 * (and any other producer) as defense in depth.
 */
export function safeWorkflowSessionUrl(sessionUrl: string | undefined): string | undefined {
  if (sessionUrl === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(sessionUrl);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? sessionUrl : undefined;
  } catch {
    return undefined;
  }
}

/** Settled agents (done or error) — the x/y header is a progress counter,
 * and an errored agent has no work remaining. */
export function phaseDoneCount(phase: WorkflowRunPhase): number {
  return phase.agents.filter((agent) => agent.status === "done" || agent.status === "error").length;
}

export function PhaseHeader({ phase }: { phase: WorkflowRunPhase }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-2 px-0.5 pt-1.5 pb-0.5">
      <span className="truncate text-[10px] text-muted-foreground/65 uppercase tracking-[0.12em]">
        {phase.title}
      </span>
      {phase.agents.length > 0 && (
        <span className="shrink-0 text-[10px] text-muted-foreground/55 tabular-nums">
          {phaseDoneCount(phase)}/{phase.agents.length}
        </span>
      )}
    </div>
  );
}

export function agentRollupLabel(counts: WorkflowRun["agentCounts"]): string {
  return `${counts.done + counts.error}/${counts.total} agents`;
}
