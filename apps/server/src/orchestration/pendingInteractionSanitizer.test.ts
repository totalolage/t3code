import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";

import {
  pendingInteractionFromActivity,
  sanitizeRemoteInteractionText,
} from "./pendingInteractionSanitizer.ts";

it("redacts credentials, paths, URLs, terminal escapes, commands, and opaque tokens", () => {
  const unsafe = [
    "token=super-secret-value",
    "Authorization: Bearer standard-bearer-secret",
    "Bearer standalone-bearer-secret",
    "/home/alice/private.txt",
    "/workspace/project/private.txt",
    "../relative/private.txt",
    "https://example.test/private",
    "\u001b[31mcolored\u001b[0m",
    "$ rm -rf somewhere",
    "git status --short",
    "AWS_SECRET_ACCESS_KEY=secret",
    "0123456789abcdef0123456789abcdef",
  ];
  const sanitized = unsafe
    .map((value) => sanitizeRemoteInteractionText(value, "Safe fallback"))
    .join(" ");

  assert.notInclude(sanitized, "super-secret-value");
  assert.notInclude(sanitized, "standard-bearer-secret");
  assert.notInclude(sanitized, "standalone-bearer-secret");
  assert.notInclude(sanitized, "/home/alice");
  assert.notInclude(sanitized, "/workspace");
  assert.notInclude(sanitized, "../relative");
  assert.notInclude(sanitized, "example.test");
  assert.notInclude(sanitized, "rm -rf");
  assert.notInclude(sanitized, "git status");
  assert.notInclude(sanitized, "AWS_SECRET_ACCESS_KEY");
  assert.notInclude(sanitized, "0123456789abcdef");
  assert.notInclude(sanitized, "\u001b");
});

it("fails approval capability closed for provider-derived approval prose", () => {
  const interaction = pendingInteractionFromActivity({
    threadId: ThreadId.make("thread-approval"),
    kind: "approval.requested",
    payload: {
      requestId: "request-approval",
      requestKind: "command",
      command: ["sh", "-c", "cat /home/alice/.env"],
      reason: "Please approve token=secret",
    },
    createdAt: "2026-07-22T00:00:00.000Z",
  });

  assert.isNotNull(interaction);
  assert.strictEqual(interaction?.summary, "Command approval requested");
  assert.isFalse(interaction?.canApprove ?? true);
  assert.deepStrictEqual(interaction?.questions, []);
});

it("bounds and sanitizes user-input questions without retaining provider envelopes", () => {
  const interaction = pendingInteractionFromActivity({
    threadId: ThreadId.make("thread-input"),
    kind: "user-input.requested",
    payload: {
      requestId: "request-input",
      questions: [
        {
          id: "question-1",
          header: "token=header-secret",
          question: "Read /root/private and run `cat .env`?",
          options: [
            { label: "https://secret.test", description: "password=hunter2" },
            { label: "No", description: "$ printenv" },
            { label: "Later", description: "Safe" },
            { label: "Extra", description: "Dropped" },
          ],
          multiSelect: false,
        },
      ],
      rawProviderEnvelope: { credentials: "must-not-survive" },
    },
    createdAt: "2026-07-22T00:00:00.000Z",
  });

  assert.isNotNull(interaction);
  assert.strictEqual(interaction?.questions.length, 1);
  assert.strictEqual(interaction?.questions[0]?.options.length, 3);
  const serialized = JSON.stringify(interaction);
  for (const forbidden of [
    "header-secret",
    "/root/private",
    "cat .env",
    "secret.test",
    "hunter2",
    "printenv",
    "must-not-survive",
    "rawProviderEnvelope",
  ]) {
    assert.notInclude(serialized, forbidden);
  }
});
