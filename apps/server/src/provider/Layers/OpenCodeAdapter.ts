import {
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeTaskUsage,
  ThreadId,
  type ToolLifecycleItemType,
  type TurnTokenUsage,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type {
  Message,
  OpencodeClient,
  Part,
  PermissionRequest,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { summarizeOpenCodeToolInput } from "@t3tools/shared/toolActivity";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import * as Option from "effect/Option";

const PROVIDER = ProviderDriverKind.make("opencode");

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION / CURSOR_RESUME_VERSION).
 */
const OPENCODE_RESUME_VERSION = 1 as const;

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure (the SDK client
 * is `throwOnError: true`, so `session.get` rejects on every non-2xx) must
 * propagate, or a transient blip resets a live thread to an empty one — the
 * #3604 silent context loss. Decides on structured signals only, never free
 * text: a numeric 404 or the exact `NotFoundError` name, found via a bounded walk
 * over `cause`/`body`/`error`/`data`. An explicit non-404 status seals its
 * subtree so a wrapped "NotFound" name can't reclassify a real failure.
 * Exported for unit testing.
 */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;

    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }

    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }

    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

type OpenCodeSessionStatusEvent = Extract<
  OpenCodeSubscribedEvent,
  { readonly type: "session.status" }
>;

const OpenCodeSessionStatusMap = Schema.Record(
  Schema.String,
  Schema.Struct({ type: Schema.String }),
);
const decodeOpenCodeSessionStatusMap = Schema.decodeUnknownOption(OpenCodeSessionStatusMap);

interface OpenCodeCancellation {
  readonly turnId: TurnId | undefined;
  readonly acknowledgment: Deferred.Deferred<void>;
  readonly completion: Deferred.Deferred<void, ProviderAdapterRequestError>;
  acknowledged?: boolean;
  turnSettled?: boolean;
  deferredIdleEvent?: OpenCodeSessionStatusEvent;
}

interface OpenCodeIdleReconciliation {
  readonly turnId: TurnId;
  readonly promptGeneration: number;
  raw: unknown;
  warned: boolean;
  dirty: boolean;
  fiber?: Fiber.Fiber<void, never>;
}

interface OpenCodePromptAdmission {
  readonly generation: number;
  readonly turnId: TurnId;
  readonly messageId: string;
  readonly priorAwaitingBusy: boolean;
  readonly priorIdle: { readonly turnId: TurnId; readonly raw: unknown } | undefined;
  idleDuringAdmission: { readonly turnId: TurnId; readonly raw: unknown } | undefined;
  idleObservedAfterMessage: boolean;
  messageObserved: boolean;
  busyObserved: boolean;
  idleStatusConfirmations: number;
  accepted: boolean;
  cancelled: boolean;
  readonly acceptance: Deferred.Deferred<void>;
  readonly submissionSettled: Deferred.Deferred<void>;
  promptFiber?: Fiber.Fiber<void, ProviderAdapterRequestError>;
  recoveryFiber?: Fiber.Fiber<void, never>;
  recoveryRaw: unknown;
}

type OpenCodeTerminalRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  {
    readonly type: "permission.replied" | "question.replied" | "question.rejected";
  }
>;

type OpenCodeAskedRequestEvent = Extract<
  OpenCodeSubscribedEvent,
  { readonly type: "permission.asked" | "question.asked" }
>;

type OpenCodeRoutedRequestEvent = OpenCodeAskedRequestEvent | OpenCodeTerminalRequestEvent;

interface OpenCodeRequestRelationRetry {
  warned: boolean;
  /** Session the waiting request belongs to, so eviction can detach it. */
  readonly sessionID: string;
  fiber?: Fiber.Fiber<void, never>;
}

interface OpenCodeParentTask {
  readonly callId: string;
  readonly ownerSessionId: string;
  readonly turnId: TurnId;
  childSessionId?: string;
  title?: string;
  role?: string;
  background: boolean;
  backgroundKnown: boolean;
}

interface OpenCodeChildTask {
  readonly sessionId: string;
  parentSessionId: string;
  turnId: TurnId;
  parentToolUseId?: string;
  linkageExact: boolean;
  title?: string;
  role?: string;
  background: boolean;
  backgroundKnown: boolean;
  idleObserved: boolean;
  latestResult?: string;
  started: boolean;
  terminal: boolean;
  linkageFingerprint?: string;
  status?: string;
  /** Last normalized assistant token snapshot reported for this child. */
  typedUsage?: RuntimeTaskUsage;
  usageFingerprint?: string;
  readonly toolFingerprints: Map<string, string>;
  readonly textFingerprints: Map<string, string>;
  /**
   * Rolling text snapshot per child text part, fed by `message.part.delta`
   * events so progress rows carry the accumulated snapshot instead of the
   * latest raw token fragment. `message.part.updated` snapshots stay
   * authoritative and share the same keys.
   */
  readonly deltaTextByPartId: Map<string, string>;
}

interface OpenCodePendingChildState {
  readonly parentSessionId: string;
  readonly observedTurnId?: TurnId;
  readonly title?: string;
  idleObserved: boolean;
  latestResult?: string;
  terminal?: {
    readonly status: "failed" | "stopped";
    readonly summary?: string;
  };
}

interface OpenCodePendingRequestRecovery {
  warned: boolean;
  rerun: boolean;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? trimText(value) : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/**
 * OpenCode assistant token snapshot ({input, output, reasoning, cache.read,
 * cache.write}) → the typed contract shape. The SDK carries no authoritative
 * total, so the total is the sum of the five fields, and `inputTokens`
 * includes cache traffic like the other adapters' rollups. A missing or
 * malformed field fails the whole snapshot rather than yielding a partial
 * guess.
 */
function normalizeOpenCodeChildUsage(tokens: unknown): RuntimeTaskUsage | undefined {
  const record = recordFromUnknown(tokens);
  const cache = recordFromUnknown(record?.cache);
  if (!record || !cache) {
    return undefined;
  }
  const input = nonNegativeInt(record.input);
  const output = nonNegativeInt(record.output);
  const reasoning = nonNegativeInt(record.reasoning);
  const cacheRead = nonNegativeInt(cache.read);
  const cacheWrite = nonNegativeInt(cache.write);
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    totalTokens: input + output + reasoning + cacheRead + cacheWrite,
    inputTokens: input + cacheRead + cacheWrite,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
  };
}

/**
 * OpenCode initializes a fresh child's token snapshot at all zeros before any
 * real work is reported; such a snapshot carries no usage progress.
 */
function openCodeChildUsageIsZero(usage: RuntimeTaskUsage): boolean {
  return (
    usage.totalTokens === 0 &&
    (usage.inputTokens === undefined || usage.inputTokens === 0) &&
    (usage.cachedInputTokens === undefined || usage.cachedInputTokens === 0) &&
    (usage.outputTokens === undefined || usage.outputTokens === 0) &&
    (usage.reasoningOutputTokens === undefined || usage.reasoningOutputTokens === 0)
  );
}

/**
 * Per-activation usage is monotonic: snapshots overwrite each other in place
 * and can shrink at a step boundary, so each field takes the best (highest)
 * value seen instead of trusting the latest snapshot. Fields never sum across
 * snapshots.
 */
function mergeOpenCodeChildUsage(
  baseline: RuntimeTaskUsage,
  next: RuntimeTaskUsage,
): RuntimeTaskUsage {
  const maxByField = (
    baselineValue: number | undefined,
    nextValue: number | undefined,
  ): number | undefined =>
    baselineValue === undefined
      ? nextValue
      : nextValue === undefined
        ? baselineValue
        : Math.max(baselineValue, nextValue);
  return {
    totalTokens: Math.max(baseline.totalTokens, next.totalTokens),
    inputTokens: maxByField(baseline.inputTokens, next.inputTokens),
    cachedInputTokens: maxByField(baseline.cachedInputTokens, next.cachedInputTokens),
    outputTokens: maxByField(baseline.outputTokens, next.outputTokens),
    reasoningOutputTokens: maxByField(baseline.reasoningOutputTokens, next.reasoningOutputTokens),
  };
}

function openCodeChildUsageFingerprint(usage: RuntimeTaskUsage): string {
  return [
    usage.totalTokens,
    usage.inputTokens,
    usage.cachedInputTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
  ].join("\u0000");
}

function boundedOpenCodeActivityText(value: unknown, maxLength: number): string | undefined {
  const text = stringFromUnknown(value);
  if (!text) {
    return undefined;
  }
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * OpenCode's task tool reports its output inside a provider-owned protocol
 * envelope (see upstream `renderOutput`): `<task id=… state=…>` wrapping an
 * optional `<summary>` and a `<task_result>`/`<task_error>` block. Only a
 * whole anchored envelope unwraps; bare result/error blocks, a task wrapper
 * without a result/error block, mismatched tags, and other XML-like text all
 * pass through untouched.
 */
const OPENCODE_TASK_ENVELOPE_PATTERN = /^\s*<task\b[^>]*>([\s\S]*)<\/task>\s*$/i;
const OPENCODE_TASK_SUMMARY_PATTERN = /^\s*<summary\b[^>]*>[\s\S]*?<\/summary>\s*/i;
const OPENCODE_TASK_RESULT_PATTERN = /^\s*<task_(result|error)\b[^>]*>([\s\S]*)<\/task_\1>\s*$/i;

function openCodeTaskOutputText(output: unknown): string {
  // Plain text passes through byte-for-byte: this output seeds the child
  // delta accumulator, so a trimmed snapshot would glue the next delta onto
  // its last word. Only a valid whole envelope unwraps (to trimmed inner
  // text); everything else — including malformed markup — is returned as-is.
  const text = typeof output === "string" ? output : "";
  const envelope = OPENCODE_TASK_ENVELOPE_PATTERN.exec(text);
  if (!envelope) {
    return text;
  }
  let inner = envelope[1] ?? "";
  const summary = OPENCODE_TASK_SUMMARY_PATTERN.exec(inner);
  if (summary) {
    inner = inner.slice(summary[0].length);
  }
  const result = OPENCODE_TASK_RESULT_PATTERN.exec(inner.trim());
  if (!result) {
    return text;
  }
  return (result[2] ?? "").trim();
}

function openCodeTaskMetadata(part: Extract<Part, { type: "tool" }>): {
  readonly childSessionId?: string;
  readonly parentSessionId?: string;
  readonly resumeSessionId?: string;
  readonly title?: string;
  readonly role?: string;
  readonly background: boolean;
  readonly backgroundKnown: boolean;
} {
  const state = recordFromUnknown(part.state);
  const input = recordFromUnknown(state?.input);
  const metadata = recordFromUnknown(state?.metadata);
  const childSessionId = stringFromUnknown(metadata?.sessionId ?? metadata?.sessionID);
  const parentSessionId = stringFromUnknown(metadata?.parentSessionId ?? metadata?.parentSessionID);
  const resumeSessionId = stringFromUnknown(input?.task_id);
  const title = boundedOpenCodeActivityText(input?.description, 240);
  const role = boundedOpenCodeActivityText(input?.subagent_type, 80);
  const status = stringFromUnknown(state?.status);
  const output = stringFromUnknown(state?.output);
  const runningTaskOutput = /<task\b[^>]*\bstate=["']running["']/i.test(output ?? "");
  // Metadata that names the child session is the task's authoritative state:
  // an omitted `background` there reads as foreground, so the root idle
  // fallback may settle the child. ParentID-only discovery stays unknown.
  const exactTaskState = childSessionId !== undefined || parentSessionId !== undefined;
  return {
    ...(childSessionId ? { childSessionId } : {}),
    ...(parentSessionId ? { parentSessionId } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(title ? { title } : {}),
    ...(role ? { role } : {}),
    background: metadata?.background === true || runningTaskOutput,
    backgroundKnown:
      exactTaskState ||
      typeof metadata?.background === "boolean" ||
      runningTaskOutput ||
      status === "completed" ||
      status === "error",
  };
}

function openCodeEventSessionId(event: OpenCodeSubscribedEvent): string | undefined {
  const properties = "properties" in event ? event.properties : undefined;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }

  const sessionID = (properties as { readonly sessionID?: unknown }).sessionID;
  const sessionIDFromProperties = typeof sessionID === "string" ? sessionID : undefined;
  if (sessionIDFromProperties) {
    return sessionIDFromProperties;
  }

  const info = (properties as { readonly info?: { readonly id?: unknown } }).info;
  return info && typeof info.id === "string" ? info.id : undefined;
}

function openCodeEventSessionTitle(event: OpenCodeSubscribedEvent): string | undefined {
  if (event.type !== "session.updated") {
    return undefined;
  }

  const title = trimText(event.properties.info.title);
  // OpenCode mints a placeholder title at session.create when no title was
  // provided, and re-emits it on every `session.updated`. Mirroring it would
  // overwrite the thread's real title (openCodeEventSessionTitle feeds the
  // `thread.metadata.updated` mirror). Ignore OpenCode's auto-generated
  // placeholders so the thread isn't locked onto them.
  if (!title || isOpenCodeDefaultTitle(title)) {
    return undefined;
  }

  return title;
}

function isOpenCodeAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "MessageAbortedError"
  );
}

function isOpenCodeChildRequestEvent(event: OpenCodeSubscribedEvent): boolean {
  switch (event.type) {
    case "permission.asked":
    case "permission.replied":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
      return true;
    default:
      return false;
  }
}

const OPENCODE_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OPENCODE_TASK_TOMBSTONE_LIMIT = 128;
const OPENCODE_UNBOUND_TASK_LIMIT = 128;
const OPENCODE_EVICTED_CHILD_LIMIT = 128;
const OPENCODE_PENDING_CHILD_LIMIT = 128;
const OPENCODE_CHILD_FINGERPRINT_LIMIT = 128;
const OPENCODE_CHILD_DELTA_TEXT_LIMIT = 2_000;
const OPENCODE_REQUEST_TOMBSTONE_LIMIT = 128;

/**
 * Per-part accumulator bound shared by the snapshot seed and the delta
 * append paths, so one entry can never grow past the limit regardless of
 * which event fed it.
 */
function boundOpenCodeChildDeltaText(text: string): string {
  return text.length > OPENCODE_CHILD_DELTA_TEXT_LIMIT
    ? text.slice(0, OPENCODE_CHILD_DELTA_TEXT_LIMIT)
    : text;
}
/**
 * Depth cap for walks over the child `parentSessionId` graph (ancestry
 * checks, descendant enumeration). Matches the bound used by the session
 * ancestry probe, so a corrupt or cyclic parent chain cannot spin.
 */
const OPENCODE_CHILD_GRAPH_LIMIT = 256;

function isOpenCodeDefaultTitle(title: string): boolean {
  return OPENCODE_DEFAULT_TITLE_PATTERN.test(title);
}

type OpenCodeTextPart = Extract<Part, { readonly type: "text" | "reasoning" }>;

type OpenCodeTextPartState = Pick<OpenCodeTextPart, "id" | "messageID" | "type" | "time"> & {
  text: string | undefined;
  emittedText: string | undefined;
  completed: boolean;
};

type OpenCodeStepUsage = Pick<Extract<Part, { readonly type: "step-finish" }>, "id" | "tokens">;

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly relatedSessionIds: Set<string>;
  readonly parentTasksByCallId: Map<string, OpenCodeParentTask>;
  readonly childTasksBySessionId: Map<string, OpenCodeChildTask>;
  readonly pendingChildStateBySessionId: Map<string, OpenCodePendingChildState>;
  readonly evictedChildSessionIds: Set<string>;
  /**
   * Flipped the moment the eviction tombstone set rolls over and forgets its
   * oldest entry. From then on the tombstone set can no longer vouch for
   * every denied child, so all unknown session ids are rejected. Exact task
   * metadata can still bind children that were already related or pending.
   */
  strictChildCorrelation: boolean;
  readonly evictedParentTaskCallIds: Set<string>;
  settleChildTasksOnStop?: () => Effect.Effect<void>;
  readonly resolvedRequestIds: Set<string>;
  readonly autoRepliedRequestIds: Set<string>;
  readonly emittedTerminalRequestIds: Set<string>;
  readonly requestRelationRetries: Map<string, OpenCodeRequestRelationRetry>;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly requestTurnById: Map<string, TurnId>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly compactionMessageIds: Set<string>;
  // OpenCode permits edits to completed parts. Keep text for snapshot comparison
  // until native removal or session teardown, but do not retain other part payloads.
  readonly textPartsByMessageId: Map<string, Map<string, OpenCodeTextPartState>>;
  turnTokenUsage: OpenCodeTurnTokenUsageAccumulator | undefined;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  cancellation: OpenCodeCancellation | undefined;
  interruptedTurnId: TurnId | undefined;
  reconcileIdleStatus: boolean;
  awaitingBusyAfterInterruption: boolean;
  pendingIdleReconciliation: OpenCodeIdleReconciliation | undefined;
  pendingRequestRecovery: OpenCodePendingRequestRecovery | undefined;
  promptGeneration: number;
  promptAdmission: OpenCodePromptAdmission | undefined;
  readonly promptSemaphore: Semaphore.Semaphore;
  readonly firstConnection: Deferred.Deferred<void, ProviderAdapterRequestError>;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

interface OpenCodeTurnTokenUsageAccumulator {
  readonly partIds: Set<string>;
  readonly promptMessageIds: Set<string>;
  readonly assistantOwnershipByMessageId: Map<string, "owned" | "other" | "unknown">;
  // Native removal does not undo usage. Keep unresolved counts until this turn settles.
  readonly unresolvedStepsByMessageId: Map<string, Map<string, OpenCodeStepUsage>>;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  complete: boolean;
  hasSubagents: boolean;
}

function makeOpenCodeTurnTokenUsageAccumulator(): OpenCodeTurnTokenUsageAccumulator {
  return {
    partIds: new Set(),
    promptMessageIds: new Set(),
    assistantOwnershipByMessageId: new Map(),
    unresolvedStepsByMessageId: new Map(),
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    complete: true,
    hasSubagents: false,
  };
}

function accumulateOpenCodeStepUsage(
  accumulator: OpenCodeTurnTokenUsageAccumulator,
  part: OpenCodeStepUsage,
): void {
  if (accumulator.partIds.has(part.id)) return;
  accumulator.partIds.add(part.id);
  accumulator.inputTokens += part.tokens.input + part.tokens.cache.read + part.tokens.cache.write;
  accumulator.cachedInputTokens += part.tokens.cache.read;
  accumulator.cacheCreationTokens += part.tokens.cache.write;
  accumulator.outputTokens += part.tokens.output + part.tokens.reasoning;
  accumulator.reasoningTokens += part.tokens.reasoning;
}

function takeOpenCodeTurnTokenUsage(
  context: OpenCodeSessionContext,
  complete: boolean,
): TurnTokenUsage {
  const usage = context.turnTokenUsage;
  context.turnTokenUsage = undefined;
  if (!usage || usage.partIds.size === 0) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage?.hasSubagents ?? false,
    };
  }
  return {
    usageStatus:
      complete && usage.complete && usage.unresolvedStepsByMessageId.size === 0
        ? "complete"
        : "partial",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: usage.hasSubagents,
  };
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite" || normalized === "todoread") {
    return "dynamic_tool_call";
  }
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" {
  switch (permission) {
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      // Every OpenCode permission needs an actionable approval in each client.
      return "command_execution_approval";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
});

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Pick<Part, "type">): "assistant_text" | "reasoning_text" {
  return part.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function retainOpenCodeTextPart(
  context: OpenCodeSessionContext,
  part: OpenCodeTextPart,
): OpenCodeTextPartState {
  const parts =
    context.textPartsByMessageId.get(part.messageID) ?? new Map<string, OpenCodeTextPartState>();
  const previous = parts.get(part.id);
  const state = {
    id: part.id,
    messageID: part.messageID,
    type: part.type,
    text: part.text,
    ...(part.time !== undefined ? { time: part.time } : {}),
    emittedText: previous?.emittedText,
    completed: previous?.completed ?? false,
  };
  parts.set(part.id, state);
  context.textPartsByMessageId.set(part.messageID, parts);
  return state;
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  const previous = previousText ?? "";
  const prefixLength = latestText.startsWith(previous)
    ? previous.length
    : commonPrefixLength(previous, latestText);
  return {
    latestText,
    deltaToEmit: latestText.slice(prefixLength),
  };
}

function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function isOpenCodeCompactionMessage(message: Message): boolean {
  return message.role === "assistant" && message.agent === "compaction" && message.summary === true;
}

/**
 * Title family for a live tool row. Covers the tools whose rows previously
 * leaked raw native output (`<path>…`, `<skill_content>…`, `<task_result>…`)
 * as their detail; unknown tools keep the native tool name.
 */
function toolTitleFamily(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case "read":
      return "Read File";
    case "skill":
      return "Skill";
    case "task":
      return "Subagent task";
    case "todowrite":
      return "Update task list";
    default:
      return toolName;
  }
}

function hidesCompletedToolOutput(toolName: string): boolean {
  switch (toolName.toLowerCase()) {
    case "read":
    case "skill":
    case "task":
    case "todowrite":
      return true;
    default:
      return false;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    return applyProviderSessionUpdate(context, patch, options, yield* nowIso);
  });
}

function applyProviderSessionUpdate(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options:
    | {
        readonly clearActiveTurnId?: boolean;
        readonly clearLastError?: boolean;
      }
    | undefined,
  updatedAt: string,
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt,
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

const failPendingOpenCodeCancellation = Effect.fn("failPendingOpenCodeCancellation")(function* (
  context: OpenCodeSessionContext,
  detail: string,
) {
  const cancellation = context.cancellation;
  if (!cancellation) {
    return;
  }
  context.cancellation = undefined;
  yield* Deferred.fail(
    cancellation.completion,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "session.abort",
      detail,
    }),
  ).pipe(Effect.ignore);
});

/**
 * Whether the parent chain above a session crosses a terminal child task.
 * Walks the tracked graph — bound child tasks plus pending discoveries,
 * which also carry a `parentSessionId` — so a newly discovered descendant
 * is denied even when its immediate parent is still live (e.g. pending
 * beneath a live child of a terminal task). Bounded by
 * {@link OPENCODE_CHILD_GRAPH_LIMIT} and a visited set.
 */
function hasTerminalOpenCodeAncestor(
  context: OpenCodeSessionContext,
  fromSessionId: string,
): boolean {
  const seen = new Set<string>([fromSessionId]);
  let sessionId: string | undefined = fromSessionId;
  for (let depth = 0; sessionId !== undefined && depth < OPENCODE_CHILD_GRAPH_LIMIT; depth += 1) {
    if (sessionId === context.openCodeSessionId) {
      return false;
    }
    const task = context.childTasksBySessionId.get(sessionId);
    if (task) {
      if (task.terminal) {
        return true;
      }
      sessionId = task.parentSessionId;
    } else {
      sessionId = context.pendingChildStateBySessionId.get(sessionId)?.parentSessionId;
    }
    if (sessionId === undefined || seen.has(sessionId)) {
      return false;
    }
    seen.add(sessionId);
  }
  return false;
}

/**
 * Live bound and pending child sessions beneath a session, breadth-first over
 * the child graph. Ancestors precede descendants so callers can settle bound
 * tasks in order and tear each session down exactly once.
 */
function liveOpenCodeDescendants(
  context: OpenCodeSessionContext,
  sessionId: string,
): {
  readonly tasks: ReadonlyArray<OpenCodeChildTask>;
  readonly sessionIds: ReadonlyArray<string>;
} {
  const tasks: Array<OpenCodeChildTask> = [];
  const sessionIds: Array<string> = [];
  const seen = new Set<string>([sessionId]);
  const queue: Array<string> = [sessionId];
  for (let steps = 0; queue.length > 0 && steps < OPENCODE_CHILD_GRAPH_LIMIT; steps += 1) {
    const parentSessionId = queue.shift()!;
    for (const task of context.childTasksBySessionId.values()) {
      if (seen.has(task.sessionId) || task.parentSessionId !== parentSessionId) {
        continue;
      }
      seen.add(task.sessionId);
      queue.push(task.sessionId);
      if (!task.terminal) {
        tasks.push(task);
        sessionIds.push(task.sessionId);
      }
    }
    for (const [pendingSessionId, pending] of context.pendingChildStateBySessionId) {
      if (seen.has(pendingSessionId) || pending.parentSessionId !== parentSessionId) {
        continue;
      }
      seen.add(pendingSessionId);
      queue.push(pendingSessionId);
      sessionIds.push(pendingSessionId);
    }
  }
  return { tasks, sessionIds };
}

const abortOpenCodeSessionId = (context: OpenCodeSessionContext, sessionID: string) =>
  runOpenCodeSdk("session.abort", (signal) =>
    context.client.session.abort({ sessionID }, { signal }),
  ).pipe(Effect.timeout("1 second"), Effect.ignore({ log: true }));

const abortOpenCodeDescendants = Effect.fn("abortOpenCodeDescendants")(function* (
  context: OpenCodeSessionContext,
) {
  const visited = new Set([context.openCodeSessionId]);
  const requestSemaphore = Semaphore.makeUnsafe(8);

  const visit = (
    sessionId: string,
    abortSession: boolean,
  ): Effect.Effect<OpenCodeRuntimeError | undefined> =>
    Effect.gen(function* () {
      let firstFailure: OpenCodeRuntimeError | undefined;
      if (abortSession) {
        const abortResult = yield* requestSemaphore
          .withPermit(
            runOpenCodeSdk("session.abort", (signal) =>
              context.client.session.abort({ sessionID: sessionId }, { signal }),
            ),
          )
          .pipe(
            Effect.catchIf(
              (cause) => isOpenCodeNotFound(cause),
              () => Effect.void,
            ),
            Effect.result,
          );
        if (abortResult._tag === "Failure") {
          firstFailure = abortResult.failure;
        }
      }

      const childrenResult = yield* requestSemaphore
        .withPermit(
          runOpenCodeSdk("session.children", (signal) =>
            context.client.session.children({ sessionID: sessionId }, { signal }),
          ),
        )
        .pipe(
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () => Effect.void,
          ),
          Effect.result,
        );
      const knownChildren = [
        ...[...context.childTasksBySessionId.values()]
          .filter((task) => !task.terminal && task.parentSessionId === sessionId)
          .map((task) => task.sessionId),
        ...[...context.pendingChildStateBySessionId.entries()]
          .filter(([, child]) => child.parentSessionId === sessionId)
          .map(([childSessionId]) => childSessionId),
      ];
      const discoveredChildren =
        childrenResult._tag === "Success"
          ? (childrenResult.success?.data ?? []).map((child) => child.id)
          : [];
      const newChildren = [...new Set([...discoveredChildren, ...knownChildren])].filter(
        (childId) => {
          if (visited.has(childId)) {
            return false;
          }
          visited.add(childId);
          return true;
        },
      );
      const childFailures = yield* Effect.forEach(newChildren, (childId) => visit(childId, true), {
        concurrency: 8,
      });
      firstFailure ??= childFailures.find((failure) => failure !== undefined);
      if (childrenResult._tag === "Failure") {
        firstFailure ??= childrenResult.failure;
      }
      return firstFailure;
    });

  const firstFailure = yield* visit(context.openCodeSessionId, false);
  if (firstFailure) {
    return yield* firstFailure;
  }
});

const abortOpenCodeSessionForTeardown = Effect.fn("abortOpenCodeSessionForTeardown")(function* (
  context: OpenCodeSessionContext,
) {
  // Stop the parent before the snapshot so it cannot add another child after
  // the adapter reads the tree.
  yield* runOpenCodeSdk("session.abort", (signal) =>
    context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
  ).pipe(Effect.timeout("1 second"), Effect.ignore({ log: true }));
  yield* abortOpenCodeDescendants(context).pipe(
    Effect.timeout("1 second"),
    Effect.ignore({ log: true }),
  );
});

const cancelPendingOpenCodePrompt = Effect.fn("cancelPendingOpenCodePrompt")(function* (
  context: OpenCodeSessionContext,
) {
  const admission = context.promptAdmission;
  if (!admission) {
    return;
  }
  admission.cancelled = true;
  if (admission.promptFiber) {
    yield* Fiber.interrupt(admission.promptFiber);
  }
  yield* Deferred.await(admission.submissionSettled);
});

const closeStartingOpenCodeContext = Effect.fn("closeStartingOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
  abortRemote: boolean,
) {
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session startup ended before the event stream connected.",
    }),
  ).pipe(Effect.ignore);
  yield* cancelPendingOpenCodePrompt(context);
  yield* failPendingOpenCodeCancellation(context, "OpenCode session startup was cancelled.");
  context.promptAdmission = undefined;
  if (abortRemote) {
    yield* abortOpenCodeSessionForTeardown(context);
  }
  yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
});

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session stopped before the event stream connected.",
    }),
  ).pipe(Effect.ignore);
  yield* cancelPendingOpenCodePrompt(context);
  const cancellation = context.cancellation;
  context.cancellation = undefined;
  if (cancellation) {
    yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
  }
  context.promptAdmission = undefined;
  // Best-effort remote abort. The scope close below tears down the local
  // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
  // but we still want to tell OpenCode that this session is done.
  yield* abortOpenCodeSessionForTeardown(context);
  if (context.settleChildTasksOnStop) {
    yield* context.settleChildTasksOnStop();
  }

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const deleteContextIfCurrent = (context: OpenCodeSessionContext) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
    };
    const awaitOpenCodeContextReady = Effect.fn("awaitOpenCodeContextReady")(function* (
      context: OpenCodeSessionContext,
    ) {
      yield* Deferred.await(context.firstConnection);
      const current = yield* ensureSessionContext(sessions, context.session.threadId);
      if (current !== context) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.session.threadId,
        });
      }
      return current;
    });
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    let messageIdEpochMillis = -1;
    let messageIdCounter = 0;
    // T3 supplies the message ID to match prompt admission events. Keep OpenCode's sortable native shape so equal-time messages retain their upstream order.
    const makeOpenCodeMessageId = Effect.fn("makeOpenCodeMessageId")(function* () {
      const epochMillis = DateTime.toEpochMillis(yield* DateTime.now);
      if (epochMillis !== messageIdEpochMillis) {
        messageIdEpochMillis = epochMillis;
        messageIdCounter = 0;
      }
      messageIdCounter += 1;
      const encodedTime = BigInt.asUintN(
        48,
        BigInt(epochMillis) * 0x1000n + BigInt(messageIdCounter),
      )
        .toString(16)
        .padStart(12, "0");
      const randomBytes = yield* crypto.randomBytes(14).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "crypto/randomBytes",
              detail: "Failed to generate an OpenCode message identifier.",
              cause,
            }),
        ),
      );
      const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
      const random = Array.from(randomBytes, (byte) => alphabet[byte % alphabet.length]).join("");
      return `msg_${encodedTime}${random}`;
    });
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    // Synchronous publish for callers that must not yield between a state
    // check and the enqueue, e.g. reopening an approval only if its terminal
    // event has not landed yet.
    const emitUnsafe = (event: ProviderRuntimeEvent) => {
      Queue.offerUnsafe(runtimeEvents, event);
    };
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const childTaskLinkage = (context: OpenCodeSessionContext, task: OpenCodeChildTask) => ({
      taskType: "subagent",
      ...(task.title ? { title: task.title } : {}),
      ...(task.role ? { role: task.role } : {}),
      ...(task.parentToolUseId ? { toolUseId: task.parentToolUseId } : {}),
      ...(task.parentSessionId !== context.openCodeSessionId
        ? { parentAgentId: task.parentSessionId }
        : {}),
      timelineBypass: true,
    });

    const childTaskFingerprint = (task: OpenCodeChildTask): string =>
      [task.title ?? "", task.role ?? "", task.parentToolUseId ?? ""].join("\u0000");

    const setBoundedMapValue = <V>(
      map: Map<string, V>,
      key: string,
      value: V,
      limit: number,
    ): void => {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) {
          return;
        }
        map.delete(oldest);
      }
    };

    const rememberRequestTombstone = (set: Set<string>, requestId: string): void => {
      set.delete(requestId);
      set.add(requestId);
      while (set.size > OPENCODE_REQUEST_TOMBSTONE_LIMIT) {
        const oldest = set.values().next().value;
        if (oldest === undefined) {
          return;
        }
        set.delete(oldest);
      }
    };

    const rememberEvictedChild = (context: OpenCodeSessionContext, sessionId: string): void => {
      context.evictedChildSessionIds.add(sessionId);
      while (context.evictedChildSessionIds.size > OPENCODE_EVICTED_CHILD_LIMIT) {
        const oldest = context.evictedChildSessionIds.values().next().value;
        if (oldest === undefined) {
          return;
        }
        context.evictedChildSessionIds.delete(oldest);
        // A tombstone was forgotten, so the set can no longer vouch for every
        // denied child. Tighten correlation instead of growing state: unknown
        // session ids now need exact task metadata to be accepted.
        context.strictChildCorrelation = true;
      }
    };

    /**
     * Drop every open request and routing entry tied to a denied child: the
     * pending permission/question records, their turn attribution, and any
     * relation-retry fibers still waiting on session ancestry. Cleaned
     * request ids are marked resolved so redelivery or recovery cannot
     * re-open them. Emits the matching declined/empty resolution before
     * deletion so client and orchestration pending state closes normally.
     */
    const detachOpenCodeChildRequests = Effect.fn("detachOpenCodeChildRequests")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
    ) {
      const doomedRequestIds = new Set<string>();
      for (const [requestId, permission] of context.pendingPermissions) {
        if (permission.sessionID === sessionId) {
          doomedRequestIds.add(requestId);
        }
      }
      for (const [requestId, question] of context.pendingQuestions) {
        if (question.sessionID === sessionId) {
          doomedRequestIds.add(requestId);
        }
      }
      for (const [requestId, retry] of context.requestRelationRetries) {
        if (retry.sessionID === sessionId) {
          doomedRequestIds.add(requestId);
        }
      }
      for (const requestId of doomedRequestIds) {
        const permission = context.pendingPermissions.get(requestId);
        const question = context.pendingQuestions.get(requestId);
        const turnId = context.requestTurnById.get(requestId);
        if (permission) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId,
              raw: { type: "opencode.child-request.denied", sessionId },
            })),
            type: "request.resolved",
            payload: {
              requestType: mapPermissionToRequestType(permission.permission),
              decision: "decline",
            },
          });
        } else if (question) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId,
              raw: { type: "opencode.child-request.denied", sessionId },
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
        }
        context.pendingPermissions.delete(requestId);
        context.pendingQuestions.delete(requestId);
        context.requestTurnById.delete(requestId);
        rememberRequestTombstone(context.resolvedRequestIds, requestId);
        rememberRequestTombstone(context.emittedTerminalRequestIds, requestId);
        const retry = context.requestRelationRetries.get(requestId);
        context.requestRelationRetries.delete(requestId);
        if (retry?.fiber) {
          yield* Fiber.interrupt(retry.fiber);
        }
      }
    });

    /**
     * Tombstone a denied child and forget every request entry tied to it, so
     * responses can no longer reach the child and its late terminal events
     * stay silent. Does not abort the remote session.
     */
    const forgetOpenCodeChildSession = Effect.fn("forgetOpenCodeChildSession")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
    ) {
      context.relatedSessionIds.delete(sessionId);
      rememberEvictedChild(context, sessionId);
      yield* detachOpenCodeChildRequests(context, sessionId);
    });

    /**
     * Full denial: tombstone, request cleanup, and remote abort.
     */
    const denyOpenCodeChildSession = Effect.fn("denyOpenCodeChildSession")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
    ) {
      yield* forgetOpenCodeChildSession(context, sessionId);
      yield* abortOpenCodeSessionId(context, sessionId);
    });

    const rememberPendingChild = (
      context: OpenCodeSessionContext,
      sessionId: string,
      parentSessionId: string,
      observedTurnId: TurnId | undefined,
      title: string | undefined,
    ): { readonly pending: OpenCodePendingChildState; readonly evictedSessionId?: string } => {
      const existing = context.pendingChildStateBySessionId.get(sessionId);
      if (existing) {
        return { pending: existing };
      }
      const pending: OpenCodePendingChildState = {
        parentSessionId,
        ...(observedTurnId ? { observedTurnId } : {}),
        ...(title ? { title } : {}),
        idleObserved: false,
      };
      context.pendingChildStateBySessionId.set(sessionId, pending);
      const evictedSessionId =
        context.pendingChildStateBySessionId.size > OPENCODE_PENDING_CHILD_LIMIT
          ? context.pendingChildStateBySessionId.keys().next().value
          : undefined;
      if (evictedSessionId !== undefined) {
        context.pendingChildStateBySessionId.delete(evictedSessionId);
        context.relatedSessionIds.delete(evictedSessionId);
        rememberEvictedChild(context, evictedSessionId);
      }
      return {
        pending,
        ...(evictedSessionId ? { evictedSessionId } : {}),
      };
    };

    const rememberEvictedParentCall = (context: OpenCodeSessionContext, callId: string): void => {
      context.evictedParentTaskCallIds.add(callId);
      while (context.evictedParentTaskCallIds.size > OPENCODE_UNBOUND_TASK_LIMIT) {
        const oldest = context.evictedParentTaskCallIds.values().next().value;
        if (oldest === undefined) {
          return;
        }
        context.evictedParentTaskCallIds.delete(oldest);
      }
    };

    const pruneOpenCodeTaskState = Effect.fn("pruneOpenCodeTaskState")(function* (
      context: OpenCodeSessionContext,
    ) {
      const terminalTasks = [...context.childTasksBySessionId.values()].filter(
        (task) => task.terminal,
      );
      for (const task of terminalTasks.slice(0, -OPENCODE_TASK_TOMBSTONE_LIMIT)) {
        context.childTasksBySessionId.delete(task.sessionId);
        context.pendingChildStateBySessionId.delete(task.sessionId);
        yield* forgetOpenCodeChildSession(context, task.sessionId);
        for (const [callId, parentTask] of context.parentTasksByCallId) {
          if (parentTask.childSessionId === task.sessionId) {
            context.parentTasksByCallId.delete(callId);
            rememberEvictedParentCall(context, callId);
          }
        }
      }

      const unboundParentTasks = [...context.parentTasksByCallId.entries()].filter(
        ([, task]) => task.childSessionId === undefined,
      );
      for (const [callId] of unboundParentTasks.slice(0, -OPENCODE_UNBOUND_TASK_LIMIT)) {
        context.parentTasksByCallId.delete(callId);
        rememberEvictedParentCall(context, callId);
      }
    });
    const emitChildTaskStarted = Effect.fn("emitChildTaskStarted")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeChildTask,
      raw: unknown,
    ) {
      if (task.started || task.terminal) {
        return;
      }
      task.started = true;
      task.status = "running";
      task.linkageFingerprint = childTaskFingerprint(task);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: task.turnId,
          raw,
        })),
        type: "task.started",
        payload: {
          taskId: RuntimeTaskId.make(task.sessionId),
          ...(task.title ? { description: task.title } : {}),
          ...childTaskLinkage(context, task),
        },
      });
    });

    const emitChildTaskLinkageUpdate = Effect.fn("emitChildTaskLinkageUpdate")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeChildTask,
      raw: unknown,
    ) {
      if (!task.started || task.terminal) {
        return;
      }
      const fingerprint = childTaskFingerprint(task);
      if (task.linkageFingerprint === fingerprint) {
        return;
      }
      task.linkageFingerprint = fingerprint;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: task.turnId,
          raw,
        })),
        type: "task.updated",
        payload: {
          taskId: RuntimeTaskId.make(task.sessionId),
          ...childTaskLinkage(context, task),
        },
      });
    });

    const emitChildTaskTerminal = Effect.fn("emitChildTaskTerminal")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeChildTask,
      status: "completed" | "failed" | "stopped",
      summary: string | undefined,
      raw: unknown,
    ) {
      if (task.terminal) {
        return;
      }
      const needsStart = !task.started;
      task.terminal = true;
      if (needsStart) {
        task.started = true;
        task.status = "running";
        task.linkageFingerprint = childTaskFingerprint(task);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: task.turnId,
            raw,
          })),
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(task.sessionId),
            ...(task.title ? { description: task.title } : {}),
            ...childTaskLinkage(context, task),
          },
        });
      }
      task.status = status;
      task.toolFingerprints.clear();
      task.textFingerprints.clear();
      task.deltaTextByPartId.clear();
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: task.turnId,
          raw,
        })),
        type: "task.completed",
        payload: {
          taskId: RuntimeTaskId.make(task.sessionId),
          status,
          ...(summary ? { summary } : {}),
          ...(task.typedUsage ? { typedUsage: task.typedUsage } : {}),
          ...childTaskLinkage(context, task),
        },
      });
      yield* pruneOpenCodeTaskState(context);
    });

    /**
     * Settle a task that just became terminal and take its whole descendant
     * subtree with it: every currently live child session beneath it is
     * settled ("stopped" — it did not end on its own) because its ancestor
     * is gone. Breadth-first over a single snapshot, so ancestors settle
     * before descendants and each lifecycle event fires exactly once. The
     * remote aborts are skipped once the session is already tearing down —
     * the teardown abort has the whole pre-settle live set.
     */
    const settleOpenCodeChildTaskTree = Effect.fn("settleOpenCodeChildTaskTree")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeChildTask,
      status: "completed" | "failed" | "stopped",
      summary: string | undefined,
      raw: unknown,
    ) {
      if (task.terminal) {
        return;
      }
      const descendants = liveOpenCodeDescendants(context, task.sessionId);
      yield* emitChildTaskTerminal(context, task, status, summary, raw);
      for (const descendant of descendants.tasks) {
        yield* emitChildTaskTerminal(
          context,
          descendant,
          "stopped",
          summary ?? descendant.latestResult,
          raw,
        );
      }
      for (const descendantSessionId of descendants.sessionIds) {
        context.pendingChildStateBySessionId.delete(descendantSessionId);
        yield* forgetOpenCodeChildSession(context, descendantSessionId);
      }
      if (yield* Ref.get(context.stopped)) {
        return;
      }
      yield* Effect.forEach(
        descendants.sessionIds,
        (descendantSessionId) => abortOpenCodeSessionId(context, descendantSessionId),
        { concurrency: "unbounded", discard: true },
      );
    });

    const finishChildTasksForTurn = Effect.fn("finishChildTasksForTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      status: "completed" | "failed" | "stopped",
      summary: string | undefined,
      raw: unknown,
    ) {
      yield* Effect.forEach(
        context.childTasksBySessionId.values(),
        (task) =>
          task.turnId === turnId && task.backgroundKnown && !task.background && !task.terminal
            ? settleOpenCodeChildTaskTree(context, task, status, summary ?? task.latestResult, raw)
            : Effect.void,
        { discard: true },
      );
    });

    const finishAllChildTasks = Effect.fn("finishAllChildTasks")(function* (
      context: OpenCodeSessionContext,
      status: "completed" | "failed" | "stopped",
      summary: string | undefined,
      raw: unknown,
    ) {
      yield* Effect.forEach(
        context.childTasksBySessionId.values(),
        (task) =>
          task.terminal
            ? Effect.void
            : settleOpenCodeChildTaskTree(context, task, status, summary, raw),
        { discard: true },
      );
    });

    const ensureChildTask = (
      context: OpenCodeSessionContext,
      input: {
        readonly sessionId: string;
        readonly parentSessionId: string;
        readonly turnId: TurnId;
        readonly parentToolUseId?: string;
        readonly title?: string;
        readonly role?: string;
        readonly background?: boolean;
        readonly backgroundKnown?: boolean;
      },
    ): OpenCodeChildTask | undefined => {
      const existing = context.childTasksBySessionId.get(input.sessionId);
      if (existing) {
        if (
          existing.turnId !== input.turnId ||
          existing.parentSessionId !== input.parentSessionId
        ) {
          return undefined;
        }
        if (existing.terminal) {
          return existing;
        }
        if (!existing.parentToolUseId && input.parentToolUseId) {
          existing.parentToolUseId = input.parentToolUseId;
        }
        if (input.title) {
          existing.title = input.title;
        }
        if (input.role) {
          existing.role = input.role;
        }
        existing.background ||= input.background === true;
        existing.backgroundKnown ||= input.backgroundKnown === true;
        return existing;
      }
      const task: OpenCodeChildTask = {
        sessionId: input.sessionId,
        parentSessionId: input.parentSessionId,
        turnId: input.turnId,
        ...(input.parentToolUseId ? { parentToolUseId: input.parentToolUseId } : {}),
        linkageExact: false,
        ...(input.title ? { title: input.title } : {}),
        ...(input.role ? { role: input.role } : {}),
        background: input.background === true,
        backgroundKnown: input.backgroundKnown === true,
        idleObserved: false,
        started: false,
        terminal: false,
        toolFingerprints: new Map(),
        textFingerprints: new Map(),
        deltaTextByPartId: new Map(),
      };
      context.childTasksBySessionId.set(input.sessionId, task);
      return task;
    };

    const bindParentTaskToChild = Effect.fn("bindParentTaskToChild")(function* (
      context: OpenCodeSessionContext,
      parentTask: OpenCodeParentTask,
      childSessionId: string,
      parentSessionId: string,
      exact: boolean,
      resume: boolean,
      raw: unknown,
    ) {
      if (context.evictedChildSessionIds.has(childSessionId)) {
        return undefined;
      }
      // The immediate parent and every ancestor above it: a newly bound child
      // of a dead branch is denied, tombstoned, and aborted.
      if (hasTerminalOpenCodeAncestor(context, parentSessionId)) {
        yield* denyOpenCodeChildSession(context, childSessionId);
        return undefined;
      }
      const existingTask = context.childTasksBySessionId.get(childSessionId);
      if (
        context.strictChildCorrelation &&
        existingTask === undefined &&
        !context.relatedSessionIds.has(childSessionId) &&
        !context.pendingChildStateBySessionId.has(childSessionId)
      ) {
        yield* denyOpenCodeChildSession(context, childSessionId);
        return undefined;
      }
      const conflictingOwners = [...context.parentTasksByCallId].filter(
        ([callId, owner]) =>
          callId !== parentTask.callId && owner.childSessionId === childSessionId,
      );
      if (resume && existingTask?.terminal && parentTask.callId !== existingTask.parentToolUseId) {
        for (const [, owner] of conflictingOwners) {
          delete owner.childSessionId;
        }
        existingTask.parentSessionId = parentSessionId;
        existingTask.turnId = parentTask.turnId;
        existingTask.parentToolUseId = parentTask.callId;
        existingTask.linkageExact = true;
        if (parentTask.title) {
          existingTask.title = parentTask.title;
        }
        if (parentTask.role) {
          existingTask.role = parentTask.role;
        }
        existingTask.background = parentTask.background;
        existingTask.backgroundKnown = parentTask.backgroundKnown;
        existingTask.idleObserved = false;
        delete existingTask.latestResult;
        delete existingTask.typedUsage;
        delete existingTask.usageFingerprint;
        existingTask.terminal = false;
        existingTask.status = "running";
        existingTask.toolFingerprints.clear();
        existingTask.textFingerprints.clear();
        existingTask.deltaTextByPartId.clear();
        existingTask.linkageFingerprint = childTaskFingerprint(existingTask);
        parentTask.childSessionId = childSessionId;
        context.relatedSessionIds.add(childSessionId);
        context.pendingChildStateBySessionId.delete(childSessionId);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId: existingTask.turnId,
            raw,
          })),
          type: "task.updated",
          payload: {
            taskId: RuntimeTaskId.make(existingTask.sessionId),
            status: "running",
            ...childTaskLinkage(context, existingTask),
          },
        });
        return existingTask;
      }
      if (conflictingOwners.length > 0 && (!exact || existingTask?.linkageExact === true)) {
        return undefined;
      }
      const task = ensureChildTask(context, {
        sessionId: childSessionId,
        parentSessionId,
        turnId: parentTask.turnId,
        parentToolUseId: parentTask.callId,
        ...(parentTask.title ? { title: parentTask.title } : {}),
        ...(parentTask.role ? { role: parentTask.role } : {}),
        background: parentTask.background,
        backgroundKnown: parentTask.backgroundKnown,
      });
      if (!task) {
        return undefined;
      }
      // A child answers to one task call at a time. Exact task metadata may
      // correct a same-turn provisional sole-candidate binding by detaching
      // the stale owner and taking over the linkage; every other conflicting
      // claim is refused so two calls never own the same child.
      if (exact && !task.linkageExact) {
        for (const [, owner] of conflictingOwners) {
          delete owner.childSessionId;
        }
        task.parentToolUseId = parentTask.callId;
      }
      task.linkageExact ||= exact;
      parentTask.childSessionId = childSessionId;
      context.relatedSessionIds.add(childSessionId);
      const pending = context.pendingChildStateBySessionId.get(childSessionId);
      context.pendingChildStateBySessionId.delete(childSessionId);
      if (pending && !task.terminal) {
        task.idleObserved ||= pending.idleObserved;
        if (!task.title && pending.title) {
          task.title = pending.title;
        }
        if (pending.latestResult) {
          task.latestResult = pending.latestResult;
        }
      }
      yield* emitChildTaskStarted(context, task, raw);
      yield* emitChildTaskLinkageUpdate(context, task, raw);
      if (pending?.terminal && !task.terminal) {
        yield* settleOpenCodeChildTaskTree(
          context,
          task,
          pending.terminal.status,
          pending.terminal.summary,
          raw,
        );
      } else if (task.background && task.idleObserved && !task.terminal) {
        yield* settleOpenCodeChildTaskTree(context, task, "completed", task.latestResult, raw);
      }
      return task;
    });

    const registerChildSession = Effect.fn("registerChildSession")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
      parentSessionId: string,
      title: string | undefined,
      raw: unknown,
    ) {
      if (context.evictedChildSessionIds.has(sessionId)) {
        return undefined;
      }
      // The immediate parent and every ancestor above it: a discovery under a
      // dead branch — including one whose immediate parent is a live pending
      // child of a terminal task — is denied, tombstoned, and aborted.
      if (hasTerminalOpenCodeAncestor(context, parentSessionId)) {
        yield* denyOpenCodeChildSession(context, sessionId);
        return undefined;
      }
      const parentTask = context.childTasksBySessionId.get(parentSessionId);
      const observedTurnId = parentTask?.turnId ?? context.activeTurnId;
      const candidates = [...context.parentTasksByCallId.values()].filter(
        (task) => task.childSessionId === undefined && task.ownerSessionId === parentSessionId,
      );
      if (
        candidates.length === 1 &&
        observedTurnId !== undefined &&
        candidates[0]!.turnId === observedTurnId
      ) {
        const bound = yield* bindParentTaskToChild(
          context,
          candidates[0]!,
          sessionId,
          parentSessionId,
          false,
          false,
          raw,
        );
        // A refusal from an already-bound child must not re-pend it; only
        // genuinely unbindable discoveries fall through to pending state.
        if (bound !== undefined || context.childTasksBySessionId.has(sessionId)) {
          return bound;
        }
      }
      const remembered = rememberPendingChild(
        context,
        sessionId,
        parentSessionId,
        observedTurnId,
        title && !isOpenCodeDefaultTitle(title) ? title : undefined,
      );
      if (remembered.evictedSessionId) {
        yield* denyOpenCodeChildSession(context, remembered.evictedSessionId);
      }
      return undefined;
    });

    const registerOpenCodeTaskPart = Effect.fn("registerOpenCodeTaskPart")(function* (
      context: OpenCodeSessionContext,
      ownerSessionId: string,
      part: Extract<Part, { type: "tool" }>,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      if (part.tool.toLowerCase() !== "task") {
        return undefined;
      }
      if (context.evictedParentTaskCallIds.has(part.callID)) {
        return undefined;
      }
      const existing = context.parentTasksByCallId.get(part.callID);
      const parentTurnId = existing?.turnId ?? turnId;
      if (!parentTurnId) {
        return undefined;
      }
      const metadata = openCodeTaskMetadata(part);
      if (metadata.parentSessionId && metadata.parentSessionId !== ownerSessionId) {
        return undefined;
      }
      if (existing && existing.ownerSessionId !== ownerSessionId) {
        return undefined;
      }
      const parentTask = existing ?? {
        callId: part.callID,
        ownerSessionId,
        turnId: parentTurnId,
        background: false,
        backgroundKnown: false,
      };
      if (metadata.title) {
        parentTask.title = metadata.title;
      }
      if (metadata.role) {
        parentTask.role = metadata.role;
      }
      parentTask.background ||= metadata.background;
      parentTask.backgroundKnown ||= metadata.backgroundKnown;
      context.parentTasksByCallId.set(part.callID, parentTask);
      yield* pruneOpenCodeTaskState(context);

      let task = parentTask.childSessionId
        ? context.childTasksBySessionId.get(parentTask.childSessionId)
        : undefined;
      if (metadata.childSessionId) {
        task = yield* bindParentTaskToChild(
          context,
          parentTask,
          metadata.childSessionId,
          metadata.parentSessionId ?? ownerSessionId,
          true,
          metadata.resumeSessionId === metadata.childSessionId,
          raw,
        );
      } else if (!task) {
        const candidates = [...context.childTasksBySessionId.values()].filter(
          (candidate) =>
            candidate.parentSessionId === ownerSessionId &&
            candidate.turnId === parentTask.turnId &&
            candidate.parentToolUseId === undefined,
        );
        if (candidates.length === 1) {
          task = yield* bindParentTaskToChild(
            context,
            parentTask,
            candidates[0]!.sessionId,
            ownerSessionId,
            false,
            false,
            raw,
          );
        } else if (candidates.length === 0) {
          const pendingCandidates = [...context.pendingChildStateBySessionId.entries()].filter(
            ([, pending]) =>
              pending.parentSessionId === ownerSessionId &&
              pending.observedTurnId === parentTask.turnId,
          );
          if (pendingCandidates.length === 1) {
            task = yield* bindParentTaskToChild(
              context,
              parentTask,
              pendingCandidates[0]![0],
              ownerSessionId,
              false,
              false,
              raw,
            );
          }
        }
      }
      if (!task) {
        return undefined;
      }
      if (task.terminal) {
        return task;
      }

      if (parentTask.title) {
        task.title = parentTask.title;
      }
      if (parentTask.role) {
        task.role = parentTask.role;
      }
      task.background ||= parentTask.background;
      task.backgroundKnown ||= parentTask.backgroundKnown;
      yield* emitChildTaskLinkageUpdate(context, task, raw);

      const state = recordFromUnknown(part.state);
      const status = stringFromUnknown(state?.status);
      if (status === "error") {
        yield* settleOpenCodeChildTaskTree(
          context,
          task,
          "failed",
          boundedOpenCodeActivityText(state?.error, 1_000),
          raw,
        );
      } else if (task.background && task.idleObserved) {
        yield* settleOpenCodeChildTaskTree(context, task, "completed", task.latestResult, raw);
      } else if (status === "completed" && !task.background) {
        yield* settleOpenCodeChildTaskTree(
          context,
          task,
          "completed",
          boundedOpenCodeActivityText(openCodeTaskOutputText(state?.output), 2_000),
          raw,
        );
      }
      return task;
    });

    const cancelIdleReconciliation = Effect.fn("cancelIdleReconciliation")(function* (
      context: OpenCodeSessionContext,
    ) {
      const pending = context.pendingIdleReconciliation;
      context.pendingIdleReconciliation = undefined;
      if (pending?.fiber) {
        yield* Fiber.interrupt(pending.fiber);
      }
    });

    const completeOpenCodeTurn = Effect.fn("completeOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      promptGeneration: number,
      raw: unknown,
    ) {
      const updatedAt = yield* nowIso;
      const stopped = yield* Ref.get(context.stopped);
      if (
        stopped ||
        context.activeTurnId !== turnId ||
        context.promptGeneration !== promptGeneration ||
        context.cancellation?.turnId === turnId
      ) {
        return;
      }
      const pendingIdleReconciliation = context.pendingIdleReconciliation;
      if (
        pendingIdleReconciliation?.turnId === turnId &&
        pendingIdleReconciliation.promptGeneration === promptGeneration
      ) {
        context.pendingIdleReconciliation = undefined;
      }
      const tokenUsage = takeOpenCodeTurnTokenUsage(context, true);
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.interruptedTurnId = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      for (const requestId of context.autoRepliedRequestIds) {
        context.emittedTerminalRequestIds.add(requestId);
      }
      context.autoRepliedRequestIds.clear();
      applyProviderSessionUpdate(
        context,
        { status: "ready" },
        { clearActiveTurnId: true },
        updatedAt,
      );
      yield* finishChildTasksForTurn(context, turnId, "completed", undefined, raw);
      if (pendingIdleReconciliation?.fiber) {
        yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
      }
      yield* schedulePendingRequestRecovery(context);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.completed",
        payload: {
          state: "completed",
          tokenUsage,
        },
      });
    });

    const scheduleIdleReconciliation = Effect.fn("scheduleIdleReconciliation")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw: unknown,
    ) {
      const existing = context.pendingIdleReconciliation;
      if (existing?.turnId === turnId && existing.promptGeneration === context.promptGeneration) {
        existing.raw = raw;
        existing.dirty = true;
        return;
      }
      yield* cancelIdleReconciliation(context);

      const pending: OpenCodeIdleReconciliation = {
        turnId,
        promptGeneration: context.promptGeneration,
        raw,
        warned: false,
        dirty: false,
      };
      context.pendingIdleReconciliation = pending;
      const reconcile = Effect.gen(function* () {
        let retryCount = 0;
        while (context.pendingIdleReconciliation === pending) {
          if (
            context.activeTurnId !== turnId ||
            context.awaitingBusyAfterInterruption ||
            context.promptGeneration !== pending.promptGeneration
          ) {
            context.pendingIdleReconciliation = undefined;
            return;
          }
          const result = yield* runOpenCodeSdk("session.status", (signal) =>
            context.client.session.status(undefined, { signal }),
          ).pipe(
            Effect.timeout("1 second"),
            Effect.retry({ times: 1 }),
            Effect.match({
              onFailure: (cause) => ({ type: "unknown" as const, cause }),
              onSuccess: (response) => {
                const data = Option.getOrUndefined(decodeOpenCodeSessionStatusMap(response.data));
                if (data === undefined) {
                  return { type: "unknown" as const, cause: undefined };
                }
                const status = data[context.openCodeSessionId];
                if (status === undefined || status.type === "idle") {
                  return { type: "idle" as const };
                }
                if (status.type === "busy" || status.type === "retry") {
                  return { type: "busy" as const };
                }
                return { type: "unknown" as const, cause: undefined };
              },
            }),
          );

          if (
            context.pendingIdleReconciliation !== pending ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== pending.promptGeneration
          ) {
            return;
          }
          if (result.type === "idle") {
            context.pendingIdleReconciliation = undefined;
            yield* completeOpenCodeTurn(context, turnId, pending.promptGeneration, pending.raw);
            return;
          }
          if (result.type === "busy") {
            if (pending.dirty) {
              pending.dirty = false;
              continue;
            }
            context.pendingIdleReconciliation = undefined;
            return;
          }
          if (!pending.warned) {
            pending.warned = true;
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode turn completion is waiting for session status.",
                detail:
                  result.cause === undefined
                    ? "session.status returned missing or invalid status data."
                    : openCodeRuntimeErrorDetail(result.cause),
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          yield* Effect.sleep(`${delayMs} millis`);
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingIdleReconciliation === pending) {
              context.pendingIdleReconciliation = undefined;
            }
          }),
        ),
      );
      pending.fiber = yield* reconcile.pipe(Effect.forkIn(context.sessionScope));
    });

    const failPromptAdmissionRecovery = Effect.fn("failPromptAdmissionRecovery")(function* (
      context: OpenCodeSessionContext,
      promptAdmission: OpenCodePromptAdmission,
    ) {
      if (
        context.promptAdmission !== promptAdmission ||
        context.activeTurnId !== promptAdmission.turnId ||
        context.promptGeneration !== promptAdmission.generation
      ) {
        return;
      }
      const detail =
        "OpenCode accepted the prompt, but T3 Code could not confirm its message or session status.";
      const abortExit = yield* Effect.exit(
        runOpenCodeSdk("session.abort", (signal) =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
        ).pipe(Effect.timeout("1 second")),
      );
      if (Exit.isFailure(abortExit)) {
        yield* emitUnexpectedExit(
          context,
          `${detail} The cleanup abort also failed: ${openCodeRuntimeErrorDetail(Cause.squash(abortExit.cause))}`,
        );
        deleteContextIfCurrent(context);
        return;
      }
      const tokenUsage = takeOpenCodeTurnTokenUsage(context, false);
      context.promptAdmission = undefined;
      context.activeTurnId = undefined;
      context.activeAgent = undefined;
      context.activeVariant = undefined;
      context.awaitingBusyAfterInterruption = false;
      context.reconcileIdleStatus = false;
      yield* updateProviderSession(
        context,
        { status: "error", lastError: detail },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: promptAdmission.turnId,
          raw: promptAdmission.recoveryRaw,
        })),
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: detail,
          tokenUsage,
        },
      });
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: promptAdmission.turnId,
          raw: promptAdmission.recoveryRaw,
        })),
        type: "runtime.error",
        payload: {
          message: detail,
          class: "transport_error",
        },
      });
    });

    const schedulePromptAdmissionRecovery = Effect.fn("schedulePromptAdmissionRecovery")(function* (
      context: OpenCodeSessionContext,
      raw: unknown,
    ) {
      const promptAdmission = context.promptAdmission;
      if (!promptAdmission || promptAdmission.cancelled) {
        return;
      }
      if (raw !== undefined) {
        promptAdmission.recoveryRaw = raw;
      }
      if (promptAdmission.recoveryFiber) {
        return;
      }
      const recover = Effect.gen(function* () {
        yield* Deferred.await(promptAdmission.acceptance);
        for (let retryCount = 0; retryCount < 5; retryCount += 1) {
          if (
            context.promptAdmission !== promptAdmission ||
            context.activeTurnId !== promptAdmission.turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            promptAdmission.cancelled ||
            (yield* Ref.get(context.stopped))
          ) {
            return;
          }

          if (!promptAdmission.messageObserved) {
            const response = yield* runOpenCodeSdk("session.message", (signal) =>
              context.client.session.message(
                {
                  sessionID: context.openCodeSessionId,
                  messageID: promptAdmission.messageId,
                },
                { signal },
              ),
            ).pipe(Effect.timeout("1 second"), Effect.option);
            const stopped = yield* Ref.get(context.stopped);
            if (
              stopped ||
              sessions.get(context.session.threadId) !== context ||
              context.promptAdmission !== promptAdmission ||
              context.activeTurnId !== promptAdmission.turnId ||
              context.promptGeneration !== promptAdmission.generation ||
              promptAdmission.cancelled
            ) {
              return;
            }
            const message = Option.isSome(response) ? response.value.data : undefined;
            if (message?.info.id === promptAdmission.messageId && message.info.role === "user") {
              promptAdmission.messageObserved = true;
              context.messageRoleById.set(promptAdmission.messageId, "user");
              context.textPartsByMessageId.delete(promptAdmission.messageId);
            }
          }

          const statusResponse = yield* runOpenCodeSdk("session.status", (signal) =>
            context.client.session.status(undefined, { signal }),
          ).pipe(Effect.timeout("1 second"), Effect.option);
          const stopped = yield* Ref.get(context.stopped);
          if (
            stopped ||
            sessions.get(context.session.threadId) !== context ||
            context.promptAdmission !== promptAdmission ||
            context.activeTurnId !== promptAdmission.turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            promptAdmission.cancelled
          ) {
            return;
          }
          const statusData = Option.isSome(statusResponse)
            ? Option.getOrUndefined(decodeOpenCodeSessionStatusMap(statusResponse.value.data))
            : undefined;
          const status = statusData?.[context.openCodeSessionId];
          const isIdle =
            statusData !== undefined && (status === undefined || status.type === "idle");
          const isBusy = status?.type === "busy" || status?.type === "retry";
          if (isBusy) {
            promptAdmission.busyObserved = true;
            promptAdmission.idleStatusConfirmations = 0;
            context.awaitingBusyAfterInterruption = false;
            context.promptAdmission = undefined;
            return;
          }

          const idle = promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
          if (
            isIdle &&
            idle !== undefined &&
            (promptAdmission.messageObserved || promptAdmission.busyObserved)
          ) {
            context.promptAdmission = undefined;
            context.awaitingBusyAfterInterruption = false;
            yield* scheduleIdleReconciliation(context, promptAdmission.turnId, idle.raw);
            return;
          }
          if (isIdle && promptAdmission.messageObserved) {
            promptAdmission.idleStatusConfirmations += 1;
            if (promptAdmission.idleStatusConfirmations >= 2) {
              context.promptAdmission = undefined;
              context.awaitingBusyAfterInterruption = false;
              yield* completeOpenCodeTurn(
                context,
                promptAdmission.turnId,
                promptAdmission.generation,
                {
                  type: "session.status.recovered",
                  status: statusData,
                },
              );
              return;
            }
          } else if (!isIdle) {
            promptAdmission.idleStatusConfirmations = 0;
          }
          if (
            isIdle &&
            promptAdmission.messageObserved &&
            promptAdmission.recoveryRaw !== undefined
          ) {
            context.promptAdmission = undefined;
            context.awaitingBusyAfterInterruption = false;
            yield* scheduleIdleReconciliation(
              context,
              promptAdmission.turnId,
              promptAdmission.recoveryRaw,
            );
            return;
          }

          const delayMs = Math.min(250 * 2 ** retryCount, 2_000);
          yield* Effect.sleep(`${delayMs} millis`);
        }
        yield* failPromptAdmissionRecovery(context, promptAdmission);
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            delete promptAdmission.recoveryFiber;
          }),
        ),
      );
      promptAdmission.recoveryFiber = yield* recover.pipe(Effect.forkIn(context.sessionScope));
    });

    const interruptOpenCodeTurn = Effect.fn("interruptOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw?: unknown,
    ) {
      if (context.interruptedTurnId === turnId) {
        return;
      }
      yield* cancelIdleReconciliation(context);
      context.interruptedTurnId = turnId;
      context.reconcileIdleStatus = true;
      context.awaitingBusyAfterInterruption = false;
      const cancellation =
        context.cancellation?.turnId === turnId ? context.cancellation : undefined;
      if (cancellation) {
        context.cancellation = undefined;
      }
      let tokenUsage: TurnTokenUsage = {
        usageStatus: "unavailable",
        usageScope: "main_agent",
        hasSubagents: false,
      };
      if (context.activeTurnId === turnId) {
        tokenUsage = takeOpenCodeTurnTokenUsage(context, false);
        context.activeTurnId = undefined;
        context.activeAgent = undefined;
        context.activeVariant = undefined;
        yield* updateProviderSession(
          context,
          { status: "ready" },
          { clearActiveTurnId: true, clearLastError: true },
        );
      }
      yield* finishChildTasksForTurn(context, turnId, "stopped", "Interrupted by user.", raw);
      yield* clearPendingOpenCodeRequests(context, { type: "session.abort" });
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.aborted",
        payload: {
          reason: "Interrupted by user.",
          tokenUsage,
        },
      });
      if (cancellation) {
        yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
      }
    });

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode session exited before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      yield* failPendingOpenCodeCancellation(
        context,
        "OpenCode session exited during cancellation.",
      );
      context.promptAdmission = undefined;
      const turnId = context.activeTurnId;
      deleteContextIfCurrent(context);
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* finishAllChildTasks(context, "failed", message, undefined).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      // Inline the teardown that `stopOpenCodeContext` would do; we can't
      // delegate to it because our `getAndSet` above already flipped the
      // one-shot guard, so the call would no-op.
      yield* abortOpenCodeSessionForTeardown(context);
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: OpenCodeTextPartState,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      if (part.text === undefined) {
        return;
      }
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(part.emittedText, part.text);
      part.emittedText = latestText;
      part.text = latestText;
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: part.time !== undefined ? isoFromEpochMs(part.time.start) : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (part.type === "text" && part.time?.end !== undefined && !part.completed) {
        part.completed = true;
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    const recordCompactionText = (part: OpenCodeTextPartState) => {
      if (part.text === undefined) {
        return;
      }
      const { latestText } = mergeOpenCodeAssistantText(part.emittedText, part.text);
      part.emittedText = latestText;
      part.text = latestText;
    };

    // Records a child session of this thread. A child seen during a live turn
    // means that turn used subagents, whether the relation came from a
    // `session.created` event or a later ancestry lookup after reconnect.
    const addRelatedOpenCodeSession = (context: OpenCodeSessionContext, sessionId: string) => {
      context.relatedSessionIds.add(sessionId);
      if (context.activeTurnId && context.turnTokenUsage) {
        context.turnTokenUsage.hasSubagents = true;
      }
    };

    const isRelatedOpenCodeSession = Effect.fn("isRelatedOpenCodeSession")(function* (
      context: OpenCodeSessionContext,
      candidateSessionId: string,
    ) {
      if (context.evictedChildSessionIds.has(candidateSessionId)) {
        return false;
      }
      if (context.relatedSessionIds.has(candidateSessionId)) {
        return true;
      }
      if (context.strictChildCorrelation) {
        return false;
      }

      const seen = new Set<string>();
      const getSession = (sessionID: string) =>
        runOpenCodeSdk("session.get", (signal) =>
          context.client.session.get({ sessionID }, { signal }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "10 seconds",
            orElse: () =>
              Effect.fail(
                new OpenCodeRuntimeError({
                  operation: "session.get",
                  detail: "OpenCode session ancestry lookup did not complete within 10 seconds.",
                }),
              ),
          }),
          Effect.catchIf(
            (cause) => isOpenCodeNotFound(cause),
            () => Effect.succeed(undefined),
          ),
        );
      let sessionId: string | undefined = candidateSessionId;
      for (let depth = 0; sessionId !== undefined && depth < 32; depth += 1) {
        if (context.relatedSessionIds.has(sessionId)) {
          addRelatedOpenCodeSession(context, candidateSessionId);
          return true;
        }
        if (seen.has(sessionId)) {
          return false;
        }
        seen.add(sessionId);
        const currentSessionId: string = sessionId;
        const response = yield* getSession(currentSessionId);
        if (response === undefined) {
          return false;
        }
        if (!response.data) {
          return yield* new OpenCodeRuntimeError({
            operation: "session.get",
            detail: `OpenCode session.get returned no session payload for '${currentSessionId}'.`,
          });
        }
        sessionId = response.data.parentID;
      }
      return false;
    });

    const openPermissionRequest = Effect.fn("openPermissionRequest")(function* (
      context: OpenCodeSessionContext,
      request: PermissionRequest,
      raw: unknown,
      requestTurnId: TurnId | undefined = context.activeTurnId,
    ) {
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: requestTurnId,
        requestId: request.id,
        raw,
      });
      const stopped = yield* Ref.get(context.stopped);
      if (
        stopped ||
        context.emittedTerminalRequestIds.has(request.id) ||
        context.pendingPermissions.has(request.id)
      ) {
        return;
      }
      const patterns = request.patterns.filter((pattern) => pattern !== "*");
      const detail =
        request.permission === "bash" && patterns.length > 0
          ? patterns.join("\n")
          : [request.permission.replaceAll("_", " "), ...patterns].join("\n");
      context.autoRepliedRequestIds.delete(request.id);
      context.pendingPermissions.set(request.id, request);
      if (requestTurnId) {
        context.requestTurnById.set(request.id, requestTurnId);
      }
      emitUnsafe({
        ...base,
        type: "request.opened",
        payload: {
          requestType: mapPermissionToRequestType(request.permission),
          detail,
          args: request.metadata,
          options: [
            { decision: "accept", label: "Allow once" },
            {
              decision: "acceptForSession",
              label: "Allow for workspace",
              warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
            },
            { decision: "decline", label: "Deny" },
          ],
        },
      });
    });

    // Full access means the user already granted everything, but two upstream
    // paths never consult the session ruleset we send: doom-loop detection
    // (evaluated against the agent ruleset only) and subagent sessions (which
    // keep only deny and external-directory rules). Answer those asks here.
    //
    // Reply "once", not "always": OpenCode stores "always" grants per
    // directory, so on a shared external server an "always" from a full-access
    // thread would silently widen what a supervised thread on the same
    // directory is allowed to do.
    const autoReplyFullAccess = Effect.fn("autoReplyFullAccess")(function* (
      context: OpenCodeSessionContext,
      request: PermissionRequest,
      raw: unknown,
    ) {
      const replied = yield* runOpenCodeSdk("permission.reply", (signal) =>
        context.client.permission.reply({ requestID: request.id, reply: "once" }, { signal }),
      ).pipe(
        Effect.timeout("10 seconds"),
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!replied) {
        // Fall back to the dialog. The id stays resolved so a recovered copy
        // of this ask cannot reopen after the user answers;
        // `pendingPermissions` gates re-asks while the dialog is open.
        yield* openPermissionRequest(context, request, raw);
      }
    });

    const emitPendingOpenCodeRequest = Effect.fn("emitPendingOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeAskedRequestEvent,
      raw: unknown,
    ) {
      if (context.resolvedRequestIds.has(event.properties.id)) {
        return;
      }
      const requestTurnId =
        context.childTasksBySessionId.get(event.properties.sessionID)?.turnId ??
        context.pendingChildStateBySessionId.get(event.properties.sessionID)?.observedTurnId ??
        (event.properties.sessionID === context.openCodeSessionId
          ? context.activeTurnId
          : undefined);
      if (context.activeTurnId === undefined && context.reconcileIdleStatus) {
        context.resolvedRequestIds.add(event.properties.id);
        return;
      }
      if (event.type === "permission.asked") {
        const request = event.properties;
        if (context.pendingPermissions.has(request.id)) {
          return;
        }
        if (context.session.runtimeMode === "full-access") {
          // Reply outside the event pump so a slow HTTP response cannot hide
          // progress, terminal replies, or the acknowledgment for Stop.
          context.resolvedRequestIds.add(request.id);
          context.autoRepliedRequestIds.add(request.id);
          yield* autoReplyFullAccess(context, request, raw).pipe(
            Effect.forkIn(context.sessionScope),
          );
          return;
        }
        yield* openPermissionRequest(context, request, raw, requestTurnId);
        return;
      }

      const request = event.properties;
      if (context.pendingQuestions.has(request.id)) {
        return;
      }
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: requestTurnId,
        requestId: request.id,
        raw,
      });
      const stopped = yield* Ref.get(context.stopped);
      if (stopped || context.resolvedRequestIds.has(request.id)) {
        return;
      }
      context.pendingQuestions.set(request.id, request);
      if (requestTurnId) {
        context.requestTurnById.set(request.id, requestTurnId);
      }
      emitUnsafe({
        ...base,
        type: "user-input.requested",
        payload: { questions: normalizeQuestionRequest(request) },
      });
    });

    const resolvePendingOpenCodeRequest = Effect.fn("resolvePendingOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      requestId: string,
    ) {
      rememberRequestTombstone(context.resolvedRequestIds, requestId);
      const retry = context.requestRelationRetries.get(requestId);
      context.requestRelationRetries.delete(requestId);
      if (retry?.fiber) {
        yield* Fiber.interrupt(retry.fiber);
      }
    });

    const emitTerminalOpenCodeRequest = Effect.fn("emitTerminalOpenCodeRequest")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeTerminalRequestEvent,
      raw: unknown = event,
    ) {
      const requestId = event.properties.requestID;
      if (context.emittedTerminalRequestIds.has(requestId)) {
        return;
      }
      rememberRequestTombstone(context.emittedTerminalRequestIds, requestId);
      const requestTurnId =
        context.requestTurnById.get(requestId) ??
        context.childTasksBySessionId.get(event.properties.sessionID)?.turnId ??
        context.pendingChildStateBySessionId.get(event.properties.sessionID)?.observedTurnId ??
        (event.properties.sessionID === context.openCodeSessionId
          ? context.activeTurnId
          : undefined);
      if (context.autoRepliedRequestIds.delete(requestId)) {
        return;
      }
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: requestTurnId,
        requestId,
        raw,
      });
      if (event.type === "permission.replied") {
        const request = context.pendingPermissions.get(requestId);
        context.pendingPermissions.delete(requestId);
        emitUnsafe({
          ...base,
          type: "request.resolved",
          payload: {
            requestType: request ? mapPermissionToRequestType(request.permission) : "unknown",
            decision: mapPermissionDecision(event.properties.reply),
          },
        });
        context.requestTurnById.delete(requestId);
        return;
      }

      const request = context.pendingQuestions.get(requestId);
      context.pendingQuestions.delete(requestId);
      const answers =
        event.type === "question.replied" && request
          ? Object.fromEntries(
              request.questions.map((question, index) => [
                openCodeQuestionId(index, question),
                event.properties.answers[index]?.join(", ") ?? "",
              ]),
            )
          : {};
      emitUnsafe({
        ...base,
        type: "user-input.resolved",
        payload: { answers },
      });
      context.requestTurnById.delete(requestId);
    });

    const closePendingOpenCodeRequests = Effect.fn("closePendingOpenCodeRequests")(function* (
      context: OpenCodeSessionContext,
      permissions: ReadonlyArray<PermissionRequest>,
      questions: ReadonlyArray<QuestionRequest>,
      raw: unknown,
    ) {
      for (const request of permissions) {
        if (!context.pendingPermissions.has(request.id)) continue;
        yield* resolvePendingOpenCodeRequest(context, request.id);
        const base = yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: request.id,
          raw,
        });
        if (context.emittedTerminalRequestIds.has(request.id)) continue;
        context.pendingPermissions.delete(request.id);
        context.emittedTerminalRequestIds.add(request.id);
        emitUnsafe({
          ...base,
          type: "request.resolved",
          payload: { requestType: mapPermissionToRequestType(request.permission) },
        });
      }
      for (const request of questions) {
        if (!context.pendingQuestions.has(request.id)) continue;
        yield* resolvePendingOpenCodeRequest(context, request.id);
        const base = yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: request.id,
          raw,
        });
        if (context.emittedTerminalRequestIds.has(request.id)) continue;
        context.pendingQuestions.delete(request.id);
        context.emittedTerminalRequestIds.add(request.id);
        emitUnsafe({ ...base, type: "user-input.resolved", payload: { answers: {} } });
      }
    });

    const clearPendingOpenCodeRequests = Effect.fn("clearPendingOpenCodeRequests")(function* (
      context: OpenCodeSessionContext,
      raw: unknown,
    ) {
      context.pendingRequestRecovery = undefined;
      for (const requestId of context.requestRelationRetries.keys()) {
        yield* resolvePendingOpenCodeRequest(context, requestId);
      }
      for (const requestId of context.autoRepliedRequestIds) {
        context.emittedTerminalRequestIds.add(requestId);
      }
      context.autoRepliedRequestIds.clear();
      yield* closePendingOpenCodeRequests(
        context,
        [...context.pendingPermissions.values()],
        [...context.pendingQuestions.values()],
        raw,
      );
    });

    const scheduleRequestRelationRetry = Effect.fn("scheduleRequestRelationRetry")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeRoutedRequestEvent,
      raw: unknown = event,
    ) {
      const isAskedEvent = event.type === "permission.asked" || event.type === "question.asked";
      const requestId = isAskedEvent ? event.properties.id : event.properties.requestID;
      if (context.requestRelationRetries.has(requestId)) {
        return;
      }
      if (isAskedEvent && context.resolvedRequestIds.has(requestId)) {
        return;
      }
      const retry: OpenCodeRequestRelationRetry = {
        warned: false,
        sessionID: event.properties.sessionID,
      };
      context.requestRelationRetries.set(requestId, retry);
      const run = Effect.gen(function* () {
        let retryCount = 0;
        while (context.requestRelationRetries.get(requestId) === retry) {
          const relation = yield* isRelatedOpenCodeSession(
            context,
            event.properties.sessionID,
          ).pipe(
            Effect.match({
              onFailure: (cause) => ({ type: "unknown" as const, cause }),
              onSuccess: (related) => ({ type: "known" as const, related }),
            }),
          );
          if (context.requestRelationRetries.get(requestId) !== retry) {
            return;
          }
          if (relation.type === "known") {
            context.requestRelationRetries.delete(requestId);
            if (relation.related) {
              if (isAskedEvent) {
                yield* emitPendingOpenCodeRequest(context, event, raw);
              } else {
                yield* emitTerminalOpenCodeRequest(context, event);
              }
            }
            return;
          }
          if (!retry.warned) {
            retry.warned = true;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                requestId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode request routing is waiting for session ancestry.",
                detail: openCodeRuntimeErrorDetail(relation.cause),
              },
            });
          }
          const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
          retryCount += 1;
          if (!isAskedEvent && retryCount >= 5) {
            return;
          }
          yield* Effect.sleep(`${delayMs} millis`);
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.requestRelationRetries.get(requestId) === retry) {
              context.requestRelationRetries.delete(requestId);
            }
          }),
        ),
      );
      retry.fiber = yield* run.pipe(Effect.forkIn(context.sessionScope));
    });

    const schedulePendingRequestRecovery = Effect.fn("schedulePendingRequestRecovery")(function* (
      context: OpenCodeSessionContext,
    ) {
      if (context.pendingRequestRecovery) {
        context.pendingRequestRecovery.rerun = true;
        return;
      }
      const recovery: OpenCodePendingRequestRecovery = { warned: false, rerun: false };
      context.pendingRequestRecovery = recovery;
      const run = Effect.gen(function* () {
        let retryCount = 0;
        while (context.pendingRequestRecovery === recovery) {
          // Only requests pending before the snapshot can be closed by it.
          const priorPermissions = [...context.pendingPermissions.values()];
          const priorQuestions = [...context.pendingQuestions.values()];
          const responses = yield* Effect.all(
            {
              permissions: runOpenCodeSdk("permission.list", (signal) =>
                context.client.permission.list(undefined, { signal }),
              ),
              questions: runOpenCodeSdk("question.list", (signal) =>
                context.client.question.list(undefined, { signal }),
              ),
            },
            { concurrency: 2 },
          ).pipe(
            Effect.timeout("10 seconds"),
            Effect.match({
              onFailure: (cause) => ({ type: "failure" as const, cause }),
              onSuccess: (value) => ({ type: "success" as const, value }),
            }),
          );
          if (context.pendingRequestRecovery !== recovery) {
            return;
          }
          if (responses.type === "failure") {
            if (!recovery.warned) {
              recovery.warned = true;
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.session.threadId })),
                type: "runtime.warning",
                payload: {
                  message: "OpenCode pending request recovery failed and will retry.",
                  detail: openCodeRuntimeErrorDetail(responses.cause),
                },
              });
            }
            const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
            retryCount += 1;
            yield* Effect.sleep(`${delayMs} millis`);
            continue;
          }
          const permissions = responses.value.permissions.data;
          const questions = responses.value.questions.data;
          if (permissions === undefined || questions === undefined) {
            if (!recovery.warned) {
              recovery.warned = true;
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.session.threadId })),
                type: "runtime.warning",
                payload: {
                  message: "OpenCode pending request recovery returned no data and will retry.",
                },
              });
            }
            const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
            retryCount += 1;
            yield* Effect.sleep(`${delayMs} millis`);
            continue;
          }
          const permissionIds = new Set(permissions.map((request) => request.id));
          const questionIds = new Set(questions.map((request) => request.id));
          yield* closePendingOpenCodeRequests(
            context,
            priorPermissions.filter((request) => !permissionIds.has(request.id)),
            priorQuestions.filter((request) => !questionIds.has(request.id)),
            { type: "pending-requests.recovered" },
          );
          yield* Effect.forEach(
            permissions,
            (request) =>
              scheduleRequestRelationRetry(
                context,
                { id: `recovered:${request.id}`, type: "permission.asked", properties: request },
                { type: "permission.asked", properties: request, recovered: true },
              ),
            { discard: true },
          );
          yield* Effect.forEach(
            questions,
            (request) =>
              scheduleRequestRelationRetry(
                context,
                { id: `recovered:${request.id}`, type: "question.asked", properties: request },
                { type: "question.asked", properties: request, recovered: true },
              ),
            { discard: true },
          );
          if (recovery.rerun) {
            recovery.rerun = false;
            recovery.warned = false;
            continue;
          }
          context.pendingRequestRecovery = undefined;
          return;
        }
      }).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (context.pendingRequestRecovery === recovery) {
              context.pendingRequestRecovery = undefined;
            }
          }),
        ),
      );
      yield* run.pipe(Effect.forkIn(context.sessionScope));
    });

    const emitChildTaskStatus = Effect.fn("emitChildTaskStatus")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeChildTask,
      status: "running" | "waiting",
      raw: unknown,
    ) {
      if (task.terminal || task.status === status) {
        return;
      }
      yield* emitChildTaskStarted(context, task, raw);
      task.status = status;
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: task.turnId,
          raw,
        })),
        type: "task.updated",
        payload: {
          taskId: RuntimeTaskId.make(task.sessionId),
          status,
          ...childTaskLinkage(context, task),
        },
      });
    });

    const emitChildTaskProgress = Effect.fn("emitChildTaskProgress")(function* (
      context: OpenCodeSessionContext,
      task: OpenCodeChildTask,
      summary: string | undefined,
      raw: unknown,
    ) {
      if (task.terminal) {
        return;
      }
      yield* emitChildTaskStarted(context, task, raw);
      task.status = "running";
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: task.turnId,
          raw,
        })),
        type: "task.progress",
        payload: {
          taskId: RuntimeTaskId.make(task.sessionId),
          description: task.title ?? "Subagent task",
          ...(summary ? { summary } : {}),
          ...(task.typedUsage ? { typedUsage: task.typedUsage } : {}),
          status: "running",
          ...childTaskLinkage(context, task),
        },
      });
    });

    const bufferPendingChildEvent = (
      context: OpenCodeSessionContext,
      sessionId: string,
      event: OpenCodeSubscribedEvent,
    ): void => {
      const pending = context.pendingChildStateBySessionId.get(sessionId);
      if (!pending) {
        return;
      }
      switch (event.type) {
        case "session.status":
          if (event.properties.status.type === "idle") {
            pending.idleObserved = true;
          } else if (
            event.properties.status.type === "busy" ||
            event.properties.status.type === "retry"
          ) {
            pending.idleObserved = false;
          }
          break;
        case "session.error": {
          const summary = boundedOpenCodeActivityText(
            sessionErrorMessage(event.properties.error),
            1_000,
          );
          pending.terminal = {
            status: isOpenCodeAbortError(event.properties.error) ? "stopped" : "failed",
            ...(summary ? { summary } : {}),
          };
          break;
        }
        case "session.deleted":
          pending.terminal = {
            status: "stopped",
            summary: "OpenCode child session ended.",
          };
          break;
        case "message.part.updated": {
          const part = event.properties.part;
          if (part.type === "text") {
            // Child text parts can carry a provider-owned task envelope:
            // OpenCode's task tool injects its `renderOutput` envelope as a
            // text part on the invoking session when a background subagent
            // settles. Keep only the inner result in buffered state.
            const latestResult = boundedOpenCodeActivityText(
              openCodeTaskOutputText(part.text),
              2_000,
            );
            if (latestResult) {
              pending.latestResult = latestResult;
            }
          }
          break;
        }
        default:
          break;
      }
    };

    const handleChildSessionEvent = Effect.fn("handleChildSessionEvent")(function* (
      context: OpenCodeSessionContext,
      sessionId: string,
      event: OpenCodeSubscribedEvent,
    ) {
      const task = context.childTasksBySessionId.get(sessionId);
      if (!task) {
        bufferPendingChildEvent(context, sessionId, event);
        return;
      }
      if (task.terminal) {
        if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (part.type === "tool" && part.tool.toLowerCase() === "task") {
            const metadata = openCodeTaskMetadata(part);
            if (
              metadata.childSessionId &&
              !context.evictedChildSessionIds.has(metadata.childSessionId) &&
              (metadata.parentSessionId === undefined || metadata.parentSessionId === sessionId)
            ) {
              yield* denyOpenCodeChildSession(context, metadata.childSessionId);
            }
          }
        }
        return;
      }
      switch (event.type) {
        case "session.status": {
          if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
            task.idleObserved = false;
            yield* emitChildTaskStatus(context, task, "running", event);
          } else if (event.properties.status.type === "idle") {
            task.idleObserved = true;
            if (task.background) {
              yield* settleOpenCodeChildTaskTree(
                context,
                task,
                "completed",
                task.latestResult,
                event,
              );
            }
          }
          break;
        }
        case "session.error": {
          const aborted = isOpenCodeAbortError(event.properties.error);
          yield* settleOpenCodeChildTaskTree(
            context,
            task,
            aborted ? "stopped" : "failed",
            boundedOpenCodeActivityText(sessionErrorMessage(event.properties.error), 1_000),
            event,
          );
          break;
        }
        case "session.deleted": {
          yield* settleOpenCodeChildTaskTree(
            context,
            task,
            "stopped",
            "OpenCode child session ended.",
            event,
          );
          break;
        }
        case "message.part.delta": {
          // Accumulate fragments per part so the progress row carries the
          // text so far — mirroring the complete snapshots the
          // `message.part.updated` path emits — instead of replacing it with
          // each raw token fragment.
          const previousDeltaText = task.deltaTextByPartId.get(event.properties.partID) ?? "";
          const { nextText } = appendOpenCodeAssistantTextDelta(
            previousDeltaText,
            event.properties.delta,
          );
          const snapshot = boundOpenCodeChildDeltaText(nextText);
          if (!snapshot) {
            break;
          }
          setBoundedMapValue(
            task.deltaTextByPartId,
            event.properties.partID,
            snapshot,
            OPENCODE_CHILD_FINGERPRINT_LIMIT,
          );
          const summary = boundedOpenCodeActivityText(snapshot, 180);
          if (!summary) {
            break;
          }
          const fingerprint = `delta\u0000${summary}`;
          if (task.textFingerprints.get(event.properties.partID) === fingerprint) {
            break;
          }
          setBoundedMapValue(
            task.textFingerprints,
            event.properties.partID,
            fingerprint,
            OPENCODE_CHILD_FINGERPRINT_LIMIT,
          );
          yield* emitChildTaskProgress(context, task, summary, event);
          break;
        }
        case "message.part.updated": {
          const part = event.properties.part;
          if (part.type === "tool" && part.tool.toLowerCase() === "task") {
            yield* registerOpenCodeTaskPart(context, sessionId, part, task.turnId, event);
          }
          if (part.type === "tool") {
            const inputSummary = summarizeOpenCodeToolInput(part.tool, part.state.input);
            const state = recordFromUnknown(part.state);
            const summary = boundedOpenCodeActivityText(
              part.state.status === "error"
                ? state?.error
                : (inputSummary ?? state?.title ?? part.tool),
              180,
            );
            const fingerprint = [part.state.status, summary ?? ""].join("\u0000");
            if (task.toolFingerprints.get(part.callID) === fingerprint || task.terminal) {
              break;
            }
            setBoundedMapValue(
              task.toolFingerprints,
              part.callID,
              fingerprint,
              OPENCODE_CHILD_FINGERPRINT_LIMIT,
            );
            yield* emitChildTaskStarted(context, task, event);
            yield* emitChildTaskStatus(context, task, "running", event);
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: task.turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type: "tool.progress",
              payload: {
                taskId: RuntimeTaskId.make(task.sessionId),
                toolUseId: part.callID,
                toolName: part.tool,
                ...(summary ? { summary } : {}),
              },
            });
            break;
          }
          const text = textFromPart(part);
          // Child text parts can carry a provider-owned task envelope (see
          // upstream `renderOutput`/`inject`): unwrap a whole envelope so
          // progress rows and the settled result hold the inner text, while
          // plain child text and malformed markup pass through untouched.
          const normalizedText = text === undefined ? undefined : openCodeTaskOutputText(text);
          // A snapshot is the authoritative full text so far: seed/replace
          // the delta accumulator so the next `message.part.delta` continues
          // from it instead of restarting from empty text and emitting a raw
          // fragment. An empty snapshot is an authoritative replacement too:
          // it resets that part's accumulator so a following delta starts
          // fresh instead of extending stale text.
          if (normalizedText !== undefined) {
            if (normalizedText.length > 0) {
              setBoundedMapValue(
                task.deltaTextByPartId,
                part.id,
                boundOpenCodeChildDeltaText(normalizedText),
                OPENCODE_CHILD_FINGERPRINT_LIMIT,
              );
            } else {
              task.deltaTextByPartId.delete(part.id);
            }
          }
          const summary = boundedOpenCodeActivityText(normalizedText, 180);
          const latestResult =
            part.type === "text" ? boundedOpenCodeActivityText(normalizedText, 2_000) : undefined;
          const fingerprint = latestResult ?? summary;
          if (!summary || !fingerprint || task.textFingerprints.get(part.id) === fingerprint) {
            break;
          }
          if (latestResult) {
            task.latestResult = latestResult;
          }
          setBoundedMapValue(
            task.textFingerprints,
            part.id,
            fingerprint,
            OPENCODE_CHILD_FINGERPRINT_LIMIT,
          );
          yield* emitChildTaskProgress(context, task, summary, event);
          break;
        }
        case "message.updated": {
          // OpenCode overwrites the token snapshot as the child works: zero
          // at activation, cumulative while running, sometimes smaller at a
          // step boundary. The best-known usage only grows (field-wise max),
          // and the fingerprint of the merged value — not the raw snapshot —
          // gates emission, so lower or repeated snapshots stay silent. The
          // merge state resets when a child is adopted into a new activation.
          if (event.properties.info.role !== "assistant") {
            break;
          }
          const usage = normalizeOpenCodeChildUsage(event.properties.info.tokens);
          if (!usage || openCodeChildUsageIsZero(usage)) {
            break;
          }
          const merged = task.typedUsage ? mergeOpenCodeChildUsage(task.typedUsage, usage) : usage;
          const fingerprint = openCodeChildUsageFingerprint(merged);
          if (task.usageFingerprint === fingerprint) {
            break;
          }
          task.typedUsage = merged;
          task.usageFingerprint = fingerprint;
          yield* emitChildTaskProgress(context, task, undefined, event);
          break;
        }
        default:
          break;
      }
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      if (yield* Ref.get(context.stopped)) {
        if (event.type === "session.created" || event.type === "session.updated") {
          const session = event.properties.info;
          // During teardown a discovered child is denied and tombstoned; the
          // bounded tombstone set is the teardown ancestry, so a grandchild
          // parented to an already-denied late discovery is denied too.
          if (
            session.id !== context.openCodeSessionId &&
            session.parentID &&
            (context.relatedSessionIds.has(session.parentID) ||
              context.evictedChildSessionIds.has(session.parentID))
          ) {
            yield* denyOpenCodeChildSession(context, session.id);
          }
        } else if (event.type === "message.part.updated") {
          const part = event.properties.part;
          if (part.type === "tool" && part.tool.toLowerCase() === "task") {
            const metadata = openCodeTaskMetadata(part);
            const parentSessionId = metadata.parentSessionId ?? event.properties.sessionID;
            if (
              metadata.childSessionId &&
              (context.relatedSessionIds.has(parentSessionId) ||
                context.evictedChildSessionIds.has(parentSessionId)) &&
              !context.evictedChildSessionIds.has(metadata.childSessionId)
            ) {
              yield* denyOpenCodeChildSession(context, metadata.childSessionId);
            }
          }
        }
        return;
      }
      if (event.type === "server.connected") {
        if (
          (yield* Ref.get(context.stopped)) ||
          sessions.get(context.session.threadId) !== context
        ) {
          return;
        }
        const isFirstConnection = !(yield* Deferred.isDone(context.firstConnection));
        if (isFirstConnection) {
          const updatedAt = yield* nowIso;
          if (
            (yield* Ref.get(context.stopped)) ||
            sessions.get(context.session.threadId) !== context
          ) {
            return;
          }
          applyProviderSessionUpdate(context, { status: "ready" }, undefined, updatedAt);
          if (!(yield* Deferred.succeed(context.firstConnection, undefined))) {
            return;
          }
        }
        yield* schedulePendingRequestRecovery(context);
        if (!isFirstConnection) {
          if (context.turnTokenUsage) {
            context.turnTokenUsage.complete = false;
          }
          yield* schedulePromptAdmissionRecovery(context, event);
          if (context.activeTurnId !== undefined && context.promptAdmission === undefined) {
            yield* scheduleIdleReconciliation(context, context.activeTurnId, event);
          }
        }
        return;
      }
      const terminalRequestId =
        event.type === "permission.replied" ||
        event.type === "question.replied" ||
        event.type === "question.rejected"
          ? event.properties.requestID
          : undefined;
      if (
        terminalRequestId !== undefined &&
        context.resolvedRequestIds.has(terminalRequestId) &&
        !context.pendingPermissions.has(terminalRequestId) &&
        !context.pendingQuestions.has(terminalRequestId) &&
        !context.autoRepliedRequestIds.has(terminalRequestId)
      ) {
        return;
      }
      if (terminalRequestId !== undefined) {
        yield* resolvePendingOpenCodeRequest(context, terminalRequestId);
      }
      if (event.type === "session.created" || event.type === "session.updated") {
        const session = event.properties.info;
        if (
          session.parentID &&
          context.evictedChildSessionIds.has(session.parentID) &&
          !context.evictedChildSessionIds.has(session.id)
        ) {
          yield* denyOpenCodeChildSession(context, session.id);
        } else if (
          session.parentID &&
          context.relatedSessionIds.has(session.parentID) &&
          !context.evictedChildSessionIds.has(session.id)
        ) {
          if (
            !context.strictChildCorrelation ||
            context.relatedSessionIds.has(session.id) ||
            context.childTasksBySessionId.get(session.id)?.linkageExact === true
          ) {
            addRelatedOpenCodeSession(context, session.id);
            yield* registerChildSession(
              context,
              session.id,
              session.parentID,
              boundedOpenCodeActivityText(session.title, 240),
              event,
            );
          }
        }
      }

      const payloadSessionId = openCodeEventSessionId(event);
      const isParentEvent = payloadSessionId === context.openCodeSessionId;
      let isKnownPendingTerminalEvent = false;
      if (
        payloadSessionId !== undefined &&
        !context.relatedSessionIds.has(payloadSessionId) &&
        isOpenCodeChildRequestEvent(event)
      ) {
        if (event.type === "permission.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (event.type === "question.asked") {
          yield* scheduleRequestRelationRetry(context, event);
        } else if (
          event.type === "permission.replied" ||
          event.type === "question.replied" ||
          event.type === "question.rejected"
        ) {
          const requestId = event.properties.requestID;
          isKnownPendingTerminalEvent =
            context.pendingPermissions.has(requestId) || context.pendingQuestions.has(requestId);
          if (!isKnownPendingTerminalEvent) {
            yield* scheduleRequestRelationRetry(context, event);
            return;
          }
        }
      }
      const isChildRequestEvent =
        payloadSessionId !== undefined &&
        isOpenCodeChildRequestEvent(event) &&
        (context.relatedSessionIds.has(payloadSessionId) || isKnownPendingTerminalEvent);
      const isRelatedChildEvent =
        payloadSessionId !== undefined &&
        payloadSessionId !== context.openCodeSessionId &&
        context.relatedSessionIds.has(payloadSessionId);
      if (!isParentEvent && !isRelatedChildEvent && !isChildRequestEvent) {
        return;
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          ...(!isParentEvent && payloadSessionId ? { childSessionId: payloadSessionId } : {}),
          payload: event,
        },
      });

      if (isRelatedChildEvent && !isOpenCodeChildRequestEvent(event)) {
        yield* handleChildSessionEvent(context, payloadSessionId, event);
        if (event.type === "session.deleted") {
          context.relatedSessionIds.delete(payloadSessionId);
        }
        return;
      }

      const suppressInterruptedParentOutput =
        isParentEvent &&
        ((context.activeTurnId === undefined &&
          (context.interruptedTurnId !== undefined || context.reconcileIdleStatus)) ||
          context.awaitingBusyAfterInterruption) &&
        (event.type === "message.part.delta" ||
          event.type === "message.part.updated" ||
          event.type === "todo.updated" ||
          (event.type === "message.updated" && event.properties.info.role === "assistant"));
      if (suppressInterruptedParentOutput) {
        return;
      }

      switch (event.type) {
        case "session.updated": {
          const title = openCodeEventSessionTitle(event);
          if (title) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                raw: event,
              })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCodeSessionId,
                },
              },
            });
          }
          break;
        }
        case "session.compacted": {
          const detail = [...context.compactionMessageIds]
            .flatMap((messageId) => [
              ...(context.textPartsByMessageId.get(messageId)?.values() ?? []),
            ])
            .filter(
              (part) => part.type === "text" && context.compactionMessageIds.has(part.messageID),
            )
            .map((part) => trimText(part.emittedText ?? part.text))
            .filter((text): text is string => text !== undefined)
            .join("\n\n");
          context.compactionMessageIds.clear();
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "thread.state.changed",
            payload: {
              state: "compacted",
              detail: detail.length > 0 ? detail : event,
            },
          });
          break;
        }

        case "message.updated": {
          const message = event.properties.info;
          const promptAdmission = context.promptAdmission;
          if (message.role === "user" && promptAdmission?.messageId === message.id) {
            promptAdmission.messageObserved = true;
            if (promptAdmission.accepted) {
              const idle = promptAdmission.idleDuringAdmission;
              context.awaitingBusyAfterInterruption = false;
              context.promptAdmission = undefined;
              if (promptAdmission.recoveryFiber) {
                yield* Fiber.interrupt(promptAdmission.recoveryFiber);
              }
              if (idle) {
                yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
              }
            }
          }
          context.messageRoleById.set(message.id, message.role);
          if (message.role === "user") {
            context.textPartsByMessageId.delete(message.id);
          }
          const isCompaction = isOpenCodeCompactionMessage(message);
          if (isCompaction) {
            if (!context.compactionMessageIds.has(message.id)) {
              context.compactionMessageIds.clear();
            }
            context.compactionMessageIds.add(message.id);
          }
          if (message.role === "assistant") {
            const usage = context.turnTokenUsage;
            const parentMessageId =
              typeof message.parentID === "string" && message.parentID.trim().length > 0
                ? message.parentID
                : undefined;
            const observedOwnership =
              parentMessageId === undefined
                ? "unknown"
                : usage?.promptMessageIds.has(parentMessageId)
                  ? "owned"
                  : "other";
            const priorOwnership = usage?.assistantOwnershipByMessageId.get(message.id);
            const ownership =
              priorOwnership === undefined || priorOwnership === "unknown"
                ? observedOwnership
                : priorOwnership;
            if (usage) {
              usage.assistantOwnershipByMessageId.set(message.id, ownership);
              if (ownership !== "unknown") {
                const steps = usage.unresolvedStepsByMessageId.get(message.id);
                if (ownership === "owned" && steps) {
                  for (const step of steps.values()) {
                    accumulateOpenCodeStepUsage(usage, step);
                  }
                }
                usage.unresolvedStepsByMessageId.delete(message.id);
              }
            }
            for (const part of context.textPartsByMessageId.get(message.id)?.values() ?? []) {
              if (isCompaction) {
                recordCompactionText(part);
              } else {
                yield* emitAssistantTextDelta(context, part, turnId, event);
              }
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          context.compactionMessageIds.delete(event.properties.messageID);
          context.textPartsByMessageId.delete(event.properties.messageID);
          break;
        }

        case "message.part.removed": {
          const parts = context.textPartsByMessageId.get(event.properties.messageID);
          parts?.delete(event.properties.partID);
          if (parts?.size === 0) {
            context.textPartsByMessageId.delete(event.properties.messageID);
          }
          break;
        }

        case "message.part.delta": {
          const existingPart = context.textPartsByMessageId
            .get(event.properties.messageID)
            ?.get(event.properties.partID);
          if (existingPart?.text === undefined || event.properties.field !== "text") {
            break;
          }
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role === undefined) {
            existingPart.text = appendOpenCodeAssistantTextDelta(existingPart.text, delta).nextText;
            break;
          }
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const previousText = existingPart.emittedText ?? existingPart.text;
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          existingPart.emittedText = nextText;
          existingPart.text = nextText;
          if (context.compactionMessageIds.has(existingPart.messageID)) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          const messageRole = messageRoleForPart(context, part);

          if (turnId && part.type === "step-finish" && context.turnTokenUsage) {
            const usage = context.turnTokenUsage;
            const ownership = usage.assistantOwnershipByMessageId.get(part.messageID);
            if (ownership === "owned") {
              accumulateOpenCodeStepUsage(usage, part);
            } else if (
              ownership === "unknown" ||
              (ownership === undefined &&
                context.messageRoleById.get(part.messageID) !== "assistant")
            ) {
              const steps =
                usage.unresolvedStepsByMessageId.get(part.messageID) ??
                new Map<string, OpenCodeStepUsage>();
              steps.set(part.id, { id: part.id, tokens: part.tokens });
              usage.unresolvedStepsByMessageId.set(part.messageID, steps);
            }
          }

          if ((part.type === "text" || part.type === "reasoning") && messageRole !== "user") {
            const state = retainOpenCodeTextPart(context, part);
            if (messageRole === "assistant") {
              if (context.compactionMessageIds.has(part.messageID)) {
                recordCompactionText(state);
              } else {
                yield* emitAssistantTextDelta(context, state, turnId, event);
              }
            }
          } else {
            const previous = context.textPartsByMessageId.get(part.messageID)?.get(part.id);
            if (previous) {
              // A non-text PATCH removes the current snapshot. Keep emitted text
              // so a later text PATCH still emits only the changed suffix.
              previous.text = undefined;
            }
          }

          if (part.type === "tool") {
            if (part.tool.toLowerCase() === "task") {
              const childTask = yield* registerOpenCodeTaskPart(
                context,
                context.openCodeSessionId,
                part,
                turnId,
                event,
              );
              // The shared child lifecycle represents the call once correlated,
              // and an uncorrelated in-flight row may still correlate; an
              // uncorrelated terminal row falls through as a normal item.
              if (
                childTask ||
                (part.state.status !== "completed" && part.state.status !== "error")
              ) {
                break;
              }
              if (part.state.status === "error") {
                context.parentTasksByCallId.delete(part.callID);
              }
            }
            const itemType = toToolLifecycleItemType(part.tool);
            const familyTitle = toolTitleFamily(part.tool);
            const nativeRunningTitle =
              part.state.status === "running" ? trimText(part.state.title) : undefined;
            const title =
              familyTitle === part.tool ? (nativeRunningTitle ?? part.tool) : familyTitle;
            const detail = (() => {
              if (part.state.status === "error") {
                return part.state.error;
              }
              const inputDetail = summarizeOpenCodeToolInput(part.tool, part.state.input);
              if (part.state.status !== "completed") {
                return inputDetail ?? nativeRunningTitle;
              }
              return (
                inputDetail ??
                (hidesCompletedToolOutput(part.tool) ? undefined : trimText(part.state.output))
              );
            })();
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
                ...(typeof part.state.input.command === "string"
                  ? { command: part.state.input.command }
                  : {}),
                ...(itemType === "file_change" ? { input: part.state.input } : {}),
                ...(part.state.status === "completed" &&
                (itemType === "command_execution" || itemType === "mcp_tool_call")
                  ? { result: part.state.output }
                  : {}),
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        }

        case "permission.replied": {
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "question.asked": {
          yield* emitPendingOpenCodeRequest(context, event, event);
          break;
        }

        case "question.replied": {
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "question.rejected": {
          yield* emitTerminalOpenCodeRequest(context, event);
          break;
        }

        case "todo.updated": {
          if (turnId === undefined) break;
          const base = yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            raw: event,
          });
          // Session-wide task updates must not reopen progress after a turn ends.
          if (context.activeTurnId !== turnId) break;
          emitUnsafe({
            ...base,
            type: "turn.plan.updated",
            payload: {
              plan: event.properties.todos
                .filter((todo) => todo.status !== "cancelled")
                .map((todo) => ({
                  step: trimText(todo.content) ?? "Task",
                  status:
                    todo.status === "completed"
                      ? "completed"
                      : todo.status === "in_progress"
                        ? "inProgress"
                        : "pending",
                })),
            },
          });
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
            if (turnId === undefined) {
              break;
            }
            yield* cancelIdleReconciliation(context);
            context.awaitingBusyAfterInterruption = false;
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.busyObserved = true;
              yield* schedulePromptAdmissionRecovery(context, event);
            }
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "runtime.warning",
              payload: {
                message: `OpenCode retry ${event.properties.status.attempt}: ${event.properties.status.message}`,
                detail: event.properties.status,
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId) {
            if (context.cancellation?.turnId === turnId) {
              context.cancellation.deferredIdleEvent = event;
              break;
            }
            if (context.promptAdmission?.turnId === turnId) {
              context.promptAdmission.idleDuringAdmission = { turnId, raw: event };
              context.promptAdmission.idleObservedAfterMessage =
                context.promptAdmission.messageObserved;
              yield* schedulePromptAdmissionRecovery(context, event);
              break;
            }
            if (context.awaitingBusyAfterInterruption) {
              break;
            }
            if (context.reconcileIdleStatus) {
              yield* scheduleIdleReconciliation(context, turnId, event);
              break;
            }
            yield* completeOpenCodeTurn(context, turnId, context.promptGeneration, event);
          }
          break;
        }

        case "session.error": {
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          const cancellation = context.cancellation;
          if (isOpenCodeAbortError(event.properties.error)) {
            if (cancellation !== undefined && cancellation.turnId === undefined) {
              cancellation.acknowledged = true;
              yield* Deferred.succeed(cancellation.acknowledgment, undefined).pipe(Effect.ignore);
              break;
            }
            if (activeTurnId !== undefined && cancellation?.turnId === activeTurnId) {
              cancellation.acknowledged = true;
              yield* Deferred.succeed(cancellation.acknowledgment, undefined).pipe(Effect.ignore);
              break;
            }
            if (context.interruptedTurnId !== undefined || context.reconcileIdleStatus) {
              break;
            }
          }
          yield* cancelIdleReconciliation(context);
          if (activeTurnId) {
            yield* finishChildTasksForTurn(context, activeTurnId, "failed", message, event);
          }
          const terminalCancellation =
            activeTurnId !== undefined && cancellation?.turnId === activeTurnId
              ? cancellation
              : undefined;
          if (terminalCancellation) {
            terminalCancellation.turnSettled = true;
            terminalCancellation.acknowledged = true;
          }
          const tokenUsage = activeTurnId ? takeOpenCodeTurnTokenUsage(context, false) : undefined;
          context.activeTurnId = undefined;
          context.activeAgent = undefined;
          context.activeVariant = undefined;
          context.reconcileIdleStatus = false;
          yield* schedulePendingRequestRecovery(context);
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
                tokenUsage,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: event.properties.error,
            },
          });
          if (terminalCancellation) {
            yield* Deferred.succeed(terminalCancellation.acknowledgment, undefined).pipe(
              Effect.ignore,
            );
          }
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      let lastStreamError: unknown;
      let warnedAboutDisconnect = false;
      const streamErrors = yield* Queue.unbounded<unknown>();
      yield* Scope.addFinalizer(context.sessionScope, Queue.shutdown(streamErrors));
      yield* Stream.fromQueue(streamErrors).pipe(
        Stream.runForEach((cause) =>
          Effect.gen(function* () {
            if (warnedAboutDisconnect) return;
            warnedAboutDisconnect = true;
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: context.activeTurnId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode connection lost. Reconnecting.",
                detail: openCodeRuntimeErrorDetail(cause),
              },
            });
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
            onSseError: (cause) => {
              lastStreamError = cause;
              Queue.offerUnsafe(streamErrors, cause);
            },
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(
            Stream.runForEach((event) => {
              if (event.type === "server.connected") lastStreamError = undefined;
              if (event.type === "server.connected") warnedAboutDisconnect = false;
              return handleSubscribedEvent(context, event);
            }),
          ),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            yield* emitUnexpectedExit(
              context,
              Exit.isFailure(exit)
                ? openCodeRuntimeErrorDetail(Cause.squash(exit.cause))
                : lastStreamError !== undefined
                  ? `OpenCode event stream disconnected: ${openCodeRuntimeErrorDetail(lastStreamError)}`
                  : "OpenCode event stream ended unexpectedly. Send another message to reconnect.",
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
      // Scope finalizers run in reverse order. Abort the pending read before
      // interrupting the pump, whose iterator.return() waits for that read.
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          if (existing.session.status === "connecting" && !(yield* Ref.get(existing.stopped))) {
            return (yield* awaitOpenCodeContextReady(existing)).session;
          }
          yield* stopOpenCodeContext(existing);
          deleteContextIfCurrent(existing);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                directory,
                serverUrl,
                ...(serverPassword ? { serverPassword } : {}),
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
              });
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              if (mcpSession && !server.external) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    name: "t3-code",
                    config: {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: {
                        Authorization: mcpSession.authorizationHeader,
                      },
                      oauth: false,
                    },
                  }),
                );
              }
              // Resume: re-adopt the session named by the durable cursor —
              // OpenCode scopes history by session id. The probe recovers only
              // a confirmed not-found (start fresh); transport/auth/server
              // errors propagate instead of masking as a new empty session.
              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", () =>
                      client.session.get({ sessionID: resumeSessionId }),
                    ).pipe(
                      Effect.map((response) => response.data),
                      Effect.catchIf(
                        (cause) => isOpenCodeNotFound(cause),
                        () => Effect.void,
                      ),
                    )
                  : undefined;

                // Reuse in place only when the session still matches the
                // requested cwd; on a cwd change it is forked below instead.
                const reusable =
                  adopted &&
                  (!adopted.directory || (yield* sameDirectory(adopted.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  // Resume skips `session.create`, so re-assert the ruleset —
                  // a runtime-mode change would otherwise leave the session on
                  // its original permissions.
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: reusable.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: reusable, created: false };
                }

                // The session lives under a different cwd (e.g. the thread
                // moved into a git worktree). Fork it into the requested
                // directory instead of minting an empty one — the fork carries
                // the full history, so the follow-up keeps its context (#3604).
                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forkedSession = yield* runOpenCodeSdk("session.fork", () =>
                    client.session.fork({ sessionID: adopted.id, directory }),
                  );
                  const forked = forkedSession.data;
                  if (!forked) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.fork",
                      detail: "OpenCode session.fork returned no session payload.",
                    });
                  }
                  yield* runOpenCodeSdk("session.update", () =>
                    client.session.update({
                      sessionID: forked.id,
                      permission: buildOpenCodePermissionRules(input.runtimeMode),
                    }),
                  );
                  return { openCodeSession: forked, created: true };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createdSession = yield* runOpenCodeSdk("session.create", () =>
                  client.session.create({
                    ...(input.title ? { title: input.title } : {}),
                    permission: buildOpenCodePermissionRules(input.runtimeMode),
                  }),
                );
                if (!createdSession.data) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.create",
                    detail: "OpenCode session.create returned no session payload.",
                  });
                }
                return { openCodeSession: createdSession.data, created: true };
              });

              return {
                sessionScope,
                server,
                client,
                openCodeSession: resolved.openCodeSession,
                created: resolved.created,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          // ProviderService persists this cursor and feeds it back into
          // `startSession` after the in-memory session is lost (reaper /
          // restart), so follow-ups continue the same conversation (#3604).
          resumeCursor: {
            schemaVersion: OPENCODE_RESUME_VERSION,
            sessionId: started.openCodeSession.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          relatedSessionIds: new Set([started.openCodeSession.id]),
          parentTasksByCallId: new Map(),
          childTasksBySessionId: new Map(),
          pendingChildStateBySessionId: new Map(),
          evictedChildSessionIds: new Set(),
          strictChildCorrelation: false,
          evictedParentTaskCallIds: new Set(),
          resolvedRequestIds: new Set(),
          autoRepliedRequestIds: new Set(),
          emittedTerminalRequestIds: new Set(),
          requestRelationRetries: new Map(),
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          requestTurnById: new Map(),
          textPartsByMessageId: new Map(),
          messageRoleById: new Map(),
          compactionMessageIds: new Set(),
          turnTokenUsage: undefined,
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          cancellation: undefined,
          interruptedTurnId: undefined,
          reconcileIdleStatus: false,
          awaitingBusyAfterInterruption: false,
          pendingIdleReconciliation: undefined,
          pendingRequestRecovery: undefined,
          promptGeneration: 0,
          promptAdmission: undefined,
          promptSemaphore: Semaphore.makeUnsafe(1),
          firstConnection: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        context.settleChildTasksOnStop = () =>
          finishAllChildTasks(context, "stopped", "OpenCode session stopped.", undefined).pipe(
            Effect.ignore,
          );
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          // Another start published first. A newly created remote session
          // belongs to this loser; a resumed session is shared upstream state.
          yield* closeStartingOpenCodeContext(context, started.created);
          return (yield* awaitOpenCodeContextReady(raceWinner)).session;
        }
        sessions.set(input.threadId, context);
        const cleanupStartingContext = closeStartingOpenCodeContext(context, started.created).pipe(
          Effect.ensuring(Effect.sync(() => deleteContextIfCurrent(context))),
        );
        const connectionExit = yield* Effect.gen(function* () {
          yield* startEventPump(context);
          yield* Deferred.await(context.firstConnection).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "event.subscribe",
                  detail: "OpenCode event stream did not connect within 10 seconds.",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.onInterrupt(() => cleanupStartingContext),
          Effect.exit,
        );
        if (Exit.isFailure(connectionExit)) {
          yield* cleanupStartingContext;
          return yield* Effect.failCause(connectionExit.cause);
        }
        yield* awaitOpenCodeContextReady(context);
        if (!started.created) {
          yield* schedulePendingRequestRecovery(context);
        }

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return context.session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      yield* awaitOpenCodeContextReady(context);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      // OpenCode ingests images, text, and PDFs natively; attachment paths are
      // passed as file parts rather than embedded in the prompt text.
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      return yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          const freshTurnId = TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
          const messageId = yield* makeOpenCodeMessageId();
          const pendingCancellation = context.cancellation;
          if (pendingCancellation) {
            const cancellationResult = yield* Deferred.await(pendingCancellation.completion).pipe(
              Effect.result,
            );
            if ((yield* Ref.get(context.stopped)) || sessions.get(input.threadId) !== context) {
              return yield* Effect.interrupt;
            }
            if (cancellationResult._tag === "Failure") {
              return yield* cancellationResult.failure;
            }
          }
          if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* Effect.interrupt;
          }
          // A sendTurn while a turn is active is a steer. OpenCode queues the
          // prompt into the running session, so the active turn id is reused.
          const steeringTurnId = context.activeTurnId;
          const turnId = steeringTurnId ?? freshTurnId;
          const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
          const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
          const verbosity = getModelSelectionStringOptionValue(modelSelection, "verbosity");
          const pendingIdleReconciliation = context.pendingIdleReconciliation;
          const priorAwaitingBusy = context.awaitingBusyAfterInterruption;
          const priorIdleCandidate = pendingIdleReconciliation
            ? {
                turnId: pendingIdleReconciliation.turnId,
                raw: pendingIdleReconciliation.raw,
              }
            : undefined;
          context.pendingIdleReconciliation = undefined;
          const promptGeneration = context.promptGeneration + 1;
          const promptAdmission: OpenCodePromptAdmission = {
            generation: promptGeneration,
            turnId,
            messageId,
            priorAwaitingBusy,
            priorIdle: priorIdleCandidate,
            idleDuringAdmission: undefined,
            idleObservedAfterMessage: false,
            messageObserved: false,
            busyObserved: false,
            idleStatusConfirmations: 0,
            accepted: false,
            cancelled: false,
            acceptance: Deferred.makeUnsafe<void>(),
            submissionSettled: Deferred.makeUnsafe<void>(),
            recoveryRaw: undefined,
          };
          context.promptGeneration = promptGeneration;
          context.promptAdmission = promptAdmission;

          context.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            context.turnTokenUsage = makeOpenCodeTurnTokenUsageAccumulator();
          }
          context.turnTokenUsage?.promptMessageIds.add(messageId);
          context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
          context.activeVariant = variant;
          if (steeringTurnId === undefined) {
            context.awaitingBusyAfterInterruption = context.interruptedTurnId !== undefined;
          }
          if (pendingIdleReconciliation?.fiber) {
            yield* Fiber.interrupt(pendingIdleReconciliation.fiber);
          }
          yield* updateProviderSession(
            context,
            {
              status: "running",
              activeTurnId: turnId,
              model: modelSelection?.model ?? context.session.model,
            },
            { clearLastError: true },
          );

          if (steeringTurnId === undefined) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.started",
              payload: {
                model: modelSelection?.model ?? context.session.model,
              },
            });
          }

          if (promptAdmission.cancelled || (yield* Ref.get(context.stopped))) {
            yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
              Effect.ignore,
            );
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            return yield* Effect.interrupt;
          }

          let promptTimedOut = false;
          const promptEffect = runOpenCodeSdk("session.promptAsync", (signal) =>
            context.client.session.promptAsync(
              {
                sessionID: context.openCodeSessionId,
                messageID: messageId,
                model: parsedModel,
                ...(context.activeAgent ? { agent: context.activeAgent } : {}),
                ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                ...(verbosity ? { verbosity } : {}),
                // OpenCode appends this after its own agent/provider prompts.
                system: buildRuntimeInstructions({
                  harness: "OpenCode",
                  model: `${parsedModel.providerID}/${parsedModel.modelID}`,
                }),
                parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
              },
              { signal },
            ),
          ).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) => {
                promptTimedOut = true;
                return Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.promptAsync",
                    detail: "OpenCode prompt submission did not complete within 10 seconds.",
                    cause,
                  }),
                );
              },
            }),
            Effect.tapError((requestError) =>
              context.promptAdmission !== promptAdmission || context.activeTurnId !== turnId
                ? Effect.void
                : Effect.gen(function* () {
                    if (!promptTimedOut) {
                      if (steeringTurnId !== undefined) {
                        context.promptAdmission = undefined;
                        context.awaitingBusyAfterInterruption = promptAdmission.priorAwaitingBusy;
                        const idle =
                          promptAdmission.idleDuringAdmission ?? promptAdmission.priorIdle;
                        if (idle) {
                          yield* scheduleIdleReconciliation(context, idle.turnId, idle.raw);
                        }
                        return;
                      }
                      const tokenUsage = takeOpenCodeTurnTokenUsage(context, false);
                      context.promptAdmission = undefined;
                      context.activeTurnId = undefined;
                      context.activeAgent = undefined;
                      context.activeVariant = undefined;
                      yield* updateProviderSession(
                        context,
                        {
                          status: "ready",
                          model: modelSelection?.model ?? context.session.model,
                          lastError: requestError.detail,
                        },
                        { clearActiveTurnId: true },
                      );
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "turn.aborted",
                        payload: {
                          reason: requestError.detail,
                          tokenUsage,
                        },
                      });
                      return;
                    }
                    const cleanupExit = yield* Effect.exit(
                      runOpenCodeSdk("session.abort", (signal) =>
                        context.client.session.abort(
                          { sessionID: context.openCodeSessionId },
                          { signal },
                        ),
                      ).pipe(Effect.timeout("1 second")),
                    );
                    if (Exit.isFailure(cleanupExit)) {
                      yield* emit({
                        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
                        type: "runtime.warning",
                        payload: {
                          message:
                            "OpenCode prompt submission failed and its cleanup abort did not complete.",
                          detail: openCodeRuntimeErrorDetail(Cause.squash(cleanupExit.cause)),
                        },
                      });
                      yield* schedulePromptAdmissionRecovery(context, {
                        requestError,
                        cleanupError: Cause.squash(cleanupExit.cause),
                      });
                      return;
                    }
                    const tokenUsage = takeOpenCodeTurnTokenUsage(context, false);
                    context.promptAdmission = undefined;
                    context.activeTurnId = undefined;
                    context.activeAgent = undefined;
                    context.activeVariant = undefined;
                    context.awaitingBusyAfterInterruption = false;
                    context.reconcileIdleStatus = false;
                    yield* updateProviderSession(
                      context,
                      {
                        status: "ready",
                        model: modelSelection?.model ?? context.session.model,
                        lastError: requestError.detail,
                      },
                      { clearActiveTurnId: true },
                    );
                    yield* emit({
                      ...(yield* buildEventBase({
                        threadId: input.threadId,
                        turnId,
                      })),
                      type: "turn.aborted",
                      payload: {
                        reason: requestError.detail,
                        tokenUsage,
                      },
                    });
                  }),
            ),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(promptAdmission.submissionSettled, undefined).pipe(
                  Effect.ignore,
                );
                if (Exit.isFailure(exit)) {
                  yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(
                    Effect.ignore,
                  );
                }
              }),
            ),
            Effect.asVoid,
          );
          const promptFiber = yield* promptEffect.pipe(Effect.forkIn(context.sessionScope));
          promptAdmission.promptFiber = promptFiber;
          const promptExit = yield* Effect.exit(Fiber.join(promptFiber));
          delete promptAdmission.promptFiber;

          const intentionallyCancelled =
            promptAdmission.cancelled ||
            (yield* Ref.get(context.stopped)) ||
            sessions.get(input.threadId) !== context;
          if (Exit.isFailure(promptExit) && !intentionallyCancelled) {
            return yield* Effect.failCause(promptExit.cause);
          }
          const cancelled =
            intentionallyCancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation;
          if (cancelled) {
            const cancellation = context.cancellation;
            if (cancellation?.turnId === turnId) {
              yield* Deferred.await(cancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }
          promptAdmission.accepted = true;
          yield* Deferred.succeed(promptAdmission.acceptance, undefined).pipe(Effect.ignore);
          if (
            context.promptAdmission === promptAdmission &&
            context.activeTurnId === turnId &&
            context.promptGeneration === promptAdmission.generation &&
            promptAdmission.messageObserved
          ) {
            context.awaitingBusyAfterInterruption = false;
            const idle = promptAdmission.idleDuringAdmission;
            if (idle && !promptAdmission.idleObservedAfterMessage) {
              yield* schedulePromptAdmissionRecovery(context, idle.raw);
            } else {
              context.promptAdmission = undefined;
            }
            if (idle && promptAdmission.idleObservedAfterMessage) {
              yield* scheduleIdleReconciliation(context, turnId, idle.raw);
            }
          } else {
            yield* schedulePromptAdmissionRecovery(context, promptAdmission.recoveryRaw);
          }

          const stopped = yield* Ref.get(context.stopped);
          const finalCancellation = context.cancellation;
          if (
            stopped ||
            sessions.get(input.threadId) !== context ||
            promptAdmission.cancelled ||
            context.activeTurnId !== turnId ||
            context.promptGeneration !== promptAdmission.generation ||
            finalCancellation?.turnId === turnId
          ) {
            if (finalCancellation?.turnId === turnId) {
              yield* Deferred.await(finalCancellation.completion).pipe(Effect.result);
            }
            if (context.promptAdmission === promptAdmission) {
              context.promptAdmission = undefined;
            }
            return yield* Effect.interrupt;
          }

          return {
            threadId: input.threadId,
            turnId,
            // Re-surface the durable cursor on every turn so the persisted binding
            // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        }),
      );
    });

    const compactThread = Effect.fn("compactThread")(function* (
      threadId: ThreadId,
      requestedModelSelection?: ProviderSendTurnInput["modelSelection"],
    ) {
      const context = yield* ensureSessionContext(sessions, threadId);
      yield* awaitOpenCodeContextReady(context);
      const modelSelection =
        requestedModelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "compactThread",
          issue: `OpenCode model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "compactThread",
          issue: "OpenCode compaction requires an active 'provider/model' selection.",
        });
      }
      yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          if (sessions.get(threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* Effect.interrupt;
          }
          if (context.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "compactThread",
              issue: "OpenCode cannot compact while a turn is running.",
            });
          }
          yield* runOpenCodeSdk("session.summarize", (signal) =>
            context.client.session.summarize(
              {
                sessionID: context.openCodeSessionId,
                ...parsedModel,
                auto: false,
              },
              { signal },
            ),
          ).pipe(
            Effect.timeout("10 minutes"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.summarize",
                    detail: "OpenCode session compaction did not complete within 10 minutes.",
                    cause,
                  }),
                ),
            }),
            Effect.asVoid,
          );
        }),
      );
    });
    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const activeTurnId = context.activeTurnId;
        if (turnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        yield* cancelIdleReconciliation(context);
        if (interruptedTurnId && context.interruptedTurnId === interruptedTurnId) {
          return;
        }
        const existingCancellation = context.cancellation;
        if (existingCancellation !== undefined) {
          return yield* Deferred.await(existingCancellation.completion);
        }
        const cancellation: OpenCodeCancellation = {
          turnId: interruptedTurnId,
          acknowledgment: Deferred.makeUnsafe<void>(),
          completion: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
        };
        context.cancellation = cancellation;
        const promptAdmission = context.promptAdmission;
        if (promptAdmission !== undefined && promptAdmission.turnId === interruptedTurnId) {
          promptAdmission.cancelled = true;
          if (promptAdmission.promptFiber) {
            yield* Fiber.interrupt(promptAdmission.promptFiber);
          }
          yield* Deferred.await(promptAdmission.submissionSettled);
        }

        const parentAbortOutcome = yield* Effect.raceFirst(
          runOpenCodeSdk("session.abort", (signal) =>
            context.client.session.abort({ sessionID: context.openCodeSessionId }, { signal }),
          ).pipe(
            Effect.asVoid,
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.abort",
                    detail: "OpenCode session abort did not complete within 10 seconds.",
                    cause,
                  }),
                ),
            }),
            Effect.exit,
            Effect.map((exit) => ({ source: "request" as const, exit })),
          ),
          Effect.raceFirst(
            Deferred.await(cancellation.acknowledgment).pipe(
              Effect.map(() => ({ source: "acknowledgment" as const })),
            ),
            Deferred.await(cancellation.completion).pipe(
              Effect.exit,
              Effect.map((exit) => ({ source: "completion" as const, exit })),
            ),
          ),
        );
        if (parentAbortOutcome.source === "completion") {
          return Exit.isFailure(parentAbortOutcome.exit)
            ? yield* Effect.failCause(parentAbortOutcome.exit.cause)
            : undefined;
        }
        const parentAbortExit =
          parentAbortOutcome.source === "request" ? parentAbortOutcome.exit : Exit.void;

        const descendantAbortOutcome = yield* Effect.raceFirst(
          abortOpenCodeDescendants(context).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.abort",
                    detail: "OpenCode child session cleanup did not complete within 10 seconds.",
                    cause,
                  }),
                ),
            }),
            Effect.exit,
            Effect.map((exit) => ({ source: "request" as const, exit })),
          ),
          Deferred.await(cancellation.completion).pipe(
            Effect.exit,
            Effect.map((exit) => ({ source: "completion" as const, exit })),
          ),
        );
        if (descendantAbortOutcome.source === "completion") {
          return Exit.isFailure(descendantAbortOutcome.exit)
            ? yield* Effect.failCause(descendantAbortOutcome.exit.cause)
            : undefined;
        }

        const parentAbortFailed = Exit.isFailure(parentAbortExit) && !cancellation.acknowledged;
        const failedExit = parentAbortFailed
          ? parentAbortExit
          : Exit.isFailure(descendantAbortOutcome.exit)
            ? descendantAbortOutcome.exit
            : undefined;
        if (failedExit !== undefined && Exit.isFailure(failedExit)) {
          if (context.cancellation === cancellation) {
            context.cancellation = undefined;
            if (
              parentAbortFailed &&
              cancellation.turnId !== undefined &&
              cancellation.deferredIdleEvent
            ) {
              yield* scheduleIdleReconciliation(
                context,
                cancellation.turnId,
                cancellation.deferredIdleEvent,
              );
            }
          }
          yield* Deferred.done(cancellation.completion, failedExit).pipe(Effect.ignore);
          return yield* Effect.failCause(failedExit.cause);
        }

        if (context.cancellation === cancellation) {
          if (cancellation.turnSettled) {
            context.cancellation = undefined;
          } else if (cancellation.turnId !== undefined) {
            yield* interruptOpenCodeTurn(context, cancellation.turnId);
          } else {
            context.cancellation = undefined;
            context.reconcileIdleStatus = true;
            yield* clearPendingOpenCodeRequests(context, { type: "session.abort" });
          }
        }
        yield* Deferred.succeed(cancellation.completion, undefined).pipe(Effect.ignore);
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingPermissions.get(requestId);
      if (!request) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail:
            context.pendingRequestRecovery || context.requestRelationRetries.has(requestId)
              ? "OpenCode is still loading this permission request. Try again."
              : `Unknown pending permission request: ${requestId}`,
        });
      }

      const reply = toOpenCodePermissionReply(decision);
      yield* runOpenCodeSdk("permission.reply", (signal) =>
        context.client.permission.reply(
          {
            requestID: requestId,
            reply,
          },
          { signal },
        ),
      ).pipe(
        Effect.mapError(toRequestError),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "permission.reply",
                detail: "OpenCode permission reply did not complete within 10 seconds.",
              }),
            ),
        }),
      );
      yield* resolvePendingOpenCodeRequest(context, requestId);
      yield* emitTerminalOpenCodeRequest(
        context,
        {
          id: `reply:${requestId}`,
          type: "permission.replied",
          properties: { sessionID: request.sessionID, requestID: requestId, reply },
        },
        { type: "permission.reply", requestID: requestId, reply },
      );
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail:
            context.pendingRequestRecovery || context.requestRelationRetries.has(requestId)
              ? "OpenCode is still loading this question. Try again."
              : `Unknown pending user-input request: ${requestId}`,
        });
      }

      const questionAnswers = toOpenCodeQuestionAnswers(request, answers);
      yield* runOpenCodeSdk("question.reply", (signal) =>
        context.client.question.reply(
          {
            requestID: requestId,
            answers: questionAnswers,
          },
          { signal },
        ),
      ).pipe(
        Effect.mapError(toRequestError),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "question.reply",
                detail: "OpenCode question reply did not complete within 10 seconds.",
              }),
            ),
        }),
      );
      yield* resolvePendingOpenCodeRequest(context, requestId);
      yield* emitTerminalOpenCodeRequest(
        context,
        {
          id: `reply:${requestId}`,
          type: "question.replied",
          properties: {
            sessionID: request.sessionID,
            requestID: requestId,
            answers: questionAnswers,
          },
        },
        { type: "question.reply", requestID: requestId },
      );
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        deleteContextIfCurrent(context);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const session = yield* runOpenCodeSdk("session.get", () =>
          context.client.session.get({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns: Array<OpenCodeTurnSnapshot> = [];
        for (const entry of messages.data ?? []) {
          if (entry.info.id === session.data?.revert?.messageID) break;
          if (entry.info.role === "assistant") {
            turns.push({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            });
          }
        }

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const snapshot = yield* readThread(threadId);
        const targetIndex = Math.max(0, snapshot.turns.length - numTurns);
        const target = snapshot.turns[targetIndex];
        if (target) {
          yield* runOpenCodeSdk("session.revert", () =>
            context.client.session.revert({
              sessionID: context.openCodeSessionId,
              messageID: target.id,
            }),
          ).pipe(Effect.mapError(toRequestError));
          // Native revert can move the boundary to the preceding user message.
          return yield* readThread(threadId);
        }

        return snapshot;
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK aborts are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        turnSteering: "supported",
      },
      startSession,
      sendTurn,
      compaction: { type: "native", start: compactThread },
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
