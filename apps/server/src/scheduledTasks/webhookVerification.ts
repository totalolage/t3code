// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac or timingSafeEqual.
import * as NodeCrypto from "node:crypto";

import type { ScheduledTaskWebhookSignature } from "@t3tools/contracts";

/** Constant-time string comparison that does not leak length through timing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = NodeCrypto.createHash("sha256").update(a).digest();
  const digestB = NodeCrypto.createHash("sha256").update(b).digest();
  return NodeCrypto.timingSafeEqual(digestA, digestB);
}

/** How far a Standard Webhooks timestamp may be from the receive time, either way. */
export const STANDARD_WEBHOOKS_TOLERANCE_SECONDS = 5 * 60;

/** The spec's minimum secret size; anything shorter is almost always a truncated paste. */
const STANDARD_WEBHOOKS_MIN_KEY_BYTES = 24;
const STANDARD_WEBHOOKS_SECRET_PREFIX = "whsec_";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes a Standard Webhooks secret: base64, optionally prefixed with
 * `whsec_`. Null when it is not base64 or too short to be a real secret.
 */
export function standardWebhooksKey(secret: string): Buffer | null {
  const encoded = secret.startsWith(STANDARD_WEBHOOKS_SECRET_PREFIX)
    ? secret.slice(STANDARD_WEBHOOKS_SECRET_PREFIX.length)
    : secret;
  if (!BASE64.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.byteLength < STANDARD_WEBHOOKS_MIN_KEY_BYTES ? null : key;
}

export type WebhookVerification =
  | { readonly verified: false }
  | {
      readonly verified: true;
      /** The Standard Webhooks `webhook-id`, covered by the signature; null for plain HMAC. */
      readonly webhookId: string | null;
    };

const REJECTED: WebhookVerification = { verified: false };

/**
 * Checks a request's signature with the task's scheme. `receivedAtMs` is when
 * the request reached T3 (or the relay, for a held request), which a Standard
 * Webhooks timestamp must be within tolerance of.
 */
export function verifyWebhookSignature(input: {
  readonly signature: ScheduledTaskWebhookSignature;
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly receivedAtMs: number;
}): WebhookVerification {
  const { signature } = input;
  if (signature.scheme === "standard_webhooks") return verifyStandardWebhooks(input);
  return verifyHmac({ ...input, signature }) ? { verified: true, webhookId: null } : REJECTED;
}

/**
 * HMAC-SHA256 over the raw body bytes, as GitHub, Linear, Shopify and most
 * other signing senders do. The header value is `<prefix><digest>`, with the
 * digest hex- or base64-encoded.
 */
function verifyHmac(input: {
  readonly signature: Extract<ScheduledTaskWebhookSignature, { scheme: "hmac_sha256" }>;
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}): boolean {
  const received = input.headers[input.signature.header.toLowerCase()];
  if (received === undefined) return false;
  const value = received.trim();
  const prefix = input.signature.prefix;
  if (prefix !== "" && !value.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const digest = NodeCrypto.createHmac("sha256", input.secret).update(input.body).digest();
  const expected =
    input.signature.encoding === "hex" ? digest.toString("hex") : digest.toString("base64");
  const candidate = value.slice(prefix.length);
  return constantTimeEquals(
    input.signature.encoding === "hex" ? candidate.toLowerCase() : candidate,
    expected,
  );
}

/**
 * Standard Webhooks (https://www.standardwebhooks.com): HMAC-SHA256 over
 * `${webhook-id}.${webhook-timestamp}.${body}`, sent in `webhook-signature`
 * as space-delimited `v1,<base64>` entries so a sender can sign with an old
 * and a new secret while rotating. Any `v1` entry may match; other versions
 * (such as asymmetric `v1a`) are skipped.
 */
function verifyStandardWebhooks(input: {
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly receivedAtMs: number;
}): WebhookVerification {
  const id = input.headers["webhook-id"]?.trim();
  const timestamp = input.headers["webhook-timestamp"]?.trim();
  const signatures = input.headers["webhook-signature"];
  // A period in the id would blur where the id ends and the timestamp begins,
  // letting one signature stand for a different id, timestamp and body.
  if (
    !id ||
    id.includes(".") ||
    timestamp === undefined ||
    !/^\d+$/.test(timestamp) ||
    signatures === undefined
  ) {
    return REJECTED;
  }
  const receivedAtSeconds = Math.floor(input.receivedAtMs / 1000);
  if (Math.abs(receivedAtSeconds - Number(timestamp)) > STANDARD_WEBHOOKS_TOLERANCE_SECONDS) {
    return REJECTED;
  }
  const key = standardWebhooksKey(input.secret);
  if (key === null) return REJECTED;
  const expected = NodeCrypto.createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(input.body)
    .digest("base64");
  const matched = signatures.split(" ").some((entry) => {
    const comma = entry.indexOf(",");
    return (
      comma !== -1 &&
      entry.slice(0, comma) === "v1" &&
      constantTimeEquals(entry.slice(comma + 1), expected)
    );
  });
  return matched ? { verified: true, webhookId: id } : REJECTED;
}
