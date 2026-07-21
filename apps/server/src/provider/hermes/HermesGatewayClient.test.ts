import { describe, expect, it } from "vite-plus/test";

import {
  HermesGatewayClientError,
  makeHermesGatewayClient,
  normalizeHermesGatewayUrl,
} from "./HermesGatewayClient.ts";

describe("HermesGatewayClient", () => {
  it("sends the shared secret only in the bearer header", async () => {
    const requests: Request[] = [];
    const client = makeHermesGatewayClient({
      gatewayUrl: "https://hermes.example.test/p/work",
      secret: "shared-secret-sentinel",
      fetch: async (input, init) => {
        requests.push(
          input instanceof Request ? new Request(input, init) : new Request(input.toString(), init),
        );
        return new Response(JSON.stringify({ object: "list", data: [{ id: "hermes-agent" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await expect(client.listModels()).resolves.toEqual([{ id: "hermes-agent" }]);
    expect(requests[0]?.url).toBe("https://hermes.example.test/p/work/v1/models");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer shared-secret-sentinel");
    expect(requests[0]?.url).not.toContain("shared-secret-sentinel");
  });

  it("parses Hermes session SSE events in order", async () => {
    const client = makeHermesGatewayClient({
      gatewayUrl: "https://hermes.example.test",
      secret: "test-secret",
      fetch: async () =>
        new Response(
          [
            "event: assistant.delta",
            'data: {"message_id":"msg_1","delta":"Hello"}',
            "",
            "event: run.completed",
            'data: {"completed":true}',
            "",
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const events: string[] = [];

    await client.streamSessionChat("session-1", { message: "Hi" }, (event) => {
      events.push(event.event);
    });

    expect(events).toEqual(["assistant.delta", "run.completed"]);
  });

  it("does not expose the configured secret in authentication errors", async () => {
    const secret = "never-log-this-secret";
    const client = makeHermesGatewayClient({
      gatewayUrl: "https://hermes.example.test",
      secret,
      fetch: async () => new Response("unauthorized", { status: 401 }),
    });

    const error = await client.listModels().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(HermesGatewayClientError);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  it("rejects gateway URLs that could smuggle credentials or request metadata", () => {
    expect(() => normalizeHermesGatewayUrl("https://user:pass@example.test")).toThrow();
    expect(() => normalizeHermesGatewayUrl("https://example.test?token=value")).toThrow();
    expect(() => normalizeHermesGatewayUrl("file:///tmp/hermes.sock")).toThrow();
  });
});
