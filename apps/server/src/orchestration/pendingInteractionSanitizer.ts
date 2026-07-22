import {
  ApprovalRequestId,
  REMOTE_INTERACTION_OPTION_MAX_COUNT,
  REMOTE_INTERACTION_QUESTION_MAX_COUNT,
  RemoteInteractionRequestId,
  RemoteInteractionThreadId,
  type RemotePendingInteractionQuestion,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { PendingInteractionRow } from "../persistence/Services/PendingInteractions.ts";

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

function sanitizeQuestions(value: unknown): ReadonlyArray<RemotePendingInteractionQuestion> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > REMOTE_INTERACTION_QUESTION_MAX_COUNT
  ) {
    return [];
  }
  const questions: RemotePendingInteractionQuestion[] = [];
  for (const candidate of value) {
    const question = readRecord(candidate);
    if (!question || !isRemoteRequestId(question.id)) {
      return [];
    }
    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions
      .slice(0, REMOTE_INTERACTION_OPTION_MAX_COUNT)
      .flatMap((candidate) => {
        const option = readRecord(candidate);
        if (!option) {
          return [];
        }
        return [
          {
            label: boundedText(option.label, "Option", 160),
            description: boundedText(option.description, "Available choice", 160),
          },
        ];
      });
    questions.push({
      id: question.id,
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
