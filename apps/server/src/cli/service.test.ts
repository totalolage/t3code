import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";
import { Command } from "effect/unstable/cli";
import { afterEach, vi } from "vite-plus/test";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import {
  formatServiceStatus,
  offerServiceDuringOnboarding,
  parseServiceEnvironmentEntries,
  reconcileService,
  recoverServiceOnboardingOffer,
  serviceCommand,
} from "./service.ts";

afterEach(() => vi.restoreAllMocks());

const status = {
  supported: true,
  installed: true,
  current: true,
  unitPath: "/home/me/.config/systemd/user/t3code.service",
  logPath: "/home/me/.t3/userdata/logs/boot-service.log",
} as const;

it("reports the installed service version and host paths", () => {
  assert.equal(
    formatServiceStatus(status, "0.0.29"),
    [
      "T3 Code service",
      "  Status: installed · t3@0.0.29",
      "  Unit: /home/me/.config/systemd/user/t3code.service",
      "  Logs: /home/me/.t3/userdata/logs/boot-service.log",
    ].join("\n"),
  );
});

it("gives a direct repair command for a stale service", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29"),
    "Next: Run `npx t3@0.0.29 service update`.",
  );
});

it("preserves s6 selection in the repair command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29", {
      supervisor: "s6",
      s6ServiceDir: "/run/service/T3 Code",
    }),
    "Next: Run `npx t3@0.0.29 service update --supervisor s6 --service-dir '/run/service/T3 Code'`.",
  );
});

it("explains an incomplete nightly installation and keeps repair on its installed version", () => {
  const output = formatServiceStatus(
    {
      ...status,
      current: false,
      installedVersion: "0.0.32-nightly.1",
      problems: ["linger-disabled", "service-stopped"],
    },
    "0.0.32-nightly.1",
  );

  expect(output).toContain("[linger-disabled]");
  expect(output).toContain("last login session ends");
  expect(output).toContain('sudo loginctl enable-linger "$(id -un)"');
  expect(output).toContain("[service-stopped]");
  expect(output).toContain("npx t3@0.0.32-nightly.1 service update");
  expect(output).not.toContain("t3@latest");
});

it("suggests the newer CLI version when the installed service needs an update", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.28" },
    "0.0.29",
  );
  expect(output).toContain("npx t3@0.0.29 service update");
  expect(output).not.toContain("npx t3@0.0.28 service update");
});

it("explains where the service is supported", () => {
  assert.include(
    formatServiceStatus({ ...status, supported: false, installed: false }, "0.0.29"),
    "Supported on: Linux with systemd, macOS with launchd, or s6 with --service-dir",
  );
});

it("preserves an explicit service host and port in the repair command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29", {
      supervisor: "s6",
      s6ServiceDir: "/run/service/t3code",
      serverHost: "0.0.0.0",
      serverPort: 3773,
    }),
    "Next: Run `npx t3@0.0.29 service update --supervisor s6 --service-dir '/run/service/t3code' --host '0.0.0.0' --port 3773`.",
  );
});

it("preserves an explicit s6 service identity in the repair command", () => {
  assert.include(
    formatServiceStatus({ ...status, current: false }, "0.0.29", {
      supervisor: "s6",
      s6ServiceDir: "/run/service/t3code",
      serviceUser: "t3 service",
      serviceGroup: "t3",
    }),
    "--service-user 't3 service' --service-group 't3'",
  );
});

it("parses repeated service environment entries without splitting value equals", () => {
  assert.deepEqual(
    parseServiceEnvironmentEntries(
      ["SECOND=two", "FIRST=spaces ' $dollar `backtick` and=equals"],
      "s6",
    ),
    [
      { name: "FIRST", value: "spaces ' $dollar `backtick` and=equals" },
      { name: "SECOND", value: "two" },
    ],
  );
});

it("rejects invalid, reserved, duplicate, and unsafe service environment entries", () => {
  const invalidEntries = [
    ["MISSING_EQUALS"],
    ["9INVALID=value"],
    ["T3CODE_HOME=value"],
    ["DUPLICATE=first", "DUPLICATE=second"],
    ["UNSAFE=line\rbreak"],
    ["UNSAFE=line\nbreak"],
    ["UNSAFE=nul\0break"],
  ];

  for (const entries of invalidEntries) {
    assert.throws(() => parseServiceEnvironmentEntries(entries, "s6"));
  }
});

it("rejects service environment entries for systemd without leaking their values", () => {
  const secret = "do-not-print-$SECRET=`command`";
  let error: unknown;
  try {
    parseServiceEnvironmentEntries([`EXAMPLE=${secret}`], "systemd");
  } catch (cause) {
    error = cause;
  }

  assert.instanceOf(error, Error);
  assert.include((error as Error).message, "--supervisor s6");
  assert.notInclude((error as Error).message, secret);
});

it.effect("rejects the option on install and update without CLI error leakage", () =>
  Effect.gen(function* () {
    const secret = "do-not-print-$SECRET=`command`";
    const run = Command.runWith(serviceCommand, { version: "test" });

    for (const action of ["install", "update"]) {
      const error = yield* run([action, "--service-environment", `EXAMPLE=${secret}`]).pipe(
        Effect.flip,
      );
      assert.instanceOf(error, Error);
      assert.include(error.message, "--supervisor s6");
      assert.notInclude(error.message, secret);
    }
  }).pipe(Effect.provide(Layer.merge(NodeServices.layer, NetService.layer))),
);

it("does not include service environment values in stale status output", () => {
  const secret = "do-not-print-$SECRET=`command`";
  const options = {
    supervisor: "s6" as const,
    s6ServiceDir: "/run/service/t3code",
    serviceEnvironment: [{ name: "EXAMPLE", value: secret }],
  };

  const output = formatServiceStatus({ ...status, current: false }, "0.0.29", options);
  assert.notInclude(output, secret);
  assert.notInclude(output, "--service-environment");
});
it("reports a newer installed service and gives an exact-version repair command", () => {
  const output = formatServiceStatus(
    { ...status, current: false, installedVersion: "0.0.32-nightly.1" },
    "0.0.31",
  );

  assert.include(output, "t3@0.0.32-nightly.1 (newer than this t3@0.0.31 CLI)");
  assert.include(output, "npx t3@0.0.32-nightly.1 service update");
  assert.notInclude(output, "npx t3@latest service update");
});

const newerServiceStatus = { ...status, current: false, installedVersion: "999.0.0" };

function makeTestService(serviceStatus: BootService.BootServiceStatus) {
  const installOptions: Array<Parameters<BootService.BootService["Service"]["install"]>[0]> = [];
  const service = BootService.BootService.of({
    status: Effect.succeed(serviceStatus),
    install: (options) =>
      Effect.sync(() => {
        installOptions.push(options);
        return {
          nodePath: "/test/node",
          t3EntryPath: "",
          launcherPath: "/test/service-launcher.mjs",
          baseDir: "/test/t3",
          unitPath: serviceStatus.unitPath,
          logPath: serviceStatus.logPath,
        };
      }),
    uninstall: Effect.succeed(false),
  });
  return { service, installOptions };
}

it.layer(Layer.mergeAll(NodeServices.layer, NetService.layer))("service commands", (it) => {
  it.effect.each(["install", "update"] as const)(
    "%s refuses a downgrade before changing the service",
    (command) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
        const { service, installOptions } = makeTestService(newerServiceStatus);
        vi.spyOn(BootService, "layer").mockReturnValue(
          Layer.succeed(BootService.BootService, service),
        );

        const error = yield* Command.runWith(serviceCommand, { version: packageJson.version })([
          command,
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcessEnvironment, {}),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
          Effect.flip,
        );

        expect(error).toMatchObject({
          _tag: "BootServiceDowngradeRefusedError",
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        });
        expect(installOptions).toEqual([]);
      }),
  );

  it.effect.each(["install", "update"] as const)("%s allows an explicit downgrade", (command) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-service-cli-test-" });
      const { service, installOptions } = makeTestService(newerServiceStatus);
      vi.spyOn(BootService, "layer").mockReturnValue(
        Layer.succeed(BootService.BootService, service),
      );

      yield* Command.runWith(serviceCommand, { version: packageJson.version })([
        command,
        "--base-dir",
        baseDir,
        "--allow-downgrade",
      ]).pipe(
        Effect.provideService(HostProcessEnvironment, {}),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
      );

      expect(installOptions).toEqual([{ allowDowngrade: true }]);
    }),
  );
});

it.effect.each([
  { name: "a new service", state: { ...status, installed: false, current: false } },
  { name: "an older service", state: { ...status, current: false, installedVersion: "0.0.0" } },
  {
    name: "the same version",
    state: { ...status, current: false, installedVersion: packageJson.version },
  },
  {
    name: "an incomplete install of the same version",
    state: {
      ...status,
      current: false,
      installedVersion: packageJson.version,
      problems: ["linger-disabled"] as const,
    },
  },
  { name: "an unknown version", state: { ...status, current: false } },
])("installs or repairs $name without an override", ({ state }) =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(state);

    const result = yield* reconcileService().pipe(
      Effect.provideService(BootService.BootService, service),
    );

    expect(result.changed).toBe(true);
    expect(installOptions).toEqual([undefined]);
  }),
);

it.effect("leaves a newer service unchanged during onboarding without prompting", () =>
  Effect.gen(function* () {
    const { service, installOptions } = makeTestService(newerServiceStatus);
    const terminal = Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      readInput: Effect.die("Onboarding must not prompt to replace a newer service."),
      readLine: Effect.die("Onboarding must not prompt to replace a newer service."),
      display: () => Effect.die("Onboarding must not prompt to replace a newer service."),
    });

    const ready = yield* offerServiceDuringOnboarding.pipe(
      Effect.provideService(BootService.BootService, service),
      Effect.provideService(Terminal.Terminal, terminal),
      Effect.provide(NodeServices.layer),
    );

    expect(ready).toBe(false);
    expect(installOptions).toEqual([]);
  }),
);

it.effect("keeps onboarding successful when a newer version appears before install", () =>
  Effect.gen(function* () {
    const ready = yield* recoverServiceOnboardingOffer(
      Effect.fail(
        new BootService.BootServiceDowngradeRefusedError({
          installedVersion: "999.0.0",
          targetVersion: packageJson.version,
        }),
      ),
    );

    expect(ready).toBe(false);
  }),
);

it.effect("keeps the manual-server fallback when background prerequisites fail", () =>
  Effect.gen(function* () {
    const ready = yield* recoverServiceOnboardingOffer(
      Effect.fail(new BootService.BootServicePrerequisiteError({ problem: "linger-disabled" })),
    );
    expect(ready).toBe(false);
  }),
);
