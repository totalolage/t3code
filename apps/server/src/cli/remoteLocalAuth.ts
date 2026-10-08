import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { migrationManifest } from "../persistence/Migrations.ts";
import * as RuntimeSqliteClient from "../persistence/RuntimeSqliteClient.ts";
import { LocalCliSessionIssuer } from "./remoteAuth.ts";
import { RemoteCliError } from "./remoteHttp.ts";
import type { StoredRemoteToken } from "./remoteTokenStore.ts";

type LocalCliTarget = Parameters<LocalCliSessionIssuer["Service"]["issue"]>[0];

const LOCAL_CLI_SESSION_SUBJECT_PREFIX = "local-cli:";
export const LOCAL_CLI_SESSION_LABEL = "T3 local CLI";
const LOCAL_CLI_SESSION_TTL = Duration.days(30);

const LOCAL_CLI_SESSION_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
] as const satisfies ReadonlyArray<AuthEnvironmentScope>;

const identityMismatchError = () => new RemoteCliError({ reason: "local-server-mismatch" });
const requestFailedError = () => new RemoteCliError({ reason: "request-failed" });
const isRemoteCliError = Schema.is(RemoteCliError);

/**
 * Guarded read-only compatibility check against the pinned database: opens the
 * same native client stack as persistence but with readonly: true, so neither
 * journal, WAL, nor SHM can be mutated. Verifies the migration registry
 * against the read-only migration manifest (every applied id known, applied
 * set a contiguous prefix — exactly what runMigrations expects to continue
 * from). Must run before any writable open driven by this seam; any failure
 * fails closed as a sanitized error and no writable open ever happens.
 */
const verifyDatabaseCompatibleReadOnly = (dbPath: string) =>
  Effect.gen(function* () {
    const clientLayer = RuntimeSqliteClient.makeRuntimeSqliteLayer({
      filename: dbPath,
      readonly: true,
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient.pipe(
          Effect.provide(yield* Layer.build(clientLayer)),
        );
        const rows =
          (yield* sql`SELECT migration_id FROM effect_sql_migrations ORDER BY migration_id`) as ReadonlyArray<{
            readonly migration_id: unknown;
          }>;
        const manifestIds: Array<number> = migrationManifest.map(([id]) => id);
        const appliedIds: Array<number> = [];
        for (const row of rows) {
          const id = row.migration_id;
          if (typeof id !== "number" || !manifestIds.includes(id)) {
            return yield* requestFailedError();
          }
          appliedIds.push(id);
        }
        const expectedIds = manifestIds.slice(0, appliedIds.length);
        if (expectedIds.some((expected, index) => expected !== appliedIds[index])) {
          return yield* requestFailedError();
        }
      }),
    );
  }).pipe(Effect.mapError(() => requestFailedError()));

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  // Captured here so `issue` can keep the service's R = never; the platform
  // services are only handed to the native auth stack during acquisition.
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  /**
   * Read-only re-checks of the pinned environment identity file and the pinned
   * state database, both against the target's pinned server config. Both must
   * pass before the native auth stack (which owns SQLite initialization and
   * migrations) is acquired, so a missing or drifted environment never
   * triggers persistence: no database, directories, or identity creation.
   * There is deliberately no generation or default home discovery here: the
   * Root layer composes the approved identity guard.
   */
  const requirePinnedIdentityAndDatabase = Effect.fn("remoteLocalAuth.requirePinnedState")(
    function* (target: LocalCliTarget) {
      const persisted = yield* fileSystem
        .readFileString(target.serverConfig.environmentIdPath)
        .pipe(
          Effect.map((value) => value.trim()),
          Effect.catch(() => identityMismatchError()),
        );
      if (persisted.length === 0 || persisted !== target.environment.environmentId) {
        return yield* identityMismatchError();
      }

      const database = yield* fileSystem
        .stat(target.serverConfig.dbPath)
        .pipe(Effect.catch(() => identityMismatchError()));
      if (database.type !== "File") {
        return yield* identityMismatchError();
      }

      return persisted;
    },
  );

  const issue = (target: LocalCliTarget) =>
    Effect.gen(function* () {
      if (target.kind !== "local") {
        return yield* new RemoteCliError({ reason: "invalid-input" });
      }

      // Pre-check before the guarded read-only compatibility gate and the
      // writable acquisition; re-verified inside the critical section below.
      yield* requirePinnedIdentityAndDatabase(target);

      // Read-only compatibility gate: runs before the native auth stack (the
      // only writable SQLite open driven by this seam) and fails closed.
      yield* verifyDatabaseCompatibleReadOnly(target.serverConfig.dbPath);

      // The native auth runtime performs SQLite initialization and migrations
      // at acquisition, so it is built per call inside this scope and only
      // after the pinned re-checks above, with the pinned server config from
      // the target. The cause sanitizer sits OUTSIDE the scope so defects from
      // acquisition, use, and finalization (the migrator and the SQLite
      // client convert failures to defects, and the dynamic import and close
      // finalizer can defect) all leave as sanitized RemoteCliErrors. Pure
      // interruption passes through untouched.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const environmentAuth = yield* Effect.service(EnvironmentAuth.EnvironmentAuth).pipe(
            Effect.provide(
              yield* Layer.build(
                EnvironmentAuth.layerRuntime.pipe(
                  Layer.provide(ServerConfig.layer(target.serverConfig)),
                  Layer.provide(
                    Layer.mergeAll(
                      Layer.succeed(FileSystem.FileSystem, fileSystem),
                      Layer.succeed(Path.Path, path),
                      Layer.succeed(Crypto.Crypto, crypto),
                    ),
                  ),
                ),
              ).pipe(Effect.mapError(() => new RemoteCliError({ reason: "request-failed" }))),
            ),
          );
          // Identity-change race guard: the persisted identity file is
          // re-read inside the acquisition critical section, immediately
          // before issuance, so a file rewritten between the pre-check and
          // acquisition can never receive a token or mutate identity.
          const criticalSectionIdentity = yield* requirePinnedIdentityAndDatabase(target);
          const issued = yield* environmentAuth
            .issueSession({
              subject: `${LOCAL_CLI_SESSION_SUBJECT_PREFIX}${criticalSectionIdentity}`,
              label: LOCAL_CLI_SESSION_LABEL,
              ttl: LOCAL_CLI_SESSION_TTL,
              scopes: [...LOCAL_CLI_SESSION_SCOPES],
            })
            .pipe(
              // Typed native failures are sanitized at the source so the
              // precondition classifications stay untouched.
              Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })),
            );
          return {
            accessToken: issued.token,
            expiresAtEpochMs: issued.expiresAt.epochMilliseconds,
          } satisfies StoredRemoteToken;
        }),
      ).pipe(
        // Sanitizer: only causes that contain something other than typed
        // sanitized RemoteCliError failures are replaced (native defects from
        // acquisition, use, and finalization). Pure interruption passes
        // through untouched, and a critical-section identity mismatch keeps
        // its `local-server-mismatch` reason.
        Effect.catchCauseIf(
          (cause) =>
            !Cause.hasInterruptsOnly(cause) &&
            cause.reasons.some(
              (reason) =>
                !Cause.isFailReason(reason) || !isRemoteCliError(reason.error as RemoteCliError),
            ),
          () => Effect.fail(requestFailedError()),
        ),
        // Attempt-local suppression: native persistence and auth dependencies
        // can log raw causes (paths, schema details). The installed logger set
        // is emptied for this attempt only; the process-default logger
        // configuration is untouched outside it.
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set() as ReadonlySet<Logger.Logger<unknown, any>>,
        ),
      );
    });

  return LocalCliSessionIssuer.of({ issue });
});

/** Construction is inert: nothing is read, written, or acquired until issue. */
export const layer = Layer.effect(LocalCliSessionIssuer, make);
