export type SettingsSheetTarget =
  | "SettingsEnvironments"
  | "SettingsNotifications"
  | "SettingsThreads"
  | "SettingsAbout"
  | "SettingsArchive"
  | "SettingsHidden"
  | "SettingsAppearance"
  | "SettingsOrganization"
  | "SettingsProjectOverview"
  | "SettingsEnvironmentNewThreads"
  | "SettingsEnvironmentSourceControl"
  | "SettingsEnvironmentAgentBehavior"
  | "SettingsEnvironmentMaintenance"
  | "SettingsProviderAccounts"
  | "SettingsKeyboard"
  | "SettingsFollowUp"
  | "SettingsScheduledTasks"
  | "SettingsProjectGrouping"
  | "SettingsClientStorage"
  | "SettingsDiagnostics"
  | "SettingsOpenSourceLicenses"
  | "SettingsUsage";

export const SETTINGS_SHEET_TARGET_PATHS: Readonly<Record<SettingsSheetTarget, string>> = {
  SettingsEnvironments: "environments",
  SettingsNotifications: "notifications",
  SettingsThreads: "thread-preferences",
  SettingsAbout: "about",
  SettingsArchive: "archive",
  SettingsHidden: "hidden",
  SettingsAppearance: "appearance",
  SettingsOrganization: "organization",
  SettingsProjectOverview: "project",
  SettingsEnvironmentNewThreads: "new-threads",
  SettingsEnvironmentSourceControl: "source-control",
  SettingsEnvironmentAgentBehavior: "agent-behavior",
  SettingsEnvironmentMaintenance: "maintenance",
  SettingsProviderAccounts: "provider-accounts",
  SettingsKeyboard: "keyboard",
  SettingsFollowUp: "follow-ups",
  SettingsScheduledTasks: "scheduled-tasks",
  SettingsProjectGrouping: "project-grouping",
  SettingsClientStorage: "client-storage",
  SettingsDiagnostics: "diagnostics",
  SettingsOpenSourceLicenses: "open-source-licenses",
  SettingsUsage: "usage",
};

export type SettingsLegalDocumentTarget = "SettingsLegal";
