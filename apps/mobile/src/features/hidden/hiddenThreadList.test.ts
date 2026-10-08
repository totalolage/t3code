import type { ArchivedSnapshotEntry } from "@t3tools/client-runtime/state/threads";
import {
  scopeProject,
  scopeThreadShell,
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { OrchestrationProjectShell, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { buildHiddenThreadGroups } from "./hiddenThreadList";
import { makeRawThreadShell } from "../../test-fixtures";

const environmentOne = EnvironmentId.make("environment-1");
const environmentTwo = EnvironmentId.make("environment-2");
const environmentThree = EnvironmentId.make("environment-3");

type ThreadFixture = OrchestrationV2ThreadShell;

type ThreadFixtureInput = Omit<
  Partial<ThreadFixture>,
  "createdAt" | "updatedAt" | "archivedAt" | "hiddenAt" | "settledAt"
> &
  Pick<ThreadFixture, "id" | "projectId" | "title"> & {
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly archivedAt?: string | null;
    readonly hiddenAt?: string | null;
    readonly settledAt?: string | null;
  };

function makeProject(
  input: Partial<OrchestrationProjectShell> & Pick<OrchestrationProjectShell, "id" | "title">,
): OrchestrationProjectShell {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(input: ThreadFixtureInput): ThreadFixture {
  const dateTime = (value: string | null | undefined) =>
    value == null ? null : DateTime.makeUnsafe(value);

  return makeRawThreadShell({
    ...input,
    createdAt: DateTime.makeUnsafe(input.createdAt ?? "2026-06-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe(input.updatedAt ?? "2026-06-01T00:00:00.000Z"),
    archivedAt: dateTime(input.archivedAt),
    hiddenAt: dateTime(input.hiddenAt),
    settledAt: dateTime(input.settledAt),
  });
}

function liveProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return scopeProject(environmentId, project);
}

function liveThread(environmentId: EnvironmentId, thread: ThreadFixture): EnvironmentThreadShell {
  return scopeThreadShell(environmentId, thread);
}

function makeSnapshot(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<ThreadFixture>,
  environmentId = environmentOne,
): ArchivedSnapshotEntry {
  return {
    environmentId,
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: 1,
      projects,
      threads,
    },
  };
}

function labels(
  ...entries: ReadonlyArray<readonly [EnvironmentId, string]>
): Readonly<Record<string, string>> {
  return Object.fromEntries(entries);
}

describe("buildHiddenThreadGroups", () => {
  it("excludes native shells with null hiddenAt", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const result = buildHiddenThreadGroups({
      projects: [liveProject(environmentOne, project)],
      threads: [
        liveThread(
          environmentOne,
          makeThread({
            id: ThreadId.make("live-missing"),
            projectId: project.id,
            title: "Live missing",
          }),
        ),
        liveThread(
          environmentOne,
          makeThread({
            hiddenAt: null,
            id: ThreadId.make("live-null"),
            projectId: project.id,
            title: "Live null",
          }),
        ),
      ],
      snapshots: [
        makeSnapshot(
          [],
          [
            makeThread({
              archivedAt: "2026-06-02T00:00:00.000Z",
              id: ThreadId.make("archive-missing"),
              projectId: project.id,
              title: "Archive missing",
            }),
            makeThread({
              archivedAt: "2026-06-03T00:00:00.000Z",
              hiddenAt: null,
              id: ThreadId.make("archive-null"),
              projectId: project.id,
              title: "Archive null",
            }),
          ],
        ),
      ],
      environmentLabels: labels([environmentOne, "Local"]),
    });

    expect(result).toEqual([]);
  });

  it("ignores hidden non-archived records in archived snapshots", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const result = buildHiddenThreadGroups({
      projects: [],
      threads: [],
      snapshots: [
        makeSnapshot(
          [project],
          [
            makeThread({
              hiddenAt: "2026-06-01T00:00:00.000Z",
              id: ThreadId.make("still-active"),
              projectId: project.id,
              title: "Still active",
            }),
          ],
        ),
      ],
      environmentLabels: labels([environmentOne, "Local"]),
    });

    expect(result).toEqual([]);
  });

  it("includes hidden live and archived threads and preserves archived status", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const live = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: "2026-06-03T00:00:00.000Z",
        id: ThreadId.make("live-hidden"),
        projectId: project.id,
        title: "Live hidden",
      }),
    );
    const archivedAt = "2026-06-04T00:00:00.000Z";
    const archived = makeThread({
      archivedAt,
      hiddenAt: "2026-06-03T00:00:00.000Z",
      id: ThreadId.make("archived-hidden"),
      projectId: project.id,
      title: "Archived hidden",
    });

    const result = buildHiddenThreadGroups({
      projects: [liveProject(environmentOne, project)],
      threads: [live],
      snapshots: [makeSnapshot([], [archived])],
      environmentLabels: labels([environmentOne, "Local"]),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.environmentLabel).toBe("Local");
    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([
      "archived-hidden",
      "live-hidden",
    ]);
    expect(result[0]?.threads.find((thread) => thread.id === archived.id)?.archivedAt).toBe(
      archivedAt,
    );
  });

  it("removes an archived thread when a refreshed snapshot clears hiddenAt", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const archivedAt = "2026-06-04T00:00:00.000Z";
    const hiddenAt = "2026-06-03T00:00:00.000Z";
    const hidden = makeThread({
      archivedAt,
      hiddenAt,
      id: ThreadId.make("archived-thread"),
      projectId: project.id,
      title: "Archived thread",
    });
    const refreshed = { ...hidden, hiddenAt: null };
    const input = {
      projects: [],
      threads: [],
      environmentLabels: labels([environmentOne, "Local"]),
    } as const;

    const initialGroups = buildHiddenThreadGroups({
      ...input,
      snapshots: [makeSnapshot([project], [hidden])],
    });
    const refreshedSnapshot = makeSnapshot([project], [refreshed]);
    const refreshedGroups = buildHiddenThreadGroups({
      ...input,
      snapshots: [refreshedSnapshot],
    });

    expect(initialGroups).toHaveLength(1);
    expect(initialGroups[0]?.threads[0]?.archivedAt).toBe(archivedAt);
    expect(refreshedGroups).toEqual([]);
    expect(DateTime.formatIso(refreshedSnapshot.snapshot.threads[0]!.archivedAt!)).toBe(archivedAt);
  });

  it("keeps identical project and thread ids distinct across environments", () => {
    const projectId = ProjectId.make("shared-project");
    const threadId = ThreadId.make("shared-thread");
    const project = makeProject({ id: projectId, title: "Shared" });

    const result = buildHiddenThreadGroups({
      projects: [liveProject(environmentOne, project), liveProject(environmentTwo, project)],
      threads: [
        liveThread(
          environmentOne,
          makeThread({
            hiddenAt: "2026-06-01T00:00:00.000Z",
            id: threadId,
            projectId,
            title: "One",
          }),
        ),
        liveThread(
          environmentTwo,
          makeThread({
            hiddenAt: "2026-06-02T00:00:00.000Z",
            id: threadId,
            projectId,
            title: "Two",
          }),
        ),
      ],
      snapshots: [],
      environmentLabels: labels([environmentOne, "Local"], [environmentTwo, "Remote"]),
    });

    expect(result.map((group) => [group.key, group.environmentLabel])).toEqual([
      [`${environmentOne}:${projectId}`, "Local"],
      [`${environmentTwo}:${projectId}`, "Remote"],
    ]);
    expect(result.map((group) => group.threads[0]?.environmentId)).toEqual([
      environmentOne,
      environmentTwo,
    ]);
  });

  it("lets an unhidden live shell supersede a stale hidden archive", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const archived = makeThread({
      archivedAt: "2026-06-02T00:00:00.000Z",
      hiddenAt: "2026-06-03T00:00:00.000Z",
      id: ThreadId.make("thread-1"),
      projectId: project.id,
      title: "Stale archive",
    });
    const live = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: null,
        id: archived.id,
        projectId: project.id,
        title: "Authoritative live",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
    );

    const result = buildHiddenThreadGroups({
      projects: [liveProject(environmentOne, project)],
      threads: [live],
      snapshots: [makeSnapshot([project], [archived])],
      environmentLabels: labels([environmentOne, "Local"]),
    });

    expect(result).toEqual([]);
  });

  it("removes a thread when the authoritative next input is unhidden", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const hidden = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: "2026-06-01T00:00:00.000Z",
        id: ThreadId.make("thread-1"),
        projectId: project.id,
        title: "Thread",
      }),
    );
    const unhidden = { ...hidden, hiddenAt: null };
    const input = {
      projects: [liveProject(environmentOne, project)],
      snapshots: [],
      environmentLabels: labels([environmentOne, "Local"]),
    } as const;

    expect(buildHiddenThreadGroups({ ...input, threads: [hidden] })).toHaveLength(1);
    expect(buildHiddenThreadGroups({ ...input, threads: [unhidden] })).toEqual([]);
  });

  it("uses live project titles, scoped archive fallback, and Unknown project", () => {
    const sharedProjectId = ProjectId.make("shared-project");
    const liveProjectValue = makeProject({ id: sharedProjectId, title: "Live title" });
    const staleProjectValue = makeProject({ id: sharedProjectId, title: "Stale title" });
    const remoteProjectValue = makeProject({ id: sharedProjectId, title: "Remote title" });
    const missingProjectId = ProjectId.make("missing-project");

    const result = buildHiddenThreadGroups({
      projects: [liveProject(environmentOne, liveProjectValue)],
      threads: [
        liveThread(
          environmentThree,
          makeThread({
            hiddenAt: "2026-06-01T00:00:00.000Z",
            id: ThreadId.make("missing-project-thread"),
            projectId: missingProjectId,
            title: "Missing project",
          }),
        ),
      ],
      snapshots: [
        makeSnapshot(
          [staleProjectValue],
          [
            makeThread({
              archivedAt: "2026-06-02T00:00:00.000Z",
              hiddenAt: "2026-06-01T00:00:00.000Z",
              id: ThreadId.make("local-archive"),
              projectId: sharedProjectId,
              title: "Local archive",
            }),
          ],
          environmentOne,
        ),
        makeSnapshot(
          [remoteProjectValue],
          [
            makeThread({
              archivedAt: "2026-06-03T00:00:00.000Z",
              hiddenAt: "2026-06-01T00:00:00.000Z",
              id: ThreadId.make("remote-archive"),
              projectId: sharedProjectId,
              title: "Remote archive",
            }),
          ],
          environmentTwo,
        ),
      ],
      environmentLabels: labels(
        [environmentOne, "Local"],
        [environmentTwo, "Remote"],
        [environmentThree, "Third"],
      ),
    });

    expect(
      result.map((group) => ({
        key: group.key,
        title: group.title,
        label: group.environmentLabel,
      })),
    ).toEqual([
      { key: `${environmentOne}:${sharedProjectId}`, title: "Live title", label: "Local" },
      { key: `${environmentTwo}:${sharedProjectId}`, title: "Remote title", label: "Remote" },
      {
        key: `${environmentThree}:${missingProjectId}`,
        title: "Unknown project",
        label: "Third",
      },
    ]);
  });

  it("filters out environments that are not saved in environmentLabels", () => {
    const project = makeProject({ id: ProjectId.make("project-1"), title: "T3 Code" });
    const hiddenLive = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: "2026-06-01T00:00:00.000Z",
        id: ThreadId.make("saved"),
        projectId: project.id,
        title: "Saved",
      }),
    );
    const hiddenUnsaved = makeThread({
      archivedAt: "2026-06-02T00:00:00.000Z",
      hiddenAt: "2026-06-01T00:00:00.000Z",
      id: ThreadId.make("unsaved"),
      projectId: project.id,
      title: "Unsaved",
    });

    const result = buildHiddenThreadGroups({
      projects: [liveProject(environmentOne, project), liveProject(environmentTwo, project)],
      threads: [hiddenLive, liveThread(environmentTwo, { ...hiddenUnsaved, archivedAt: null })],
      snapshots: [makeSnapshot([project], [hiddenUnsaved], environmentTwo)],
      environmentLabels: labels([environmentOne, "Local"]),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe(`${environmentOne}:${project.id}`);
    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([hiddenLive.id]);
  });

  it("sorts groups by title and key, and threads by updatedAt then id without mutating input", () => {
    const alphaOne = makeProject({ id: ProjectId.make("alpha-one"), title: "Alpha" });
    const alphaTwo = makeProject({ id: ProjectId.make("alpha-two"), title: "Alpha" });
    const zeta = makeProject({ id: ProjectId.make("zeta"), title: "Zeta" });
    const older = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: "2026-06-01T00:00:00.000Z",
        id: ThreadId.make("b-thread"),
        projectId: alphaOne.id,
        title: "Older",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
    );
    const tied = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: "2026-06-01T00:00:00.000Z",
        id: ThreadId.make("a-thread"),
        projectId: alphaOne.id,
        title: "Tied",
        updatedAt: "2026-06-03T00:00:00.000Z",
      }),
    );
    const newest = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: "2026-06-01T00:00:00.000Z",
        id: ThreadId.make("newest"),
        projectId: alphaOne.id,
        title: "Newest",
        updatedAt: "2026-06-04T00:00:00.000Z",
      }),
    );
    const alphaTwoThread = liveThread(
      environmentTwo,
      makeThread({
        hiddenAt: "2026-06-01T00:00:00.000Z",
        id: ThreadId.make("alpha-two-thread"),
        projectId: alphaTwo.id,
        title: "Alpha two",
      }),
    );
    const zetaThread = liveThread(
      environmentOne,
      makeThread({
        hiddenAt: "2026-06-01T00:00:00.000Z",
        id: ThreadId.make("zeta-thread"),
        projectId: zeta.id,
        title: "Zeta",
      }),
    );
    const threads = [older, tied, newest, alphaTwoThread, zetaThread];
    const originalThreads = [...threads];
    const projects = [
      liveProject(environmentOne, zeta),
      liveProject(environmentTwo, alphaTwo),
      liveProject(environmentOne, alphaOne),
    ];

    const result = buildHiddenThreadGroups({
      projects,
      threads,
      snapshots: [],
      environmentLabels: labels([environmentOne, "Local"], [environmentTwo, "Remote"]),
    });

    expect(result.map((group) => group.key)).toEqual([
      `${environmentOne}:${alphaOne.id}`,
      `${environmentTwo}:${alphaTwo.id}`,
      `${environmentOne}:${zeta.id}`,
    ]);
    expect(result[0]?.threads.map((thread) => thread.id)).toEqual([newest.id, tied.id, older.id]);
    expect(threads).toEqual(originalThreads);
    expect(projects.map((project) => project.id)).toEqual([zeta.id, alphaTwo.id, alphaOne.id]);
  });
});
