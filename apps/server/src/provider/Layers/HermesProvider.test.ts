import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  buildHermesCapabilitiesFromConfigOptions,
  buildHermesDiscoveredModels,
  checkHermesProviderStatus,
  makePendingHermesProvider,
} from "./HermesProvider.ts";

const decodeSettings = Schema.decodeSync(HermesSettings);

describe("HermesProvider", () => {
  it.effect("builds a CLI-oriented pending snapshot with in-session model changes", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingHermesProvider(
        decodeSettings({ enabled: true, binaryPath: "hermes" }),
      );
      expect(snapshot.message).toContain("Hermes CLI");
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.models[0]?.slug).toBe("hermes-default");
    }),
  );

  it("preserves provider-qualified ACP model ids and generic config options", () => {
    const configOptions = [
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        type: "select" as const,
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
      {
        id: "extended_context",
        name: "Extended context",
        type: "boolean" as const,
        currentValue: true,
      },
    ];
    const models = buildHermesDiscoveredModels(
      {
        currentModelId: "anthropic:claude-sonnet-5",
        availableModels: [
          {
            modelId: "anthropic:claude-sonnet-5",
            name: "Claude Sonnet 5",
          },
          {
            modelId: "openrouter:moonshotai/kimi-k2.5",
            name: "Kimi K2.5",
          },
        ],
      },
      configOptions,
    );
    expect(models.map((model) => model.slug)).toEqual([
      "anthropic:claude-sonnet-5",
      "openrouter:moonshotai/kimi-k2.5",
    ]);
    expect(models[0]?.capabilities?.optionDescriptors?.map((option) => option.id)).toEqual([
      "reasoning_effort",
      "extended_context",
    ]);
    expect(buildHermesCapabilitiesFromConfigOptions(configOptions)).toEqual(
      models[0]?.capabilities,
    );
  });
});

it.layer(NodeServices.layer)("checkHermesProviderStatus", (it) => {
  it.effect("reports a missing Hermes CLI", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkHermesProviderStatus(
        decodeSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/hermes",
        }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );
});
