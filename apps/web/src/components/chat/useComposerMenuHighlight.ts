import { useCallback, useMemo, useRef, useState } from "react";

import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

type ComposerMenuHighlightState = {
  readonly itemId: string | null;
  readonly searchKey: string | null;
  readonly observedSearchKey: string | null;
  readonly menuOpen: boolean;
};

function createResetHighlightState(input: {
  readonly menuOpen: boolean;
  readonly searchKey: string | null;
}): ComposerMenuHighlightState {
  return {
    itemId: null,
    searchKey: null,
    observedSearchKey: input.searchKey,
    menuOpen: input.menuOpen,
  };
}

function sameHighlightState(
  left: ComposerMenuHighlightState,
  right: ComposerMenuHighlightState,
): boolean {
  return (
    left.itemId === right.itemId &&
    left.searchKey === right.searchKey &&
    left.observedSearchKey === right.observedSearchKey &&
    left.menuOpen === right.menuOpen
  );
}

export function useComposerMenuHighlight(input: {
  readonly items: ReadonlyArray<ComposerCommandItem>;
  readonly menuOpen: boolean;
  readonly searchKey: string | null;
}) {
  const inputRef = useRef(input);
  inputRef.current = input;

  const [storedHighlightState, setStoredHighlightState] = useState<ComposerMenuHighlightState>(() =>
    createResetHighlightState(input),
  );

  let highlightState = storedHighlightState;
  if (
    highlightState.menuOpen !== input.menuOpen ||
    highlightState.observedSearchKey !== input.searchKey
  ) {
    highlightState = createResetHighlightState(input);
    setStoredHighlightState(highlightState);
  }

  const activeItemId = useMemo(() => {
    if (!input.menuOpen) return null;
    return resolveComposerMenuActiveItemId({
      items: input.items,
      highlightedItemId: highlightState.itemId,
      currentSearchKey: input.searchKey,
      highlightedSearchKey: highlightState.searchKey,
    });
  }, [
    highlightState.itemId,
    highlightState.searchKey,
    input.items,
    input.menuOpen,
    input.searchKey,
  ]);
  const activeItemIdRef = useRef(activeItemId);
  activeItemIdRef.current = activeItemId;

  const reset = useCallback(() => {
    const currentInput = inputRef.current;
    setStoredHighlightState((existing) => {
      const next = createResetHighlightState(currentInput);
      return sameHighlightState(existing, next) ? existing : next;
    });
  }, []);

  const setHighlightedItemId = useCallback((itemId: string | null) => {
    const currentInput = inputRef.current;
    setStoredHighlightState((existing) => {
      const next: ComposerMenuHighlightState = {
        itemId,
        searchKey: itemId === null ? null : currentInput.searchKey,
        observedSearchKey: currentInput.searchKey,
        menuOpen: currentInput.menuOpen,
      };
      return sameHighlightState(existing, next) ? existing : next;
    });
  }, []);

  const nudge = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      const currentInput = inputRef.current;
      if (!currentInput.menuOpen || currentInput.items.length === 0) return;
      const currentActiveItemId = activeItemIdRef.current;
      const activeIndex = currentActiveItemId
        ? currentInput.items.findIndex((item) => item.id === currentActiveItemId)
        : -1;
      const normalizedIndex = activeIndex >= 0 ? activeIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + currentInput.items.length) % currentInput.items.length;
      const nextItem = currentInput.items[nextIndex];
      setHighlightedItemId(nextItem?.id ?? null);
    },
    [setHighlightedItemId],
  );

  return useMemo(
    () => ({
      activeItemId,
      nudge,
      reset,
      setHighlightedItemId,
    }),
    [activeItemId, nudge, reset, setHighlightedItemId],
  );
}
