import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ArchiveIcon, EyeOffIcon, EyeIcon } from "lucide-react";
import { useCallback, useMemo, type ComponentType } from "react";

import { useThreadActions } from "../../hooks/useThreadActions";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import {
  getHiddenThreadActionEligibility,
  requestHiddenThreadUnhide,
} from "../../lib/hiddenThreadActions";
import { groupHiddenThreads, hiddenThreadProjectKey } from "../../lib/hiddenThreads";
import { useEnvironmentSupportsHiding, useProjects, useThreadShells } from "../../state/entities";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

function projectScopeKeys(
  scope: ReturnType<typeof useSettingsScope>["scope"],
): ReadonlySet<string> | null {
  if (scope.kind !== "project" && scope.kind !== "checkout") return null;
  return new Set(
    scope.members.map((member) => hiddenThreadProjectKey(member.environmentId, member.id)),
  );
}

function environmentLabel(
  environmentId: EnvironmentId,
  labels: ReadonlyMap<EnvironmentId, string>,
) {
  return labels.get(environmentId) ?? "the selected environment";
}

function hiddenThreadDescription(thread: {
  readonly hiddenAt?: string | null | undefined;
  readonly archivedAt: string | null;
  readonly createdAt: string;
}) {
  const hiddenAt = thread.hiddenAt;
  const hiddenLabel = hiddenAt ? formatRelativeTimeLabel(hiddenAt) : "an unknown time";
  const parts = [`Hidden ${hiddenLabel}`];
  if (thread.archivedAt !== null) {
    parts.push(`Archived ${formatRelativeTimeLabel(thread.archivedAt)}`);
  }
  parts.push(`Created ${formatRelativeTimeLabel(thread.createdAt)}`);
  return parts.join(" \u00b7 ");
}

function HiddenThreadRow({
  thread,
  onUnhide,
}: {
  readonly thread: EnvironmentThreadShell;
  readonly onUnhide: (threadRef: ScopedThreadRef) => Promise<void>;
}) {
  const environment = useEnvironment(thread.environmentId);
  const supportsHiding = useEnvironmentSupportsHiding(thread.environmentId);
  const eligibility = getHiddenThreadActionEligibility(
    supportsHiding,
    environment?.connection.phase ?? null,
  );
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);

  return (
    <SettingsRow
      title={thread.title}
      description={hiddenThreadDescription(thread)}
      status={eligibility.canUnhide ? undefined : eligibility.guidance}
      control={
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={!eligibility.canUnhide}
          onClick={() => void onUnhide(threadRef)}
        >
          <EyeIcon className="size-3.5" />
          <span>Unhide</span>
        </Button>
      }
    />
  );
}

function HiddenThreadStatus({
  id,
  isLoading,
  archiveError,
  loadingEnvironmentLabels,
  unavailableEnvironmentLabels,
}: {
  readonly id?: string | undefined;
  readonly isLoading: boolean;
  readonly archiveError: string | null;
  readonly loadingEnvironmentLabels: ReadonlyArray<string>;
  readonly unavailableEnvironmentLabels: ReadonlyArray<string>;
}) {
  const rows: Array<{
    title: string;
    description: string;
    icon: ComponentType<{ className?: string }>;
  }> = [];
  if (isLoading) {
    rows.push({
      title: "Loading hidden threads",
      description: "Checking connected environments.",
      icon: ArchiveIcon,
    });
  }
  if (archiveError) {
    rows.push({
      title: "Could not load hidden threads",
      description: archiveError,
      icon: EyeOffIcon,
    });
  }
  if (loadingEnvironmentLabels.length > 0) {
    rows.push({
      title: "Waiting for environments",
      description: `Hidden threads from ${loadingEnvironmentLabels.join(", ")} will appear after reconnecting.`,
      icon: EyeOffIcon,
    });
  }
  if (unavailableEnvironmentLabels.length > 0) {
    rows.push({
      title: "Some environments are offline or unavailable",
      description: `Hidden threads from ${unavailableEnvironmentLabels.join(", ")} may be missing until they reconnect.`,
      icon: EyeOffIcon,
    });
  }
  if (rows.length === 0) return null;

  return (
    <SettingsSection
      id={id}
      title={id === undefined ? "Status" : searchableSetting("hidden").title}
      variant="plain"
    >
      {rows.map(({ title, description, icon: Icon }) => (
        <SettingsRow
          key={title}
          title={
            <span className="inline-flex items-center gap-2">
              <Icon className="size-3.5 text-muted-foreground" />
              {title}
            </span>
          }
          description={description}
        />
      ))}
    </SettingsSection>
  );
}

export function HiddenThreadsPanel() {
  const { scope } = useSettingsScope();
  const { environments } = useEnvironments();
  const normalProjects = useProjects();
  const normalThreads = useThreadShells();
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);
  const { unhideThread } = useThreadActions();

  const selectedProjectKeys = useMemo(() => projectScopeKeys(scope), [scope]);
  const groups = useMemo(
    () =>
      groupHiddenThreads({
        normalProjects,
        normalThreads,
        archivedSnapshots,
        environmentIds: scope.environmentIds,
        projectKeys: selectedProjectKeys,
      }),
    [archivedSnapshots, normalProjects, normalThreads, scope.environmentIds, selectedProjectKeys],
  );

  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const selectedEnvironments = useMemo(() => {
    const selectedIds = new Set(scope.environmentIds);
    return environments.filter((environment) => selectedIds.has(environment.environmentId));
  }, [environments, scope.environmentIds]);
  const loadingEnvironmentLabels = selectedEnvironments
    .filter(
      (environment) =>
        environment.connection.phase === "connecting" ||
        environment.connection.phase === "reconnecting",
    )
    .map((environment) => environmentLabel(environment.environmentId, environmentLabels));
  const unavailableEnvironmentLabels = selectedEnvironments
    .filter(
      (environment) =>
        environment.connection.phase !== "connected" &&
        environment.connection.phase !== "connecting" &&
        environment.connection.phase !== "reconnecting",
    )
    .map((environment) => environmentLabel(environment.environmentId, environmentLabels));
  const hasStatus =
    isLoadingArchive ||
    archiveError !== null ||
    loadingEnvironmentLabels.length > 0 ||
    unavailableEnvironmentLabels.length > 0;

  const handleUnhide = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const action = await requestHiddenThreadUnhide(threadRef, unhideThread);
      if (action._tag === "Blocked") return;
      const result = action.result;
      if (result._tag === "Success") {
        refreshArchivedThreads();
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to unhide thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    },
    [refreshArchivedThreads, unhideThread],
  );

  return (
    <SettingsPageContainer>
      {hasStatus ? (
        <HiddenThreadStatus
          id={groups.length === 0 ? searchableSetting("hidden").id : undefined}
          isLoading={isLoadingArchive}
          archiveError={archiveError}
          loadingEnvironmentLabels={loadingEnvironmentLabels}
          unavailableEnvironmentLabels={unavailableEnvironmentLabels}
        />
      ) : null}
      {groups.length === 0 && !hasStatus ? (
        <SettingsSection
          id={searchableSetting("hidden").id}
          title={searchableSetting("hidden").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <EyeIcon className="size-3.5 text-muted-foreground" />
                No hidden threads
              </span>
            }
            description="Hidden threads will appear here."
          />
        </SettingsSection>
      ) : (
        groups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={`${project.environmentId}:${project.id}`}
            id={index === 0 ? searchableSetting("hidden").id : undefined}
            title={project.title}
            icon={<ProjectFavicon project={project} />}
          >
            {projectThreads.map((thread) => (
              <HiddenThreadRow
                key={`${thread.environmentId}:${thread.id}`}
                thread={thread}
                onUnhide={handleUnhide}
              />
            ))}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
