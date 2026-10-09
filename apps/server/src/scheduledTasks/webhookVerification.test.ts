// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no createHmac.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";

import { standardWebhooksKey, verifyWebhookSignature } from "./webhookVerification.ts";

const body = new TextEncoder().encode('{"action":"opened"}');
const secret = "shared-secret";
const hmac = () => NodeCrypto.createHmac("sha256", secret).update(body);
const receivedAtMs = 0;

describe("verifyWebhookSignature", () => {
  const github = {
    scheme: "hmac_sha256",
    header: "x-hub-signature-256",
    encoding: "hex",
    prefix: "sha256=",
  } as const;
  const verified = (input: Omit<Parameters<typeof verifyWebhookSignature>[0], "receivedAtMs">) =>
    verifyWebhookSignature({ ...input, receivedAtMs }).verified;

  it("accepts a GitHub-style hex signature with prefix", () => {
    const headers = { "x-hub-signature-256": `sha256=${hmac().digest("hex")}` };
    assert.deepStrictEqual(
      verifyWebhookSignature({ signature: github, secret, headers, body, receivedAtMs }),
      { verified: true, webhookId: null },
    );
  });

  it("rejects a tampered body, a wrong secret, a missing header and a missing prefix", () => {
    const valid = `sha256=${hmac().digest("hex")}`;
    const tampered = new TextEncoder().encode('{"action":"closed"}');
    assert.isFalse(
      verified({
        signature: github,
        secret,
        headers: { "x-hub-signature-256": valid },
        body: tampered,
      }),
    );
    assert.isFalse(
      verified({
        signature: github,
        secret: "other",
        headers: { "x-hub-signature-256": valid },
        body,
      }),
    );
    assert.isFalse(verified({ signature: github, secret, headers: {}, body }));
    assert.isFalse(
      verified({
        signature: github,
        secret,
        headers: { "x-hub-signature-256": hmac().digest("hex") },
        body,
      }),
    );
  });

  it("accepts a base64 signature without prefix", () => {
    assert.isTrue(
      verified({
        signature: { scheme: "hmac_sha256", header: "X-Signature", encoding: "base64", prefix: "" },
        secret,
        headers: { "x-signature": hmac().digest("base64") },
        body,
      }),
    );
  });
});

describe("verifyWebhookSignature with Standard Webhooks", () => {
  // The vector shared by the reference libraries' test suites
  // (github.com/standard-webhooks/standard-webhooks/tree/main/libraries).
  const vector = {
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: 1614265330,
    payload: new TextEncoder().encode('{"test": 2432232314}'),
    signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  };
  const signature = { scheme: "standard_webhooks" } as const;
  const verify = (
    overrides: {
      readonly secret?: string;
      readonly headers?: Record<string, string>;
      readonly body?: Uint8Array;
      readonly receivedAtMs?: number;
    } = {},
  ) =>
    verifyWebhookSignature({
      signature,
      secret: overrides.secret ?? vector.secret,
      headers: overrides.headers ?? {
        "webhook-id": vector.id,
        "webhook-timestamp": String(vector.timestamp),
        "webhook-signature": vector.signature,
      },
      body: overrides.body ?? vector.payload,
      receivedAtMs: overrides.receivedAtMs ?? vector.timestamp * 1000,
    });
  const headers = (signatureHeader: string, extra: Record<string, string> = {}) => ({
    "webhook-id": vector.id,
    "webhook-timestamp": String(vector.timestamp),
    "webhook-signature": signatureHeader,
    ...extra,
  });

  /** Signs the way PostHog's HTTP Webhook destination does (nodejs/src/cdp/utils/standard-webhooks.ts). */
  const posthogSign = (input: {
    readonly secret: string;
    readonly id: string;
    readonly timestamp: number;
    readonly body: string;
  }) => {
    const key = Buffer.from(input.secret.replace(/^whsec_/, ""), "base64");
    const digest = NodeCrypto.createHmac("sha256", key)
      .update(`${input.id}.${input.timestamp}.${input.body}`)
      .digest("base64");
    return {
      "webhook-id": input.id,
      "webhook-timestamp": String(input.timestamp),
      "webhook-signature": `v1,${digest}`,
    };
  };

  it("accepts the reference vector and returns the verified webhook-id", () => {
    assert.deepStrictEqual(verify(), { verified: true, webhookId: vector.id });
  });

  it("accepts the secret without its whsec_ prefix", () => {
    assert.isTrue(verify({ secret: vector.secret.slice("whsec_".length) }).verified);
  });

  it("accepts an unpadded base64 secret", () => {
    // From the Python library's tests; PostHog accepts unpadded secrets too.
    const unpadded = "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSwBr";
    const signed = posthogSign({
      secret: unpadded,
      id: vector.id,
      timestamp: vector.timestamp,
      body: '{"test": 2432232314}',
    });
    assert.isTrue(verify({ secret: unpadded, headers: signed }).verified);
  });

  it("accepts any matching v1 entry and skips other versions", () => {
    const listed = [
      "v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=",
      "v2,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=",
      vector.signature,
      "v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc=",
    ].join(" ");
    assert.isTrue(verify({ headers: headers(listed) }).verified);
    const signatureOnly = vector.signature.slice("v1,".length);
    assert.isFalse(verify({ headers: headers(`v1a,${signatureOnly}`) }).verified);
    assert.isFalse(verify({ headers: headers(`v2,${signatureOnly}`) }).verified);
    assert.isFalse(verify({ headers: headers(signatureOnly) }).verified);
  });

  it("interoperates with PostHog's signing", () => {
    const posthogSecret = `whsec_${NodeCrypto.randomBytes(32).toString("base64")}`;
    const timestamp = 1_760_000_000;
    const json = '{"event":"$pageview","distinct_id":"user-1"}';
    const signed = posthogSign({ secret: posthogSecret, id: "event-uuid", timestamp, body: json });
    assert.deepStrictEqual(
      verify({
        secret: posthogSecret,
        headers: signed,
        body: new TextEncoder().encode(json),
        receivedAtMs: timestamp * 1000 + 1_500,
      }),
      { verified: true, webhookId: "event-uuid" },
    );
  });

  it("rejects a tampered body, id or timestamp, and a wrong secret", () => {
    assert.isFalse(verify({ body: new TextEncoder().encode('{"test": 2432232315}') }).verified);
    assert.isFalse(
      verify({ headers: headers(vector.signature, { "webhook-id": "msg_other" }) }).verified,
    );
    assert.isFalse(
      verify({
        headers: headers(vector.signature, { "webhook-timestamp": String(vector.timestamp + 1) }),
        receivedAtMs: (vector.timestamp + 1) * 1000,
      }).verified,
    );
    assert.isFalse(
      verify({ secret: `whsec_${NodeCrypto.randomBytes(24).toString("base64")}` }).verified,
    );
  });

  it("allows 5 minutes of clock difference in either direction", () => {
    const at = (offsetSeconds: number) =>
      verify({ receivedAtMs: (vector.timestamp + offsetSeconds) * 1000 }).verified;
    assert.isTrue(at(300));
    assert.isTrue(at(-300));
    assert.isFalse(at(301));
    assert.isFalse(at(-301));
  });

  it("rejects missing and malformed headers", () => {
    const { "webhook-id": _id, ...withoutId } = headers(vector.signature);
    const { "webhook-timestamp": _timestamp, ...withoutTimestamp } = headers(vector.signature);
    const { "webhook-signature": _signature, ...withoutSignature } = headers(vector.signature);
    for (const malformed of [
      withoutId,
      withoutTimestamp,
      withoutSignature,
      headers(vector.signature, { "webhook-id": "" }),
      headers(vector.signature, { "webhook-timestamp": "1614265330.0" }),
      headers(vector.signature, { "webhook-timestamp": "-1614265330" }),
      headers(vector.signature, { "webhook-timestamp": "2021-02-25T15:02:10Z" }),
      headers(""),
      headers("v1,"),
      headers("v1,not base64!"),
    ]) {
      assert.isFalse(verify({ headers: malformed }).verified, JSON.stringify(malformed));
    }
  });

  it("rejects a secret that is not base64 or is shorter than 24 bytes", () => {
    assert.isFalse(verify({ secret: "shared-secret" }).verified);
    assert.isFalse(
      verify({ secret: `whsec_${NodeCrypto.randomBytes(16).toString("base64")}` }).verified,
    );
  });
});

describe("standardWebhooksKey", () => {
  it("decodes whsec_ and bare base64 secrets of at least 24 bytes", () => {
    const key = NodeCrypto.randomBytes(32);
    assert.deepStrictEqual(standardWebhooksKey(`whsec_${key.toString("base64")}`), key);
    assert.deepStrictEqual(standardWebhooksKey(key.toString("base64")), key);
    assert.isNull(standardWebhooksKey(NodeCrypto.randomBytes(23).toString("base64")));
    assert.isNull(standardWebhooksKey("whsec_not base64"));
    assert.isNull(standardWebhooksKey(""));
  });
});
