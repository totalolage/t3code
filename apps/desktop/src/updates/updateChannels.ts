import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /^[^-+]+-nightly\.\d{8}\.\d+$/;
// Preview builds are the maintainers' test train, cut by hand from unreleased
// branches to exercise the release flow. They share nightly's branding but
// are packaged without an update feed (see
// isDesktopPreviewVersion in scripts/build-desktop-artifact.ts), so the
// channel a preview install reports is cosmetic: it never checks for updates
// and no updater feed ever lists a preview release.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;
const F8Y_VERSION_PATTERN = /-f8y\.\d{8}\.\d+$/;

export type DesktopUpdaterChannel = DesktopUpdateChannel | "f8y";

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

export function isF8yDesktopVersion(version: string): boolean {
  return F8Y_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return NIGHTLY_VERSION_PATTERN.test(appVersion) ? "nightly" : "latest";
}

export function resolveDesktopUpdaterChannel(
  appVersion: string,
  selectedChannel: DesktopUpdateChannel,
): DesktopUpdaterChannel {
  return isF8yDesktopVersion(appVersion) ? "f8y" : selectedChannel;
}
