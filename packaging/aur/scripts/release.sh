#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
repo="${GITHUB_REPOSITORY:-pingdotgg/t3code}"
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
pkgrel="${PKGREL:-1}"
package_kind='desktop'

if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  pkgname='t3code-bin'
  icon_path='assets/prod/black-universal-1024.png'
elif [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  pkgname='t3code-nightly-bin'
  icon_path='assets/nightly/nightly-universal-1024.png'
elif [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-f8y\.[0-9]{8}\.[0-9]+$ ]]; then
  pkgname='t3code-f8y-bin'
  icon_path='assets/prod/black-universal-1024.png'
else
  echo "Release $tag does not publish an AUR package."
  exit 0
fi

version="${tag#v}"
pkgver="${version//-/_}"
if [[ "$package_kind" == 'cli' ]]; then
  asset_name="t3-${version}-linux-x64"
else
  asset_name="T3-Code-${version}-x86_64.AppImage"
fi
release_json="$(gh api "repos/$repo/releases/tags/$tag")"
asset_digest="$(jq -r --arg name "$asset_name" \
  '.assets[] | select(.name == $name) | .digest' <<<"$release_json")"
artifact_sha256="${asset_digest#sha256:}"

if [[ ! "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Release $tag is missing $asset_name or its SHA-256 digest." >&2
  exit 1
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$repo/contents/LICENSE?ref=$tag" > "$work_dir/LICENSE"
license_sha256="$(sha256sum "$work_dir/LICENSE" | awk '{print $1}')"

if [[ "$package_kind" == 'desktop' ]]; then
  gh api -H 'Accept: application/vnd.github.raw' \
    "repos/$repo/contents/$icon_path?ref=$tag" > "$work_dir/icon.png"
  icon_sha256="$(sha256sum "$work_dir/icon.png" | awk '{print $1}')"
fi

package_dir="$repo_root/packaging/aur/$pkgname"
cd "$package_dir"
sed_args=(
  -e "s/^pkgver=.*/pkgver=$pkgver/" \
  -e "s/^pkgrel=.*/pkgrel=$pkgrel/" \
  -e "/# upstream license$/s/'[0-9a-f]{64}'/'$license_sha256'/"
)
if [[ "$package_kind" == 'cli' ]]; then
  sed_args+=(-e "/# binary$/s/'[0-9a-f]{64}'/'$artifact_sha256'/")
else
  sed_args+=(
    -e "/# AppImage$/s/'[0-9a-f]{64}'/'$artifact_sha256'/"
    -e "/# icon$/s/'[0-9a-f]{64}'/'$icon_sha256'/"
  )
fi
sed -Ei "${sed_args[@]}" PKGBUILD

run_as_builder() {
  if [[ "$(id -u)" == 0 ]]; then
    runuser -u builder -- "$@"
  else
    "$@"
  fi
}

if [[ "$(id -u)" == 0 ]]; then
  chown -R builder:builder "$package_dir"
fi
run_as_builder namcap PKGBUILD
run_as_builder makepkg --printsrcinfo > .SRCINFO
run_as_builder makepkg --force --syncdeps --cleanbuild --clean --noconfirm
run_as_builder namcap "$(run_as_builder makepkg --packagelist)"

if [[ -z "${AUR_SSH_PRIVATE_KEY:-}" ]]; then
  echo 'AUR_SSH_PRIVATE_KEY is not set; build complete, skipping publish.'
  exit 0
fi

key_file="$work_dir/id_ed25519"
known_hosts_file="$work_dir/known_hosts"
aur_dir="$work_dir/$pkgname"
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > "$key_file"
chmod 600 "$key_file"
printf '%s\n' \
  'aur.archlinux.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEuBKrPzbawxA/k2g6NcyV5jmqwJ2s+zpgZGZ7tpLIcN' \
  > "$known_hosts_file"
export GIT_SSH_COMMAND="ssh -i $key_file -o IdentitiesOnly=yes -o UserKnownHostsFile=$known_hosts_file -o StrictHostKeyChecking=yes"

git clone "ssh://aur@aur.archlinux.org/$pkgname.git" "$aur_dir"
cp PKGBUILD .SRCINFO "$aur_dir/"
cd "$aur_dir"
git rm --ignore-unmatch LICENSE .upstream-commit t3code-icon.png
git config user.name 't3code-ci'
git config user.email 't3code-ci@users.noreply.github.com'
git add -A

if git diff --cached --quiet; then
  echo 'AUR package is already up to date.'
  exit 0
fi

git commit -m "$pkgname: update to $pkgver-$pkgrel"
git push origin HEAD:master
