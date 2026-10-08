import * as QuickActions from "expo-quick-actions";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { useLinkTo, type NavigationState } from "@react-navigation/native";
import { isThreadHidden } from "@t3tools/client-runtime/state/thread-hidden";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import {
  loadRecentThreadShortcuts,
  saveRecentThreadShortcuts,
  type RecentThreadShortcut,
} from "../../persistence/imperative";
import { useThreadShell } from "../../state/entities";
import { environmentThreadShells } from "../../state/threads";
import {
  activeThreadRef,
  buildShortcutActions,
  MAX_RECENT_THREAD_SHORTCUTS,
  shortcutHref,
  withRecentThreadShortcut,
} from "./appShortcuts";

const EMPTY_HIDDEN_RECENT_THREAD_KEYS = "[]";
const EMPTY_HIDDEN_RECENT_THREAD_KEYS_ATOM = Atom.make(EMPTY_HIDDEN_RECENT_THREAD_KEYS).pipe(
  Atom.withLabel("mobile:recent-hidden-thread-keys:empty"),
);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);

function recentThreadRef(thread: RecentThreadShortcut): ScopedThreadRef | null {
  try {
    return {
      environmentId: EnvironmentId.make(thread.environmentId),
      threadId: ThreadId.make(thread.threadId),
    };
  } catch {
    // Persisted launcher entries predate this observer and can contain stale
    // ids. Keep the incumbent visible behavior for those entries.
    return null;
  }
}

/**
 * Owns the launcher app shortcuts (Android long-press menu): keeps the
 * static "New task" entry plus the recently opened threads in sync, and
 * routes shortcut taps — cold start included — to their in-app screens.
 * Mounted once in the root stack layout.
 */
export function useAppShortcuts(state: NavigationState): void {
  useShortcutNavigation();
  useRecentThreadShortcutSync(state);
}

function useShortcutNavigation(): void {
  const linkTo = useLinkTo();
  const handledInitialAction = useRef(false);

  useEffect(() => {
    // Cold start: the tapped shortcut arrives as the launch action, before
    // any listener can fire. Navigating from here pushes the target over the
    // initial Home route, so back returns home instead of exiting the app.
    if (!handledInitialAction.current) {
      handledInitialAction.current = true;
      const initialHref = QuickActions.initial ? shortcutHref(QuickActions.initial) : null;
      if (initialHref !== null) {
        linkTo(initialHref);
      }
    }

    const subscription = QuickActions.addListener((action) => {
      const href = shortcutHref(action);
      if (href !== null) {
        linkTo(href);
      }
    });
    return () => subscription.remove();
  }, [linkTo]);
}

function useRecentThreadShortcutSync(state: NavigationState): void {
  // Launcher shortcuts are Android-only. A null ref on iOS keeps this hook
  // (mounted in the root stack layout) from subscribing the root to the
  // active thread's shell, which would re-render every screen on each
  // title/status/session change.
  const threadRef = useMemo(
    () => (Platform.OS === "android" ? activeThreadRef(state) : null),
    [state],
  );
  const threadShell = useThreadShell(threadRef);
  // null until the persisted list loads; recording waits on it so the first
  // thread opened after a cold start cannot clobber older entries.
  const [recents, setRecents] = useState<ReadonlyArray<RecentThreadShortcut> | null>(null);
  // Gates storage writes: a failed load falls back to an empty in-memory
  // list (so the launcher still gets the "New task" item), but persisting
  // that fallback would erase valid history over a transient read error.
  // Real thread opens flip this on — by then the list is the new truth.
  const persistableRef = useRef(false);
  // Saves are fire-and-forget; chaining them keeps an older list from
  // finishing after (and overwriting) a newer one.
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  // Observe only the first three persisted candidates, and reduce their
  // shells to a serialized key list. Shell updates for title/status/session
  // data therefore re-evaluate this atom without changing the primitive read
  // by the root hook unless visibility changes. Unknown shells are excluded
  // until a canonical shell confirms that the thread is visible.
  const hiddenRecentThreadKeysAtom = useMemo(() => {
    if (Platform.OS !== "android" || recents === null) {
      return EMPTY_HIDDEN_RECENT_THREAD_KEYS_ATOM;
    }

    const candidateRefs = recents
      .slice(0, MAX_RECENT_THREAD_SHORTCUTS)
      .map(recentThreadRef)
      .filter((ref): ref is ScopedThreadRef => ref !== null);
    if (candidateRefs.length === 0) {
      return EMPTY_HIDDEN_RECENT_THREAD_KEYS_ATOM;
    }

    return Atom.make((get): string => {
      const hiddenKeys = candidateRefs.flatMap((ref) => {
        const shell = get(environmentThreadShells.threadShellAtom(ref));
        return shell === null || isThreadHidden(shell) ? [threadKey(ref)] : [];
      });
      return JSON.stringify(hiddenKeys);
    }).pipe(Atom.withLabel("mobile:recent-hidden-thread-keys"));
  }, [recents]);
  const hiddenRecentThreadKeys = useAtomValue(hiddenRecentThreadKeysAtom);
  const excludedScopedThreadRefs = useMemo(() => {
    if (recents === null || hiddenRecentThreadKeys === EMPTY_HIDDEN_RECENT_THREAD_KEYS) {
      return EMPTY_SCOPED_THREAD_REFS;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(hiddenRecentThreadKeys);
    } catch {
      return EMPTY_SCOPED_THREAD_REFS;
    }
    if (!Array.isArray(parsed) || !parsed.every((key): key is string => typeof key === "string")) {
      return EMPTY_SCOPED_THREAD_REFS;
    }

    const hiddenKeys = new Set(parsed);
    return recents.slice(0, MAX_RECENT_THREAD_SHORTCUTS).flatMap((thread) => {
      const ref = recentThreadRef(thread);
      return ref !== null && hiddenKeys.has(threadKey(ref)) ? [ref] : [];
    });
  }, [recents, hiddenRecentThreadKeys]);

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }

    let cancelled = false;
    void loadRecentThreadShortcuts()
      .then((threads) => {
        if (!cancelled) {
          persistableRef.current = true;
          setRecents(threads);
        }
      })
      .catch((error) => {
        console.warn("[app-shortcuts] failed to load recent threads", error);
        if (!cancelled) {
          setRecents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loaded = recents !== null;
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const title = threadShell?.title ?? "";
  useEffect(() => {
    if (!loaded || environmentId === null || threadId === null) {
      return;
    }

    // withRecentThreadShortcut returns the same array when nothing changed,
    // so React bails out and the persist effect below does not re-fire.
    setRecents((current) => {
      if (current === null) {
        return current;
      }
      const next = withRecentThreadShortcut(current, { environmentId, threadId, title });
      if (next !== current) {
        persistableRef.current = true;
      }
      return next;
    });
  }, [loaded, environmentId, threadId, title]);

  useEffect(() => {
    if (recents === null) {
      return;
    }

    if (persistableRef.current) {
      saveQueueRef.current = saveQueueRef.current.then(
        () =>
          saveRecentThreadShortcuts(recents).catch((error) => {
            console.warn("[app-shortcuts] failed to persist recent threads", error);
          }),
        () => undefined,
      );
    }
  }, [recents]);

  useEffect(() => {
    if (recents === null) {
      return;
    }

    const actions = buildShortcutActions(recents, excludedScopedThreadRefs);
    void QuickActions.setItems(actions).catch((error) => {
      console.warn("[app-shortcuts] failed to update launcher shortcuts", error);
    });
  }, [recents, excludedScopedThreadRefs]);
}
