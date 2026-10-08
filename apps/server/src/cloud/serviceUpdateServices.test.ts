import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { StagedServiceRuntime, UpdateAuthorityReserveInput } from "./serviceUpdateServices.ts";

const attemptId = "11111111-1111-4111-8111-111111111111";
const decodeReserveInput = Schema.decodeUnknownSync(UpdateAuthorityReserveInput, {
  onExcessProperty: "error",
});
const decodeStagedRuntime = Schema.decodeUnknownSync(StagedServiceRuntime, {
  onExcessProperty: "error",
});

describe("UpdateAuthorityReserveInput", () => {
  it("requires an attempt ID for scheduled ownership but not manual ownership", () => {
    expect(decodeReserveInput({ owner: "manual" })).toEqual({ owner: "manual" });
    expect(decodeReserveInput({ owner: "manual", attemptId })).toEqual({
      owner: "manual",
      attemptId,
    });
    expect(decodeReserveInput({ owner: "scheduled", attemptId })).toEqual({
      owner: "scheduled",
      attemptId,
    });
    expect(() => decodeReserveInput({ owner: "scheduled" })).toThrow();
    expect(() => decodeReserveInput({ owner: "manual", attemptId: "not-a-uuid" })).toThrow();
  });

  it("rejects excess reservation fields", () => {
    expect(() => decodeReserveInput({ owner: "manual", extra: true })).toThrow();
  });
});

describe("StagedServiceRuntime", () => {
  const staged = {
    format: 1,
    attemptId,
    version: "1.0.0",
    platform: "linux-x64",
    sha256: "a".repeat(64),
    bytes: 1,
    stagingDirectory: "/tmp/service-update-staging/attempt",
  } as const;

  it("accepts the fixed internal staged-runtime receipt", () => {
    expect(decodeStagedRuntime(staged)).toEqual(staged);
  });

  it("requires a positive safe byte count and exact digest/platform", () => {
    expect(() => decodeStagedRuntime({ ...staged, bytes: 0 })).toThrow();
    expect(() => decodeStagedRuntime({ ...staged, bytes: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => decodeStagedRuntime({ ...staged, sha256: "A".repeat(64) })).toThrow();
    expect(() => decodeStagedRuntime({ ...staged, platform: "linux-arm64" })).toThrow();
    expect(() => decodeStagedRuntime({ ...staged, unexpected: true })).toThrow();
  });
});
