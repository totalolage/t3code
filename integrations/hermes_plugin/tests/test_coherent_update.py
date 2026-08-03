from __future__ import annotations

import io
import json
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from dataclasses import replace
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch

from integrations.hermes_plugin import coherent_update, update_process
from integrations.hermes_plugin.config import load_config


class CoherentUpdateTest(unittest.TestCase):
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

    def test_dashboard_update_uses_fresh_code_from_the_current_checkout(self) -> None:
        completed = CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {
                    "ok": True,
                    "action": "updated",
                    "desired_tag": "v0.0.31-f8y.20260803.49",
                    "installed_tag": "v0.0.31-f8y.20260803.49",
                }
            ),
            stderr="",
        )
        with patch(
            "integrations.hermes_plugin.coherent_update._command",
            return_value=completed,
        ) as command:
            result = coherent_update.update(self.config)

        argv = command.call_args.args[0]
        self.assertEqual(argv[0], coherent_update.sys.executable)
        self.assertEqual(argv[1], "-I")
        self.assertEqual(Path(argv[2]).name, "update_process.py")
        self.assertEqual(argv[-2:], [str(self.config.plugin_root), "update"])
        self.assertEqual(result["action"], "updated")

    def test_fresh_entrypoint_imports_code_from_the_supplied_checkout(self) -> None:
        target_root = Path(self.temporary.name) / "target-plugin"
        package = target_root / "integrations" / "hermes_plugin"
        package.mkdir(parents=True)
        marker = target_root / "loaded-target"
        package.joinpath("coherent_update.py").write_text(
            "from pathlib import Path\n"
            "def main(argv):\n"
            f"    Path({str(marker)!r}).write_text(argv[1], encoding='utf-8')\n"
            "    return 0\n",
            encoding="utf-8",
        )
        worker = Path(coherent_update.__file__).with_name("update_process.py")

        result = coherent_update._command(
            [
                coherent_update.sys.executable,
                "-I",
                str(worker),
                str(target_root),
                "update",
            ],
            check=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(marker.read_text(encoding="utf-8"), "update")

    def test_update_process_preserves_plugin_root_and_operation(self) -> None:
        plugin_root = str(self.config.plugin_root)
        with (
            patch.object(
                update_process.sys,
                "argv",
                ["update_process.py", plugin_root, "update"],
            ),
            patch.object(coherent_update, "main", return_value=0) as update_main,
        ):
            exit_code = update_process.main()

        self.assertEqual(exit_code, 0)
        update_main.assert_called_once_with([plugin_root, "update"])

    def test_failed_activation_restores_prior_runtime_state_and_service(self) -> None:
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(b"prior runtime")
        prior_state = b'{"version":1,"desired_state":"installed"}\n'
        self.config.service_state_path.write_bytes(prior_state)
        (self.config.service_dir / "run").parent.mkdir(parents=True)
        (self.config.service_dir / "run").write_text("run", encoding="utf-8")
        snapshot = coherent_update._snapshot_product(self.config)
        self.config.binary_path.write_bytes(b"failed target")
        self.config.service_state_path.write_text(
            '{"version":1,"desired_state":"uninstalled"}\n', encoding="utf-8"
        )

        with patch(
            "integrations.hermes_plugin.service._restore_runtime_after_product_rollback"
        ) as restore_service:
            result = coherent_update._rollback_product(self.config, snapshot)

        self.assertTrue(result["ok"])
        self.assertEqual(self.config.binary_path.read_bytes(), b"prior runtime")
        self.assertEqual(
            json.loads(self.config.service_state_path.read_text(encoding="utf-8")),
            json.loads(prior_state),
        )
        restore_service.assert_called_once_with(self.config, installed_intent=True)

    def test_failed_install_rollback_preserves_uninstalled_intent(self) -> None:
        snapshot = coherent_update.ProductSnapshot(
            binary_backup=None,
            state_backup=b'{"version":1,"desired_state":"uninstalled"}\n',
            services_installed=False,
        )
        with patch(
            "integrations.hermes_plugin.service._restore_runtime_after_product_rollback"
        ) as restore_service:
            result = coherent_update._rollback_product(self.config, snapshot)

        self.assertTrue(result["ok"])
        restored = json.loads(
            self.config.service_state_path.read_text(encoding="utf-8")
        )
        self.assertEqual(restored["desired_state"], "uninstalled")
        restore_service.assert_called_once_with(self.config, installed_intent=False)

    def test_invalid_service_pid_rolls_back_and_cannot_report_success(self) -> None:
        target = coherent_update.ProductTarget(
            version="0.0.31",
            tag="v0.0.31",
            staged_binary=self.config.runtime_root / ".target" / "t3",
            binary_sha256="a" * 64,
        )
        snapshot = coherent_update.ProductSnapshot(
            binary_backup=None,
            state_backup=b'{"version":1,"desired_state":"installed"}\n',
            services_installed=True,
        )
        with (
            patch(
                "integrations.hermes_plugin.coherent_update.repository_release_tag",
                return_value=target.tag,
            ),
            patch(
                "integrations.hermes_plugin.service._read_service_state",
                return_value={
                    "version": 1,
                    "desired_state": "installed",
                    "product_release_tag": "v0.0.30",
                },
            ),
            patch("integrations.hermes_plugin.service._validate_recovery_binary"),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target",
                return_value=target,
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._snapshot_product",
                return_value=snapshot,
            ),
            patch(
                "integrations.hermes_plugin.service._activate_staged_product_locked",
                return_value={
                    "ok": True,
                    "service_pid": -1,
                    "http_healthy": True,
                },
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._rollback_product",
                return_value={"ok": True, "failures": []},
            ) as rollback,
            patch("integrations.hermes_plugin.coherent_update.shutil.rmtree"),
            self.assertRaisesRegex(
                coherent_update.UpdateError, "activation did not prove"
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        rollback.assert_called_once_with(self.config, snapshot)

    def test_retry_preserves_a_snapshot_from_an_earlier_failed_rollback(self) -> None:
        snapshot_root = self.config.runtime_root / ".service-update-snapshot"
        snapshot_root.mkdir(parents=True)
        retained = snapshot_root / "t3"
        retained.write_bytes(b"prior trusted runtime")

        with (
            patch(
                "integrations.hermes_plugin.coherent_update.repository_release_tag",
                return_value="v0.0.31",
            ),
            patch(
                "integrations.hermes_plugin.service._read_service_state",
                return_value={
                    "version": 1,
                    "desired_state": "installed",
                    "product_release_tag": "v0.0.30",
                },
            ),
            patch(
                "integrations.hermes_plugin.coherent_update._resolve_target"
            ) as resolve_target,
            self.assertRaisesRegex(
                coherent_update.UpdateError,
                "incomplete service update snapshot",
            ),
        ):
            coherent_update._perform_locked(self.config, "update")

        self.assertEqual(retained.read_bytes(), b"prior trusted runtime")
        resolve_target.assert_not_called()

    def test_snapshot_rejects_a_prior_binary_that_changed_after_validation(
        self,
    ) -> None:
        self.config.binary_path.parent.mkdir(parents=True)
        self.config.binary_path.write_bytes(b"tampered runtime")
        state = {
            "version": 1,
            "desired_state": "installed",
            "binary_sha256": "0" * 64,
        }

        with self.assertRaisesRegex(
            coherent_update.UpdateError,
            "trusted rollback snapshot",
        ):
            coherent_update._snapshot_product(self.config, state)

        self.assertFalse(
            (self.config.runtime_root / ".service-update-snapshot").exists()
        )

    def test_lifecycle_lock_serializes_update_processes(self) -> None:
        active = 0
        peak = 0
        state_lock = threading.Lock()

        def perform(_config, _operation):
            nonlocal active, peak
            with state_lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.02)
            with state_lock:
                active -= 1
            return {"ok": True}

        with patch(
            "integrations.hermes_plugin.coherent_update._perform_locked",
            side_effect=perform,
        ):
            threads = [
                threading.Thread(
                    target=coherent_update._run_in_process,
                    args=(self.config, "update"),
                )
                for _ in range(2)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=2)

        self.assertEqual(peak, 1)

    def test_main_redacts_credentials_from_failures(self) -> None:
        stderr = io.StringIO()
        with (
            patch(
                "integrations.hermes_plugin.coherent_update.load_config",
                side_effect=coherent_update.UpdateError(
                    "download https://secret@example.test/file?token=abc failed"
                ),
            ),
            redirect_stderr(stderr),
        ):
            exit_code = coherent_update.main([str(self.config.plugin_root), "update"])

        self.assertEqual(exit_code, 1)
        self.assertNotIn("secret", stderr.getvalue())
        self.assertNotIn("token=abc", stderr.getvalue())
        self.assertIn("[REDACTED]", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
