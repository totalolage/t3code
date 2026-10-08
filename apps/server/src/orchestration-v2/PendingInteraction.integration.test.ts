// @effect-diagnostics nodeBuiltinImport:off
import {
  AuthSessionId,
  RemoteInteractionRequestId,
  RuntimeRequestId,
  ThreadId,
  type IsoDateTime,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { layerFromPath } from "../persistence/Sqlite.ts";
import { PendingInteractionResponseRepositoryLive } from "../persistence/PendingInteractionResponses.ts";
import {
  PendingInteractionResponseRepository,
  type InteractionRecord,
} from "../persistence/Services/PendingInteractionResponses.ts";
import { OrchestratorDispatchError, OrchestratorV2 } from "./Orchestrator.ts";
import {
  PendingInteractionQuery,
  type NativePendingInteraction,
} from "./PendingInteractionQuery.ts";
import {
  PendingInteractionService,
  PendingInteractionServiceLive,
} from "./PendingInteractionService.ts";

const NOW = "2026-09-12T00:00:00.000Z" as IsoDateTime;
const threadId = ThreadId.make("pending-durable-thread");
const runtimeRequestId = RuntimeRequestId.make("pending-durable-request");
const remoteRequestId = RemoteInteractionRequestId.make(runtimeRequestId);

const interaction: InteractionRecord = {
  threadId,
  requestId: runtimeRequestId,
  kind: "user-input",
  status: "pending",
  summary: "User input requested",
  canApprove: false,
  questions: [
    {
      id: "environment",
      providerQuestionId: "private-provider-question",
      header: "Environment",
      prompt: "Which environment should be used?",
      options: [
        {
          label: "Private",
          description: "Use the configured environment.",
          providerValue: "/private/environment",
        },
      ],
      multiSelect: false,
      allowsCustomAnswer: false,
    },
  ],
  responseAction: null,
  responseCommandId: null,
  createdAt: NOW,
  updatedAt: NOW,
  resolvedAt: null,
};

const nativeCandidate: NativePendingInteraction = {
  interaction,
  responseMode: "message",
};

const answerInput = {
  authSessionId: AuthSessionId.make("pending-durable-auth-session"),
  threadId,
  requestId: remoteRequestId,
  idempotencyKey: "pending-durable-idempotency-key",
  action: "answer" as const,
  answers: [{ questionId: "environment", values: ["Private"] }],
};

const makeServiceLayer = (
  databasePath: string,
  calls: { list: number; get: number },
  commands: OrchestrationV2ServerCommand[],
  failDispatch: boolean,
) => {
  const queryLayer = Layer.succeed(PendingInteractionQuery, {
    list: (input) =>
      Effect.sync(() => {
        calls.list += 1;
        return input.threadId === undefined || input.threadId === threadId ? [nativeCandidate] : [];
      }),
    get: (input) =>
      Effect.sync(() => {
        calls.get += 1;
        return input.threadId === threadId && input.requestId === remoteRequestId
          ? Option.some(nativeCandidate)
          : Option.none();
      }),
  });
  const orchestratorLayer = Layer.mock(OrchestratorV2)({
    dispatch: (command) => {
      commands.push(command);
      if (failDispatch) {
        return Effect.fail(
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
          }),
        );
      }
      return Effect.succeed({ sequence: commands.length, storedEvents: [] });
    },
  });
  return PendingInteractionServiceLive.pipe(
    Layer.provideMerge(PendingInteractionResponseRepositoryLive),
    Layer.provide(queryLayer),
    Layer.provide(orchestratorLayer),
    Layer.provideMerge(layerFromPath(databasePath)),
    Layer.provideMerge(NodeServices.layer),
  );
};

const withDatabase = <A, E, R>(effect: (databasePath: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-pending-interaction-native-")),
      ),
      (directory) =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
    ).pipe(Effect.flatMap((directory) => effect(NodePath.join(directory, "state.sqlite")))),
  );

it.effect("persists accepted native response intent and replays it after reopening", () =>
  withDatabase((databasePath) => {
    const calls = { list: 0, get: 0 };
    const commands: OrchestrationV2ServerCommand[] = [];

    return Effect.gen(function* () {
      const first = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        const repository = yield* PendingInteractionResponseRepository;
        const result = yield* service.respond(answerInput);
        const stored = yield* repository.getByKey({
          authSessionId: answerInput.authSessionId,
          idempotencyKey: answerInput.idempotencyKey,
        });
        return { result, stored };
      }).pipe(Effect.provide(makeServiceLayer(databasePath, calls, commands, false)));

      assert.isFalse(first.result.replayed);
      assert.isTrue(Option.isSome(first.stored));
      if (Option.isSome(first.stored)) {
        assert.isNotNull(first.stored.value.dispatchedAt);
      }
      assert.equal(commands.length, 1);
      assert.equal(commands[0]?.type, "runtime-request.respond");
      if (commands[0]?.type === "runtime-request.respond") {
        assert.deepStrictEqual(commands[0].answers, {
          "private-provider-question": "/private/environment",
        });
      }

      const replay = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* service.respond(answerInput);
      }).pipe(Effect.provide(makeServiceLayer(databasePath, calls, commands, false)));

      assert.isTrue(replay.replayed);
      assert.equal(commands.length, 1);
      assert.equal(calls.get, 1);
    });
  }),
);

it.effect("keeps an uncertain durable claim unavailable after dispatch failure", () =>
  withDatabase((databasePath) => {
    const calls = { list: 0, get: 0 };
    const commands: OrchestrationV2ServerCommand[] = [];

    return Effect.gen(function* () {
      const firstError = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* service.respond(answerInput).pipe(Effect.flip);
      }).pipe(Effect.provide(makeServiceLayer(databasePath, calls, commands, true)));
      assert.equal(firstError._tag, "OrchestratorDispatchError");
      assert.equal(commands.length, 1);

      const retryError = yield* Effect.gen(function* () {
        const service = yield* PendingInteractionService;
        return yield* service.respond(answerInput).pipe(Effect.flip);
      }).pipe(Effect.provide(makeServiceLayer(databasePath, calls, commands, false)));

      assert.equal(retryError._tag, "PendingInteractionUnavailableError");
      assert.equal(commands.length, 1);
      assert.equal(calls.get, 1);
    });
  }),
);
