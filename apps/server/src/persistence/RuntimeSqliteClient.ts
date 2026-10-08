/// <reference types="bun" />
// @effect-diagnostics nodeBuiltinImport:off - native SQLite imports are runtime-selected.
import type * as BunSqlite from "bun:sqlite";
import type * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly readonly?: boolean;
  readonly spanAttributes?: Record<string, unknown>;
};

type Loader = {
  readonly layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};

declare const __T3CODE_BUILD_SQLITE_RUNTIME__: "node" | undefined;
declare const __T3_BUN_STANDALONE__: boolean | undefined;

type RuntimeReadonlySqliteDatabase = BunSqlite.Database | NodeSqlite.DatabaseSync;

const loadSqliteClient = (): Promise<Loader> => {
  if (typeof __T3CODE_BUILD_SQLITE_RUNTIME__ !== "undefined") {
    return import("@t3tools/shared/nodeSqliteClient");
  }
  if (typeof __T3_BUN_STANDALONE__ !== "undefined" && __T3_BUN_STANDALONE__) {
    return import("@effect/sql-sqlite-bun/SqliteClient");
  }
  return process.versions.bun !== undefined
    ? import("@effect/sql-sqlite-bun/SqliteClient")
    : import("@t3tools/shared/nodeSqliteClient");
};

/** Open an existing database read-only through the active runtime's native driver. */
export const openRuntimeSqliteReadOnly = async (
  filename: string,
): Promise<RuntimeReadonlySqliteDatabase> => {
  if (typeof __T3CODE_BUILD_SQLITE_RUNTIME__ !== "undefined") {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(filename, { readOnly: true });
  }
  if (typeof __T3_BUN_STANDALONE__ !== "undefined" && __T3_BUN_STANDALONE__) {
    const { Database } = await import("bun:sqlite");
    return new Database(filename, { readonly: true });
  }
  if (process.versions.bun !== undefined) {
    const { Database } = await import("bun:sqlite");
    return new Database(filename, { readonly: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(filename, { readOnly: true });
};

/**
 * Select the native SQLite client without importing both runtime-specific
 * drivers. The readonly flag is passed through so inspection never falls
 * back to a creating or writable connection.
 */
export const makeRuntimeSqliteLayer = Effect.fn("makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const clientModule = yield* Effect.promise<Loader>(loadSqliteClient);
  return clientModule.layer(config);
}, Layer.unwrap);
