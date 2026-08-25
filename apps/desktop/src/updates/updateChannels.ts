import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;
const F8Y_VERSION_PATTERN = /-f8y\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}

export function resolveDesktopUpdaterChannel(
  appVersion: string,
  selectedChannel: DesktopUpdateChannel,
): string {
  return F8Y_VERSION_PATTERN.test(appVersion) ? "f8y" : selectedChannel;
}
