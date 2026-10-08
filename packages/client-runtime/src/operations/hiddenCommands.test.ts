import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionAttemptError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { AtomCommandResult } from "../state/runtime.ts";
import { createThreadEnvironmentAtoms } from "../state/threadCommands.ts";

let randomBytesCalls = 0;
const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => {
      randomBytesCalls += 1;
      return new Uint8Array(size);
    },
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const SUPPORTING_CONFIG = {
  environment: { capabilities: { threadHiding: true } },
} as unknown as ServerConfig;
const MISSING_CAPABILITY_CONFIG = {
  environment: { capabilities: {} },
} as unknown as ServerConfig;
const DISABLED_CAPABILITY_CONFIG = {
  environment: { capabilities: { threadHiding: false } },
} as unknown as ServerConfig;
const UNAVAILABLE_CONFIG: Effect.Effect<ServerConfig, ConnectionAttemptError> = Effect.fail(
  new ConnectionTransientError({
    reason: "transport",
    detail: "The test configuration is unavailable.",
  }),
);

interface TestEnvironment {
  readonly target: PrimaryConnectionTarget;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly hasSession: boolean;
}

function makeEnvironment(
  environmentId: string,
  label: string,
  initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>,
  hasSession = true,
): TestEnvironment {
  return {
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make(environmentId),
      label,
      httpBaseUrl: `https://${environmentId}.example.test`,
      wsBaseUrl: `wss://${environmentId}.example.test`,
    }),
    initialConfig,
    hasSession,
  };
}

const TEST_ENVIRONMENTS = {
  supported: makeEnvironment(
    "environment-supported",
    "Supported environment",
    Effect.succeed(SUPPORTING_CONFIG),
  ),
  missing: makeEnvironment(
    "environment-missing",
    "Missing capability environment",
    Effect.succeed(MISSING_CAPABILITY_CONFIG),
  ),
  disabled: makeEnvironment(
    "environment-disabled",
    "Disabled capability environment",
    Effect.succeed(DISABLED_CAPABILITY_CONFIG),
  ),
  disconnected: makeEnvironment(
    "environment-disconnected",
    "Disconnected environment",
    Effect.succeed(SUPPORTING_CONFIG),
    false,
  ),
  unavailable: makeEnvironment(
    "environment-unavailable",
    "Unavailable configuration environment",
    UNAVAILABLE_CONFIG,
  ),
} as const;

const THREAD_ID = ThreadId.make("thread-shared");

interface DispatchedRequest {
  readonly environmentId: EnvironmentId;
  readonly command: OrchestrationV2Command;
}

const makeSupervisor = Effect.fn("TestHiddenCommands.makeSupervisor")(function* (
  environment: TestEnvironment,
  dispatched: DispatchedRequest[],
) {
  const { target } = environment;
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        dispatched.push({ environmentId: target.environmentId, command });
        return { sequence: dispatched.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: environment.initialConfig,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(
      environment.hasSession ? Option.some(session) : Option.none<RpcSession>(),
    ),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

const makeTestRuntime = Effect.fn("TestHiddenCommands.makeRuntime")(function* (
  dispatched: DispatchedRequest[],
) {
  const supervisors = new Map(
    yield* Effect.forEach(Object.values(TEST_ENVIRONMENTS), (environment) =>
      makeSupervisor(environment, dispatched).pipe(
        Effect.map((supervisor) => [environment.target.environmentId, supervisor] as const),
      ),
    ),
  );
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
    environmentId,
    effect,
  ) => {
    const supervisor = supervisors.get(environmentId);
    return supervisor === undefined
      ? Effect.die(`Unknown test environment: ${environmentId}`)
      : Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  };
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
      TEST_CRYPTO_LAYER,
    ),
  );
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  const snapshotAtom = (_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(null);
  return { atoms: createThreadEnvironmentAtoms(runtime, snapshotAtom), registry };
});

function assertUnavailable<A, E>(
  result: AtomCommandResult<A, E>,
  environmentId: EnvironmentId,
  message: string,
) {
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  const error = Cause.squash(result.cause);
  expect(error).toBeInstanceOf(EnvironmentRpcUnavailableError);
  expect(error).toMatchObject({
    environmentId,
    message: expect.stringContaining(message),
  });
}

describe("hidden thread commands", () => {
  it.effect("gates unsupported targets without sending lifecycle commands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: DispatchedRequest[] = [];
        const { atoms, registry } = yield* makeTestRuntime(dispatched);
        randomBytesCalls = 0;

        const hideResult = yield* Effect.promise(() =>
          atoms.hide.run(registry, {
            environmentId: TEST_ENVIRONMENTS.supported.target.environmentId,
            input: {
              commandId: CommandId.make("hide-command"),
              threadId: THREAD_ID,
            },
          }),
        );
        const unhideResult = yield* Effect.promise(() =>
          atoms.unhide.run(registry, {
            environmentId: TEST_ENVIRONMENTS.supported.target.environmentId,
            input: {
              commandId: CommandId.make("unhide-command"),
              threadId: THREAD_ID,
            },
          }),
        );
        const [
          missingHide,
          missingUnhide,
          disabledHide,
          disabledUnhide,
          disconnectedHide,
          disconnectedUnhide,
          unavailableHide,
          unavailableUnhide,
        ] = yield* Effect.promise(() =>
          Promise.all([
            atoms.hide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.missing.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
            atoms.unhide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.missing.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
            atoms.hide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.disabled.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
            atoms.unhide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.disabled.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
            atoms.hide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.disconnected.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
            atoms.unhide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.disconnected.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
            atoms.hide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.unavailable.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
            atoms.unhide.run(registry, {
              environmentId: TEST_ENVIRONMENTS.unavailable.target.environmentId,
              input: { threadId: THREAD_ID },
            }),
          ]),
        );

        expect(hideResult).toMatchObject({ _tag: "Success", value: { sequence: 1 } });
        expect(unhideResult).toMatchObject({ _tag: "Success", value: { sequence: 2 } });
        assertUnavailable(
          missingHide,
          TEST_ENVIRONMENTS.missing.target.environmentId,
          "Update the server",
        );
        assertUnavailable(
          missingUnhide,
          TEST_ENVIRONMENTS.missing.target.environmentId,
          "Update the server",
        );
        assertUnavailable(
          disabledHide,
          TEST_ENVIRONMENTS.disabled.target.environmentId,
          "Update the server",
        );
        assertUnavailable(
          disabledUnhide,
          TEST_ENVIRONMENTS.disabled.target.environmentId,
          "Update the server",
        );
        assertUnavailable(
          disconnectedHide,
          TEST_ENVIRONMENTS.disconnected.target.environmentId,
          "not connected",
        );
        assertUnavailable(
          disconnectedUnhide,
          TEST_ENVIRONMENTS.disconnected.target.environmentId,
          "not connected",
        );
        assertUnavailable(
          unavailableHide,
          TEST_ENVIRONMENTS.unavailable.target.environmentId,
          "Connect to an updated server",
        );
        assertUnavailable(
          unavailableUnhide,
          TEST_ENVIRONMENTS.unavailable.target.environmentId,
          "Connect to an updated server",
        );
        expect(randomBytesCalls).toBe(0);
        expect(dispatched).toEqual([
          {
            environmentId: "environment-supported",
            command: {
              type: "thread.hide",
              commandId: "hide-command",
              threadId: "thread-shared",
            },
          },
          {
            environmentId: "environment-supported",
            command: {
              type: "thread.unhide",
              commandId: "unhide-command",
              threadId: "thread-shared",
            },
          },
        ]);
        expect(dispatched.map(({ command }) => command.type)).toEqual([
          "thread.hide",
          "thread.unhide",
        ]);
      }),
    ),
  );
});
