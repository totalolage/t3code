# Running T3 Code in the Background

On Linux and macOS, T3 Code can run as a background service for your user, so it is ready without
keeping a terminal open.

## Manage the Service

Install it with the latest T3 Code release:

```sh
npx t3@latest service install
```

Check whether it is installed:

```sh
npx t3@latest service status
```

Update or repair it:

```sh
npx t3@latest service update
```

Stop it and remove it from startup:

```sh
npx t3@latest service uninstall
```

Updating restarts T3 Code briefly. Let active agent work and terminal commands finish first.
If a remote update is already in progress, wait for it to finish before retrying a local update.

The service runs a small stable launcher. Exact T3 Code versions are installed separately, so a
failed remote candidate can return to the previous version without rewriting the service
definition. The launcher snapshots the database before a remote candidate starts, so database
updates roll back with the server version. An older launcher may require one local
`service update` before this is available.

## Platform Support

**Linux** uses a systemd user unit at `~/.config/systemd/user/t3code.service` by default. The
service starts when the machine boots and keeps running after you log out. Installation enables
lingering for the user.

For a classic s6 scan directory, pass the same supervisor options to each lifecycle command:

```sh
sudo t3 service install --base-dir "$HOME/.t3" \
  --supervisor s6 --service-dir /run/service/t3code
sudo t3 service status --base-dir "$HOME/.t3" \
  --supervisor s6 --service-dir /run/service/t3code
```

The service directory must already be inside a scan directory managed by `s6-svscan`. T3 Code owns
the `run` file inside that directory and controls it with `s6-svc`. The generated service drops
privileges before starting T3 Code. A non-root invocation uses its own UID and GID. A root invocation
under `sudo` uses `SUDO_UID` and `SUDO_GID`. For another account, or when invoking directly as root,
select the non-root identity explicitly and repeat it for update or repair commands:

```sh
t3 service install --supervisor s6 --service-dir /run/service/t3code \
  --service-user t3 --service-group t3
```

Installation reconciles the T3 Code state and log ownership to the selected identity so the service
can keep writing across supervisor restarts.

Pass `--host` and `--port` when the managed service needs a stable listening address. These values
are persisted in the generated service definition:

```sh
t3 service install --supervisor s6 --service-dir /run/service/t3code \
  --host 0.0.0.0 --port 3773
```

**macOS** uses a launch agent at `~/Library/LaunchAgents/com.t3tools.t3code.service.plist`. It
starts when you log in, not when the Mac boots, and it stops when you log out. macOS has no
equivalent of Linux lingering for user agents. For a Mac that must stay reachable unattended,
turn on automatic login in **System Settings → Users & Groups**, and keep the Mac from sleeping.
Automatic login is unavailable while FileVault is on.

A few more macOS notes:

- Installing over SSH needs someone logged in at the Mac's screen to start the agent immediately.
  Otherwise, the install command reports an error at the final start step. The agent remains
  installed and starts at the next login.
- macOS may show privacy prompts for protected folders such as Desktop, Documents, or Downloads.
  The prompt may name a bare `node` process. If agent work cannot read those folders, grant Full
  Disk Access to the node binary listed in the launch agent's `ProgramArguments`.
- The agent appears under **System Settings → General → Login Items**. If it was switched off there
  or disabled with `launchctl disable`, switch it back on before the next login.

**Windows** is not supported yet.

## Automatic Service Updates

On Linux, set **Settings → General → Service update repository** to an exact GitHub repository URL,
such as `https://github.com/owner/repository`. Leave the setting empty to disable automatic service
updates.

Every 15 minutes the managed service checks that repository's GitHub releases. A newer
platform-specific CLI and its adjacent `.sha256` file are downloaded into the T3 Code runtime
directory. T3 Code verifies the checksum and the binary's reported version before marking the
update pending.

While an update is pending, existing agent turns may finish and new turns are saved in a durable
queue. Once no agent turn is active, T3 Code atomically replaces the systemd unit or s6 launcher and
asks the configured supervisor to restart it. The replacement process invokes queued turns after it
starts. A failed supervisor activation restores the previous service definition and resumes queued
work.

For s6, the root-owned run script remains fixed. It grants the selected group permission to restart
only that service, drops privileges, and then runs a launcher under the selected identity. Automatic
updates replace that user-owned launcher rather than modifying a script that s6 executes as root.

## Using It with T3 Connect

T3 Connect may offer to install the service during setup so the host stays reachable in the
background. This is only an onboarding shortcut: the service and T3 Connect are managed separately.

Signing out of T3 Connect does not remove the service. Use `t3 service uninstall` when you no longer
want T3 Code to start in the background.
