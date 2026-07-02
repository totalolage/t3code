import { ExternalLinkIcon, NetworkIcon } from "lucide-react";
import { type ReactElement } from "react";

import { cn } from "~/lib/utils";
import {
  formatWorkflowDuration,
  formatWorkflowTokens,
  isRemoteWorkflowRun,
  type WorkflowRun,
  type WorkflowRunAgent,
  workflowRunTitle,
} from "~/workflow-logic";
import { Button } from "../ui/button";
import {
  AgentRowContent,
  PhaseHeader,
  WorkflowStatusChip,
  agentRollupLabel,
  safeWorkflowSessionUrl,
} from "./workflowUi";

const MAX_CARD_AGENT_ROWS = 8;

function agentRecency(agent: WorkflowRunAgent): number {
  return agent.lastProgressAt ?? agent.startedAt ?? agent.queuedAt ?? 0;
}

/** Choose which agent indices survive the card cap: running+error first, then most recent. */
function selectVisibleAgentIndices(agents: WorkflowRunAgent[], cap: number): Set<number> {
  const prioritized = [...agents].sort((a, b) => {
    const aUrgent = a.status === "running" || a.status === "error" ? 0 : 1;
    const bUrgent = b.status === "running" || b.status === "error" ? 0 : 1;
    if (aUrgent !== bUrgent) {
      return aUrgent - bUrgent;
    }
    return agentRecency(b) - agentRecency(a);
  });
  return new Set(prioritized.slice(0, cap).map((agent) => agent.index));
}

export function WorkflowRunCard(props: {
  workflowRun: WorkflowRun;
  onOpenDetails?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
}): ReactElement {
  const { workflowRun: run, onOpenDetails, onStop } = props;
  const title = workflowRunTitle(run);
  const remote = isRemoteWorkflowRun(run);
  const tokens = run.usage?.totalTokens;
  const durationMs = run.usage?.durationMs;

  const allAgents = run.phases.flatMap((phase) => phase.agents);
  const overCap = allAgents.length > MAX_CARD_AGENT_ROWS;
  const visibleIndices = overCap ? selectVisibleAgentIndices(allAgents, MAX_CARD_AGENT_ROWS) : null;
  const hiddenCount = overCap ? allAgents.length - MAX_CARD_AGENT_ROWS : 0;

  return (
    <div className="mt-2 rounded-lg border border-border/80 bg-card/45 p-2.5">
      <div className="flex items-center gap-2">
        <NetworkIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-[13px] text-foreground">{title}</span>
        <WorkflowStatusChip status={run.status} />
        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/70 tabular-nums">
            <span>{agentRollupLabel(run.agentCounts)}</span>
            {tokens !== undefined && <span>{formatWorkflowTokens(tokens)}</span>}
            {durationMs !== undefined && <span>{formatWorkflowDuration(durationMs)}</span>}
          </div>
          {(onStop || onOpenDetails) && (
            <div className="flex items-center gap-1.5">
              {onStop && (
                <Button type="button" size="xs" variant="outline" onClick={onStop}>
                  Stop
                </Button>
              )}
              {onOpenDetails && (
                <Button type="button" size="xs" variant="outline" onClick={onOpenDetails}>
                  Details
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {remote ? (
        <RemoteRunBody run={run} />
      ) : allAgents.length > 0 ? (
        <div className="mt-1 space-y-px">
          {run.phases.map((phase) => {
            const rows = phase.agents.filter(
              (agent) => visibleIndices === null || visibleIndices.has(agent.index),
            );
            if (rows.length === 0) {
              return null;
            }
            return (
              <div key={`${run.taskId}:${phase.index}`}>
                <PhaseHeader phase={phase} />
                {rows.map((agent) => (
                  <div key={`${run.taskId}:${agent.index}`} className="px-0.5 py-0.5">
                    <AgentRowContent agent={agent} />
                  </div>
                ))}
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <button
              type="button"
              disabled={onOpenDetails === undefined}
              onClick={onOpenDetails}
              className={cn(
                "w-full px-0.5 py-0.5 text-left text-[12px] text-muted-foreground/60 leading-5",
                onOpenDetails &&
                  "cursor-pointer rounded-md hover:bg-accent/20 hover:text-muted-foreground",
              )}
            >
              +{hiddenCount} more agents — open details
            </button>
          )}
        </div>
      ) : null}

      {run.handles?.warning !== undefined && (
        <p className="mt-1.5 text-[11px] text-warning">{run.handles.warning}</p>
      )}
    </div>
  );
}

function RemoteRunBody({ run }: { run: WorkflowRun }): ReactElement {
  const sessionUrl = safeWorkflowSessionUrl(run.handles?.sessionUrl);
  if (sessionUrl === undefined) {
    return (
      <p className="mt-1.5 px-0.5 text-[12px] text-muted-foreground/70 leading-5">
        Running in the cloud
      </p>
    );
  }
  return (
    <a
      href={sessionUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1.5 flex items-center gap-1.5 rounded-md px-0.5 py-0.5 text-[12px] text-foreground/82 leading-5 hover:bg-accent/20 hover:text-foreground"
    >
      <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
      Running in the cloud — open session
    </a>
  );
}
