export type AppVariant = "development" | "preview" | "production" | "f8y";

export const F8Y_APP_ID = "com.f8y.t3code";
export const F8Y_APP_IDENTITY = {
  appName: "T3 Code",
  scheme: "t3code",
  iosBundleIdentifier: F8Y_APP_ID,
  androidPackage: F8Y_APP_ID,
  relyingParty: "clerk.t3.codes",
} as const;

const F8Y_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+-f8y\.\d{8}\.\d+$/;
const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

export function resolveAppVariant(value: string | undefined): AppVariant {
  switch (value) {
    case "development":
    case "preview":
    case "production":
    case "f8y":
      return value;
    default:
      return "production";
  }
}

export function resolveF8yReleaseVersion(variant: AppVariant, value: string | undefined): string {
  if (variant !== "f8y") return "0.1.0";

  const version = value?.trim() ?? "";
  if (!F8Y_RELEASE_VERSION_PATTERN.test(version)) {
    throw new Error("T3CODE_RELEASE_VERSION must match X.Y.Z-f8y.YYYYMMDD.RUN for f8y builds.");
  }
  return version;
}

export function resolveF8yAndroidVersionCode(
  variant: AppVariant,
  value: string | undefined,
): number | undefined {
  if (variant !== "f8y") return undefined;

  const versionCode = Number(value);
  if (!Number.isInteger(versionCode) || versionCode < 1 || versionCode > ANDROID_VERSION_CODE_MAX) {
    throw new Error(
      `T3CODE_ANDROID_VERSION_CODE must be an integer from 1 to ${ANDROID_VERSION_CODE_MAX} for f8y builds.`,
    );
  }
  return versionCode;
}
