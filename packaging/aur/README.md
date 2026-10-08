# AUR packaging

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) packages. Both
repackage the official x86_64 AppImage from GitHub Releases.

## Publishing

The release workflow calls `.github/workflows/publish-aur.yml` after publishing a GitHub release;
the workflow can also be run manually for a specific tag. It selects the stable or nightly
package, then updates its version and checksums, builds it, regenerates `.SRCINFO`, and pushes it
to the AUR.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```

## Fork desktop package

`t3code-f8y-bin` packages the extracted desktop AppImage from a fork's GitHub Release.
Install or update it with an AUR helper:

```bash
yay -S t3code-f8y-bin
yay -Syu
```

The package has no in-app self-update. The bundled app identity and data paths stay
unchanged, and it does not use profile flags.

The f8y package template is initially unreleased. Run
`packaging/aur/scripts/release.sh` first to populate a valid version, checksums, and
`.SRCINFO` before publication.

For f8y publication, `RELEASE_TAG` must be
`v<core>-f8y.<YYYYMMDD>.<run>`. Set `SOURCE_REPO` to the explicit `owner/repo`, or
let it fall back to `GITHUB_REPOSITORY` from the invoking fork; f8y rejects
`pingdotgg/t3code`. Invoke the AUR workflow only after release assets are uploaded.

The matching Linux x64 asset follows the current builder artifact name
`T3-Code-${version}-${arch}.${ext}`:
`T3-Code-<core>-f8y.<date>.<run>-x86_64.AppImage`. The release must expose exactly
one matching asset with a GitHub SHA-256 digest and the exact download URL
`https://github.com/<SOURCE_REPO>/releases/download/<RELEASE_TAG>/T3-Code-<core>-f8y.<date>.<run>-x86_64.AppImage`, report the same `tag_name`, set
`tag_name` equal to `RELEASE_TAG`, set `draft` to `false`, and include `LICENSE` at
that tag.

The release workflow separately owns the version and bundled `dev.f8y.t3code`
identity, and uploads the AppImage, checksum, and `f8y-linux.yml`. AUR packaging
uses the GitHub asset digest and tagged `LICENSE`; it does not consume the update
feed or sidecar checksum.
