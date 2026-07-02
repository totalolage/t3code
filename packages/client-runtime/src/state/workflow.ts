import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * Workflow-run inspection atoms (Claude Agent SDK workflow artifacts).
 *
 * `readScript` and `readJournal` are cached queries — the script never
 * changes for a given path within a run, and journal reads are refreshed by
 * re-query. `readAgentTranscript` is an imperative command because the
 * caller drives cursor-paged polling while a transcript pane is open.
 */
export function createWorkflowEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    readScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:read-script",
      tag: WS_METHODS.workflowReadScript,
      staleTimeMs: 30_000,
    }),
    readJournal: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflow:read-journal",
      tag: WS_METHODS.workflowReadJournal,
      staleTimeMs: 5_000,
      // The journal grows while a run is live and the query only mounts
      // while the Logs tab is open — poll so new results appear without a
      // manual refresh.
      refreshIntervalMs: 4_000,
    }),
    readAgentTranscript: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflow:read-agent-transcript",
      tag: WS_METHODS.workflowReadAgentTranscript,
    }),
  };
}
