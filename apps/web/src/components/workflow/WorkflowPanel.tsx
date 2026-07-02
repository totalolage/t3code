import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, CopyIcon, ExternalLinkIcon, NetworkIcon } from "lucide-react";
import {
  Component,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTheme } from "~/hooks/useTheme";
import { type DiffThemeName, resolveDiffThemeName } from "~/lib/diffRendering";
import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { workflowEnvironment } from "~/state/workflow";
import {
  isRemoteWorkflowRun,
  type WorkflowRun,
  type WorkflowRunAgent,
  type WorkflowRunStatus,
  workflowRunTitle,
} from "~/workflow-logic";
import { Button } from "../ui/button";
import {
  AgentRowContent,
  PhaseHeader,
  WorkflowStatusChip,
  safeWorkflowSessionUrl,
} from "./workflowUi";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";

type WorkflowTabId = "run" | "script" | "logs";

const WORKFLOW_TABS: ReadonlyArray<{ id: WorkflowTabId; label: string }> = [
  { id: "run", label: "Run" },
  { id: "script", label: "Script" },
  { id: "logs", label: "Logs" },
];

// ---------------------------------------------------------------------------
// Root — handles the not-found empty state, then delegates to the inner panel
// so every data hook runs unconditionally.
// ---------------------------------------------------------------------------

export function WorkflowPanel(props: {
  workflowRun: WorkflowRun | null;
  environmentId: EnvironmentId;
  onStop?: (() => void) | undefined;
}): ReactElement {
  if (props.workflowRun === null) {
    return (
      <div className="flex h-full min-w-0 items-center justify-center p-6 text-muted-foreground text-sm">
        Workflow not found
      </div>
    );
  }
  return (
    <WorkflowPanelInner
      run={props.workflowRun}
      environmentId={props.environmentId}
      onStop={props.onStop}
    />
  );
}

function WorkflowPanelInner({
  run,
  environmentId,
  onStop,
}: {
  run: WorkflowRun;
  environmentId: EnvironmentId;
  onStop?: (() => void) | undefined;
}): ReactElement {
  const [tab, setTab] = useState<WorkflowTabId>("run");
  const { resolvedTheme } = useTheme();
  const themeName = resolveDiffThemeName(resolvedTheme);

  const scriptPath = run.handles?.scriptPath;
  const transcriptDir = run.handles?.transcriptDir;
  const remote = isRemoteWorkflowRun(run);
  const isTerminal = run.status !== "running";

  const scriptQuery = useEnvironmentQuery(
    tab === "script" && scriptPath !== undefined
      ? workflowEnvironment.readScript({ environmentId, input: { scriptPath } })
      : null,
  );
  const journalQuery = useEnvironmentQuery(
    tab === "logs" && transcriptDir !== undefined
      ? workflowEnvironment.readJournal({ environmentId, input: { transcriptDir } })
      : null,
  );

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-border/60 border-b px-3 py-2">
        <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium text-foreground text-sm">
          {workflowRunTitle(run)}
        </span>
        <WorkflowStatusChip status={run.status} />
        <div className="ml-auto flex items-center gap-1.5">
          {isTerminal && run.handles?.runId !== undefined && scriptPath !== undefined && (
            <CopyResumeButton scriptPath={scriptPath} runId={run.handles.runId} />
          )}
          {onStop && (
            <Button type="button" size="xs" variant="outline" onClick={onStop}>
              Stop
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 border-border/60 border-b px-2 py-1.5">
        {WORKFLOW_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-active-tab={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={cn(
              "flex h-7 items-center rounded-md px-2.5 text-sm transition-colors",
              tab === entry.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === "run" && (
          <RunTab
            run={run}
            environmentId={environmentId}
            transcriptDir={transcriptDir}
            remote={remote}
          />
        )}
        {tab === "script" && (
          <ScriptTab scriptPath={scriptPath} query={scriptQuery} themeName={themeName} />
        )}
        {tab === "logs" && (
          <LogsTab logs={run.logs} transcriptDir={transcriptDir} query={journalQuery} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header copy button
// ---------------------------------------------------------------------------

function CopyResumeButton({
  scriptPath,
  runId,
}: {
  scriptPath: string;
  runId: string;
}): ReactElement {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1200,
    target: "workflow resume command",
  });

  const handleCopy = useCallback(() => {
    copyToClipboard(`Workflow({ scriptPath: "${scriptPath}", resumeFromRunId: "${runId}" })`);
  }, [copyToClipboard, runId, scriptPath]);

  return (
    <Button type="button" size="xs" variant="outline" onClick={handleCopy}>
      {isCopied ? <CheckIcon /> : <CopyIcon />}
      Copy resume command
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Run tab
// ---------------------------------------------------------------------------

function RunTab({
  run,
  environmentId,
  transcriptDir,
  remote,
}: {
  run: WorkflowRun;
  environmentId: EnvironmentId;
  transcriptDir: string | undefined;
  remote: boolean;
}): ReactElement {
  if (remote) {
    const sessionUrl = safeWorkflowSessionUrl(run.handles?.sessionUrl);
    if (sessionUrl === undefined) {
      return <MutedBody text="Running in the cloud" />;
    }
    return (
      <a
        href={sessionUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1.5 rounded-md px-0.5 py-1 text-[12px] text-foreground/82 leading-5 hover:bg-accent/20 hover:text-foreground"
      >
        <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
        Running in the cloud — open session
      </a>
    );
  }

  if (run.phases.length === 0) {
    return <MutedBody text="No agents yet" />;
  }

  return (
    <div className="space-y-px">
      {run.phases.map((phase) => (
        <div key={`${run.taskId}:${phase.index}`}>
          <PhaseHeader phase={phase} />
          {phase.agents.map((agent) => (
            <ExpandableAgentRow
              key={`${run.taskId}:${agent.index}`}
              agent={agent}
              environmentId={environmentId}
              transcriptDir={transcriptDir}
              runStatus={run.status}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

const stopPropagation = (event: ReactMouseEvent) => event.stopPropagation();

function ExpandableAgentRow({
  agent,
  environmentId,
  transcriptDir,
  runStatus,
}: {
  agent: WorkflowRunAgent;
  environmentId: EnvironmentId;
  transcriptDir: string | undefined;
  runStatus: WorkflowRunStatus;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const agentId = agent.agentId;
  const canExpand =
    agentId !== undefined && transcriptDir !== undefined && agent.isolation !== "remote";

  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    },
    [toggle],
  );

  const leading = canExpand ? (
    <ChevronRightIcon
      className={cn(
        "size-3 shrink-0 text-muted-foreground/60 transition-transform",
        expanded && "rotate-90",
      )}
    />
  ) : (
    <span className="size-3 shrink-0" />
  );

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-inset",
      )}
      {...(canExpand
        ? { role: "button", tabIndex: 0, "aria-expanded": expanded, onClick: toggle, onKeyDown }
        : {})}
    >
      <AgentRowContent agent={agent} leading={leading} />
      {canExpand && expanded && agentId !== undefined && transcriptDir !== undefined && (
        <AgentTranscriptView
          environmentId={environmentId}
          transcriptDir={transcriptDir}
          agentId={agentId}
          runStatus={runStatus}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transcript view (cursor-paged, polled while running)
// ---------------------------------------------------------------------------

function extractAssistantText(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const message =
    typeof record.message === "object" && record.message !== null
      ? (record.message as Record<string, unknown>)
      : record;
  const role = record.type ?? message.role;
  if (role !== "assistant") {
    return null;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const record2 = block as Record<string, unknown>;
        if (record2.type === "text" && typeof record2.text === "string") {
          parts.push(record2.text);
        }
      }
    }
    if (parts.length > 0) {
      return parts.join("\n");
    }
  }
  return null;
}

function renderTranscriptLine(raw: string): { text: string; dim: boolean } {
  try {
    const parsed: unknown = JSON.parse(raw);
    const text = extractAssistantText(parsed);
    if (text !== null && text.trim().length > 0) {
      return { text, dim: false };
    }
    const type =
      typeof parsed === "object" && parsed !== null && "type" in parsed
        ? String((parsed as { type: unknown }).type)
        : "event";
    return { text: type, dim: true };
  } catch {
    return { text: raw, dim: true };
  }
}

function AgentTranscriptView({
  environmentId,
  transcriptDir,
  agentId,
  runStatus,
}: {
  environmentId: EnvironmentId;
  transcriptDir: string;
  agentId: string;
  runStatus: WorkflowRunStatus;
}): ReactElement {
  const runTranscript = useAtomCommand(
    workflowEnvironment.readAgentTranscript,
    "workflow read transcript",
  );
  const [lines, setLines] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const nextLineRef = useRef(0);
  const completeRef = useRef(false);
  const loadingRef = useRef(false);

  const loadMore = useCallback(async () => {
    // `complete` only means the last read caught up to end-of-file; a live
    // run keeps appending, so polling must keep re-reading past prior EOF.
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    const result = await runTranscript({
      environmentId,
      input: { transcriptDir, agentId, afterLine: nextLineRef.current },
    });
    loadingRef.current = false;
    setLoading(false);
    if (result._tag !== "Success") {
      setFailed(true);
      return;
    }
    setFailed(false);
    nextLineRef.current = result.value.nextLine;
    completeRef.current = result.value.complete;
    if (result.value.lines.length > 0) {
      setLines((prev) => [...prev, ...result.value.lines]);
    }
  }, [agentId, environmentId, runTranscript, transcriptDir]);

  // Drain all currently-available pages when the row opens.
  useEffect(() => {
    const control = { cancelled: false };
    const drain = async () => {
      while (!control.cancelled && !completeRef.current) {
        const before = nextLineRef.current;
        await loadMore();
        if (control.cancelled || nextLineRef.current === before) {
          break;
        }
      }
    };
    void drain();
    return () => {
      control.cancelled = true;
    };
  }, [loadMore]);

  // Keep polling for new lines while the run is live; when the run settles
  // (or the row opens on an already-terminal run), fetch once more so lines
  // appended after the last poll tick are not lost.
  useEffect(() => {
    if (runStatus !== "running") {
      void loadMore();
      return;
    }
    const id = setInterval(() => {
      void loadMore();
    }, 2000);
    return () => clearInterval(id);
  }, [loadMore, runStatus]);

  return (
    <div
      className="mt-1 ml-4 max-h-72 overflow-y-auto rounded-md border border-border/60 bg-muted/30 p-1.5 font-mono text-[11px] leading-4"
      onClick={stopPropagation}
    >
      {lines.length === 0 ? (
        failed ? (
          <p className="text-destructive/80">Failed to load transcript.</p>
        ) : loading ? (
          <p className="text-muted-foreground/60">Loading transcript…</p>
        ) : (
          <p className="text-muted-foreground/60">No transcript output.</p>
        )
      ) : (
        lines.map((line, index) => {
          const parsed = renderTranscriptLine(line);
          return (
            <div
              // Lines are append-only and never reordered, so the index is stable.
              // oxlint-disable-next-line no-array-index-key
              key={`${index}:${line.length}`}
              className={cn(
                "whitespace-pre-wrap break-words",
                parsed.dim && "text-muted-foreground/55",
              )}
            >
              {parsed.text}
            </div>
          );
        })
      )}
      {failed && lines.length > 0 && (
        <p className="text-destructive/70">Failed to load more transcript.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Script tab
// ---------------------------------------------------------------------------

let cachedScriptHighlighter: Promise<DiffsHighlighter> | undefined;

function getScriptHighlighter(): Promise<DiffsHighlighter> {
  cachedScriptHighlighter ??= getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: ["javascript" as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  });
  return cachedScriptHighlighter;
}

class WorkflowCodeErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function ScriptHighlight({
  source,
  themeName,
}: {
  source: string;
  themeName: DiffThemeName;
}): ReactElement {
  const highlighter = use(getScriptHighlighter());
  const html = useMemo(
    () => highlighter.codeToHtml(source, { lang: "javascript", theme: themeName }),
    [highlighter, source, themeName],
  );
  return (
    <div
      className="chat-markdown-shiki overflow-x-auto text-[12px]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function ScriptTab({
  scriptPath,
  query,
  themeName,
}: {
  scriptPath: string | undefined;
  query: {
    data: { source: string; truncated: boolean } | null;
    error: string | null;
    isPending: boolean;
  };
  themeName: DiffThemeName;
}): ReactElement {
  if (scriptPath === undefined) {
    return <MutedBody text="No script for this run." />;
  }
  if (query.error !== null) {
    return <p className="text-[12px] text-destructive/80">{query.error}</p>;
  }
  if (query.data === null) {
    return <MutedBody text={query.isPending ? "Loading script…" : "No script."} />;
  }
  const { source, truncated } = query.data;
  const fallback = (
    <pre className="overflow-x-auto rounded-md bg-muted/30 p-2 font-mono text-[12px] leading-5">
      {source}
    </pre>
  );
  return (
    <div>
      {truncated && (
        <p className="mb-1.5 text-[11px] text-warning">Script truncated for display.</p>
      )}
      <WorkflowCodeErrorBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <ScriptHighlight source={source} themeName={themeName} />
        </Suspense>
      </WorkflowCodeErrorBoundary>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------------

interface JournalEntry {
  agentId: string;
  hasResult: boolean;
  resultJson?: string | undefined;
  resultTruncated?: boolean | undefined;
}

function LogsTab({
  logs,
  transcriptDir,
  query,
}: {
  logs: string[];
  transcriptDir: string | undefined;
  query: {
    data: { entries: readonly JournalEntry[]; truncated: boolean } | null;
    error: string | null;
    isPending: boolean;
  };
}): ReactElement {
  return (
    <div className="space-y-3">
      {logs.length === 0 ? (
        <MutedBody text="No logs." />
      ) : (
        <div className="space-y-px font-mono text-[11px] text-muted-foreground/70 leading-4">
          {logs.map((log, index) => (
            // oxlint-disable-next-line no-array-index-key -- logs are append-only, index is stable
            <div key={`${index}:${log.length}`} className="whitespace-pre-wrap break-words">
              {log}
            </div>
          ))}
        </div>
      )}

      {transcriptDir !== undefined && (
        <div>
          <p className="mb-1 text-[10px] text-muted-foreground/65 uppercase tracking-[0.12em]">
            Results
          </p>
          {query.error !== null ? (
            <p className="text-[12px] text-destructive/80">{query.error}</p>
          ) : query.data === null ? (
            query.isPending ? (
              <MutedBody text="Loading results…" />
            ) : null
          ) : query.data.entries.length === 0 ? (
            <MutedBody text="No results yet." />
          ) : (
            <div className="space-y-px">
              {query.data.entries.map((entry) => (
                <JournalResultRow key={entry.agentId} entry={entry} />
              ))}
            </div>
          )}
          {query.data?.truncated && (
            <p className="mt-1 text-[11px] text-muted-foreground/55">Results truncated.</p>
          )}
        </div>
      )}
    </div>
  );
}

function JournalResultRow({ entry }: { entry: JournalEntry }): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const resultJson = entry.resultJson;
  return (
    <div className="rounded-md px-0.5 py-0.5">
      <div className="flex items-center gap-1.5 text-[12px] leading-5">
        <span className="shrink-0 truncate font-medium text-foreground/82">{entry.agentId}</span>
        {!entry.hasResult && <span className="text-[11px] text-muted-foreground/55">pending</span>}
      </div>
      {resultJson !== undefined &&
        (expanded ? (
          <div
            className="mt-1 cursor-pointer"
            role="button"
            tabIndex={0}
            onClick={() => setExpanded(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpanded(false);
              }
            }}
          >
            <pre className="max-h-64 overflow-auto rounded-md bg-muted/30 p-1.5 font-mono text-[11px] leading-4">
              {resultJson}
            </pre>
            {entry.resultTruncated && (
              <p className="mt-0.5 text-[10px] text-muted-foreground/55">Result truncated.</p>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-0.5 block w-full cursor-pointer text-left"
          >
            <span className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground/70 leading-4">
              {resultJson}
            </span>
          </button>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared muted body
// ---------------------------------------------------------------------------

function MutedBody({ text }: { text: string }): ReactElement {
  return <p className="px-0.5 py-1 text-[12px] text-muted-foreground/60 leading-5">{text}</p>;
}
