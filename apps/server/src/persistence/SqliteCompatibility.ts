import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import { DATABASE_INCOMPATIBLE_EXIT_CODE } from "@t3tools/contracts";

import { migrationManifest } from "./Migrations.ts";
import {
  classifyAppendedNativeWebhookJournal,
  classifyNativeWebhookJournal,
  isNativeCollisionSchemaAbsent,
  isNativeWebhookJournalSchemaCompatible,
  isSupportedDeployedForkJournal,
  isSupportedPriorPortJournal,
} from "./ForkSqliteMigration.ts";
import {
  inspectSqliteDatabase,
  type SqliteMigrationJournalObservation,
} from "./SqliteInspection.ts";

type PresentMigrationJournal = Extract<
  SqliteMigrationJournalObservation,
  { readonly _tag: "Present" }
>;

export class SqliteCompatibilityError extends Schema.TaggedError<SqliteCompatibilityError>()(
  "SqliteCompatibilityError",
  {
    dbPath: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override readonly [Runtime.errorExitCode] = DATABASE_INCOMPATIBLE_EXIT_CODE;

  override get message(): string {
    return `SQLite database at ${this.dbPath} is not compatible: ${this.reason}. No source migrations or application writes were attempted. Keep this database unchanged. Use the original compatible application or select a separate native database/home. Do not edit the migration journal or attempt in-place repair.`;
  }
}

const validateMigrationJournal = (dbPath: string, journal: PresentMigrationJournal) =>
  Effect.gen(function* () {
    const nativeWebhookState = classifyNativeWebhookJournal(journal.rows, migrationManifest);
    const deployedForkJournal = isSupportedDeployedForkJournal(journal.rows, migrationManifest);
    const priorPortJournal = isSupportedPriorPortJournal(journal.rows, migrationManifest);
    const appendedNativeWebhookState = classifyAppendedNativeWebhookJournal(
      journal.rows,
      migrationManifest,
    );
    const claimsPortCollisionBody = journal.rows.some(
      (row) =>
        (row.migration_id === 57 && row.name === "PendingInteractionResponses") ||
        (row.migration_id === 58 && row.name === "RunAcceptanceSequence"),
    );
    const webhookStateToValidate = nativeWebhookState ?? appendedNativeWebhookState;
    if (webhookStateToValidate !== undefined) {
      if (!(yield* isNativeWebhookJournalSchemaCompatible(dbPath, webhookStateToValidate))) {
        return yield* new SqliteCompatibilityError({
          dbPath,
          reason: "The native scheduled-task webhook migration schema does not match its journal",
        });
      }
    } else if (claimsPortCollisionBody) {
      if (!(yield* isNativeCollisionSchemaAbsent(dbPath))) {
        return yield* new SqliteCompatibilityError({
          dbPath,
          reason: "The port migration journal conflicts with native scheduled-task webhook schema",
        });
      }
    }

    if (deployedForkJournal) {
      return journal.rows.at(-1)?.migration_id ?? 0;
    }

    if (nativeWebhookState !== undefined) {
      return nativeWebhookState.latestMigrationId;
    }

    if (priorPortJournal) {
      return journal.rows.at(-1)?.migration_id ?? 0;
    }

    if (journal.rows.length > migrationManifest.length) {
      return yield* new SqliteCompatibilityError({
        dbPath,
        reason: "The migration journal contains an unknown higher migration",
      });
    }

    let previousMigrationId = 0;
    for (const [index, row] of journal.rows.entries()) {
      if (!Number.isSafeInteger(row.migration_id) || row.migration_id <= 0) {
        return yield* new SqliteCompatibilityError({
          dbPath,
          reason: "The migration journal contains a non-positive or unsafe migration ID",
        });
      }

      if (row.migration_id <= previousMigrationId) {
        return yield* new SqliteCompatibilityError({
          dbPath,
          reason: "The migration journal contains duplicate or out-of-order migration IDs",
        });
      }

      if (row.created_at.length === 0) {
        return yield* new SqliteCompatibilityError({
          dbPath,
          reason: "The migration journal contains an empty creation timestamp",
        });
      }

      const expected = migrationManifest[index];
      if (expected === undefined) {
        return yield* new SqliteCompatibilityError({
          dbPath,
          reason: "The migration journal contains a migration outside the compiled manifest",
        });
      }

      const [expectedMigrationId, expectedName] = expected;
      // Native installations may have recorded this one site-local migration
      // in the otherwise contiguous journal. The native migrator historically
      // skipped its own migration 41 by ID and logged the name divergence.
      const supportedLocalMigration41 =
        index === 40 && row.migration_id === 41 && row.name === "ThreadSummaryTimeline";
      if (
        (row.migration_id !== expectedMigrationId || row.name !== expectedName) &&
        !supportedLocalMigration41
      ) {
        return yield* new SqliteCompatibilityError({
          dbPath,
          reason:
            "The migration journal is not an exact contiguous prefix of the compiled manifest",
        });
      }

      previousMigrationId = row.migration_id;
    }

    const lastRow = journal.rows.at(-1);
    return lastRow === undefined ? 0 : lastRow.migration_id;
  });

const isV2PreviewJournal = (rows: PresentMigrationJournal["rows"]): boolean => {
  if (rows.length < 53 || rows.length > 55) return false;

  let suffixIndex = 52;
  const firstSuffix = rows[suffixIndex];
  const includePullRequestFilesViewed =
    firstSuffix?.migration_id === 53 && firstSuffix.name === "PullRequestFilesViewed";
  if (includePullRequestFilesViewed) suffixIndex++;

  const v2Preview = rows[suffixIndex];
  if (v2Preview?.migration_id === 53 && v2Preview.name === "OrchestrationV2") {
    return suffixIndex === 52 && rows.length === 53;
  }

  if (v2Preview?.migration_id !== 54 || v2Preview.name !== "OrchestrationV2") {
    return false;
  }
  suffixIndex++;

  const cleanup = rows[suffixIndex];
  const includeIndexCleanup =
    cleanup?.migration_id === 55 && cleanup.name === "RemoveRedundantProjectionIndexes";
  if (includeIndexCleanup) suffixIndex++;
  return suffixIndex === rows.length;
};

const validatePreviewMigrationJournal = (dbPath: string, journal: PresentMigrationJournal) =>
  Effect.gen(function* () {
    if (!isV2PreviewJournal(journal.rows)) return false;

    const prefix = { ...journal, rows: journal.rows.slice(0, 52) };
    yield* validateMigrationJournal(dbPath, prefix);

    if (journal.rows.slice(52).some((row) => row.created_at.length === 0)) {
      return yield* new SqliteCompatibilityError({
        dbPath,
        reason: "The V2 preview journal contains an empty creation timestamp",
      });
    }

    return true;
  });

/**
 * Recognize the exact shipped fork journal and native journals before a
 * writable open can run migrations against an unknown schema lineage.
 */
export const assertSqliteDatabaseCompatible = Effect.fn("assertSqliteDatabaseCompatible")(
  function* (dbPath: string) {
    const observation = yield* inspectSqliteDatabase(dbPath);
    if (observation._tag === "Missing") return;

    const journal = observation.migrationJournal;
    if (journal._tag === "Absent") {
      if (observation.schema.length === 0) return;
      return yield* new SqliteCompatibilityError({
        dbPath,
        reason: "The database has noninternal schema objects but no migration journal",
      });
    }

    // Keep the official native preview journals accepted by native upgrades.
    if (yield* validatePreviewMigrationJournal(dbPath, journal)) return;
    yield* validateMigrationJournal(dbPath, journal);
  },
);
