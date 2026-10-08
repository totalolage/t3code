import { assert, it } from "@effect/vitest";

import {
  F8Y_APP_IDENTITY,
  resolveAppVariant,
  resolveF8yBuildConfig,
  resolveF8yAndroidVersionCode,
  resolveF8yReleaseVersion,
} from "./f8yBuildConfig.ts";

it("defines a standalone f8y identity without changing the display name", () => {
  assert.deepStrictEqual(F8Y_APP_IDENTITY, {
    appName: "T3 Code",
    scheme: "t3code",
    iosBundleIdentifier: "dev.f8y.t3code",
    androidPackage: "dev.f8y.t3code",
    relyingParty: "clerk.t3.codes",
  });
  assert.equal(resolveAppVariant("f8y"), "f8y");
  assert.equal(resolveAppVariant(undefined), "production");
});

it("validates f8y version names and Android version codes", () => {
  assert.equal(resolveF8yReleaseVersion("f8y", "0.0.29-f8y.20260720.42"), "0.0.29-f8y.20260720.42");
  assert.equal(resolveF8yAndroidVersionCode("f8y", "42"), 42);
  assert.throws(() => resolveF8yReleaseVersion("f8y", "0.0.29"));
  assert.throws(() => resolveF8yAndroidVersionCode("f8y", "0"));
  assert.throws(() => resolveF8yAndroidVersionCode("f8y", "2.5"));
});

it("preserves existing variant defaults without release environment variables", () => {
  assert.equal(resolveF8yReleaseVersion("production", undefined), "2.0.0");
  assert.equal(resolveF8yAndroidVersionCode("production", undefined), undefined);
});

it("keeps shipped version inputs independent of the GitHub run environment", () => {
  assert.deepStrictEqual(
    resolveF8yBuildConfig({
      T3CODE_RELEASE_VERSION: " 0.0.29-f8y.20260720.42 ",
      T3CODE_ANDROID_VERSION_CODE: "43",
    }),
    {
      version: "0.0.29-f8y.20260720.42",
      versionCode: 43,
      artifactName: "T3-Code-0.0.29-f8y.20260720.42-android.apk",
    },
  );
});
