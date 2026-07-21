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
import {
  isExpectedClientDispatchError,
  make,
  type OrchestrationCommandDispatcherDependencies,
} from "./OrchestrationCommandDispatcher.ts";

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
    } as unknown as OrchestrationCommandDispatcherDependencies;
    const dispatcher = make(dependencies);
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
