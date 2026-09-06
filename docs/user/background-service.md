# Running T3 Code in the background

On Linux and macOS, T3 Code can run as a service for your user so you do not need
to keep a terminal open.

## Manage the service

Run these commands on the machine that will host T3 Code:

| Task                            | Command                           |
| ------------------------------- | --------------------------------- |
| Install and start               | `npx t3@latest service install`   |
| Inspect status and log location | `npx t3@latest service status`    |
| Update or repair                | `npx t3@latest service update`    |
| Stop and remove from startup    | `npx t3@latest service uninstall` |

Uninstalling the service leaves your projects, threads, and settings intact.

Install and update use the version of the CLI you invoke. For nightly, use
`npx t3@nightly service update`; replace `nightly` with an exact version to pin
one. An older CLI refuses to replace a newer service unless you explicitly add
`--allow-downgrade`.

Updating restarts the server. Finish active work first, and wait for any remote
update already in progress. To match a remote client's version, follow
[Updating T3 Code](./updating.md).

## Platform support

Linux needs systemd user services. Setup enables lingering so T3 Code starts at
boot and keeps running after logout. If this needs administrator permission,
setup prints a recovery command before changing the service.

macOS starts the service when you log in and stops it when you log out. Keep the
Mac logged in and awake for unattended remote access. Installing over SSH while
nobody is logged in at the Mac's screen can fail at the final start step; the
service is still installed and will start at the next login.

Windows background services are not supported.

### Use an s6 supervisor

For a classic s6 scan directory, pass `--supervisor s6` and an absolute
`--service-dir` to each service command:

```sh
sudo t3 service install --base-dir "$HOME/.t3" \
  --supervisor s6 --service-dir /run/service/t3code
sudo t3 service status --base-dir "$HOME/.t3" \
  --supervisor s6 --service-dir /run/service/t3code
```

The service directory must already be inside a scan directory managed by
`s6-svscan`. T3 Code owns the `run` file in that directory and controls it with
`s6-svc`.

The generated service drops privileges before starting T3 Code. A non-root
invocation uses its own UID and GID. A root invocation through `sudo` uses
`SUDO_UID` and `SUDO_GID`. If you invoke T3 Code directly as root, or select
another account, provide the non-root identity explicitly and repeat it for
update or repair commands:

```sh
t3 service install --supervisor s6 --service-dir /run/service/t3code \
  --service-user t3 --service-group t3
```

Installation reconciles T3 Code state and log ownership to the selected identity
so the service can keep writing across supervisor restarts.

Pass `--service-environment NAME=VALUE` to `service install` or `service update`
to add an environment variable to an s6 service. Repeat the flag for multiple
variables. T3 Code validates the names and values, rejects T3-managed names, and
exports the variables after the service drops root privileges.

Pass `--host` and `--port` when the managed service needs a stable listening
address. T3 Code persists these values in the generated service definition:

```sh
t3 service install --supervisor s6 --service-dir /run/service/t3code \
  --host 0.0.0.0 --port 3773
```

T3 Connect can offer service installation during setup, but the two are managed
separately. Signing out of T3 Connect does not stop or uninstall the service.

## Automatic service updates

For a managed systemd or s6 service, set **Settings → General → Service update
repository** (`serviceUpdateRepository`) to an exact GitHub repository URL, such
as `https://github.com/owner/repository`. Automatic update binaries are available
for Linux x64 and Apple Silicon macOS. Leave the setting empty to disable
automatic service updates.

Every 15 minutes, the managed service checks that repository's GitHub releases.
It downloads a newer platform-specific CLI and its adjacent `.sha256` file into
the T3 Code runtime directory. T3 Code verifies the checksum and the binary's
reported version before marking the update pending.

While an update is pending, existing agent turns may finish and new turns are
saved in a durable queue. When no agent turn is active, T3 Code atomically
replaces the systemd unit or s6 launcher and asks the configured supervisor to
restart it. The replacement process invokes queued turns after it starts. A
failed supervisor activation restores the previous service definition and
resumes queued work.

For s6, the root-owned `run` script remains fixed. It grants the selected group
permission to restart only that service, drops privileges, and runs a launcher
under the selected identity. Automatic updates replace that user-owned launcher
rather than modifying a script that s6 executes as root.

## Troubleshooting

Start with `t3 service status` on the host. It prints the log path and, on Linux,
checks whether the installed service is running, enabled, and allowed to survive
logout.

If it stops when your SSH session closes, check for `linger-disabled`. An
administrator can enable lingering with:

```sh
sudo loginctl enable-linger "$(id -un)"
```

Over SSH, allow sudo to prompt:

```sh
ssh -t your-server 'sudo loginctl enable-linger "$(id -un)"'
```

Then retry service setup as your normal user. Run only the `loginctl` command
with sudo; running T3 Code as root creates a separate installation and Connect
identity. Without administrator access, run `t3 serve` in a terminal and keep
that session open.

| Status problem                          | Next step                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `linger-unavailable`                    | Run `loginctl show-user "$(id -un)" --property=Linger` and check that systemd-logind is available.                             |
| `user-manager-unavailable`              | Run `systemctl --user status` in a login session for the service user; check your distribution's systemd user-session support. |
| `service-disabled` or `service-stopped` | Read the log and `systemctl --user status t3code.service`, then use the repair command printed by T3 Code.                     |

On macOS, check **System Settings → General → Login Items** if the service no
longer starts at login. If agent work cannot access Desktop, Documents, or
Downloads, it may need Full Disk Access for the Node executable listed in
`ProgramArguments` in
`~/Library/LaunchAgents/com.t3tools.t3code.service.plist`.

For failures after signing in to T3 Connect, see
[connection troubleshooting](./remote-access.md#t3-connect-troubleshooting).
