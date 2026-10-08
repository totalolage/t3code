// @effect-diagnostics nodeBuiltinImport:off - reads static repository text in Node.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "vite-plus/test";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
const workflow = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, ".github/workflows/f8y-release.yml"),
  "utf8",
);
const desktopBuilder = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, "scripts/build-desktop-artifact.ts"),
  "utf8",
);
const releaseVerifier = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, "scripts/verify-f8y-release.ts"),
  "utf8",
);
const pkgbuild = NodeFS.readFileSync(
  NodePath.join(repositoryRoot, "packaging/aur/t3code-f8y-bin/PKGBUILD"),
  "utf8",
);

it("retains the shipped main-push trigger and replacement policy", () => {
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/u);
  assert.include(workflow, "workflow_dispatch:");
  assert.match(workflow, /concurrency:\n\s+group: f8y-release\n\s+cancel-in-progress: true/u);
});

it("passes the shipped version and signing inputs to the native Android build", () => {
  assert.include(workflow, "T3CODE_RELEASE_VERSION: ${{ needs.metadata.outputs.version }}");
  assert.include(
    workflow,
    "T3CODE_ANDROID_VERSION_CODE: ${{ needs.metadata.outputs.version_code }}",
  );
  assert.include(
    workflow,
    "F8Y_ANDROID_KEYSTORE_BASE64: ${{ secrets.F8Y_ANDROID_KEYSTORE_BASE64 }}",
  );
  assert.include(
    workflow,
    "T3CODE_ANDROID_STORE_PASSWORD: ${{ secrets.F8Y_ANDROID_STORE_PASSWORD }}",
  );
  assert.include(workflow, "T3CODE_ANDROID_KEY_PASSWORD: ${{ secrets.F8Y_ANDROID_KEY_PASSWORD }}");
  assert.include(workflow, "vp run dist:mobile:apk:f8y");
});

it("compares a previous published APK when one exists without new repository configuration", () => {
  assert.include(workflow, "previous_args=()");
  assert.include(workflow, 'if [[ -n "$previous_apk_url" ]]');
  assert.include(workflow, 'previous_args=(--previous-apk "$previous_apk")');
  assert.include(workflow, '"${previous_args[@]}"');
  assert.notInclude(workflow, "F8Y_ANDROID_CERT_SHA256");
  assert.notInclude(workflow, "F8Y_ANDROID_MIN_VERSION_CODE");
});

it("retains the shipped release title and installation guidance", () => {
  assert.include(
    workflow,
    "T3 Code f8y ${{ needs.metadata.outputs.version }} (${{ needs.metadata.outputs.short_sha }})",
  );
  assert.include(workflow, "Privacy & Security → Open Anyway");
  assert.include(workflow, "Obtainium source: `https://github.com/totalolage/t3code`");
  assert.include(workflow, "prerelease: true");
  assert.include(workflow, "make_latest: false");
});

it("consumes the Linux AppImage name emitted by the desktop builder", () => {
  const template = desktopBuilder.match(/artifactName: "([^"]+)"/u)?.[1];
  if (template === undefined) throw new Error("Desktop artifact name template is missing.");
  assert.equal(template, "T3-Code-${version}-${arch}.${ext}");
  const shellArtifact = template
    .replace("${version}", "$VERSION")
    .replace("${arch}", "x86_64")
    .replace("${ext}", "AppImage");
  const uploadArtifact = template
    .replace("${version}", "${{ needs.metadata.outputs.version }}")
    .replace("${arch}", "x86_64")
    .replace("${ext}", "AppImage");

  assert.include(workflow, `chmod +x "release/${shellArtifact}"`);
  assert.include(workflow, `--artifact "release/${shellArtifact}"`);
  assert.include(workflow, `release/${uploadArtifact}`);
  assert.include(releaseVerifier, "T3-Code-${version}-x86_64.AppImage");
  assert.notInclude(workflow, "-x64.AppImage");
});

it("publishes the native verified artifacts and then the shipped AUR package", () => {
  assert.include(
    workflow,
    'node scripts/verify-f8y-release.ts --version "$VERSION" --directory release-assets',
  );
  assert.include(workflow, "softprops/action-gh-release@v2");
  assert.include(workflow, "files: release-assets/*");
  assert.include(workflow, "needs: [metadata, publish]");
  assert.include(workflow, "uses: ./.github/workflows/publish-aur.yml");
  assert.include(workflow, "release_tag: ${{ needs.metadata.outputs.tag }}");
  assert.include(pkgbuild, "_repo='totalolage/t3code'");
  assert.include(pkgbuild, '"$pkgdir/usr/bin/t3code"');
  assert.notInclude(pkgbuild, '"$pkgdir/usr/bin/t3"');
});
