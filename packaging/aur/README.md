# AUR packaging

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin),
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin), and
[`t3code-f8y-bin`](https://aur.archlinux.org/packages/t3code-f8y-bin) packages. The stable and
nightly packages repackage the official x86_64 AppImage. The f8y package installs the
self-contained Linux x86_64 CLI binary from `totalolage/t3code` releases.

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
