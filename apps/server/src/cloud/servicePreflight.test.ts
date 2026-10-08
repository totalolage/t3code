import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { HostProcessIsExecutable, isBunStandaloneRuntime } from "@t3tools/shared/hostProcess";
import { decodeServicePreflightResult, runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

const preflightInput = {
  databasePath: "/missing/state.sqlite",
  launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  version: "1.2.3",
};

it.each([1, 2])("blocks legacy launcher protocol %i", (launcherProtocol) => {
  expect(
    runServicePreflight(
      {
        databasePath: "/missing/state.sqlite",
        launcherProtocol,
        version: "1.2.3",
      },
      { format: "node" },
    ),
  ).toEqual({
    status: "blocked",
    version: "1.2.3",
    reason:
      "This release requires a newer T3 Code service launcher. Update it on the server machine.",
  });
});

it("accepts the current launcher protocol", () => {
  expect(
    runServicePreflight(
      {
        databasePath: "/missing/state.sqlite",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "1.2.3",
      },
      { format: "node" },
    ),
  ).toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  });
});

it.effect("detects the current runtime and executable status without a format override", () =>
  Effect.gen(function* () {
    const nodeSea = process.getBuiltinModule("node:sea");
    const isNodeSea = nodeSea?.isSea() ?? false;
    const expectedFormat = isBunStandaloneRuntime
      ? "bun-standalone"
      : isNodeSea
        ? "node-sea"
        : "node";

    const preflight = runServicePreflight(preflightInput);
    if (expectedFormat === "node") {
      expect(preflight).toEqual({
        status: "ready",
        version: "1.2.3",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      });
    } else {
      expect(preflight).toEqual({
        status: "ready",
        version: "1.2.3",
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        runtimeFormat: expectedFormat,
        supportsProtectedLauncher: true,
      });
    }

    const isExecutable = yield* HostProcessIsExecutable;
    expect(isExecutable).toBe(isBunStandaloneRuntime || isNodeSea);
  }),
);

it.each(["bun-standalone", "node-sea"] as const)(
  "reports protected-launcher support for %s without inheriting the source context",
  (format) => {
    expect(runServicePreflight(preflightInput, { format })).toEqual({
      status: "ready",
      version: "1.2.3",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      runtimeFormat: format,
      supportsProtectedLauncher: true,
    });
  },
);

it("decodes Node readiness and rejects incomplete or legacy RAW facts", () => {
  const numericReady = {
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
  };
  expect(decodeServicePreflightResult(numericReady)).toEqual(numericReady);
  for (const format of ["bun-standalone", "node-sea"] as const) {
    expect(
      decodeServicePreflightResult({ ...numericReady, runtimeFormat: format }),
    ).toBeUndefined();
    expect(
      decodeServicePreflightResult({
        ...numericReady,
        runtimeFormat: format,
        supportsProtectedLauncher: true,
      }),
    ).toEqual({
      ...numericReady,
      runtimeFormat: format,
      supportsProtectedLauncher: true,
    });
    expect(
      decodeServicePreflightResult({
        ...numericReady,
        runtimeFormat: format,
        supportsProtectedLauncher: false,
      }),
    ).toBeUndefined();
  }
  expect(
    decodeServicePreflightResult({
      ...numericReady,
      runtimeFormat: "node",
      supportsProtectedLauncher: true,
    }),
  ).toBeUndefined();
  expect(
    decodeServicePreflightResult({
      ...numericReady,
      runtimeFormat: "bun-standalone",
      protectedLauncher: true,
    }),
  ).toBeUndefined();
});
