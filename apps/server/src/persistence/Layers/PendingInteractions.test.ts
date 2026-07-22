import { ApprovalRequestId, AuthSessionId, CommandId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { respondToRemotePendingInteraction } from "../../orchestration/PendingInteractionService.ts";
import { PendingInteractionRepository } from "../Services/PendingInteractions.ts";
import { PendingInteractionRepositoryLive } from "./PendingInteractions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  PendingInteractionRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const opened = (threadId: string, requestId: string) => ({
  threadId: ThreadId.make(threadId),
  requestId: ApprovalRequestId.make(requestId),
  kind: "approval" as const,
  status: "pending" as const,
  summary: "Approval requested",
  canApprove: false,
  questions: [],
  responseAction: null,
  responseCommandId: null,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
  resolvedAt: null,
});

layer("PendingInteractionRepository", (it) => {
  it.effect("keys interactions by thread and request and bounds open reads", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionRepository;
      yield* repository.upsertOpened(opened("thread-a", "shared-request"));
      yield* repository.upsertOpened(opened("thread-b", "shared-request"));

      const rows = yield* repository.listOpen();
      assert.strictEqual(rows.length, 2);
      assert.deepStrictEqual(
        rows.map((row) => [row.threadId, row.requestId]),
        [
          ["thread-a", "shared-request"],
          ["thread-b", "shared-request"],
        ],
      );
    }),
  );

  it.effect("applies a thread filter before the global open-read limit", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionRepository;
      for (let index = 0; index < 101; index += 1) {
        yield* repository.upsertOpened(
          opened(`thread-a-${String(index).padStart(3, "0")}`, `request-${index}`),
        );
      }
      const target = opened("thread-z-target", "request-target");
      yield* repository.upsertOpened(target);

      assert.strictEqual((yield* repository.listOpen()).length, 100);
      assert.notInclude(
        (yield* repository.listOpen()).map((row) => row.threadId),
        target.threadId,
      );
      assert.deepStrictEqual(
        (yield* repository.listOpen({ threadId: target.threadId })).map((row) => row.requestId),
        [target.requestId],
      );
    }),
  );

  it.effect("provides session-bound semantic idempotency and accepts dispatch in two phases", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionRepository;
      const row = opened("thread-idempotent", "request-idempotent");
      yield* repository.upsertOpened(row);
      const claimInput = {
        authSessionId: AuthSessionId.make("session-a"),
        idempotencyKey: "retry-a",
        threadId: row.threadId,
        requestId: row.requestId,
        action: "decline" as const,
        semanticHash: "semantic-a",
        commandId: CommandId.make("remote-interaction:command-a"),
        commandCreatedAt: "2026-07-22T00:00:01.000Z",
      };

      const claimed = yield* repository.claimResponse(claimInput);
      assert.strictEqual(claimed._tag, "claimed");
      assert.isFalse(claimed._tag === "claimed" ? claimed.dispatchAccepted : true);
      assert.strictEqual((yield* repository.get(row)).pipe(Option.getOrThrow).status, "pending");

      const replayBeforeAcceptance = yield* repository.claimResponse({
        ...claimInput,
        commandId: CommandId.make("remote-interaction:ignored"),
      });
      assert.strictEqual(replayBeforeAcceptance._tag, "replayed");
      assert.strictEqual(
        replayBeforeAcceptance._tag === "replayed" ? replayBeforeAcceptance.commandId : "",
        claimInput.commandId,
      );
      assert.isFalse(
        replayBeforeAcceptance._tag === "replayed" ? replayBeforeAcceptance.dispatchAccepted : true,
      );

      // The command event and receipt commit atomically before the HTTP path
      // can finalize its ledger row. Correlation by command id makes that
      // crash window safely retryable with the same engine-deduplicated id.
      yield* repository.markResponding({
        threadId: row.threadId,
        requestId: row.requestId,
        action: claimInput.action,
        commandId: claimInput.commandId,
        updatedAt: "2026-07-22T00:00:01.500Z",
      });
      const recoveredReplay = yield* repository.claimResponse(claimInput);
      assert.strictEqual(recoveredReplay._tag, "replayed");
      assert.isFalse(recoveredReplay._tag === "replayed" ? recoveredReplay.dispatchAccepted : true);

      yield* repository.markDispatchAccepted({
        authSessionId: claimInput.authSessionId,
        idempotencyKey: claimInput.idempotencyKey,
        commandId: claimInput.commandId,
        dispatchedAt: "2026-07-22T00:00:02.000Z",
      });
      assert.strictEqual((yield* repository.get(row)).pipe(Option.getOrThrow).status, "responding");

      const replayAfterAcceptance = yield* repository.claimResponse(claimInput);
      assert.strictEqual(replayAfterAcceptance._tag, "replayed");
      assert.isTrue(
        replayAfterAcceptance._tag === "replayed" ? replayAfterAcceptance.dispatchAccepted : false,
      );

      const semanticConflict = yield* repository.claimResponse({
        ...claimInput,
        semanticHash: "different-semantics",
      });
      assert.strictEqual(semanticConflict._tag, "conflict");

      const otherSession = yield* repository.claimResponse({
        ...claimInput,
        authSessionId: AuthSessionId.make("session-b"),
        idempotencyKey: "retry-b",
      });
      assert.strictEqual(otherSession._tag, "unavailable");

      const locallyAnswered = opened("thread-local-race", "request-local-race");
      yield* repository.upsertOpened(locallyAnswered);
      const remoteClaim = {
        ...claimInput,
        idempotencyKey: "retry-local-race",
        threadId: locallyAnswered.threadId,
        requestId: locallyAnswered.requestId,
        commandId: CommandId.make("remote-interaction:unaccepted"),
      };
      yield* repository.claimResponse(remoteClaim);
      yield* repository.markResponding({
        threadId: locallyAnswered.threadId,
        requestId: locallyAnswered.requestId,
        action: "decline",
        commandId: CommandId.make("local-command-won"),
        updatedAt: "2026-07-22T00:00:03.000Z",
      });
      assert.strictEqual((yield* repository.claimResponse(remoteClaim))._tag, "unavailable");
    }),
  );

  it.effect("fails approval closed and never dispatches an accepted idempotent retry twice", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionRepository;
      const row = opened("thread-service", "request-service");
      yield* repository.upsertOpened(row);
      const dispatchCount = yield* Ref.make(0);
      const dispatcher = {
        dispatch: () =>
          Ref.update(dispatchCount, (count) => count + 1).pipe(Effect.as({ sequence: 1 })),
      };

      const unsafeApproval = yield* Effect.exit(
        respondToRemotePendingInteraction({
          authSessionId: AuthSessionId.make("session-service"),
          idempotencyKey: "approve-unsafe",
          threadId: row.threadId,
          requestId: row.requestId,
          action: "approve",
          dispatcher,
        }),
      );
      assert.strictEqual(unsafeApproval._tag, "Failure");
      assert.strictEqual(yield* Ref.get(dispatchCount), 0);

      const request = {
        authSessionId: AuthSessionId.make("session-service"),
        idempotencyKey: "decline-safe",
        threadId: row.threadId,
        requestId: row.requestId,
        action: "decline" as const,
        dispatcher,
      };
      const accepted = yield* respondToRemotePendingInteraction(request);
      const replayed = yield* respondToRemotePendingInteraction(request);

      assert.isFalse(accepted.replayed);
      assert.isTrue(replayed.replayed);
      assert.strictEqual(yield* Ref.get(dispatchCount), 1);
    }),
  );

  it.effect("removes acknowledged and stale interactions from open reads", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionRepository;
      const resolved = opened("thread-resolved", "request-resolved");
      const stale = opened("thread-stale", "request-stale");
      yield* repository.upsertOpened(resolved);
      yield* repository.upsertOpened(stale);
      yield* repository.resolve({
        threadId: resolved.threadId,
        requestId: resolved.requestId,
        updatedAt: "2026-07-22T00:00:03.000Z",
      });
      yield* repository.markThreadStale({
        threadId: stale.threadId,
        updatedAt: "2026-07-22T00:00:04.000Z",
      });

      const openKeys = (yield* repository.listOpen()).map(
        (row) => `${row.threadId}:${row.requestId}`,
      );
      assert.notInclude(openKeys, "thread-resolved:request-resolved");
      assert.notInclude(openKeys, "thread-stale:request-stale");
      assert.strictEqual(
        (yield* repository.get(resolved)).pipe(Option.getOrThrow).status,
        "resolved",
      );
      assert.strictEqual((yield* repository.get(stale)).pipe(Option.getOrThrow).status, "stale");
    }),
  );

  it.effect("marks stale acknowledgements by correlated thread and request only", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionRepository;
      const stale = opened("thread-shared", "request-stale");
      const stillPending = opened("thread-shared", "request-still-pending");
      yield* repository.upsertOpened(stale);
      yield* repository.upsertOpened(stillPending);

      yield* repository.markStale({
        threadId: stale.threadId,
        requestId: stale.requestId,
        updatedAt: "2026-07-22T00:00:05.000Z",
      });

      assert.strictEqual((yield* repository.get(stale)).pipe(Option.getOrThrow).status, "stale");
      assert.strictEqual(
        (yield* repository.get(stillPending)).pipe(Option.getOrThrow).status,
        "pending",
      );
    }),
  );
});
