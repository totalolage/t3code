import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
type PluginConfig = {
  readonly android?: { readonly package?: string };
  readonly mods?: {
    readonly android?: {
      readonly appBuildGradle?: (input: GradleModInput) => Promise<GradleModInput>;
    };
  };
  readonly [key: string]: unknown;
};
type GradleModInput = PluginConfig & {
  readonly modRequest: {
    readonly platform: string;
    readonly modName: string;
    readonly introspect: boolean;
  };
  readonly modResults: { readonly language: string; readonly contents: string };
};
type SigningPlugin = ((config: PluginConfig) => PluginConfig) & {
  readonly applyF8yReleaseSigning: (contents: string) => string;
};
const signingPlugin = require("./withF8yAndroidSigning.cjs") as SigningPlugin;
const { applyF8yReleaseSigning } = signingPlugin;

const gradleTemplate = loadInstalledGradleTemplate();

describe("shipped f8y Android signing on the native Expo template", () => {
  it("uses the fork keystore for release while retaining debug signing", () => {
    const transformed = applyF8yReleaseSigning(gradleTemplate);
    const releaseStart = transformed.indexOf("        release {");
    const releaseEnd = transformed.indexOf("\n        }", releaseStart);
    expect(releaseStart).toBeGreaterThan(-1);
    expect(transformed.slice(releaseStart, releaseEnd)).toContain(
      "signingConfig signingConfigs.f8yRelease",
    );
    expect(transformed.slice(releaseStart, releaseEnd)).not.toContain(
      "signingConfig signingConfigs.debug",
    );
    expect(transformed).toContain("signingConfig signingConfigs.debug");
    for (const name of [
      "T3CODE_ANDROID_KEYSTORE_PATH",
      "T3CODE_ANDROID_STORE_PASSWORD",
      "T3CODE_ANDROID_KEY_PASSWORD",
    ]) {
      expect(transformed).toContain(`System.getenv("${name}")`);
    }
    expect(transformed).toContain('keyAlias "t3code-f8y"');
    expect(applyF8yReleaseSigning(transformed)).toBe(transformed);
  });

  it("registers the Android app Gradle mod and rejects Kotlin templates", async () => {
    const config = signingPlugin({ android: { package: "dev.f8y.t3code" } });
    const appBuildGradle = config.mods?.android?.appBuildGradle;
    if (appBuildGradle === undefined) {
      throw new Error("The signing plugin did not register an Android app Gradle mod.");
    }

    await expect(
      appBuildGradle({
        ...config,
        modRequest: { platform: "android", modName: "appBuildGradle", introspect: false },
        modResults: { language: "kt", contents: gradleTemplate },
      }),
    ).rejects.toThrow(/must use Groovy/u);

    const result = await appBuildGradle({
      ...config,
      modRequest: { platform: "android", modName: "appBuildGradle", introspect: false },
      modResults: { language: "groovy", contents: gradleTemplate },
    });
    expect(result.android?.package).toBe("dev.f8y.t3code");
    expect(result.modResults.contents).toBe(applyF8yReleaseSigning(gradleTemplate));
  });
});

function loadInstalledGradleTemplate() {
  const templatePath = NodePath.join(
    NodePath.dirname(require.resolve("expo/package.json")),
    "template.tgz",
  );
  return NodeChildProcess.execFileSync(
    "tar",
    ["-xOf", templatePath, "package/android/app/build.gradle"],
    { encoding: "utf8" },
  );
}
