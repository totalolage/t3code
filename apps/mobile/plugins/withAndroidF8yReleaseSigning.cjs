const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING_CONFIG_MARKER = "// f8y release signing (withAndroidF8yReleaseSigning)";
const SIGNING_CONFIG = `${SIGNING_CONFIG_MARKER}
        f8yRelease {
            def keystorePath = System.getenv("T3CODE_ANDROID_KEYSTORE_PATH")
            def storePasswordValue = System.getenv("T3CODE_ANDROID_STORE_PASSWORD")
            def keyPasswordValue = System.getenv("T3CODE_ANDROID_KEY_PASSWORD")
            if (!keystorePath || !storePasswordValue || !keyPasswordValue) {
                throw new GradleException("f8y Android release signing environment is incomplete.")
            }
            storeFile file(keystorePath)
            storePassword storePasswordValue
            keyAlias "t3code-f8y"
            keyPassword keyPasswordValue
        }`;

function applyF8yReleaseSigning(contents) {
  if (contents.includes(SIGNING_CONFIG_MARKER)) {
    return contents;
  }

  const signingConfigsAnchor = "    signingConfigs {";
  if (!contents.includes(signingConfigsAnchor)) {
    throw new Error(
      "withAndroidF8yReleaseSigning: could not find signingConfigs in app/build.gradle; the Expo template changed.",
    );
  }

  let nextContents = contents.replace(
    signingConfigsAnchor,
    `${signingConfigsAnchor}\n${SIGNING_CONFIG}`,
  );

  const releaseSigningPattern = /(release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
  if (!releaseSigningPattern.test(nextContents)) {
    throw new Error(
      "withAndroidF8yReleaseSigning: could not find the release debug signing assignment; the Expo template changed.",
    );
  }

  nextContents = nextContents.replace(
    releaseSigningPattern,
    "$1signingConfig signingConfigs.f8yRelease",
  );
  return nextContents;
}

function withAndroidF8yReleaseSigning(config) {
  return withAppBuildGradle(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "groovy") {
      throw new Error("withAndroidF8yReleaseSigning: app/build.gradle must use Groovy.");
    }
    nextConfig.modResults.contents = applyF8yReleaseSigning(nextConfig.modResults.contents);
    return nextConfig;
  });
}

module.exports = withAndroidF8yReleaseSigning;
module.exports.applyF8yReleaseSigning = applyF8yReleaseSigning;
