from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from integrations.hermes_plugin import coherent_update, releases, service
from integrations.hermes_plugin.config import load_config


class TagDrivenUpdateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        base = load_config(plugin_root=root / "plugin")
        self.config = replace(
            base,
            runtime_root=root / "runtime",
            binary_path=root / "runtime" / "bin" / "t3",
            data_dir=root / "runtime" / "data",
            service_dir=root / "service" / "t3code",
            watchdog_service_dir=root / "service" / "t3code-plugin-watchdog",
        )

    def test_repository_release_tag_comes_from_the_current_checkout_only(self) -> None:
        with (
            patch(
                "integrations.hermes_plugin.releases._git",
                return_value=CompletedProcess([], 0, "v0.0.31-f8y.20260803.49\n", ""),
            ) as git,
            patch("integrations.hermes_plugin.releases._request_json") as request_json,
        ):
            tag = releases.repository_release_tag(self.config)

        self.assertEqual(tag, "v0.0.31-f8y.20260803.49")
        git.assert_called_once_with(
            self.config.plugin_root,
            ["tag", "--points-at", "HEAD"],
        )
        request_json.assert_not_called()

    def test_equal_tags_are_a_clean_no_op_without_artifact_or_service_work(
        self,
    ) -> None:
        state = {
            "version": 1,
            "desired_state": "installed",
            "product_release_tag": "v0.0.31-f8y.20260803.49",
        }
        status = {
            "desired_tag": "v0.0.31-f8y.20260803.49",
            "installed_tag": "v0.0.31-f8y.20260803.49",
            "update_available": False,
        }
        with (
            patch(
                "integrations.hermes_plugin.coherent_update.repository_release_tag",
                return_value="v0.0.31-f8y.20260803.49",
            ),
            patch(
                "integrations.hermes_plugin.service._read_service_state",
                return_value=state,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            patch(
                "integrations.hermes_plugin.service._activate_staged_product_locked"
            ) as activate,
            patch(
                "integrations.hermes_plugin.service._validate_recovery_binary"
            ) as validate_prior,
            patch("integrations.hermes_plugin.service.status") as service_status,
        ):
            service_status.return_value.to_dict.return_value = status
            result = coherent_update._perform_locked(self.config, "update")

        self.assertEqual(result["action"], "not_needed")
        self.assertEqual(result["desired_tag"], state["product_release_tag"])
        self.assertEqual(result["installed_tag"], state["product_release_tag"])
        self.assertEqual(result["status"], status)
        resolve_target.assert_not_called()
        activate.assert_not_called()
        validate_prior.assert_not_called()

    def test_different_tags_install_exact_repository_release_and_verify_health(
        self,
    ) -> None:
        prior_tag = "v0.0.31-f8y.20260802.48"
        desired_tag = "v0.0.31-f8y.20260803.49"
        state = {
            "version": 1,
            "desired_state": "installed",
            "product_release_tag": prior_tag,
        }
        target = coherent_update.ProductTarget(
            version="0.0.31-f8y.20260803.49",
            tag=desired_tag,
            staged_binary=self.config.runtime_root / ".update" / "t3",
            binary_sha256="a" * 64,
        )
        activation = {"ok": True, "service_pid": 321, "http_healthy": True}
        with (
            patch(
                "integrations.hermes_plugin.coherent_update.repository_release_tag",
                return_value=desired_tag,
            ),
            patch(
                "integrations.hermes_plugin.service._read_service_state",
                return_value=state,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ) as resolve_target,
            patch("integrations.hermes_plugin.service._validate_recovery_binary"),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product"
            ) as snapshot,
            patch(
                "integrations.hermes_plugin.service._activate_staged_product_locked",
                return_value=activation,
            ) as activate,
            patch("integrations.hermes_plugin.service.status") as service_status,
            patch("integrations.hermes_plugin.coherent_update.shutil.rmtree"),
        ):
            snapshot.return_value = coherent_update.ProductSnapshot(
                binary_backup=None,
                state_backup=json.dumps(state).encode(),
                services_installed=True,
            )
            service_status.return_value.to_dict.return_value = {
                "desired_tag": desired_tag,
                "installed_tag": desired_tag,
            }
            result = coherent_update._perform_locked(self.config, "update")

        resolve_target.assert_called_once_with(self.config, desired_tag)
        activate.assert_called_once_with(
            self.config,
            staged_binary=target.staged_binary,
            product_version=target.version,
            release_tag=target.tag,
            binary_sha256=target.binary_sha256,
        )
        self.assertEqual(result["action"], "updated")
        self.assertEqual(result["desired_tag"], desired_tag)
        self.assertEqual(result["installed_tag"], desired_tag)
        self.assertEqual(result["service_pid"], 321)

    def test_update_never_resurrects_an_explicitly_uninstalled_service(self) -> None:
        with (
            patch(
                "integrations.hermes_plugin.coherent_update.repository_release_tag",
                return_value="v0.0.31-f8y.20260803.49",
            ),
            patch(
                "integrations.hermes_plugin.service._read_service_state",
                return_value={"version": 1, "desired_state": "uninstalled"},
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            patch(
                "integrations.hermes_plugin.service._activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "requires an installed service",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        resolve_target.assert_not_called()
        activate.assert_not_called()

    def test_install_converges_an_uninstalled_stale_slot_via_update_lifecycle(
        self,
    ) -> None:
        desired_tag = "v0.0.31"
        self.config.service_dir.mkdir(parents=True)
        (self.config.service_dir / "run").write_text(
            "stale slot\n", encoding="utf-8"
        )
        service._set_desired_state(self.config, "uninstalled")
        staged = self.config.runtime_root / ".transaction" / "t3"
        staged.parent.mkdir(parents=True)
        staged.write_bytes(b"new verified coherent runtime")
        target = coherent_update.ProductTarget(
            version="0.0.31",
            tag=desired_tag,
            staged_binary=staged,
            binary_sha256=hashlib.sha256(staged.read_bytes()).hexdigest(),
        )
        current_status = {
            "desired_state": "installed",
            "desired_tag": desired_tag,
            "installed_tag": desired_tag,
        }

        with (
            patch(
                "integrations.hermes_plugin.coherent_update.repository_release_tag",
                return_value=desired_tag,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.service.binary_version",
                return_value="0.0.31",
            ),
            patch("integrations.hermes_plugin.service._prepare_service_dir"),
            patch(
                "integrations.hermes_plugin.service._write_t3_s6_service"
            ) as write_service,
            patch("integrations.hermes_plugin.service._install_watchdog"),
            patch(
                "integrations.hermes_plugin.service._verify_t3_service_up",
                return_value=9621,
            ),
            patch("integrations.hermes_plugin.service._verify_product_health"),
            patch("integrations.hermes_plugin.service.status") as status,
        ):
            status.return_value.to_dict.return_value = current_status
            result = coherent_update._perform_locked(self.config, "install")

        self.assertEqual(result["action"], "installed")
        self.assertEqual(result["status"], current_status)
        write_service.assert_called_once_with(
            self.config,
            "update",
            timeout=45,
            allow_downgrade=True,
        )
        state = json.loads(
            self.config.service_state_path.read_text(encoding="utf-8")
        )
        self.assertEqual(state["desired_state"], "installed")
        self.assertEqual(state["product_release_tag"], desired_tag)

    def test_different_tags_reject_a_tampered_prior_runtime_before_mutation(
        self,
    ) -> None:
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(b"tampered runtime")
        state = {
            "version": 1,
            "desired_state": "installed",
            "product_release_tag": "v0.0.30",
            "binary_sha256": hashlib.sha256(b"trusted prior runtime").hexdigest(),
        }
        with (
            patch(
                "integrations.hermes_plugin.coherent_update.repository_release_tag",
                return_value="v0.0.31",
            ),
            patch(
                "integrations.hermes_plugin.service._read_service_state",
                return_value=state,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            patch(
                "integrations.hermes_plugin.service._activate_staged_product_locked"
            ) as activate,
            self.assertRaisesRegex(service.ServiceError, "checksum mismatch"),
        ):
            coherent_update._perform_locked(self.config, "update")

        resolve_target.assert_not_called()
        activate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
