import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { isThreadHidden } from "@t3tools/client-runtime/state/thread-hidden";

import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";

export interface HiddenThreadGroup {
  readonly key: string;
  readonly title: string;
  readonly environmentLabel: string | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

interface MutableHiddenThreadGroup {
  readonly key: string;
  readonly title: string;
  readonly environmentLabel: string | null;
  readonly threads: EnvironmentThreadShell[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function updatedTimestamp(thread: EnvironmentThreadShell): number {
  const timestamp = Date.parse(thread.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function compareThreads(left: EnvironmentThreadShell, right: EnvironmentThreadShell): number {
  return updatedTimestamp(right) - updatedTimestamp(left) || compareStrings(left.id, right.id);
}

function compareGroups(left: HiddenThreadGroup, right: HiddenThreadGroup): number {
  return compareStrings(left.title, right.title) || compareStrings(left.key, right.key);
}

export function buildHiddenThreadGroups(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly snapshots: ReadonlyArray<ArchivedSnapshotEntry>;
  readonly environmentLabels: Readonly<Record<string, string>>;
}): readonly HiddenThreadGroup[] {
  const savedEnvironmentIds = new Set(Object.keys(input.environmentLabels));
  const projectByKey = new Map<string, EnvironmentProject>();

  for (const project of input.projects) {
    if (!savedEnvironmentIds.has(project.environmentId)) continue;
    projectByKey.set(scopedProjectKey(project.environmentId, project.id), project);
  }

  const archivedEntries = input.snapshots.filter((entry) =>
    savedEnvironmentIds.has(entry.environmentId),
  );
  for (const entry of archivedEntries) {
    for (const rawProject of entry.snapshot.projects) {
      const project = scopeProject(entry.environmentId, rawProject);
      const key = scopedProjectKey(project.environmentId, project.id);
      if (!projectByKey.has(key)) {
        projectByKey.set(key, project);
      }
    }
  }

  // Insert live shells first. An unhidden live shell must replace a stale hidden
  // archived copy before the final hidden filter runs.
  const threadByKey = new Map<string, EnvironmentThreadShell>();
  for (const thread of input.threads) {
    if (!savedEnvironmentIds.has(thread.environmentId)) continue;
    threadByKey.set(scopedThreadKey(thread.environmentId, thread.id), thread);
  }

  for (const entry of archivedEntries) {
    for (const rawThread of entry.snapshot.threads) {
      if (rawThread.archivedAt == null) continue;
      const thread = scopeThreadShell(entry.environmentId, rawThread);
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (!threadByKey.has(key)) {
        threadByKey.set(key, thread);
      }
    }
  }

  const groups = new Map<string, MutableHiddenThreadGroup>();
  for (const thread of threadByKey.values()) {
    if (!isThreadHidden(thread)) continue;

    const key = scopedProjectKey(thread.environmentId, thread.projectId);
    const existing = groups.get(key);
    if (existing !== undefined) {
      existing.threads.push(thread);
      continue;
    }

    groups.set(key, {
      key,
      title: projectByKey.get(key)?.title ?? "Unknown project",
      environmentLabel: input.environmentLabels[thread.environmentId] ?? null,
      threads: [thread],
    });
  }

  const result: HiddenThreadGroup[] = [];
  for (const group of groups.values()) {
    result.push({
      key: group.key,
      title: group.title,
      environmentLabel: group.environmentLabel,
      threads: [...group.threads].sort(compareThreads),
    });
  }

  return result.sort(compareGroups);
}
