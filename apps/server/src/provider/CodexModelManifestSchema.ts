import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const CodexVerbositySchema = Schema.Literals(["low", "medium", "high"]);
export type CodexVerbosity = typeof CodexVerbositySchema.Type;

export const CodexVerbosityMetadataSchema = Schema.Struct({
  support_verbosity: Schema.Boolean,
  default_verbosity: Schema.optional(CodexVerbositySchema),
});
export type CodexVerbosityMetadata = typeof CodexVerbosityMetadataSchema.Type;

export const CodexModelAdapterSchema = Schema.Struct({
  codex: Schema.optional(CodexVerbosityMetadataSchema),
});
export type CodexVerbositySupport = Omit<CodexVerbosityMetadata, "support_verbosity"> & {
  readonly support_verbosity: true;
};

export const decodeCodexModelAdapter = Schema.decodeUnknownOption(CodexModelAdapterSchema);
export const decodeCodexVerbosity = Schema.decodeUnknownOption(CodexVerbositySchema);

interface CodexManifestAdapterInput {
  readonly providers?:
    | Readonly<
        Record<
          string,
          | {
              readonly profiles: Readonly<Record<string, { readonly adapter?: unknown }>>;
              readonly models: ReadonlyArray<{ readonly adapter?: unknown }>;
            }
          | undefined
        >
      >
    | undefined;
}

export function hasValidCodexManifestAdapters(manifest: CodexManifestAdapterInput): boolean {
  const catalog = manifest.providers?.codex;
  if (!catalog) return true;

  return (
    Object.values(catalog.profiles).every((profile) =>
      Option.isSome(decodeCodexModelAdapter(profile.adapter ?? {})),
    ) &&
    catalog.models.every((model) => Option.isSome(decodeCodexModelAdapter(model.adapter ?? {})))
  );
}
