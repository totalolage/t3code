import { LegendList } from "@legendapp/list/react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, Platform, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { SymbolView } from "../../components/AppSymbol";
import { relativeTime } from "../../lib/time";
import { useProjects, useThreadShells } from "../../state/entities";
import { useThreadHidingUnavailableReason } from "../../state/thread-hiding";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useThreadListActions } from "../home/useThreadListActions";
import { buildHiddenThreadGroups, type HiddenThreadGroup } from "../hidden/hiddenThreadList";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import { SettingsSection } from "./components/SettingsSection";

type HiddenThreadListItem =
  | {
      readonly kind: "project";
      readonly key: string;
      readonly title: string;
      readonly environmentLabel: string | null;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly isFirst: boolean;
      readonly isLast: boolean;
      readonly thread: EnvironmentThreadShell;
    };

function HiddenThreadsError(props: { readonly message: string; readonly onRetry: () => void }) {
  return (
    <SettingsSection title="Status">
      <View className="gap-2 p-4">
        <View className="flex-row items-center gap-3">
          <SymbolView
            name="exclamationmark.triangle"
            size={20}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
          />
          <Text className="flex-1 text-base font-t3-bold text-foreground">
            Could not load every hidden thread
          </Text>
        </View>
        <Text className="text-sm leading-normal text-foreground-muted">{props.message}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.onRetry}
          className="self-start rounded-full bg-subtle px-4 py-2 active:opacity-70"
        >
          <Text className="text-sm font-t3-bold text-foreground">Try again</Text>
        </Pressable>
      </View>
    </SettingsSection>
  );
}

function HiddenProjectHeader(props: {
  readonly environmentLabel: string | null;
  readonly title: string;
}) {
  return (
    <View className="gap-1 px-2 pb-2 pt-5">
      <View className="flex-row items-center gap-2.5">
        <SymbolView
          name="folder.fill"
          size={18}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
      </View>
      {props.environmentLabel ? (
        <View className="flex-row items-center gap-1.5 pl-[26px]">
          <SymbolView
            name="desktopcomputer"
            size={11}
            tintColorClassName="accent-foreground-tertiary"
            type="monochrome"
          />
          <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
            {props.environmentLabel}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function HiddenThreadRow(props: {
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onUnhide: () => void;
  readonly thread: EnvironmentThreadShell;
}) {
  const threadHidingUnavailableReason = useThreadHidingUnavailableReason(
    props.thread.environmentId,
  );
  const details = [
    props.thread.hiddenAt ? `Hidden ${relativeTime(props.thread.hiddenAt)}` : "Hidden",
    props.thread.archivedAt !== null ? "Archived" : null,
    props.thread.branch,
  ].filter((part): part is string => Boolean(part));

  return (
    <View
      className={`flex-row items-center gap-4 bg-card p-4 android:bg-transparent ${
        props.isFirst ? "rounded-t-[22px]" : ""
      } ${props.isLast ? "rounded-b-[22px]" : "border-b border-border-subtle"}`}
    >
      <SymbolView
        name={{ ios: "eye.slash", android: "visibility" }}
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
      />

      <View className="min-w-0 flex-1 gap-1">
        <Text className="text-lg font-t3-bold leading-snug text-foreground" numberOfLines={2}>
          {props.thread.title}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={2}>
          {details.join(" · ")}
        </Text>
      </View>

      {threadHidingUnavailableReason !== null ? (
        <Text className="max-w-[180px] shrink text-right text-xs leading-4 text-foreground-muted">
          {threadHidingUnavailableReason}
        </Text>
      ) : (
        <Pressable
          accessibilityLabel={`Unhide ${props.thread.title}`}
          accessibilityRole="button"
          onPress={props.onUnhide}
          className="rounded-full bg-subtle px-3 py-2 active:opacity-70"
        >
          <Text className="text-sm font-t3-medium text-foreground">Unhide</Text>
        </Pressable>
      )}
    </View>
  );
}

function makeHiddenThreadListItems(
  groups: ReadonlyArray<HiddenThreadGroup>,
): ReadonlyArray<HiddenThreadListItem> {
  const items: HiddenThreadListItem[] = [];
  for (const group of groups) {
    items.push({
      kind: "project",
      key: `${group.key}:project`,
      title: group.title,
      environmentLabel: group.environmentLabel,
    });
    group.threads.forEach((thread, index) => {
      items.push({
        kind: "thread",
        key: `${thread.environmentId}:${thread.id}`,
        isFirst: index === 0,
        isLast: index === group.threads.length - 1,
        thread,
      });
    });
  }
  return items;
}

export function SettingsHiddenThreadsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environmentIds = useMemo(
    () => Object.values(savedConnectionsById).map((connection) => connection.environmentId),
    [savedConnectionsById],
  );
  const environmentLabels = useMemo(
    () =>
      Object.fromEntries(
        Object.values(savedConnectionsById).map((connection) => [
          connection.environmentId,
          connection.environmentLabel,
        ]),
      ),
    [savedConnectionsById],
  );
  const { error, isLoading, refresh, snapshots } = useArchivedThreadSnapshots(environmentIds);
  const groups = useMemo(
    () =>
      buildHiddenThreadGroups({
        environmentLabels,
        projects,
        snapshots,
        threads,
      }),
    [environmentLabels, projects, snapshots, threads],
  );
  const { unhideThread } = useThreadListActions();

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const listItems = useMemo(() => makeHiddenThreadListItems(groups), [groups]);
  const isInitialLoad = isLoading && groups.length === 0 && error === null;
  const renderItem = useCallback(
    ({ item }: { readonly item: HiddenThreadListItem }) => {
      if (item.kind === "project") {
        return <HiddenProjectHeader environmentLabel={item.environmentLabel} title={item.title} />;
      }

      return (
        <HiddenThreadRow
          isFirst={item.isFirst}
          isLast={item.isLast}
          onUnhide={() => {
            // The action refreshes the archive and the live shell is the
            // authority for removal. Do not remove the row optimistically.
            void unhideThread(item.thread);
          }}
          thread={item.thread}
        />
      );
    },
    [unhideThread],
  );
  const listEmptyComponent = useMemo(() => {
    if (isInitialLoad) {
      return (
        <View className="items-center py-16">
          <ActivityIndicator colorClassName="accent-icon" />
          <Text className="mt-3 text-sm text-foreground-muted">Loading hidden threads...</Text>
        </View>
      );
    }

    return (
      <EmptyState
        detail="Threads you hide will appear here."
        title="No hidden threads"
        variant="card"
      />
    );
  }, [isInitialLoad]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Hidden Threads" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <LegendList
        className="flex-1"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 4,
        }}
        contentInsetAdjustmentBehavior="automatic"
        data={listItems}
        estimatedItemSize={70}
        getItemType={(item) => item.kind}
        keyExtractor={(item) => item.key}
        ListEmptyComponent={listEmptyComponent}
        ListHeaderComponent={
          error ? <HiddenThreadsError message={error} onRetry={refresh} /> : null
        }
        refreshControl={
          <RefreshControl
            onRefresh={refresh}
            refreshing={isLoading && !isInitialLoad}
            tintColorClassName="accent-icon"
          />
        }
        renderItem={renderItem}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
