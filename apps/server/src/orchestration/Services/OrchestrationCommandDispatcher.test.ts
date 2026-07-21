import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { isExpectedClientDispatchError, make } from "./OrchestrationCommandDispatcher.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as OrchestrationEngine from "./OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./ProjectionSnapshotQuery.ts";

const makeTestDispatcher = (dependencies: {
  readonly crypto: Crypto.Crypto;
  readonly orchestrationEngine: unknown;
  readonly projectionSnapshotQuery?: unknown;
  readonly gitWorkflow: unknown;
  readonly projectSetupScriptRunner: unknown;
  readonly startup: unknown;
  readonly terminalManager?: unknown;
  readonly vcsStatusBroadcaster: unknown;
}) =>
  make.pipe(
    Effect.provideService(Crypto.Crypto, dependencies.crypto),
    Effect.provideService(
      OrchestrationEngine.OrchestrationEngineService,
      dependencies.orchestrationEngine as never,
    ),
    Effect.provideService(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      (dependencies.projectionSnapshotQuery ?? {
        getProjectShellById: (projectId: ProjectId) =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Test project",
              workspaceRoot: "/tmp/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
          ),
        getThreadShellById: () => Effect.succeed(Option.none()),
      }) as never,
    ),
    Effect.provideService(GitWorkflowService.GitWorkflowService, dependencies.gitWorkflow as never),
    Effect.provideService(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
      dependencies.projectSetupScriptRunner as never,
    ),
    Effect.provideService(ServerRuntimeStartup.ServerRuntimeStartup, dependencies.startup as never),
    Effect.provideService(
      TerminalManager.TerminalManager,
      (dependencies.terminalManager ?? { close: () => Effect.void }) as never,
    ),
    Effect.provideService(
      VcsStatusBroadcaster.VcsStatusBroadcaster,
      dependencies.vcsStatusBroadcaster as never,
    ),
  );

describe("OrchestrationCommandDispatcher error classification", () => {
  it("classifies cause-free domain invariants as expected client errors", () => {
    const invariant = new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "Thread does not exist.",
    });

    expect(
      isExpectedClientDispatchError(
        new OrchestrationDispatchCommandError({
          message: invariant.message,
          cause: invariant,
        }),
      ),
    ).toBe(true);
  });

  it("keeps infrastructure failures wrapped as invariants in the internal-error category", () => {
    const invariant = new OrchestrationCommandInvariantError({
      commandType: "thread.turn.start",
      detail: "Failed to generate an event identifier.",
      cause: new Error("crypto unavailable"),
    });

    expect(
      isExpectedClientDispatchError(
        new OrchestrationDispatchCommandError({
          message: invariant.message,
          cause: invariant,
        }),
      ),
    ).toBe(false);
  });
});

effectIt.effect("rejects a bootstrap project cwd outside the registered project", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const projectId = ProjectId.make("project-path-boundary");
    let dispatched = false;
    let gitInvoked = false;
    const dispatcher = yield* makeTestDispatcher({
      crypto,
      orchestrationEngine: {
        dispatch: () => {
          dispatched = true;
          return Effect.succeed({ sequence: 1 });
        },
        getCommandReceipt: () => Effect.succeed(Option.none()),
        withBootstrapDispatchLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      },
      projectionSnapshotQuery: {
        getProjectShellById: () =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Registered project",
              workspaceRoot: "/srv/registered-project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
          ),
      },
      gitWorkflow: {
        createWorktree: () => {
          gitInvoked = true;
          return Effect.die("unexpected Git operation");
        },
      },
      projectSetupScriptRunner: {},
      startup: {
        enqueueCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      },
      vcsStatusBroadcaster: {},
    });
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };
    const error = yield* dispatcher
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-path-boundary"),
        threadId: ThreadId.make("thread-path-boundary"),
        message: {
          messageId: MessageId.make("msg-path-boundary"),
          role: "user",
          text: "do not escape",
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId,
            title: "Path boundary",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          prepareWorktree: {
            projectCwd: "/srv/unrelated-repository",
            baseBranch: "main",
            branch: "feat/path-boundary",
          },
          runSetupScript: true,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .pipe(Effect.flip);

    expect(isExpectedClientDispatchError(error)).toBe(true);
    expect(error.message).toContain("does not match the registered project");
    expect(dispatched).toBe(false);
    expect(gitInvoked).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("compensates an interrupted bootstrap after worktree creation", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const metaUpdateStarted = yield* Deferred.make<void>();
    const effects: string[] = [];
    const dispatchedCommands: OrchestrationCommand[] = [];
    const dependencies = {
      crypto,
      orchestrationEngine: {
        readEvents: () => {
          throw new Error("unused");
        },
        dispatch: (command: OrchestrationCommand) => {
          dispatchedCommands.push(command);
          effects.push(`dispatch.${command.type}`);
          if (command.type === "thread.meta.update") {
            return Deferred.succeed(metaUpdateStarted, undefined).pipe(
              Effect.andThen(Effect.never),
            );
          }
          return Effect.succeed({ sequence: dispatchedCommands.length });
        },
        getCommandReceipt: () => Effect.succeed(Option.none()),
        withBootstrapDispatchLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        streamDomainEvents: null,
      },
      gitWorkflow: {
        createWorktree: () =>
          Effect.sync(() => {
            effects.push("worktree.create");
            return {
              worktree: {
                refName: "t3code/interrupted-bootstrap",
                path: "/tmp/interrupted-bootstrap",
              },
            };
          }),
        removeWorktree: () =>
          Effect.sync(() => {
            effects.push("worktree.remove");
          }),
        deleteBranch: () =>
          Effect.sync(() => {
            effects.push("branch.delete");
          }),
      },
      projectSetupScriptRunner: {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
      startup: {
        enqueueCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      },
      vcsStatusBroadcaster: {
        refreshStatus: () => Effect.void,
      },
    };
    const dispatcher = yield* makeTestDispatcher(dependencies);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };
    const dispatchFiber = yield* dispatcher
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-interrupted-bootstrap"),
        threadId: ThreadId.make("thread-interrupted-bootstrap"),
        message: {
          messageId: MessageId.make("msg-interrupted-bootstrap"),
          role: "user",
          text: "interrupt after worktree creation",
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-interrupted-bootstrap"),
            title: "Interrupted Bootstrap",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt,
          },
          prepareWorktree: {
            projectCwd: "/tmp/project",
            baseBranch: "main",
            branch: "t3code/interrupted-bootstrap",
          },
          runSetupScript: false,
        },
        createdAt,
      })
      .pipe(Effect.forkChild);

    yield* Deferred.await(metaUpdateStarted);
    yield* Fiber.interrupt(dispatchFiber);
    const exit = yield* Fiber.await(dispatchFiber);

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(effects).toEqual([
      "dispatch.thread.create",
      "worktree.create",
      "dispatch.thread.meta.update",
      "worktree.remove",
      "branch.delete",
      "dispatch.thread.delete",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("closes launched setup before rolling back a rejected final turn", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const effects: string[] = [];
    let setupLaunches = 0;
    const dispatcher = yield* makeTestDispatcher({
      crypto,
      orchestrationEngine: {
        dispatch: (command: OrchestrationCommand) => {
          effects.push(`dispatch.${command.type}`);
          return command.type === "thread.turn.start"
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "final dispatch rejected",
                }),
              )
            : Effect.succeed({ sequence: effects.length });
        },
        getCommandReceipt: () => Effect.succeed(Option.none()),
        withBootstrapDispatchLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      },
      gitWorkflow: {
        createWorktree: () =>
          Effect.sync(() => {
            effects.push("worktree.create");
            return {
              worktree: { refName: "feat/setup-order", path: "/tmp/setup-order" },
            };
          }),
        removeWorktree: () =>
          Effect.sync(() => {
            effects.push("worktree.remove");
          }),
        deleteBranch: () =>
          Effect.sync(() => {
            effects.push("branch.delete");
          }),
      },
      projectSetupScriptRunner: {
        runForThread: () =>
          Effect.sync(() => {
            setupLaunches += 1;
            effects.push("setup.start");
            return {
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-setup",
              cwd: "/tmp/setup-order",
            };
          }),
      },
      startup: {
        enqueueCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      },
      terminalManager: {
        close: () =>
          Effect.sync(() => {
            effects.push("setup.close");
          }),
      },
      vcsStatusBroadcaster: { refreshStatus: () => Effect.void },
    });
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };

    yield* dispatcher
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-setup-order"),
        threadId: ThreadId.make("thread-setup-order"),
        message: {
          messageId: MessageId.make("msg-setup-order"),
          role: "user",
          text: "setup after acceptance",
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-setup-order"),
            title: "Setup order",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          prepareWorktree: {
            projectCwd: "/tmp/project",
            baseBranch: "main",
            branch: "feat/setup-order",
          },
          runSetupScript: true,
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      })
      .pipe(Effect.flip);

    expect(setupLaunches).toBe(1);
    expect(effects).toEqual([
      "dispatch.thread.create",
      "worktree.create",
      "dispatch.thread.meta.update",
      "setup.start",
      "dispatch.thread.activity.append",
      "dispatch.thread.activity.append",
      "dispatch.thread.turn.start",
      "setup.close",
      "worktree.remove",
      "branch.delete",
      "dispatch.thread.delete",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

effectIt.effect("does not compensate after an interrupted final command is accepted", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const finalDispatchStarted = yield* Deferred.make<void>();
    const allowFinalCommit = yield* Deferred.make<void>();
    const effects: string[] = [];
    const commandId = CommandId.make("cmd-interrupted-final-bootstrap");
    const threadId = ThreadId.make("thread-interrupted-final-bootstrap");
    const createdAt = "2026-01-01T00:00:00.000Z";
    let acceptedSequence: number | null = null;
    const dependencies = {
      crypto,
      orchestrationEngine: {
        readEvents: () => {
          throw new Error("unused");
        },
        dispatch: (command: OrchestrationCommand) => {
          effects.push(`dispatch.${command.type}`);
          if (command.type === "thread.turn.start") {
            return Deferred.succeed(finalDispatchStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowFinalCommit)),
              Effect.andThen(
                Effect.sync(() => {
                  acceptedSequence = 3;
                  return { sequence: acceptedSequence };
                }),
              ),
            );
          }
          return Effect.succeed({ sequence: effects.length });
        },
        getCommandReceipt: (candidateCommandId: CommandId) =>
          Effect.sync(() =>
            candidateCommandId === commandId && acceptedSequence !== null
              ? Option.some({
                  commandId,
                  aggregateKind: "thread" as const,
                  aggregateId: threadId,
                  acceptedAt: createdAt,
                  resultSequence: acceptedSequence,
                  status: "accepted" as const,
                  error: null,
                })
              : Option.none(),
          ),
        withBootstrapDispatchLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
        streamDomainEvents: null,
      },
      gitWorkflow: {
        createWorktree: () =>
          Effect.sync(() => {
            effects.push("worktree.create");
            return {
              worktree: {
                refName: "t3code/interrupted-final-bootstrap",
                path: "/tmp/interrupted-final-bootstrap",
              },
            };
          }),
        removeWorktree: () =>
          Effect.sync(() => {
            effects.push("worktree.remove");
          }),
        deleteBranch: () =>
          Effect.sync(() => {
            effects.push("branch.delete");
          }),
      },
      projectSetupScriptRunner: {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
      startup: {
        enqueueCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      },
      vcsStatusBroadcaster: {
        refreshStatus: () => Effect.void,
      },
    };
    const dispatcher = yield* makeTestDispatcher(dependencies);
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    };
    const command = {
      type: "thread.turn.start",
      commandId,
      threadId,
      message: {
        messageId: MessageId.make("msg-interrupted-final-bootstrap"),
        role: "user",
        text: "interrupt after final command enqueue",
        attachments: [],
      },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-interrupted-final-bootstrap"),
          title: "Interrupted Final Bootstrap",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          createdAt,
        },
        prepareWorktree: {
          projectCwd: "/tmp/project",
          baseBranch: "main",
          branch: "t3code/interrupted-final-bootstrap",
        },
        runSetupScript: false,
      },
      createdAt,
    } as const;
    const dispatchFiber = yield* dispatcher.dispatch(command).pipe(Effect.forkChild);

    yield* Deferred.await(finalDispatchStarted);
    const interruptFiber = yield* Fiber.interrupt(dispatchFiber).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(allowFinalCommit, undefined);
    yield* Fiber.await(interruptFiber);
    const exit = yield* Fiber.await(dispatchFiber);

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(acceptedSequence).toBe(3);
    expect(effects).toEqual([
      "dispatch.thread.create",
      "worktree.create",
      "dispatch.thread.meta.update",
      "dispatch.thread.turn.start",
    ]);

    const retry = yield* dispatcher.dispatch(command);
    expect(retry.sequence).toBe(3);
    expect(effects).toEqual([
      "dispatch.thread.create",
      "worktree.create",
      "dispatch.thread.meta.update",
      "dispatch.thread.turn.start",
    ]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
