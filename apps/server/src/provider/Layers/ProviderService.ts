/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EventId,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  RuntimeRequestId,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  ThreadId,
  TurnId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { causeErrorTag } from "@t3tools/shared/observability";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveProjectAgentBrowserAccess } from "@t3tools/shared/serverSettings";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderInstanceNotFoundError,
  ProviderSessionDirectoryPersistenceError,
  ProviderSessionNotFoundError,
  ProviderSessionSupersededError,
  ProviderUnsupportedError,
  type ProviderAdapterError,
  type ProviderServiceError,
  ProviderValidationError,
  ProviderWorkspaceMissingError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as ProviderRuntimeDelivery from "./ProviderRuntimeDelivery.ts";
import * as ProviderSessionOperations from "./ProviderSessionOperations.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
const isModelSelection = Schema.is(ModelSelection);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterSessionClosedError = Schema.is(ProviderAdapterSessionClosedError);
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isProviderInstanceNotFoundError = Schema.is(ProviderInstanceNotFoundError);
const isProviderSessionDirectoryPersistenceError = Schema.is(
  ProviderSessionDirectoryPersistenceError,
);
const isProviderSessionNotFoundError = Schema.is(ProviderSessionNotFoundError);
const isProviderSessionSupersededError = Schema.is(ProviderSessionSupersededError);
const isProviderUnsupportedError = Schema.is(ProviderUnsupportedError);
const isProviderValidationError = Schema.is(ProviderValidationError);
const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);

/** Carries a typed consumer failure through the delivery controller's homogeneous error channel. */
class ProviderRuntimeConsumerFailure extends Data.TaggedError("ProviderRuntimeConsumerFailure")<{
  readonly cause: unknown;
}> {}

type ProviderRuntimeDeliveryError = ProviderServiceError | ProviderRuntimeConsumerFailure;

/** How long a manual context compaction may run before ProviderService gives up on it. */
const COMPACTION_COMPLETION_TIMEOUT = "10 minutes";
const STOP_ALL_METADATA_TIMEOUT = "2 seconds";
const STOP_ALL_PROVIDER_TIMEOUT = "10 seconds";
const STOP_ALL_START_DRAIN_TIMEOUT = "10 seconds";
const STOP_ALL_METADATA_CONCURRENCY = 4;

interface PendingCompaction {
  readonly completion: Deferred.Deferred<string>;
  readonly native: boolean;
  readonly providerInstanceId: ProviderInstanceId;
  readonly source: ProviderRuntimeDelivery.ProviderRuntimeSource;
  readonly requestId: MessageId | undefined;
  readonly earlyEvents: ProviderRuntimeEvent[];
  compactedEventObserved: boolean;
  expectedTurnId: TurnId | undefined;
}

type ProviderRuntimeSource = ProviderRuntimeDelivery.ProviderRuntimeSource;

interface SubscribedAdapterRecord {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly source: ProviderRuntimeSource;
}

type StopSessionTarget = {
  readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
  readonly source: ProviderRuntimeSource;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly runtimeMode: ProviderSession["runtimeMode"] | undefined;
  readonly isActive: boolean;
  readonly hasBinding: boolean;
};

type StopSessionResolution = {
  readonly target: StopSessionTarget | undefined;
  readonly hasBinding: boolean;
};

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  /**
   * Overrides MCP credential issuance. The real issuer reads a module-global
   * registry that only a running MCP server installs, which makes the
   * agent-browser-access gate unobservable from a unit test; this seam lets a
   * test see whether a credential was requested at all.
   */
  readonly issueMcpCredential?: typeof McpSessionRegistry.issueActiveMcpCredential;
  /** Same seam as `issueMcpCredential`, for observing the deny path's revoke. */
  readonly revokeMcpCredential?: typeof McpSessionRegistry.revokeActiveMcpThread;
}

interface TurnAnalyticsMetadata {
  readonly requestId: number;
  readonly provider: ProviderDriverKind;
  readonly startedAtMs: number;
  readonly mixedModels: boolean;
  readonly model?: string;
  readonly effort?: string;
  readonly interactionMode?: string;
  readonly runtimeMode?: string;
}

interface ActiveTurnAnalytics {
  readonly metadata: TurnAnalyticsMetadata;
  readonly requestAssociated: boolean;
}

interface DeferredTurnAnalyticsCompletion {
  readonly completionKey: string;
  readonly completedAtMs: number;
  readonly terminalProperties: Readonly<Record<string, unknown>>;
}

interface TurnAnalyticsSessionState {
  readonly pendingByRequestId: Map<number, TurnAnalyticsMetadata>;
  readonly activeByTurnId: Map<string, ActiveTurnAnalytics>;
  readonly deferredCompletionsByTurnId: Map<string, DeferredTurnAnalyticsCompletion>;
}

interface TurnAnalyticsState {
  readonly sessions: Map<string, TurnAnalyticsSessionState>;
  readonly completedKeys: Set<string>;
  readonly completedOrder: Array<string>;
}

const MAX_COMPLETED_TURN_ANALYTICS_KEYS = 512;
const MAX_ACTIVE_TURN_ANALYTICS_PER_SESSION = 8;

function setActiveTurnAnalytics(
  session: TurnAnalyticsSessionState,
  turnId: string,
  active: ActiveTurnAnalytics,
): void {
  session.activeByTurnId.set(turnId, active);
  while (session.activeByTurnId.size > MAX_ACTIVE_TURN_ANALYTICS_PER_SESSION) {
    const oldestTurnId = session.activeByTurnId.keys().next().value;
    if (oldestTurnId === undefined) return;
    session.activeByTurnId.delete(oldestTurnId);
  }
}

function turnAnalyticsSessionKey(instanceId: ProviderInstanceId, threadId: ThreadId): string {
  return `${String(instanceId)}\u0000${String(threadId)}`;
}

function turnAnalyticsCompletionKey(
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  turnId: string,
): string {
  return `${turnAnalyticsSessionKey(instanceId, threadId)}\u0000${turnId}`;
}

function turnEffort(modelSelection: ProviderSendTurnInput["modelSelection"]): string | undefined {
  return (
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
    getModelSelectionStringOptionValue(modelSelection, "effort")
  );
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const providerServiceErrorFromUnknown = (
  operation: string,
  cause: unknown,
): ProviderServiceError => {
  const unwrappedCause = cause instanceof ProviderRuntimeConsumerFailure ? cause.cause : cause;
  if (
    isProviderAdapterProcessError(unwrappedCause) ||
    isProviderAdapterRequestError(unwrappedCause) ||
    isProviderAdapterSessionClosedError(unwrappedCause) ||
    isProviderAdapterSessionNotFoundError(unwrappedCause) ||
    isProviderAdapterValidationError(unwrappedCause) ||
    isProviderInstanceNotFoundError(unwrappedCause) ||
    isProviderSessionDirectoryPersistenceError(unwrappedCause) ||
    isProviderSessionNotFoundError(unwrappedCause) ||
    isProviderSessionSupersededError(unwrappedCause) ||
    isProviderUnsupportedError(unwrappedCause) ||
    isProviderValidationError(unwrappedCause) ||
    isProviderWorkspaceMissingError(unwrappedCause)
  ) {
    return unwrappedCause;
  }
  return toValidationError(
    operation,
    unwrappedCause instanceof Error ? unwrappedCause.message : String(unwrappedCause),
    unwrappedCause,
  );
};

const providerSessionSuperseded = (operation: string, threadId: ThreadId, detail: string) =>
  new ProviderSessionSupersededError({ operation, threadId, detail });

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly continueAfterServerUpdate?: TurnId;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.continueAfterServerUpdate !== undefined
      ? { continueAfterServerUpdate: extra.continueAfterServerUpdate }
      : {}),
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const serverConfig = yield* ServerConfig.ServerConfig;
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projectionQuery = yield* Effect.serviceOption(
    ProjectionSnapshotQuery.ProjectionSnapshotQuery,
  );
  const issueMcpCredential =
    options?.issueMcpCredential ?? McpSessionRegistry.issueActiveMcpCredential;
  const revokeMcpCredential =
    options?.revokeMcpCredential ?? McpSessionRegistry.revokeActiveMcpThread;
  const fileSystem = yield* FileSystem.FileSystem;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const pendingCompactions = new Map<ThreadId, PendingCompaction>();
  const timedOutNativeCompactions = new Map<ThreadId, ProviderRuntimeSource>();
  const settleCompaction = (threadId: ThreadId, pending: PendingCompaction, terminal: string) =>
    Effect.gen(function* () {
      if (pendingCompactions.get(threadId) !== pending) return false;
      pendingCompactions.delete(threadId);
      yield* Deferred.succeed(pending.completion, terminal);
      return true;
    });
  const turnAnalytics = yield* Ref.make<TurnAnalyticsState>({
    sessions: new Map(),
    completedKeys: new Set(),
    completedOrder: [],
  });
  let turnAnalyticsRequestId = 0;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const finishTurnAnalytics = (
    state: TurnAnalyticsState,
    input: {
      readonly sessionKey: string;
      readonly turnId: string;
      readonly completion: DeferredTurnAnalyticsCompletion;
    },
  ): Readonly<Record<string, unknown>> | undefined => {
    if (state.completedKeys.has(input.completion.completionKey)) return undefined;
    state.completedKeys.add(input.completion.completionKey);
    state.completedOrder.push(input.completion.completionKey);
    while (state.completedOrder.length > MAX_COMPLETED_TURN_ANALYTICS_KEYS) {
      const expired = state.completedOrder.shift();
      if (expired) state.completedKeys.delete(expired);
    }

    const session = state.sessions.get(input.sessionKey);
    const metadata = session?.activeByTurnId.get(input.turnId)?.metadata;
    session?.activeByTurnId.delete(input.turnId);
    session?.deferredCompletionsByTurnId.delete(input.turnId);
    if (
      session &&
      session.activeByTurnId.size === 0 &&
      session.pendingByRequestId.size === 0 &&
      session.deferredCompletionsByTurnId.size === 0
    ) {
      state.sessions.delete(input.sessionKey);
    }

    return {
      ...input.completion.terminalProperties,
      ...(metadata?.model ? { model: metadata.model } : {}),
      ...(metadata?.effort ? { effort: metadata.effort } : {}),
      ...(metadata?.interactionMode ? { interactionMode: metadata.interactionMode } : {}),
      ...(metadata?.runtimeMode ? { runtimeMode: metadata.runtimeMode } : {}),
      ...(metadata ? { mixedModels: metadata.mixedModels } : {}),
      ...(metadata
        ? { durationMs: Math.max(0, input.completion.completedAtMs - metadata.startedAtMs) }
        : {}),
    };
  };

  const recordCompletedTurnProperties = (
    properties: ReadonlyArray<Readonly<Record<string, unknown>>>,
  ) =>
    Effect.forEach(properties, (entry) => analytics.record("provider.turn.completed", entry), {
      discard: true,
    });

  const clearTurnAnalyticsSession = (providerInstanceId: ProviderInstanceId, threadId: ThreadId) =>
    Effect.gen(function* () {
      const properties = yield* Ref.modify(turnAnalytics, (state) => {
        const sessionKey = turnAnalyticsSessionKey(providerInstanceId, threadId);
        const session = state.sessions.get(sessionKey);
        const completed: Array<Readonly<Record<string, unknown>>> = [];
        if (session) {
          for (const [turnId, completion] of session.deferredCompletionsByTurnId) {
            const entry = finishTurnAnalytics(state, { sessionKey, turnId, completion });
            if (entry) completed.push(entry);
          }
        }
        state.sessions.delete(sessionKey);
        return [completed, state] as const;
      });
      yield* recordCompletedTurnProperties(properties);
    });

  const beginTurnAnalytics = Effect.fn("beginTurnAnalytics")(function* (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
    readonly modelSelection: ProviderSendTurnInput["modelSelection"];
    readonly interactionMode: ProviderSendTurnInput["interactionMode"];
    readonly runtimeMode: string | undefined;
  }) {
    const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
    turnAnalyticsRequestId += 1;
    const requestId = turnAnalyticsRequestId;
    const effort = turnEffort(input.modelSelection);
    return yield* Ref.modify(turnAnalytics, (state) => {
      const key = turnAnalyticsSessionKey(input.providerInstanceId, input.threadId);
      const session = state.sessions.get(key) ?? {
        pendingByRequestId: new Map(),
        activeByTurnId: new Map(),
        deferredCompletionsByTurnId: new Map(),
      };
      const metadata: TurnAnalyticsMetadata = {
        provider: input.provider,
        startedAtMs,
        mixedModels: false,
        requestId,
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        ...(effort ? { effort } : {}),
        ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
      };
      session.pendingByRequestId.set(requestId, metadata);
      state.sessions.set(key, session);
      return [metadata, state] as const;
    });
  });

  const clearPendingTurnAnalytics = (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly requestId: number;
  }) =>
    Effect.gen(function* () {
      const properties = yield* Ref.modify(turnAnalytics, (state) => {
        const sessionKey = turnAnalyticsSessionKey(input.providerInstanceId, input.threadId);
        const session = state.sessions.get(sessionKey);
        if (!session)
          return [[] as ReadonlyArray<Readonly<Record<string, unknown>>>, state] as const;
        session.pendingByRequestId.delete(input.requestId);
        const completed: Array<Readonly<Record<string, unknown>>> = [];
        if (session.pendingByRequestId.size === 0) {
          for (const [turnId, completion] of session.deferredCompletionsByTurnId) {
            const entry = finishTurnAnalytics(state, { sessionKey, turnId, completion });
            if (entry) completed.push(entry);
          }
        }
        if (
          session.activeByTurnId.size === 0 &&
          session.pendingByRequestId.size === 0 &&
          session.deferredCompletionsByTurnId.size === 0
        ) {
          state.sessions.delete(sessionKey);
        }
        return [completed, state] as const;
      });
      yield* recordCompletedTurnProperties(properties);
    });

  const associateTurnAnalytics = (input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly turnId: string;
    readonly metadata: TurnAnalyticsMetadata;
  }) =>
    Effect.gen(function* () {
      const properties = yield* Ref.modify(turnAnalytics, (state) => {
        const completionKey = turnAnalyticsCompletionKey(
          input.providerInstanceId,
          input.threadId,
          input.turnId,
        );
        const sessionKey = turnAnalyticsSessionKey(input.providerInstanceId, input.threadId);
        const session = state.sessions.get(sessionKey);
        if (!session || state.completedKeys.has(completionKey)) {
          if (session) {
            session.pendingByRequestId.delete(input.metadata.requestId);
            if (
              session.activeByTurnId.size === 0 &&
              session.pendingByRequestId.size === 0 &&
              session.deferredCompletionsByTurnId.size === 0
            ) {
              state.sessions.delete(sessionKey);
            }
          }
          return [[] as ReadonlyArray<Readonly<Record<string, unknown>>>, state] as const;
        }
        const existing = session.activeByTurnId.get(input.turnId);
        const existingMetadata = existing?.metadata;
        const base = existing?.requestAssociated ? existing.metadata : input.metadata;
        setActiveTurnAnalytics(session, input.turnId, {
          requestAssociated: true,
          metadata: {
            ...base,
            ...(existingMetadata?.model
              ? { model: existingMetadata.model }
              : input.metadata.model
                ? { model: input.metadata.model }
                : {}),
            ...(existingMetadata?.effort
              ? { effort: existingMetadata.effort }
              : input.metadata.effort
                ? { effort: input.metadata.effort }
                : {}),
            ...(base?.interactionMode
              ? {}
              : input.metadata.interactionMode
                ? { interactionMode: input.metadata.interactionMode }
                : {}),
            ...(base?.runtimeMode
              ? {}
              : input.metadata.runtimeMode
                ? { runtimeMode: input.metadata.runtimeMode }
                : {}),
            mixedModels: existingMetadata?.mixedModels ?? input.metadata.mixedModels,
          },
        });
        session.pendingByRequestId.delete(input.metadata.requestId);
        const completion = session.deferredCompletionsByTurnId.get(input.turnId);
        const completed = completion
          ? finishTurnAnalytics(state, {
              sessionKey,
              turnId: input.turnId,
              completion,
            })
          : undefined;
        return [completed ? [completed] : [], state] as const;
      });
      yield* recordCompletedTurnProperties(properties);
    });

  const observeTurnStartedForAnalytics = Effect.fn("observeTurnStartedForAnalytics")(function* (
    source: { readonly instanceId: ProviderInstanceId; readonly provider: ProviderDriverKind },
    event: Extract<ProviderRuntimeEvent, { readonly type: "turn.started" }>,
  ) {
    if (!event.turnId) return;
    const observedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(turnAnalytics, (state) => {
      const completionKey = turnAnalyticsCompletionKey(
        source.instanceId,
        event.threadId,
        String(event.turnId),
      );
      if (state.completedKeys.has(completionKey)) return state;
      const sessionKey = turnAnalyticsSessionKey(source.instanceId, event.threadId);
      const session = state.sessions.get(sessionKey) ?? {
        pendingByRequestId: new Map(),
        activeByTurnId: new Map(),
        deferredCompletionsByTurnId: new Map(),
      };
      // A start never binds send metadata on its own. Claude can start a
      // synthetic turn for leftover agent output while sendTurn is still
      // preparing the real turn, so only the adapter's sendTurn response
      // links a request to its turn. Completions that land before that
      // response wait in deferredCompletionsByTurnId.
      const current = session.activeByTurnId.get(String(event.turnId));
      const metadata: TurnAnalyticsMetadata = {
        ...(current?.metadata ?? {
          requestId: ++turnAnalyticsRequestId,
          provider: source.provider,
          startedAtMs: observedAtMs,
          mixedModels: false,
        }),
        ...(event.payload.model ? { model: event.payload.model } : {}),
        ...(event.payload.effort ? { effort: event.payload.effort } : {}),
      };
      setActiveTurnAnalytics(session, String(event.turnId), {
        metadata,
        requestAssociated: current?.requestAssociated ?? false,
      });
      state.sessions.set(sessionKey, session);
      return state;
    });
  });

  const observeModelReroutedForAnalytics = (
    source: { readonly instanceId: ProviderInstanceId },
    event: Extract<ProviderRuntimeEvent, { readonly type: "model.rerouted" }>,
  ) =>
    Ref.update(turnAnalytics, (state) => {
      const session = state.sessions.get(
        turnAnalyticsSessionKey(source.instanceId, event.threadId),
      );
      if (!session) return state;
      if (event.turnId) {
        const current = session.activeByTurnId.get(String(event.turnId));
        if (current) {
          session.activeByTurnId.set(String(event.turnId), {
            ...current,
            metadata: { ...current.metadata, mixedModels: true },
          });
        }
      } else {
        for (const [turnId, current] of session.activeByTurnId) {
          session.activeByTurnId.set(turnId, {
            ...current,
            metadata: { ...current.metadata, mixedModels: true },
          });
        }
      }
      return state;
    });

  const recordTurnCompletedAnalytics = Effect.fn("recordTurnCompletedAnalytics")(function* (
    source: { readonly instanceId: ProviderInstanceId; readonly provider: ProviderDriverKind },
    event: Extract<ProviderRuntimeEvent, { readonly type: "turn.completed" | "turn.aborted" }>,
  ) {
    if (!event.turnId) return;
    const completedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
    const tokenUsage = event.payload.tokenUsage;
    const completion: DeferredTurnAnalyticsCompletion = {
      completionKey: turnAnalyticsCompletionKey(
        source.instanceId,
        event.threadId,
        String(event.turnId),
      ),
      completedAtMs,
      terminalProperties: {
        provider: source.provider,
        terminalStatus:
          event.type === "turn.completed"
            ? event.payload.state
            : event.payload.reason.toLowerCase().includes("interrupt")
              ? "interrupted"
              : "cancelled",
        usageStatus: tokenUsage?.usageStatus ?? "unavailable",
        usageScope: tokenUsage?.usageScope ?? "main_agent",
        ...(tokenUsage ? { hasSubagents: tokenUsage.hasSubagents } : {}),
        ...(tokenUsage?.inputTokens !== undefined ? { inputTokens: tokenUsage.inputTokens } : {}),
        ...(tokenUsage?.cachedInputTokens !== undefined
          ? { cachedInputTokens: tokenUsage.cachedInputTokens }
          : {}),
        ...(tokenUsage?.cacheCreationTokens !== undefined
          ? { cacheCreationTokens: tokenUsage.cacheCreationTokens }
          : {}),
        ...(tokenUsage?.outputTokens !== undefined
          ? { outputTokens: tokenUsage.outputTokens }
          : {}),
        ...(tokenUsage?.reasoningTokens !== undefined
          ? { reasoningTokens: tokenUsage.reasoningTokens }
          : {}),
      },
    };
    const properties = yield* Ref.modify(turnAnalytics, (state) => {
      if (state.completedKeys.has(completion.completionKey)) {
        return [[] as ReadonlyArray<Readonly<Record<string, unknown>>>, state] as const;
      }
      const turnId = String(event.turnId);
      const sessionKey = turnAnalyticsSessionKey(source.instanceId, event.threadId);
      const session = state.sessions.get(sessionKey);
      if (session?.deferredCompletionsByTurnId.has(turnId)) {
        return [[] as ReadonlyArray<Readonly<Record<string, unknown>>>, state] as const;
      }
      const active = session?.activeByTurnId.get(turnId);
      const needsAssociation =
        (session?.pendingByRequestId.size ?? 0) > 0 && active?.requestAssociated !== true;
      if (!session || !needsAssociation) {
        const completed = finishTurnAnalytics(state, { sessionKey, turnId, completion });
        return [completed ? [completed] : [], state] as const;
      }

      session.deferredCompletionsByTurnId.set(turnId, completion);
      const completed: Array<Readonly<Record<string, unknown>>> = [];
      while (session.deferredCompletionsByTurnId.size > MAX_ACTIVE_TURN_ANALYTICS_PER_SESSION) {
        const oldest = session.deferredCompletionsByTurnId.entries().next().value;
        if (!oldest) break;
        const [oldestTurnId, oldestCompletion] = oldest;
        const entry = finishTurnAnalytics(state, {
          sessionKey,
          turnId: oldestTurnId,
          completion: oldestCompletion,
        });
        if (entry) completed.push(entry);
      }
      return [completed, state] as const;
    });
    yield* recordCompletedTurnProperties(properties);
  });
  /**
   * Attach the `t3-code` MCP server to the session that is about to start.
   *
   * This is the only place a credential is minted, so withholding one here is
   * what disables agent browser access everywhere: every adapter already
   * treats a missing session as "no MCP server", and the `/mcp` endpoint
   * accepts nothing but tokens issued from this path.
   */
  /**
   * Deny on an unreadable settings file rather than letting the read failure
   * escape: adding `ServerSettingsError` to `ProviderServiceError` would widen
   * a union every caller handles, for a branch that only decides whether one
   * optional toolset is attached. Denying is the safe direction — an explicit
   * "off" silently becoming "on" would violate the user's stated choice,
   * whereas the reverse costs an agent one toolset and is visible immediately.
   */
  const agentBrowserAccessEnabled = Effect.fn("ProviderService.agentBrowserAccessEnabled")(
    function* (threadId: ThreadId) {
      const settings = yield* serverSettings.getSettings;
      if (Object.keys(settings.projectAgentBrowserAccessOverrides).length === 0) {
        return settings.enableAgentBrowserAccess;
      }
      // Provider-only runtimes may omit orchestration. An unresolved project
      // must not bypass an explicit browser override.
      if (Option.isNone(projectionQuery)) return false;
      const thread = yield* projectionQuery.value.getThreadShellById(threadId);
      if (Option.isNone(thread)) return false;
      return resolveProjectAgentBrowserAccess(settings, thread.value.projectId);
    },
    Effect.catch((cause) =>
      Effect.logWarning(
        "Could not read server settings; withholding agent browser access for this session.",
        { cause },
      ).pipe(Effect.as(false)),
    ),
  );

  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      if (!(yield* agentBrowserAccessEnabled(threadId))) {
        // Revoke as well as clear. Every other prepare path reaches
        // `issueActiveMcpCredential`, which revokes the thread first, so
        // skipping it here would leave a previously issued bearer token valid
        // against `/mcp` for the rest of its liveness window — and later turns
        // would keep refreshing it. A session restart (runtime mode, cwd,
        // model) re-prepares without stopping, so it relies on this.
        yield* revokeMcpCredential(threadId);
        yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));
        return undefined;
      }
      const credential = yield* issueMcpCredential({ threadId, providerInstanceId });
      if (credential) {
        yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
      }
      return credential;
    });
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  // The source record is retained while an adapter is being withdrawn. A
  // replacement cannot take the same instance id until the old reader and
  // late starts have both drained.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, SubscribedAdapterRecord>(),
  );
  const reconcileLock = yield* Semaphore.make(1);
  let reconcileInstanceSubscriptions: Effect.Effect<void> = Effect.void;
  let processRuntimeEvent: (
    source: ProviderRuntimeSource,
    event: ProviderRuntimeEvent,
  ) => Effect.Effect<void, ProviderRuntimeDeliveryError> = () =>
    Effect.die("ProviderService runtime event handler is not ready");
  const operations = yield* ProviderSessionOperations.makeProviderSessionOperations;
  const runtimeDelivery =
    yield* ProviderRuntimeDelivery.makeProviderRuntimeDelivery<ProviderRuntimeDeliveryError>({
      processEvent: (source, event) => processRuntimeEvent(source, event),
      onSourceEnded: () =>
        // The delivery helper invokes this before it marks its reader record
        // reconciled. Schedule the retry after that handoff so an attachment
        // blocked by the old tombstone can proceed.
        Effect.forkDetach(
          Effect.yieldNow.pipe(
            Effect.andThen(Effect.suspend(() => reconcileInstanceSubscriptions)),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider runtime source reconciliation failed", { cause }),
            ),
          ),
        ).pipe(Effect.asVoid),
    });
  const stopAllRegistration = yield* Semaphore.make(1);
  let stopAllOutcome: Deferred.Deferred<Exit.Exit<void, ProviderServiceError>> | undefined;

  const publishRuntimeEvent = (
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void, ProviderRuntimeDeliveryError> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) =>
        runtimeDelivery.deliver(canonicalEvent, (isAllowed) =>
          Effect.sync(() => {
            if (isAllowed()) PubSub.publishUnsafe(runtimeEventPubSub, canonicalEvent);
          }),
        ),
      ),
    );

  const isCompactedEvent = (
    event: ProviderRuntimeEvent,
  ): event is Extract<ProviderRuntimeEvent, { readonly type: "thread.state.changed" }> =>
    event.type === "thread.state.changed" && event.payload.state === "compacted";
  const withCompactionRequestId = (
    event: ProviderRuntimeEvent,
    pending: PendingCompaction,
  ): ProviderRuntimeEvent => {
    if (pending.requestId === undefined) return event;
    const derived = {
      ...event,
      requestId: RuntimeRequestId.make(String(pending.requestId)),
    } satisfies ProviderRuntimeEvent;
    runtimeDelivery.inheritTag(derived, event);
    return derived;
  };
  const compactionTerminal = (event: ProviderRuntimeEvent): string | null =>
    event.type === "turn.completed"
      ? event.payload.state
      : event.type === "runtime.error" || event.type === "turn.aborted"
        ? event.type
        : event.type === "session.exited"
          ? event.type
          : null;
  const processFallbackCompactionEvent = (
    pending: PendingCompaction,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void, ProviderRuntimeDeliveryError> =>
    Effect.gen(function* () {
      if (pendingCompactions.get(event.threadId) !== pending) {
        yield* publishRuntimeEvent(event);
        return;
      }
      const matchesTurn = event.turnId !== undefined && event.turnId === pending.expectedTurnId;
      if (matchesTurn && isCompactedEvent(event)) {
        pending.compactedEventObserved = true;
        yield* publishRuntimeEvent(withCompactionRequestId(event, pending));
        return;
      }
      yield* publishRuntimeEvent(event);
      const terminal = compactionTerminal(event);
      if (!matchesTurn || terminal === null) return;
      const settled = yield* settleCompaction(event.threadId, pending, terminal);
      if (!settled || terminal !== "completed" || pending.compactedEventObserved) return;
      const compactedEvent = {
        ...event,
        eventId: EventId.make(`${event.eventId}:context-compaction`),
        type: "thread.state.changed",
        payload: {
          state: "compacted",
          detail: { source: "provider-native-command" },
        },
        ...(pending.requestId !== undefined
          ? { requestId: RuntimeRequestId.make(String(pending.requestId)) }
          : {}),
      } satisfies ProviderRuntimeEvent;
      runtimeDelivery.inheritTag(compactedEvent, event);
      yield* increment(providerRuntimeEventsTotal, {
        provider: compactedEvent.provider,
        eventType: compactedEvent.type,
      });
      yield* publishRuntimeEvent(compactedEvent);
    });

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly continueAfterServerUpdate?: TurnId;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  processRuntimeEvent = (
    source: ProviderRuntimeSource,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void, ProviderRuntimeDeliveryError> =>
    Effect.gen(function* () {
      const canonicalEvent = yield* Effect.sync(() =>
        correlateRuntimeEventWithInstance(
          { instanceId: source.instanceId, provider: source.adapter.provider },
          event,
        ),
      );
      runtimeDelivery.tag(canonicalEvent, source);
      yield* increment(providerRuntimeEventsTotal, {
        provider: canonicalEvent.provider,
        eventType: canonicalEvent.type,
      });
      if (canonicalEvent.type === "turn.started") {
        yield* observeTurnStartedForAnalytics(
          { instanceId: source.instanceId, provider: source.adapter.provider },
          canonicalEvent,
        );
      } else if (canonicalEvent.type === "model.rerouted") {
        yield* observeModelReroutedForAnalytics({ instanceId: source.instanceId }, canonicalEvent);
      } else if (
        canonicalEvent.type === "turn.completed" ||
        canonicalEvent.type === "turn.aborted"
      ) {
        yield* recordTurnCompletedAnalytics(
          { instanceId: source.instanceId, provider: source.adapter.provider },
          canonicalEvent,
        );
      } else if (canonicalEvent.type === "session.exited") {
        yield* clearTurnAnalyticsSession(source.instanceId, canonicalEvent.threadId);
      }
      if (
        isCompactedEvent(canonicalEvent) &&
        timedOutNativeCompactions.get(canonicalEvent.threadId) === source
      ) {
        timedOutNativeCompactions.delete(canonicalEvent.threadId);
        yield* publishRuntimeEvent(canonicalEvent);
        return;
      }
      const pendingCompaction = pendingCompactions.get(canonicalEvent.threadId);
      if (!pendingCompaction) {
        yield* publishRuntimeEvent(canonicalEvent);
        return;
      }
      if (
        pendingCompaction.providerInstanceId !== source.instanceId ||
        pendingCompaction.source !== source
      ) {
        yield* publishRuntimeEvent(canonicalEvent);
        return;
      }
      if (canonicalEvent.type === "session.exited") {
        yield* publishRuntimeEvent(canonicalEvent);
        yield* settleCompaction(canonicalEvent.threadId, pendingCompaction, canonicalEvent.type);
        return;
      }
      if (pendingCompaction.native) {
        const compacted = isCompactedEvent(canonicalEvent);
        const terminal = compacted ? "completed" : compactionTerminal(canonicalEvent);
        yield* publishRuntimeEvent(
          compacted ? withCompactionRequestId(canonicalEvent, pendingCompaction) : canonicalEvent,
        );
        if (terminal !== null)
          yield* settleCompaction(canonicalEvent.threadId, pendingCompaction, terminal);
        return;
      }
      if (
        pendingCompaction.expectedTurnId === undefined &&
        canonicalEvent.turnId !== undefined &&
        (isCompactedEvent(canonicalEvent) || compactionTerminal(canonicalEvent) !== null)
      ) {
        pendingCompaction.earlyEvents.push(canonicalEvent);
        return;
      }
      yield* processFallbackCompactionEvent(pendingCompaction, canonicalEvent);
    });

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) =>
      Array.from(map.entries()).filter(([, record]) => record.source.isPublishing()),
    ),
  );

  // Rebuild the id → adapter/source map from the registry. An old record is
  // deliberately kept while it is still publishing so routing can finish a
  // withdrawal even though the registry has already removed that id.
  const reconcileInstanceSubscriptionsUnsafe = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, SubscribedAdapterRecord>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      const prior = previous.get(id);
      if (prior?.adapter === adapter && prior.source.isPublishing()) {
        next.set(id, prior);
        continue;
      }
      const attached = yield* runtimeDelivery.attach(id, adapter);
      if (Option.isSome(attached)) {
        next.set(id, { adapter, source: attached.value });
      }
      // A replacement can be blocked by a retiring source. Keep that source
      // addressable until its reader callback schedules the next reconcile.
      if (Option.isNone(attached) && prior?.source.isPublishing()) next.set(id, prior);
    }
    for (const [id, prior] of previous) {
      if (!next.has(id) && prior.source.isPublishing()) next.set(id, prior);
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  reconcileInstanceSubscriptions = reconcileLock.withPermit(reconcileInstanceSubscriptionsUnsafe);

  const waitForRetiredSourceStarts = Effect.fn("ProviderService.waitForRetiredSourceStarts")(
    (source: ProviderRuntimeSource): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const drained = yield* operations
          .drainStarts(source)
          .pipe(Effect.timeoutOption("5 seconds"));
        if (Option.isNone(drained)) {
          yield* Effect.logWarning("provider session starts outlived adapter retirement", {
            instanceId: String(source.instanceId),
            provider: String(source.adapter.provider),
            timeout: "5 seconds",
          });
        }
      }).pipe(Effect.orDie),
  );

  yield* registry.registerRetirementHooks({
    beforeClose: (instanceId, adapter) =>
      Effect.gen(function* () {
        yield* runtimeDelivery.beforeClose(instanceId, adapter);
        const source = runtimeDelivery.get(instanceId, adapter);
        if (source !== undefined) yield* operations.retireSource(source);
      }),
    afterClose: (instanceId, adapter) =>
      Effect.gen(function* () {
        const source = runtimeDelivery.get(instanceId, adapter);
        if (source !== undefined) yield* waitForRetiredSourceStarts(source);
        yield* runtimeDelivery.afterClose(instanceId, adapter);
      }).pipe(Effect.orDie),
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const getSubscribedAdapter = (instanceId: ProviderInstanceId) =>
    Ref.get(subscribedAdapters).pipe(
      Effect.map((map) => {
        const record = map.get(instanceId);
        return record?.source.isPublishing() ? record : undefined;
      }),
    );

  const resolveAdapterRecord = Effect.fn("ProviderService.resolveAdapterRecord")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRetiringFallback?: boolean;
  }) {
    const subscribed = yield* getSubscribedAdapter(input.instanceId);
    const lookup = yield* Effect.exit(registry.getByInstance(input.instanceId));
    if (Exit.isFailure(lookup)) {
      if (input.allowRetiringFallback === true && subscribed !== undefined) return subscribed;
      return yield* Effect.failCause(lookup.cause);
    }

    const adapter = lookup.value;
    if (subscribed?.adapter === adapter) return subscribed;

    const attached = yield* runtimeDelivery.attach(input.instanceId, adapter);
    if (Option.isSome(attached)) {
      const record = { adapter, source: attached.value } satisfies SubscribedAdapterRecord;
      yield* Ref.update(subscribedAdapters, (current) => {
        const next = new Map(current);
        next.set(input.instanceId, record);
        return next;
      });
      return record;
    }

    if (input.allowRetiringFallback === true && subscribed !== undefined) return subscribed;
    return yield* providerSessionSuperseded(
      input.operation,
      input.threadId,
      `Provider instance '${input.instanceId}' is still handing off its previous runtime source.`,
    );
  });

  const ensureStartLease = (
    operation: string,
    threadId: ThreadId,
    lease: ProviderSessionOperations.ProviderSessionLease,
  ): Effect.Effect<void, ProviderSessionSupersededError> =>
    lease.isCurrent() && !lease.isStopping()
      ? Effect.void
      : Effect.fail(
          providerSessionSuperseded(
            operation,
            threadId,
            "The provider session start lost ownership before its result could be committed.",
          ),
        );

  const ensureOperationsOpen = (
    operation: string,
    threadId: ThreadId,
  ): Effect.Effect<void, ProviderSessionSupersededError> =>
    operations.isClosed()
      ? Effect.fail(
          providerSessionSuperseded(operation, threadId, "Provider session operations are closed."),
        )
      : Effect.void;

  const cleanupStartedSession = Effect.fn("ProviderService.cleanupStartedSession")(
    function* (input: {
      readonly operation: string;
      readonly threadId: ThreadId;
      readonly source: ProviderRuntimeSource;
      readonly adapter: ProviderAdapterShape<ProviderAdapterError>;
      readonly session: ProviderSession | undefined;
      readonly lease: ProviderSessionOperations.ProviderSessionLease;
    }) {
      // ProviderSessionOperations invokes cleanup only after ownership has been
      // withdrawn. The session captured by this invocation is therefore the only
      // native session that this cleanup is allowed to stop.
      if (!input.lease.isStopping()) return;

      const hasSession =
        input.session !== undefined && (yield* input.adapter.hasSession(input.threadId));
      if (hasSession) {
        const stopExit = yield* Effect.exit(
          runtimeDelivery
            .withExitIntent(
              input.source,
              input.threadId,
              () => "stop",
              input.adapter.stopSession(input.threadId),
            )
            .pipe(
              Effect.catch((cause) =>
                isProviderAdapterSessionNotFoundError(cause) ? Effect.void : Effect.fail(cause),
              ),
            ),
        );
        yield* clearMcpSession(input.threadId);
        if (Exit.isFailure(stopExit)) return yield* Effect.failCause(stopExit.cause);
        return;
      }
      yield* clearMcpSession(input.threadId);
    },
  );

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
    readonly record: SubscribedAdapterRecord;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const { adapter, source } = input.record;
      if (!source.isAdmitted()) {
        return yield* providerSessionSuperseded(
          input.operation,
          input.binding.threadId,
          "The provider session source is no longer admitted.",
        );
      }
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      let resumedSession: ProviderSession | undefined;
      const resumed = yield* operations.start({
        threadId: input.binding.threadId,
        source,
        isSourceActive: source.isAdmitted,
        operation: (lease) =>
          Effect.gen(function* () {
            yield* ensureStartLease(input.operation, input.binding.threadId, lease);
            yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
            yield* ensureStartLease(input.operation, input.binding.threadId, lease);

            const resumed = yield* runtimeDelivery
              .withExitIntent(
                source,
                input.binding.threadId,
                () => (lease.isStopping() ? "stop" : "replace"),
                // Native startup may finish after ownership is withdrawn; let it
                // publish its session so the operation cleanup can stop it.
                Effect.uninterruptible(
                  adapter
                    .startSession({
                      threadId: input.binding.threadId,
                      provider: input.binding.provider,
                      providerInstanceId: bindingInstanceId,
                      ...(persistedCwd ? { cwd: persistedCwd } : {}),
                      ...(persistedModelSelection
                        ? { modelSelection: persistedModelSelection }
                        : {}),
                      ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
                      runtimeMode: input.binding.runtimeMode ?? "full-access",
                    })
                    .pipe(
                      Effect.tap((session) =>
                        Effect.sync(() => {
                          resumedSession = session;
                        }),
                      ),
                    ),
                ),
              )
              .pipe(
                Effect.mapError((cause) => providerServiceErrorFromUnknown(input.operation, cause)),
                Effect.onError(() => clearMcpSession(input.binding.threadId)),
              );

            yield* ensureStartLease(input.operation, input.binding.threadId, lease);
            if (resumed.provider !== adapter.provider) {
              yield* clearMcpSession(input.binding.threadId);
              return yield* toValidationError(
                input.operation,
                `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
              );
            }

            const resumedWithInstance = { ...resumed, providerInstanceId: bindingInstanceId };
            yield* ensureStartLease(input.operation, input.binding.threadId, lease);
            yield* upsertSessionBinding(resumedWithInstance, input.binding.threadId);
            yield* analytics.record("provider.session.recovered", {
              provider: resumed.provider,
              strategy: "resume-thread",
              hasResumeCursor: resumed.resumeCursor !== undefined,
            });
            return resumedWithInstance;
          }),
        cleanup: (lease) =>
          cleanupStartedSession({
            operation: input.operation,
            threadId: input.binding.threadId,
            source,
            adapter,
            session: resumedSession,
            lease,
          }),
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
    readonly allowRetiringFallback?: boolean;
  }) {
    yield* ensureOperationsOpen(input.operation, input.threadId);
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const record = yield* resolveAdapterRecord({
      instanceId,
      threadId: input.threadId,
      operation: input.operation,
      ...(input.allowRetiringFallback === true ? { allowRetiringFallback: true } : {}),
    });
    if (!record.source.isPublishing()) {
      return yield* providerSessionSuperseded(
        input.operation,
        input.threadId,
        "The provider session source has retired.",
      );
    }
    if (!record.source.isAdmitted() && input.allowRetiringFallback !== true) {
      return yield* providerSessionSuperseded(
        input.operation,
        input.threadId,
        "The provider session source is no longer admitted.",
      );
    }
    const adapter = record.adapter;

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        source: record.source,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        source: record.source,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
      record,
    });
    return {
      adapter: recovered.adapter,
      source: record.source,
      instanceId,
      threadId: input.threadId,
      runtimeMode: recovered.session.runtimeMode,
      isActive: true,
    } as const;
  });

  const resolveStopSessionTarget = Effect.fn("resolveStopSessionTarget")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<StopSessionResolution, ProviderServiceError> {
    const binding = yield* directory.getBinding(threadId);
    if (Option.isSome(binding)) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.stopSession",
        allowRecovery: false,
        allowRetiringFallback: true,
      });
      return {
        target: { ...routed, hasBinding: true },
        hasBinding: true,
      };
    }

    const startingSource = operations.startingSource(threadId);
    const source =
      startingSource === undefined
        ? undefined
        : runtimeDelivery.sources().find((candidate) => candidate === startingSource);
    if (source === undefined) return { target: undefined, hasBinding: false };

    return {
      target: {
        adapter: source.adapter,
        source,
        instanceId: source.instanceId,
        threadId,
        runtimeMode: undefined,
        isActive: yield* source.adapter
          .hasSession(threadId)
          .pipe(
            Effect.mapError((cause) =>
              providerServiceErrorFromUnknown("ProviderService.stopSession", cause),
            ),
          ),
        hasBinding: false,
      },
      hasBinding: false,
    };
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, record]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* record.adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* runtimeDelivery
                .withExitIntent(
                  record.source,
                  input.threadId,
                  () => "stop",
                  record.adapter.stopSession(input.threadId),
                )
                .pipe(
                  Effect.tap(() =>
                    analytics.record("provider.session.stopped", {
                      provider: record.adapter.provider,
                    }),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("provider.session.stop-stale-failed", {
                      threadId: input.threadId,
                      provider: record.adapter.provider,
                      cause,
                    }),
                  ),
                );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput, onStarted) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        if (
          persistedBinding?.provider === resolvedProvider &&
          persistedBinding.providerInstanceId !== resolvedInstanceId &&
          (input.resumeCursor != null || persistedBinding.resumeCursor != null)
        ) {
          const previousInstanceId = yield* requireBindingInstanceId(
            "ProviderService.startSession",
            persistedBinding,
          );
          const previousInfo = yield* registry.getInstanceInfo(previousInstanceId);
          if (
            previousInfo.continuationIdentity.continuationKey !==
            instanceInfo.continuationIdentity.continuationKey
          ) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Thread '${threadId}' cannot switch from instance '${previousInstanceId}' to '${resolvedInstanceId}' because their provider resume state is incompatible.`,
            );
          }
        }
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        if (effectiveCwd !== undefined) {
          // Fail fast with an actionable error when the workspace folder is
          // gone (e.g. moved, deleted, or replaced by a plain file).
          // Otherwise every adapter surfaces this as a misleading "failed to
          // spawn <binary>" process error. Stat failures other than "missing"
          // fall through to the adapter.
          const workspaceIsDirectory = yield* fileSystem.stat(effectiveCwd).pipe(
            Effect.map((workspaceStat) => workspaceStat.type === "Directory"),
            Effect.catch((statError) => Effect.succeed(statError.reason._tag !== "NotFound")),
          );
          if (!workspaceIsDirectory) {
            return yield* new ProviderWorkspaceMissingError({ threadId, cwd: effectiveCwd });
          }
        }
        const record = yield* resolveAdapterRecord({
          instanceId: resolvedInstanceId,
          threadId,
          operation: "ProviderService.startSession",
        });
        if (!record.source.isAdmitted()) {
          return yield* providerSessionSuperseded(
            "ProviderService.startSession",
            threadId,
            "The provider session source is no longer admitted.",
          );
        }
        const adapter = record.adapter;
        let startedSession: ProviderSession | undefined;
        const session = yield* operations.start({
          threadId,
          source: record.source,
          isSourceActive: record.source.isAdmitted,
          operation: (lease) =>
            Effect.gen(function* () {
              yield* ensureStartLease("ProviderService.startSession", threadId, lease);
              yield* clearTurnAnalyticsSession(resolvedInstanceId, threadId);
              yield* prepareMcpSession(threadId, resolvedInstanceId);
              yield* ensureStartLease("ProviderService.startSession", threadId, lease);

              const session = yield* runtimeDelivery
                .withExitIntent(
                  record.source,
                  threadId,
                  () => (lease.isStopping() ? "stop" : "replace"),
                  // Native startup may finish after ownership is withdrawn; let it
                  // publish its session so the operation cleanup can stop it.
                  Effect.uninterruptible(
                    adapter
                      .startSession({
                        ...input,
                        providerInstanceId: resolvedInstanceId,
                        ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
                        ...(effectiveResumeCursor !== undefined
                          ? { resumeCursor: effectiveResumeCursor }
                          : {}),
                      })
                      .pipe(
                        Effect.tap((session) =>
                          Effect.sync(() => {
                            startedSession = session;
                          }),
                        ),
                      ),
                  ),
                )
                .pipe(
                  Effect.mapError((cause) =>
                    providerServiceErrorFromUnknown("ProviderService.startSession", cause),
                  ),
                  Effect.onError(() => clearMcpSession(threadId)),
                );

              yield* ensureStartLease("ProviderService.startSession", threadId, lease);
              if (session.provider !== adapter.provider) {
                yield* clearMcpSession(threadId);
                return yield* toValidationError(
                  "ProviderService.startSession",
                  `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
                );
              }
              const sessionWithInstance = {
                ...session,
                providerInstanceId: resolvedInstanceId,
              };

              yield* stopStaleSessionsForThread({
                threadId,
                currentInstanceId: resolvedInstanceId,
              });
              yield* ensureStartLease("ProviderService.startSession", threadId, lease);
              yield* upsertSessionBinding(sessionWithInstance, threadId, {
                modelSelection: input.modelSelection,
              });
              yield* ensureStartLease("ProviderService.startSession", threadId, lease);
              if (onStarted !== undefined) {
                yield* onStarted(sessionWithInstance).pipe(
                  Effect.mapError((cause) =>
                    providerServiceErrorFromUnknown(
                      "ProviderService.startSession.onStarted",
                      cause,
                    ),
                  ),
                );
              }
              yield* analytics.record("provider.session.started", {
                provider: sessionWithInstance.provider,
                runtimeMode: input.runtimeMode,
                hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
                hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
                hasModel:
                  typeof input.modelSelection?.model === "string" &&
                  input.modelSelection.model.trim().length > 0,
              });
              timedOutNativeCompactions.delete(threadId);

              // Changing runtime mode restarts the session, so the transition is only
              // observable here, by diffing against the mode the previous session for
              // this thread was bound to. Recording it separately is what makes the
              // "started supervised, switched to full access" funnel answerable.
              const previousRuntimeMode = persistedBinding?.runtimeMode;
              if (previousRuntimeMode !== undefined && previousRuntimeMode !== input.runtimeMode) {
                yield* analytics.record("provider.runtime_mode.changed", {
                  provider: sessionWithInstance.provider,
                  from: previousRuntimeMode,
                  to: input.runtimeMode,
                });
              }

              return sessionWithInstance;
            }),
          cleanup: (lease) =>
            cleanupStartedSession({
              operation: "ProviderService.startSession",
              threadId,
              source: record.source,
              adapter,
              session: startedSession,
              lease,
            }),
        });
        return session;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const attachments = parsed.attachments ?? [];
    if (!parsed.input && attachments.length === 0 && parsed.continuation !== true) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }

    const inputTextWithCitations =
      parsed.input === undefined ? undefined : expandAssistantCitationsForProvider(parsed.input);
    if (inputTextWithCitations !== parsed.input) {
      yield* decodeInputOrValidationError({
        operation: "ProviderService.sendTurn",
        schema: ProviderSendTurnInput.fields.input,
        payload: inputTextWithCitations,
      });
    }

    // Every attachment gets an on-disk path in the prompt so the model's tools
    // can dereference the actual file. All attachments then go to the adapter,
    // and each adapter decides what its provider ingests natively: OpenCode
    // sends generic files as file parts, the others send images only and rely
    // on the path line for everything else. Unresolvable ids are skipped here
    // and surface as adapter errors when the file is read.
    const attachmentPathLines = attachments.flatMap((attachment) => {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      return attachmentPath === null
        ? []
        : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
    });
    const inputTextWithAttachmentPaths =
      attachmentPathLines.length === 0
        ? inputTextWithCitations
        : [inputTextWithCitations, attachmentPathLines.join("\n")]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n\n");

    const input = {
      ...parsed,
      ...(inputTextWithAttachmentPaths !== undefined
        ? { input: inputTextWithAttachmentPaths }
        : {}),
    };
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: false,
      });
      if (
        input.continuation === true &&
        !input.input &&
        attachments.length === 0 &&
        routed.adapter.capabilities.promptlessTurnContinuation !== true
      ) {
        return yield* toValidationError(
          "ProviderService.sendTurn",
          `Provider '${routed.adapter.provider}' requires an explicit continuation prompt`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
      }
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      // A turn is the clearest sign a session is still alive. The MCP
      // credential is minted once at session start and cannot be rotated into
      // an already-spawned agent process, so we keep the existing token valid
      // rather than issuing a new one: sessions that go a long time between
      // browser tool calls used to lose the toolkit outright.
      yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
      const operationToken = yield* operations.capture(input.threadId, routed.source);
      const analyticsModelSelection =
        input.modelSelection?.instanceId === routed.instanceId ? input.modelSelection : undefined;
      const turn = yield* Effect.acquireUseRelease(
        beginTurnAnalytics({
          providerInstanceId: routed.instanceId,
          provider: routed.adapter.provider,
          threadId: input.threadId,
          modelSelection: analyticsModelSelection,
          interactionMode: input.interactionMode,
          runtimeMode: routed.runtimeMode,
        }),
        (turnMetadata) =>
          Effect.gen(function* () {
            const turn = yield* routed.adapter.sendTurn(input);
            yield* operations.commitIfCurrent(
              operationToken,
              Effect.gen(function* () {
                yield* associateTurnAnalytics({
                  providerInstanceId: routed.instanceId,
                  threadId: input.threadId,
                  turnId: String(turn.turnId),
                  metadata: turnMetadata,
                });
                yield* directory.upsert({
                  threadId: input.threadId,
                  provider: routed.adapter.provider,
                  providerInstanceId: routed.instanceId,
                  status: "running",
                  ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
                  runtimePayload: {
                    ...(input.modelSelection !== undefined
                      ? { modelSelection: input.modelSelection }
                      : {}),
                    activeTurnId: turn.turnId,
                    // Admission and marker consumption must survive the same restart.
                    continueAfterServerUpdate: null,
                    continueAfterServerUpdatePrepared: null,
                    lastRuntimeEvent: "provider.sendTurn",
                    lastRuntimeEventAt: yield* nowIso,
                  },
                });
                yield* analytics.record("provider.turn.sent", {
                  provider: routed.adapter.provider,
                  model: input.modelSelection?.model,
                  interactionMode: input.interactionMode,
                  // Session-start events alone skew runtime mode toward users who toggle
                  // often, since every toggle restarts the session. Recording it per turn
                  // gives a usage-weighted view and lets it cross with interactionMode.
                  runtimeMode: routed.runtimeMode,
                  attachmentCount: attachments.length,
                  hasInput: typeof input.input === "string" && input.input.trim().length > 0,
                });
              }),
            );
            return turn;
          }),
        (turnMetadata) =>
          operations
            .commitIfCurrent(
              operationToken,
              clearPendingTurnAnalytics({
                providerInstanceId: routed.instanceId,
                threadId: input.threadId,
                requestId: turnMetadata.requestId,
              }),
            )
            .pipe(
              Effect.asVoid,
              Effect.catch((cause) =>
                isProviderSessionSupersededError(cause) ? Effect.void : Effect.fail(cause),
              ),
            ),
      );
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const compactThread: ProviderServiceMethod<"compactThread"> = Effect.fn("compactThread")(
    function* (threadId, modelSelection, requestId, onSettled) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.compactThread",
        allowRecovery: true,
      });
      const operationToken = yield* operations.capture(threadId, routed.source);
      const compactionExit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "provider.operation": "compact-thread",
            "provider.kind": routed.adapter.provider,
            "provider.thread_id": threadId,
          });
          yield* McpSessionRegistry.touchActiveMcpThread(threadId);
          const compaction = routed.adapter.compaction;
          if (compaction === undefined) {
            return yield* toValidationError(
              "ProviderService.compactThread",
              `Provider '${routed.adapter.provider}' does not support context compaction.`,
            );
          }
          const completion = yield* Deferred.make<string>();
          const pending: PendingCompaction = {
            completion,
            native: compaction.type === "native",
            providerInstanceId: routed.instanceId,
            source: routed.source,
            requestId,
            earlyEvents: [],
            compactedEventObserved: false,
            expectedTurnId: undefined,
          };
          if (
            compaction.type === "native" &&
            timedOutNativeCompactions.get(threadId) === routed.source
          ) {
            return yield* new ProviderAdapterRequestError({
              provider: routed.adapter.provider,
              method: "thread/compact",
              detail:
                "The previous context compaction may still be running. Restart the provider session before retrying.",
            });
          }
          const claimed = yield* Effect.sync(() => {
            if (pendingCompactions.has(threadId)) return false;
            pendingCompactions.set(threadId, pending);
            return true;
          });
          if (!claimed) {
            return yield* new ProviderAdapterRequestError({
              provider: routed.adapter.provider,
              method: "thread/compact",
              detail: "Context compaction is already in progress.",
            });
          }
          const clearPending = Effect.sync(() => {
            if (pendingCompactions.get(threadId) === pending) {
              pendingCompactions.delete(threadId);
            }
          });
          const awaitNativeCompaction = (start: Effect.Effect<void, ProviderAdapterError>) =>
            start.pipe(
              Effect.andThen(Deferred.await(completion)),
              Effect.timeout(COMPACTION_COMPLETION_TIMEOUT),
              Effect.catchTag("TimeoutError", (cause) =>
                Effect.sync(() => {
                  timedOutNativeCompactions.set(threadId, routed.source);
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ProviderAdapterRequestError({
                        provider: routed.adapter.provider,
                        method: "thread/compact",
                        detail: `Provider did not report completed context compaction within ${COMPACTION_COMPLETION_TIMEOUT}.`,
                        cause,
                      }),
                    ),
                  ),
                ),
              ),
            );
          const awaitFallbackCompaction = Deferred.await(completion).pipe(
            Effect.timeout(COMPACTION_COMPLETION_TIMEOUT),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: routed.adapter.provider,
                  method: "turn/start",
                  detail: `Provider did not finish context compaction within ${COMPACTION_COMPLETION_TIMEOUT}.`,
                  cause,
                }),
            ),
          );
          const terminal = yield* (
            compaction.type === "native"
              ? awaitNativeCompaction(compaction.start(routed.threadId, modelSelection))
              : Effect.gen(function* () {
                  const turn = yield* sendTurn({
                    threadId,
                    input: compaction.command,
                    ...(modelSelection !== undefined ? { modelSelection } : {}),
                  }).pipe(
                    Effect.onError(() =>
                      Effect.ignore(
                        Effect.forEach(pending.earlyEvents.splice(0), publishRuntimeEvent, {
                          discard: true,
                        }),
                      ),
                    ),
                  );
                  pending.expectedTurnId = turn.turnId;
                  const earlyEvents = pending.earlyEvents.splice(0);
                  for (const earlyEvent of earlyEvents) {
                    yield* processFallbackCompactionEvent(pending, earlyEvent).pipe(
                      Effect.mapError((cause) =>
                        providerServiceErrorFromUnknown("ProviderService.compactThread", cause),
                      ),
                    );
                  }
                  return yield* awaitFallbackCompaction;
                })
          ).pipe(Effect.ensuring(clearPending));
          if (terminal !== "completed") {
            return yield* new ProviderAdapterRequestError({
              provider: routed.adapter.provider,
              method: compaction.type === "native" ? "thread/compact" : "turn/start",
              detail: `Context compaction ended with ${terminal}.`,
            });
          }
        }),
      );
      const callbackExit =
        onSettled === undefined
          ? Exit.succeed(undefined)
          : yield* Effect.exit(
              operations.commitIfCurrent(
                operationToken,
                onSettled(compactionExit).pipe(
                  Effect.mapError((cause) =>
                    providerServiceErrorFromUnknown(
                      "ProviderService.compactThread.onSettled",
                      cause,
                    ),
                  ),
                ),
              ),
            );
      if (Exit.isFailure(compactionExit)) return yield* Effect.failCause(compactionExit.cause);
      if (Exit.isFailure(callbackExit)) return yield* Effect.failCause(callbackExit.cause);
      yield* analytics.record("provider.thread.compacted", {
        provider: routed.adapter.provider,
      });
    },
  );

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput, onSettled) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      const ticket = yield* operations.beginStop(input.threadId);
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const resolutionExit = yield* Effect.exit(
          resolveStopSessionTarget(input.threadId).pipe(
            Effect.mapError((cause) =>
              providerServiceErrorFromUnknown("ProviderService.stopSession", cause),
            ),
          ),
        );
        const ticketSource = ticket.source;
        const originalSource =
          ticketSource === undefined
            ? undefined
            : runtimeDelivery.sources().find((source) => source === ticketSource);
        let target: StopSessionTarget | undefined;
        let hasBinding = false;
        let stopExit: Exit.Exit<void, ProviderServiceError> = Exit.succeed(undefined);

        if (Exit.isFailure(resolutionExit)) {
          stopExit = Exit.failCause(resolutionExit.cause);
        } else {
          target = resolutionExit.value.target;
          hasBinding = resolutionExit.value.hasBinding;
          const resolvedTarget = target;
          if (resolvedTarget !== undefined) {
            metricProvider = resolvedTarget.adapter.provider;
            yield* Effect.annotateCurrentSpan({
              "provider.operation": "stop-session",
              "provider.kind": resolvedTarget.adapter.provider,
              "provider.thread_id": input.threadId,
            });
          }

          if (!hasBinding && onSettled === undefined) {
            stopExit = Exit.fail(
              toValidationError(
                "ProviderService.stopSession",
                `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
              ),
            );
          } else if (resolvedTarget === undefined) {
            stopExit = Exit.succeed(undefined);
          }

          if (resolvedTarget !== undefined && Exit.isSuccess(stopExit)) {
            const targetMatchesTicket =
              ticketSource === undefined || resolvedTarget.source === ticketSource;
            const canInvokeNativeStop =
              resolvedTarget.isActive && ticket.isCurrent() && targetMatchesTicket;
            const nativeStop = canInvokeNativeStop
              ? runtimeDelivery.withExitIntent(
                  resolvedTarget.source,
                  input.threadId,
                  () => "stop",
                  Effect.suspend(() => {
                    if (
                      !ticket.isCurrent() ||
                      (ticketSource !== undefined && resolvedTarget.source !== ticketSource)
                    ) {
                      return Effect.void;
                    }
                    return resolvedTarget.adapter.stopSession(resolvedTarget.threadId);
                  }),
                )
              : Effect.void;
            stopExit = yield* Effect.exit(
              nativeStop.pipe(
                Effect.mapError((cause) =>
                  providerServiceErrorFromUnknown("ProviderService.stopSession", cause),
                ),
              ),
            );
          }
        }

        const resolvedTarget = target;
        const cleanupSource = originalSource ?? resolvedTarget?.source;
        const cleanupAdapter = resolvedTarget?.adapter ?? originalSource?.adapter;
        const cleanupInstanceId = resolvedTarget?.instanceId ?? originalSource?.instanceId;
        const sourceMatchesTicket =
          resolvedTarget === undefined ||
          ticketSource === undefined ||
          resolvedTarget.source === ticketSource;
        const isOriginalSourceCurrent = () =>
          ticket.isCurrent() &&
          sourceMatchesTicket &&
          (ticketSource === undefined ||
            runtimeDelivery
              .sources()
              .some((source) => source === ticketSource && source.isPublishing()));

        const commit = Effect.gen(function* () {
          if (Exit.isSuccess(stopExit)) {
            const pendingCompaction = pendingCompactions.get(input.threadId);
            if (pendingCompaction !== undefined && pendingCompaction.source === cleanupSource) {
              yield* settleCompaction(input.threadId, pendingCompaction, "turn.aborted");
            }
            if (timedOutNativeCompactions.get(input.threadId) === cleanupSource) {
              timedOutNativeCompactions.delete(input.threadId);
            }
            if (cleanupInstanceId !== undefined) {
              yield* clearTurnAnalyticsSession(cleanupInstanceId, input.threadId);
            }
            yield* clearMcpSession(input.threadId);
            if (resolvedTarget !== undefined && hasBinding) {
              yield* directory.upsert({
                threadId: input.threadId,
                provider: resolvedTarget.adapter.provider,
                providerInstanceId: resolvedTarget.instanceId,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  continueAfterServerUpdate: null,
                  continueAfterServerUpdatePrepared: null,
                },
              });
            }
            if (cleanupAdapter !== undefined) {
              yield* analytics.record("provider.session.stopped", {
                provider: cleanupAdapter.provider,
              });
            }
          }
          if (onSettled !== undefined) {
            yield* onSettled(stopExit).pipe(
              Effect.mapError((cause) =>
                providerServiceErrorFromUnknown("ProviderService.stopSession.onSettled", cause),
              ),
            );
          }
        });
        const settlementExit = yield* Effect.exit(
          operations.settleStop(ticket, {
            succeeded: Exit.isSuccess(stopExit),
            isSourceCurrent: isOriginalSourceCurrent,
            commit,
          }),
        );
        if (Exit.isFailure(settlementExit) && Exit.isSuccess(stopExit)) {
          return yield* Effect.failCause(settlementExit.cause);
        }
        if (Exit.isFailure(stopExit)) return yield* Effect.failCause(stopExit.cause);
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, record]) =>
        record.adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      // Only live adapter sessions appear in this response. Resolving every
      // historical binding here makes each call scale with the full thread
      // history instead of the active session set.
      const persistedBindings = yield* Effect.forEach(
        [...new Set(activeSessions.map((session) => session.threadId))],
        (threadId) =>
          directory
            .getBinding(threadId)
            .pipe(
              Effect.orElseSucceed(() =>
                Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
              ),
            ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const assertConversationRollbackSupported: ProviderServiceMethod<"assertConversationRollbackSupported"> =
    Effect.fn("assertConversationRollbackSupported")(function* (threadId) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.assertConversationRollbackSupported",
        allowRecovery: false,
      });
      if (routed.adapter.capabilities.supportsConversationRollback === false) {
        return yield* toValidationError(
          "ProviderService.assertConversationRollbackSupported",
          `Provider '${routed.adapter.provider}' does not support conversation rewind.`,
        );
      }
    });

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      yield* assertConversationRollbackSupported(input.threadId);
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const uploadFeedback: ProviderServiceMethod<"uploadFeedback"> = Effect.fn("uploadFeedback")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.uploadFeedback",
        schema: ProviderUploadFeedbackInput,
        payload: rawInput,
      });
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.uploadFeedback",
        allowRecovery: false,
      });
      if (routed.adapter.uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.uploadFeedback",
          allowRecovery: true,
        });
      }
      const uploadFeedback = routed.adapter.uploadFeedback;
      if (uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "upload-feedback",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      return yield* uploadFeedback(input);
    },
  );

  const executeStopAll = Effect.fn("executeStopAll")(function* () {
    const failures: ProviderServiceError[] = [];
    const runStage = <A, E>(
      stage: string,
      effect: Effect.Effect<A, E, never>,
    ): Effect.Effect<A | undefined, never> =>
      Effect.exit(effect).pipe(
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return Effect.succeed(exit.value);
          const error = providerServiceErrorFromUnknown(
            `ProviderService.stopAll.${stage}`,
            Cause.squash(exit.cause),
          );
          failures.push(error);
          return Effect.logWarning("provider service shutdown stage failed", {
            stage,
            errorTag: causeErrorTag(exit.cause),
          }).pipe(Effect.as(undefined));
        }),
      );
    const runMetadataStage = <A, E>(
      stage: string,
      effect: Effect.Effect<A, E, never>,
    ): Effect.Effect<A | undefined, never> =>
      runStage(
        stage,
        effect.pipe(
          Effect.timeoutOption(STOP_ALL_METADATA_TIMEOUT),
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.fail(
                  toValidationError(
                    "ProviderService.stopAll",
                    `Shutdown metadata stage '${stage}' did not finish within ${STOP_ALL_METADATA_TIMEOUT}.`,
                  ),
                ),
          ),
        ),
      );

    yield* runStage("close-runtime-admission", runtimeDelivery.closeAdmission);
    yield* runStage("close-session-operations", operations.close);
    const sources = runtimeDelivery.sources();

    const settings = yield* runMetadataStage("read-settings", serverSettings.getSettings);
    const continueAfterRestart = settings?.continueThreadsAfterServerUpdate === true;
    const properties =
      (yield* runMetadataStage(
        "finish-deferred-turn-analytics",
        Ref.modify(turnAnalytics, (state) => {
          const completed: Array<Readonly<Record<string, unknown>>> = [];
          for (const [sessionKey, session] of state.sessions) {
            for (const [turnId, completion] of session.deferredCompletionsByTurnId) {
              const entry = finishTurnAnalytics(state, { sessionKey, turnId, completion });
              if (entry) completed.push(entry);
            }
          }
          state.sessions.clear();
          return [completed, state] as const;
        }),
      )) ?? [];
    yield* runMetadataStage(
      "record-deferred-turn-analytics",
      recordCompletedTurnProperties(properties),
    );

    const threadIds = (yield* runMetadataStage("list-thread-ids", directory.listThreadIds())) ?? [];
    const sessionsBySource =
      (yield* runMetadataStage(
        "list-sessions",
        Effect.forEach(
          sources,
          (source) =>
            runStage(
              `list-sessions:${String(source.instanceId)}`,
              source.adapter.listSessions().pipe(
                Effect.map((sessions) =>
                  sessions.map((session) => ({
                    ...session,
                    providerInstanceId: source.instanceId,
                  })),
                ),
              ),
            ),
          { concurrency: STOP_ALL_METADATA_CONCURRENCY },
        ),
      )) ?? [];
    const activeSessions = sessionsBySource.flatMap((sessions) => sessions ?? []);
    yield* runMetadataStage(
      "persist-restart-markers",
      Effect.forEach(
        activeSessions,
        (session) =>
          runStage(
            `persist-restart-marker:${String(session.threadId)}`,
            Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
              upsertSessionBinding(session, session.threadId, {
                ...(continueAfterRestart && session.status === "running" && session.activeTurnId
                  ? { continueAfterServerUpdate: session.activeTurnId }
                  : {}),
                lastRuntimeEvent: "provider.stopAll",
                lastRuntimeEventAt,
              }),
            ),
          ),
        { concurrency: STOP_ALL_METADATA_CONCURRENCY, discard: true },
      ),
    );

    const stopSource = (source: ProviderRuntimeSource) =>
      Effect.gen(function* () {
        const stopFiber = yield* Effect.forkDetach(
          source.adapter
            .stopAll()
            .pipe(
              Effect.mapError((cause) =>
                providerServiceErrorFromUnknown(
                  `ProviderService.stopAll.stop:${String(source.instanceId)}`,
                  cause,
                ),
              ),
            ),
          { startImmediately: true },
        );
        const completed = yield* Fiber.await(stopFiber).pipe(
          Effect.timeoutOption(STOP_ALL_PROVIDER_TIMEOUT),
        );
        if (Option.isNone(completed)) {
          yield* Fiber.interrupt(stopFiber).pipe(Effect.forkDetach, Effect.asVoid);
          return yield* toValidationError(
            "ProviderService.stopAll",
            `Provider '${source.adapter.provider}' did not finish stopping within ${STOP_ALL_PROVIDER_TIMEOUT}.`,
          );
        }
        if (Exit.isFailure(completed.value)) {
          return yield* Effect.failCause(completed.value.cause);
        }
      });
    yield* Effect.forEach(
      sources,
      (source) => runStage(`stop-all:${String(source.instanceId)}`, stopSource(source)),
      { concurrency: "unbounded", discard: true },
    );

    yield* runStage(
      "drain-starts",
      operations.drainStarts().pipe(
        Effect.timeoutOption(STOP_ALL_START_DRAIN_TIMEOUT),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.succeed(result.value)
            : toValidationError(
                "ProviderService.stopAll",
                `Provider session starts did not finish cleanup within ${STOP_ALL_START_DRAIN_TIMEOUT}.`,
              ),
        ),
      ),
    );

    const flushableSources = sources.filter((source) => source.adapter.drainEvents !== undefined);
    yield* Effect.forEach(
      flushableSources,
      (source) => runStage(`flush:${String(source.instanceId)}`, runtimeDelivery.flush(source)),
      { concurrency: "unbounded", discard: true },
    );

    yield* runMetadataStage(
      "revoke-mcp-credentials",
      McpSessionRegistry.revokeAllActiveMcpCredentials(),
    );
    yield* runMetadataStage(
      "clear-mcp-sessions",
      Effect.sync(() => McpProviderSession.clearAllMcpProviderSessions()),
    );
    const bindings = (yield* runMetadataStage("list-bindings", directory.listBindings())) ?? [];
    yield* runMetadataStage(
      "mark-stopped-bindings",
      Effect.forEach(
        bindings,
        (binding) =>
          runStage(
            `mark-stopped:${String(binding.threadId)}`,
            Effect.gen(function* () {
              const providerInstanceId = dieOnMissingBindingInstanceId(
                "ProviderService.stopAll",
                binding,
              );
              return yield* directory.upsert({
                threadId: binding.threadId,
                provider: binding.provider,
                providerInstanceId,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: yield* nowIso,
                },
              });
            }),
          ),
        { concurrency: STOP_ALL_METADATA_CONCURRENCY, discard: true },
      ),
    );
    yield* runMetadataStage(
      "record-stopped-all",
      analytics.record("provider.sessions.stopped_all", {
        sessionCount: threadIds.length,
      }),
    );
    yield* runMetadataStage("flush-analytics", analytics.flush);

    const firstFailure = failures[0];
    if (firstFailure !== undefined) return yield* firstFailure;
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const outcome = yield* Effect.uninterruptible(
      stopAllRegistration.withPermit(
        Effect.gen(function* () {
          if (stopAllOutcome !== undefined) return stopAllOutcome;
          const created = yield* Deferred.make<Exit.Exit<void, ProviderServiceError>>();
          stopAllOutcome = created;
          const worker = Effect.uninterruptibleMask((restore) =>
            Effect.exit(restore(executeStopAll())).pipe(
              Effect.flatMap((exit) => Deferred.succeed(created, exit).pipe(Effect.asVoid)),
              Effect.catchCause((cause) =>
                Deferred.succeed(
                  created,
                  Exit.fail(
                    providerServiceErrorFromUnknown("ProviderService.stopAll", Cause.squash(cause)),
                  ),
                ).pipe(Effect.asVoid),
              ),
            ),
          );
          yield* Effect.forkDetach(worker, { startImmediately: true }).pipe(
            Effect.catchCause((cause) =>
              Deferred.succeed(
                created,
                Exit.fail(
                  providerServiceErrorFromUnknown("ProviderService.stopAll", Cause.squash(cause)),
                ),
              ).pipe(Effect.asVoid),
            ),
            Effect.asVoid,
          );
          return created;
        }),
      ),
    );
    const completed = yield* Deferred.await(outcome);
    if (Exit.isSuccess(completed)) return completed.value;
    return yield* Effect.failCause(completed.cause);
  });

  yield* Effect.uninterruptible(
    Effect.addFinalizer(() =>
      runStopAll().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to stop provider service", {
            errorTag: causeErrorTag(cause),
          }),
        ),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    compactThread,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    stopAll: runStopAll,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    assertConversationRollbackSupported,
    rollbackConversation,
    uploadFeedback,
    registerRuntimeEventConsumer: <E>(consumer: ProviderService.ProviderRuntimeEventConsumer<E>) =>
      runtimeDelivery.registerConsumer((event) =>
        consumer(event).pipe(
          Effect.mapError((cause) => new ProviderRuntimeConsumerFailure({ cause })),
        ),
      ),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
