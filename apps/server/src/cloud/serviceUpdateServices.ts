import {
  NonNegativeInt,
  PositiveInt,
  ServiceRuntimeUpdateId,
  ServiceUpdateAttemptId,
  ServiceUpdateVersion,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { ServiceUpdateAdmissionState } from "../orchestration-v2/ServiceUpdateAdmission.ts";
import type { ServiceUpdateReleaseDescriptor } from "./serviceUpdateRelease.ts";

export type ServiceUpdateUnsupportedReason =
  | "unmanaged"
  | "platform"
  | "launcher-upgrade-required"
  | "runtime-binding-unavailable";

export type ServiceUpdateErrorStage = "source" | "runtime" | "drain" | "authority" | "settings";
export type ServiceUpdateErrorCode =
  | "invalid-input"
  | "unsupported"
  | "operation-failed"
  | "rejected-before-acceptance"
  | "acceptance-unknown";

export class ServiceUpdateError extends Schema.TaggedError<ServiceUpdateError>()(
  "ServiceUpdateError",
  {
    stage: Schema.Literals(["source", "runtime", "drain", "authority", "settings"]),
    code: Schema.Literals([
      "invalid-input",
      "unsupported",
      "operation-failed",
      "rejected-before-acceptance",
      "acceptance-unknown",
    ]),
    detail: Schema.String.check(Schema.isMaxLength(512)),
  },
) {}

const ServiceUpdateDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}(?![\s\S])/u));

/** Internal stage receipt passed from the source to the runtime adopter. */
export const StagedServiceRuntime = Schema.Struct({
  format: Schema.Literal(1),
  attemptId: ServiceUpdateAttemptId,
  version: ServiceUpdateVersion,
  platform: Schema.Literal("linux-x64"),
  sha256: ServiceUpdateDigest,
  bytes: PositiveInt,
  stagingDirectory: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096)),
});
export type StagedServiceRuntime = typeof StagedServiceRuntime.Type;

export const ServiceUpdateProgress = Schema.Struct({
  downloadedBytes: NonNegativeInt,
  totalBytes: Schema.NullOr(NonNegativeInt),
});
export type ServiceUpdateProgress = typeof ServiceUpdateProgress.Type;

export type ServiceUpdateOperationStage = "source" | "runtime" | "drain" | "authority";
export type ServiceUpdateOperationCode =
  | "invalid-input"
  | "unavailable"
  | "io"
  | "verification-failed"
  | "rejected-before-acceptance"
  | "acceptance-unknown"
  | "cancelled"
  | "timeout"
  | "unknown";

/** Local effect error. Unit4 maps it to a bounded ServiceUpdateError at the wire boundary. */
export class ServiceUpdateOperationError extends Error {
  readonly _tag = "ServiceUpdateOperationError" as const;
  readonly stage: ServiceUpdateOperationStage;
  readonly code: ServiceUpdateOperationCode;
  readonly cleanupFailure: boolean;

  constructor(input: {
    readonly stage: ServiceUpdateOperationStage;
    readonly code: ServiceUpdateOperationCode;
    readonly cause?: unknown;
    readonly cleanupFailure?: boolean;
  }) {
    super(`Service update ${input.stage} operation failed (${input.code}).`, {
      cause: input.cause,
    });
    this.name = "ServiceUpdateOperationError";
    this.stage = input.stage;
    this.code = input.code;
    this.cleanupFailure = input.cleanupFailure ?? false;
  }
}

export interface ServiceUpdateProgressReporter {
  (progress: ServiceUpdateProgress): Effect.Effect<void, ServiceUpdateOperationError>;
}

export interface ServiceUpdateSourceShape {
  readonly check: (input: {
    readonly repository: string;
    readonly currentVersion: string;
  }) => Effect.Effect<ServiceUpdateReleaseDescriptor | null, ServiceUpdateOperationError>;
  /** Resolve one explicit F8Y tag without applying the scheduled newer-than-current policy. */
  readonly resolveTargetVersion: (input: {
    readonly repository: string;
    readonly targetVersion: string;
  }) => Effect.Effect<ServiceUpdateReleaseDescriptor, ServiceUpdateOperationError>;
  readonly stage: (
    input: {
      readonly attemptId: ServiceUpdateAttemptId;
      readonly candidate: ServiceUpdateReleaseDescriptor;
    },
    reportProgress: ServiceUpdateProgressReporter,
  ) => Effect.Effect<StagedServiceRuntime, ServiceUpdateOperationError>;
  readonly discard: (
    staged: StagedServiceRuntime,
  ) => Effect.Effect<void, ServiceUpdateOperationError>;
}

/** Release lookup and bounded artifact staging port. No production layer lives here. */
export class ServiceUpdateSource extends Context.Service<
  ServiceUpdateSource,
  ServiceUpdateSourceShape
>()("t3/cloud/serviceUpdateServices/ServiceUpdateSource") {}

export type ServiceUpdateRuntimeAvailability =
  | { readonly status: "supported" }
  | {
      readonly status: "unsupported";
      readonly reason: ServiceUpdateUnsupportedReason;
    };

/** Immutable facts captured from the running launcher generation and open DB. */
export interface ServiceUpdateSourceCapture {
  readonly databaseIdentity: string;
  readonly fromVersion: ServiceUpdateVersion;
}

export interface ServiceUpdateRuntimeShape {
  readonly availability: Effect.Effect<
    ServiceUpdateRuntimeAvailability,
    ServiceUpdateOperationError
  >;
  readonly captureSource: (input: {
    readonly fromVersion: ServiceUpdateVersion;
  }) => Effect.Effect<ServiceUpdateSourceCapture, ServiceUpdateOperationError>;
  readonly adopt: (
    staged: StagedServiceRuntime,
  ) => Effect.Effect<void, ServiceUpdateOperationError>;
  /**
   * Hand an adopted runtime to the launcher. The returned `updateId` records
   * launcher acceptance only: the launcher acknowledges the request before it
   * terminates this process and starts the trial run. It is never a readiness
   * or commit confirmation — those complete in the trial process and cannot
   * be observed from here.
   */
  readonly requestHandoff: (input: {
    readonly targetVersion: ServiceUpdateVersion;
    readonly source: ServiceUpdateSourceCapture;
    readonly authorityLease: UpdateAuthorityLease;
  }) => Effect.Effect<{ readonly updateId: ServiceRuntimeUpdateId }, ServiceUpdateOperationError>;
}

/** Runtime resolution/adoption and launcher handoff port. No default layer is provided. */
export class ServiceUpdateRuntime extends Context.Service<
  ServiceUpdateRuntime,
  ServiceUpdateRuntimeShape
>()("t3/cloud/serviceUpdateServices/ServiceUpdateRuntime") {}

export interface ServiceUpdateDrainObservation {
  readonly activeTurns: number;
  readonly startingOperations: number;
  readonly queued: number;
  readonly claimed: number;
  readonly unresolvedClaims: number;
}

export interface ServiceUpdateDrainLease {
  readonly observations: Stream.Stream<ServiceUpdateDrainObservation, ServiceUpdateOperationError>;
  readonly cancel: Effect.Effect<void, ServiceUpdateOperationError>;
  /**
   * Wait for native owners to settle, then recheck under the shared fair cut.
   * The callback runs only while the same admission exclusion is held.
   */
  readonly withQuiescence: <A, E, R>(
    use: (
      setAdmissionState: (state: ServiceUpdateAdmissionState) => Effect.Effect<void>,
    ) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ServiceUpdateOperationError, R>;
}

export interface ServiceUpdateDrainShape {
  readonly acquire: Effect.Effect<ServiceUpdateDrainLease, ServiceUpdateOperationError>;
}

/** Canonical provider admission/drain port. R05 supplies the real implementation. */
export class ServiceUpdateDrain extends Context.Service<
  ServiceUpdateDrain,
  ServiceUpdateDrainShape
>()("t3/cloud/serviceUpdateServices/ServiceUpdateDrain") {}

export type UpdateAuthorityOwner = "manual" | "scheduled";

export const UpdateAuthorityReserveInput = Schema.Union([
  Schema.Struct({
    owner: Schema.Literal("scheduled"),
    attemptId: ServiceUpdateAttemptId,
  }),
  Schema.Struct({
    owner: Schema.Literal("manual"),
    attemptId: Schema.optionalKey(ServiceUpdateAttemptId),
  }),
] as const).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type UpdateAuthorityReserveInput = typeof UpdateAuthorityReserveInput.Type;

export class UpdateAuthorityError extends Error {
  readonly _tag = "UpdateAuthorityError" as const;
  readonly code: "invalid-lease" | "stale-lease" | "retained-lease";

  constructor(input: {
    readonly code: "invalid-lease" | "stale-lease" | "retained-lease";
    readonly cause?: unknown;
  }) {
    super(`Service update authority rejected ${input.code}.`, { cause: input.cause });
    this.name = "UpdateAuthorityError";
    this.code = input.code;
  }
}

export interface UpdateAuthorityLease {
  readonly owner: UpdateAuthorityOwner;
  readonly attemptId?: ServiceUpdateAttemptId;
  readonly enterIrreversible: Effect.Effect<void, UpdateAuthorityError>;
  readonly release: Effect.Effect<"released" | "already-released", UpdateAuthorityError>;
}

export type UpdateAuthorityReserveResult =
  | { readonly _tag: "busy" }
  | { readonly _tag: "owned"; readonly lease: UpdateAuthorityLease };

/**
 * Shared in-process authority declaration. The production capability owns the
 * token and the production singleton; Unit0 deliberately provides no Live or
 * no-op implementation.
 */
export class UpdateAuthority extends Context.Service<
  UpdateAuthority,
  {
    readonly reserve: (
      input: UpdateAuthorityReserveInput,
    ) => Effect.Effect<UpdateAuthorityReserveResult, UpdateAuthorityError>;
  }
>()("t3/cloud/serviceUpdateServices/UpdateAuthority") {}
