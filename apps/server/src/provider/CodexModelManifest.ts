import {
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  decodeCodexModelAdapter,
  decodeCodexVerbosity,
  type CodexVerbosity,
  type CodexVerbosityMetadata,
  type CodexVerbositySupport,
} from "./CodexModelManifestSchema.ts";
import {
  resolveProviderCatalog,
  type ModelManifestData,
  type ResolvedManifestModel,
} from "./ModelManifest.ts";

export type { CodexVerbosity, CodexVerbositySupport } from "./CodexModelManifestSchema.ts";

const CODEX = ProviderDriverKind.make("codex");

function resolveCodexCatalogModel(
  manifest: ModelManifestData,
  slug: string,
): ResolvedManifestModel | undefined {
  const catalog = resolveProviderCatalog(manifest, CODEX);
  if (!catalog) return undefined;

  return (
    catalog.models.find((entry) => entry.model.slug === slug) ??
    catalog.models.find((entry) => entry.model.aliases?.includes(slug) === true)
  );
}

function isGpt5Model(modelID: string): boolean {
  return modelID.toLowerCase().startsWith("gpt-5");
}

function resolvesToGpt5Model(manifest: ModelManifestData, slug: string): boolean {
  const catalogModel = resolveCodexCatalogModel(manifest, slug);
  return isGpt5Model(catalogModel?.model.slug ?? slug);
}

function resolveCodexVerbosityMetadata(
  entry: ResolvedManifestModel,
): CodexVerbosityMetadata | undefined {
  for (const adapter of [entry.adapter, entry.profileAdapter]) {
    if (adapter === undefined) continue;

    const decoded = decodeCodexModelAdapter(adapter);
    if (Option.isNone(decoded)) return undefined;
    if (decoded.value.codex !== undefined) return decoded.value.codex;
  }
  return undefined;
}

function isSupportedCodexVerbosity(
  metadata: CodexVerbosityMetadata | undefined,
): metadata is CodexVerbositySupport {
  return metadata?.support_verbosity === true;
}

export function getCodexVerbositySupport(
  manifest: ModelManifestData,
  slug: string,
): CodexVerbositySupport | undefined {
  const entry = resolveCodexCatalogModel(manifest, slug);
  if (!entry) return undefined;

  const metadata = resolveCodexVerbosityMetadata(entry);
  return isSupportedCodexVerbosity(metadata) ? metadata : undefined;
}

const CODEX_VERBOSITY_DESCRIPTION = "Controls how much detail Codex uses for each turn.";

function codexVerbosityDescriptor(): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "verbosity",
    label: "Verbosity",
    description: CODEX_VERBOSITY_DESCRIPTION,
    type: "select",
    options: [
      { id: "low", label: "Low", description: CODEX_VERBOSITY_DESCRIPTION },
      {
        id: "medium",
        label: "Medium",
        description: CODEX_VERBOSITY_DESCRIPTION,
        isDefault: true,
      },
      { id: "high", label: "High", description: CODEX_VERBOSITY_DESCRIPTION },
    ],
    currentValue: "medium",
  };
}

function removeVerbosityDescriptor(
  capabilities: ServerProviderModel["capabilities"],
): ServerProviderModel["capabilities"] {
  if (!capabilities?.optionDescriptors) return capabilities;

  const optionDescriptors = capabilities.optionDescriptors.filter(
    (descriptor) => descriptor.id !== "verbosity",
  );
  return optionDescriptors.length === capabilities.optionDescriptors.length
    ? capabilities
    : { ...capabilities, optionDescriptors };
}

export function applyCodexVerbosityCapabilities(
  models: ReadonlyArray<ServerProviderModel>,
  manifest: ModelManifestData,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    const capabilities = removeVerbosityDescriptor(model.capabilities);
    if (!resolvesToGpt5Model(manifest, model.slug)) {
      return capabilities === model.capabilities ? model : { ...model, capabilities };
    }

    const baseCapabilities = capabilities ?? { optionDescriptors: [] };
    return {
      ...model,
      capabilities: {
        ...baseCapabilities,
        optionDescriptors: [
          ...(baseCapabilities.optionDescriptors ?? []),
          codexVerbosityDescriptor(),
        ],
      },
    };
  });
}

export function resolveCodexSessionVerbosity(
  manifest: ModelManifestData,
  slug: string,
  preference: string | undefined,
): CodexVerbosity | undefined {
  if (!resolvesToGpt5Model(manifest, slug)) return undefined;
  if (preference === undefined) return "medium";

  const decoded = decodeCodexVerbosity(preference);
  return Option.isSome(decoded) ? decoded.value : undefined;
}
