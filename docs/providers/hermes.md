# Hermes

T3 Code runs Hermes as an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agent.
Hermes remains a provider in **Settings → Providers** because it is the agent runtime that owns
sessions, tools, and model-provider credentials. The model picker is populated from the models Hermes
advertises over ACP, and T3 Code forwards model, runtime-mode, and supported option changes to the
active Hermes session.

T3 Code does not connect to the Hermes gateway HTTP API. A gateway URL and API-server secret are
therefore not Hermes provider settings. They authenticate the OpenAI-compatible HTTP surface, not the
stdio ACP process that T3 Code hosts.

## Native Hermes installation

Install and configure Hermes using its normal setup flow:

```bash
hermes setup
hermes acp --check
```

Then enable Hermes in T3 Code. Leave **Binary path** as `hermes`, or enter the absolute path to the
Hermes executable.

## Official Docker image

The repository includes [`scripts/hermes-container`](../../scripts/hermes-container), an executable
adapter that makes the official Hermes image look like a local `hermes` CLI. It:

- pins the tested image by digest;
- keeps Hermes configuration, credentials, sessions, and memory in a host data directory;
- mounts the current T3 project at the identical path inside the container;
- mounts linked-worktree Git metadata when it lives outside the project directory; and
- leaves stdin attached and keeps the ACP stdout stream free of image-bootstrap messages while
  removing the container when the session exits.

Docker must be installed and available to the user running the T3 Code server. Configure Hermes once:

```bash
scripts/hermes-container setup
scripts/hermes-container acp --check
```

In **Settings → Providers → Hermes**, set **Binary path** to the absolute path of
`scripts/hermes-container`, then enable the provider. The first invocation pulls the pinned image and
can take several minutes.

The default persistent state directory is:

```text
$XDG_DATA_HOME/t3code/hermes
```

or, when `XDG_DATA_HOME` is unset:

```text
$HOME/.local/share/t3code/hermes
```

Set `HERMES_CONTAINER_DATA_DIR` on the Hermes provider instance to use another directory. Use a
different directory for each independently configured Hermes provider instance.

### Supplying credentials through T3 Code

The setup wizard stores credentials in the mounted Hermes data directory and is the simplest option.
For instance-specific environment credentials instead, add both variables under the provider's
**Environment variables** section:

```text
HERMES_CONTAINER_FORWARD_ENV=OPENROUTER_API_KEY
OPENROUTER_API_KEY=<secret>
```

Mark API keys as sensitive. `HERMES_CONTAINER_FORWARD_ENV` accepts comma- or space-separated variable
names and is an explicit allowlist; the launcher does not copy T3 Code's entire server environment
into the container.

### Launcher overrides

| Variable                       | Purpose                                                 |
| ------------------------------ | ------------------------------------------------------- |
| `HERMES_CONTAINER_DATA_DIR`    | Persistent Hermes `/opt/data` directory                 |
| `HERMES_CONTAINER_IMAGE`       | Alternate Hermes image tag or digest                    |
| `HERMES_CONTAINER_ENGINE`      | Docker-compatible executable path                       |
| `HERMES_CONTAINER_RUNTIME`     | Optional Docker runtime name                            |
| `HERMES_CONTAINER_FORWARD_ENV` | Environment-variable names forwarded into the container |

`host.docker.internal` is mapped to the container host, so a custom model endpoint running on the
host can be configured as `http://host.docker.internal:<port>/v1`.

## Projects and execution

Hermes is not a T3 remote environment. T3 Code launches one ACP subprocess for the selected project,
and that subprocess performs tool work in the project directory. With the Docker launcher, the
subprocess happens to live in a local container whose project mount is created for that session.

For Hermes on another machine, expose an executable on the T3 server that transports stdio to
`hermes acp` on that machine, for example an SSH wrapper. The remote path must represent the same
project checkout that Hermes should edit; a Hermes gateway URL alone cannot provide that filesystem
and stdio contract.

## Conversations and model selection

New T3 Code threads create Hermes ACP sessions. T3 Code stores the opaque Hermes session ID and asks
Hermes to load it when a thread is reopened. T3 sends selected model changes through
`session/set_model`, maps T3 interaction modes to Hermes session modes, and forwards ACP tool and
approval events into the normal conversation timeline.

The models shown in T3 depend on the providers configured in Hermes. Add or authenticate another
underlying model provider with Hermes first; it can then advertise those models to T3 Code.

## Current limits

- The container has read/write access to the active project, its external linked-worktree metadata
  when needed, and its Hermes data directory. It does not receive an arbitrary host filesystem mount.
- A gateway HTTP URL and secret cannot be reused as ACP credentials.
- File attachments and thread rollback are not currently exposed by this integration.
