import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useThreadListActions } from "../home/useThreadListActions";
import { SettingsSection } from "./components/SettingsSection";

interface HiddenThreadGroup {
  readonly key: string;
  readonly title: string;
  readonly environmentLabel: string | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
}

export function SettingsHiddenThreadsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const threads = useThreadShells();
  const projects = useProjects();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const { unhideThread } = useThreadListActions();
  const groups = useMemo<ReadonlyArray<HiddenThreadGroup>>(() => {
    const projectsByKey = new Map<string, (typeof projects)[number]>(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
    );
    const grouped = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of threads) {
      if (thread.hiddenAt == null || thread.archivedAt !== null) continue;
      const key = `${thread.environmentId}:${thread.projectId}`;
      const group = grouped.get(key);
      if (group) group.push(thread);
      else grouped.set(key, [thread]);
    }
    return [...grouped.entries()]
      .map(([key, groupThreads]) => {
        const first = groupThreads[0]!;
        const project = projectsByKey.get(key);
        return {
          key,
          title: project?.title ?? project?.workspaceRoot ?? "Unknown project",
          environmentLabel: savedConnectionsById[first.environmentId]?.environmentLabel ?? null,
          threads: groupThreads.sort((left, right) =>
            (right.hiddenAt ?? "").localeCompare(left.hiddenAt ?? ""),
          ),
        };
      })
      .sort((left, right) => left.title.localeCompare(right.title));
  }, [projects, savedConnectionsById, threads]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Hidden Threads" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      {groups.length === 0 ? (
        <View className="flex-1 justify-center px-5">
          <EmptyState
            title="No hidden threads"
            detail="Threads you hide from the sidebar will appear here."
          />
        </View>
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-4 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {groups.map((group) => (
            <SettingsSection
              key={group.key}
              title={
                group.environmentLabel === null
                  ? group.title
                  : `${group.title} · ${group.environmentLabel}`
              }
            >
              {group.threads.map((thread, index) => (
                <View
                  key={`${thread.environmentId}:${thread.id}`}
                  className={
                    index === 0
                      ? "flex-row items-center gap-3 p-4"
                      : "flex-row items-center gap-3 border-t border-border-subtle p-4"
                  }
                >
                  <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={2}>
                    {thread.title}
                  </Text>
                  <Pressable
                    accessibilityLabel={`Unhide ${thread.title}`}
                    accessibilityRole="button"
                    className="min-h-11 justify-center rounded-lg bg-subtle px-3 py-2"
                    onPress={() => void unhideThread(thread)}
                  >
                    <Text className="font-t3-semibold text-sm text-foreground">Unhide</Text>
                  </Pressable>
                </View>
              ))}
            </SettingsSection>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
