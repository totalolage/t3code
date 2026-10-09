import { describe, expect, it } from "vite-plus/test";

import { suggestedWebhookPublicBaseUrl, webhookAddress } from "./webhookAddress.ts";

const path = "/api/hooks/scheduled-task%3Ahook/token";
const endpoint = (url: string | null, urlSource?: "t3-connect" | "public-base-url") => ({
  path,
  url,
  hasSecret: false,
  ...(urlSource === undefined ? {} : { urlSource }),
});

describe("webhookAddress", () => {
  it("uses the T3 Connect URL when the server has one", () => {
    expect(webhookAddress(endpoint("https://relay.t3.codes/v1/hooks/k/t/x"), null)).toEqual({
      address: "https://relay.t3.codes/v1/hooks/k/t/x",
      copyable: true,
      note: null,
    });
  });

  it("uses a public base URL without a T3 Connect nag", () => {
    const url = `https://code.example.com/t3${path}`;
    const result = webhookAddress(endpoint(url, "public-base-url"), "http://127.0.0.1:3773/");
    expect(result.address).toBe(url);
    expect(result.copyable).toBe(true);
    expect(result.note).not.toContain("T3 Connect");
  });

  it("builds a direct URL on the environment's address without T3 Connect", () => {
    const result = webhookAddress(endpoint(null), "https://mac.tail1234.ts.net/");
    expect(result.address).toBe(`https://mac.tail1234.ts.net${path}`);
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Tailscale");
  });

  it("says only this computer can call a loopback address", () => {
    const result = webhookAddress(endpoint(null), "http://127.0.0.1:3773/");
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Only this computer");
  });

  it("falls back to the path when the address is unknown", () => {
    expect(webhookAddress(endpoint(null), null)).toMatchObject({
      address: path,
      copyable: false,
    });
  });
});

describe("suggestedWebhookPublicBaseUrl", () => {
  const direct = (httpBaseUrl: string, tag = "PrimaryConnectionTarget") => ({
    httpBaseUrl,
    target: { _tag: tag },
  });

  it("suggests a direct https address on a public host, keeping its base path", () => {
    expect(suggestedWebhookPublicBaseUrl(direct("https://code.example.com/"))).toBe(
      "https://code.example.com",
    );
    expect(
      suggestedWebhookPublicBaseUrl(direct("https://proxy.acme.dev/t3/", "BearerConnectionTarget")),
    ).toBe("https://proxy.acme.dev/t3");
  });

  it("suggests nothing senders could not reach", () => {
    for (const url of [
      "http://code.example.com/",
      "https://localhost:3773/",
      "https://192.168.1.20:3773/",
      "https://devbox.tail1234.ts.net/",
      "https://devbox.local/",
    ]) {
      expect(suggestedWebhookPublicBaseUrl(direct(url))).toBeNull();
    }
    expect(
      suggestedWebhookPublicBaseUrl(direct("https://relay.t3.codes/x/", "RelayConnectionTarget")),
    ).toBeNull();
    expect(suggestedWebhookPublicBaseUrl(null)).toBeNull();
  });
});
