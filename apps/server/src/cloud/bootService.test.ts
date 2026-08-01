import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessGroupId,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as BootService from "./bootService.ts";
import { pinnedRuntimePaths } from "./pinnedRuntime.ts";
import { parseServiceState } from "./serviceProtocol.ts";

it("keeps systemd pinned to the stable launcher rather than a versioned server", () => {
  const unit = BootService.renderBootServiceUnit({
    nodePath: "/usr/bin/node",
    t3EntryPath: "/home/theo/.t3/runtime/versions/1.2.3/node_modules/t3/dist/bin.mjs",
    launcherPath: "/home/theo/.t3/runtime/service-launcher.mjs",
    baseDir: "/home/theo/.t3",
    logPath: "/home/theo/.t3/userdata/logs/boot-service.log",
    unitPath: "/home/theo/.config/systemd/user/t3code.service",
  });

  expect(unit).toContain("ExecStart=/usr/bin/node /home/theo/.t3/runtime/service-launcher.mjs");
  expect(unit).toContain("Environment=T3_SERVICE_SUPERVISOR=systemd");
  expect(unit).toContain("KillMode=control-group");
  expect(unit).not.toContain("versions/1.2.3");
});

it("renders s6 service environment only after privilege drop", () => {
  const secret = "/home/hermes/T3's $data `literal`";
  const plan: BootService.BootServicePlan = {
    supervisor: "s6",
    serviceUser: "theo",
    serviceGroup: "staff",
    nodePath: "/usr/local/bin/t3",
    t3EntryPath: "",
    baseDir: "/home/theo/.t3",
    serviceEnvironment: [{ name: "HERMES_HOME", value: secret }],
    logPath: "/home/theo/.t3/service.log",
    unitPath: "/run/service/t3code/run",
  };

  const script = BootService.renderS6RunScript(plan);
  expect(script).toContain(BootService.S6_SERVICE_ENVIRONMENT_SENTINEL);
  expect(script).toContain("export HERMES_HOME=");
  expect(script).not.toContain(secret);
  expect(BootService.renderS6LauncherScript(plan)).not.toContain("HERMES_HOME");
});

it("resolves s6 identity from the kernel or sudo rather than USER", () => {
  expect(
    BootService.resolveS6ServiceIdentity({
      processUserId: 1001,
      processGroupId: 1002,
      env: { USER: "stale" },
    }),
  ).toEqual({ serviceUser: "1001", serviceGroup: "1002" });
  expect(
    BootService.resolveS6ServiceIdentity({
      processUserId: 0,
      processGroupId: 0,
      env: { SUDO_UID: "2001", SUDO_GID: "2002" },
    }),
  ).toEqual({ serviceUser: "2001", serviceGroup: "2002" });
});

const hostLayer = (home: string, platform: NodeJS.Platform = "linux") =>
  Layer.mergeAll(
    Layer.succeed(HostProcessPlatform, platform),
    Layer.succeed(HostProcessExecutablePath, "/usr/bin/node"),
    Layer.succeed(HostProcessArguments, ["/usr/bin/node", `${home}/bin.mjs`]),
    Layer.succeed(HostProcessEnvironment, {}),
    Layer.succeed(HostProcessUserId, 1000),
    Layer.succeed(HostProcessGroupId, 1000),
    ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HOME: home } })),
  );

const makeHarness = Effect.fn("test.make_boot_service_harness")(function* (
  platform: NodeJS.Platform = "linux",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-boot-service-test-" });
  const baseDir = path.join(home, ".t3");
  const sourceLauncher = path.join(home, "service-launcher.mjs");
  const statePath = path.join(baseDir, "runtime", "service-state.json");
  yield* fs.writeFileString(sourceLauncher, "export {};\n");
  const runtime = pinnedRuntimePaths(path, baseDir, "1.2.3");
  yield* fs.makeDirectory(path.dirname(runtime.entryPath), { recursive: true });
  yield* fs.writeFileString(runtime.entryPath, "export {};\n");
  yield* fs.writeFileString(runtime.sentinelPath, "1.2.3\n");

  const commands: string[] = [];
  const control: { failCommand: string | undefined } = { failCommand: undefined };
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.sync(() => {
        const command = `${input.command} ${input.args.join(" ")}`;
        commands.push(command);
        return {
          stdout: input.args[1] === "--version" ? "t3 v1.2.3\n" : "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(command === control.failCommand ? 1 : 0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      }),
  });
  const service = yield* BootService.make({
    baseDir,
    logsDir: path.join(baseDir, "userdata", "logs"),
    cliVersion: "1.2.3",
    host: {
      execPath: "/usr/bin/node",
      cliEntryPath: path.join(home, "bin.mjs"),
      launcherSourcePath: sourceLauncher,
    },
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provide(hostLayer(home, platform)),
  );
  return { service, fs, statePath, commands, control };
});

it.layer(NodeServices.layer)("boot service install", (it) => {
  it.effect("installs, reports current state, and uninstalls", () =>
    Effect.gen(function* () {
      const { service, fs, statePath, commands } = yield* makeHarness();
      const plan = yield* service.install;

      expect(parseServiceState(yield* fs.readFileString(statePath))).toEqual({
        protocol: 1,
        activeVersion: "1.2.3",
      });
      expect(plan.launcherPath).toBeDefined();
      if (plan.launcherPath === undefined) return;
      expect(yield* fs.readFileString(plan.launcherPath)).toBe("export {};\n");
      expect((yield* service.status).current).toBe(true);
      yield* fs.writeFileString(
        statePath,
        '{"protocol":1,"activeVersion":"1.2.3","update":{"id":"u","fromVersion":"1.2.3","targetVersion":"1.2.4","status":"pending"}}',
      );
      expect((yield* service.status).current).toBe(false);
      expect(yield* service.uninstall).toBe(true);
      expect((yield* service.status).installed).toBe(false);
      expect(commands.some((command) => command.startsWith("npm "))).toBe(false);
    }),
  );

  it.effect("restarts an installed service when repair fails", () =>
    Effect.gen(function* () {
      const { service, commands, control } = yield* makeHarness();
      yield* service.install;
      commands.length = 0;
      control.failCommand = "systemctl --user daemon-reload";

      const error = yield* service.install.pipe(Effect.flip);
      expect(error._tag).toBe("BootServiceCommandError");
      expect(commands.filter((command) => command.startsWith("systemctl "))).toEqual([
        "systemctl --user stop t3code.service",
        "systemctl --user daemon-reload",
        "systemctl --user restart t3code.service",
      ]);
    }),
  );

  it.effect("installs and removes an s6 scan-directory service", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-s6-service-test-" });
      const baseDir = path.join(home, ".t3");
      const serviceDir = path.join(home, "service", "t3code");
      const executable = path.join(home, "t3");
      yield* fs.writeFileString(executable, "#!/bin/sh\n");
      const commands: string[] = [];
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() => {
            commands.push(`${input.command} ${input.args.join(" ")}`);
            return {
              stdout: "",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            };
          }),
      });
      const service = yield* BootService.make({
        baseDir,
        logsDir: path.join(baseDir, "userdata", "logs"),
        cliVersion: "1.2.3",
        supervisor: "s6",
        s6ServiceDir: serviceDir,
        host: { execPath: executable, cliEntryPath: "", standalone: true },
      }).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provide(hostLayer(home)),
      );

      const plan = yield* service.install;
      expect((yield* fs.stat(plan.unitPath)).mode & 0o777).toBe(0o700);
      expect((yield* service.status).current).toBe(true);
      expect(commands).toContain(`s6-svc -u ${serviceDir}`);
      expect(yield* service.uninstall).toBe(true);
      expect(commands).toContain(`s6-svc -d ${serviceDir}`);
    }),
  );

  it.effect("fails closed off Linux", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness("darwin");
      expect((yield* service.status).supported).toBe(false);
      expect((yield* service.install.pipe(Effect.flip))._tag).toBe("BootServiceUnsupportedError");
    }),
  );
});
