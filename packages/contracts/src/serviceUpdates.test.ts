import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ServiceRuntimeUpdateId,
  ServiceUpdateAttemptId,
  ServiceUpdateVersion,
} from "./serviceUpdates.ts";
import { ServiceUpdateState } from "./server.ts";

describe("service-update identities", () => {
  it("accepts only UUID attempt identities and bounded untrimmed versions", () => {
    expect(
      Schema.decodeUnknownSync(ServiceUpdateAttemptId)("11111111-1111-4111-8111-111111111111"),
    ).toBe("11111111-1111-4111-8111-111111111111");
    expect(() => Schema.decodeUnknownSync(ServiceUpdateAttemptId)("attempt-1")).toThrow();

    expect(Schema.decodeUnknownSync(ServiceUpdateVersion)("1.2.3-f8y.20261006.1")).toBe(
      "1.2.3-f8y.20261006.1",
    );
    expect(() => Schema.decodeUnknownSync(ServiceUpdateVersion)(" 1.2.3-f8y.20261006.1")).toThrow();
    expect(Schema.decodeUnknownSync(ServiceRuntimeUpdateId)("launcher/update/1")).toBe(
      "launcher/update/1",
    );
  });
});

describe("public service-update lifecycle state", () => {
  const decode = Schema.decodeUnknownSync(ServiceUpdateState);

  it("keeps only idle, draining, and activating states", () => {
    expect(decode({ status: "idle" })).toEqual({ status: "idle" });
    expect(
      decode({
        status: "draining",
        targetVersion: "1.2.3-f8y.20261006.1",
        activeTurnCount: 2,
        queuedTurnCount: 1,
        queuedTurns: [{ threadId: "thread-1", messageId: "message-1" }],
        startedAt: "2026-10-06T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "draining", activeTurnCount: 2, queuedTurnCount: 1 });
    expect(
      decode({
        status: "activating",
        targetVersion: "1.2.3-f8y.20261006.1",
        queuedTurnCount: 0,
        queuedTurns: [],
        startedAt: "2026-10-06T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "activating", queuedTurnCount: 0 });
    expect(() => decode({ status: "blocked", attemptId: "attempt-1" })).toThrow();
  });
});
