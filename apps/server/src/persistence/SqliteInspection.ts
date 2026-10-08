import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { makeRuntimeSqliteLayer } from "./RuntimeSqliteClient.ts";

const SQLITE_MIGRATIONS_TABLE = "effect_sql_migrations";

export const SqliteSchemaRowSchema = Schema.Struct({
  type: Schema.String,
  name: Schema.String,
  tbl_name: Schema.String,
  sql: Schema.NullOr(Schema.String),
});

export const SqliteTableInfoRowSchema = Schema.Struct({
  cid: Schema.Int,
  name: Schema.String,
  type: Schema.String,
  notnull: Schema.Int,
  dflt_value: Schema.NullOr(Schema.String),
  pk: Schema.Int,
});

export const SqliteMigrationRowSchema = Schema.Struct({
  migration_id: Schema.Int,
  name: Schema.String,
  created_at: Schema.String,
});

type RawSqlRow = Readonly<Record<string, unknown>>;

export type SqliteSchemaRow = Schema.Schema.Type<typeof SqliteSchemaRowSchema>;
export type SqliteTableInfoRow = Schema.Schema.Type<typeof SqliteTableInfoRowSchema>;
export type SqliteMigrationRow = Schema.Schema.Type<typeof SqliteMigrationRowSchema>;

export type SqliteMigrationJournalObservation =
  | {
      readonly _tag: "Absent";
    }
  | {
      readonly _tag: "Present";
      readonly tableInfo: ReadonlyArray<SqliteTableInfoRow>;
      readonly rows: ReadonlyArray<SqliteMigrationRow>;
    };

export type SqliteInspectionObservation =
  | {
      readonly _tag: "Missing";
      readonly dbPath: string;
    }
  | {
      readonly _tag: "Existing";
      readonly dbPath: string;
      readonly schema: ReadonlyArray<SqliteSchemaRow>;
      readonly migrationJournal: SqliteMigrationJournalObservation;
    };

// These observations report the database's current schema and recorded journal
// only. They do not establish migration lineage or semantic compatibility;
// callers must classify that provenance explicitly.

export class SqliteInspectionError extends Schema.TaggedError<SqliteInspectionError>()(
  "SqliteInspectionError",
  {
    dbPath: Schema.String,
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to inspect SQLite database at ${this.dbPath}: ${this.reason}. No target migrations or application writes were attempted; manual compatibility classification is required.`;
  }
}

const isSqliteInspectionError = Schema.is(SqliteInspectionError);

const inspectionError = (dbPath: string, reason: string, cause: unknown) =>
  new SqliteInspectionError({ dbPath, reason, cause });

const readExistingDatabase = Effect.fn("readExistingDatabase")(function* (dbPath: string) {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rawSchemaRows = yield* sql<RawSqlRow>`
        SELECT type, name, tbl_name, sql
        FROM sqlite_schema
        WHERE substr(name, 1, 7) <> 'sqlite_'
        ORDER BY type, name
      `;
      const schemaRows = yield* Schema.decodeUnknownEffect(Schema.Array(SqliteSchemaRowSchema))(
        rawSchemaRows,
      ).pipe(
        Effect.mapError((cause) =>
          inspectionError(
            dbPath,
            "The sqlite_schema query returned an unexpected row shape",
            cause,
          ),
        ),
      );

      const hasMigrationJournal = schemaRows.some(
        (row) => row.type === "table" && row.name === SQLITE_MIGRATIONS_TABLE,
      );
      if (!hasMigrationJournal) {
        return {
          _tag: "Existing",
          dbPath,
          schema: schemaRows,
          migrationJournal: { _tag: "Absent" },
        } as const;
      }

      const rawTableInfoRows = yield* sql<RawSqlRow>`
        PRAGMA table_info(effect_sql_migrations)
      `;
      const tableInfoRows = yield* Schema.decodeUnknownEffect(
        Schema.Array(SqliteTableInfoRowSchema),
      )(rawTableInfoRows).pipe(
        Effect.mapError((cause) =>
          inspectionError(
            dbPath,
            "The effect_sql_migrations table-info query returned an unexpected row shape",
            cause,
          ),
        ),
      );

      const rawMigrationRows = yield* sql<RawSqlRow>`
        SELECT migration_id, name, created_at
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      const migrationRows = yield* Schema.decodeUnknownEffect(
        Schema.Array(SqliteMigrationRowSchema),
      )(rawMigrationRows).pipe(
        Effect.mapError((cause) =>
          inspectionError(
            dbPath,
            "The effect_sql_migrations journal query returned an unexpected row shape",
            cause,
          ),
        ),
      );

      return {
        _tag: "Existing",
        dbPath,
        schema: schemaRows,
        migrationJournal: {
          _tag: "Present",
          tableInfo: tableInfoRows,
          rows: migrationRows,
        },
      } as const;
    }),
  );
});

const readExistingDatabaseScoped = (dbPath: string) =>
  readExistingDatabase(dbPath).pipe(
    Effect.scoped,
    Effect.provide(makeRuntimeSqliteLayer({ filename: dbPath, readonly: true })),
    Effect.mapError((cause) =>
      isSqliteInspectionError(cause)
        ? cause
        : inspectionError(
            dbPath,
            "The readonly SQLite database could not be opened or queried",
            cause,
          ),
    ),
    Effect.catchDefect((cause) =>
      Effect.fail(
        inspectionError(
          dbPath,
          "The readonly SQLite database could not be opened or queried",
          cause,
        ),
      ),
    ),
  );

export const inspectSqliteDatabase = Effect.fn("inspectSqliteDatabase")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.stat(dbPath).pipe(
    Effect.map(() => true),
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeed(false)
          : Effect.fail(inspectionError(dbPath, "The database path could not be inspected", cause)),
    }),
  );

  if (!exists) {
    return { _tag: "Missing", dbPath } as const;
  }

  return yield* readExistingDatabaseScoped(dbPath);
});
