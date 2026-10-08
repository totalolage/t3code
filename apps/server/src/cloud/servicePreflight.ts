import packageJson from "../../package.json" with { type: "json" };
import { isBunStandaloneRuntime } from "@t3tools/shared/hostProcess";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightRuntimeFormat = "node" | "node-sea" | "bun-standalone";

const currentRuntimeFormat = (): ServicePreflightRuntimeFormat =>
  isBunStandaloneRuntime
    ? "bun-standalone"
    : process.getBuiltinModule("node:sea")?.isSea()
      ? "node-sea"
      : "node";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
      readonly runtimeFormat?: never;
      readonly protectedLauncher?: never;
      readonly supportsProtectedLauncher?: never;
    }
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
      readonly runtimeFormat: "bun-standalone" | "node-sea";
      readonly supportsProtectedLauncher: true;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(
  input: {
    /** Older servers always pass this flag when invoking a staged preflight. */
    readonly databasePath: string;
    readonly launcherProtocol: number;
    readonly version?: string;
  },
  runtime: {
    readonly format?: ServicePreflightRuntimeFormat;
  } = {},
): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      reason:
        "This release requires a newer T3 Code service launcher. Update it on the server machine.",
    };
  }

  const runtimeFormat = runtime.format ?? currentRuntimeFormat();
  if (runtimeFormat === "bun-standalone" || runtimeFormat === "node-sea") {
    return {
      status: "ready",
      version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      runtimeFormat,
      supportsProtectedLauncher: true,
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    const hasRuntimeFormat = Object.prototype.hasOwnProperty.call(record, "runtimeFormat");
    const hasProtectedLauncherSupport = Object.prototype.hasOwnProperty.call(
      record,
      "supportsProtectedLauncher",
    );
    const hasLegacyProtectedLauncher = Object.prototype.hasOwnProperty.call(
      record,
      "protectedLauncher",
    );
    if (hasRuntimeFormat || hasProtectedLauncherSupport || hasLegacyProtectedLauncher) {
      return hasRuntimeFormat &&
        hasProtectedLauncherSupport &&
        !hasLegacyProtectedLauncher &&
        (record.runtimeFormat === "bun-standalone" || record.runtimeFormat === "node-sea") &&
        record.supportsProtectedLauncher === true
        ? {
            status: "ready",
            version: record.version,
            launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
            runtimeFormat: record.runtimeFormat,
            supportsProtectedLauncher: true,
          }
        : undefined;
    }
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
