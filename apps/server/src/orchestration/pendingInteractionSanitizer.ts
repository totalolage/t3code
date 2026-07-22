import {
  ApprovalRequestId,
  REMOTE_INTERACTION_OPTION_MAX_COUNT,
  REMOTE_INTERACTION_QUESTION_MAX_COUNT,
  RemoteInteractionRequestId,
  RemoteInteractionThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type {
  PendingInteractionQuestion,
  PendingInteractionRow,
} from "../persistence/Services/PendingInteractions.ts";

const CONTROL_OR_ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- these bytes must be stripped from public text
  /\u001b\[[0-?]*[ -/]*[@-~]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PEM_BLOCK_PATTERN = /-----BEGIN [^-\r\n]+-----[\s\S]*?-----END [^-\r\n]+-----/gi;
const BEARER_CREDENTIAL_PATTERN = /\b(?:authorization\s*:\s*)?bearer\s+[^\s,;]+/gi;
const CREDENTIAL_PATTERN =
  /\b(?:bearer|token|password|passwd|secret|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi;
const ENV_ASSIGNMENT_PATTERN = /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s,;]+/g;
const PATH_PATTERN =
  /(?:[A-Za-z]:\\|~[\\/]|\.{1,2}[\\/]|\/(?!\/)|\b[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.-])[^\s,;)}\]]+/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s]+/gi;
const LONG_OPAQUE_PATTERN = /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9_+/=-]{40,})\b/g;
const INLINE_CODE_PATTERN = /`[^`\r\n]+`/g;
const COMMAND_LINE_PATTERN =
  /(?:^|\s)(?:[$>#]\s+|(?:sudo\s+)?(?:bash|sh|zsh|fish|pwsh|powershell|cmd|cat|cd|chmod|chown|cp|curl|env|git|ls|mv|npm|pnpm|printenv|python|rm|ssh|tar|wget)(?:\.exe)?(?:\s+|$))[^\r\n]*/gim;
const SHELL_SYNTAX_PATTERN = /(?:\$\(|\$\{|&&|\|\||(?:^|\s)[|<>]{1,2}(?:\s|$))/m;
const ERROR_OR_TRACE_PATTERN = /(?:^|\s)(?:traceback|stack trace|stderr:|stdout:|error:)\s/i;

const isRemoteRequestId = Schema.is(RemoteInteractionRequestId);
const isRemoteThreadId = Schema.is(RemoteInteractionThreadId);

function boundedText(value: unknown, fallback: string, maxChars: number): string {
  if (typeof value !== "string") {
    return fallback;
  }
  if (
    value.includes("\n") ||
    value.includes("\r") ||
    SHELL_SYNTAX_PATTERN.test(value) ||
    ERROR_OR_TRACE_PATTERN.test(value)
  ) {
    return fallback;
  }
  const sanitized = value
    .replace(CONTROL_OR_ANSI_PATTERN, "")
    .replace(PEM_BLOCK_PATTERN, "[redacted]")
    .replace(BEARER_CREDENTIAL_PATTERN, "[redacted]")
    .replace(CREDENTIAL_PATTERN, "[redacted]")
    .replace(ENV_ASSIGNMENT_PATTERN, "[redacted]")
    .replace(PATH_PATTERN, "[redacted]")
    .replace(URL_PATTERN, "[redacted]")
    .replace(LONG_OPAQUE_PATTERN, "[redacted]")
    .replace(INLINE_CODE_PATTERN, "[redacted]")
    .replace(COMMAND_LINE_PATTERN, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
  return sanitized.length > 0 ? sanitized : fallback;
}

export function sanitizeRemoteInteractionText(value: unknown, fallback: string): string {
  return boundedText(value, fallback, 512);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function safeApprovalSummary(payload: Record<string, unknown>): {
  readonly summary: string;
  readonly canApprove: boolean;
} {
  // Provider payloads are untrusted and cannot assert an allowlist key. Until a
  // server-authored semantic normalizer exists, every provider approval is
  // intentionally reject/cancel-only.
  switch (payload.requestKind) {
    case "command":
      return { summary: "Command approval requested", canApprove: false };
    case "file-read":
      return { summary: "File-read approval requested", canApprove: false };
    case "file-change":
      return { summary: "File-change approval requested", canApprove: false };
    default:
      return { summary: "Approval requested", canApprove: false };
  }
}

function sanitizeQuestions(value: unknown): ReadonlyArray<PendingInteractionQuestion> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > REMOTE_INTERACTION_QUESTION_MAX_COUNT
  ) {
    return [];
  }
  const questions: PendingInteractionQuestion[] = [];
  const usedQuestionIds = new Set<string>();
  for (const [questionIndex, candidate] of value
    .slice(0, REMOTE_INTERACTION_QUESTION_MAX_COUNT)
    .entries()) {
    const question = readRecord(candidate);
    if (!question || typeof question.id !== "string" || question.id.length === 0) {
      return [];
    }
    const providerQuestionId = question.id;
    const baseQuestionId = isRemoteRequestId(providerQuestionId)
      ? providerQuestionId
      : `question-${questionIndex + 1}`;
    let questionId = baseQuestionId;
    let questionSuffix = 2;
    while (usedQuestionIds.has(questionId)) {
      questionId = `${baseQuestionId.slice(0, 120)}-${questionSuffix}`;
      questionSuffix += 1;
    }
    usedQuestionIds.add(questionId);
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    if (
      rawOptions.length > REMOTE_INTERACTION_OPTION_MAX_COUNT ||
      rawOptions.some((candidate) => {
        const option = readRecord(candidate);
        return !option || typeof option.label !== "string" || option.label.length === 0;
      })
    ) {
      return [];
    }
    const usedLabels = new Set<string>();
    const options = rawOptions
      .slice(0, REMOTE_INTERACTION_OPTION_MAX_COUNT)
      .flatMap((candidate, index) => {
        const option = readRecord(candidate);
        if (!option) {
          return [];
        }
        const providerValue =
          typeof option.label === "string" && option.label.length > 0 ? option.label : "Option";
        const sanitizedLabel = boundedText(providerValue, "Option", 160);
        const baseLabel = sanitizedLabel === providerValue ? sanitizedLabel : `Option ${index + 1}`;
        let label = baseLabel;
        let suffix = 2;
        while (usedLabels.has(label)) {
          label = `${baseLabel.slice(0, 150)} (${suffix})`;
          suffix += 1;
        }
        usedLabels.add(label);
        return [
          {
            label,
            description: boundedText(option.description, "Available choice", 160),
            providerValue,
          },
        ];
      });
    questions.push({
      id: questionId,
      providerQuestionId,
      header: boundedText(question.header, "Input needed", 64),
      prompt: boundedText(question.question, "The agent needs input.", 512),
      options,
      multiSelect: question.multiSelect === true,
      allowsCustomAnswer: true,
    });
  }
  return questions;
}

export function pendingInteractionFromActivity(input: {
  readonly threadId: ThreadId;
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}): PendingInteractionRow | null {
  const payload = readRecord(input.payload);
  if (!isRemoteThreadId(input.threadId) || !payload || !isRemoteRequestId(payload.requestId)) {
    return null;
  }
  const requestId = ApprovalRequestId.make(payload.requestId);

  if (input.kind === "approval.requested") {
    const approval = safeApprovalSummary(payload);
    return {
      threadId: input.threadId,
      requestId,
      kind: "approval",
      status: "pending",
      summary: approval.summary,
      canApprove: approval.canApprove,
      questions: [],
      responseAction: null,
      responseCommandId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      resolvedAt: null,
    };
  }

  if (input.kind === "user-input.requested") {
    const questions = sanitizeQuestions(payload.questions);
    if (questions.length === 0) {
      return null;
    }
    return {
      threadId: input.threadId,
      requestId,
      kind: "user-input",
      status: "pending",
      summary: "User input requested",
      canApprove: false,
      questions: [...questions],
      responseAction: null,
      responseCommandId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      resolvedAt: null,
    };
  }

  return null;
}
