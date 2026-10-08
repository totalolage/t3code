// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  HostProcessArchitecture,
  HostProcessExecutablePath,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { ServiceUpdateAttemptId, ServiceUpdateVersion } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { makeRuntimeSqliteLayer } from "../persistence/RuntimeSqliteClient.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  ServiceLauncherClient,
  ServiceLauncherClientError,
  ServiceLauncherRejectedError,
} from "./serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_CONTEXT_ENV, SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";
import { STAGED_ARTIFACT_FILENAME } from "./serviceUpdateSourceLive.ts";
import {
  makePreflightValidate,
  makeServiceUpdateRuntime,
  runtimeInstallPaths,
  ServiceUpdateRuntimeLive,
  type ServiceUpdateRuntimeLiveInput,
  type ServiceUpdateRuntimeLauncher,
} from "./serviceUpdateRuntimeLive.ts";
import {
  ServiceUpdateOperationError,
  ServiceUpdateRuntime,
  UpdateAuthorityError,
  type StagedServiceRuntime,
  type UpdateAuthorityLease,
  type ServiceUpdateSourceCapture,
} from "./serviceUpdateServices.ts";

const attemptId = ServiceUpdateAttemptId.make("11111111-1111-4111-8111-111111111111");
const VERSION = "1.2.4-f8y.20260101.2";
const TARGET_VERSION = ServiceUpdateVersion.make(VERSION);
const ARTIFACT_TEXT = "t3-runtime-artifact-bytes";
const ARTIFACT_BYTES = new TextEncoder().encode(ARTIFACT_TEXT);
const ARTIFACT_DIGEST = NodeCrypto.createHash("sha256").update(ARTIFACT_BYTES).digest("hex");

const sourceCapture = (databaseIdentity = "/tmp/db/state.sqlite"): ServiceUpdateSourceCapture => ({
  databaseIdentity,
  fromVersion: TARGET_VERSION,
});

const encodePreflightResult = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literal("ready"),
      version: Schema.String,
      launcherProtocol: Schema.Number,
      runtimeFormat: Schema.optional(Schema.Literals(["bun-standalone", "node-sea"])),
      supportsProtectedLauncher: Schema.optional(Schema.Literal(true)),
    }),
  ),
);

interface Harness {
  readonly root: string;
  readonly stagingDirectory: string;
  readonly staged: StagedServiceRuntime;
  readonly artifactPath: string;
  readonly dispose: () => void;
}

const makeHarness = (options: { readonly artifactText?: string } = {}): Harness => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-live-"));
  const stagingDirectory = NodePath.join(root, "staging", attemptId);
  NodeFS.mkdirSync(stagingDirectory, { recursive: true });
  const artifactPath = NodePath.join(stagingDirectory, STAGED_ARTIFACT_FILENAME);
  const artifactBytes = Buffer.from(options.artifactText ?? ARTIFACT_TEXT);
  NodeFS.writeFileSync(artifactPath, artifactBytes);
  const digest = NodeCrypto.createHash("sha256").update(artifactBytes).digest("hex");
  const staged: StagedServiceRuntime = {
    format: 1,
    attemptId,
    version: TARGET_VERSION,
    platform: "linux-x64",
    sha256: digest,
    bytes: artifactBytes.byteLength,
    stagingDirectory,
  };
  return {
    root,
    stagingDirectory,
    staged,
    artifactPath,
    dispose: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
};

const replaceHarnessArtifact = (harness: Harness, artifactText: string): Harness => {
  const bytes = Buffer.from(artifactText);
  NodeFS.writeFileSync(harness.artifactPath, bytes);
  return {
    ...harness,
    staged: {
      ...harness.staged,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    },
  };
};

const executablePreflightFixture = (input: {
  readonly version: string;
  readonly databasePath: string;
  readonly logPath: string;
  readonly runtimeFormat?: "bun-standalone" | "node-sea";
  readonly supportsProtectedLauncher?: true;
}): string => {
  const preflightResult = JSON.stringify({
    status: "ready",
    version: input.version,
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    ...(input.runtimeFormat === undefined ? {} : { runtimeFormat: input.runtimeFormat }),
    ...(input.supportsProtectedLauncher === undefined
      ? {}
      : { supportsProtectedLauncher: input.supportsProtectedLauncher }),
  });
  return `#!/bin/sh
printf '%s|%s\\n' "$0" "$*" >> ${JSON.stringify(input.logPath)}
if [ "$1" = "--version" ]; then
  printf 't3 v${input.version}\\n'
  exit 0
fi
if [ "$1" = "__service-preflight" ]; then
  [ "$#" -eq 5 ] || exit 21
  [ "$2" = "--database-path" ] || exit 22
  [ "$3" = ${JSON.stringify(input.databasePath)} ] || exit 23
  [ "$4" = "--launcher-protocol" ] || exit 24
  [ "$5" = "${SERVICE_LAUNCHER_PROTOCOL}" ] || exit 25
  printf '%s\\n' '${preflightResult}'
  exit 0
fi
exit 26
`;
};

const executableFixtureRunner: ProcessRunner.ProcessRunner["Service"] = {
  run: (input) =>
    Effect.sync(() => {
      const result = NodeChildProcess.spawnSync(input.command, [...input.args], {
        encoding: "utf8",
        env: input.env ?? process.env,
      });
      if (result.error !== undefined) throw result.error;
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.status as ProcessRunner.ProcessRunOutput["code"],
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      };
    }),
};

const makeLauncher = (
  overrides: Partial<ServiceUpdateRuntimeLauncher> & {
    readonly failWith?: "rejected" | "unmanaged" | "disconnect";
  } = {},
): {
  readonly launcher: ServiceUpdateRuntimeLauncher;
  readonly calls: Array<{ targetVersion: string; dbPath: string }>;
} => {
  const calls: Array<{ targetVersion: string; dbPath: string }> = [];
  const launcher: ServiceUpdateRuntimeLauncher = {
    managed: overrides.managed ?? true,
    requestUpdate: (input) => {
      calls.push(input);
      if (overrides.failWith === "rejected") {
        return Effect.fail(
          new ServiceLauncherRejectedError({
            targetVersion: input.targetVersion,
            reason: "target runtime is missing",
          }),
        );
      }
      if (overrides.failWith === "unmanaged") {
        return Effect.fail(new ServiceLauncherClientError({ operation: "unmanaged" }));
      }
      if (overrides.failWith === "disconnect") {
        return Effect.fail(new ServiceLauncherClientError({ operation: "disconnect" }));
      }
      return overrides.requestUpdate
        ? overrides.requestUpdate(input)
        : Effect.succeed("native-update-1");
    },
  };
  return { launcher, calls };
};

const runtimeInput = (
  overrides: Partial<ServiceUpdateRuntimeLiveInput> = {},
): ServiceUpdateRuntimeLiveInput => {
  const { launcher } = makeLauncher({ managed: overrides.launcher?.managed ?? true });
  return {
    launcher,
    baseDir: "/tmp/t3-runtime-base",
    dbPath: "/tmp/t3-runtime-base/userdata/state.sqlite",
    captureSource: () =>
      Effect.fail(
        new ServiceUpdateOperationError({
          stage: "runtime",
          code: "unavailable",
          cause: "source capture is not exercised by this runtime unit test",
        }),
      ),
    desktopManaged: false,
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    platform: "linux",
    architecture: "x64",
    validate: () => Effect.void,
    ...overrides,
  };
};

const createSqliteFile = (filename: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE capture_source_probe (value TEXT NOT NULL)`;
  }).pipe(Effect.provide(makeRuntimeSqliteLayer({ filename })));

it.layer(NodeServices.layer)("ServiceUpdateRuntimeLive source capture", (it) => {
  it.effect("captures the main database from the already-open SQLite client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-source-capture-")),
          ),
          (directory) =>
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const config = yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(process.cwd(), root)),
        );
        const sourceDatabase = NodePath.join(root, "source.sqlite");
        const replacementDatabase = NodePath.join(root, "replacement.sqlite");
        yield* createSqliteFile(sourceDatabase);
        yield* createSqliteFile(replacementDatabase);
        NodeFS.symlinkSync(sourceDatabase, config.dbPath);

        const launcher = ServiceLauncherClient.of({
          managed: true,
          requestUpdate: () => Effect.succeed("unused-update-id"),
          prepareTrial: Effect.undefined,
        });
        const dependencies = Layer.mergeAll(
          Layer.succeed(ServerConfig.ServerConfig, config),
          Layer.succeed(ServiceLauncherClient, launcher),
          makeRuntimeSqliteLayer({ filename: config.dbPath }),
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
          Layer.succeed(HostProcessExecutablePath, process.execPath),
          Layer.succeed(HostProcessPlatform, "linux"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        );
        const services = yield* Layer.build(
          ServiceUpdateRuntimeLive.pipe(Layer.provideMerge(dependencies)),
        );
        const sql = Context.get(services, SqlClient.SqlClient);
        yield* sql`SELECT 1`;

        NodeFS.unlinkSync(config.dbPath);
        NodeFS.symlinkSync(replacementDatabase, config.dbPath);

        const runtime = Context.get(services, ServiceUpdateRuntime);
        const captured = yield* runtime.captureSource({ fromVersion: TARGET_VERSION });
        assert.deepEqual(captured, {
          databaseIdentity: NodeFS.realpathSync(sourceDatabase),
          fromVersion: TARGET_VERSION,
        });

        const memoryDependencies = Layer.mergeAll(
          Layer.succeed(ServerConfig.ServerConfig, config),
          Layer.succeed(ServiceLauncherClient, launcher),
          makeRuntimeSqliteLayer({ filename: ":memory:" }),
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
          Layer.succeed(HostProcessExecutablePath, process.execPath),
          Layer.succeed(HostProcessPlatform, "linux"),
          Layer.succeed(HostProcessArchitecture, "x64"),
        );
        const memoryServices = yield* Layer.build(
          ServiceUpdateRuntimeLive.pipe(Layer.provideMerge(memoryDependencies)),
        );
        const memoryRuntime = Context.get(memoryServices, ServiceUpdateRuntime);
        const memoryError = yield* Effect.flip(
          memoryRuntime.captureSource({ fromVersion: TARGET_VERSION }),
        );
        assert.equal(memoryError.code, "unavailable");
      }),
    ),
  );
});

const makeLease = (): {
  readonly lease: UpdateAuthorityLease;
  readonly entered: Array<true>;
  readonly released: Array<"released" | "already-released">;
} => {
  const entered: Array<true> = [];
  const released: Array<"released" | "already-released"> = [];
  let phase: "held" | "irreversible" | "released" = "held";
  const lease: UpdateAuthorityLease = {
    owner: "scheduled",
    attemptId,
    enterIrreversible: Effect.suspend(() => {
      if (phase === "irreversible") {
        return Effect.fail(new UpdateAuthorityError({ code: "retained-lease" }));
      }
      if (phase === "released") {
        return Effect.fail(new UpdateAuthorityError({ code: "stale-lease" }));
      }
      phase = "irreversible";
      return Effect.sync(() => {
        entered.push(true);
      });
    }),
    release: Effect.suspend(() => {
      if (phase === "released") {
        return Effect.sync(() => {
          released.push("already-released");
          return "already-released" as const;
        });
      }
      phase = "released";
      return Effect.sync(() => {
        released.push("released");
        return "released" as const;
      });
    }),
  };
  return { lease, entered, released };
};

it.effect("availability covers managed, unmanaged, and platform", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* makeServiceUpdateRuntime(runtimeInput()).availability, {
      status: "supported",
    });
    assert.deepEqual(
      yield* makeServiceUpdateRuntime(
        runtimeInput({ launcher: makeLauncher({ managed: false }).launcher }),
      ).availability,
      { status: "unsupported", reason: "unmanaged" },
    );
    assert.deepEqual(
      yield* makeServiceUpdateRuntime(runtimeInput({ desktopManaged: true })).availability,
      { status: "unsupported", reason: "unmanaged" },
    );
    assert.deepEqual(
      yield* makeServiceUpdateRuntime(runtimeInput({ platform: "darwin" })).availability,
      { status: "unsupported", reason: "platform" },
    );
    assert.deepEqual(
      yield* makeServiceUpdateRuntime(runtimeInput({ architecture: "arm64" })).availability,
      { status: "unsupported", reason: "platform" },
    );
    assert.deepEqual(
      yield* makeServiceUpdateRuntime(runtimeInput({ launcherProtocol: 1 })).availability,
      { status: "unsupported", reason: "launcher-upgrade-required" },
    );
    assert.deepEqual(
      yield* makeServiceUpdateRuntime(runtimeInput({ baseDir: "  " })).availability,
      { status: "unsupported", reason: "runtime-binding-unavailable" },
    );
  }),
);

it.effect("adopt copies and re-verifies without mutating the staged directory", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const input = runtimeInput({
      baseDir: harness.root,
      dbPath: NodePath.join(harness.root, "db"),
    });
    const stagedModeBefore = NodeFS.statSync(harness.artifactPath).mode & 0o777;
    const stagedTextBefore = NodeFS.readFileSync(harness.artifactPath, "utf8");
    try {
      yield* makeServiceUpdateRuntime(input).adopt(harness.staged);

      // Published at the layout the launcher's `runtimeExists` expects.
      const paths = runtimeInstallPaths(harness.root, VERSION, "standalone-executable");
      assert.equal(NodeFS.readFileSync(paths.executablePath, "utf8"), ARTIFACT_TEXT);
      assert.isAbove(NodeFS.statSync(paths.executablePath).mode & 0o111, 0);
      assert.equal(NodeFS.readFileSync(paths.sentinelPath, "utf8").trim(), VERSION);
      assert.isFalse(
        NodeFS.existsSync(NodePath.join(paths.versionDir, "..", `.staging-${attemptId}`)),
      );

      // The staged directory is never mutated by adopt.
      assert.equal(NodeFS.readFileSync(harness.artifactPath, "utf8"), stagedTextBefore);
      assert.equal(NodeFS.statSync(harness.artifactPath).mode & 0o777, stagedModeBefore);
      assert.deepEqual(NodeFS.readdirSync(harness.stagingDirectory), [STAGED_ARTIFACT_FILENAME]);
    } finally {
      harness.dispose();
    }
  }),
);

it.effect("adopt fails closed when a byte flip breaks the copied digest", () =>
  Effect.gen(function* () {
    // The staged record pins one digest while the artifact carries one flipped
    // byte; the copy-verify re-hash must catch it and publish nothing.
    const harness = makeHarness({ artifactText: `${ARTIFACT_TEXT}!` });
    const input = runtimeInput({
      baseDir: harness.root,
      dbPath: NodePath.join(harness.root, "db"),
    });
    const pinnedOriginalDigest: StagedServiceRuntime = {
      ...harness.staged,
      sha256: ARTIFACT_DIGEST,
    };
    try {
      const result = yield* Effect.result(
        makeServiceUpdateRuntime(input).adopt(pinnedOriginalDigest),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        expect(result.failure).toBeInstanceOf(ServiceUpdateOperationError);
        assert.equal(result.failure.code, "verification-failed");
        assert.equal(result.failure.stage, "runtime");
      }
      const paths = runtimeInstallPaths(harness.root, VERSION, "standalone-executable");
      assert.isFalse(NodeFS.existsSync(paths.versionDir));
    } finally {
      harness.dispose();
    }
  }),
);

it.effect("adopts and preflights a raw executable directly with its exact version and argv", () =>
  Effect.gen(function* () {
    const emptyFixture = makeHarness();
    const dbPath = NodePath.join(emptyFixture.root, "userdata", "state.sqlite");
    const invocationLog = NodePath.join(emptyFixture.root, "invocations.log");
    const script = executablePreflightFixture({
      version: VERSION,
      databasePath: dbPath,
      logPath: invocationLog,
      runtimeFormat: "bun-standalone",
      supportsProtectedLauncher: true,
    });
    const fixture = replaceHarnessArtifact(emptyFixture, script);
    const input = runtimeInput({
      baseDir: fixture.root,
      dbPath,
      validate: makePreflightValidate({
        runner: executableFixtureRunner,
        execPath: "/usr/bin/node",
        dbPath,
      }),
    });
    try {
      yield* makeServiceUpdateRuntime(input).adopt(fixture.staged);
      const paths = runtimeInstallPaths(fixture.root, VERSION, "standalone-executable");
      const reportedVersion = NodeChildProcess.spawnSync(paths.executablePath, ["--version"], {
        encoding: "utf8",
      });
      assert.equal(reportedVersion.status, 0);
      assert.equal(reportedVersion.stdout, `t3 v${VERSION}\n`);
      assert.isAbove(NodeFS.statSync(paths.executablePath).mode & 0o111, 0);
      const stagedExecutablePath = NodePath.join(
        fixture.root,
        "runtime",
        "versions",
        `.staging-${attemptId}`,
        "t3",
      );
      const firstInvocations = [
        [
          `${stagedExecutablePath}|__service-preflight`,
          `--database-path ${dbPath}`,
          `--launcher-protocol ${SERVICE_LAUNCHER_PROTOCOL}`,
        ].join(" "),
        `${paths.executablePath}|--version`,
        "",
      ].join("\n");
      assert.equal(NodeFS.readFileSync(invocationLog, "utf8"), firstInvocations);

      yield* makeServiceUpdateRuntime(input).adopt(fixture.staged);
      assert.equal(NodeFS.readFileSync(paths.executablePath, "utf8"), script);
      const mismatchedRelease = yield* Effect.result(
        makeServiceUpdateRuntime(input).adopt({
          ...fixture.staged,
          sha256: NodeCrypto.createHash("sha256").update("different-release").digest("hex"),
        }),
      );
      assert.equal(mismatchedRelease._tag, "Failure");
      if (mismatchedRelease._tag === "Failure") {
        assert.equal(mismatchedRelease.failure.code, "rejected-before-acceptance");
      }
      assert.equal(NodeFS.readFileSync(paths.executablePath, "utf8"), script);
      const allInvocations = [
        [
          `${stagedExecutablePath}|__service-preflight`,
          `--database-path ${dbPath}`,
          `--launcher-protocol ${SERVICE_LAUNCHER_PROTOCOL}`,
        ].join(" "),
        `${paths.executablePath}|--version`,
        [
          `${paths.executablePath}|__service-preflight`,
          `--database-path ${dbPath}`,
          `--launcher-protocol ${SERVICE_LAUNCHER_PROTOCOL}`,
        ].join(" "),
        "",
      ].join("\n");
      assert.equal(NodeFS.readFileSync(invocationLog, "utf8"), allInvocations);
    } finally {
      fixture.dispose();
    }
  }),
);

it.effect("rejects a Node SEA as a raw standalone runtime", () =>
  Effect.gen(function* () {
    const paths = runtimeInstallPaths(
      "/tmp/t3-node-sea-preflight",
      VERSION,
      "standalone-executable",
    );
    const runner: ProcessRunner.ProcessRunner["Service"] = {
      run: () =>
        Effect.succeed({
          stdout: JSON.stringify({
            status: "ready",
            version: VERSION,
            launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
            runtimeFormat: "node-sea",
            supportsProtectedLauncher: true,
          }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        }),
    };

    const result = yield* Effect.result(
      makePreflightValidate({
        runner,
        execPath: "/usr/bin/node",
        dbPath: "/tmp/state.sqlite",
      })(paths, TARGET_VERSION),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "rejected-before-acceptance");
    }
  }),
);

it.effect(
  "does not adopt a raw runtime whose preflight only reports numeric protocol readiness",
  () =>
    Effect.gen(function* () {
      const emptyHarness = makeHarness();
      const dbPath = NodePath.join(emptyHarness.root, "userdata", "state.sqlite");
      const invocationLog = NodePath.join(emptyHarness.root, "invocations.log");
      const harness = replaceHarnessArtifact(
        emptyHarness,
        executablePreflightFixture({
          version: VERSION,
          databasePath: dbPath,
          logPath: invocationLog,
        }),
      );
      const input = runtimeInput({
        baseDir: harness.root,
        dbPath,
        validate: makePreflightValidate({
          runner: executableFixtureRunner,
          execPath: "/usr/bin/node",
          dbPath,
        }),
      });
      try {
        const result = yield* Effect.result(makeServiceUpdateRuntime(input).adopt(harness.staged));
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure.code, "rejected-before-acceptance");
        }
        assert.isFalse(
          NodeFS.existsSync(
            runtimeInstallPaths(harness.root, VERSION, "standalone-executable").versionDir,
          ),
        );
      } finally {
        harness.dispose();
      }
    }),
);

it.effect("accepts numeric protocol readiness for a Node entry candidate", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
    const runner: ProcessRunner.ProcessRunner["Service"] = {
      run: (input) => {
        calls.push({ command: input.command, args: input.args });
        return Effect.succeed({
          stdout: JSON.stringify({
            status: "ready",
            version: VERSION,
            launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
          }),
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    };
    const dbPath = "/tmp/t3-runtime-base/userdata/state.sqlite";
    const paths = runtimeInstallPaths("/tmp/t3-runtime-base", VERSION, "node-entry");
    yield* makePreflightValidate({ runner, execPath: "/usr/bin/node", dbPath })(
      paths,
      TARGET_VERSION,
    );
    assert.deepEqual(calls, [
      {
        command: "/usr/bin/node",
        args: [
          paths.executablePath,
          "__service-preflight",
          "--database-path",
          dbPath,
          "--launcher-protocol",
          String(SERVICE_LAUNCHER_PROTOCOL),
        ],
      },
    ]);
  }),
);

it.effect(
  "removes inherited launcher environment but preserves unrelated staged-child values",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const paths = runtimeInstallPaths(harness.root, VERSION, "standalone-executable");
      const databasePath = NodePath.join(harness.root, "userdata", "state.sqlite");
      const environmentReceiptPath = NodePath.join(harness.root, "preflight-env.txt");
      const syntheticEnvironmentName = "T3CODE_STAGED_PREFLIGHT_TEST_VALUE";
      const previousEnvironment = new Map(
        [SERVICE_LAUNCHER_CONTEXT_ENV, syntheticEnvironmentName].map(
          (name) => [name, process.env[name]] as const,
        ),
      );
      const preflightResult = encodePreflightResult({
        status: "ready",
        version: VERSION,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        runtimeFormat: "bun-standalone",
        supportsProtectedLauncher: true,
      });
      const script = `#!/bin/sh
set -eu
if [ "$1" != "__service-preflight" ]; then exit 26; fi
printf '%s|%s\\n' "\${${SERVICE_LAUNCHER_CONTEXT_ENV}+set}" "\${${syntheticEnvironmentName}-}" > '${environmentReceiptPath.replaceAll("'", "'\\''")}'
printf '%s\\n' '${preflightResult}'
`;
      try {
        NodeFS.mkdirSync(paths.versionDir, { recursive: true });
        NodeFS.writeFileSync(paths.executablePath, script, { mode: 0o755 });
        process.env[SERVICE_LAUNCHER_CONTEXT_ENV] = "source-context-sentinel";
        process.env[syntheticEnvironmentName] = "preserve-this-value";

        const runner = yield* ProcessRunner.ProcessRunner.pipe(
          Effect.provide(Layer.provide(ProcessRunner.layer, NodeServices.layer)),
        );
        yield* makePreflightValidate({
          runner,
          execPath: process.execPath,
          dbPath: databasePath,
        })(paths, TARGET_VERSION);

        expect(NodeFS.readFileSync(environmentReceiptPath, "utf8")).toBe("|preserve-this-value\n");
      } finally {
        for (const [name, value] of previousEnvironment) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        harness.dispose();
      }
    }),
);

it.effect("does not publish a ready standalone runtime that reports a different version", () =>
  Effect.gen(function* () {
    const emptyHarness = makeHarness();
    const dbPath = NodePath.join(emptyHarness.root, "userdata", "state.sqlite");
    const invocationLog = NodePath.join(emptyHarness.root, "invocations.log");
    const harness = replaceHarnessArtifact(
      emptyHarness,
      executablePreflightFixture({
        version: "1.2.4-f8y.20260101.3",
        databasePath: dbPath,
        logPath: invocationLog,
        runtimeFormat: "bun-standalone",
        supportsProtectedLauncher: true,
      }),
    );
    const input = runtimeInput({
      baseDir: harness.root,
      dbPath,
      validate: makePreflightValidate({
        runner: executableFixtureRunner,
        execPath: "/usr/bin/node",
        dbPath,
      }),
    });
    try {
      const result = yield* Effect.result(makeServiceUpdateRuntime(input).adopt(harness.staged));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "rejected-before-acceptance");
      }
      assert.isFalse(
        NodeFS.existsSync(
          runtimeInstallPaths(harness.root, VERSION, "standalone-executable").versionDir,
        ),
      );
    } finally {
      harness.dispose();
    }
  }),
);

it.effect("adopt fails closed when the staged digest does not match the artifact", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const input = runtimeInput({
      baseDir: harness.root,
      dbPath: NodePath.join(harness.root, "db"),
    });
    const flipped: StagedServiceRuntime = {
      ...harness.staged,
      sha256: NodeCrypto.createHash("sha256").update("other-bytes").digest("hex"),
    };
    try {
      const result = yield* Effect.result(makeServiceUpdateRuntime(input).adopt(flipped));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.code, "verification-failed");
      }
    } finally {
      harness.dispose();
    }
  }),
);

it.effect("requestHandoff returns launcher acceptance only and drives the lease", () =>
  Effect.gen(function* () {
    const { launcher, calls } = makeLauncher();
    const { lease, entered } = makeLease();
    const input = runtimeInput({ launcher, dbPath: "/tmp/db/state.sqlite" });
    const handedOff = yield* makeServiceUpdateRuntime(input).requestHandoff({
      targetVersion: TARGET_VERSION,
      source: sourceCapture("/tmp/db/state.sqlite"),
      authorityLease: lease,
    });
    // Launcher acceptance only: the opaque update id, never readiness/commit.
    assert.equal(handedOff.updateId, "native-update-1");
    assert.deepEqual(calls, [{ targetVersion: TARGET_VERSION, dbPath: "/tmp/db/state.sqlite" }]);
    // The irreversible boundary is established before the launcher request.
    assert.equal(entered.length, 1);
  }),
);

it.effect("requestHandoff retains the lease when launcher acceptance is unknown", () =>
  Effect.gen(function* () {
    const { launcher } = makeLauncher({ failWith: "disconnect" });
    const { lease, released } = makeLease();
    const input = runtimeInput({ launcher });
    const result = yield* Effect.result(
      makeServiceUpdateRuntime(input).requestHandoff({
        targetVersion: TARGET_VERSION,
        source: sourceCapture(),
        authorityLease: lease,
      }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.code, "acceptance-unknown");
      assert.equal(result.failure.stage, "runtime");
    }
    assert.deepEqual(released, []);
  }),
);

it.effect("reports definite rejection without releasing authority and maps unmanaged errors", () =>
  Effect.gen(function* () {
    const rejected = makeLauncher({ failWith: "rejected" });
    const rejectedLease = makeLease();
    const rejectedResult = yield* Effect.result(
      makeServiceUpdateRuntime(runtimeInput({ launcher: rejected.launcher })).requestHandoff({
        targetVersion: TARGET_VERSION,
        source: sourceCapture(),
        authorityLease: rejectedLease.lease,
      }),
    );
    assert.equal(rejectedResult._tag, "Failure");
    if (rejectedResult._tag === "Failure") {
      assert.equal(rejectedResult.failure.code, "rejected-before-acceptance");
    }
    assert.deepEqual(rejectedLease.released, []);

    const unmanaged = makeLauncher({ failWith: "unmanaged" });
    const unmanagedResult = yield* Effect.result(
      makeServiceUpdateRuntime(runtimeInput({ launcher: unmanaged.launcher })).requestHandoff({
        targetVersion: TARGET_VERSION,
        source: sourceCapture(),
        authorityLease: makeLease().lease,
      }),
    );
    assert.equal(unmanagedResult._tag, "Failure");
    if (unmanagedResult._tag === "Failure") {
      assert.equal(unmanagedResult.failure.code, "unavailable");
    }
  }),
);
