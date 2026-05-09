import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";
import {
  type GitBranchState,
  type GitBranchTarget,
  EMPTY_GIT_BRANCH_ATOM,
  EMPTY_GIT_BRANCH_STATE,
  createGitBranchManager,
  getGitBranchTargetKey,
  gitBranchStateAtom,
} from "@t3tools/client-runtime";

import { appAtomRegistry } from "./atom-registry";
import {
  getEnvironmentClient,
  subscribeEnvironmentConnections,
} from "./environment-session-registry";

export const gitBranchManager = createGitBranchManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.git : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
  watchLimit: 100,
});

export function useGitBranches(target: GitBranchTarget): GitBranchState {
  const stableTarget = useMemo(
    () => ({
      environmentId: target.environmentId,
      cwd: target.cwd,
      query: target.query ?? null,
    }),
    [target.cwd, target.environmentId, target.query],
  );
  const targetKey = getGitBranchTargetKey(stableTarget);
  useEffect(() => gitBranchManager.watch(stableTarget), [stableTarget]);
  const state = useAtomValue(
    targetKey !== null ? gitBranchStateAtom(targetKey) : EMPTY_GIT_BRANCH_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_BRANCH_STATE : state;
}
