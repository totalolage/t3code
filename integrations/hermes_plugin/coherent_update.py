"""Release-tag-driven T3 service updates for the Hermes plugin."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import service
from .config import PluginConfig, load_config
from .releases import repository_release_tag, stage_release_tag


class UpdateError(RuntimeError):
    """Raised when the requested service release cannot be activated."""


def _redact_error(error: object) -> str:
    message = str(error)
    message = re.sub(
        r"(https?://)[^/\s@]+@",
        r"\1[REDACTED]@",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"(https?://[^\s?]+)\?[^\s]+",
        r"\1?[REDACTED]",
        message,
        flags=re.IGNORECASE,
    )
    message = re.sub(
        r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b",
        "[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)\b(Bearer\s+)[^\s,;]+",
        r"\1[REDACTED]",
        message,
    )
    message = re.sub(
        r"(?i)\b(access[_-]?token|pairing[_-]?token|token|password|secret)"
        r"\s*[=:]\s*([^\s,;]+)",
        r"\1=[REDACTED]",
        message,
    )
    return message


@dataclass(frozen=True)
class ProductTarget:
    version: str
    tag: str
    staged_binary: Path
    binary_sha256: str


@dataclass(frozen=True)
class ProductSnapshot:
    binary_backup: Path | None
    state_backup: bytes | None
    services_installed: bool


def _command(
    command: list[str],
    *,
    cwd: Path | None = None,
    timeout: float = 120,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            command,
            cwd=str(cwd) if cwd is not None else None,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise UpdateError(f"could not run {command[0]}: {error}") from error
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise UpdateError(
            f"{command[0]} exited with status {result.returncode}"
            + (f": {detail}" if detail else "")
        )
    return result


def _installed_tag(
    state: dict[str, object] | None,
    desired_tag: str,
) -> str | None:
    if state is None:
        return None
    tag = state.get("product_release_tag")
    if isinstance(tag, str):
        return tag
    version = state.get("product_version")
    if isinstance(version, str) and version == desired_tag.removeprefix("v"):
        # State written by the prior updater stored the artifact version without
        # its leading tag prefix. Adopt it without a needless reinstall.
        return desired_tag
    return version if isinstance(version, str) else None


def _resolve_target(config: PluginConfig, desired_tag: str) -> ProductTarget:
    config.runtime_root.mkdir(parents=True, exist_ok=True)
    transaction_root = Path(
        tempfile.mkdtemp(prefix=".service-update-", dir=config.runtime_root)
    )
    try:
        release = stage_release_tag(config, desired_tag, transaction_root / "t3")
        return ProductTarget(
            version=release.version,
            tag=release.tag,
            staged_binary=transaction_root / "t3",
            binary_sha256=release.binary_sha256,
        )
    except Exception:
        shutil.rmtree(transaction_root, ignore_errors=True)
        raise


def _snapshot_product(
    config: PluginConfig,
    prior_state: dict[str, object] | None = None,
) -> ProductSnapshot:
    snapshot_root = config.runtime_root / ".service-update-snapshot"
    if snapshot_root.exists():
        raise UpdateError(
            f"an incomplete service update snapshot exists at {snapshot_root}"
        )
    snapshot_root.mkdir(parents=True)
    try:
        binary_backup = None
        if config.binary_path.is_file():
            binary_backup = snapshot_root / "t3"
            shutil.copyfile(config.binary_path, binary_backup)
            os.chmod(binary_backup, 0o755)
        if prior_state is not None and prior_state.get("desired_state") == "installed":
            expected_digest = prior_state.get("binary_sha256")
            if (
                binary_backup is None
                or not isinstance(expected_digest, str)
                or service._binary_sha256(binary_backup) != expected_digest
            ):
                raise UpdateError(
                    "the prior installed runtime changed before a trusted rollback "
                    "snapshot could be created"
                )
        return ProductSnapshot(
            binary_backup=binary_backup,
            state_backup=(
                config.service_state_path.read_bytes()
                if config.service_state_path.is_file()
                else None
            ),
            services_installed=(config.service_dir / "run").is_file(),
        )
    except Exception:
        shutil.rmtree(snapshot_root, ignore_errors=True)
        raise


def _restore_state(config: PluginConfig, state_backup: bytes | None) -> None:
    if state_backup is None:
        config.service_state_path.unlink(missing_ok=True)
        return
    state = json.loads(state_backup)
    if not isinstance(state, dict):
        raise UpdateError("prior desired state is invalid")
    service._write_service_state(config, state)


def _rollback_product(
    config: PluginConfig,
    snapshot: ProductSnapshot,
) -> dict[str, object]:
    failures: list[str] = []
    try:
        config.binary_path.parent.mkdir(parents=True, exist_ok=True)
        if snapshot.binary_backup is None:
            config.binary_path.unlink(missing_ok=True)
        else:
            replacement = config.binary_path.with_name(
                f".{config.binary_path.name}.rollback"
            )
            shutil.copyfile(snapshot.binary_backup, replacement)
            os.chmod(replacement, 0o755)
            os.replace(replacement, config.binary_path)
        service._restore_runtime_after_product_rollback(
            config,
            installed_intent=snapshot.services_installed,
        )
    except Exception as error:
        failures.append(f"runtime/service: {_redact_error(error)}")
    try:
        _restore_state(config, snapshot.state_backup)
    except Exception as error:
        failures.append(f"state: {_redact_error(error)}")
    return {"ok": not failures, "failures": failures}


def _perform_locked(config: PluginConfig, operation: str) -> dict[str, object]:
    desired_tag = repository_release_tag(config)
    state = service._read_service_state(config)
    if operation == "update" and (
        state is None or state.get("desired_state") != "installed"
    ):
        raise UpdateError(
            "Update requires an installed service; use Install and start for the "
            "first activation"
        )

    installed_tag = _installed_tag(state, desired_tag)
    if operation == "update" and installed_tag == desired_tag:
        return {
            "ok": True,
            "action": "not_needed",
            "desired_tag": desired_tag,
            "installed_tag": installed_tag,
            "status": service.status(config).to_dict(),
        }

    snapshot_root = config.runtime_root / ".service-update-snapshot"
    if snapshot_root.exists():
        raise UpdateError(
            f"an incomplete service update snapshot exists at {snapshot_root}"
        )
    if operation == "update":
        service._validate_recovery_binary(config, state)

    target: ProductTarget | None = None
    snapshot: ProductSnapshot | None = None
    snapshot_created = False
    cleanup_snapshot = True
    try:
        target = _resolve_target(config, desired_tag)
        snapshot = _snapshot_product(config, state)
        snapshot_created = True
        activation = service._activate_staged_product_locked(
            config,
            staged_binary=target.staged_binary,
            product_version=target.version,
            release_tag=target.tag,
            binary_sha256=target.binary_sha256,
        )
        service_pid = activation.get("service_pid")
        if (
            activation.get("ok") is not True
            or type(service_pid) is not int
            or service_pid <= 0
            or activation.get("http_healthy") is not True
        ):
            raise UpdateError(
                "activation did not prove runtime, supervisor, process, and HTTP health"
            )
        return {
            "ok": True,
            "action": "installed" if operation == "install" else "updated",
            "version": target.version,
            "desired_tag": target.tag,
            "installed_tag": target.tag,
            "service_pid": service_pid,
            "status": service.status(config).to_dict(),
        }
    except Exception as error:
        if snapshot is None:
            raise
        rollback = _rollback_product(config, snapshot)
        cleanup_snapshot = bool(rollback["ok"])
        outcome = "rollback succeeded" if rollback["ok"] else "rollback failed"
        details = rollback.get("failures") or []
        suffix = f": {'; '.join(map(str, details))}" if details else ""
        raise UpdateError(f"{error}; {outcome}{suffix}") from error
    finally:
        if target is not None:
            shutil.rmtree(target.staged_binary.parent, ignore_errors=True)
        if snapshot_created and cleanup_snapshot:
            shutil.rmtree(
                config.runtime_root / ".service-update-snapshot",
                ignore_errors=True,
            )


def _run_in_process(config: PluginConfig, operation: str) -> dict[str, object]:
    with service.lifecycle_lock(config):
        return _perform_locked(config, operation)


def _run_entrypoint(config: PluginConfig, operation: str) -> dict[str, object]:
    config.runtime_root.mkdir(parents=True, exist_ok=True)
    worker = Path(__file__).with_name("update_process.py")
    result = _command(
        [sys.executable, "-I", str(worker), str(config.plugin_root), operation],
        cwd=config.runtime_root,
        timeout=300,
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError((result.stderr or result.stdout).strip() or "Update failed")
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise UpdateError("Update process returned invalid JSON") from error
    if not isinstance(response, dict) or not response.get("ok"):
        raise UpdateError("Update process did not report success")
    return response


def install(config: PluginConfig) -> dict[str, object]:
    return _run_entrypoint(config, "install")


def update(config: PluginConfig) -> dict[str, object]:
    return _run_entrypoint(config, "update")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("invalid service update invocation", file=sys.stderr)
        return 2
    try:
        config = load_config(plugin_root=Path(argv[0]).resolve())
        operation = argv[1]
        if operation not in {"install", "update"}:
            raise UpdateError("invalid service update operation")
        result = _run_in_process(config, operation)
    except Exception as error:
        print(_redact_error(error), file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0
