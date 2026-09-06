import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Terminal from "effect/Terminal";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import packageJson from "../../package.json" with { type: "json" };
import * as BootService from "../cloud/bootService.ts";
import { compareExactServiceVersions } from "../cloud/serviceProtocol.ts";
import type * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import { hostFlag, portFlag, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const bootServiceLayer = (
  config: ServerConfig.ServerConfig["Service"],
  options?: {
    readonly supervisor?: BootService.ServiceSupervisor;
    readonly s6ServiceDir?: string;
    readonly serverHost?: string;
    readonly serverPort?: number;
    readonly serviceUser?: string;
    readonly serviceGroup?: string;
    readonly serviceEnvironment?: ReadonlyArray<BootService.ServiceEnvironmentEntry>;
  },
) =>
  BootService.layer({
    baseDir: config.baseDir,
    logsDir: config.logsDir,
    cliVersion: packageJson.version,
    ...(options?.supervisor === undefined ? {} : { supervisor: options.supervisor }),
    ...(options?.s6ServiceDir === undefined ? {} : { s6ServiceDir: options.s6ServiceDir }),
    ...(options?.serverHost === undefined ? {} : { serverHost: options.serverHost }),
    ...(options?.serverPort === undefined ? {} : { serverPort: options.serverPort }),
    ...(options?.serviceUser === undefined ? {} : { serviceUser: options.serviceUser }),
    ...(options?.serviceGroup === undefined ? {} : { serviceGroup: options.serviceGroup }),
    ...(options?.serviceEnvironment === undefined
      ? {}
      : { serviceEnvironment: options.serviceEnvironment }),
  }).pipe(Layer.provide(ProcessRunner.layer));

const supervisorFlag = Flag.choice("supervisor", ["systemd", "s6"] as const).pipe(
  Flag.withDescription("Service supervisor to configure."),
  Flag.withDefault("systemd"),
);

const s6ServiceDirFlag = Flag.string("service-dir").pipe(
  Flag.withDescription("Absolute s6 scan-directory service path (required with --supervisor s6)."),
  Flag.optional,
);

const serviceUserFlag = Flag.string("service-user").pipe(
  Flag.withDescription(
    "Non-root user for the s6 service (defaults to the invoking non-root or sudo identity).",
  ),
  Flag.optional,
);

const serviceGroupFlag = Flag.string("service-group").pipe(
  Flag.withDescription("Group for the s6 service (defaults with the invoking identity)."),
  Flag.optional,
);

const serviceEnvironmentFlag = Flag.string("service-environment").pipe(
  Flag.atLeast(0),
  Flag.withDescription(
    "Environment entry for the s6 service as NAME=VALUE. Repeat for multiple entries.",
  ),
  Flag.withMetavar("NAME=VALUE"),
);

const serviceFlags = {
  ...projectLocationFlags,
  host: hostFlag,
  port: portFlag,
  supervisor: supervisorFlag,
  s6ServiceDir: s6ServiceDirFlag,
  serviceUser: serviceUserFlag,
  serviceGroup: serviceGroupFlag,
};

const serviceMutationFlags = {
  ...serviceFlags,
  serviceEnvironment: serviceEnvironmentFlag,
};

export function parseServiceEnvironmentEntries(
  values: ReadonlyArray<string>,
  supervisor: BootService.ServiceSupervisor,
): ReadonlyArray<BootService.ServiceEnvironmentEntry> {
  const entries = values.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new BootService.ServiceEnvironmentInputError("invalidEntry");
    }
    return {
      name: entry.slice(0, separator),
      value: entry.slice(separator + 1),
    };
  });
  return BootService.normalizeServiceEnvironment(entries, supervisor);
}

class ServiceEnvironmentCliError extends CliError.UserError {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : "Invalid service environment configuration.";
  }
}

export type ServiceReconcileResult =
  | {
      readonly changed: false;
      readonly status: BootService.BootServiceStatus;
    }
  | {
      readonly changed: true;
      readonly previouslyInstalled: boolean;
      readonly plan: BootService.BootServicePlan;
    };

/** Install, update, or repair the service using the CLI version running this command. */
export const reconcileService = Effect.fn("cli.service.reconcile")(function* (options?: {
  readonly allowDowngrade?: boolean;
}) {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  if (status.installed && status.current) {
    return { changed: false, status } satisfies ServiceReconcileResult;
  }
  if (
    status.installedVersion !== undefined &&
    options?.allowDowngrade !== true &&
    compareExactServiceVersions(packageJson.version, status.installedVersion) < 0
  ) {
    return yield* new BootService.BootServiceDowngradeRefusedError({
      installedVersion: status.installedVersion,
      targetVersion: packageJson.version,
    });
  }
  const plan = yield* service.install(options);
  return {
    changed: true,
    previouslyInstalled: status.installed,
    plan,
  } satisfies ServiceReconcileResult;
});

export function formatServiceStatus(
  status: BootService.BootServiceStatus,
  cliVersion: string,
  options?: {
    readonly supervisor?: BootService.ServiceSupervisor;
    readonly s6ServiceDir?: string;
    readonly serverHost?: string;
    readonly serverPort?: number;
    readonly serviceUser?: string;
    readonly serviceGroup?: string;
  },
): string {
  if (!status.supported) {
    return "T3 Code service\n  Status: unavailable for this configuration\n  Supported on: Linux with systemd, macOS with launchd, or s6 with --service-dir";
  }
  if (!status.installed) {
    return "T3 Code service\n  Status: not installed\n  Next: Run `t3 service install`.";
  }
  const installedVersion = status.installedVersion ?? cliVersion;
  const problems = (status.problems ?? []).map(
    (problem) => `  [${problem}] ${BootService.formatBootServiceProblem(problem)}`,
  );
  const repairCommand = (version: string) => {
    const parts = [`npx t3@${version} service update`];
    if (options?.supervisor === "s6" && options.s6ServiceDir !== undefined) {
      parts.push(
        "--supervisor s6",
        `--service-dir ${BootService.quoteShellValue(options.s6ServiceDir)}`,
      );
      if (options.serviceUser !== undefined) {
        parts.push(`--service-user ${BootService.quoteShellValue(options.serviceUser)}`);
      }
      if (options.serviceGroup !== undefined) {
        parts.push(`--service-group ${BootService.quoteShellValue(options.serviceGroup)}`);
      }
    }
    if (options?.serverHost !== undefined) {
      parts.push(`--host ${BootService.quoteShellValue(options.serverHost)}`);
    }
    if (options?.serverPort !== undefined) {
      parts.push(`--port ${String(options.serverPort)}`);
    }
    return parts.join(" ");
  };
  if (
    !status.current &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, cliVersion) > 0
  ) {
    return [
      "T3 Code service",
      `  Status: installed · t3@${installedVersion} (newer than this t3@${cliVersion} CLI)`,
      `  Unit: ${status.unitPath}`,
      `  Logs: ${status.logPath}`,
      ...problems,
      `  Next: Use \`${repairCommand(installedVersion)}\` to repair it, or pass \`--allow-downgrade\` explicitly.`,
    ].join("\n");
  }
  return [
    "T3 Code service",
    `  Status: ${status.current ? `installed · t3@${installedVersion}` : "needs an update or repair"}`,
    `  Unit: ${status.unitPath}`,
    `  Logs: ${status.logPath}`,
    ...problems,
    ...(status.current ? [] : [`  Next: Run \`${repairCommand(cliVersion)}\`.`]),
  ].join("\n");
}

const runServiceCommand = Effect.fn("cli.service.run")(function* <A, E>(
  flags: {
    readonly baseDir: Parameters<typeof resolveCliAuthConfig>[0]["baseDir"];
    readonly host: Option.Option<string>;
    readonly port: Option.Option<number>;
    readonly supervisor: BootService.ServiceSupervisor;
    readonly s6ServiceDir: Option.Option<string>;
    readonly serviceUser: Option.Option<string>;
    readonly serviceGroup: Option.Option<string>;
    readonly serviceEnvironment?: ReadonlyArray<string>;
  },
  run: Effect.Effect<A, E, BootService.BootService>,
) {
  const serviceEnvironment = yield* Effect.try({
    try: () => parseServiceEnvironmentEntries(flags.serviceEnvironment ?? [], flags.supervisor),
    catch: (cause) => new ServiceEnvironmentCliError({ cause }),
  });
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* run.pipe(
    Effect.provide(
      bootServiceLayer(config, {
        supervisor: flags.supervisor,
        ...(Option.isSome(flags.s6ServiceDir) ? { s6ServiceDir: flags.s6ServiceDir.value } : {}),
        ...(Option.isSome(flags.host) ? { serverHost: flags.host.value } : {}),
        ...(Option.isSome(flags.port) ? { serverPort: flags.port.value } : {}),
        ...(Option.isSome(flags.serviceUser) ? { serviceUser: flags.serviceUser.value } : {}),
        ...(Option.isSome(flags.serviceGroup) ? { serviceGroup: flags.serviceGroup.value } : {}),
        ...(serviceEnvironment.length === 0 ? {} : { serviceEnvironment }),
      }),
    ),
  );
});

const serviceReconcileFlags = {
  ...serviceMutationFlags,
  allowDowngrade: Flag.boolean("allow-downgrade").pipe(
    Flag.withDescription("Allow replacing a newer installed service with this older CLI version."),
    Flag.withDefault(false),
  ),
};

const serviceInstallCommand = Command.make("install", serviceReconcileFlags).pipe(
  Command.withDescription("Install T3 Code as a background service for this user."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
        if (!result.changed) {
          yield* Console.log(
            `T3 Code service is already installed with t3@${packageJson.version}.`,
          );
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceUpdateCommand = Command.make("update", serviceReconcileFlags).pipe(
  Command.withDescription(
    "Update or repair the background service using this CLI version. Use `npx t3@latest service update` for the latest release.",
  ),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const result = yield* reconcileService({ allowDowngrade: flags.allowDowngrade });
        if (!result.changed) {
          yield* Console.log(`T3 Code service is already using t3@${packageJson.version}.`);
          return;
        }
        yield* Console.log(
          `${result.previouslyInstalled ? "Updated" : "Installed"} T3 Code service with t3@${packageJson.version}.\nLogs: ${result.plan.logPath}`,
        );
      }),
    ),
  ),
);

const serviceUninstallCommand = Command.make("uninstall", serviceFlags).pipe(
  Command.withDescription("Stop and remove the T3 Code background service."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        const removed = yield* service.uninstall;
        yield* Console.log(
          removed ? "Removed the T3 Code service." : "T3 Code service is not installed.",
        );
      }),
    ),
  ),
);

const serviceStatusCommand = Command.make("status", serviceFlags).pipe(
  Command.withDescription("Show whether the T3 Code background service is installed."),
  Command.withHandler((flags) =>
    runServiceCommand(
      flags,
      Effect.gen(function* () {
        const service = yield* BootService.BootService;
        yield* Console.log(
          formatServiceStatus(yield* service.status, packageJson.version, {
            supervisor: flags.supervisor,
            ...(Option.isSome(flags.s6ServiceDir)
              ? { s6ServiceDir: flags.s6ServiceDir.value }
              : {}),
            ...(Option.isSome(flags.host) ? { serverHost: flags.host.value } : {}),
            ...(Option.isSome(flags.port) ? { serverPort: flags.port.value } : {}),
            ...(Option.isSome(flags.serviceUser) ? { serviceUser: flags.serviceUser.value } : {}),
            ...(Option.isSome(flags.serviceGroup)
              ? { serviceGroup: flags.serviceGroup.value }
              : {}),
          }),
        );
      }),
    ),
  ),
);

export const offerServiceDuringOnboarding = Effect.gen(function* () {
  const service = yield* BootService.BootService;
  const status = yield* service.status;
  const { supported, installed, current } = status;
  if (!supported) {
    return false;
  }
  if (installed && current) {
    yield* Console.log("T3 Code is already set up to run in the background on this machine.");
    return true;
  }
  for (const problem of status.problems ?? []) {
    yield* Console.warn(`[${problem}] ${BootService.formatBootServiceProblem(problem)}`);
  }
  if (
    installed &&
    status.installedVersion !== undefined &&
    compareExactServiceVersions(status.installedVersion, packageJson.version) > 0
  ) {
    yield* Console.log(
      `A newer t3@${status.installedVersion} background service is installed. Leaving it unchanged.`,
    );
    // This CLI cannot verify the newer service. Keep the manual fallback available.
    return false;
  }
  // A LaunchAgent starts at login and dies at logout; there is no
  // enable-linger equivalent on macOS. Do not promise more than that.
  const platform = yield* HostProcessPlatform;
  const wanted = yield* Prompt.run(
    Prompt.confirm({
      message: installed
        ? "The installed T3 Code service needs an update or repair. Update it now?"
        : platform === "darwin"
          ? "Run T3 Code in the background whenever you log in to this Mac? " +
            "It stays reachable through T3 Connect while you are logged in."
          : "Run T3 Code in the background whenever this machine boots? " +
            "It stays reachable through T3 Connect even after you log out.",
      initial: true,
    }),
  );
  if (!wanted) {
    return false;
  }
  const result = yield* reconcileService();
  if (result.changed) {
    yield* Console.log(
      `Background service ${result.previouslyInstalled ? "updated" : "installed"}. Logs: ${result.plan.logPath}`,
    );
  }
  return true;
});

export const recoverServiceOnboardingOffer = <R>(
  offer: Effect.Effect<boolean, BootService.BootServiceError | Terminal.QuitError, R>,
) =>
  offer.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed(false),
      BootServiceUnsupportedError: (error) =>
        Console.log(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
      BootServiceCommandError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceIdentityError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceInstallError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServicePrerequisiteError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceUpdatePendingError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceDowngradeRefusedError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
    }),
  );

export const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Manage the T3 Code background service."),
  Command.withSubcommands([
    serviceInstallCommand,
    serviceUninstallCommand,
    serviceUpdateCommand,
    serviceStatusCommand,
  ]),
);
