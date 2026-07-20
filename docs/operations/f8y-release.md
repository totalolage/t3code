# f8y Continuous Releases

`.github/workflows/f8y-release.yml` publishes a GitHub prerelease for every push to `main` and can
also be started manually. A release is atomic: it is published only after both platform builds
succeed.

Each release contains exactly two assets:

- an unsigned Apple Silicon (`arm64`) macOS DMG
- a signed Android APK named `T3-Code-<version>-android.apk`

Versions use the next patch after the checked-in desktop version followed by the UTC date and GitHub
Actions run number, for example `0.0.29-f8y.20260720.42`. Android uses the workflow run number as its
monotonically increasing `versionCode`.

## Android signing setup

Android requires every installable APK to be signed. Successive APKs must use the same key to update
in place. Generate one long-lived RSA keystore with the fixed alias `t3code-f8y`:

```sh
keytool -genkeypair \
  -keystore t3code-f8y.jks \
  -alias t3code-f8y \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Configure these GitHub Actions repository secrets before the workflow first runs:

- `F8Y_ANDROID_KEYSTORE_BASE64`: the keystore encoded as one base64 string
- `F8Y_ANDROID_STORE_PASSWORD`: the keystore password
- `F8Y_ANDROID_KEY_PASSWORD`: the key password

On macOS, produce the first secret value with:

```sh
base64 -i t3code-f8y.jks | tr -d '\n'
```

Never commit the keystore. Losing it means existing installations cannot be updated by a newly keyed
APK; uninstall the old application before installing the replacement. Do not install an APK for
`com.f8y.t3code` from another signing source because Android will reject an update signed by a
different key.

## Obtainium setup

On the Android device:

1. Install Obtainium.
2. Add `https://github.com/totalolage/t3code` as a GitHub source.
3. Enable prereleases.
4. Disable **Verify Latest Tag** because f8y builds are prereleases and are never marked as the
   repository's latest stable release.
5. Sort releases by date.
6. Set **Filter APKs by Regular Expression** to `^T3-Code-.*-android\.apk$`.
7. Enable update notifications.
8. Allow Obtainium to install unknown applications when Android requests permission.

The repository is public, so a GitHub token is normally unnecessary for this single source. Add a
token in Obtainium only if GitHub API rate limits become a problem. See Obtainium's
[GitHub source documentation](https://wiki.obtainium.imranr.dev/sources/) for the source-specific
settings.

Obtainium detects and downloads new APKs, but a stock Android device still shows the system update
confirmation. After installation, application data is preserved because the package ID remains
`com.f8y.t3code`, the signing key stays constant, and each release has a higher `versionCode`.

## macOS installation and updates

The macOS build uses app ID `com.f8y.t3code`, is unsigned, and intentionally contains no Electron
update-feed configuration. Install new versions manually from GitHub Releases. On first launch,
right-click the application and select **Open**.

Automatic macOS updates would require Apple Developer Program membership, a Developer ID Application
certificate, notarization credentials, consistent signing, and publishing the Electron ZIP and
channel metadata alongside the DMG. Squirrel.Mac cannot update an unsigned application.

## Verification

For the first release:

1. Confirm the GitHub prerelease targets the expected `main` commit and contains one DMG and one APK.
2. Install the APK through Obtainium.
3. Verify the installed package is `com.f8y.t3code` and its version matches the release.
4. Publish a later `main` build and confirm Obtainium detects it.
5. Install the update without uninstalling and confirm settings and application data remain intact.

The workflow verifies the APK signature, package ID, version name, and version code before it uploads
the asset. Starting with the second release, it also compares the certificate and `versionCode` with
the previous f8y APK and rejects a changed key or non-increasing code.
