import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import * as NodeSqlite from "node:sqlite";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { layerFromPath } from "../persistence/Sqlite.ts";
import { RemoteCliError } from "./remoteHttp.ts";
import { layer as remoteLocalAuthLayer, LOCAL_CLI_SESSION_LABEL } from "./remoteLocalAuth.ts";
import { LocalCliSessionIssuer } from "./remoteAuth.ts";

type LocalCliTarget = Parameters<LocalCliSessionIssuer["Service"]["issue"]>[0];

const environmentId = EnvironmentId.make("environment-local-cli-test");

const descriptor = {
  environmentId,
  label: "Local environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.40",
  capabilities: { repositoryIdentity: false },
} satisfies ExecutionEnvironmentDescriptor;

const THIRTY_DAYS_MS = Duration.toMillis(Duration.days(30));
const isRemoteCliError = Schema.is(RemoteCliError);

const makeLocalTarget = Effect.fn("remoteLocalAuth.test.makeLocalTarget")(function* (
  baseDir: string,
) {
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
  );
  return {
    kind: "local",
    httpBaseUrl: "http://127.0.0.1:3773",
    environment: descriptor,
    tokenStateDirectory: path.join(baseDir, "local-cli"),
    tokenKey: `environment:${descriptor.environmentId}`,
    serverConfig,
  } satisfies LocalCliTarget;
});

const withIsolatedHome = <A, E, R>(run: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "remote-local-auth-" });
      return yield* run(baseDir);
    }),
  );

const provideNodeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const issuerIssue = (target: LocalCliTarget) =>
  Effect.gen(function* () {
    const issuer = yield* LocalCliSessionIssuer;
    return yield* issuer.issue(target);
  }).pipe(Effect.provide(remoteLocalAuthLayer));

/** Runs the issuer with the production layer capturing every FileSystem call. */
const issuerIssueWithCounting = (target: LocalCliTarget, counts: { operations: number }) =>
  Effect.gen(function* () {
    const realFileSystem = yield* FileSystem.FileSystem;
    return yield* Effect.gen(function* () {
      const issuer = yield* LocalCliSessionIssuer;
      return yield* issuer.issue(target);
    }).pipe(
      Effect.provide(remoteLocalAuthLayer),
      Effect.provideService(FileSystem.FileSystem, countingFileSystem(realFileSystem, counts)),
    );
  });

const countingFileSystem = (
  fileSystem: FileSystem.FileSystem,
  counts: { operations: number },
): FileSystem.FileSystem =>
  new Proxy(fileSystem, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: Array<unknown>) => {
        counts.operations += 1;
        return (value as (...innerArgs: Array<unknown>) => unknown).apply(target, args);
      };
    },
  });

/**
 * Fixture-only setup: seeds the pinned identity and runs the real native
 * persistence initialization outside `issue`, so the issuer reuses an existing
 * database instead of creating one.
 */
const preseedPinnedState = (target: LocalCliTarget) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(target.serverConfig.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(
        target.serverConfig.environmentIdPath,
        `${environmentId}\n`,
      );
      yield* Layer.build(layerFromPath(target.serverConfig.dbPath));
    }),
  );

/**
 * Rolls the migration bookkeeping back to before the first non-idempotent
 * migration (006 adds a column without IF NOT EXISTS) using the real native
 * client, so the next acquisition must re-run it and fail as a native defect.
 */
const rollBackMigrationBookkeeping = (target: LocalCliTarget) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* Effect.service(SqlClient.SqlClient).pipe(
        Effect.provide(yield* Layer.build(layerFromPath(target.serverConfig.dbPath))),
      );
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 6`;
    }),
  );

/**
 * Runs the issuer with a FileSystem proxy that rewrites the persisted identity
 * file right before the second read — the critical-section re-read —
 * simulating an identity change between check and issuance.
 */
const issuerIssueWithIdentityRewrite = (target: LocalCliTarget, driftedId: string) =>
  Effect.gen(function* () {
    const realFileSystem = yield* FileSystem.FileSystem;
    let identityReads = 0;
    const hookedFileSystem: FileSystem.FileSystem = new Proxy(realFileSystem, {
      get(fsTarget, property, receiver) {
        const value = Reflect.get(fsTarget, property, receiver);
        if (typeof value !== "function") {
          return value;
        }
        if (property !== "readFileString") {
          return (...args: Array<unknown>) =>
            (value as (...innerArgs: Array<unknown>) => unknown).apply(fsTarget, args);
        }
        return (path: string, ...rest: Array<unknown>) => {
          if (path !== target.serverConfig.environmentIdPath) {
            return (value as (...innerArgs: Array<unknown>) => unknown).apply(fsTarget, [
              path,
              ...rest,
            ]);
          }
          identityReads += 1;
          if (identityReads !== 2) {
            return (value as (...innerArgs: Array<unknown>) => unknown).apply(fsTarget, [
              path,
              ...rest,
            ]);
          }
          const realRead = () =>
            (value as (...innerArgs: Array<unknown>) => Effect.Effect<string, never>).apply(
              fsTarget,
              [path, ...rest],
            );
          return Effect.andThen(
            realFileSystem.writeFileString(target.serverConfig.environmentIdPath, `${driftedId}\n`),
            realRead(),
          );
        };
      },
    });
    return yield* Effect.gen(function* () {
      const issuer = yield* LocalCliSessionIssuer;
      return yield* issuer.issue(target);
    }).pipe(
      Effect.provide(remoteLocalAuthLayer),
      Effect.provideService(FileSystem.FileSystem, hookedFileSystem),
    );
  });

/**
 * Installs a call-order spy on the native SQLite statement preparer and runs
 * the issuer, restoring the prototype afterwards. Records every SQL string in
 * execution order across all connections.
 */
const withSqliteCallOrderSpy =
  (calls: Array<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const originalPrepare = NodeSqlite.DatabaseSync.prototype.prepare;
    NodeSqlite.DatabaseSync.prototype.prepare = function (
      this: NodeSqlite.DatabaseSync,
      sql: string,
    ) {
      calls.push(sql);
      return originalPrepare.call(this, sql);
    };
    return Effect.ensuring(
      effect,
      Effect.sync(() => {
        NodeSqlite.DatabaseSync.prototype.prepare = originalPrepare;
      }),
    );
  };

const stateDirectoryEntries = (target: LocalCliTarget) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem
      .readDirectory(target.serverConfig.stateDir)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  });

const snapshotFile = (filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const bytes = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => undefined));
    return bytes === undefined ? "absent" : NodeBuffer.Buffer.from(bytes).toString("base64");
  });

const snapshotNativeDatabaseFiles = (target: LocalCliTarget) =>
  Effect.all([
    snapshotFile(target.serverConfig.dbPath),
    snapshotFile(`${target.serverConfig.dbPath}-wal`),
    snapshotFile(`${target.serverConfig.dbPath}-shm`),
  ]);

/** Installs a recording logger as the only logger; returns the capture. */
const withRecordingLogger = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  captured: { lines: Array<string>; annotations: Array<Record<string, unknown>> },
) =>
  effect.pipe(
    Effect.provide(
      Logger.layer(
        [
          Logger.make(({ fiber, message }) => {
            captured.lines.push(String(message));
            captured.annotations.push({
              ...fiber.getRef(References.CurrentLogAnnotations),
            });
          }),
        ],
        { mergeWithExisting: false },
      ),
    ),
  );

const emptyCapture = () => ({
  lines: [] as Array<string>,
  annotations: [] as Array<Record<string, unknown>>,
});

/**
 * Full-cause capture: the failure cause must contain only sanitized
 * RemoteCliError failures — no Die reasons, no raw defects.
 */
const assertOnlySanitizedFailure = (
  exit: Exit.Exit<unknown, RemoteCliError>,
  expectedReason: "local-server-mismatch" | "request-failed",
) => {
  assert.isTrue(Exit.isFailure(exit));
  if (!Exit.isFailure(exit)) return;
  const reasons = exit.cause.reasons;
  assert.isTrue(reasons.length > 0);
  for (const reason of reasons) {
    if (!Cause.isFailReason(reason)) {
      assert.fail("expected only Fail reasons, no defects");
      continue;
    }
    assert.isTrue(isRemoteCliError(reason.error));
    assert.equal((reason.error as RemoteCliError).reason, expectedReason);
  }
};

const assertNoSentinels = (
  captured: { lines: Array<string>; annotations: Array<Record<string, unknown>> },
  sentinels: ReadonlyArray<string>,
) => {
  const serialized = [
    ...captured.lines,
    ...captured.annotations.map((entry) => JSON.stringify(entry)),
  ].join("\n");
  for (const sentinel of sentinels) {
    assert.isFalse(serialized.includes(sentinel), `log leak of sentinel: ${sentinel}`);
  }
};

/** Lists the sessions the native auth stack actually persisted for the issue. */
const inspectPersistedSessions = (target: LocalCliTarget) =>
  Effect.scoped(
    Effect.gen(function* () {
      const environmentAuth = yield* Effect.service(EnvironmentAuth.EnvironmentAuth).pipe(
        Effect.provide(
          yield* Layer.build(
            EnvironmentAuth.layerRuntime.pipe(
              Layer.provide(ServerConfig.layer(target.serverConfig)),
            ),
          ),
        ),
      );
      return yield* environmentAuth.listSessions();
    }),
  );

/** Builds the issuer layer under a counting FileSystem; construction must touch nothing. */
const buildIssuerLayerInertly = (counts: { operations: number }) =>
  Effect.gen(function* () {
    const realFileSystem = yield* FileSystem.FileSystem;
    return yield* Layer.build(remoteLocalAuthLayer).pipe(
      Effect.provideService(FileSystem.FileSystem, countingFileSystem(realFileSystem, counts)),
    );
  }).pipe(Effect.provide(NodeServices.layer));

describe("remote local CLI session issuer", () => {
  it.effect("construction is inert: zero filesystem operations and zero acquisition", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = yield* makeLocalTarget(baseDir);
          const initialEntries = yield* fileSystem.readDirectory(baseDir, { recursive: true });
          const counts = { operations: 0 };

          yield* buildIssuerLayerInertly(counts);

          assert.equal(counts.operations, 0);
          assert.deepEqual(
            yield* fileSystem.readDirectory(baseDir, { recursive: true }),
            initialEntries,
          );
          assert.equal(target.serverConfig.dbPath.startsWith(baseDir), true);
          assert.isFalse(yield* fileSystem.exists(target.serverConfig.dbPath));
        }),
      ),
    ),
  );

  it.effect("refuses a missing pinned identity without any persistence operation", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = yield* makeLocalTarget(baseDir);

          const exit = yield* Effect.exit(issuerIssue(target));

          assertOnlySanitizedFailure(exit, "local-server-mismatch");
          assert.isFalse(yield* fileSystem.exists(target.serverConfig.environmentIdPath));
          assert.isFalse(yield* fileSystem.exists(target.serverConfig.dbPath));
          if (!Exit.isFailure(exit)) return;
          assert.isFalse(
            (exit.cause.reasons[0] as Cause.Fail<RemoteCliError>).error.message.includes(
              target.serverConfig.environmentIdPath,
            ),
          );
        }),
      ),
    ),
  );

  it.effect("refuses an empty pinned identity without any persistence operation", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = yield* makeLocalTarget(baseDir);
          yield* fileSystem.makeDirectory(target.serverConfig.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(target.serverConfig.environmentIdPath, "   \n");
          const stateEntries = yield* stateDirectoryEntries(target);

          const exit = yield* Effect.exit(issuerIssue(target));

          assertOnlySanitizedFailure(exit, "local-server-mismatch");
          assert.isFalse(yield* fileSystem.exists(target.serverConfig.dbPath));
          assert.deepEqual(yield* stateDirectoryEntries(target), stateEntries);
        }),
      ),
    ),
  );

  it.effect("refuses a valid identity with a missing database before acquisition", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = yield* makeLocalTarget(baseDir);
          yield* fileSystem.makeDirectory(target.serverConfig.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(
            target.serverConfig.environmentIdPath,
            `${environmentId}\n`,
          );
          const stateEntries = yield* stateDirectoryEntries(target);
          const counts = { operations: 0 };

          const exit = yield* Effect.exit(issuerIssueWithCounting(target, counts));

          // Exactly the precondition reads: identity read + database stat,
          // nothing else — no acquisition.
          assert.equal(counts.operations, 2);
          assertOnlySanitizedFailure(exit, "local-server-mismatch");
          assert.deepEqual(yield* stateDirectoryEntries(target), stateEntries);
        }),
      ),
    ),
  );

  it.effect(
    "refuses a nonempty identity mismatch against a valid seeded database before acquisition",
    () =>
      provideNodeServices(
        withIsolatedHome((baseDir) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const target = yield* makeLocalTarget(baseDir);
            yield* preseedPinnedState(target);
            yield* fileSystem.writeFileString(
              target.serverConfig.environmentIdPath,
              "environment-drifted\n",
            );
            const before = yield* snapshotNativeDatabaseFiles(target);
            const sessionsBefore = yield* inspectPersistedSessions(target);
            const counts = { operations: 0 };

            const exit = yield* Effect.exit(issuerIssueWithCounting(target, counts));

            // Exactly one precondition op (the identity read); the database is
            // never stat-ed into acquisition and no native connection is made.
            assert.equal(counts.operations, 1);
            assertOnlySanitizedFailure(exit, "local-server-mismatch");
            // Database, WAL, and SHM bytes are untouched and no session appeared.
            assert.deepEqual(yield* snapshotNativeDatabaseFiles(target), before);
            assert.deepEqual(yield* inspectPersistedSessions(target), sessionsBefore);
            assert.lengthOf(sessionsBefore, 0);
          }),
        ),
      ),
  );

  it.effect("refuses a database that is not a regular file before acquisition", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = yield* makeLocalTarget(baseDir);
          yield* preseedPinnedState(target);
          yield* fileSystem.remove(target.serverConfig.dbPath);
          yield* fileSystem.makeDirectory(target.serverConfig.dbPath);

          const exit = yield* Effect.exit(issuerIssue(target));

          assertOnlySanitizedFailure(exit, "local-server-mismatch");
        }),
      ),
    ),
  );

  it.effect(
    "issues into the pre-seeded database with the exact subject, scopes, and 30-day expiry",
    () =>
      provideNodeServices(
        withIsolatedHome((baseDir) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const target = yield* makeLocalTarget(baseDir);
            yield* preseedPinnedState(target);
            assert.isTrue(yield* fileSystem.exists(target.serverConfig.dbPath));

            const nowBefore = (yield* DateTime.now).epochMilliseconds;
            const token = yield* issuerIssue(target);

            assert.equal(token.expiresAtEpochMs, nowBefore + THIRTY_DAYS_MS);
            assert.isTrue(token.accessToken.length > 0);

            const sessions = yield* inspectPersistedSessions(target);
            const issued = sessions.find(
              (session) => session.subject === `local-cli:${environmentId}`,
            );
            assert.isDefined(issued);
            assert.deepEqual(issued.scopes, [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]);
            assert.equal(issued.client.label, LOCAL_CLI_SESSION_LABEL);
            assert.equal(issued.expiresAt.epochMilliseconds, nowBefore + THIRTY_DAYS_MS);
          }),
        ),
      ),
  );

  it.effect(
    "converts a real native migration defect into a sanitized failure without log leaks",
    () =>
      provideNodeServices(
        withIsolatedHome((baseDir) =>
          Effect.gen(function* () {
            const target = yield* makeLocalTarget(baseDir);
            yield* preseedPinnedState(target);
            // Forces a re-run of migration 006 (ALTER TABLE ADD COLUMN without
            // IF NOT EXISTS): the migrator converts the SQL failure into a
            // native defect during acquisition.
            yield* rollBackMigrationBookkeeping(target);
            const captured = emptyCapture();

            const exit = yield* Effect.exit(withRecordingLogger(issuerIssue(target), captured));

            // Full-cause capture: only a sanitized Fail, never a Die.
            assertOnlySanitizedFailure(exit, "request-failed");
            // No raw cause, path, or schema detail in any escaped log line.
            assertNoSentinels(captured, [
              baseDir,
              target.serverConfig.dbPath,
              "duplicate column",
              "runtime_mode",
            ]);
          }),
        ),
      ),
  );

  it.effect("sanitizes a corrupt-database acquisition failure without log leaks", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = yield* makeLocalTarget(baseDir);
          yield* preseedPinnedState(target);
          yield* fileSystem.remove(`${target.serverConfig.dbPath}-wal`, { force: true });
          yield* fileSystem.remove(`${target.serverConfig.dbPath}-shm`, { force: true });
          yield* fileSystem.writeFileString(target.serverConfig.dbPath, "not a database");
          const captured = emptyCapture();

          const exit = yield* Effect.exit(withRecordingLogger(issuerIssue(target), captured));

          assertOnlySanitizedFailure(exit, "request-failed");
          assertNoSentinels(captured, [baseDir, target.serverConfig.dbPath, "not a database"]);
        }),
      ),
    ),
  );

  it.effect(
    "fails a mid-flight identity change without issuing, writing tokens, or mutating identity",
    () =>
      provideNodeServices(
        withIsolatedHome((baseDir) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const target = yield* makeLocalTarget(baseDir);
            yield* preseedPinnedState(target);

            const exit = yield* Effect.exit(
              issuerIssueWithIdentityRewrite(target, "environment-raced"),
            );

            // Exactly one sanitized failure with the mismatch reason.
            assertOnlySanitizedFailure(exit, "local-server-mismatch");
            // The issuer never rewrote or regenerated identity: the file holds
            // exactly what the simulated racer wrote.
            assert.equal(
              yield* fileSystem.readFileString(target.serverConfig.environmentIdPath),
              "environment-raced\n",
            );
            // No token was issued into the database.
            assert.lengthOf(yield* inspectPersistedSessions(target), 0);
          }),
        ),
      ),
  );

  it.effect("runs the read-only compatibility guard before any writable open", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const target = yield* makeLocalTarget(baseDir);
          yield* preseedPinnedState(target);
          const calls: Array<string> = [];

          const token = yield* withSqliteCallOrderSpy(calls)(issuerIssue(target));

          assert.isTrue(token.accessToken.length > 0);
          const guardIndex = calls.findIndex((sql) => sql.includes("FROM effect_sql_migrations"));
          const firstWritableIndex = calls.findIndex((sql) => sql.startsWith("PRAGMA"));
          assert.isTrue(guardIndex !== -1, "guard query never ran");
          assert.isTrue(firstWritableIndex !== -1, "writable acquisition never ran");
          assert.isTrue(guardIndex < firstWritableIndex, "guard ran after writable open");
        }),
      ),
    ),
  );

  it.effect("guard failure fails closed with no writable open or journal mutation", () =>
    provideNodeServices(
      withIsolatedHome((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const target = yield* makeLocalTarget(baseDir);
          yield* preseedPinnedState(target);
          // A regular but schemaless database: the read-only guard must reject
          // it before the writable path is ever attempted.
          yield* fileSystem.remove(`${target.serverConfig.dbPath}-wal`, { force: true });
          yield* fileSystem.remove(`${target.serverConfig.dbPath}-shm`, { force: true });
          yield* fileSystem.writeFileString(target.serverConfig.dbPath, "");
          const captured = emptyCapture();

          const exit = yield* Effect.exit(withRecordingLogger(issuerIssue(target), captured));

          assertOnlySanitizedFailure(exit, "request-failed");
          assertNoSentinels(captured, [baseDir, target.serverConfig.dbPath]);
          // No journal or WAL mutation, and the file itself is untouched.
          assert.equal(yield* snapshotFile(target.serverConfig.dbPath), "");
          assert.equal(yield* snapshotFile(`${target.serverConfig.dbPath}-wal`), "absent");
          assert.equal(yield* snapshotFile(`${target.serverConfig.dbPath}-shm`), "absent");
        }),
      ),
    ),
  );
});
