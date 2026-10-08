import {
  type AuthSessionId,
  CommandId,
  MessageId,
  type EnvironmentHttpCommonError,
  EnvironmentInternalError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type OrchestrationCliDispatchCommand,
  type OrchestrationCliCreateRequest,
  type OrchestrationCliCreateResult,
  type OrchestrationV2ThreadDetailSnapshot,
  type RemoteInteractionAnswerRequest,
  type RemoteInteractionRequestId,
  type RemoteInteractionResponseResult,
  type RemoteInteractionThreadId,
  type RemotePendingInteractionsQuery,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import type { HttpClient } from "effect/http";

import type { AuthenticatedCliTarget } from "./remoteAuth.ts";
import { makeRemoteCliApi, requestRemoteCli, RemoteCliError } from "./remoteHttp.ts";

/** Prebuilt authenticated CLI context as returned by resolveAuthenticatedCliTarget. */
export type RemoteOperationsContext = AuthenticatedCliTarget;

const orchestrationHeaders = (accessToken: string) => ({
  authorization: `Bearer ${accessToken}`,
  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT as "2",
});

const exitFailure = <A, E>(exit: Exit.Failure<A, E>): E | undefined =>
  Option.getOrUndefined(Cause.findErrorOption(exit.cause));

export type SendThreadMessageInput = {
  readonly threadId: ThreadId;
  readonly message: string;
  /** Raw caller key; never trimmed. Length must be 1..256. */
  readonly idempotencyKey?: string;
  readonly retryAmbiguous?: boolean;
};

export type SendThreadMessageResult = {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly sequence: number;
  /** True only when the receipt came from the retry attempt. */
  readonly recovered: boolean;
};

const KEYED_COMMAND_ID_PREFIX = "cli-send:";
const IDEMPOTENCY_KEY_MIN_LENGTH = 1;
const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

const isRemoteCliError = Schema.is(RemoteCliError);
const isEnvironmentInternalError = Schema.is(EnvironmentInternalError);

const sha256Hex = (crypto: Crypto.Crypto, value: string) =>
  crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
    Effect.map((bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")),
    Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })),
  );

/**
 * Keyed send id: `cli-send:` + sha256hex(sessionId + NUL + key). The same
 * session and key always produce the same id across transport retries.
 */
export const keyedSendCommandId = Effect.fnUntraced(function* (
  sessionId: AuthSessionId,
  key: string,
) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* sha256Hex(crypto, `${sessionId}\0${key}`);
  return CommandId.make(`${KEYED_COMMAND_ID_PREFIX}${digest}`);
});

/**
 * Unkeyed send id: the deployed wire identity is one plain UUID per send.
 * The `cli-send:` grammar applies only to keyed ids; this value is generated
 * once per send and reused verbatim across ambiguous-dispatch retries.
 */
const randomSendCommandId = () =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.map(CommandId.make),
    Effect.mapError(() => new RemoteCliError({ reason: "request-failed" })),
  );

const resolveSendCommandId = (
  ctx: RemoteOperationsContext,
  idempotencyKey: string | undefined,
): Effect.Effect<CommandId, RemoteCliError, Crypto.Crypto> => {
  if (idempotencyKey === undefined) {
    return randomSendCommandId();
  }
  if (
    idempotencyKey.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return Effect.fail(new RemoteCliError({ reason: "invalid-input" }));
  }
  const sessionId = ctx.session.principal?.sessionId;
  // RemoteCliError carries static reason messages only; the "idempotency
  // requires an authenticated session" wording belongs to the command
  // boundary that renders this invalid-input failure.
  if (sessionId === undefined) {
    return Effect.fail(new RemoteCliError({ reason: "invalid-input" }));
  }
  return keyedSendCommandId(sessionId, idempotencyKey);
};

function makeRemoteSendCommand(input: {
  readonly snapshot: OrchestrationV2ThreadDetailSnapshot;
  readonly commandId: CommandId;
  readonly message: string;
  readonly createdAt: string;
}): Extract<OrchestrationCliDispatchCommand, { type: "thread.turn.start" }> {
  const thread = input.snapshot.projection.thread;
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: thread.id,
    message: {
      messageId: MessageId.make(input.commandId),
      role: "user",
      text: input.message,
      attachments: [],
    },
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: input.createdAt,
  };
}

/** Native full read-model snapshot with the CLI bearer token. */
export const readOrchestrationSnapshot = (ctx: RemoteOperationsContext) =>
  Effect.gen(function* () {
    const api = yield* makeRemoteCliApi(ctx.target.httpBaseUrl);
    return yield* requestRemoteCli(
      api.orchestration.snapshot({ headers: { authorization: `Bearer ${ctx.accessToken}` } }),
    );
  });

/** Native lightweight shell snapshot with the CLI bearer token. */
export const readOrchestrationShell = (ctx: RemoteOperationsContext) =>
  Effect.gen(function* () {
    const api = yield* makeRemoteCliApi(ctx.target.httpBaseUrl);
    return yield* requestRemoteCli(
      api.orchestration.shellSnapshot({ headers: orchestrationHeaders(ctx.accessToken) }),
    );
  });

/** Native thread detail snapshot with the CLI bearer token. */
export const readOrchestrationThread = (ctx: RemoteOperationsContext, threadId: ThreadId) =>
  Effect.gen(function* () {
    const api = yield* makeRemoteCliApi(ctx.target.httpBaseUrl);
    return yield* requestRemoteCli(
      api.orchestration.threadSnapshot({
        headers: orchestrationHeaders(ctx.accessToken),
        params: { threadId },
      }),
    );
  });

/**
 * Sends one user turn to an existing thread. The command is built once from
 * the thread's live runtime/interaction modes; an ambiguous transport failure
 * during dispatch (RemoteCliError request-failed, which includes the 15s
 * timeout) retries exactly once with the identical command object. Declared
 * EnvironmentHttpCommonError rejections never retry. A second ambiguous
 * outcome fails with `ambiguous-dispatch` instead of inventing a receipt.
 */
export const sendThreadMessage = Effect.fn("remoteOperations.sendThreadMessage")(function* (
  ctx: RemoteOperationsContext,
  input: SendThreadMessageInput,
) {
  const commandId = yield* resolveSendCommandId(ctx, input.idempotencyKey);
  const threadId = input.threadId;
  const api = yield* makeRemoteCliApi(ctx.target.httpBaseUrl);
  const snapshot = yield* requestRemoteCli(
    api.orchestration.threadSnapshot({
      headers: orchestrationHeaders(ctx.accessToken),
      params: { threadId },
    }),
  );
  const command = makeRemoteSendCommand({
    snapshot,
    commandId,
    message: input.message,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
  const dispatchOnce = () =>
    requestRemoteCli(
      api.orchestration.dispatch({
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: command,
      }),
    );

  const first = yield* dispatchOnce().pipe(Effect.exit);
  if (Exit.isSuccess(first)) {
    return {
      threadId,
      commandId,
      sequence: first.value.sequence,
      recovered: false,
    };
  }

  const firstError = exitFailure(first);
  const ambiguous =
    firstError !== undefined &&
    ((isRemoteCliError(firstError) && firstError.reason === "request-failed") ||
      (isEnvironmentInternalError(firstError) &&
        firstError.reason === "orchestration_send_outcome_unknown"));
  if (!ambiguous || input.retryAmbiguous === false) {
    return yield* firstError === undefined
      ? new RemoteCliError({ reason: "request-failed" })
      : Effect.fail(firstError);
  }

  const second = yield* dispatchOnce().pipe(Effect.exit);
  if (Exit.isSuccess(second)) {
    return {
      threadId,
      commandId,
      sequence: second.value.sequence,
      recovered: true,
    };
  }

  return yield* new RemoteCliError({ reason: "ambiguous-dispatch", commandId, threadId });
});

const REMOTE_KEY_MIN_LENGTH = 1;

/**
 * Trims one caller-supplied idempotency key and validates the trimmed length.
 * The key is never regenerated or altered beyond the trim.
 */
const trimRemoteKey = (key: string, maxLength: number): Effect.Effect<string, RemoteCliError> => {
  const trimmed = key.trim();
  return trimmed.length < REMOTE_KEY_MIN_LENGTH || trimmed.length > maxLength
    ? Effect.fail(new RemoteCliError({ reason: "invalid-input" }))
    : Effect.succeed(trimmed);
};

const orchestrator = (ctx: RemoteOperationsContext) => makeRemoteCliApi(ctx.target.httpBaseUrl);

export type CompactThreadInput = {
  readonly threadId: ThreadId;
  readonly idempotencyKey: string;
};

/**
 * Requests thread compaction. The server derives the cli-compact command id
 * from the trimmed idempotency key; a wrong or unknown thread is an explicit
 * typed failure, and an unrecognized 409 body sanitizes to request-failed
 * without any raw transport detail.
 */
export const compactThread = (ctx: RemoteOperationsContext, input: CompactThreadInput) =>
  Effect.gen(function* () {
    const idempotencyKey = yield* trimRemoteKey(input.idempotencyKey, 256);
    const api = yield* orchestrator(ctx);
    return yield* requestRemoteCli(
      api.orchestration.compact({
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: { threadId: input.threadId, idempotencyKey },
      }),
    );
  });

export type CreateThreadResult = OrchestrationCliCreateResult;

/** Creates a thread through the server-authoritative CLI create endpoint. */
export const createThread = (
  ctx: RemoteOperationsContext,
  input: OrchestrationCliCreateRequest,
): Effect.Effect<
  CreateThreadResult,
  RemoteCliError | EnvironmentHttpCommonError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const idempotencyKey = yield* trimRemoteKey(input.idempotencyKey, 256);
    const api = yield* orchestrator(ctx);
    return yield* requestRemoteCli(
      api.orchestration.create({
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: { ...input, idempotencyKey },
      }),
    );
  });

/** Lists pending interactions, optionally scoped to one thread. */
export const listPendingInteractions = (
  ctx: RemoteOperationsContext,
  query: RemotePendingInteractionsQuery,
) =>
  Effect.gen(function* () {
    const api = yield* orchestrator(ctx);
    return yield* requestRemoteCli(
      api.orchestration.pendingInteractions({
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        query,
      }),
    );
  });

export type RespondPendingInteractionInput = {
  readonly threadId: RemoteInteractionThreadId;
  readonly requestId: RemoteInteractionRequestId;
  readonly idempotencyKey: string;
};

/** Answers one pending user-input interaction. */
export const answerPendingInteraction = (
  ctx: RemoteOperationsContext,
  input: RespondPendingInteractionInput & {
    readonly answers: ReadonlyArray<RemoteInteractionAnswerRequest["answers"][number]>;
  },
): Effect.Effect<
  RemoteInteractionResponseResult,
  RemoteCliError | EnvironmentHttpCommonError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const idempotencyKey = yield* trimRemoteKey(input.idempotencyKey, 128);
    const api = yield* orchestrator(ctx);
    return yield* requestRemoteCli(
      api.orchestration.answerPendingInteraction({
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: {
          threadId: input.threadId,
          requestId: input.requestId,
          idempotencyKey,
          answers: [...input.answers],
        },
      }),
    );
  });

/** Approves one pending approval interaction. */
export const approvePendingInteraction = (
  ctx: RemoteOperationsContext,
  input: RespondPendingInteractionInput,
): Effect.Effect<
  RemoteInteractionResponseResult,
  RemoteCliError | EnvironmentHttpCommonError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const idempotencyKey = yield* trimRemoteKey(input.idempotencyKey, 128);
    const api = yield* orchestrator(ctx);
    return yield* requestRemoteCli(
      api.orchestration.approvePendingInteraction({
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: {
          threadId: input.threadId,
          requestId: input.requestId,
          idempotencyKey,
        },
      }),
    );
  });

/** Declines or cancels one pending interaction. */
export const rejectPendingInteraction = (
  ctx: RemoteOperationsContext,
  input: RespondPendingInteractionInput & { readonly decision: "decline" | "cancel" },
): Effect.Effect<
  RemoteInteractionResponseResult,
  RemoteCliError | EnvironmentHttpCommonError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const idempotencyKey = yield* trimRemoteKey(input.idempotencyKey, 128);
    const api = yield* orchestrator(ctx);
    return yield* requestRemoteCli(
      api.orchestration.rejectPendingInteraction({
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: {
          threadId: input.threadId,
          requestId: input.requestId,
          idempotencyKey,
          decision: input.decision,
        },
      }),
    );
  });
