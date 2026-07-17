import { TextGenerationError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isTextGenerationError = Schema.is(TextGenerationError);

/** Convert an Effect Schema to a flat JSON Schema object, inlining `$defs` when present. */
export function toJsonSchemaObject(schema: Schema.Top): unknown {
  const document = Schema.toJsonSchemaDocument(schema);
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    return { ...document.schema, $defs: document.definitions };
  }
  return document.schema;
}

/** Truncate a text section to `maxChars`, appending a `[truncated]` marker when needed. */
export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const truncated = value.slice(0, maxChars);
  return `${truncated}\n\n[truncated]`;
}

/** Preserve both ends of tool output, where setup and final errors commonly live. */
export function limitToolContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = "\n\n[truncated]\n\n";
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`;
}

/** Normalise a raw commit subject to imperative-mood, ≤72 chars, no trailing period. */
export function sanitizeCommitSubject(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const withoutTrailingPeriod = singleLine.replace(/[.]+$/g, "").trim();
  if (withoutTrailingPeriod.length === 0) {
    return "Update project files";
  }

  if (withoutTrailingPeriod.length <= 72) {
    return withoutTrailingPeriod;
  }
  return withoutTrailingPeriod.slice(0, 72).trimEnd();
}

/** Normalise a raw PR title to a single line with a sensible fallback. */
export function sanitizePrTitle(raw: string): string {
  const singleLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  if (singleLine.length > 0) {
    return singleLine;
  }
  return "Update project changes";
}

/** Normalise a raw thread title to a compact single-line sidebar-safe label. */
export function sanitizeThreadTitle(raw: string): string {
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized || normalized.trim().length === 0) {
    return "New thread";
  }

  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47).trimEnd()}...`;
}

/** Normalize a generated tool summary without inventing fallback text. */
export function sanitizeToolSummary(raw: string): string | null {
  let normalized = raw.trim().replace(/\s+/g, " ");
  normalized = normalized
    .replace(/^(?:[>#*_~`-]+\s*)+/, "")
    .replace(/(?:\s*[*_~`]+)+$/, "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .trim();

  if (normalized.length === 0) return null;
  return normalized.length <= 80 ? normalized : normalized.slice(0, 80).trimEnd();
}

/** Keep only one valid generated summary for each supplied activity ID. */
export function normalizeGeneratedToolSummaries(
  knownActivityIds: ReadonlySet<string>,
  generated: ReadonlyArray<{ readonly activityId: string; readonly summary: string }>,
): ReadonlyArray<{ activityId: string; summary: string }> {
  const counts = new Map<string, number>();
  for (const entry of generated) {
    counts.set(entry.activityId, (counts.get(entry.activityId) ?? 0) + 1);
  }

  const summaries: Array<{ activityId: string; summary: string }> = [];
  for (const entry of generated) {
    if (!knownActivityIds.has(entry.activityId) || counts.get(entry.activityId) !== 1) continue;
    const summary = sanitizeToolSummary(entry.summary);
    if (summary) summaries.push({ activityId: entry.activityId, summary });
  }
  return summaries;
}

/** CLI name to human-readable label, e.g. "codex" → "Codex CLI (`codex`)" */
function cliLabel(cliName: string): string {
  const capitalized = cliName.charAt(0).toUpperCase() + cliName.slice(1);
  return `${capitalized} CLI (\`${cliName}\`)`;
}

/**
 * Normalize an unknown error from a CLI text generation process into a
 * typed `TextGenerationError`. Parameterized by CLI name so both Codex
 * and Claude (and future providers) can share the same logic.
 */
export function normalizeCliError(
  cliName: string,
  operation: string,
  error: unknown,
  fallback: string,
): TextGenerationError {
  if (isTextGenerationError(error)) {
    return error;
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (
      error.message.includes(`Command not found: ${cliName}`) ||
      lower.includes(`spawn ${cliName}`) ||
      lower.includes("enoent")
    ) {
      return new TextGenerationError({
        operation,
        detail: `${cliLabel(cliName)} is required but not available on PATH.`,
        cause: error,
      });
    }
    return new TextGenerationError({
      operation,
      detail: fallback,
      cause: error,
    });
  }

  return new TextGenerationError({
    operation,
    detail: fallback,
    cause: error,
  });
}
