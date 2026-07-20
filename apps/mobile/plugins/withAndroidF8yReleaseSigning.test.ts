import * as NodeModule from "node:module";

import { assert, it } from "@effect/vitest";

const require = NodeModule.createRequire(import.meta.url);
const { applyF8yReleaseSigning } = require("./withAndroidF8yReleaseSigning.cjs") as {
  readonly applyF8yReleaseSigning: (contents: string) => string;
};

const gradleFixture = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}
`;

it("adds environment-backed f8y release signing idempotently", () => {
  const configured = applyF8yReleaseSigning(gradleFixture);

  assert.include(configured, 'System.getenv("T3CODE_ANDROID_KEYSTORE_PATH")');
  assert.include(configured, 'keyAlias "t3code-f8y"');
  assert.include(configured, "signingConfig signingConfigs.f8yRelease");
  assert.equal(applyF8yReleaseSigning(configured), configured);
});

it("fails clearly when the Expo Gradle template changes", () => {
  assert.throws(
    () => applyF8yReleaseSigning("android { buildTypes { release {} } }"),
    /could not find signingConfigs/u,
  );
  assert.throws(
    () => applyF8yReleaseSigning("android {\n    signingConfigs {\n    }\n}"),
    /could not find the release debug signing assignment/u,
  );
});
