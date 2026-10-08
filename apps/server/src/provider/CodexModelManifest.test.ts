import { assert, describe, it } from "@effect/vitest";

import { type ServerProviderModel } from "@t3tools/contracts";

import {
  applyCodexVerbosityCapabilities,
  getCodexVerbositySupport,
  resolveCodexSessionVerbosity,
} from "./CodexModelManifest.ts";
import { BUNDLED_MODEL_MANIFEST, type ModelManifestData } from "./ModelManifest.ts";

const VERBOSITY_DESCRIPTION = "Controls how much detail Codex uses for each turn.";

type ManifestProvider = NonNullable<ModelManifestData["providers"]>[string];
type ManifestModel = ManifestProvider["models"][number];
type ManifestProfile = ManifestProvider["profiles"][string];

const manifestModel = (overrides: Partial<ManifestModel>): ManifestModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  status: "current",
  ...overrides,
});

const manifest = (input: {
  readonly models: Array<ManifestModel>;
  readonly profiles?: Record<string, ManifestProfile>;
}): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    codex: {
      profiles: input.profiles ?? {},
      models: input.models,
    },
  },
});

const serverModel = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("getCodexVerbositySupport", () => {
  it("resolves exact models and declared aliases while rejecting unsupported metadata", () => {
    const testManifest = manifest({
      profiles: {
        supported: {
          adapter: { codex: { support_verbosity: true, default_verbosity: "low" } },
        },
        unsupported: {
          adapter: { codex: { support_verbosity: false, default_verbosity: "high" } },
        },
        malformed: {
          adapter: { codex: { support_verbosity: true, default_verbosity: "invalid" } },
        },
      },
      models: [
        manifestModel({ slug: "gpt-5.6-sol", aliases: ["sol"], profile: "supported" }),
        manifestModel({ slug: "gpt-5.6-terra", profile: "unsupported" }),
        manifestModel({ slug: "gpt-malformed", profile: "malformed" }),
        manifestModel({
          slug: "gpt-direct-false",
          profile: "supported",
          adapter: { codex: { support_verbosity: false } },
        }),
      ],
    });

    assert.deepStrictEqual(getCodexVerbositySupport(testManifest, "gpt-5.6-sol"), {
      support_verbosity: true,
      default_verbosity: "low",
    });
    assert.deepStrictEqual(getCodexVerbositySupport(testManifest, "sol"), {
      support_verbosity: true,
      default_verbosity: "low",
    });
    assert.strictEqual(getCodexVerbositySupport(testManifest, "gpt-5.6-terra"), undefined);
    assert.strictEqual(getCodexVerbositySupport(testManifest, "gpt-malformed"), undefined);
    assert.strictEqual(getCodexVerbositySupport(testManifest, "gpt-direct-false"), undefined);
    assert.strictEqual(getCodexVerbositySupport(testManifest, "gpt-5.6"), undefined);
    assert.strictEqual(getCodexVerbositySupport(testManifest, "openai.gpt-5.6-sol"), undefined);
    assert.strictEqual(getCodexVerbositySupport(testManifest, "gpt-6-astra"), undefined);
    assert.strictEqual(getCodexVerbositySupport(testManifest, "gpt-5.6-luna"), undefined);
  });
});

describe("applyCodexVerbosityCapabilities", () => {
  it("adds the GPT-5 family descriptor without changing other capabilities or model ids", () => {
    const longSlug =
      "gpt-5-supported/experimental/reasoning/verbosity/variant/custom-variant/long-model-id";
    const reasoning = {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select" as const,
      options: [{ id: "high", label: "High", isDefault: true }],
      currentValue: "high",
    };
    const serviceTier = {
      id: "serviceTier",
      label: "Service Tier",
      type: "select" as const,
      options: [{ id: "flex", label: "Flex", isDefault: true }],
      currentValue: "flex",
    };
    const inheritedVerbosity = {
      id: "verbosity",
      label: "Inherited Verbosity",
      type: "select" as const,
      options: [{ id: "low", label: "Low" }],
      currentValue: "low",
    };
    const testManifest = manifest({
      profiles: {
        supported: {
          adapter: { codex: { support_verbosity: true, default_verbosity: "low" } },
        },
        unsupported: {
          adapter: { codex: { support_verbosity: false } },
        },
      },
      models: [
        manifestModel({ slug: "gpt-5-supported", profile: "supported" }),
        manifestModel({ slug: "gpt-5-disabled", profile: "unsupported" }),
        manifestModel({ slug: longSlug, aliases: ["long-supported"], profile: "supported" }),
      ],
    });
    const models = [
      serverModel({
        slug: "gpt-5-supported",
        isDefault: true,
        capabilities: { optionDescriptors: [inheritedVerbosity, reasoning, serviceTier] },
      }),
      serverModel({
        slug: "gpt-5-disabled",
        capabilities: { optionDescriptors: [reasoning, inheritedVerbosity] },
      }),
      serverModel({
        slug: "gpt-unknown",
        isCustom: true,
        capabilities: { optionDescriptors: [inheritedVerbosity, serviceTier] },
      }),
      serverModel({ slug: longSlug }),
      serverModel({ slug: "gpt-5.4" }),
    ];

    const applied = applyCodexVerbosityCapabilities(models, testManifest);
    assert.deepStrictEqual(
      applied.map(({ slug, isDefault, isCustom }) => ({ slug, isDefault, isCustom })),
      models.map(({ slug, isDefault, isCustom }) => ({ slug, isDefault, isCustom })),
    );

    assert.deepStrictEqual(applied[0]?.capabilities?.optionDescriptors, [
      reasoning,
      serviceTier,
      {
        id: "verbosity",
        label: "Verbosity",
        description: VERBOSITY_DESCRIPTION,
        type: "select",
        options: [
          { id: "low", label: "Low", description: VERBOSITY_DESCRIPTION },
          {
            id: "medium",
            label: "Medium",
            description: VERBOSITY_DESCRIPTION,
            isDefault: true,
          },
          { id: "high", label: "High", description: VERBOSITY_DESCRIPTION },
        ],
        currentValue: "medium",
      },
    ]);
    assert.deepStrictEqual(
      applied[1]?.capabilities?.optionDescriptors?.map((descriptor) => descriptor.id),
      ["reasoningEffort", "verbosity"],
    );
    assert.deepStrictEqual(applied[2]?.capabilities?.optionDescriptors, [serviceTier]);
    assert.strictEqual(applied[3]?.slug, longSlug);
    assert.strictEqual(applied[3]?.capabilities?.optionDescriptors?.[0]?.id, "verbosity");
    assert.strictEqual(applied[3]?.capabilities?.optionDescriptors?.[0]?.currentValue, "medium");
    assert.strictEqual(applied[4]?.capabilities?.optionDescriptors?.[0]?.id, "verbosity");
    assert.strictEqual(applied[4]?.capabilities?.optionDescriptors?.[0]?.currentValue, "medium");
  });
});

describe("resolveCodexSessionVerbosity", () => {
  it("uses the resolved GPT-5 family with a medium default and selected turn value", () => {
    const testManifest = manifest({
      profiles: {
        supported: {
          adapter: { codex: { support_verbosity: true, default_verbosity: "low" } },
        },
        unsupported: {
          adapter: { codex: { support_verbosity: false } },
        },
      },
      models: [
        manifestModel({ slug: "gpt-5.6-sol", aliases: ["gpt56"] }),
        manifestModel({ slug: "gpt-5-disabled", profile: "unsupported" }),
        manifestModel({ slug: "gpt-4-supported", profile: "supported" }),
      ],
    });

    assert.strictEqual(resolveCodexSessionVerbosity(testManifest, "gpt-5.4", undefined), "medium");
    assert.strictEqual(resolveCodexSessionVerbosity(testManifest, "gpt56", "high"), "high");
    assert.strictEqual(resolveCodexSessionVerbosity(testManifest, "gpt-5-disabled", "low"), "low");
    assert.strictEqual(resolveCodexSessionVerbosity(testManifest, "gpt-5.4", "invalid"), undefined);
    assert.strictEqual(
      resolveCodexSessionVerbosity(testManifest, "gpt-4-supported", "high"),
      undefined,
    );
    assert.strictEqual(
      resolveCodexSessionVerbosity(testManifest, "gpt-5-unknown", undefined),
      "medium",
    );
  });
});

describe("bundled Codex verbosity catalog", () => {
  it("contains only the verified model tuples and no chat default", () => {
    const catalog = BUNDLED_MODEL_MANIFEST.providers?.codex;

    assert.deepStrictEqual(
      catalog?.models.map(({ slug, profile, status }) => ({ slug, profile, status })),
      [
        { slug: "gpt-5.6-sol", profile: "verbosity-supported-low", status: "current" },
        { slug: "gpt-5.6-terra", profile: "verbosity-supported-low", status: "current" },
      ],
    );
    assert.strictEqual(catalog?.defaults, undefined);
    assert.deepStrictEqual(getCodexVerbositySupport(BUNDLED_MODEL_MANIFEST, "gpt-5.6-sol"), {
      support_verbosity: true,
      default_verbosity: "low",
    });
    assert.deepStrictEqual(getCodexVerbositySupport(BUNDLED_MODEL_MANIFEST, "gpt-5.6-terra"), {
      support_verbosity: true,
      default_verbosity: "low",
    });
    assert.strictEqual(getCodexVerbositySupport(BUNDLED_MODEL_MANIFEST, "gpt-6-astra"), undefined);
    assert.strictEqual(getCodexVerbositySupport(BUNDLED_MODEL_MANIFEST, "gpt-5.6-luna"), undefined);
  });
});
