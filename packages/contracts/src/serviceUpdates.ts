import * as Schema from "effect/Schema";

const makeUntrimmedBoundedString = (maxLength: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxLength),
    Schema.makeFilter((value) =>
      value.trim().length > 0 && value === value.trim()
        ? true
        : "Expected a non-empty string without leading or trailing whitespace.",
    ),
  );

/** Internal identity used to correlate native persistence and effect receipts. */
export const ServiceUpdateAttemptId = Schema.String.check(Schema.isUUID());
export type ServiceUpdateAttemptId = typeof ServiceUpdateAttemptId.Type;

/** Version copied from a release or native launcher outcome without rewriting it. */
export const ServiceUpdateVersion = makeUntrimmedBoundedString(128);
export type ServiceUpdateVersion = typeof ServiceUpdateVersion.Type;

/** The native launcher's opaque update identity. It need not be a UUID. */
export const ServiceRuntimeUpdateId = makeUntrimmedBoundedString(128);
export type ServiceRuntimeUpdateId = typeof ServiceRuntimeUpdateId.Type;
