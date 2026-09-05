# Remote access

Connect a phone, browser, or another desktop app to T3 Code running on a different
machine. That machine must stay running and reachable while you work.

## T3 Connect

T3 Connect makes an environment available to your other devices without setting
up router forwarding. In the desktop app on the host, open **Settings →
Connections**, sign in, and enable **T3 Connect** for that environment.

For a command-line host, run:

```bash
npx t3@latest connect
```

Follow the sign-in instructions. Setup offers a
[background service](./background-service.md); if you decline it, start the
server with `npx t3 serve`. Saving your sign-in alone does not make the machine
reachable.

On your other device, sign in to the same T3 Connect account and choose the
environment. Over SSH, the CLI prints a browser link and accepts the returned
authorization code, so you do not need to forward an OAuth callback port.

T3 Connect renews access credentials when needed without disconnecting a healthy
connection. Pull request diffs and provider settings keep working after the
previous credential expires. A failed renewal affects that request; it does not
disconnect an otherwise healthy conversation.

## Pair over a LAN or private network

Use direct pairing when the other device can reach the host's network address.

On a desktop host, open **Settings → Connections**, enable **Network access**,
then create a pairing link using an address the other device can reach. Changing
network access restarts the desktop app. You can turn it off in the same place.

For a command-line host, replace `<private-ip>` with the host's LAN or tailnet
address:

```bash
npx t3 serve --host <private-ip>
```

If a server is already running, generate a fresh link without restarting it:

```bash
npx t3 pair
```

Scan the QR code on your phone or paste the pairing URL into **Add environment**
in the receiving app. Connection settings are under **Settings → Connections**
on web and desktop and **Settings → Environments** on mobile. A loopback address
such as `127.0.0.1` reaches only the device opening the link.

Pairing authorizes that device for future connections. Use a fresh one-time link
for each new device; you do not need the original token to reconnect. Links
created in Settings can only be copied from the client that created them while
its Connections page stays open. If you leave or reload that page, create
another link to share.

### Tailscale HTTPS

Join both devices to the same tailnet. In the desktop app, enable **Tailscale
HTTPS** in **Settings → Connections**. Turn it off there to remove that route.

To start a command-line server with Tailscale HTTPS:

```bash
npx t3 serve --tailscale-serve
```

For an already-running server:

```bash
npx t3 pair --tailscale
```

The pairing link uses an address such as `https://machine.tailnet.ts.net/`.
The mapping created by `pair --tailscale` persists across restarts. Remove its
default-port mapping with:

```bash
tailscale serve --https=443 off
```

If that port is already in use, choose another with
`--tailscale-serve-port`. See `npx t3 pair --help` for other pairing options.

### Hosted web app

[app.t3.codes](https://app.t3.codes) needs an HTTPS endpoint. It connects directly
to your server; a hosted pairing link does not make an unreachable backend
reachable or convert HTTP to HTTPS.

For a plain HTTP LAN endpoint, use the direct pairing URL in a browser that can
open it, or pair from the desktop app. On mobile, an IP address entered without a
scheme uses HTTP, so include `https://` when your server uses HTTPS.

## Desktop-managed SSH

In the desktop app, open **Settings → Connections → Add environment**, choose
**SSH**, and enter a host or SSH alias such as `user@example.com`. T3 Code starts
or reuses a server there and opens the port forward for you. Projects, provider
credentials, and agent work stay on the remote machine.

The remote host needs a compatible [Node.js installation](./install.md#requirements)
and [provider setup](./install.md#providers). If launch cannot find Node or reports
an incompatible version, check it through a non-interactive SSH session:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

Configure your version manager for non-interactive shells if this differs from
your normal terminal. With nvm, setting a compatible default, such as
`nvm alias default 24`, can resolve the problem.

If SSH reconnecting fails after an app update, retry the launch once. Removing
the connection stops a server that T3 Code launched; a server that was already
running is left alone.

For Antigravity's Google callback on a remote host, see
[remote sign-in](./providers-antigravity.md#sign-in-from-a-remote-device).

## Manage or revoke access

On the host, **Settings → Connections** lets authorized administrators create
pairing links and revoke client sessions. Revoking an unused link prevents new
pairings; revoke a device's session to remove its existing access. Command-line
management is available through `npx t3 auth --help`.

A session with an open connection stays listed after its access credential
expires.

To remove an environment from T3 Connect, open your account menu's **T3 Connect**
page, or **Settings → T3 Connect** on mobile, and choose **Deregister**. This
revokes its cloud access and frees its host space even when the environment is
offline or has been wiped.

On a command-line host, `t3 connect unlink` disables exposure while retaining
your login; `t3 connect logout` also clears that login. Background-service
[removal](./background-service.md#manage-the-service) is separate.

Treat pairing URLs and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports. Anyone with a valid pairing credential can
create a session until the credential expires or is revoked.

## T3 Connect troubleshooting

Run `t3 connect status` on the host to inspect saved authorization and link
configuration. It is not a live reachability check. If the environment appears
offline, run `t3 service status` and read the displayed log. If it disappears
when SSH closes, see [background-service troubleshooting](./background-service.md#troubleshooting).

| Error                                                     | Recovery                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `environment_link_limit_exceeded` or managed tunnel limit | Deregister an unused environment, then restart T3 Code on the host.                                                                         |
| `auth_invalid` or `invalid_bearer`                        | Run `t3 connect login`. If credentials were revoked, run `t3 connect logout`, then `t3 connect` again. Restart the server after signing in. |
| Expired or invalid link proof                             | Check the host's date and time, update T3 Code, then restart it.                                                                            |
| HTTP 403 without a recognized error                       | Check relay access, proxies, and firewall rules. Keep any Cloudflare Ray ID for a bug report.                                               |
| HTTP 408, 429, or 5xx                                     | Check network and relay availability. Startup retries temporary failures for up to ten minutes.                                             |

After fixing a permanent rejection, restart the host's server. On Linux, use
`systemctl --user restart t3code.service` for the background service. For a
foreground server, stop it and run `t3 serve` again with your usual options.
Include the diagnostic message and trace ID when reporting a persistent failure.

For a connection that still fails after linking, check the date and time on both
devices. For server version warnings, follow [Updating T3 Code](./updating.md).

## Headless CLI

The orchestration command surface is the same for a live local server and an
explicit remote server:

```bash
# Discover the live server recorded under this base directory.
t3 session --base-dir /path/to/t3-state
t3 shell --base-dir /path/to/t3-state
t3 pending --base-dir /path/to/t3-state

# Target an explicit compatible remote server.
t3 remote session --host https://backend.example.com
t3 remote shell --host https://backend.example.com
t3 remote pending --host https://backend.example.com
```

The top-level `create`, `send`, `compact`, `watch`, `pending`, `answer`,
`approve`, `reject`, `thread`, `shell`, `session`, and `snapshot` commands
discover a live local server from its runtime state. Discovery verifies the
process, environment identity, and orchestration CLI API version before loading
or issuing the stable local CLI bearer session. These commands never fall back
to offline project mutation. `snapshot` is an advanced debug view; prefer
`shell`, `thread`, or `pending` for normal automation.

`t3 remote <operation> --host ...` uses the same command specification and HTTP
and WebSocket operations. Remote credentials remain managed only by `t3 remote
auth`; top-level `t3 auth` continues to manage the local server. Both paths send
bearer authorization headers and do not fall back to browser cookies.

### Create and compact threads

Thread creation is server-authoritative. The server resolves the registered
project, project model default, runtime and interaction defaults, branch policy,
worktree, setup script, and first turn as one rollback-capable operation:

```bash
t3 create project-id "Implement the change" \
  --yes \
  --confirm-create \
  --idempotency-key automation-job-42
```

Use `--branch`, `--base-branch`, `--runtime-mode`, `--interaction-mode`, or
`--start-from-origin` only when overriding server defaults. A path must already
identify a registered project; create never enrolls a project automatically.
Reusing the same idempotency key with the same authenticated CLI principal
safely replays the accepted result.

Compact an idle Codex thread after a completed automation run without creating a
message or turn:

```bash
t3 compact thread-123 \
  --yes \
  --idempotency-key dispatcher-run-42 \
  --base-dir /path/to/t3-state
```

Use `t3 remote compact ... --host https://backend.example.com` for an explicit
remote server. The command returns after Codex accepts native compaction.
Reusing the same idempotency key does not request compaction twice. Active
threads and providers without manual compaction fail clearly.

### Inspect pending interactions

The standalone remote CLI can read and respond to provider interactions without
exposing provider activity envelopes. A compatible server advertises
`capabilities.orchestration.pendingInteractions: true` in its environment
descriptor.

Use the read-only inspection commands before making a write:

```bash
t3 remote environment --host https://backend.example.com
t3 remote session --host https://backend.example.com
t3 remote shell --host https://backend.example.com
t3 remote snapshot --host https://backend.example.com
t3 remote thread thread-123 --host https://backend.example.com
t3 remote pending --host https://backend.example.com --thread-id thread-123
```

`environment` inspects public capabilities. The other inspection commands
require an authenticated session with `orchestration:read`; `shell`, `snapshot`,
and `thread` expose progressively more orchestration state, while `pending` is
the narrow interaction-only view.

### Watch and respond

Watch returns actionable interactions by default:

```bash
t3 remote watch thread-123 \
  --host https://backend.example.com \
  --format json
```

When a user-input question or command approval is open, `watch` exits promptly
with code `26` and writes exactly one compact JSON object to stdout. Its fields
are `threadId`, `turnId`, and `interaction`. The interaction contains `kind`,
`requestId`, and bounded structural `prompt` metadata: question and option
counts for user input or `requestKind: "command"` for an approval. It never
includes prompt text, option text, command text, arguments, provider logs,
credentials, or paths. Interaction output is JSON regardless of `--format`; the
format flag controls the final assistant result. Use `--no-interactions` only
when you intentionally want to wait for terminal completion without interruption
by approvals or user input.

Use `pending` to inspect the sanitized response choices:

```bash
t3 remote pending --host https://backend.example.com
t3 remote pending --host https://backend.example.com --thread-id thread-123
```

`pending` is read-only and requires `orchestration:read`. It writes exactly one
JSON document to stdout. The document always has an `interactions` array. Each
item has `threadId`, `requestId`, `kind`, `status`, `summary`, `canApprove`,
`allowedActions`, `questions`, `createdAt`, and `updatedAt`. Question objects
contain bounded `id`, `header`, `prompt`, `options`, `multiSelect`, and
`allowsCustomAnswer` fields. Display text is sanitized and bounded. Provider
envelopes, commands, arguments, environment values, credentials, raw errors,
terminal output, and local paths are not part of this API. Submit an option's
displayed `label` in `values`; when a provider option contains redacted text,
the server exposes a unique safe label and maps it back to the exact provider
value internally without returning that value to the client. Provider-required
question keys that are not safe opaque IDs are handled the same way through the
displayed question `id`. Requests that exceed the documented question or option
bounds are not exposed as partially answerable interactions.

Response writes require all three of the following: an authenticated session
authorized for `orchestration:operate`, a new opaque `--idempotency-key`, and
`--yes` as explicit acknowledgement of the remote write. The positional syntax
is always `<thread-id> <request-id>`:

```bash
t3 remote answer thread-123 request-456 \
  --host https://backend.example.com \
  --idempotency-key answer-456-1 \
  --answers-json '[{"questionId":"choice","values":["Continue"]}]' \
  --yes

t3 remote approve thread-123 request-456 \
  --host https://backend.example.com \
  --idempotency-key approve-456-1 \
  --yes

t3 remote reject thread-123 request-456 \
  --host https://backend.example.com \
  --idempotency-key reject-456-1 \
  --decision decline \
  --yes
```

Use `--decision cancel` when cancellation is preferable to decline. Approval is
fail-closed: `approve` is available only when the server produced an allowlisted
safe summary and reports `canApprove: true`. The current provider-derived
projection has no trusted positive allowlist, so it reports `canApprove: false`
and exposes only `decline` and `cancel`.

Every accepted response prints one JSON object with `threadId`, `requestId`,
`status`, `action`, `idempotencyKey`, and `replayed`. `status` is `responding`:
dispatch acceptance is not provider acknowledgement. The interaction remains
visible as `responding` with no allowed actions until the provider emits the
matching acknowledgement. Re-run `watch` after acknowledgement. It returns the
next actionable question or approval with exit code `26`, or the final assistant
result with exit code `0`. Final JSON fields are `threadId`, `turnId`, `status`,
and `message`; `message` contains `id`, `text`, and `createdAt`.

Retries in the same authenticated session reuse the original command identity
and do not forward an already accepted response again. A matching retry remains
replayable after provider resolution, which makes a lost HTTP acknowledgement
safe to recover. A retry key cannot be reused for different semantics. New or
mismatched responses to invalid, missing, resolved, and stale identifiers never
dispatch; missing and stale keys return the same generic not-found shape.
Stopped, interrupted, deleted, or provider-rejected stale requests disappear
from the open list. CLI diagnostics go to stderr and never include raw remote
error bodies, credentials, provider payloads, or local paths.
