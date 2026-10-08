#!/usr/bin/env bun
/// <reference types="bun" />

const loadNodeSqliteClient = async (): Promise<unknown> =>
  import("@t3tools/shared/nodeSqliteClient");

export const runStandaloneNodeSqliteBoundary = async (): Promise<"bun" | "node"> => {
  if (process.versions.bun !== undefined) return "bun";
  await loadNodeSqliteClient();
  return "node";
};

if (import.meta.main) {
  // @effect-diagnostics-next-line globalConsole:off - the fixture reports its runtime branch.
  console.log(await runStandaloneNodeSqliteBoundary());
}
