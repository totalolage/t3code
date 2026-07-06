import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { selectProjectGroupingSettings } from "../logicalProject";
import {
  areSettingsSelectionsEqual,
  createSettingsSelectorSnapshotReader,
  mergeEnvironmentSettings,
} from "./useSettings";

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });
});

describe("createSettingsSelectorSnapshotReader", () => {
  it("reuses the selected reference when unrelated settings change", () => {
    let settings = DEFAULT_CLIENT_SETTINGS;
    const readProjectGroupingSettings = createSettingsSelectorSnapshotReader(
      () => settings,
      selectProjectGroupingSettings,
    );

    const initialSelection = readProjectGroupingSettings();
    settings = {
      ...settings,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };
    const unrelatedUpdateSelection = readProjectGroupingSettings();

    expect(unrelatedUpdateSelection).toBe(initialSelection);

    settings = {
      ...settings,
      sidebarProjectGroupingMode: "physical-worktree",
    };
    const relatedUpdateSelection = readProjectGroupingSettings();

    expect(relatedUpdateSelection).not.toBe(initialSelection);
    expect(relatedUpdateSelection.sidebarProjectGroupingMode).toBe("physical-worktree");
  });
});

describe("areSettingsSelectionsEqual", () => {
  it("compares selected objects shallowly", () => {
    expect(areSettingsSelectionsEqual({ a: 1, b: "same" }, { a: 1, b: "same" })).toBe(true);
    expect(areSettingsSelectionsEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
});
