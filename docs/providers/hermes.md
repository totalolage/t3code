# Hermes

T3 Code connects to Hermes through the authenticated HTTP API exposed by an existing Hermes gateway.
Gateway deployment, network access, TLS, and ingress are administrator responsibilities and are not
provisioned by T3 Code.

## Configure a gateway

In **Settings → Providers → Hermes**, configure:

- **Gateway URL**: the base URL T3 Code's server can reach. A multiplexed profile path can be part of
  the base URL.
- **Shared secret**: the gateway's API server key.

Use HTTPS whenever the gateway is not on a trusted local network. T3 Code preserves non-secret query
parameters used for gateway routing on every Hermes endpoint request. It rejects embedded userinfo,
fragments, credential-shaped query parameters such as tokens, API keys, passwords, and secrets, and
non-HTTP schemes. It also refuses automatic redirects so the bearer secret cannot be forwarded to a
different origin.

The gateway URL is normal provider configuration. The shared secret is marked sensitive and stored
through T3 Code's server-side secret store; persisted settings and subsequent browser responses contain
only a redacted placeholder. Entering a new value replaces the stored secret.

After saving both fields, enable Hermes. The provider status reports the gateway health and
authentication result, and the model picker shows models returned by the gateway's `/v1/models`
endpoint.

## Conversations

New T3 Code threads create a Hermes native session. T3 Code stores the opaque Hermes session ID as its
resume cursor, uses the session streaming endpoint for turns, and translates assistant deltas and tool
lifecycle updates into the same timeline used by other providers. Continuing or reopening the T3 Code
thread resumes that Hermes session rather than replaying the transcript into a new one.

Stopping a T3 Code session does not delete the remote Hermes session, so it remains resumable.
Interrupting a turn closes the streaming request, which asks the Hermes gateway to cancel that run.

## Current limits

- Hermes tools run in the gateway's execution environment; a T3 Code project path is not transferred
  to the remote host.
- The Hermes session API does not expose T3's supervised or auto-accept runtime-mode enforcement.
  T3 Code therefore accepts only **Full access** for Hermes sessions; administrators must enforce any
  additional execution restrictions at the gateway.
- File attachments, interactive approvals, structured user-input requests, model switching within an
  existing session, and thread rollback are not exposed by this integration.
- Ingress provisioning and Hermes gateway configuration remain outside T3 Code.
