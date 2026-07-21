import { type HermesSettings, type ServerProviderModel } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { createModelCapabilities } from "@t3tools/shared/model";

import type { HermesGatewayClient } from "../hermes/HermesGatewayClient.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_MODEL = "hermes-agent";

function fallbackModels(settings: HermesSettings): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return [DEFAULT_MODEL, ...settings.customModels].flatMap((candidate) => {
    const slug = candidate.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      { slug, name: slug, isCustom: slug !== DEFAULT_MODEL, capabilities: EMPTY_CAPABILITIES },
    ];
  });
}

export const makePendingHermesProvider = Effect.fn("makePendingHermesProvider")(function* (
  settings: HermesSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: fallbackModels(settings),
    probe: settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: settings.gatewayUrl
            ? "Checking Hermes gateway availability..."
            : "Configure a Hermes gateway URL and shared secret.",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
  });
});

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  settings: HermesSettings,
  client: HermesGatewayClient | undefined,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbacks = fallbackModels(settings);
  if (!settings.enabled) return yield* makePendingHermesProvider(settings);
  if (!settings.gatewayUrl.trim() || !client) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbacks,
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Configure a valid Hermes gateway URL and shared secret.",
      },
    });
  }

  const result = yield* Effect.tryPromise({
    try: async (signal) => {
      const health = await client.health(signal);
      const models = await client.listModels(signal);
      return { health, models };
    },
    catch: () => "hermes-probe-failed" as const,
  }).pipe(Effect.timeout("10 seconds"), Effect.result);

  if (Result.isFailure(result)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbacks,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Hermes gateway health or authentication check failed.",
      },
    });
  }

  const discovered = result.success.models.map(
    (model) =>
      ({
        slug: model.id,
        name: model.id,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      }) satisfies ServerProviderModel,
  );
  const models = discovered.length > 0 ? discovered : fallbacks;
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: result.success.health.version ?? null,
      status: "ready",
      auth: { status: "authenticated", type: "shared-secret", label: "Gateway shared secret" },
      message: "Hermes gateway is ready.",
    },
  });
});
