import {
  REMOTE_INTERACTION_ID_MAX_CHARS,
  REMOTE_INTERACTION_OPTION_MAX_COUNT,
  REMOTE_INTERACTION_QUESTION_MAX_COUNT,
  RemotePendingInteraction,
  type RemotePendingInteractionAction,
  type RemotePendingInteractionQuestion,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PendingInteractionQuestion as PendingInteractionQuestionSchema,
  type InteractionRecord,
  type PendingInteractionQuestion,
} from "../persistence/Services/PendingInteractionResponses.ts";

const REDACTION_MARKER = "[redacted]";
const QUESTION_HEADER_FALLBACK = "Input needed";
const QUESTION_PROMPT_FALLBACK = "The agent needs input.";
const OPTION_LABEL_FALLBACK = "Option";
const OPTION_DESCRIPTION_FALLBACK = "Available choice";
const INTERACTION_SUMMARY_FALLBACK = "Interaction requested";

const CONTROL_OR_ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- the public boundary must remove these bytes
  /\u001b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;
const PEM_BLOCK_PATTERN = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/giu;
const BEARER_CREDENTIAL_PATTERN = /\b(?:authorization\s*:\s*)?bearer\s+[^\s,;)}\]]+/giu;
const CREDENTIAL_PATTERN =
  /\b["']?(?:access[_-]?token|api[_-]?key|client[_-]?secret|credential|password|passwd|private[_-]?key|refresh[_-]?token|secret|token)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;)}\]]+)/giu;
const ENV_ASSIGNMENT_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s,;)}\]]+/gu;
const URL_PATTERN = /\b(?:https?|ftp|file):\/\/[^\s,;)}\]]+/giu;
const PATH_PATTERN =
  /(?:[A-Za-z]:[\\/][^\s,;)}\]]+|~[\\/][^\s,;)}\]]+|\.{1,2}[\\/][^\s,;)}\]]+|\/[^\s,;)}\]]+|\b[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+)/gu;
const LONG_OPAQUE_PATTERN = /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_+/=-]{40,})\b/gu;
const INLINE_CODE_PATTERN = /`[^`\r\n]+`/gu;
const COMMAND_LINE_PATTERN =
  /(?:^|\s)(?:[$>#]\s+|(?:sudo\s+)?(?:bash|sh|zsh|fish|pwsh|powershell|cmd|cat|cd|chmod|chown|cp|curl|env|git|ls|mv|npm|pnpm|printenv|python|rm|ssh|tar|wget)(?:\.exe)?(?:\s+|$))[^\r\n]*/giu;
const SHELL_SYNTAX_PATTERN = /(?:\$\(|\$\{|&&|\|\||(?:^|\s)[|<>]{1,2}(?:\s|$))/u;
const ERROR_OR_TRACE_PATTERN = /(?:^|\s)(?:traceback|stack trace|stderr:|stdout:|error:)\s/i;

const SafeQuestionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(REMOTE_INTERACTION_ID_MAX_CHARS),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
);
const isSafeQuestionId = Schema.is(SafeQuestionId);

// Do not use the public TrimmedNonEmptyString schema here. Native IDs and
// option values are answer keys, so their exact strings must be retained in
// the provider-only fields below while their display copies are sanitized.
const NativeRequiredText = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/\S/u));
const NativeQuestionOption = Schema.Struct({
  label: NativeRequiredText,
  description: Schema.String,
  value: Schema.optional(Schema.String),
});
const NativeQuestion = Schema.Struct({
  id: NativeRequiredText,
  header: NativeRequiredText,
  question: NativeRequiredText,
  options: Schema.Array(NativeQuestionOption).check(
    Schema.isMaxLength(REMOTE_INTERACTION_OPTION_MAX_COUNT),
  ),
  allowCustomAnswer: Schema.optional(Schema.Boolean),
  multiSelect: Schema.optional(Schema.Boolean),
});
type NativeQuestionOptionType = typeof NativeQuestionOption.Type;
const NativeQuestions = Schema.Array(NativeQuestion).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(REMOTE_INTERACTION_QUESTION_MAX_COUNT),
);
const decodeNativeQuestions = Schema.decodeUnknownOption(NativeQuestions);
const decodePendingInteractionQuestion = Schema.decodeUnknownOption(
  PendingInteractionQuestionSchema,
);
const decodeRemotePendingInteraction = Schema.decodeUnknownSync(RemotePendingInteraction);

interface SanitizedText {
  readonly value: string;
  readonly unsafe: boolean;
}

function replaceUnsafe(value: string, pattern: RegExp): SanitizedText {
  const next = value.replace(pattern, REDACTION_MARKER);
  return { value: next, unsafe: next !== value };
}

function sanitizeText(value: unknown, fallback: string, maxChars: number): SanitizedText {
  if (typeof value !== "string" || value.length === 0) {
    return { value: fallback, unsafe: true };
  }

  if (
    /[\r\n\u2028\u2029]/u.test(value) ||
    SHELL_SYNTAX_PATTERN.test(value) ||
    ERROR_OR_TRACE_PATTERN.test(value)
  ) {
    return { value: fallback, unsafe: true };
  }

  let sanitized = value;
  let unsafe = false;
  const controlFree = sanitized.replace(CONTROL_OR_ANSI_PATTERN, "");
  unsafe ||= controlFree !== sanitized;
  sanitized = controlFree;

  for (const pattern of [
    PEM_BLOCK_PATTERN,
    BEARER_CREDENTIAL_PATTERN,
    CREDENTIAL_PATTERN,
    ENV_ASSIGNMENT_PATTERN,
    URL_PATTERN,
    PATH_PATTERN,
    LONG_OPAQUE_PATTERN,
    INLINE_CODE_PATTERN,
    COMMAND_LINE_PATTERN,
  ]) {
    const result = replaceUnsafe(sanitized, pattern);
    sanitized = result.value;
    unsafe ||= result.unsafe;
  }

  sanitized = sanitized.replace(/\s+/gu, " ").trim();
  if (sanitized.length === 0) {
    return { value: fallback, unsafe: true };
  }

  const bounded = sanitized.slice(0, maxChars).trim();
  return {
    value: bounded.length > 0 ? bounded : fallback,
    unsafe,
  };
}

function appendBoundedSuffix(base: string, suffix: string, maxChars: number): string {
  const suffixText = `${suffix}`;
  return `${base.slice(0, Math.max(1, maxChars - suffixText.length))}${suffixText}`;
}

function uniqueQuestionId(candidate: unknown, index: number, used: Set<string>): string {
  const fallback = `question-${index + 1}`;
  // Public answer keys must not expose secrets retained in providerQuestionId.
  const base =
    typeof candidate === "string" &&
    isSafeQuestionId(candidate) &&
    !sanitizeText(candidate, "", REMOTE_INTERACTION_ID_MAX_CHARS).unsafe &&
    !used.has(candidate)
      ? candidate
      : fallback;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = appendBoundedSuffix(base, `-${suffix}`, REMOTE_INTERACTION_ID_MAX_CHARS);
    suffix += 1;
  }
  used.add(id);
  return id;
}

function uniqueOptionLabel(base: string, used: Set<string>): string {
  let label = base;
  let suffix = 2;
  while (used.has(label)) {
    label = appendBoundedSuffix(base, ` (${suffix})`, 160);
    suffix += 1;
  }
  used.add(label);
  return label;
}

function publicOptionLabel(value: unknown, index: number, used: Set<string>): string {
  const label = sanitizeText(value, OPTION_LABEL_FALLBACK, 160);
  const baseLabel = label.unsafe ? `${OPTION_LABEL_FALLBACK} ${index + 1}` : label.value;
  return uniqueOptionLabel(baseLabel, used);
}

function optionsFromNative(
  options: ReadonlyArray<NativeQuestionOptionType>,
): ReadonlyArray<PendingInteractionQuestion["options"][number]> {
  const usedLabels = new Set<string>();
  return options.map((option, index) => ({
    label: publicOptionLabel(option.label, index, usedLabels),
    description: sanitizeText(option.description, OPTION_DESCRIPTION_FALLBACK, 160).value,
    providerValue: option.value ?? option.label,
  }));
}

function questionOptionsToRemote(
  options: ReadonlyArray<PendingInteractionQuestion["options"][number]>,
): ReadonlyArray<RemotePendingInteractionQuestion["options"][number]> {
  const usedLabels = new Set<string>();
  return options.map((option, index) => {
    return {
      label: publicOptionLabel(option.label, index, usedLabels),
      description: sanitizeText(option.description, OPTION_DESCRIPTION_FALLBACK, 160).value,
    };
  });
}

function questionsToRemote(
  questions: ReadonlyArray<PendingInteractionQuestion>,
): ReadonlyArray<RemotePendingInteractionQuestion> {
  const usedQuestionIds = new Set<string>();
  return questions.map((question, questionIndex) => ({
    id: uniqueQuestionId(question.id, questionIndex, usedQuestionIds),
    header: sanitizeText(question.header, QUESTION_HEADER_FALLBACK, 64).value,
    prompt: sanitizeText(question.prompt, QUESTION_PROMPT_FALLBACK, 512).value,
    options: questionOptionsToRemote(question.options),
    multiSelect: question.multiSelect === true,
    allowsCustomAnswer: question.allowsCustomAnswer === true,
  }));
}

function allowedActions(
  interaction: Pick<InteractionRecord, "kind" | "status">,
): ReadonlyArray<RemotePendingInteractionAction> {
  if (interaction.status === "responding") {
    return [];
  }
  return interaction.kind === "user-input" ? ["answer"] : ["decline", "cancel"];
}

/**
 * Parse native question payloads into the bounded archival shape. The returned
 * display fields are safe, while provider IDs/values remain reversible for
 * answer normalization and never cross the public presentation boundary.
 */
export function questionsFromNative(value: unknown): readonly PendingInteractionQuestion[] | null {
  const decoded = decodeNativeQuestions(value);
  if (Option.isNone(decoded)) {
    return null;
  }

  // Provider IDs are the keys used to normalize answers. Relabeling a duplicate
  // into a unique public ID would leave the archived response map ambiguous.
  if (new Set(decoded.value.map((question) => question.id)).size !== decoded.value.length) {
    return null;
  }

  const usedQuestionIds = new Set<string>();
  const questions = decoded.value.map((question, questionIndex) => ({
    id: uniqueQuestionId(question.id, questionIndex, usedQuestionIds),
    providerQuestionId: question.id,
    header: sanitizeText(question.header, QUESTION_HEADER_FALLBACK, 64).value,
    prompt: sanitizeText(question.question, QUESTION_PROMPT_FALLBACK, 512).value,
    options: optionsFromNative(question.options),
    multiSelect: question.multiSelect === true,
    // ROOT policy: providers omitting the flag intend custom answers to be
    // available, so only an explicit false closes the freeform path.
    allowsCustomAnswer: question.allowCustomAnswer !== false,
  }));

  // A question without choices is only actionable when the native provider
  // permits a custom answer; an explicit false makes it nonactionable.
  if (
    decoded.value.some(
      (question) => question.options.length === 0 && question.allowCustomAnswer === false,
    )
  ) {
    return null;
  }

  return questions.every((question) => Option.isSome(decodePendingInteractionQuestion(question)))
    ? questions
    : null;
}

export function toRemotePendingInteraction(
  interaction: InteractionRecord,
): RemotePendingInteraction {
  if (interaction.status !== "pending" && interaction.status !== "responding") {
    throw new Error(`Cannot present terminal interaction with status "${interaction.status}"`);
  }

  const remote = {
    threadId: interaction.threadId,
    requestId: interaction.requestId,
    kind: interaction.kind,
    status: interaction.status,
    summary: sanitizeText(interaction.summary, INTERACTION_SUMMARY_FALLBACK, 512).value,
    // Provider-derived approval capabilities are never trusted at this boundary.
    canApprove: false,
    allowedActions: allowedActions(interaction),
    questions: interaction.kind === "user-input" ? questionsToRemote(interaction.questions) : [],
    createdAt: interaction.createdAt,
    updatedAt: interaction.updatedAt,
  } as const;

  return decodeRemotePendingInteraction(remote);
}
