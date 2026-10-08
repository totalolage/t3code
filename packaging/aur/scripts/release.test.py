#!/usr/bin/env python3
"""Behavioral tests for packaging/aur/scripts/release.sh and the f8y PKGBUILD.

Executes the ACTUAL shell helper and the ACTUAL PKGBUILD functions inside
isolated fixture trees that mirror the repository layout. All network,
build, publication, and credential-affecting commands are intercepted by
PATH shims (gh, namcap, makepkg, git, ssh, runuser, id, chown) that record
every invocation and fail on unexpected actions. Real offline tools
(bash, jq, sha256sum, sed, install, chmod) are used as-is.

No network access, no real credentials, no publication, no installs.
Credentials are never inherited: GH_TOKEN is always scrubbed; the publish
path is exercised only with a dummy AUR_SSH_PRIVATE_KEY plus stub git/ssh.

Large fixtures live on the worktree disk (.t3/test-tmp, gitignored);
compact evidence goes to /tmp/opencode/rewrite-aur-distribution/.

Run from the worktree root:
  flock /tmp/opencode/fork-rewrite-heavy-b.lock python3 \
    packaging/aur/scripts/release.test.py
"""

import json
import os
import hashlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
AUR_DIR = REPO_ROOT / "packaging" / "aur"
HELPER = AUR_DIR / "scripts" / "release.sh"
STABLE_PKGBUILD = AUR_DIR / "t3code-bin" / "PKGBUILD"
NIGHTLY_PKGBUILD = AUR_DIR / "t3code-nightly-bin" / "PKGBUILD"
F8Y_PKGBUILD = AUR_DIR / "t3code-f8y-bin" / "PKGBUILD"

# Large fixture area on the disk-backed worktree filesystem (gitignored).
FIXTURE_ROOT = REPO_ROOT / ".t3" / "test-tmp" / "aur-release-tests"
# Compact evidence for the parent.
EVIDENCE_DIR = Path("/tmp/opencode/rewrite-aur-distribution")

STABLE_TAG = "v1.2.3"
NIGHTLY_TAG = "v1.2.3-nightly.20260912.7"
F8Y_TAG = "v1.2.3-f8y.20260912.7"
F8Y_VERSION = "1.2.3-f8y.20260912.7"
F8Y_PKGVER = "1.2.3_f8y.20260912.7"
F8Y_REPO = "acme/t3code-fork"

APPIMAGE_DIGEST = "a" * 64
LICENSE_BYTES = b"MIT License\nfixture-for-aur-release-tests\n"
LICENSE_SHA = hashlib.sha256(LICENSE_BYTES).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def production_hashes() -> dict:
    return {
        str(p.relative_to(REPO_ROOT)): sha256_file(p)
        for p in (HELPER, STABLE_PKGBUILD, NIGHTLY_PKGBUILD, F8Y_PKGBUILD)
    }


def release_json(tag: str, repo: str, assets: list, draft: bool = False,
                 tag_name: str | None = None) -> str:
    version = tag[1:]
    asset_arch = "x86_64"
    asset_name = f"T3-Code-{version}-{asset_arch}.AppImage"
    return json.dumps({
        "tag_name": tag_name if tag_name is not None else tag,
        "draft": draft,
        "assets": [
            {
                "name": name,
                "digest": digest,
                "browser_download_url": (
                    url if url is not None else
                    f"https://github.com/{repo}/releases/download/{tag}/{name}"
                ),
            }
            for (name, digest, url) in assets
        ],
    })


def good_assets(tag: str, repo: str) -> list:
    version = tag[1:]
    asset_arch = "x86_64"
    asset_name = f"T3-Code-{version}-{asset_arch}.AppImage"
    return [
        ("SHA256SUMS", "sha256:" + "b" * 64, None),
        (asset_name, "sha256:" + APPIMAGE_DIGEST, None),
        ("f8y-linux.yml", None, None),
    ]


class HelperFixture:
    """An isolated repo-layout tree plus stub command PATH for release.sh."""

    def __init__(self, unittest_case: "ReleaseHelperTest"):
        self.case = unittest_case
        FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(
            prefix=f"helper-{unittest_case.id()}-", dir=FIXTURE_ROOT))
        self.tmp = self.root / "tmp"
        self.tmp.mkdir()
        # Mirror the repository layout: repo_root/packaging/aur/...
        self.repo = self.root / "repo"
        scripts = self.repo / "packaging" / "aur" / "scripts"
        scripts.mkdir(parents=True)
        shutil.copy2(HELPER, scripts / "release.sh")
        for pkg in ("t3code-bin", "t3code-nightly-bin", "t3code-f8y-bin"):
            pkg_dir = self.repo / "packaging" / "aur" / pkg
            pkg_dir.mkdir()
            shutil.copy2(AUR_DIR / pkg / "PKGBUILD", pkg_dir / "PKGBUILD")
        self.release_sh = scripts / "release.sh"

        self.shims = self.root / "shims"
        self.shims.mkdir()
        self.stub_log = self.root / "stub-log.txt"
        self.stub_log.touch()
        self.publish_log = self.root / "publish-log.txt"
        self.publish_log.touch()
        self.license_file = self.root / "LICENSE"
        self.license_file.write_bytes(LICENSE_BYTES)
        self.release_json_file = self.root / "release.json"

        self._write_shims()

    # ---- stub commands -------------------------------------------------

    def _shim(self, name: str, body: str) -> None:
        path = self.shims / name
        path.write_text("#!/usr/bin/env bash\n" + body + "\n")
        path.chmod(0o755)

    def _write_shims(self) -> None:
        log = str(self.stub_log)
        pub = str(self.publish_log)
        self._shim("id", r'''
if [[ "${1:-}" == "-u" ]]; then
  echo 1000
else
  echo "uid=1000(fixture) gid=1000(fixture)"
fi
''')
        self._shim("gh", f'''
printf 'gh' >> {log!r}
for a in "$@"; do printf ' %q' "$a" >> {log!r}; done
printf '\\n' >> {log!r}
route=""
for a in "$@"; do
  case "$a" in repos/*) route="$a";; esac
done
case "$route" in
  */contents/LICENSE*)
    if [[ -n "${{GH_LICENSE_FILE:-}}" ]]; then
      cat "${{GH_LICENSE_FILE}}"
    else
      echo "gh: no LICENSE fixture" >&2; exit 1
    fi
    ;;
  */releases/tags/*)
    if [[ -n "${{GH_RELEASE_JSON:-}}" ]]; then
      cat "${{GH_RELEASE_JSON}}"
    else
      echo "gh: no release fixture" >&2; exit 1
    fi
    ;;
  *)
    echo "gh stub: unexpected route: $route" >&2
    exit 1
    ;;
esac
''')
        # jq stays real: it is not shadowed in the shims directory.
        self._shim("namcap", f'''
printf 'namcap %q\\n' "$*" >> {log!r}
exit 0
''')
        self._shim("makepkg", f'''
printf 'makepkg %q\\n' "$*" >> {log!r}
pkgname="$(sed -n "s/^pkgname=//p" PKGBUILD)"
pkgver="$(sed -n "s/^pkgver=//p" PKGBUILD)"
pkgrel="$(sed -n "s/^pkgrel=//p" PKGBUILD)"
case " $* " in
  *" --printsrcinfo "*)
    cat <<EOF
pkgname = $pkgname
pkgver = $pkgver
pkgrel = $pkgrel
arch = x86_64
EOF
    ;;
  *" --packagelist "*)
    echo "$pkgname-$pkgver-$pkgrel-x86_64.pkg.tar.zst"
    ;;
  *" --syncdeps "*)
    : > "$(pwd)/.stub-build-evidence"
    ;;
  *)
    echo "makepkg stub: unexpected arguments: $*" >&2
    exit 1
    ;;
esac
''')
        self._shim("git", f'''
printf 'git %q\\n' "$*" >> {log!r}
cmd="$1"; shift || true
case "$cmd" in
  clone)
    mkdir -p "$2"
    printf '%s\\n' "$1" > "$2/.stub-remote"
    ;;
  rm|config|add)
    ;;
  diff)
    # Force the "there are changes" path so commit+push are exercised.
    exit 1
    ;;
  commit)
    printf 'commit %q\\n' "$*" >> {pub!r}
    ;;
  push)
    printf 'push %q\\n' "$*" >> {pub!r}
    ;;
  *)
    echo "git stub: unexpected subcommand: $cmd" >&2
    exit 1
    ;;
esac
''')
        self._shim("ssh", f'''
printf 'ssh %q\\n' "$*" >> {log!r}
echo "ssh stub: real ssh must never be invoked" >&2
exit 1
''')
        self._shim("runuser", f'''
printf 'runuser %q\\n' "$*" >> {log!r}
exec "$@"
''')
        self._shim("chown", f'''
printf 'chown %q\\n' "$*" >> {log!r}
exit 0
''')

    # ---- environment ---------------------------------------------------

    def env(self, *, source_repo=None, github_repo=None,
            pkgrel=None, aur_key=None) -> dict:
        env = {
            k: v for k, v in os.environ.items()
            if k not in ("GH_TOKEN", "GITHUB_TOKEN", "AUR_SSH_PRIVATE_KEY",
                         "SOURCE_REPO", "GITHUB_REPOSITORY")
        }
        env["PATH"] = f"{self.shims}:{env.get('PATH', '')}"
        env["TMPDIR"] = str(self.tmp)
        env["STUB_LOG"] = str(self.stub_log)
        env["STUB_PUBLISH_LOG"] = str(self.publish_log)
        env["GH_RELEASE_JSON"] = str(self.release_json_file)
        env["GH_LICENSE_FILE"] = str(self.license_file)
        if source_repo is not None:
            env["SOURCE_REPO"] = source_repo
        if github_repo is not None:
            env["GITHUB_REPOSITORY"] = github_repo
        if pkgrel is not None:
            env["PKGREL"] = pkgrel
        if aur_key is not None:
            env["AUR_SSH_PRIVATE_KEY"] = aur_key
        return env

    def set_release(self, text: str) -> None:
        self.release_json_file.write_text(text)

    def run_helper(self, tag: str | None, **env_kw) -> subprocess.CompletedProcess:
        env = self.env(**env_kw)
        argv = ["bash", str(self.release_sh)]
        if tag is None:
            argv = ["env", "-u", "RELEASE_TAG"] + argv
        else:
            env["RELEASE_TAG"] = tag
        return subprocess.run(
            argv, env=env, cwd=str(self.repo),
            capture_output=True, text=True, timeout=120)

    # ---- observation ---------------------------------------------------

    def stub_lines(self, tool: str | None = None) -> list:
        lines = self.stub_log.read_text().splitlines()
        if tool is None:
            return lines
        return [ln for ln in lines if ln.startswith(tool + " ")]

    def publish_log_lines(self) -> list:
        return self.publish_log.read_text().splitlines()

    def pkgbuild(self, pkg: str) -> str:
        return (self.repo / "packaging" / "aur" / pkg / "PKGBUILD").read_text()

    def pkgbuild_bytes(self, pkg: str) -> bytes:
        return (self.repo / "packaging" / "aur" / pkg / "PKGBUILD").read_bytes()

    def cleanup(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)


class ReleaseHelperTest(unittest.TestCase):
    """Tests executing the actual packaging/aur/scripts/release.sh."""

    def setUp(self):
        self.fx = HelperFixture(self)
        self.addCleanup(self.fx.cleanup)

    # ---- routing: stable / nightly / f8y -------------------------------

    def test_stable_tag_routes_to_t3code_bin_upstream_repo_ignoring_github_repository(self):
        self.fx.set_release(release_json(STABLE_TAG, "pingdotgg/t3code",
                                         good_assets(STABLE_TAG, "pingdotgg/t3code")))
        # A fork GITHUB_REPOSITORY must be ignored for stable releases.
        proc = self.fx.run_helper(STABLE_TAG, github_repo="acme/some-fork")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        gh_routes = self.fx.stub_lines("gh")
        self.assertTrue(any("repos/pingdotgg/t3code/releases/tags/v1.2.3" in ln
                            for ln in gh_routes), gh_routes)
        self.assertFalse(any("acme/some-fork" in ln for ln in gh_routes),
                         "stable must never query the fork repo")
        self.assertTrue(any("repos/pingdotgg/t3code/contents/LICENSE" in ln
                            for ln in gh_routes))
        pb = self.fx.pkgbuild("t3code-bin")
        self.assertIn("pkgver=1.2.3", pb)
        self.assertIn(APPIMAGE_DIGEST, pb)
        self.assertIn(LICENSE_SHA, pb)
        self.assertIn(f'"$_appimage::https://github.com/pingdotgg/t3code/'
                      f'releases/download/v${{pkgver}}/$_appimage"', pb)

    def test_nightly_tag_routes_to_t3code_nightly_bin(self):
        self.fx.set_release(release_json(NIGHTLY_TAG, "pingdotgg/t3code",
                                         good_assets(NIGHTLY_TAG, "pingdotgg/t3code")))
        proc = self.fx.run_helper(NIGHTLY_TAG, github_repo="acme/some-fork")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        gh_routes = self.fx.stub_lines("gh")
        self.assertTrue(any(
            "repos/pingdotgg/t3code/releases/tags/" + NIGHTLY_TAG in ln
            for ln in gh_routes), gh_routes)
        pb = self.fx.pkgbuild("t3code-nightly-bin")
        self.assertIn("pkgver=1.2.3_nightly.20260912.7", pb)
        self.assertIn(APPIMAGE_DIGEST, pb)
        self.assertIn(LICENSE_SHA, pb)
        # The other packages stay untouched by this run.
        self.assertNotIn("1.2.3", self.fx.pkgbuild("t3code-bin"))
        self.assertNotIn("1.2.3", self.fx.pkgbuild("t3code-f8y-bin"))

    def test_f8y_tag_pkgver_underscore_and_repo_selection(self):
        self.fx.set_release(release_json(F8Y_TAG, F8Y_REPO,
                                         good_assets(F8Y_TAG, F8Y_REPO)))
        proc = self.fx.run_helper(F8Y_TAG, source_repo=F8Y_REPO,
                                  github_repo="ignored/other", pkgrel="2")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        pb = self.fx.pkgbuild("t3code-f8y-bin")
        self.assertIn("pkgver=1.2.3_f8y.20260912.7", pb)
        self.assertIn("pkgrel=2", pb)
        self.assertIn(f"_repo='{F8Y_REPO}'", pb)
        self.assertIn('"$_appimage::https://github.com/$_repo/releases/'
                      'download/v${_upstream_version}/$_appimage"', pb)
        self.assertIn(APPIMAGE_DIGEST, pb)
        self.assertIn(LICENSE_SHA, pb)
        # gh routing proof: every query went to the fork repo, never upstream.
        gh_routes = self.fx.stub_lines("gh")
        self.assertTrue(any(
            f"repos/{F8Y_REPO}/releases/tags/{F8Y_TAG}" in ln
            for ln in gh_routes), gh_routes)
        self.assertTrue(any(
            f"repos/{F8Y_REPO}/contents/LICENSE" in ln for ln in gh_routes),
            gh_routes)
        for ln in gh_routes:
            self.assertNotIn("pingdotgg/t3code/", ln, ln)

    def test_f8y_repo_falls_back_to_github_repository(self):
        self.fx.set_release(release_json(F8Y_TAG, "forky/t3",
                                         good_assets(F8Y_TAG, "forky/t3")))
        proc = self.fx.run_helper(F8Y_TAG, github_repo="forky/t3")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        pb = self.fx.pkgbuild("t3code-f8y-bin")
        self.assertIn("_repo='forky/t3'", pb)
        self.assertTrue(any("repos/forky/t3/releases/tags/" in ln
                            for ln in self.fx.stub_lines("gh")))

    # ---- invalid inputs rejected before any side effect -----------------

    def _assert_rejected(self, proc, *, gh_expected: bool):
        self.assertNotEqual(proc.returncode, 0,
                            f"expected failure, stdout={proc.stdout}")
        gh_calls = self.fx.stub_lines("gh")
        if not gh_expected:
            self.assertEqual(gh_calls, [], "commands ran before validation")
        # No package mutation, no build artifacts.
        self.assertEqual(self.fx.pkgbuild_bytes("t3code-f8y-bin"),
                         Path(F8Y_PKGBUILD).read_bytes())
        self.assertEqual(self.fx.pkgbuild_bytes("t3code-bin"),
                         Path(STABLE_PKGBUILD).read_bytes())
        self.assertEqual(self.fx.stub_lines("makepkg"), [])
        self.assertEqual(self.fx.stub_lines("namcap"), [])
        self.assertEqual(self.fx.stub_lines("git"), [])
        self.assertEqual(self.fx.publish_log_lines(), [])
        for pkg in ("t3code-bin", "t3code-nightly-bin", "t3code-f8y-bin"):
            self.assertFalse(
                (self.fx.repo / "packaging" / "aur" / pkg / ".SRCINFO").exists())

    def publish_log_lines(self) -> list:  # test-side convenience
        return self.fx.publish_log_lines()

    def test_f8y_rejects_missing_repo_without_commands(self):
        self._assert_rejected(self.fx.run_helper(F8Y_TAG), gh_expected=False)

    def test_f8y_rejects_upstream_repo_case_insensitively(self):
        for repo in ("pingdotgg/t3code", "PINGDOTGG/T3CODE", "PingdotGG/T3Code"):
            with self.subTest(repo=repo):
                self._assert_rejected(
                    self.fx.run_helper(F8Y_TAG, source_repo=repo),
                    gh_expected=False)

    def test_f8y_rejects_unsafe_repo_shapes(self):
        for repo in ("acme corp/t3", "acme", "acme/", "/t3", "acme/../evil",
                     "../etc", "x/..", ".", "acme//t3", "acme/t3 extra"):
            with self.subTest(repo=repo):
                self._assert_rejected(
                    self.fx.run_helper(F8Y_TAG, source_repo=repo),
                    gh_expected=False)

    def test_malformed_f8y_tags_fail_without_commands(self):
        for tag in ("v1.2.3-f8y.20260912", "v1.2.3-f8y", "v1.2.3-f8y.20260912.a",
                    "v1.2.3-f8y.202609127.7", "some-v1.2.3-f8y.20260912.7"):
            with self.subTest(tag=tag):
                self._assert_rejected(self.fx.run_helper(tag), gh_expected=False)

    def test_pkgrel_must_be_positive_integer_before_any_command(self):
        self.fx.set_release(release_json(F8Y_TAG, F8Y_REPO,
                                         good_assets(F8Y_TAG, F8Y_REPO)))
        # Note: an EMPTY PKGREL resolves to the default 1 via ${PKGREL:-1};
        # that is bash default semantics, not a validation failure.
        for bad in ("0", "-1", "abc", "1.5", "01"):
            with self.subTest(pkgrel=bad):
                self._assert_rejected(
                    self.fx.run_helper(F8Y_TAG, source_repo=F8Y_REPO,
                                       pkgrel=bad),
                    gh_expected=False)

    def test_missing_release_tag_fails(self):
        self._assert_rejected(self.fx.run_helper(None), gh_expected=False)

    # ---- release metadata validation ------------------------------------

    def _assert_metadata_rejected(self, text):
        self.fx.set_release(text)
        self._assert_rejected(
            self.fx.run_helper(F8Y_TAG, source_repo=F8Y_REPO),
            gh_expected=True)

    def test_rejects_wrong_tag_name(self):
        self._assert_metadata_rejected(release_json(
            F8Y_TAG, F8Y_REPO, good_assets(F8Y_TAG, F8Y_REPO),
            tag_name="v9.9.9"))

    def test_rejects_draft_release(self):
        self._assert_metadata_rejected(release_json(
            F8Y_TAG, F8Y_REPO, good_assets(F8Y_TAG, F8Y_REPO), draft=True))

    def test_rejects_missing_expected_asset(self):
        self._assert_metadata_rejected(release_json(F8Y_TAG, F8Y_REPO, [
            ("SHA256SUMS", "sha256:" + "b" * 64, None),
            ("f8y-linux.yml", None, None),
        ]))

    def test_rejects_legacy_x64_appimage_name(self):
        self._assert_metadata_rejected(release_json(F8Y_TAG, F8Y_REPO, [
            ("T3-Code-1.2.3-f8y.20260912.7-x64.AppImage",
             "sha256:" + APPIMAGE_DIGEST, None),
            ("f8y-linux.yml", None, None),
        ]))

    def test_rejects_duplicate_expected_assets(self):
        name = "T3-Code-1.2.3-f8y.20260912.7-x86_64.AppImage"
        self._assert_metadata_rejected(release_json(F8Y_TAG, F8Y_REPO, [
            (name, "sha256:" + APPIMAGE_DIGEST, None),
            (name, "sha256:" + "c" * 64, None),
        ]))

    def test_rejects_arm64_only_assets(self):
        self._assert_metadata_rejected(release_json(F8Y_TAG, F8Y_REPO, [
            ("SHA256SUMS", "sha256:" + "b" * 64, None),
            ("T3-Code-1.2.3-f8y.20260912.7-arm64.AppImage",
             "sha256:" + APPIMAGE_DIGEST, None),
            ("f8y-linux.yml", None, None),
        ]))

    def test_rejects_cli_only_assets(self):
        self._assert_metadata_rejected(release_json(F8Y_TAG, F8Y_REPO, [
            ("t3code-cli-1.2.3-x86_64.tar.gz", "sha256:" + "b" * 64, None),
        ]))

    def test_rejects_invalid_digests(self):
        for digest in ("sha512:" + "a" * 128, "sha256:" + "A" * 64,
                       "sha256:" + "a" * 63, "a" * 64, None):
            with self.subTest(digest=digest):
                name = "T3-Code-1.2.3-f8y.20260912.7-x86_64.AppImage"
                self._assert_metadata_rejected(release_json(F8Y_TAG, F8Y_REPO, [
                    (name, digest, None),
                ]))

    def test_rejects_wrong_download_url(self):
        name = "T3-Code-1.2.3-f8y.20260912.7-x86_64.AppImage"
        self._assert_metadata_rejected(release_json(F8Y_TAG, F8Y_REPO, [
            (name, "sha256:" + APPIMAGE_DIGEST,
             f"https://github.com/evil/mirror/releases/download/{F8Y_TAG}/{name}"),
        ]))

    def test_correct_asset_among_unrelated_assets_is_accepted(self):
        assets = good_assets(F8Y_TAG, F8Y_REPO) + [
            ("totally-unrelated.zip", "sha256:" + "d" * 64, None),
            ("T3-Code-1.2.3-f8y.20260912.7-x64.AppImage",
             "sha256:" + "e" * 64, None),
        ]
        self.fx.set_release(release_json(F8Y_TAG, F8Y_REPO, assets))
        proc = self.fx.run_helper(F8Y_TAG, source_repo=F8Y_REPO)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn(APPIMAGE_DIGEST, self.fx.pkgbuild("t3code-f8y-bin"))

    # ---- build + publish pipeline (stubs only) ---------------------------

    def test_successful_f8y_run_builds_via_stubs_and_persists_repo(self):
        self.fx.set_release(release_json(F8Y_TAG, F8Y_REPO,
                                         good_assets(F8Y_TAG, F8Y_REPO)))
        proc = self.fx.run_helper(F8Y_TAG, source_repo=F8Y_REPO)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        pkg_dir = self.fx.repo / "packaging" / "aur" / "t3code-f8y-bin"
        # Build evidence from the makepkg stub.
        self.assertTrue((pkg_dir / ".stub-build-evidence").exists())
        self.assertTrue((pkg_dir / ".SRCINFO").exists())
        self.assertIn("pkgname = t3code-f8y-bin",
                      (pkg_dir / ".SRCINFO").read_text())
        self.assertIn("pkgver = 1.2.3_f8y.20260912.7",
                      (pkg_dir / ".SRCINFO").read_text())
        makepkg_calls = self.fx.stub_lines("makepkg")
        self.assertEqual(len(makepkg_calls), 3, makepkg_calls)
        self.assertIn("--printsrcinfo", makepkg_calls[0])
        self.assertIn("--syncdeps", makepkg_calls[1])
        self.assertIn("--packagelist", makepkg_calls[2])
        self.assertEqual(len(self.fx.stub_lines("namcap")), 2)
        # Non-root: helper must run tools directly, without runuser/chown.
        self.assertEqual(self.fx.stub_lines("runuser"), [])
        self.assertEqual(self.fx.stub_lines("chown"), [])
        self.assertEqual(self.fx.stub_lines("ssh"), [])
        # Without AUR_SSH_PRIVATE_KEY the publish path must not run.
        self.assertEqual(self.fx.publish_log_lines(), [])
        self.assertEqual(self.fx.stub_lines("git"), [])
        self.assertIn("skipping publish", proc.stdout)

    def test_publish_path_uses_stub_git_and_dummy_key_only(self):
        self.fx.set_release(release_json(F8Y_TAG, F8Y_REPO,
                                         good_assets(F8Y_TAG, F8Y_REPO)))
        proc = self.fx.run_helper(F8Y_TAG, source_repo=F8Y_REPO,
                                  aur_key="dummy-test-key-not-real")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        pub = self.publish_log_lines()
        self.assertTrue(any(ln.startswith("commit") for ln in pub), pub)
        pushes = [ln.replace("\\ ", " ")
                  for ln in pub if ln.startswith("push")]
        self.assertEqual(len(pushes), 1, pub)
        self.assertIn("push origin HEAD:master", pushes[0])
        git_lines = self.fx.stub_lines("git")
        clones = [ln for ln in git_lines if " clone " in ln or " clone" in ln]
        self.assertTrue(any("ssh://aur@aur.archlinux.org/t3code-f8y-bin.git" in ln
                            for ln in clones), git_lines)
        # The real ssh stub must never be invoked by the helper itself.
        self.assertEqual(self.fx.stub_lines("ssh"), [])

    def test_non_f8y_unknown_tag_skips_unchanged(self):
        proc = self.fx.run_helper("v1.2.3-beta.1")
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        self.assertIn("does not publish", proc.stdout)
        self.assertEqual(self.fx.stub_lines(), [], "no command may run")
        self.assertEqual(self.fx.pkgbuild_bytes("t3code-bin"),
                         Path(STABLE_PKGBUILD).read_bytes())
        self.assertEqual(self.fx.pkgbuild_bytes("t3code-f8y-bin"),
                         Path(F8Y_PKGBUILD).read_bytes())


class F8yPackageTest(unittest.TestCase):
    """Tests executing the actual t3code-f8y-bin PKGBUILD functions."""

    FAKEVER = "1.2.3_f8y.20260912.7"

    def setUp(self):
        FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(
            prefix=f"pkg-{self.id()}-", dir=FIXTURE_ROOT))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.pkgbuild = self.root / "PKGBUILD"
        shutil.copy2(F8Y_PKGBUILD, self.pkgbuild)
        # The template hardcodes a placeholder pkgver; pin the fixture version
        # so prepare()/package() resolve $_appimage to our fake payload.
        text = self.pkgbuild.read_text()
        self.pkgbuild.write_text(re.sub(
            r"^pkgver=.*$", f"pkgver={self.FAKEVER}", text, count=1,
            flags=re.MULTILINE))
        self.srcdir = self.root / "src"
        self.srcdir.mkdir()
        self.pkgdir = self.root / "pkg"
        self.pkgdir.mkdir()
        self.appimage = self.srcdir / (
            f"T3-Code-{self.FAKEVER.replace('_f8y.', '-f8y.')}-x86_64.AppImage")
        self.appimage.write_text(
            "#!/usr/bin/env bash\n"
            "case \"${1:-}\" in\n"
            "  --appimage-extract)\n"
            "    rm -rf squashfs-root\n"
            "    mkdir -p squashfs-root/resources\n"
            "    mkdir -p squashfs-root/usr/share/icons/hicolor/256x256/apps\n"
            "    printf '#!/bin/sh\\necho AppRun \"$@\"\\n' > squashfs-root/AppRun\n"
            "    printf '#!/bin/sh\\necho t3code \"$@\"\\n' > squashfs-root/t3code\n"
            "    printf 'sandbox\\n' > squashfs-root/chrome-sandbox\n"
            "    printf 'asar\\n' > squashfs-root/resources/app.asar\n"
            "    printf 'png\\n' > squashfs-root/usr/share/icons/hicolor/256x256/apps/t3code.png\n"
            "    chmod 755 squashfs-root/AppRun squashfs-root/t3code\n"
            "    ;;\n"
            "  *) echo \"fake AppImage: unsupported argv: $*\" >&2; exit 1 ;;\n"
            "esac\n")
        self.appimage.chmod(0o644)
        self.license = self.srcdir / f"t3code-f8y-bin-{self.FAKEVER}-LICENSE"
        self.license.write_bytes(LICENSE_BYTES)

    def run_pkgbuild(self, calls: str) -> subprocess.CompletedProcess:
        script = f"""
set -euo pipefail
pkgname=t3code-f8y-bin
pkgver={self.FAKEVER}
pkgrel=1
srcdir={self.srcdir}
pkgdir={self.pkgdir}
source {self.pkgbuild}
{calls}
"""
        return subprocess.run(
            ["bash", "-c", script], capture_output=True, text=True,
            timeout=120, cwd=str(self.srcdir))

    def prepare_and_package(self) -> subprocess.CompletedProcess:
        return self.run_pkgbuild("prepare\npackage\n")

    # ---- positive behavior ----------------------------------------------

    def test_prepare_and_package_build_complete_tree(self):
        proc = self.prepare_and_package()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        opt = self.pkgdir / "opt" / "t3code-f8y-bin"
        self.assertTrue((opt / "AppRun").is_file())
        self.assertTrue((opt / "t3code").is_file())
        self.assertTrue((opt / "resources" / "app.asar").is_file())
        sandbox = opt / "chrome-sandbox"
        self.assertTrue(sandbox.is_file())
        self.assertEqual(oct(sandbox.stat().st_mode & 0o7777), "0o4755")
        # u=rwX,go=rX on the rest of /opt: dirs 755, files 644, exes 755.
        self.assertEqual(oct((opt / "AppRun").stat().st_mode & 0o777), "0o755")
        self.assertEqual(oct((opt / "resources" / "app.asar").stat().st_mode & 0o777),
                         "0o644")
        launcher = self.pkgdir / "usr" / "bin" / "t3code"
        self.assertTrue(launcher.is_file())
        self.assertEqual(oct(launcher.stat().st_mode & 0o777), "0o755")
        alias = self.pkgdir / "usr" / "bin" / "t3-code-desktop"
        self.assertTrue(alias.is_symlink())
        self.assertEqual(os.readlink(alias), "t3code")
        icon = (self.pkgdir / "usr" / "share" / "icons" / "hicolor" /
                "256x256" / "apps" / "t3code-f8y.png")
        self.assertTrue(icon.is_file())
        desktop = self.pkgdir / "usr" / "share" / "applications" / "t3code.desktop"
        text = desktop.read_text()
        for field in ("Exec=t3code %U", "TryExec=t3code",
                      "Icon=t3code-f8y", "MimeType=x-scheme-handler/t3code;",
                      "Type=Application", "Categories=Development;"):
            self.assertIn(field, text)
        installed_license = (self.pkgdir / "usr" / "share" / "licenses" /
                             "t3code-f8y-bin" / "LICENSE")
        self.assertEqual(installed_license.read_bytes(), LICENSE_BYTES)
        # Launcher content: absolute /opt path, env hardening, no profile flags.
        launcher_text = launcher.read_text()
        self.assertIn("exec /opt/t3code-f8y-bin/AppRun", launcher_text)
        self.assertIn("export T3CODE_DISABLE_AUTO_UPDATE=1", launcher_text)
        self.assertIn("unset APPIMAGE APPDIR", launcher_text)
        self.assertNotIn("user-data-dir", launcher_text)
        self.assertNotIn("--profile", launcher_text)
        # PKGBUILD declares x86_64 + desktop purpose.
        pb = self.pkgbuild.read_text()
        self.assertIn("arch=('x86_64')", pb)
        self.assertIn("pkgdesc=", pb)

    # ---- prepare failure modes -------------------------------------------

    def test_prepare_fails_without_desktop_executable(self):
        # Full payload EXCEPT the t3code executable; prepare must fail on its
        # explicit desktop-executable check, not on a generic missing payload.
        orig = self.appimage.read_text()
        self.appimage.write_text(orig.replace(
            "printf '#!/bin/sh\\necho t3code \"$@\"\\n' > squashfs-root/t3code\n"
            "", "").replace(
            "chmod 755 squashfs-root/AppRun squashfs-root/t3code\n",
            "chmod 755 squashfs-root/AppRun\n"))
        proc = self.run_pkgbuild("prepare")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("missing its launcher, desktop executable",
                      proc.stderr, proc.stderr)

    def test_prepare_fails_when_desktop_executable_not_executable(self):
        # t3code exists but lacks -x; prepare's executable check must fail.
        orig = self.appimage.read_text()
        self.appimage.write_text(orig.replace(
            "chmod 755 squashfs-root/AppRun squashfs-root/t3code\n",
            "chmod 755 squashfs-root/AppRun\n"
            "chmod 644 squashfs-root/t3code\n"))
        proc = self.run_pkgbuild("prepare")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("missing its launcher, desktop executable",
                      proc.stderr, proc.stderr)

    def test_prepare_fails_when_app_asar_missing(self):
        orig = self.appimage.read_text()
        self.appimage.write_text(orig.replace(
            "printf 'asar\\n' > squashfs-root/resources/app.asar\n", ""))
        proc = self.run_pkgbuild("prepare")
        self.assertNotEqual(proc.returncode, 0)

    def test_prepare_fails_when_chrome_sandbox_missing(self):
        orig = self.appimage.read_text()
        self.appimage.write_text(orig.replace(
            "printf 'sandbox\\n' > squashfs-root/chrome-sandbox\n", ""))
        proc = self.run_pkgbuild("prepare")
        self.assertNotEqual(proc.returncode, 0)

    # ---- launcher execution ------------------------------------------------

    def test_launcher_preserves_args_and_hardens_environment(self):
        proc = self.prepare_and_package()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        launcher = (self.pkgdir / "usr" / "bin" / "t3code").read_text()
        recorder = self.root / "apprun-recorder.sh"
        out_file = self.root / "apprun-record.txt"
        recorder.write_text(
            "#!/usr/bin/env bash\n"
            "{\n"
            "  printf 'argc=%s\\n' \"$#\"\n"
            "  for a in \"$@\"; do printf 'arg=%s\\n' \"$a\"; done\n"
            "  printf 'T3CODE_DISABLE_AUTO_UPDATE=%s\\n' \"${T3CODE_DISABLE_AUTO_UPDATE-<unset>}\"\n"
            "  printf 'APPIMAGE=%s\\n' \"${APPIMAGE-<unset>}\"\n"
            "  printf 'APPDIR=%s\\n' \"${APPDIR-<unset>}\"\n"
            "} > \"" + str(out_file) + "\"\n")
        recorder.chmod(0o755)
        # Repoint ONLY the absolute /opt AppRun path; nothing else changes.
        repointed = self.root / "launcher-repointed.sh"
        repointed.write_text(
            launcher.replace("/opt/t3code-f8y-bin/AppRun", str(recorder)))
        repointed.chmod(0o755)
        env = dict(os.environ)
        env["APPIMAGE"] = "/inherited/x.AppImage"
        env["APPDIR"] = "/inherited/appdir"
        env["T3CODE_DISABLE_AUTO_UPDATE"] = "0"
        run = subprocess.run([str(repointed), "--foo", "bar", "--flag=value"],
                             env=env, capture_output=True, text=True,
                             timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        record = out_file.read_text().splitlines()
        self.assertEqual(record[0], "argc=3")
        self.assertEqual(record[1:4],
                         ["arg=--foo", "arg=bar", "arg=--flag=value"])
        self.assertIn("T3CODE_DISABLE_AUTO_UPDATE=1", record)
        self.assertIn("APPIMAGE=<unset>", record)
        self.assertIn("APPDIR=<unset>", record)
        for line in record[1:4]:
            self.assertNotIn("user-data-dir", line)
            self.assertNotIn("--profile", line)


class SyntaxAndIntegrityTest(unittest.TestCase):
    """bash -n over the real production files + end-of-run immutability."""

    def test_shell_syntax_of_production_files(self):
        for path in (HELPER, STABLE_PKGBUILD, NIGHTLY_PKGBUILD, F8Y_PKGBUILD):
            with self.subTest(file=str(path.relative_to(REPO_ROOT))):
                proc = subprocess.run(["bash", "-n", str(path)],
                                      capture_output=True, text=True,
                                      timeout=60)
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_production_files_unchanged_after_full_suite(self):
        before = unittest_case_store.get("production_hashes")
        self.assertIsNotNone(before)
        self.assertEqual(production_hashes(), before,
                         "production files were mutated during the run")


unittest_case_store: dict = {}


def _flatten_tests(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _flatten_tests(item)
        elif item is not None:
            yield item.id()


def main() -> int:
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    unittest_case_store["production_hashes"] = production_hashes()

    loader = unittest.TestLoader()
    suite = loader.loadTestsFromModule(sys.modules[__name__])
    # Snapshot names BEFORE running: TestSuite iteration on this Python
    # destructively releases its tests once traversed (the runner consumes it).
    test_names = list(_flatten_tests(suite))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    finished = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    summary = {
        "startedUtc": started,
        "finishedUtc": finished,
        "testsRun": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "skipped": len(result.skipped),
        "testNames": test_names,
        "productionHashes": unittest_case_store["production_hashes"],
        "testFileSha256": sha256_file(Path(__file__)),
        "command": ("flock /tmp/opencode/fork-rewrite-heavy-b.lock python3 "
                    "packaging/aur/scripts/release.test.py"),
    }
    (EVIDENCE_DIR / "release-test-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n")
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
