// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const workflowPath = NodePath.join(repoRoot, ".github/workflows/f8y-release.yml");
const workflow = NodeFS.readFileSync(workflowPath, "utf8");

it("publishes one DMG, its checksum, and one Obtainium-compatible APK for every main push", () => {
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/u);
  assert.include(workflow, "workflow_dispatch:");
  assert.include(workflow, "runs-on: macos-15");
  assert.include(workflow, "runs-on: ubuntu-24.04");
  assert.include(workflow, 'T3CODE_DESKTOP_DISABLE_UPDATE_CONFIG: "true"');
  assert.include(workflow, "T3-Code-${{ needs.metadata_and_checks.outputs.version }}-android.apk");
  assert.include(workflow, "prerelease: true");
  assert.include(workflow, "make_latest: false");
  assert.include(workflow, "release-assets/*.dmg");
  assert.include(workflow, "release-assets/*.dmg.sha256");
  assert.include(workflow, "release-assets/*.apk");
  assert.notInclude(workflow, "blacksmith-");
  assert.notInclude(workflow, "EXPO_TOKEN");
  assert.notInclude(workflow, "CSC_LINK");
  assert.notInclude(workflow.toLowerCase(), "personal");
});

it("ad-hoc-signs and integrity-checks the account-free macOS release", () => {
  assert.include(workflow, 'T3CODE_DESKTOP_AD_HOC_SIGN: "true"');
  assert.include(workflow, 'hdiutil verify "$dmg"');
  assert.include(workflow, 'codesign --verify --deep --strict --verbose=2 "$app"');
  assert.include(workflow, "Signature=adhoc");
  assert.include(workflow, 'shasum -a 256 "$(basename "$dmg")"');
  assert.include(workflow, 'bundle_id" != "com.f8y.t3code"');
  assert.include(workflow, "Privacy & Security → Open Anyway");
  assert.notInclude(workflow, "notarytool");
  assert.notInclude(workflow, "stapler");
  assert.notInclude(workflow, "--signed");
});

it("cancels an in-progress f8y release when a newer one is queued", () => {
  assert.match(workflow, /concurrency:\n\s+group: f8y-release\n\s+cancel-in-progress: true/u);
});

it("uses a stable f8y keystore and validates Android package metadata", () => {
  assert.include(workflow, "F8Y_ANDROID_KEYSTORE_BASE64");
  assert.include(workflow, "F8Y_ANDROID_STORE_PASSWORD");
  assert.include(workflow, "F8Y_ANDROID_KEY_PASSWORD");
  assert.include(workflow, "name='com.f8y.t3code'");
  assert.include(
    workflow,
    "versionCode='${{ needs.metadata_and_checks.outputs.android_version_code }}'",
  );
  assert.include(workflow, 'apksigner" verify --verbose --print-certs');
  assert.include(workflow, "s/^.*certificate SHA-256 digest: //p");
  assert.notInclude(workflow, "s/^Signer #1 certificate SHA-256 digest: //p");
  assert.include(workflow, "Signing certificate differs from the previous f8y APK.");
  assert.include(workflow, "previous_version_code >= current_version_code");
});

it("keeps GitHub write access isolated to the publishing job", () => {
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(
    workflow,
    /publish_release:[\s\S]*?permissions:\n\s+contents: write[\s\S]*?softprops\/action-gh-release@v2/u,
  );
});
