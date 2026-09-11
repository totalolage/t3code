/**
 * Multi-instance validation slices for `ProviderInstanceRegistryLive`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`, `hermes`,
 *     `antigravity`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every instance in these tests is configured with `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real provider processes.
 * That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ClaudeSettings,
  type CodexSettings,
  type CursorSettings,
  type GrokSettings,
  type HermesSettings,
  type OpenCodeSettings,
  type AntigravitySettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { isHostWindows } from "@t3tools/shared/hostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import type { BuiltInDriversEnv } from "../builtInDrivers.ts";
import { AntigravityInstallation } from "../AntigravityInstallation.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { CodexDriver } from "../Drivers/CodexDriver.ts";
import { CursorDriver } from "../Drivers/CursorDriver.ts";
import { GrokDriver } from "../Drivers/GrokDriver.ts";
import { HermesDriver } from "../Drivers/HermesDriver.ts";
import { OpenCodeDriver } from "../Drivers/OpenCodeDriver.ts";
import { AntigravityDriver } from "../Drivers/AntigravityDriver.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { OpenCodeRuntimeLive } from "../opencodeRuntime.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import * as CodexResetCredit from "./codexResetCredit.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const RETIREMENT_TEST_DRIVER = ProviderDriverKind.make("retirement-test");

const makeRetirementTestInstance = (
  instanceId: ProviderInstanceId,
  adapter: ProviderInstance["adapter"],
): ProviderInstance => ({
  instanceId,
  driverKind: RETIREMENT_TEST_DRIVER,
  continuationIdentity: {
    driverKind: RETIREMENT_TEST_DRIVER,
    continuationKey: `${RETIREMENT_TEST_DRIVER}:instance:${instanceId}`,
  },
  displayName: undefined,
  enabled: false,
  snapshot: {
    resolveMaintenance: () => Effect.die("unused"),
    getSnapshot: Effect.succeed({} as ServerProvider),
    refresh: Effect.succeed({} as ServerProvider),
    streamChanges: Stream.empty,
    applyUsageLimits: () => Effect.void,
  },
  adapter,
  textGeneration: {} as ProviderInstance["textGeneration"],
});

const makeRetirementTestDriver = (
  onCreate: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly adapter: ProviderInstance["adapter"];
    readonly scope: Scope.Scope;
    readonly version: number;
    readonly createNumber: number;
  }) => Effect.Effect<void>,
): ProviderDriver<{ readonly version: number }> => {
  let createNumber = 0;
  return {
    driverKind: RETIREMENT_TEST_DRIVER,
    metadata: { displayName: "Retirement test" },
    configSchema: Schema.Struct({ version: Schema.Number }),
    defaultConfig: () => ({ version: 0 }),
    create: ({ instanceId, config }) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        createNumber += 1;
        const adapter = {
          provider: RETIREMENT_TEST_DRIVER,
          capabilities: {
            sessionModelSwitch: "unsupported" as const,
            turnSteering: "supported" as const,
          },
        } as ProviderInstance["adapter"];
        yield* onCreate({
          instanceId,
          adapter,
          scope,
          version: config.version,
          createNumber,
        });
        return makeRetirementTestInstance(instanceId, adapter);
      }),
  };
};

const makeRetirementConfig = (
  instanceId: ProviderInstanceId,
  version: number,
): ProviderInstanceConfigMap => ({
  [instanceId]: {
    driver: RETIREMENT_TEST_DRIVER,
    enabled: false,
    config: { version },
  },
});

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  ...overrides,
});

const makeCursorConfig = (overrides: Partial<CursorSettings>): CursorSettings => ({
  enabled: false,
  binaryPath: "cursor-agent",
  apiEndpoint: "",
  customModels: [],
  ...overrides,
});

const makeGrokConfig = (overrides: Partial<GrokSettings>): GrokSettings => ({
  enabled: false,
  binaryPath: "grok",
  customModels: [],
  ...overrides,
});

const makeOpenCodeConfig = (overrides: Partial<OpenCodeSettings>): OpenCodeSettings => ({
  enabled: false,
  binaryPath: "opencode",
  serverUrl: "",
  serverPassword: "",
  customModels: [],
  ...overrides,
});

const makeHermesConfig = (overrides: Partial<HermesSettings>): HermesSettings => ({
  enabled: false,
  binaryPath: "hermes",
  customModels: [],
  ...overrides,
});

const makeAntigravityConfig = (overrides: Partial<AntigravitySettings>): AntigravitySettings => ({
  enabled: false,
  authMethod: "oauth-personal",
  apiKey: "",
  gcpProject: "",
  gcpLocation: "",
  binaryPath: "",
  customModels: [],
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistryLive.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = expandHomePath("~");
  const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: homePath,
    prefix: ".t3-provider-path-test-",
  });
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "../testFixtures");

  yield* fileSystem.copyFile(path.join(codexFixtureDir, "codexCollabMockPeer.sh"), codexPath);
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed script document read by the external Codex mock peer.
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.writeFileString(
    claudePath,
    [
      "#!/usr/bin/env node",
      'import * as NodeReadline from "node:readline";',
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("claude 2.1.219\\n");',
      "  process.exit(0);",
      "}",
      "const lines = NodeReadline.createInterface({ input: process.stdin });",
      'lines.on("line", (line) => {',
      "  const message = JSON.parse(line);",
      '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
      "  process.stdout.write(JSON.stringify({",
      '    type: "control_response",',
      "    response: {",
      '      subtype: "success",',
      "      request_id: message.request_id,",
      "      response: {",
      "        commands: [], agents: [], models: [],",
      '        output_style: "default", available_output_styles: ["default"],',
      '        account: { email: "test@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
      "      },",
      "    },",
      '  }) + "\\n");',
      "});",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"),
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

describe("ProviderInstanceRegistryLive — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `NodeServices.layer` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const testLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(CodexResetCredit.layerTest),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.adapter).not.toBe(work!.adapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      // The layout resolves the configured home through the host Path.
      const path = yield* Path.Path;
      expect(personalSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex_personal")}`,
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex")}`,
      );

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable is never undone.
      const staleId = ProviderInstanceId.make("codex_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("runs Codex and Claude readiness probes from configured tilde paths", () =>
    Effect.gen(function* () {
      if (yield* isHostWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();

      const codexId = ProviderInstanceId.make("codex_tilde");
      const claudeId = ProviderInstanceId.make("claude_tilde");
      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [
            {
              name: "T3_CODEX_COLLAB_SCRIPT",
              value: fixtures.codexScriptPath,
              sensitive: false,
            },
          ],
          config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
        },
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex).toBeDefined();
      expect(claude).toBeDefined();

      const [codexSnapshot, claudeSnapshot] = yield* Effect.all(
        [codex!.snapshot.refresh, claude!.snapshot.refresh],
        { concurrency: "unbounded" },
      );
      expect(codexSnapshot).toMatchObject({ status: "ready", installed: true, version: "0.0.0" });
      expect(claudeSnapshot).toMatchObject({
        status: "ready",
        installed: true,
        version: "2.1.219",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — all drivers slice", () => {
  // All drivers need `NodeServices` (ChildProcessSpawner + FileSystem +
  // Path). `OpenCodeDriver.create` additionally yields `OpenCodeRuntime`
  // at construction time, so we wire `OpenCodeRuntimeLive` into the stack.
  // `OpenCodeRuntimeLive` bundles its own `NetService.layer` via
  // `Layer.provide`, so the only external requirement it still exposes is
  // `ChildProcessSpawner` — resolved here by piping it through
  // `provideMerge(NodeServices.layer)`.
  //
  // The nested `provideMerge`s read bottom-up: `NodeServices.layer`
  // provides `OpenCodeRuntimeLive`'s deps while keeping its own outputs
  // surfaced; that merged layer then provides `ServerConfig.layerTest`'s
  // `FileSystem` dep while keeping everything else surfaced to the test.
  const infraLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));
  const testLayer = AntigravityInstallation.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "provider-instance-registry-all-drivers-test",
      }),
    ),
    Layer.provideMerge(infraLayer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(CodexResetCredit.layerTest),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");
      const cursorId = ProviderInstanceId.make("cursor_default");
      const grokId = ProviderInstanceId.make("grok_default");
      const openCodeId = ProviderInstanceId.make("opencode_default");
      const hermesId = ProviderInstanceId.make("hermes_default");
      const antigravityId = ProviderInstanceId.make("antigravity_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");
      const cursorDriverKind = ProviderDriverKind.make("cursor");
      const grokDriverKind = ProviderDriverKind.make("grok");
      const openCodeDriverKind = ProviderDriverKind.make("opencode");
      const hermesDriverKind = ProviderDriverKind.make("hermes");
      const antigravityDriverKind = ProviderDriverKind.make("antigravity");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex" }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
        [cursorId]: {
          driver: cursorDriverKind,
          displayName: "Cursor",
          enabled: false,
          config: makeCursorConfig({}),
        },
        [grokId]: {
          driver: grokDriverKind,
          displayName: "Grok",
          enabled: false,
          config: makeGrokConfig({}),
        },
        [openCodeId]: {
          driver: openCodeDriverKind,
          displayName: "OpenCode",
          enabled: false,
          config: makeOpenCodeConfig({}),
        },
        [hermesId]: {
          driver: hermesDriverKind,
          displayName: "Hermes",
          enabled: false,
          config: makeHermesConfig({}),
        },
        [antigravityId]: {
          driver: antigravityDriverKind,
          displayName: "Antigravity",
          enabled: false,
          config: makeAntigravityConfig({}),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<BuiltInDriversEnv>({
        drivers: [
          CodexDriver,
          ClaudeDriver,
          CursorDriver,
          GrokDriver,
          OpenCodeDriver,
          HermesDriver,
          AntigravityDriver,
        ],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(7);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId, cursorId, grokId, openCodeId, hermesId, antigravityId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      const cursor = yield* registry.getInstance(cursorId);
      const grok = yield* registry.getInstance(grokId);
      const openCode = yield* registry.getInstance(openCodeId);
      const hermes = yield* registry.getInstance(hermesId);
      const antigravity = yield* registry.getInstance(antigravityId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(cursor?.driverKind).toBe(cursorDriverKind);
      expect(grok?.driverKind).toBe(grokDriverKind);
      expect(openCode?.driverKind).toBe(openCodeDriverKind);
      expect(hermes?.driverKind).toBe(hermesDriverKind);
      expect(antigravity?.driverKind).toBe(antigravityDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");
      expect(cursor?.displayName).toBe("Cursor");
      expect(grok?.displayName).toBe("Grok");
      expect(openCode?.displayName).toBe("OpenCode");
      expect(hermes?.displayName).toBe("Hermes");
      expect(antigravity?.displayName).toBe("Antigravity");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `adapter` / `textGeneration` / `snapshot` are all
      // distinct references even when two instances happen to share a
      // trait (e.g. Cursor + others all use a stub-or-real
      // `textGeneration`; they must still be different object values).
      const adapters = [
        codex!.adapter,
        claude!.adapter,
        cursor!.adapter,
        grok!.adapter,
        openCode!.adapter,
        hermes!.adapter,
        antigravity!.adapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
        cursor!.textGeneration,
        grok!.textGeneration,
        openCode!.textGeneration,
        hermes!.textGeneration,
        antigravity!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
        cursor!.snapshot,
        grok!.snapshot,
        openCode!.snapshot,
        hermes!.snapshot,
        antigravity!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.supportsSteering).toBe(true);
      expect(codexSnapshot.continuation?.groupKey).toBe(
        `codex:home:${(yield* Path.Path).resolve("/home/julius/.codex")}`,
      );

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.supportsSteering).toBe(true);
      expect(claudeSnapshot.continuation?.groupKey).toBe(
        `claude:home:${(yield* Path.Path).resolve("/home/julius/.claude-work")}`,
      );

      const cursorSnapshot = yield* cursor!.snapshot.getSnapshot;
      expect(cursorSnapshot.instanceId).toBe(cursorId);
      expect(cursorSnapshot.driver).toBe(cursorDriverKind);
      expect(cursorSnapshot.enabled).toBe(false);
      expect(cursorSnapshot.supportsSteering).toBe(true);
      expect(cursorSnapshot.continuation?.groupKey).toBe(
        `${cursorDriverKind}:instance:${cursorId}`,
      );

      const grokSnapshot = yield* grok!.snapshot.getSnapshot;
      expect(grokSnapshot.instanceId).toBe(grokId);
      expect(grokSnapshot.driver).toBe(grokDriverKind);
      expect(grokSnapshot.enabled).toBe(false);
      expect(grokSnapshot.supportsSteering).toBe(true);
      expect(grokSnapshot.continuation?.groupKey).toBe(`${grokDriverKind}:instance:${grokId}`);

      const openCodeSnapshot = yield* openCode!.snapshot.getSnapshot;
      expect(openCodeSnapshot.instanceId).toBe(openCodeId);
      expect(openCodeSnapshot.driver).toBe(openCodeDriverKind);
      expect(openCodeSnapshot.enabled).toBe(false);
      expect(openCodeSnapshot.supportsSteering).toBe(true);
      expect(openCodeSnapshot.continuation?.groupKey).toBe(
        `${openCodeDriverKind}:instance:${openCodeId}`,
      );

      const hermesSnapshot = yield* hermes!.snapshot.getSnapshot;
      expect(hermesSnapshot.instanceId).toBe(hermesId);
      expect(hermesSnapshot.driver).toBe(hermesDriverKind);
      expect(hermesSnapshot.enabled).toBe(false);
      expect(hermesSnapshot.supportsSteering).toBe(false);
      expect(hermesSnapshot.continuation?.groupKey).toBe(
        `${hermesDriverKind}:instance:${hermesId}`,
      );

      const antigravitySnapshot = yield* antigravity!.snapshot.getSnapshot;
      expect(antigravitySnapshot.instanceId).toBe(antigravityId);
      expect(antigravitySnapshot.driver).toBe(antigravityDriverKind);
      expect(antigravitySnapshot.enabled).toBe(false);
      expect(antigravitySnapshot.supportsSteering).toBe(true);
      expect(antigravitySnapshot.continuation?.groupKey).toBe(
        `${antigravityDriverKind}:instance:${antigravityId}`,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("serializes non-steerable turns for the lifetime of the provider instance", () =>
    Effect.gen(function* () {
      const firstTurnStarted = yield* Deferred.make<void>();
      const releaseFirstTurn = yield* Deferred.make<void>();
      let active = false;
      let sendCount = 0;
      const driver = {
        ...HermesDriver,
        create: (input: Parameters<typeof HermesDriver.create>[0]) =>
          HermesDriver.create(input).pipe(
            Effect.map((instance) => ({
              ...instance,
              adapter: {
                ...instance.adapter,
                interruptTurn: () =>
                  Deferred.succeed(releaseFirstTurn, undefined).pipe(Effect.asVoid),
                sendTurn: (turnInput: Parameters<typeof instance.adapter.sendTurn>[0]) =>
                  Effect.gen(function* () {
                    if (active) {
                      return yield* new ProviderAdapterValidationError({
                        provider: instance.adapter.provider,
                        operation: "sendTurn",
                        issue: "A provider turn is already running for this thread.",
                      });
                    }
                    active = true;
                    sendCount += 1;
                    const currentSend = sendCount;
                    if (currentSend === 1) {
                      yield* Deferred.succeed(firstTurnStarted, undefined);
                      yield* Deferred.await(releaseFirstTurn);
                    }
                    active = false;
                    return {
                      threadId: turnInput.threadId,
                      turnId: TurnId.make(`turn-${currentSend}`),
                    };
                  }),
              },
            })),
          ),
      };
      const instanceId = ProviderInstanceId.make("hermes_queue_test");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [driver],
        configMap: {
          [instanceId]: {
            driver: ProviderDriverKind.make("hermes"),
            enabled: false,
            config: makeHermesConfig({}),
          },
        },
      });
      const instance = yield* registry.getInstance(instanceId);
      expect(instance).toBeDefined();
      const threadId = ThreadId.make("provider-instance-queue-thread");

      const firstTurnFiber = yield* instance!.adapter
        .sendTurn({ threadId, input: "first", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstTurnStarted);
      const secondTurnFiber = yield* instance!.adapter
        .sendTurn({ threadId, input: "second", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      expect(secondTurnFiber.pollUnsafe()).toBeUndefined();
      expect(sendCount).toBe(1);

      yield* instance!.adapter.interruptTurn(threadId);
      const [firstTurn, secondTurn] = yield* Effect.all([
        Fiber.join(firstTurnFiber),
        Fiber.join(secondTurnFiber),
      ]);
      expect(firstTurn.turnId).not.toBe(secondTurn.turnId);
      expect(sendCount).toBe(2);
    }).pipe(Effect.provide(testLayer)),
  );
});

describe("ProviderInstanceRegistryLive — retirement lifecycle", () => {
  it.effect("retires an instance before creating or exposing its replacement", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("retirement-ordering");
      const closeStarted = yield* Deferred.make<void>();
      const closeRelease = yield* Deferred.make<void>();
      const afterCloseStarted = yield* Deferred.make<void>();
      const afterCloseRelease = yield* Deferred.make<void>();
      const beforeCloseObserved = yield* Deferred.make<void>();
      const events: Array<string> = [];
      let initialAdapter: ProviderInstance["adapter"] | undefined;
      let beforeCloseObservation:
        | {
            readonly retiringId: ProviderInstanceId;
            readonly adapter: unknown;
            readonly lookup: ProviderInstance | undefined;
          }
        | undefined;
      let afterCloseObservation:
        | {
            readonly retiringId: ProviderInstanceId;
            readonly adapter: unknown;
            readonly lookup: ProviderInstance | undefined;
          }
        | undefined;

      const releaseGates = Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(closeRelease, undefined);
          yield* Deferred.succeed(afterCloseRelease, undefined);
        }),
      );

      yield* Effect.gen(function* () {
        const driver = makeRetirementTestDriver(({ adapter, createNumber, scope, version }) =>
          Effect.gen(function* () {
            events.push(`create:${version}`);
            if (createNumber === 1) {
              initialAdapter = adapter;
              yield* Scope.addFinalizer(
                scope,
                Effect.gen(function* () {
                  events.push("close-started");
                  yield* Deferred.succeed(closeStarted, undefined);
                  yield* Deferred.await(closeRelease);
                  events.push("close-complete");
                }),
              );
            }
          }),
        );
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: makeRetirementConfig(instanceId, 1),
        });
        const initial = yield* registry.getInstance(instanceId);
        expect(initial?.adapter).toBe(initialAdapter);

        yield* registry.registerRetirementHooks({
          beforeClose: (retiringId, adapter) =>
            Effect.gen(function* () {
              events.push("before-close");
              beforeCloseObservation = {
                retiringId,
                adapter,
                lookup: yield* registry.getInstance(instanceId),
              };
              yield* Deferred.succeed(beforeCloseObserved, undefined);
            }),
          afterClose: (retiringId, adapter) =>
            Effect.gen(function* () {
              events.push("after-close-started");
              afterCloseObservation = {
                retiringId,
                adapter,
                lookup: yield* registry.getInstance(instanceId),
              };
              yield* Deferred.succeed(afterCloseStarted, undefined);
              yield* Deferred.await(afterCloseRelease);
              events.push("after-close-receipt");
            }),
        });

        const replacement = yield* mutator
          .reconcile(makeRetirementConfig(instanceId, 2))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(beforeCloseObserved);

        expect(beforeCloseObservation?.retiringId).toBe(instanceId);
        expect(beforeCloseObservation?.adapter).toBe(initialAdapter);
        expect(beforeCloseObservation?.lookup).toBeUndefined();

        yield* Deferred.await(closeStarted);
        expect(events).toEqual(["create:1", "before-close", "close-started"]);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();
        expect(yield* registry.listInstances).toEqual([]);

        yield* Deferred.succeed(closeRelease, undefined);
        yield* Deferred.await(afterCloseStarted);
        expect(afterCloseObservation?.retiringId).toBe(instanceId);
        expect(afterCloseObservation?.adapter).toBe(initialAdapter);
        expect(afterCloseObservation?.lookup).toBeUndefined();
        expect(events).toEqual([
          "create:1",
          "before-close",
          "close-started",
          "close-complete",
          "after-close-started",
        ]);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* Deferred.succeed(afterCloseRelease, undefined);
        yield* Fiber.join(replacement);

        expect(events).toEqual([
          "create:1",
          "before-close",
          "close-started",
          "close-complete",
          "after-close-started",
          "after-close-receipt",
          "create:2",
        ]);
        const current = yield* registry.getInstance(instanceId);
        expect(current).toBeDefined();
        expect(current?.adapter).not.toBe(initialAdapter);
      }).pipe(Effect.ensuring(releaseGates));
    }).pipe(Effect.scoped),
  );

  it.effect("serializes concurrent reconciles through interrupted retirement", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("retirement-interruption");
      const beforeStarted = yield* Deferred.make<void>();
      const beforeRelease = yield* Deferred.make<void>();
      const closeStarted = yield* Deferred.make<void>();
      const closeRelease = yield* Deferred.make<void>();
      const afterCloseStarted = yield* Deferred.make<void>();
      const afterCloseRelease = yield* Deferred.make<void>();
      const afterCloseComplete = yield* Deferred.make<void>();
      const createdVersions: Array<number> = [];
      const events: Array<string> = [];
      let beforeCalls = 0;
      let activeBeforeCalls = 0;
      let maxActiveBeforeCalls = 0;
      const releaseGates = Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(beforeRelease, undefined);
          yield* Deferred.succeed(closeRelease, undefined);
          yield* Deferred.succeed(afterCloseRelease, undefined);
        }),
      );

      yield* Effect.gen(function* () {
        const driver = makeRetirementTestDriver(({ createNumber, scope, version }) =>
          Effect.gen(function* () {
            events.push(`create:${version}`);
            createdVersions.push(version);
            if (createNumber !== 1) return;
            yield* Scope.addFinalizer(
              scope,
              Effect.uninterruptible(
                Effect.gen(function* () {
                  events.push("close-started");
                  yield* Deferred.succeed(closeStarted, undefined);
                  yield* Deferred.await(closeRelease);
                  events.push("close-complete");
                }),
              ),
            );
          }),
        );
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: makeRetirementConfig(instanceId, 0),
        });

        yield* registry.registerRetirementHooks({
          beforeClose: () =>
            Effect.gen(function* () {
              beforeCalls += 1;
              activeBeforeCalls += 1;
              maxActiveBeforeCalls = Math.max(maxActiveBeforeCalls, activeBeforeCalls);
              if (beforeCalls === 1) {
                events.push("before-close");
                yield* Deferred.succeed(beforeStarted, undefined);
                yield* Deferred.await(beforeRelease);
              }
              activeBeforeCalls -= 1;
            }),
          afterClose: () =>
            Effect.gen(function* () {
              events.push("after-close-started");
              yield* Deferred.succeed(afterCloseStarted, undefined);
              yield* Deferred.await(afterCloseRelease);
              events.push("after-close-complete");
              yield* Deferred.succeed(afterCloseComplete, undefined);
            }),
        });

        const first = yield* mutator
          .reconcile(makeRetirementConfig(instanceId, 1))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(beforeStarted);

        const second = yield* mutator
          .reconcile(makeRetirementConfig(instanceId, 2))
          .pipe(Effect.forkChild({ startImmediately: true }));
        const interruptFirst = yield* Fiber.interrupt(first).pipe(Effect.forkDetach);
        yield* Effect.yieldNow;

        expect(events).toEqual(["create:0", "before-close"]);
        expect(createdVersions).toEqual([0]);
        expect(activeBeforeCalls).toBe(1);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* Deferred.succeed(beforeRelease, undefined);
        yield* Deferred.await(closeStarted);
        expect(events).toEqual(["create:0", "before-close", "close-started"]);
        expect(createdVersions).toEqual([0]);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* Deferred.succeed(closeRelease, undefined);
        yield* Deferred.await(afterCloseStarted);
        expect(events).toEqual([
          "create:0",
          "before-close",
          "close-started",
          "close-complete",
          "after-close-started",
        ]);
        expect(createdVersions).toEqual([0]);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* Deferred.succeed(afterCloseRelease, undefined);
        yield* Deferred.await(afterCloseComplete);
        yield* Fiber.join(interruptFirst);
        yield* Fiber.join(second);

        expect(createdVersions).toContain(2);
        expect(events.indexOf("after-close-complete")).toBeLessThan(
          events.findIndex((event) => event === "create:2"),
        );
        expect(beforeCalls).toBeGreaterThanOrEqual(1);
        expect(maxActiveBeforeCalls).toBe(1);
        expect(yield* registry.getInstance(instanceId)).toBeDefined();
      }).pipe(Effect.ensuring(releaseGates));
    }).pipe(Effect.scoped),
  );

  it.effect("runs afterClose and replacement build after a timed-out close", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("retirement-timeout");
      const closeStarted = yield* Deferred.make<void>();
      const closeRelease = yield* Deferred.make<void>();
      const closeComplete = yield* Deferred.make<void>();
      const afterCloseStarted = yield* Deferred.make<void>();
      const afterCloseRelease = yield* Deferred.make<void>();
      const events: Array<string> = [];
      const releaseGates = Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(closeRelease, undefined);
          yield* Deferred.succeed(afterCloseRelease, undefined);
        }),
      );

      yield* Effect.gen(function* () {
        const driver = makeRetirementTestDriver(({ createNumber, scope, version }) =>
          Effect.gen(function* () {
            events.push(`create:${version}`);
            if (createNumber !== 1) return;
            yield* Scope.addFinalizer(
              scope,
              Effect.uninterruptible(
                Effect.gen(function* () {
                  events.push("close-started");
                  yield* Deferred.succeed(closeStarted, undefined);
                  yield* Deferred.await(closeRelease);
                  events.push("close-complete");
                  yield* Deferred.succeed(closeComplete, undefined);
                }),
              ),
            );
          }),
        );
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: makeRetirementConfig(instanceId, 0),
        });

        yield* registry.registerRetirementHooks({
          beforeClose: () =>
            Effect.sync(() => {
              events.push("before-close");
            }),
          afterClose: () =>
            Effect.gen(function* () {
              events.push("after-close-started");
              yield* Deferred.succeed(afterCloseStarted, undefined);
              yield* Deferred.await(afterCloseRelease);
              events.push("after-close-complete");
            }),
        });

        const replacement = yield* mutator
          .reconcile(makeRetirementConfig(instanceId, 1))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeStarted);
        yield* TestClock.adjust("5 seconds");
        yield* Deferred.await(afterCloseStarted);

        expect(events).toEqual([
          "create:0",
          "before-close",
          "close-started",
          "after-close-started",
        ]);
        expect(yield* registry.getInstance(instanceId)).toBeUndefined();

        yield* Deferred.succeed(afterCloseRelease, undefined);
        yield* Fiber.join(replacement);
        expect(events).toEqual([
          "create:0",
          "before-close",
          "close-started",
          "after-close-started",
          "after-close-complete",
          "create:1",
        ]);
        expect(yield* registry.getInstance(instanceId)).toBeDefined();

        yield* Deferred.succeed(closeRelease, undefined);
        yield* Deferred.await(closeComplete);
      }).pipe(Effect.ensuring(releaseGates));
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("unregisters retirement hooks by scope and rejects duplicate registration", () =>
    Effect.gen(function* () {
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [makeRetirementTestDriver(() => Effect.void)],
        configMap: {},
      });
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const firstHooks = {
        beforeClose: () => Effect.void,
        afterClose: () => Effect.void,
      };
      const secondHooks = {
        beforeClose: () => Effect.void,
        afterClose: () => Effect.void,
      };

      yield* registry
        .registerRetirementHooks(firstHooks)
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      const duplicate = yield* registry
        .registerRetirementHooks(secondHooks)
        .pipe(Effect.provideService(Scope.Scope, secondScope), Effect.exit);
      expect(Exit.isFailure(duplicate) && Cause.hasDies(duplicate.cause)).toBe(true);

      yield* Scope.close(firstScope, Exit.void);
      yield* registry
        .registerRetirementHooks(secondHooks)
        .pipe(Effect.provideService(Scope.Scope, secondScope));
      yield* Scope.close(secondScope, Exit.void);
    }).pipe(Effect.scoped),
  );
});
