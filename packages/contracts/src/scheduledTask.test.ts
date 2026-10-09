import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";

const decodeSchedule = Schema.decodeUnknownSync(ScheduledTaskSchedule);
const decodeUpsertSchedule = Schema.decodeUnknownSync(ScheduledTaskUpsertSchedule);

describe("ScheduledTaskSchedule", () => {
  it("keeps legacy sub-minute persisted schedules readable", () => {
    expect(
      decodeSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
    });
  });

  it("still rejects corrupt non-positive persisted intervals", () => {
    expect(() => decodeSchedule({ type: "interval", everyMs: 0 })).toThrow();
  });
});

describe("ScheduledTaskUpsertSchedule", () => {
  it("accepts interval schedules at the one-minute minimum", () => {
    expect(
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
      }),
    ).toEqual({
      type: "interval",
      everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS,
    });
  });

  it("rejects interval schedules more frequent than once per minute", () => {
    expect(() =>
      decodeUpsertSchedule({
        type: "interval",
        everyMs: MIN_SCHEDULED_TASK_INTERVAL_MS - 1,
      }),
    ).toThrow();
  });
});

describe("ScheduledTaskWebhookSignature", () => {
  const encodeSchedule = Schema.encodeSync(ScheduledTaskSchedule);
  const hmac = { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" } as const;

  it("reads a signature saved before schemes existed as HMAC", () => {
    expect(decodeSchedule({ type: "webhook", signature: hmac })).toEqual({
      type: "webhook",
      signature: { scheme: "hmac_sha256", ...hmac },
    });
    expect(decodeUpsertSchedule({ type: "webhook", signature: { ...hmac, secret: "s" } })).toEqual({
      type: "webhook",
      signature: { scheme: "hmac_sha256", ...hmac, secret: "s" },
    });
  });

  it("round-trips a Standard Webhooks signature", () => {
    const schedule = decodeSchedule({
      type: "webhook",
      signature: { scheme: "standard_webhooks" },
    });
    expect(schedule).toEqual({ type: "webhook", signature: { scheme: "standard_webhooks" } });
    expect(decodeSchedule(encodeSchedule(schedule))).toEqual(schedule);
  });

  it("rejects an unknown scheme and an HMAC signature without a header", () => {
    expect(() =>
      decodeSchedule({ type: "webhook", signature: { ...hmac, scheme: "ed25519" } }),
    ).toThrow();
    expect(() =>
      decodeSchedule({ type: "webhook", signature: { scheme: "hmac_sha256" } }),
    ).toThrow();
  });
});
