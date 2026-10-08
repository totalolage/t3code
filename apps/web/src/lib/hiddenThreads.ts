import { isThreadHidden } from "@t3tools/client-runtime/state/thread-hidden";
import { scopeThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot as OrchestrationShellSnapshot,
  OrchestrationV2ThreadShell as OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

export interface HiddenThreadSnapshotEntry {
  readonly environmentId: EnvironmentId;
  readonly snapshot: Pick<OrchestrationShellSnapshot, "projects" | "threads">;
}

export interface HiddenThreadsInput {
  /** The normal shell is authoritative for a thread key when both sources list it. */
  readonly normalProjects: ReadonlyArray<EnvironmentProject>;
  readonly normalThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly archivedSnapshots: ReadonlyArray<HiddenThreadSnapshotEntry>;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** Composite environment/project keys for project and checkout settings scopes. */
  readonly projectKeys?: ReadonlySet<string> | null;
}

export interface HiddenThreadGroup {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

function hiddenThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

export function hiddenThreadProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

function isSelectedProject(input: HiddenThreadsInput, key: string): boolean {
  return input.projectKeys == null || input.projectKeys.has(key);
}

function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

function scopeThread(
  environmentId: EnvironmentId,
  thread: OrchestrationThreadShell,
): EnvironmentThreadShell {
  return scopeThreadShell(environmentId, thread);
}

function hiddenThreadTimestamp(thread: EnvironmentThreadShell): string {
  return thread.hiddenAt ?? thread.archivedAt ?? thread.updatedAt ?? thread.createdAt;
}

/** Merge normal and archived shell reads without mutating either source. */
export function groupHiddenThreads(input: HiddenThreadsInput): ReadonlyArray<HiddenThreadGroup> {
  const environmentIds = new Set(input.environmentIds);
  const projectsByKey = new Map<string, EnvironmentProject>();

  for (const project of input.normalProjects) {
    const key = hiddenThreadProjectKey(project.environmentId, project.id);
    if (!environmentIds.has(project.environmentId) || !isSelectedProject(input, key)) continue;
    if (!projectsByKey.has(key)) projectsByKey.set(key, project);
  }

  for (const entry of input.archivedSnapshots) {
    if (!environmentIds.has(entry.environmentId)) continue;
    for (const project of entry.snapshot.projects) {
      const key = hiddenThreadProjectKey(entry.environmentId, project.id);
      if (!isSelectedProject(input, key) || projectsByKey.has(key)) continue;
      projectsByKey.set(key, scopeProject(entry.environmentId, project));
    }
  }

  // Add every normal shell before filtering hidden state. A visible normal shell
  // must suppress a stale hidden copy from the archived endpoint as well.
  const authoritativeThreads = new Map<string, EnvironmentThreadShell>();
  for (const thread of input.normalThreads) {
    if (!environmentIds.has(thread.environmentId)) continue;
    const key = hiddenThreadKey(thread.environmentId, thread.id);
    if (!authoritativeThreads.has(key)) authoritativeThreads.set(key, thread);
  }

  for (const entry of input.archivedSnapshots) {
    if (!environmentIds.has(entry.environmentId)) continue;
    for (const thread of entry.snapshot.threads) {
      const key = hiddenThreadKey(entry.environmentId, thread.id);
      if (!authoritativeThreads.has(key)) {
        authoritativeThreads.set(key, scopeThread(entry.environmentId, thread));
      }
    }
  }

  const threadsByProject = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of authoritativeThreads.values()) {
    if (!isThreadHidden({ hiddenAt: thread.hiddenAt ?? null })) continue;
    const projectKey = hiddenThreadProjectKey(thread.environmentId, thread.projectId);
    if (!projectsByKey.has(projectKey)) continue;
    const projectThreads = threadsByProject.get(projectKey);
    if (projectThreads === undefined) {
      threadsByProject.set(projectKey, [thread]);
    } else {
      projectThreads.push(thread);
    }
  }

  const groups: HiddenThreadGroup[] = [];
  for (const [projectKey, project] of projectsByKey) {
    const threads = threadsByProject.get(projectKey);
    if (threads === undefined || threads.length === 0) continue;
    groups.push({
      project,
      threads: threads.toSorted(
        (left, right) =>
          hiddenThreadTimestamp(right).localeCompare(hiddenThreadTimestamp(left)) ||
          right.id.localeCompare(left.id),
      ),
    });
  }
  return groups;
}
