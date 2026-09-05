# Remote architecture

Each connection joins a client to one environment over HTTP and WebSocket. The
environment owns providers, execution, files, and durable state. Direct access,
Tailscale, SSH, and T3 Connect change how the client reaches that server; they do
not introduce another execution model. See
[remote access](../user/remote-access.md) for setup.

## Identity is independent of the route

An environment keeps its ID across server restarts and endpoint changes. Saved
connections are local to a client profile; the server's identity and state are
not. A repository identity can correlate clones across environments, but never
routes work between them. A project and its threads belong to one environment.

[Environment ID initialization](../../apps/server/src/environment/ServerEnvironment.ts)
must publish a complete ID atomically. Repair of an empty ID file retains a
recovery file so concurrent or delayed initializers choose the same winner.
Removing that recovery state as ordinary temporary-file cleanup can change the
identity underneath an already-running server.

Advertised endpoints are reachability hints. Only the connecting device can
prove that a route works. In particular, a host's loopback address refers to a
different machine when another device opens it. Endpoint selection must not
silently fall back to loopback when a shareable endpoint is unavailable.

## Hosted web is a client

The hosted web app stores its connection catalog in the browser and connects
directly to each environment. It does not proxy traffic or hold server-side
pairing state. Hosting the UI over HTTPS therefore cannot make a plain HTTP LAN
backend accessible from that browser context.

A [hosted pairing URL](../../apps/web/src/hostedPairing.ts) identifies the backend
in its query and carries the pairing secret in its fragment. Fragments stay out
of requests to the hosted origin. The browser exchanges the secret with the
environment and strips it from its history. Moving the token into a query
parameter would disclose it to the wrong origin.

The backend URL in the `host` query parameter may contain its own query
parameters. The client preserves their order, duplicate keys, and empty values,
then appends them to HTTP and WebSocket requests for that connection. `token` is
reserved for the pairing credential and is never forwarded as an endpoint
parameter. Generated pairing URLs put the credential in the fragment.

## Access and process ownership are different

Tailscale supplies an endpoint for ordinary pairing, so it needs no separate
environment type. Authentication remains the environment's responsibility for
every route. See [environment authentication](./environment-auth.md) and the
[T3 Connect trust boundary](./t3-connect.md).

SSH can launch a server as well as forward a port. Desktop main owns that
lifecycle because it can spawn SSH and handle authentication prompts. The
renderer uses the forwarded endpoint through the shared connection runtime.
[SSH cleanup](../../packages/ssh/src/tunnel.ts) stops a remote server only if the
launcher owns it; a server it discovered already running must survive a client
disconnect. Reconnection restores the forward before opening the application
transport.

## Unified CLI orchestration

Local and remote CLI orchestration share command specifications and handlers. A
target resolver supplies either a live server discovered from base-directory
runtime state or an explicit remote HTTP base URL. Both targets then use the
same authenticated HTTP and WebSocket transport. Local discovery verifies
process liveness, environment identity, CLI API compatibility, and operation
capabilities before issuing a stable local bearer session. Remote authentication
and public environment inspection stay under `t3 remote` so they remain separate
from local administrative authentication.

Thread creation is server-authoritative. The client sends project identity, the
first message, optional overrides, and a session-scoped idempotency key. The
server resolves only active registered projects and owns defaults,
branch/worktree preparation, setup, first-turn dispatch, deduplication, and
compensation. It never enrolls a project from a client-supplied path. The
environment descriptor advertises the CLI API version and operation capabilities;
clients fail closed when a required capability is absent or incompatible.

### Pending interactions

Remote pending interactions are an additive orchestration capability advertised
as `capabilities.orchestration.pendingInteractions`. The public HTTP and CLI
contract is a bounded, sanitized projection keyed by `(threadId, requestId)`.
Provider activity payloads never cross that remote API.

The server persists a semantic idempotency ledger scoped to the authenticated
session. Dispatch uses the existing internal wire commands and decision literals
with a stable command identity for crash recovery. The lifecycle is
`pending -> responding` only after dispatch acceptance and becomes resolved only
after the correlated provider acknowledgement. Terminal session states, thread
deletion, and recognized stale provider responses reconcile unresolved records to
a non-public stale state.

Remote approval is intentionally asymmetric. Decline and cancel remain
available, but approval is allowed only for a trusted allowlisted semantic
summary that sets `canApprove: true`. Untrusted provider prose can never grant
approval capability. Until a server-authored semantic normalizer provides that
allowlist, all provider-derived approvals are reject/cancel-only.

Remote servers can outlive several client releases. Clients must use advertised
capabilities and handle their absence, rather than assume their own version
describes the server. Process replacement belongs to the launcher's
[update protocol](./server-updates.md); the connection runtime handles the
resulting disconnect.
