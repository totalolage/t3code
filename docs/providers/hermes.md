# Hermes

T3 Code runs Hermes as an [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) agent.
Hermes remains a provider in **Settings → Providers** because it is the agent runtime that owns
sessions, tools, and model-provider credentials. The model picker is populated from the models Hermes
advertises over ACP, and T3 Code forwards model, runtime-mode, and supported option changes to the
active Hermes session.

T3 Code does not connect to the Hermes gateway HTTP API. A gateway URL and API-server secret are
therefore not Hermes provider settings. They authenticate the OpenAI-compatible HTTP surface, not the
stdio ACP process that T3 Code hosts.

## Installation

Install and configure Hermes using its normal setup flow:

```bash
hermes setup
hermes acp --check
```

Then enable Hermes in T3 Code. Leave **Binary path** as `hermes`, or enter the absolute path to the
Hermes executable.

## Projects and execution

Hermes is not a T3 remote environment. T3 Code launches one ACP subprocess for the selected project,
and that subprocess performs tool work in the project directory.

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

- A gateway HTTP URL and secret cannot be reused as ACP credentials.
- File attachments and thread rollback are not currently exposed by this integration.
