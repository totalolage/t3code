#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
repo='pingdotgg/t3code'
tag="${RELEASE_TAG:?RELEASE_TAG is required}"
pkgrel="${PKGREL:-1}"
is_f8y=false
asset_arch='x86_64'

if [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  pkgname='t3code-bin'
elif [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-nightly\.[0-9]{8}\.[0-9]+$ ]]; then
  pkgname='t3code-nightly-bin'
elif [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-f8y\.[0-9]{8}\.[0-9]+$ ]]; then
  pkgname='t3code-f8y-bin'
  is_f8y=true
  asset_arch='x86_64'
  repo="${SOURCE_REPO:-${GITHUB_REPOSITORY:-}}"
  owner="${repo%%/*}"
  repository="${repo#*/}"
  repo_is_safe=false
  if [[ -n "$repo" ]] && (
    export LC_ALL=C
    [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]
  ); then
    repo_is_safe=true
  fi

  if [[ "$repo_is_safe" != true ||
        "$owner" == '.' || "$owner" == '..' ||
        "$repository" == '.' || "$repository" == '..' ||
        "${repo,,}" == 'pingdotgg/t3code' ]]; then
    echo "Invalid SOURCE_REPO/GITHUB_REPOSITORY for f8y release: ${repo:-<unset>}." >&2
    exit 1
  fi
else
  if [[ "$tag" == *f8y* ]]; then
    echo "Malformed f8y release tag: $tag" >&2
    exit 1
  fi
  echo "Release $tag does not publish an AUR package."
  exit 0
fi

if [[ ! "$pkgrel" =~ ^[1-9][0-9]*$ ]]; then
  echo "PKGREL must be a positive integer." >&2
  exit 1
fi

version="${tag#v}"
pkgver="${version//-/_}"
asset_name="T3-Code-${version}-${asset_arch}.AppImage"
release_json="$(gh api "repos/$repo/releases/tags/$tag")"
expected_url="https://github.com/$repo/releases/download/$tag/$asset_name"
appimage_sha256="$(
  jq -er \
    --arg tag "$tag" \
    --arg asset_name "$asset_name" \
    --arg expected_url "$expected_url" \
    '
      if .tag_name != $tag then
        error("release tag does not match requested tag")
      elif .draft != false then
        error("release is a draft")
      else
        [.assets[]? | select(.name == $asset_name)] as $matches
        | if ($matches | length) != 1 then
            error("release must contain exactly one expected AppImage asset")
          elif ($matches[0].digest | type) != "string" then
            error("AppImage digest is missing")
          elif ($matches[0].digest | test("^sha256:[0-9a-f]{64}$") | not) then
            error("AppImage digest is invalid")
          elif $matches[0].browser_download_url != $expected_url then
            error("AppImage download URL does not match requested repository and tag")
          else
            $matches[0].digest | sub("^sha256:"; "")
          end
      end
    ' <<<"$release_json"
)"

work_dir="$(mktemp -d)"
trap 'rm -rf -- "$work_dir"' EXIT
gh api -H 'Accept: application/vnd.github.raw' \
  "repos/$repo/contents/LICENSE?ref=$tag" > "$work_dir/LICENSE"
license_sha256="$(sha256sum "$work_dir/LICENSE" | awk '{print $1}')"

package_dir="$repo_root/packaging/aur/$pkgname"
cd "$package_dir"
if [[ "$is_f8y" == true ]]; then
  sed -Ei \
    -e "s|^_repo=.*|_repo='$repo'|" \
    -e "s/^pkgver=.*/pkgver=$pkgver/" \
    -e "s/^pkgrel=.*/pkgrel=$pkgrel/" \
    -e "/# AppImage$/s/'[0-9a-f]{64}'/'$appimage_sha256'/" \
    -e "/# upstream license$/s/'[0-9a-f]{64}'/'$license_sha256'/" \
    PKGBUILD
else
  sed -Ei \
    -e "s/^pkgver=.*/pkgver=$pkgver/" \
    -e "s/^pkgrel=.*/pkgrel=$pkgrel/" \
    -e "/# AppImage$/s/'[0-9a-f]{64}'/'$appimage_sha256'/" \
    -e "/# upstream license$/s/'[0-9a-f]{64}'/'$license_sha256'/" \
    PKGBUILD
fi

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
run_as_builder makepkg --syncdeps --cleanbuild --clean --noconfirm
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
