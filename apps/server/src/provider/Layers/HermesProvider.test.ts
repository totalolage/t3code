import { assert, it } from "@effect/vitest";
import { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { HermesGatewayClient } from "../hermes/HermesGatewayClient.ts";
import { checkHermesProviderStatus } from "./HermesProvider.ts";

const decodeSettings = Schema.decodeSync(HermesSettings);

function makeClient(input?: {
  readonly version?: string;
  readonly models?: ReadonlyArray<{ readonly id: string }>;
}): HermesGatewayClient {
  return {
    health: async () => ({ version: input?.version ?? "1.2.3" }),
    listModels: async () => input?.models ?? [{ id: "hermes-agent" }],
    createSession: async () => ({ id: "session-1" }),
    getSession: async (sessionId) => ({ id: sessionId }),
    listMessages: async () => [],
    streamSessionChat: async () => undefined,
    chatCompletion: async () => "{}",
  };
}

it.effect("reports an authenticated Hermes gateway and its discovered models", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkHermesProviderStatus(
      decodeSettings({ enabled: true, gatewayUrl: "https://hermes.example.test" }),
      makeClient({ models: [{ id: "model-a" }, { id: "model-b" }] }),
    );

    assert.strictEqual(snapshot.status, "ready");
    assert.strictEqual(snapshot.auth.status, "authenticated");
    assert.strictEqual(snapshot.version, "1.2.3");
    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      ["model-a", "model-b"],
    );
  }),
);

it.effect("reports configuration errors without attempting a gateway request", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkHermesProviderStatus(
      decodeSettings({ enabled: true, gatewayUrl: "" }),
      undefined,
    );

    assert.strictEqual(snapshot.status, "error");
    assert.strictEqual(snapshot.auth.status, "unauthenticated");
    assert.match(snapshot.message ?? "", /gateway URL and shared secret/u);
  }),
);
