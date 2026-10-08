import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";

import {
  SETTINGS_SHEET_TARGET_PATHS,
  type SettingsSheetTarget,
} from "./components/settings-sheet-targets";

function loadGetStateFromPath() {
  const require = NodeModule.createRequire(import.meta.url);
  const nativePackage = require.resolve("@react-navigation/native/package.json");
  const requireFromNative = NodeModule.createRequire(nativePackage);
  const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
  const requireFromCore = NodeModule.createRequire(corePackage);
  return requireFromCore("@react-navigation/core")
    .getStateFromPath as typeof import("@react-navigation/native").getStateFromPath;
}

const getStateFromPath = loadGetStateFromPath();

const settingsPathConfig = {
  screens: {
    SettingsSheet: {
      path: "settings",
      screens: {
        SettingsContent: {
          path: "",
          screens: {
            Settings: "",
            ...Object.fromEntries(
              Object.entries(SETTINGS_SHEET_TARGET_PATHS).map(([name, path]) => [name, { path }]),
            ),
          },
        },
      },
    },
  },
} as Parameters<typeof getStateFromPath>[1];

type NestedRouteState = {
  readonly routes: ReadonlyArray<{
    readonly name: string;
    readonly state?: NestedRouteState;
  }>;
};

function focusedRouteNames(state: ReturnType<typeof getStateFromPath>): ReadonlyArray<string> {
  const names: string[] = [];
  let current = state as NestedRouteState | null;
  while (current) {
    const route = current.routes.at(-1);
    if (!route) break;
    names.push(route.name);
    current = route.state ?? null;
  }
  return names;
}

describe.each(["ios", "android"] as const)("settings navigation on %s", (platform) => {
  it(`resolves the Hidden Threads target through the ${platform} settings stack`, () => {
    const hiddenPath = "hidden";
    expect(SETTINGS_SHEET_TARGET_PATHS.SettingsHidden).toBe(hiddenPath);
    const state = getStateFromPath(`settings/${hiddenPath}`, settingsPathConfig);

    expect(state).not.toBeNull();
    expect(focusedRouteNames(state!)).toEqual([
      "SettingsSheet",
      "SettingsContent",
      "SettingsHidden",
    ]);
  });

  it(`keeps the existing Archived Threads route resolving on ${platform}`, () => {
    const archiveTarget: SettingsSheetTarget = "SettingsArchive";
    const archivePath = "archive";
    expect(SETTINGS_SHEET_TARGET_PATHS[archiveTarget]).toBe(archivePath);
    const state = getStateFromPath(`settings/${archivePath}`, settingsPathConfig);

    expect(state).not.toBeNull();
    expect(focusedRouteNames(state!)).toEqual([
      "SettingsSheet",
      "SettingsContent",
      "SettingsArchive",
    ]);
  });
});
