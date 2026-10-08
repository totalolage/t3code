// @effect-diagnostics nodeBuiltinImport:off
import {
  AuthSessionId,
  CommandId,
  RuntimeRequestId,
  ThreadId,
  type IsoDateTime,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlClient as SqlClientService } from "effect/sql/SqlClient";

import {
  PendingInteractionResponseRepository,
  type InteractionRecord as InteractionRecordType,
  type ResponseRecord as ResponseRecordType,
} from "./Services/PendingInteractionResponses.ts";
import { PendingInteractionResponseRepositoryLive } from "./PendingInteractionResponses.ts";
import { layerMemory, layerFromPath } from "./Sqlite.ts";

const layer = it.layer(
  PendingInteractionResponseRepositoryLive.pipe(
    Layer.provideMerge(layerMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const initialTimestamp: IsoDateTime = "2026-07-22T00:00:00.000Z";

const countLedgerRows = (sql: SqlClientService) =>
  Effect.all({
    interactions: sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM pending_interactions
    `,
    responses: sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM pending_interaction_responses
    `,
  });

const makeInteraction = (key: string): InteractionRecordType => ({
  threadId: ThreadId.make(`thread-${key}`),
  requestId: RuntimeRequestId.make(`request-${key}`),
  kind: "user-input",
  status: "pending",
  summary: `Input requested for ${key}`,
  canApprove: false,
  questions: [
    {
      id: `question-${key}`,
      providerQuestionId: `Which provider value should ${key} use?`,
      header: "Choose",
      prompt: `Choose a value for ${key}`,
      options: [
        {
          label: "Private",
          description: "Use the private provider value.",
          providerValue: `/private/${key}`,
        },
        {
          label: "Public",
          description: "Use the public provider value.",
          providerValue: `/public/${key}`,
        },
      ],
      multiSelect: false,
      allowsCustomAnswer: false,
    },
  ],
  responseAction: null,
  responseCommandId: null,
  createdAt: initialTimestamp,
  updatedAt: initialTimestamp,
  resolvedAt: null,
});

const makeResponse = (
  interaction: InteractionRecordType,
  key: string,
  overrides: Partial<ResponseRecordType> = {},
): ResponseRecordType => ({
  authSessionId: AuthSessionId.make(`session-${key}`),
  idempotencyKey: `retry-${key}`,
  threadId: interaction.threadId,
  requestId: interaction.requestId,
  action: "answer",
  semanticHash: `hash-${key}`,
  commandId: CommandId.make(`command-${key}`),
  commandCreatedAt: initialTimestamp,
  dispatchedAt: null,
  ...overrides,
});

layer("PendingInteractionResponseRepository", (it) => {
  it.effect("claims immutable snapshots and returns the same response for a replay", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionResponseRepository;
      const interaction = makeInteraction("replay");
      const response = makeResponse(interaction, "replay");

      assert.deepStrictEqual(yield* repository.claim({ interaction, response }), {
        _tag: "Acquired",
        response,
      });

      const replay = {
        ...response,
        commandId: CommandId.make("command-replay-ignored"),
        commandCreatedAt: "2026-07-22T00:00:01.000Z",
      };
      const replayed = yield* repository.claim({
        interaction: { ...interaction, summary: "This snapshot must be ignored" },
        response: replay,
      });

      assert.deepStrictEqual(replayed, { _tag: "Existing", response });
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          }),
        ),
        interaction,
      );
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getByKey({
            authSessionId: response.authSessionId,
            idempotencyKey: response.idempotencyKey,
          }),
        ),
        response,
      );
    }),
  );

  it.effect("keeps idempotency keys and interaction ownership opaque on conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionResponseRepository;
      const interaction = makeInteraction("conflict");
      const response = makeResponse(interaction, "conflict");
      yield* repository.claim({ interaction, response });

      const changedHash = yield* repository.claim({
        interaction,
        response: { ...response, semanticHash: "hash-changed" },
      });
      assert.deepStrictEqual(changedHash, { _tag: "Conflict" });

      const changedThread = makeInteraction("conflict-other-thread");
      const changedThreadResponse = {
        ...response,
        threadId: changedThread.threadId,
        requestId: changedThread.requestId,
        commandId: CommandId.make("command-conflict-other-thread"),
      };
      const changedThreadResult = yield* repository.claim({
        interaction: changedThread,
        response: changedThreadResponse,
      });
      assert.deepStrictEqual(changedThreadResult, { _tag: "Conflict" });

      const otherSessionResponse = {
        ...response,
        authSessionId: AuthSessionId.make("session-conflict-other"),
        idempotencyKey: "retry-conflict-other",
        commandId: CommandId.make("command-conflict-other"),
      };
      const otherSessionResult = yield* repository.claim({
        interaction,
        response: otherSessionResponse,
      });
      assert.deepStrictEqual(otherSessionResult, { _tag: "Conflict" });
      assert.isTrue(
        Option.isNone(
          yield* repository.getByKey({
            authSessionId: otherSessionResponse.authSessionId,
            idempotencyKey: otherSessionResponse.idempotencyKey,
          }),
        ),
      );

      const commandConflictInteraction = makeInteraction("command-conflict");
      const commandConflictResponse = makeResponse(commandConflictInteraction, "command-conflict", {
        commandId: response.commandId,
      });
      assert.deepStrictEqual(
        yield* repository.claim({
          interaction: commandConflictInteraction,
          response: commandConflictResponse,
        }),
        { _tag: "Conflict" },
      );
      assert.isTrue(
        Option.isNone(
          yield* repository.getInteraction({
            threadId: commandConflictInteraction.threadId,
            requestId: commandConflictInteraction.requestId,
          }),
        ),
      );

      const sql = yield* SqlClient.SqlClient;
      const snapshots = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM pending_interactions
        WHERE thread_id = ${interaction.threadId}
          AND request_id = ${interaction.requestId}
      `;
      const responses = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM pending_interaction_responses
        WHERE thread_id = ${interaction.threadId}
          AND request_id = ${interaction.requestId}
      `;
      assert.deepStrictEqual(snapshots, [{ count: 1 }]);
      assert.deepStrictEqual(responses, [{ count: 1 }]);
    }),
  );

  it.effect("serializes simultaneous claims for one interaction", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionResponseRepository;
      const interaction = makeInteraction("simultaneous");
      const responses = [
        makeResponse(interaction, "simultaneous-a"),
        makeResponse(interaction, "simultaneous-b"),
      ];

      const outcomes = yield* Effect.forEach(
        responses,
        (response) => repository.claim({ interaction, response }),
        { concurrency: 2 },
      );

      assert.deepStrictEqual(outcomes.map(({ _tag }) => _tag).sort(), ["Acquired", "Conflict"]);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM pending_interaction_responses
        WHERE thread_id = ${interaction.threadId}
          AND request_id = ${interaction.requestId}
      `;
      assert.deepStrictEqual(rows, [{ count: 1 }]);
    }),
  );

  it.effect("rejects a new claim whose response IDs do not match its snapshot", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionResponseRepository;
      const sql = yield* SqlClient.SqlClient;
      const interaction = makeInteraction("mismatched-ids");
      const responseInteraction = makeInteraction("mismatched-response-ids");
      const response = {
        ...makeResponse(interaction, "mismatched-ids"),
        threadId: responseInteraction.threadId,
        requestId: responseInteraction.requestId,
      };
      const before = yield* countLedgerRows(sql);

      assert.deepStrictEqual(yield* repository.claim({ interaction, response }), {
        _tag: "Conflict",
      });
      assert.isTrue(
        Option.isNone(
          yield* repository.getInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          }),
        ),
      );
      assert.deepStrictEqual(
        yield* repository.getByKey({
          authSessionId: response.authSessionId,
          idempotencyKey: response.idempotencyKey,
        }),
        Option.none(),
      );
      assert.deepStrictEqual(yield* countLedgerRows(sql), before);
    }),
  );

  it.effect("rejects a new claim for a non-pending snapshot", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionResponseRepository;
      const sql = yield* SqlClient.SqlClient;
      const interaction = { ...makeInteraction("non-pending"), status: "responding" as const };
      const response = makeResponse(interaction, "non-pending");
      const before = yield* countLedgerRows(sql);

      assert.deepStrictEqual(yield* repository.claim({ interaction, response }), {
        _tag: "Conflict",
      });
      assert.isTrue(
        Option.isNone(
          yield* repository.getInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          }),
        ),
      );
      assert.deepStrictEqual(
        yield* repository.getByKey({
          authSessionId: response.authSessionId,
          idempotencyKey: response.idempotencyKey,
        }),
        Option.none(),
      );
      assert.deepStrictEqual(yield* countLedgerRows(sql), before);
    }),
  );

  it.effect("rejects a new claim with caller-supplied dispatch evidence", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionResponseRepository;
      const sql = yield* SqlClient.SqlClient;
      const interaction = makeInteraction("pre-dispatched");
      const response = makeResponse(interaction, "pre-dispatched", {
        dispatchedAt: "2026-07-22T00:00:09.000Z",
      });
      const before = yield* countLedgerRows(sql);

      assert.deepStrictEqual(yield* repository.claim({ interaction, response }), {
        _tag: "Conflict",
      });
      assert.isTrue(
        Option.isNone(
          yield* repository.getInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          }),
        ),
      );
      assert.deepStrictEqual(
        yield* repository.getByKey({
          authSessionId: response.authSessionId,
          idempotencyKey: response.idempotencyKey,
        }),
        Option.none(),
      );
      assert.deepStrictEqual(yield* countLedgerRows(sql), before);
    }),
  );

  it.effect("marks only the matching command as dispatched and never infers answered", () =>
    Effect.gen(function* () {
      const repository = yield* PendingInteractionResponseRepository;
      const interaction = makeInteraction("dispatch");
      const response = makeResponse(interaction, "dispatch");
      yield* repository.claim({ interaction, response });

      yield* repository.markDispatched({
        authSessionId: AuthSessionId.make("session-wrong"),
        idempotencyKey: response.idempotencyKey,
        commandId: response.commandId,
        dispatchedAt: "2026-07-22T00:00:01.000Z",
      });
      yield* repository.markDispatched({
        authSessionId: response.authSessionId,
        idempotencyKey: response.idempotencyKey,
        commandId: CommandId.make("command-wrong"),
        dispatchedAt: "2026-07-22T00:00:01.500Z",
      });
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getByKey({
            authSessionId: response.authSessionId,
            idempotencyKey: response.idempotencyKey,
          }),
        ),
        response,
      );
      assert.strictEqual(
        Option.getOrThrow(
          yield* repository.getInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          }),
        ).status,
        "pending",
      );

      const firstDispatchAt = "2026-07-22T00:00:02.000Z";
      yield* repository.markDispatched({
        authSessionId: response.authSessionId,
        idempotencyKey: response.idempotencyKey,
        commandId: response.commandId,
        dispatchedAt: firstDispatchAt,
      });
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getByKey({
            authSessionId: response.authSessionId,
            idempotencyKey: response.idempotencyKey,
          }),
        ),
        { ...response, dispatchedAt: firstDispatchAt },
      );
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          }),
        ),
        {
          ...interaction,
          status: "responding",
          responseAction: "answer",
          responseCommandId: response.commandId,
          updatedAt: firstDispatchAt,
        },
      );

      yield* repository.markDispatched({
        authSessionId: response.authSessionId,
        idempotencyKey: response.idempotencyKey,
        commandId: response.commandId,
        dispatchedAt: "2026-07-22T00:00:03.000Z",
      });
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getByKey({
            authSessionId: response.authSessionId,
            idempotencyKey: response.idempotencyKey,
          }),
        ).dispatchedAt,
        firstDispatchAt,
      );
      assert.deepStrictEqual(
        Option.getOrThrow(
          yield* repository.getInteraction({
            threadId: interaction.threadId,
            requestId: interaction.requestId,
          }),
        ).status,
        "responding",
      );
    }),
  );

  it.effect(
    "imports literal F rows without writes and preserves provider normalization fields",
    () =>
      Effect.gen(function* () {
        const repository = yield* PendingInteractionResponseRepository;
        const sql = yield* SqlClient.SqlClient;
        const questionsJson =
          '[{"id":"import-choice","providerQuestionId":"Which private choice should be used?","header":"Choose","prompt":"Continue?","options":[{"label":"Continue","description":"Continue the turn","providerValue":"/home/alice/private-choice"},{"label":"Stop","description":"Stop the turn"}],"multiSelect":false,"allowsCustomAnswer":false}]';

        yield* sql`
        INSERT INTO pending_interactions (
          thread_id, request_id, kind, status, summary, can_approve,
          questions_json, response_action, response_command_id,
          created_at, updated_at, resolved_at
        ) VALUES (
          'thread-imported', 'request-imported', 'user-input', 'responding',
          'Imported user input', 1, ${questionsJson}, 'answer',
          'command-imported', '2026-07-21T00:00:00.000Z',
          '2026-07-21T00:00:01.000Z', NULL
        )
      `;
        yield* sql`
        INSERT INTO pending_interaction_responses (
          auth_session_id, idempotency_key, thread_id, request_id,
          action, semantic_hash, command_id, command_created_at, dispatched_at
        ) VALUES (
          'session-imported', 'imported-key', 'thread-imported', 'request-imported',
          'answer', 'legacy-normalized-hash', 'command-imported-response',
          '2026-07-21T00:00:02.000Z', NULL
        )
      `;

        const before = yield* sql<{ readonly interactions: number; readonly responses: number }>`
        SELECT
          (SELECT COUNT(*) FROM pending_interactions) AS interactions,
          (SELECT COUNT(*) FROM pending_interaction_responses) AS responses
      `;
        const importedInteraction = Option.getOrThrow(
          yield* repository.getInteraction({
            threadId: ThreadId.make("thread-imported"),
            requestId: RuntimeRequestId.make("request-imported"),
          }),
        );
        const importedResponse = Option.getOrThrow(
          yield* repository.getByKey({
            authSessionId: AuthSessionId.make("session-imported"),
            idempotencyKey: "imported-key",
          }),
        );
        const after = yield* sql<{ readonly interactions: number; readonly responses: number }>`
        SELECT
          (SELECT COUNT(*) FROM pending_interactions) AS interactions,
          (SELECT COUNT(*) FROM pending_interaction_responses) AS responses
      `;

        assert.deepStrictEqual(importedInteraction, {
          threadId: ThreadId.make("thread-imported"),
          requestId: RuntimeRequestId.make("request-imported"),
          kind: "user-input",
          status: "responding",
          summary: "Imported user input",
          canApprove: true,
          questions: [
            {
              id: "import-choice",
              providerQuestionId: "Which private choice should be used?",
              header: "Choose",
              prompt: "Continue?",
              options: [
                {
                  label: "Continue",
                  description: "Continue the turn",
                  providerValue: "/home/alice/private-choice",
                },
                { label: "Stop", description: "Stop the turn" },
              ],
              multiSelect: false,
              allowsCustomAnswer: false,
            },
          ],
          responseAction: "answer",
          responseCommandId: CommandId.make("command-imported"),
          createdAt: "2026-07-21T00:00:00.000Z",
          updatedAt: "2026-07-21T00:00:01.000Z",
          resolvedAt: null,
        });
        assert.deepStrictEqual(importedResponse, {
          authSessionId: AuthSessionId.make("session-imported"),
          idempotencyKey: "imported-key",
          threadId: ThreadId.make("thread-imported"),
          requestId: RuntimeRequestId.make("request-imported"),
          action: "answer",
          semanticHash: "legacy-normalized-hash",
          commandId: CommandId.make("command-imported-response"),
          commandCreatedAt: "2026-07-21T00:00:02.000Z",
          dispatchedAt: null,
        });
        assert.deepStrictEqual(after, before);
      }),
  );
});

it.effect("reopens a database with null and dispatched ledger timestamps intact", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pending-response-"));
  const databasePath = NodePath.join(tempDir, "state.sqlite");
  const nullInteraction = {
    ...makeInteraction("reopen-null"),
    responseAction: "decline" as const,
    responseCommandId: CommandId.make("snapshot-command-null"),
    resolvedAt: "2026-07-22T00:00:04.000Z",
  };
  const nullResponse = makeResponse(nullInteraction, "reopen-null", {
    action: "decline",
    semanticHash: "hash-reopen-null",
    commandCreatedAt: "2026-07-22T00:00:05.000Z",
    dispatchedAt: null,
  });
  const dispatchedInteraction = makeInteraction("reopen-dispatched");
  const dispatchedResponse = makeResponse(dispatchedInteraction, "reopen-dispatched", {
    action: "approve",
    semanticHash: "hash-reopen-dispatched",
    commandCreatedAt: "2026-07-22T00:00:07.000Z",
    dispatchedAt: null,
  });
  const dispatchedAt = "2026-07-22T00:00:08.000Z" as IsoDateTime;
  const dispatchedInteractionAfterDispatch = {
    ...dispatchedInteraction,
    status: "responding" as const,
    responseAction: dispatchedResponse.action,
    responseCommandId: dispatchedResponse.commandId,
    updatedAt: dispatchedAt,
  };
  const dispatchedResponseAfterDispatch = { ...dispatchedResponse, dispatchedAt };
  const fileRepositoryLayer = PendingInteractionResponseRepositoryLive.pipe(
    Layer.provideMerge(layerFromPath(databasePath)),
    Layer.provideMerge(NodeServices.layer),
  );

  const firstOpen = Effect.gen(function* () {
    const repository = yield* PendingInteractionResponseRepository;
    assert.deepStrictEqual(
      yield* repository.claim({ interaction: nullInteraction, response: nullResponse }),
      { _tag: "Acquired", response: nullResponse },
    );
    assert.deepStrictEqual(
      yield* repository.claim({ interaction: dispatchedInteraction, response: dispatchedResponse }),
      { _tag: "Acquired", response: dispatchedResponse },
    );
    yield* repository.markDispatched({
      authSessionId: dispatchedResponse.authSessionId,
      idempotencyKey: dispatchedResponse.idempotencyKey,
      commandId: dispatchedResponse.commandId,
      dispatchedAt,
    });
  }).pipe(Effect.provide(fileRepositoryLayer));

  const reopened = Effect.gen(function* () {
    const repository = yield* PendingInteractionResponseRepository;
    assert.deepStrictEqual(
      Option.getOrThrow(
        yield* repository.getInteraction({
          threadId: nullInteraction.threadId,
          requestId: nullInteraction.requestId,
        }),
      ),
      nullInteraction,
    );
    assert.deepStrictEqual(
      Option.getOrThrow(
        yield* repository.getByKey({
          authSessionId: nullResponse.authSessionId,
          idempotencyKey: nullResponse.idempotencyKey,
        }),
      ),
      nullResponse,
    );
    assert.deepStrictEqual(
      Option.getOrThrow(
        yield* repository.getInteraction({
          threadId: dispatchedInteraction.threadId,
          requestId: dispatchedInteraction.requestId,
        }),
      ),
      dispatchedInteractionAfterDispatch,
    );
    assert.deepStrictEqual(
      Option.getOrThrow(
        yield* repository.getByKey({
          authSessionId: dispatchedResponse.authSessionId,
          idempotencyKey: dispatchedResponse.idempotencyKey,
        }),
      ),
      dispatchedResponseAfterDispatch,
    );
  }).pipe(Effect.provide(fileRepositoryLayer));

  return firstOpen.pipe(
    Effect.andThen(reopened),
    Effect.ensuring(
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
});
