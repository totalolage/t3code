import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { hasDeployChanges, makeDeployConfigProvider, reconcileRootEnvRelayUrl } from "./deploy.ts";

describe("hasDeployChanges", () => {
  it("detects resource, binding, and deletion changes", () => {
    expect(hasDeployChanges({ resources: {}, deletions: {} } as never)).toBe(false);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "create", bindings: [] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {
          api: { action: "noop", bindings: [{ action: "update" }] },
        },
        deletions: {},
      } as never),
    ).toBe(true);
    expect(
      hasDeployChanges({
        resources: {},
        deletions: {
          api: { action: "delete", bindings: [] },
        },
      } as never),
    ).toBe(true);
  });
});

describe("makeDeployConfigProvider", () => {
  it("prefers injected environment values while retaining dotenv fallbacks", async () => {
    const provider = makeDeployConfigProvider(
      ConfigProvider.fromEnv({ env: { T3_RELAY_DOMAIN: "ci.example.test" } }),
      ConfigProvider.fromEnv({
        env: {
          T3_RELAY_DOMAIN: "dotenv.example.test",
          T3_RELAY_ZONE_NAME: "example.test",
        },
      }),
    );
    const config = Config.all({
      relayDomain: Config.string("T3_RELAY_DOMAIN"),
      relayZoneName: Config.string("T3_RELAY_ZONE_NAME"),
    }).pipe(Effect.provide(ConfigProvider.layer(provider)));

    await expect(Effect.runPromise(config)).resolves.toEqual({
      relayDomain: "ci.example.test",
      relayZoneName: "example.test",
    });
  });
});

describe("reconcileRootEnvRelayUrl", () => {
  it("adds the relay URL to an empty root env file", () => {
    expect(reconcileRootEnvRelayUrl("", "https://relay.example.test")).toBe(
      "T3_RELAY_URL=https://relay.example.test\n",
    );
  });

  it("preserves unrelated root env entries while replacing a previous relay URL", () => {
    expect(
      reconcileRootEnvRelayUrl(
        "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3_RELAY_URL=https://old.example.test\n",
        "https://relay.example.test",
      ),
    ).toBe(
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_test_example\nT3_RELAY_URL=https://relay.example.test\n",
    );
  });
});
