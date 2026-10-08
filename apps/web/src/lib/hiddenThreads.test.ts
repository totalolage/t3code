import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import {
  groupHiddenThreads,
  hiddenThreadProjectKey,
  type HiddenThreadSnapshotEntry,
} from "./hiddenThreads";
import { makeThreadFixture } from "../test-fixtures";

const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

function project(environmentId: EnvironmentId, id: string, title = id): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspace/${id}`,
    defaultModelSelection: MODEL_SELECTION,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function thread(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make(id),
    title: id,
    ...overrides,
  });
}

function archived(
  environmentId: EnvironmentId,
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): HiddenThreadSnapshotEntry {
  return { environmentId, snapshot: { projects, threads: threads.map((thread) => thread.source) } };
}

function hiddenGroups(input: {
  readonly normalProjects?: ReadonlyArray<EnvironmentProject>;
  readonly normalThreads?: ReadonlyArray<EnvironmentThreadShell>;
  readonly archivedSnapshots?: ReadonlyArray<HiddenThreadSnapshotEntry>;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly projectKeys?: ReadonlySet<string> | null;
}) {
  return groupHiddenThreads({
    normalProjects: input.normalProjects ?? [],
    normalThreads: input.normalThreads ?? [],
    archivedSnapshots: input.archivedSnapshots ?? [],
    ...input,
  });
}

describe("groupHiddenThreads", () => {
  it("combines hidden normal and archived shells while preferring normal duplicates", () => {
    const environmentId = EnvironmentId.make("env-a");
    const projectRecord = project(environmentId, "project-a");
    const normalDuplicate = thread(environmentId, projectRecord.id, "same", {
      title: "Current title",
      hiddenAt: "2026-03-02T00:00:00.000Z",
    });
    const archivedDuplicate = thread(environmentId, projectRecord.id, "same", {
      title: "Stale title",
      hiddenAt: "2026-03-01T00:00:00.000Z",
    });
    const archivedOnly = thread(environmentId, projectRecord.id, "archived-only", {
      hiddenAt: "2026-03-03T00:00:00.000Z",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });

    const groups = hiddenGroups({
      environmentIds: [environmentId],
      normalProjects: [projectRecord],
      normalThreads: [normalDuplicate],
      archivedSnapshots: [
        archived(environmentId, [projectRecord], [archivedDuplicate, archivedOnly]),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.threads.map((item) => item.id)).toEqual([
      ThreadId.make("archived-only"),
      ThreadId.make("same"),
    ]);
    expect(groups[0]!.threads[1]!.title).toBe("Current title");
  });

  it("keeps equal project and thread ids separate across environments", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const projectA = project(envA, "same-project", "A project");
    const projectB = project(envB, "same-project", "B project");
    const threadA = thread(envA, projectA.id, "same-thread", {
      hiddenAt: "2026-03-01T00:00:00.000Z",
    });
    const threadB = thread(envB, projectB.id, "same-thread", {
      hiddenAt: "2026-03-02T00:00:00.000Z",
    });

    const groups = hiddenGroups({
      environmentIds: [envA, envB],
      normalProjects: [projectA, projectB],
      normalThreads: [threadA, threadB],
    });

    expect(groups.map((group) => [group.project.environmentId, group.project.title])).toEqual([
      [envA, "A project"],
      [envB, "B project"],
    ]);
    expect(groups.map((group) => group.threads[0]!.environmentId)).toEqual([envA, envB]);
  });

  it("limits project scopes by the composite environment and project id", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const projectA = project(envA, "project-a");
    const projectB = project(envA, "project-b");
    const projectOnB = project(envB, "project-a");
    const selected = hiddenThreadProjectKey(envA, projectA.id);

    const groups = hiddenGroups({
      environmentIds: [envA, envB],
      projectKeys: new Set([selected]),
      normalProjects: [projectA, projectB, projectOnB],
      normalThreads: [
        thread(envA, projectA.id, "selected", { hiddenAt: "2026-03-01T00:00:00.000Z" }),
        thread(envA, projectB.id, "other-project", { hiddenAt: "2026-03-02T00:00:00.000Z" }),
        thread(envB, projectOnB.id, "other-environment", {
          hiddenAt: "2026-03-03T00:00:00.000Z",
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.project.id).toBe(projectA.id);
    expect(groups[0]!.threads.map((item) => item.id)).toEqual([ThreadId.make("selected")]);
  });

  it("does not list shells without a hidden timestamp", () => {
    const environmentId = EnvironmentId.make("env-a");
    const projectRecord = project(environmentId, "project-a");
    const missing = thread(environmentId, projectRecord.id, "missing");
    const visible = thread(environmentId, projectRecord.id, "visible", { hiddenAt: null });

    const groups = hiddenGroups({
      environmentIds: [environmentId],
      normalProjects: [projectRecord],
      normalThreads: [missing, visible],
      archivedSnapshots: [archived(environmentId, [projectRecord], [missing, visible])],
    });

    expect(groups).toEqual([]);
  });

  it("removes a hidden thread after its normal shell reverses to visible", () => {
    const environmentId = EnvironmentId.make("env-a");
    const projectRecord = project(environmentId, "project-a");
    const archivedHidden = thread(environmentId, projectRecord.id, "thread-a", {
      hiddenAt: "2026-03-01T00:00:00.000Z",
    });

    expect(
      hiddenGroups({
        environmentIds: [environmentId],
        normalProjects: [projectRecord],
        normalThreads: [
          thread(environmentId, projectRecord.id, "thread-a", {
            hiddenAt: null,
          }),
        ],
        archivedSnapshots: [archived(environmentId, [projectRecord], [archivedHidden])],
      }),
    ).toEqual([]);
  });

  it("preserves source arrays and records", () => {
    const environmentId = EnvironmentId.make("env-a");
    const projectRecord = project(environmentId, "project-a");
    const normalThread = thread(environmentId, projectRecord.id, "normal", {
      hiddenAt: "2026-03-01T00:00:00.000Z",
    });
    const archiveEntry = archived(
      environmentId,
      [projectRecord],
      [
        thread(environmentId, projectRecord.id, "archived", {
          hiddenAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
    );
    const normalProjects = [projectRecord];
    const normalThreads = [normalThread];
    const archivedSnapshots = [archiveEntry];
    const before = JSON.stringify({ normalProjects, normalThreads, archivedSnapshots });

    const groups = hiddenGroups({
      environmentIds: [environmentId],
      normalProjects,
      normalThreads,
      archivedSnapshots,
    });

    expect(JSON.stringify({ normalProjects, normalThreads, archivedSnapshots })).toBe(before);
    expect(groups[0]!.threads.find((item) => item.id === normalThread.id)).toBe(normalThread);
  });
});
