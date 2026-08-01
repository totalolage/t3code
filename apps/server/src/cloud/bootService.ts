// @effect-diagnostics-next-line nodeBuiltinImport:off - s6 ownership snapshots require uid/gid metadata unavailable from Effect FileSystem.
import * as NodeFSP from "node:fs/promises";
import {
  HostProcessArguments,
  HostProcessEnvironment,
  HostProcessExecutablePath,
  HostProcessGroupId,
  HostProcessPlatform,
  HostProcessUserId,
} from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
  type PinnedRuntimePaths,
} from "./pinnedRuntime.ts";
import {
  SERVICE_LAUNCHER_FILE,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  parseServiceState,
  type ServiceState,
} from "./serviceProtocol.ts";

const BOOT_SERVICE_NAME = "t3code";
export const BOOT_SERVICE_UNIT_FILE = `${BOOT_SERVICE_NAME}.service`;
export const BOOT_SERVICE_UNIT_ENV = "T3_BOOT_SERVICE_UNIT";
export const SERVICE_SUPERVISOR_ENV = "T3_SERVICE_SUPERVISOR";
export const SERVICE_VERSION_ENV = "T3_SERVICE_VERSION";
export const S6_SERVICE_DIR_ENV = "T3_S6_SERVICE_DIR";
export const S6_SERVICE_USER_ENV = "T3_S6_SERVICE_USER";
export const S6_SERVICE_GROUP_ENV = "T3_S6_SERVICE_GROUP";
export const S6_SERVICE_LAUNCHER_ENV = "T3_S6_SERVICE_LAUNCHER";
export const S6_SERVICE_ENVIRONMENT_SENTINEL = "__t3_s6_service_environment__";

export type ServiceSupervisor = "systemd" | "s6";

export interface ServiceEnvironmentEntry {
  readonly name: string;
  readonly value: string;
}

export type ServiceEnvironmentErrorReason =
  | "invalidEntry"
  | "invalidName"
  | "reservedName"
  | "duplicateName"
  | "unsafeValue"
  | "unsupportedSupervisor";

const SERVICE_ENVIRONMENT_ERROR_MESSAGES: Record<ServiceEnvironmentErrorReason, string> = {
  invalidEntry: "Service environment entries must use NAME=VALUE.",
  invalidName:
    "Service environment names must start with a letter or underscore and contain only letters, digits, and underscores.",
  reservedName: "Service environment names must not conflict with T3-managed variables.",
  duplicateName: "Service environment names must be unique.",
  unsafeValue: "Service environment values must not contain CR, LF, or NUL characters.",
  unsupportedSupervisor: "--service-environment is supported only with --supervisor s6.",
};

const RESERVED_SERVICE_ENVIRONMENT_NAMES = new Set([
  "HOME",
  "UID",
  "GID",
  "T3CODE_HOME",
  "T3CODE_HOST",
  "T3CODE_PORT",
  BOOT_SERVICE_UNIT_ENV,
  SERVICE_SUPERVISOR_ENV,
  SERVICE_VERSION_ENV,
  S6_SERVICE_DIR_ENV,
  S6_SERVICE_USER_ENV,
  S6_SERVICE_GROUP_ENV,
  S6_SERVICE_LAUNCHER_ENV,
]);

/** Sanitized validation error: it intentionally retains neither names nor values. */
export class ServiceEnvironmentInputError extends Error {
  readonly reason: ServiceEnvironmentErrorReason;

  constructor(reason: ServiceEnvironmentErrorReason) {
    super(SERVICE_ENVIRONMENT_ERROR_MESSAGES[reason]);
    this.name = "ServiceEnvironmentInputError";
    this.reason = reason;
  }
}

export function normalizeServiceEnvironment(
  entries: ReadonlyArray<ServiceEnvironmentEntry>,
  supervisor: ServiceSupervisor,
): ReadonlyArray<ServiceEnvironmentEntry> {
  if (entries.length > 0 && supervisor !== "s6") {
    throw new ServiceEnvironmentInputError("unsupportedSupervisor");
  }

  const names = new Set<string>();
  for (const entry of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.name)) {
      throw new ServiceEnvironmentInputError("invalidName");
    }
    if (RESERVED_SERVICE_ENVIRONMENT_NAMES.has(entry.name)) {
      throw new ServiceEnvironmentInputError("reservedName");
    }
    if (names.has(entry.name)) {
      throw new ServiceEnvironmentInputError("duplicateName");
    }
    if (
      entry.value.includes("\r") ||
      entry.value.includes("\n") ||
      entry.value.includes("\u0000")
    ) {
      throw new ServiceEnvironmentInputError("unsafeValue");
    }
    names.add(entry.name);
  }

  return entries
    .map(({ name, value }) => ({ name, value }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

const EPHEMERAL_CACHE_SEGMENTS = [
  "/_npx/", // npx
  "\\_npx\\",
  "/pnpm/dlx/", // pnpm dlx (~/.cache/pnpm/dlx and $PNPM_HOME/.pnpm/dlx)
  "/.pnpm/dlx/",
  "/.bun/install/cache/", // bunx
];

/**
 * `npx t3` (and pnpm dlx / bunx) run out of ephemeral package-manager
 * caches that can be evicted at any time — a boot service must never point
 * there. Global installs, repo checkouts, and the pinned runtime below are
 * all stable.
 */
export function isEphemeralCacheEntry(entryPath: string): boolean {
  return EPHEMERAL_CACHE_SEGMENTS.some((segment) => entryPath.includes(segment));
}

export function isBunEmbeddedEntryPath(entryPath: string): boolean {
  return entryPath.replaceAll("\\", "/").startsWith("/$bunfs/");
}

/**
 * systemd expands `%` specifiers in most directive values, including the
 * `append:` file paths, which take the rest of the line literally and must
 * NOT be quoted.
 */
export function escapeSystemdSpecifiers(value: string): string {
  return value.replaceAll("%", "%%");
}

export function quoteSystemdValue(value: string): string {
  const escaped = escapeSystemdSpecifiers(value);
  return /[\s"'\\]/.test(escaped)
    ? `"${escaped.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
    : escaped;
}

export interface BootServicePlan {
  readonly supervisor?: ServiceSupervisor;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly serviceLauncherPath?: string;
  /** Absolute executable used to launch the CLI. */
  readonly nodePath: string;
  /** Optional JavaScript entry point. Empty for a standalone executable. */
  readonly t3EntryPath: string;
  /** Stable launcher used by systemd-managed exact-version installs. */
  readonly launcherPath?: string;
  readonly baseDir: string;
  /** CLI version marker used to detect in-place executable upgrades. */
  readonly cliVersion?: string;
  /** Optional network interface persisted into the service environment. */
  readonly serverHost?: string;
  /** Optional fixed HTTP/WebSocket port persisted into the service environment. */
  readonly serverPort?: number;
  /** Extra environment exported only after the s6 service drops root privileges. */
  readonly serviceEnvironment?: ReadonlyArray<ServiceEnvironmentEntry>;
  readonly logPath: string;
  readonly unitPath: string;
}

function serviceExecArgs(plan: BootServicePlan): ReadonlyArray<string> {
  return plan.t3EntryPath === ""
    ? [plan.nodePath, "serve"]
    : [plan.nodePath, plan.t3EntryPath, "serve"];
}

function serviceExecutableArgs(plan: BootServicePlan): ReadonlyArray<string> {
  return plan.t3EntryPath === "" ? [plan.nodePath] : [plan.nodePath, plan.t3EntryPath];
}

export function quoteShellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function renderServiceEnvironmentExports(
  entries: ReadonlyArray<ServiceEnvironmentEntry>,
): string {
  return entries.map(({ name, value }) => `export ${name}=${quoteShellValue(value)}`).join("\n");
}

const S6_SERVICE_ENVIRONMENT_BEGIN = "  # t3-service-environment:begin";
const S6_SERVICE_ENVIRONMENT_END = "  # t3-service-environment:end";

function serviceEnvironmentBlock(script: string): string | undefined {
  const startMarker = `${S6_SERVICE_ENVIRONMENT_BEGIN}\n`;
  const endMarker = `${S6_SERVICE_ENVIRONMENT_END}\n`;
  const start = script.indexOf(startMarker);
  if (start < 0) return undefined;
  const contentStart = start + startMarker.length;
  const end = script.indexOf(endMarker, contentStart);
  return end < 0 ? undefined : script.slice(contentStart, end);
}

function replaceServiceEnvironmentBlock(script: string, content: string): string {
  const startMarker = `${S6_SERVICE_ENVIRONMENT_BEGIN}\n`;
  const endMarker = `${S6_SERVICE_ENVIRONMENT_END}\n`;
  const start = script.indexOf(startMarker);
  if (start < 0) return script;
  const contentStart = start + startMarker.length;
  const end = script.indexOf(endMarker, contentStart);
  return end < 0 ? script : `${script.slice(0, contentStart)}${content}${script.slice(end)}`;
}

function s6DefinitionsMatch(
  installed: string,
  expected: string,
  serviceEnvironmentSpecified: boolean,
): boolean {
  if (serviceEnvironmentSpecified) return installed === expected;
  const installedEnvironment = serviceEnvironmentBlock(installed);
  const expectedEnvironment = serviceEnvironmentBlock(expected);
  if (installedEnvironment === undefined || expectedEnvironment === undefined) {
    return installed === expected;
  }
  return (
    replaceServiceEnvironmentBlock(installed, "") === replaceServiceEnvironmentBlock(expected, "")
  );
}

export interface S6ServiceIdentity {
  readonly serviceUser: string;
  readonly serviceGroup?: string;
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Resolve an s6 identity without trusting USER/LOGNAME. A non-root caller can
 * safely use its kernel identity. A root caller may inherit the original
 * identity from sudo, but otherwise must select a user explicitly.
 */
export function resolveS6ServiceIdentity(input: {
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly processUserId?: number;
  readonly processGroupId?: number;
  readonly env: NodeJS.ProcessEnv;
}): S6ServiceIdentity | undefined {
  const selectedUser = input.serviceUser?.trim();
  const selectedGroup = input.serviceGroup?.trim();
  if (selectedUser) {
    return {
      serviceUser: selectedUser,
      ...(selectedGroup ? { serviceGroup: selectedGroup } : {}),
    };
  }

  if (input.processUserId !== undefined && input.processUserId > 0) {
    return {
      serviceUser: String(input.processUserId),
      ...(selectedGroup
        ? { serviceGroup: selectedGroup }
        : input.processGroupId === undefined
          ? {}
          : { serviceGroup: String(input.processGroupId) }),
    };
  }

  const sudoUserId = parseNonNegativeInteger(input.env.SUDO_UID);
  const sudoGroupId = parseNonNegativeInteger(input.env.SUDO_GID);
  if (sudoUserId !== undefined && sudoUserId > 0 && sudoGroupId !== undefined) {
    return {
      serviceUser: String(sudoUserId),
      serviceGroup: selectedGroup ?? String(sudoGroupId),
    };
  }

  return undefined;
}

/**
 * Pure so it is testable byte-for-byte. systemd user units run with a
 * minimal environment: every path must be absolute, and the service must
 * not rely on PATH, nvm shims, or shell profiles. Failures land in
 * `logPath` because `systemctl --user` failures are otherwise invisible.
 */
export function renderBootServiceUnit(plan: BootServicePlan): string {
  // The user manager has no reliable network-online target; server networking retries itself.
  return [
    "[Unit]",
    "Description=T3 Code server",
    "StartLimitIntervalSec=300",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "WorkingDirectory=%h",
    `Environment=T3CODE_HOME=${quoteSystemdValue(plan.baseDir)}`,
    ...(plan.cliVersion === undefined
      ? []
      : [`Environment=${SERVICE_VERSION_ENV}=${quoteSystemdValue(plan.cliVersion)}`]),
    ...(plan.serverHost === undefined
      ? []
      : [`Environment=T3CODE_HOST=${quoteSystemdValue(plan.serverHost)}`]),
    ...(plan.serverPort === undefined
      ? []
      : [`Environment=T3CODE_PORT=${String(plan.serverPort)}`]),
    `Environment=${BOOT_SERVICE_UNIT_ENV}=${BOOT_SERVICE_UNIT_FILE}`,
    `Environment=${SERVICE_SUPERVISOR_ENV}=systemd`,
    `ExecStart=${
      plan.launcherPath === undefined
        ? serviceExecArgs(plan).map(quoteSystemdValue).join(" ")
        : `${quoteSystemdValue(plan.nodePath)} ${quoteSystemdValue(plan.launcherPath)}`
    }`,
    "KillMode=control-group",
    "Restart=always",
    "RestartSec=5",
    `StandardOutput=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    `StandardError=append:${escapeSystemdSpecifiers(plan.logPath)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Classic s6/scan-directory service script. The service directory is
 * explicit because s6-overlay and hand-managed scan directories do not share
 * a portable default location. */
export function renderS6RunScript(plan: BootServicePlan): string {
  if (plan.serviceUser === undefined) {
    throw new Error("An s6 service user is required.");
  }
  const serviceCommand =
    plan.serviceLauncherPath === undefined
      ? serviceExecArgs(plan)
      : [plan.serviceLauncherPath, "serve"];
  const serviceDir = pathForS6ServiceDir(plan.unitPath);
  const environmentExports = renderServiceEnvironmentExports(plan.serviceEnvironment ?? []);
  const privilegeDropArgs =
    plan.serviceGroup === undefined
      ? ["s6-setuidgid", plan.serviceUser]
      : [
          "s6-envuidgid",
          "-nB",
          `${plan.serviceUser}:${plan.serviceGroup}`,
          "/bin/sh",
          "-c",
          'exec s6-applyuidgid -z -u "$UID" -g "$GID" -G "$GID" "$@"',
          "t3code-applyuidgid",
        ];
  return [
    "#!/bin/sh",
    "set -eu",
    `if [ "\${1-}" = ${quoteShellValue(S6_SERVICE_ENVIRONMENT_SENTINEL)} ]; then`,
    "  shift",
    S6_SERVICE_ENVIRONMENT_BEGIN,
    ...environmentExports
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => `  ${line}`),
    S6_SERVICE_ENVIRONMENT_END,
    `  exec "$@" >>${quoteShellValue(plan.logPath)} 2>&1`,
    "fi",
    `export T3CODE_HOME=${quoteShellValue(plan.baseDir)}`,
    ...(plan.serverHost === undefined
      ? []
      : [`export T3CODE_HOST=${quoteShellValue(plan.serverHost)}`]),
    ...(plan.serverPort === undefined
      ? []
      : [`export T3CODE_PORT=${quoteShellValue(String(plan.serverPort))}`]),
    `export ${SERVICE_SUPERVISOR_ENV}=s6`,
    `export ${S6_SERVICE_DIR_ENV}=${quoteShellValue(pathForS6ServiceDir(plan.unitPath))}`,
    `export ${S6_SERVICE_USER_ENV}=${quoteShellValue(plan.serviceUser)}`,
    ...(plan.serviceGroup === undefined
      ? []
      : [`export ${S6_SERVICE_GROUP_ENV}=${quoteShellValue(plan.serviceGroup)}`]),
    ...(plan.serviceLauncherPath === undefined
      ? []
      : [`export ${S6_SERVICE_LAUNCHER_ENV}=${quoteShellValue(plan.serviceLauncherPath)}`]),
    'service_home=""',
    `if command -v getent >/dev/null 2>&1; then service_home=$(getent passwd ${quoteShellValue(plan.serviceUser)} 2>/dev/null | cut -d: -f6); fi`,
    'if [ -z "$service_home" ]; then',
    "  while IFS=: read -r account _ account_uid _ _ account_home _; do",
    `    if [ "$account" = ${quoteShellValue(plan.serviceUser)} ] || [ "$account_uid" = ${quoteShellValue(plan.serviceUser)} ]; then service_home=$account_home; break; fi`,
    "  done </etc/passwd",
    "fi",
    'if [ -z "$service_home" ]; then echo "Could not resolve s6 service user home." >&2; exit 1; fi',
    'export HOME="$service_home"',
    ...(plan.serviceGroup === undefined
      ? [
          `service_group=$(id -g ${quoteShellValue(plan.serviceUser)})`,
          `s6-svperms -G ":$service_group" ${quoteShellValue(serviceDir)}`,
        ]
      : [
          `s6-svperms -G ${quoteShellValue(
            /^\d+$/u.test(plan.serviceGroup) ? `:${plan.serviceGroup}` : plan.serviceGroup,
          )} ${quoteShellValue(serviceDir)}`,
        ]),
    `exec ${[
      ...privilegeDropArgs,
      "/bin/sh",
      "-s",
      "--",
      S6_SERVICE_ENVIRONMENT_SENTINEL,
      ...serviceCommand,
    ]
      .map(quoteShellValue)
      .join(" ")} <"$0"`,
    "",
  ].join("\n");
}

/** The root-owned s6 run script executes this mutable launcher only after
 * dropping privileges. Automatic updates can safely replace the launcher
 * without gaining a path to root execution. */
export function renderS6LauncherScript(plan: BootServicePlan): string {
  return [
    "#!/bin/sh",
    "set -eu",
    ...(plan.cliVersion === undefined
      ? []
      : [`export ${SERVICE_VERSION_ENV}=${quoteShellValue(plan.cliVersion)}`]),
    `exec ${serviceExecutableArgs(plan).map(quoteShellValue).join(" ")} "$@"`,
    "",
  ].join("\n");
}

function pathForS6ServiceDir(runPath: string): string {
  return runPath.endsWith("/run") ? runPath.slice(0, -4) : runPath;
}

export class BootServiceUnsupportedError extends Schema.TaggedErrorClass<BootServiceUnsupportedError>()(
  "BootServiceUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `Background setup supports Linux with systemd or an explicit s6 service directory; this machine reports '${this.platform}'.`;
  }
}

export class BootServiceCommandError extends Schema.TaggedErrorClass<BootServiceCommandError>()(
  "BootServiceCommandError",
  {
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.exitCode === undefined
      ? `Background setup failed while ${this.step}.`
      : `Background setup failed while ${this.step} (exit code ${this.exitCode}).`;
  }
}

export class BootServiceInstallError extends Schema.TaggedErrorClass<BootServiceInstallError>()(
  "BootServiceInstallError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not set up the T3 Code background service.";
  }
}

export class BootServiceIdentityError extends Schema.TaggedErrorClass<BootServiceIdentityError>()(
  "BootServiceIdentityError",
  {
    reason: Schema.Literals(["missing", "root"]),
  },
) {
  override get message(): string {
    if (this.reason === "missing") {
      return "Installing an s6 service as root requires --service-user (and optionally --service-group), unless sudo provides a non-root invoking identity.";
    }
    return "The s6 service user must resolve to a non-root UID.";
  }
}

export type BootServiceError =
  | BootServiceUnsupportedError
  | BootServiceCommandError
  | BootServiceIdentityError
  | BootServiceInstallError;

export interface BootServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current: boolean;
  readonly unitPath: string;
  readonly logPath: string;
}

export class BootService extends Context.Service<
  BootService,
  {
    readonly install: Effect.Effect<BootServicePlan, BootServiceError>;
    readonly uninstall: Effect.Effect<boolean, BootServiceError>;
    readonly status: Effect.Effect<BootServiceStatus, BootServiceError>;
  }
>()("t3/cloud/bootService") {}

export interface BootServiceHost {
  readonly execPath: string;
  readonly cliEntryPath: string;
  readonly standalone?: boolean;
  readonly launcherSourcePath?: string;
}

interface S6OwnershipSnapshot {
  readonly target: string;
  readonly owner: string;
}

export const make = Effect.fn("cloud.boot_service.make")(function* (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
  readonly serverHost?: string;
  readonly serverPort?: number;
  readonly supervisor?: ServiceSupervisor;
  readonly s6ServiceDir?: string;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly serviceEnvironment?: ReadonlyArray<ServiceEnvironmentEntry>;
}) {
  const hostArguments = yield* HostProcessArguments;
  const hostExecPath = yield* HostProcessExecutablePath;
  const platform = yield* HostProcessPlatform;
  const processEnvironment = yield* HostProcessEnvironment;
  const processUserId = yield* HostProcessUserId;
  const processGroupId = yield* HostProcessGroupId;
  const homeDir = yield* Config.string("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const argumentEntryPath = hostArguments[1] ?? "";
  const standalone =
    !path.isAbsolute(argumentEntryPath) || isBunEmbeddedEntryPath(argumentEntryPath);
  const host = input.host ?? {
    execPath: hostExecPath,
    // A compiled Bun executable exposes its embedded entry at the absolute
    // virtual /$bunfs path. That path cannot be passed back to a new process.
    cliEntryPath: standalone ? "" : argumentEntryPath,
    standalone,
  };

  const supervisor = input.supervisor ?? "systemd";
  const serviceEnvironmentSpecified = input.serviceEnvironment !== undefined;
  const serviceEnvironment = yield* Effect.try({
    try: () => normalizeServiceEnvironment(input.serviceEnvironment ?? [], supervisor),
    catch: (cause) => new BootServiceInstallError({ cause }),
  });
  const serviceIdentity =
    supervisor === "s6"
      ? resolveS6ServiceIdentity({
          ...(input.serviceUser === undefined ? {} : { serviceUser: input.serviceUser }),
          ...(input.serviceGroup === undefined ? {} : { serviceGroup: input.serviceGroup }),
          ...(processUserId === undefined ? {} : { processUserId }),
          ...(processGroupId === undefined ? {} : { processGroupId }),
          env: processEnvironment,
        })
      : undefined;
  const serviceLauncherPath =
    supervisor === "s6" ? path.join(input.baseDir, "runtime", "s6-service-launcher") : undefined;
  const unitDir =
    supervisor === "systemd"
      ? path.join(homeDir, ".config", "systemd", "user")
      : (input.s6ServiceDir ?? "");
  const unitPath = path.join(unitDir, BOOT_SERVICE_UNIT_FILE);
  const definitionPath =
    supervisor === "systemd" ? unitPath : path.join(input.s6ServiceDir ?? "", "run");
  const logPath = path.join(input.logsDir, "boot-service.log");
  const launcherPath = path.join(input.baseDir, "runtime", SERVICE_LAUNCHER_FILE);
  const statePath = path.join(input.baseDir, "runtime", SERVICE_STATE_FILE);
  const launcherSourcePath =
    host.launcherSourcePath ?? path.join(path.dirname(host.cliEntryPath), SERVICE_LAUNCHER_FILE);
  const runtimePaths = pinnedRuntimePaths(path, input.baseDir, input.cliVersion);
  const writeDurably = (filePath: string, contents: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = path.dirname(filePath);
        yield* fs.makeDirectory(directory, { recursive: true });
        const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".service-write-" });
        yield* fs.writeFileString(tempPath, contents, { mode: 0o600 });
        yield* (yield* fs.open(tempPath, { flag: "r" })).sync;
        yield* fs.rename(tempPath, filePath);
        yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
  const requireSupportedLinux = Effect.gen(function* () {
    if (
      platform !== "linux" ||
      (supervisor === "systemd" && homeDir === "") ||
      (supervisor === "s6" &&
        (input.s6ServiceDir === undefined || !path.isAbsolute(input.s6ServiceDir)))
    ) {
      return yield* new BootServiceUnsupportedError({ platform });
    }
  });

  const runStep = Effect.fn("cloud.boot_service.run_step")(function* (
    step: string,
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeout?: Duration.Input },
  ) {
    return yield* runner.run({ command, args, timeout: options?.timeout }).pipe(
      Effect.mapError((cause) => new BootServiceCommandError({ step, cause })),
      Effect.filterOrFail(
        (result) => result.code === 0,
        (result) =>
          new BootServiceCommandError({
            step,
            exitCode: Number(result.code),
            stdoutLength: result.stdout.length,
            stderrLength: result.stderr.length,
          }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: "a",
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  const waitForS6Supervision = Effect.fn("cloud.boot_service.wait_for_s6_supervision")(function* (
    serviceDir: string,
  ) {
    const attempts = 100;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = yield* runner.run({ command: "s6-svok", args: [serviceDir] }).pipe(
        Effect.mapError(
          (cause) =>
            new BootServiceCommandError({
              step: "waiting for s6 supervision",
              cause,
            }),
        ),
      );
      if (result.code === 0) return;
      if (attempt < attempts) {
        yield* Effect.sleep(Duration.millis(50));
      }
    }
    return yield* new BootServiceCommandError({
      step: "waiting for s6 supervision",
    });
  });

  /**
   * Ensures plannedEntryPath exists before the unit points at it. A stable
   * install (global bin, repo checkout) is used as-is; an ephemeral cache
   * entry is replaced by `npm install --prefix`-ing the exact running
   * version into <baseDir>/runtime/versions/<v>. A real install (not a copy
   * of bin.mjs) because t3 ships native deps like node-pty.
   */
  const validatePinnedRuntime = (runtime: PinnedRuntimePaths) =>
    runner
      .run({
        command: host.execPath,
        args: [runtime.entryPath, "--version"],
        timeout: Duration.seconds(30),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PinnedRuntimeInstallError({
              step: "verifying the pinned t3 runtime",
              cause,
            }),
        ),
        Effect.flatMap((result) => {
          const reportedVersion = /\bv(\S+)\s*$/.exec(result.stdout)?.[1];
          return result.code === 0 && reportedVersion === input.cliVersion
            ? Effect.void
            : Effect.fail(
                new PinnedRuntimeInstallError({
                  step: "verifying the pinned t3 runtime",
                  exitCode: Number(result.code),
                  stdoutLength: result.stdout.length,
                  stderrLength: result.stderr.length,
                }),
              );
        }),
      );

  const ensurePinnedRuntime = Effect.gen(function* () {
    if (host.standalone === true || !isEphemeralCacheEntry(host.cliEntryPath)) {
      return;
    }
    yield* ensurePinnedRuntimeInstalled({
      baseDir: input.baseDir,
      version: input.cliVersion,
      fs,
      path,
      runner,
      validate: validatePinnedRuntime,
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "PinnedRuntimeInstallError" && error.step.startsWith("installing")
          ? new BootServiceCommandError({
              step: error.step,
              exitCode: error.exitCode,
              stdoutLength: error.stdoutLength,
              stderrLength: error.stderrLength,
              cause: error.cause,
            })
          : new BootServiceInstallError({ cause: error }),
      ),
      Effect.tapError((error) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            fs.writeFileString(logPath, `${DateTime.formatIso(now)} ${error.message}\n`, {
              flag: "a",
            }),
          ),
          Effect.ignore,
        ),
      ),
    );
  });

  // Where the unit will point: derivable without touching the network, so
  // status can compare units purely; install materializes it first.
  const plannedEntryPath =
    host.standalone === true
      ? ""
      : isEphemeralCacheEntry(host.cliEntryPath)
        ? runtimePaths.entryPath
        : host.cliEntryPath;
  const plan: BootServicePlan = {
    supervisor,
    ...serviceIdentity,
    ...(serviceLauncherPath === undefined ? {} : { serviceLauncherPath }),
    nodePath: host.execPath,
    t3EntryPath: plannedEntryPath,
    ...(supervisor === "systemd" ? { launcherPath } : {}),
    baseDir: input.baseDir,
    cliVersion: input.cliVersion,
    ...(input.serverHost === undefined ? {} : { serverHost: input.serverHost }),
    ...(input.serverPort === undefined ? {} : { serverPort: input.serverPort }),
    ...(serviceEnvironment.length === 0 ? {} : { serviceEnvironment }),
    logPath,
    unitPath: definitionPath,
  };

  const install: BootService["Service"]["install"] = Effect.gen(function* () {
    yield* requireSupportedLinux;
    yield* fs
      .makeDirectory(input.baseDir, { recursive: true })
      .pipe(Effect.andThen(fs.makeDirectory(input.logsDir, { recursive: true })))
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));

    if (supervisor === "systemd") {
      // Prepare every immutable artifact before stopping the installed unit.
      yield* ensurePinnedRuntimeInstalled({
        baseDir: input.baseDir,
        version: input.cliVersion,
        fs,
        path,
        runner,
        validate: validatePinnedRuntime,
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "PinnedRuntimeInstallError"
            ? new BootServiceCommandError({
                step: error.step,
                exitCode: error.exitCode,
                stdoutLength: error.stdoutLength,
                stderrLength: error.stderrLength,
                cause: error,
              })
            : new BootServiceInstallError({ cause: error }),
        ),
      );

      const launcherSource = yield* fs
        .readFileString(launcherSourcePath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      const installed = yield* fs
        .exists(unitPath)
        .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
      if (installed) {
        yield* runStep("stopping the installed service", "systemctl", [
          "--user",
          "stop",
          BOOT_SERVICE_UNIT_FILE,
        ]);
      }

      yield* Effect.gen(function* () {
        yield* fs
          .makeDirectory(unitDir, { recursive: true })
          .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
        yield* writeDurably(launcherPath, launcherSource);
        yield* writeDurably(
          statePath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off - fixed launcher-owned document.
          `${JSON.stringify(
            {
              protocol: SERVICE_LAUNCHER_PROTOCOL,
              activeVersion: input.cliVersion,
            } satisfies ServiceState,
            null,
            2,
          )}\n`,
        );
        yield* writeDurably(unitPath, renderBootServiceUnit(plan));
        yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
        yield* runStep("enabling the service", "systemctl", [
          "--user",
          "enable",
          BOOT_SERVICE_UNIT_FILE,
        ]);
        yield* runStep("enabling lingering for this user", "loginctl", ["enable-linger"]);
        yield* runStep("starting the service", "systemctl", [
          "--user",
          "restart",
          BOOT_SERVICE_UNIT_FILE,
        ]);
      }).pipe(
        Effect.tapError(() =>
          installed
            ? runStep("restarting the service after a failed update", "systemctl", [
                "--user",
                "restart",
                BOOT_SERVICE_UNIT_FILE,
              ]).pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      return plan;
    }

    yield* ensurePinnedRuntime;
    if (serviceIdentity === undefined) {
      return yield* new BootServiceIdentityError({ reason: "missing" });
    }
    const numericUserId = parseNonNegativeInteger(serviceIdentity.serviceUser);
    if (numericUserId === 0) {
      return yield* new BootServiceIdentityError({ reason: "root" });
    }
    if (numericUserId === undefined) {
      const resolvedUser = yield* runStep("resolving the s6 service user", "id", [
        "-u",
        serviceIdentity.serviceUser,
      ]);
      const resolvedUserId = parseNonNegativeInteger(resolvedUser.stdout.trim());
      if (resolvedUserId === undefined || resolvedUserId === 0) {
        return yield* new BootServiceIdentityError({ reason: "root" });
      }
    }

    const previousUnit = yield* fs.exists(definitionPath).pipe(
      Effect.flatMap((exists) =>
        exists
          ? fs.readFileString(definitionPath).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none<string>()),
      ),
      Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    );
    const previousLauncher =
      serviceLauncherPath !== undefined
        ? yield* fs.exists(serviceLauncherPath).pipe(
            Effect.flatMap((exists) =>
              exists
                ? fs.readFileString(serviceLauncherPath).pipe(Effect.map(Option.some))
                : Effect.succeed(Option.none<string>()),
            ),
            Effect.mapError((cause) => new BootServiceInstallError({ cause })),
          )
        : Option.none<string>();
    const ownershipTargets = [...new Set([input.baseDir, input.logsDir])];
    const previousOwnership = yield* Effect.tryPromise({
      try: async () => {
        const snapshot: Array<S6OwnershipSnapshot> = [];
        const visit = async (target: string): Promise<void> => {
          const info = await NodeFSP.lstat(target);
          snapshot.push({
            target,
            owner: `${String(info.uid)}:${String(info.gid)}`,
          });
          if (info.isDirectory()) {
            for (const entry of await NodeFSP.readdir(target)) {
              await visit(path.join(target, entry));
            }
          }
        };
        for (const target of ownershipTargets) {
          await visit(target);
        }
        return snapshot;
      },
      catch: (cause) => new BootServiceInstallError({ cause }),
    });

    const rollbackFailedInstall = Effect.fn("cloud.boot_service.rollback_failed_install")(
      function* () {
        if (serviceLauncherPath !== undefined) {
          if (Option.isSome(previousLauncher)) {
            yield* fs
              .writeFileString(serviceLauncherPath, previousLauncher.value)
              .pipe(Effect.andThen(fs.chmod(serviceLauncherPath, 0o755)), Effect.ignore);
          } else {
            yield* fs.remove(serviceLauncherPath).pipe(Effect.ignore);
          }
        }
        if (Option.isSome(previousUnit)) {
          yield* fs.writeFileString(definitionPath, previousUnit.value).pipe(Effect.ignore);
        } else {
          yield* runStep("cleaning up the s6 service", "s6-svc", ["-d", unitDir]).pipe(
            Effect.ignore,
          );
          yield* fs.remove(definitionPath).pipe(Effect.ignore);
        }
        for (let index = previousOwnership.length - 1; index >= 0; index -= 1) {
          const ownership = previousOwnership[index];
          if (ownership === undefined) continue;
          yield* runStep("restoring s6 service state ownership", "chown", [
            "-h",
            "--",
            ownership.owner,
            ownership.target,
          ]).pipe(Effect.ignore);
        }
        if (Option.isSome(previousUnit)) {
          yield* runStep("restoring the previous s6 service", "s6-svc", ["-r", unitDir]).pipe(
            Effect.ignore,
          );
        }
      },
    );

    yield* Effect.gen(function* () {
      if (serviceLauncherPath !== undefined) {
        yield* fs.makeDirectory(path.dirname(serviceLauncherPath), { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(serviceLauncherPath, renderS6LauncherScript(plan))),
          Effect.andThen(fs.chmod(serviceLauncherPath, 0o755)),
          Effect.mapError((cause) => new BootServiceInstallError({ cause })),
        );
      }

      const owner =
        serviceIdentity.serviceGroup === undefined
          ? serviceIdentity.serviceUser
          : `${serviceIdentity.serviceUser}:${serviceIdentity.serviceGroup}`;
      yield* runStep("reconciling s6 service state ownership", "chown", [
        "-R",
        "--",
        owner,
        ...ownershipTargets,
      ]);

      const renderedDefinition = renderS6RunScript(plan);
      const previousServiceEnvironment =
        !serviceEnvironmentSpecified && Option.isSome(previousUnit)
          ? serviceEnvironmentBlock(previousUnit.value)
          : undefined;
      const definition =
        previousServiceEnvironment === undefined
          ? renderedDefinition
          : replaceServiceEnvironmentBlock(renderedDefinition, previousServiceEnvironment);
      yield* fs.makeDirectory(unitDir, { recursive: true }).pipe(
        Effect.andThen(fs.writeFileString(definitionPath, definition)),
        Effect.andThen(fs.chmod(definitionPath, 0o700)),
        Effect.mapError((cause) => new BootServiceInstallError({ cause })),
      );

      yield* runStep("rescanning the s6 service directory", "s6-svscanctl", [
        "-a",
        path.dirname(unitDir),
      ]);
      yield* waitForS6Supervision(unitDir);
      yield* runStep(
        Option.isSome(previousUnit) ? "restarting the s6 service" : "starting the s6 service",
        "s6-svc",
        [Option.isSome(previousUnit) ? "-r" : "-u", unitDir],
      );
    }).pipe(Effect.tapError(() => rollbackFailedInstall()));

    return plan;
  }).pipe(Effect.withSpan("cloud.boot_service.install"));

  const uninstall: BootService["Service"]["uninstall"] = Effect.gen(function* () {
    yield* requireSupportedLinux;
    const exists = yield* fs
      .exists(definitionPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (!exists) {
      return false;
    }
    if (supervisor === "systemd") {
      yield* runStep("stopping the service", "systemctl", [
        "--user",
        "disable",
        "--now",
        BOOT_SERVICE_UNIT_FILE,
      ]);
    } else {
      yield* runStep("stopping the s6 service", "s6-svc", ["-d", unitDir]);
    }
    yield* fs
      .remove(definitionPath)
      .pipe(Effect.mapError((cause) => new BootServiceInstallError({ cause })));
    if (supervisor === "systemd") {
      yield* runStep("reloading systemd user units", "systemctl", ["--user", "daemon-reload"]);
    }
    return true;
  }).pipe(Effect.withSpan("cloud.boot_service.uninstall"));

  const status: BootService["Service"]["status"] = Effect.gen(function* () {
    if (
      platform !== "linux" ||
      (supervisor === "systemd" && homeDir === "") ||
      (supervisor === "s6" &&
        (input.s6ServiceDir === undefined || !path.isAbsolute(input.s6ServiceDir)))
    ) {
      return {
        supported: false,
        installed: false,
        current: false,
        unitPath: definitionPath,
        logPath,
      };
    }
    const unitExists = yield* fs.exists(definitionPath);
    if (!unitExists) {
      return {
        supported: true,
        installed: false,
        current: false,
        unitPath: definitionPath,
        logPath,
      };
    }
    const unit = yield* fs.readFileString(definitionPath);
    if (supervisor === "systemd") {
      const [launcherExists, runtimeEntryExists, runtimeSentinel, stateText] = yield* Effect.all([
        fs.exists(launcherPath),
        fs.exists(runtimePaths.entryPath),
        fs.readFileString(runtimePaths.sentinelPath).pipe(Effect.option),
        fs.readFileString(statePath).pipe(Effect.option),
      ]);
      const state = Option.isSome(stateText) ? parseServiceState(stateText.value) : undefined;
      return {
        supported: true,
        installed: true,
        current:
          unit === renderBootServiceUnit(plan) &&
          launcherExists &&
          runtimeEntryExists &&
          Option.isSome(runtimeSentinel) &&
          runtimeSentinel.value.trim() === input.cliVersion &&
          state?.activeVersion === input.cliVersion &&
          state?.update?.status !== "pending",
        unitPath: definitionPath,
        logPath,
      };
    }

    const definitionPermissionsCurrent = ((yield* fs.stat(definitionPath)).mode & 0o777) === 0o700;
    // A unit is current only if it matches what install would write now (an
    // older CLI wrote a different runtime/node path) AND the entry point it
    // references still exists (a pinned runtime under ~/.t3 can be deleted to
    // reclaim space). Either mismatch makes connect offer a repair.
    const entryExists = yield* fs.exists(
      plannedEntryPath === "" ? host.execPath : plannedEntryPath,
    );
    const launcherCurrent =
      serviceLauncherPath === undefined
        ? true
        : yield* fs
            .exists(serviceLauncherPath)
            .pipe(
              Effect.flatMap((exists) =>
                exists
                  ? fs
                      .readFileString(serviceLauncherPath)
                      .pipe(Effect.map((launcher) => launcher === renderS6LauncherScript(plan)))
                  : Effect.succeed(false),
              ),
            );
    const expected = serviceIdentity === undefined ? undefined : renderS6RunScript(plan);
    const definitionCurrent =
      expected !== undefined && s6DefinitionsMatch(unit, expected, serviceEnvironmentSpecified);
    const current =
      definitionCurrent && definitionPermissionsCurrent && entryExists && launcherCurrent;
    return { supported: true, installed: true, current, unitPath: definitionPath, logPath };
  }).pipe(
    Effect.mapError((cause) => new BootServiceInstallError({ cause })),
    Effect.withSpan("cloud.boot_service.status"),
  );

  return BootService.of({ install, uninstall, status });
});

export const layer = (input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly cliVersion: string;
  readonly host?: BootServiceHost;
  readonly serverHost?: string;
  readonly serverPort?: number;
  readonly supervisor?: ServiceSupervisor;
  readonly s6ServiceDir?: string;
  readonly serviceUser?: string;
  readonly serviceGroup?: string;
  readonly serviceEnvironment?: ReadonlyArray<ServiceEnvironmentEntry>;
}) => Layer.effect(BootService, make(input));
