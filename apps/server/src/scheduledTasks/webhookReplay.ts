/**
 * Reads the sender's delivery id and send time from a webhook request, for
 * tasks that opt into replay protection. Both are read only after the request
 * is authenticated; what they protect against depends on whether the
 * signature covers them, which the task's settings describe to the user.
 */
import type {
  ScheduledTaskWebhookDeliveryIdSource,
  ScheduledTaskWebhookDeliveryTimestamp,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { webhookJsonField, type WebhookRequest } from "./webhookTemplate.ts";

/** The delivery id, or undefined when the request has none or it is not a string or number. */
export function webhookDeliveryId(
  source: ScheduledTaskWebhookDeliveryIdSource,
  request: WebhookRequest,
): string | undefined {
  const value =
    source.type === "header"
      ? request.headers[source.name.toLowerCase()]
      : webhookJsonField(request, source.path);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return id === "" ? undefined : id;
}

/** Below this a number is Unix seconds, above it milliseconds (seconds reach it in year 5138). */
const SECONDS_LIMIT = 100_000_000_000;

/** The send time in epoch milliseconds, or undefined when missing or unreadable. */
export function webhookDeliveryTime(
  timestamp: ScheduledTaskWebhookDeliveryTimestamp,
  request: WebhookRequest,
): number | undefined {
  const value = webhookJsonField(request, timestamp.path);
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value)
        ? Number(value)
        : undefined;
  if (numeric !== undefined) {
    if (!Number.isFinite(numeric)) return undefined;
    return Math.abs(numeric) < SECONDS_LIMIT ? numeric * 1000 : numeric;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return Option.getOrUndefined(Option.map(DateTime.make(value.trim()), DateTime.toEpochMillis));
}
