import { RemotePendingInteraction, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  questionsFromNative,
  toRemotePendingInteraction,
} from "./PendingInteractionPresentation.ts";
import type {
  InteractionRecord,
  PendingInteractionQuestion,
} from "../persistence/Services/PendingInteractionResponses.ts";

const CREATED_AT = "2026-07-22T00:00:00.000Z";
const decodeRemotePendingInteraction = Schema.decodeUnknownSync(RemotePendingInteraction);

const nativeQuestion = (overrides: Record<string, unknown> = {}) => ({
  id: "environment",
  header: "Environment",
  question: "Which environment should be used?",
  options: [
    { label: "Local", description: "Use the local environment." },
    { label: "Remote", description: "Use the connected environment." },
  ],
  multiSelect: false,
  ...overrides,
});

const defaultQuestion: PendingInteractionQuestion = {
  id: "environment",
  providerQuestionId: "environment",
  header: "Environment",
  prompt: "Which environment should be used?",
  options: [
    { label: "Local", description: "Use the local environment.", providerValue: "Local" },
    { label: "Remote", description: "Use the connected environment.", providerValue: "Remote" },
  ],
  multiSelect: false,
  allowsCustomAnswer: false,
};

const makeInteraction = (overrides: Partial<InteractionRecord> = {}): InteractionRecord => ({
  threadId: ThreadId.make("thread-presentation"),
  requestId: RuntimeRequestId.make("request-presentation"),
  kind: "user-input",
  status: "pending",
  summary: "User input requested",
  canApprove: false,
  questions: [defaultQuestion],
  responseAction: null,
  responseCommandId: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  resolvedAt: null,
  ...overrides,
});

const remoteForUnsafeText = (unsafe: string): string => {
  const questions = questionsFromNative([
    nativeQuestion({
      header: unsafe,
      question: unsafe,
      options: [{ label: unsafe, description: unsafe }],
      allowCustomAnswer: true,
    }),
  ]);
  assert.isNotNull(questions);
  return JSON.stringify(toRemotePendingInteraction(makeInteraction({ questions: questions! })));
};

it("keeps benign native questions usable and validates the public DTO", () => {
  const questions = questionsFromNative([
    nativeQuestion({
      id: "environment",
      allowCustomAnswer: true,
    }),
  ]);

  assert.isNotNull(questions);
  assert.deepStrictEqual(questions?.[0], {
    id: "environment",
    providerQuestionId: "environment",
    header: "Environment",
    prompt: "Which environment should be used?",
    options: [
      {
        label: "Local",
        description: "Use the local environment.",
        providerValue: "Local",
      },
      {
        label: "Remote",
        description: "Use the connected environment.",
        providerValue: "Remote",
      },
    ],
    multiSelect: false,
    allowsCustomAnswer: true,
  });

  const remote = toRemotePendingInteraction(makeInteraction({ questions: questions ?? [] }));
  assert.deepStrictEqual(remote.questions, [
    {
      id: "environment",
      header: "Environment",
      prompt: "Which environment should be used?",
      options: [
        { label: "Local", description: "Use the local environment." },
        { label: "Remote", description: "Use the connected environment." },
      ],
      multiSelect: false,
      allowsCustomAnswer: true,
    },
  ]);
  assert.deepStrictEqual(decodeRemotePendingInteraction(remote), remote);
});

it("redacts credentials at the remote presentation boundary", () => {
  const serialized = remoteForUnsafeText("Authorization: Bearer standard-bearer-secret");

  assert.notInclude(serialized, "standard-bearer-secret");
  assert.notInclude(serialized, "Authorization");
  assert.notInclude(serialized, "Bearer");
  assert.notInclude(remoteForUnsafeText("password=hunter2"), "hunter2");
});

it("redacts environment assignments at the remote presentation boundary", () => {
  const serialized = remoteForUnsafeText("AWS_SECRET_ACCESS_KEY=secret-value");

  assert.notInclude(serialized, "AWS_SECRET_ACCESS_KEY");
  assert.notInclude(serialized, "secret-value");
});

it("redacts URLs at the remote presentation boundary", () => {
  const serialized = remoteForUnsafeText("https://secret.example/private?token=secret");

  assert.notInclude(serialized, "secret.example");
  assert.notInclude(serialized, "token=secret");
});

it("redacts absolute and relative paths at the remote presentation boundary", () => {
  const serialized = remoteForUnsafeText("/home/alice/private.txt");

  assert.notInclude(serialized, "/home/alice");
  assert.notInclude(remoteForUnsafeText("../relative/private.env"), "../relative");
  assert.notInclude(remoteForUnsafeText("C:\\Users\\Alice\\private.env"), "Alice");
});

it("redacts opaque secrets at the remote presentation boundary", () => {
  const opaque = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const serialized = remoteForUnsafeText(opaque);

  assert.notInclude(serialized, opaque);
});

it("redacts commands and inline code at the remote presentation boundary", () => {
  const command = remoteForUnsafeText("git status --short");
  const inlineCode = remoteForUnsafeText("Read `cat .env` before continuing.");

  assert.notInclude(command, "git status");
  assert.notInclude(inlineCode, "cat .env");
  assert.notInclude(inlineCode, "`Read");
});

it("redacts PEM blocks, control bytes, multiline text, and traces", () => {
  const pem = "-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----";
  const pemSerialized = remoteForUnsafeText(pem);
  const controlSerialized = remoteForUnsafeText("\u001b[31mprivate\u001b[0m");
  const multilineSerialized = remoteForUnsafeText("first line\npassword=hunter2");
  const traceSerialized = remoteForUnsafeText("Traceback (most recent call last): secret");

  assert.notInclude(pemSerialized, "PRIVATE KEY");
  assert.notInclude(pemSerialized, "secret");
  assert.notInclude(controlSerialized, "\u001b");
  assert.notInclude(multilineSerialized, "hunter2");
  assert.notInclude(traceSerialized, "Traceback");
  assert.notInclude(traceSerialized, "secret");
});

it("keeps distinct provider IDs and values reversible while making public IDs and labels safe", () => {
  const unsafeLabel = "https://secret.example/choice";
  const questions = questionsFromNative([
    nativeQuestion({
      id: "question-2",
      options: [
        { label: unsafeLabel, description: "Choose this option." },
        { label: "Option 1", description: "A benign duplicate target." },
      ],
    }),
    nativeQuestion({
      id: "unsafe question\n",
      question: "A second question.",
      options: [{ label: "Continue", description: "Continue." }],
    }),
    nativeQuestion({
      id: "another-safe-id",
      question: "A third question.",
      options: [{ label: "Later", description: "Wait." }],
    }),
  ]);

  assert.isNotNull(questions);
  assert.deepStrictEqual(
    questions?.map((question) => question.id),
    ["question-2", "question-2-2", "another-safe-id"],
  );
  assert.deepStrictEqual(
    questions?.map((question) => question.providerQuestionId),
    ["question-2", "unsafe question\n", "another-safe-id"],
  );
  assert.deepStrictEqual(
    questions?.[0]?.options.map(({ label, providerValue }) => ({ label, providerValue })),
    [
      { label: "Option 1", providerValue: unsafeLabel },
      { label: "Option 1 (2)", providerValue: "Option 1" },
    ],
  );

  const remote = toRemotePendingInteraction(makeInteraction({ questions: questions ?? [] }));
  assert.deepStrictEqual(
    remote.questions.map((question) => ({
      id: question.id,
      options: question.options.map(({ label }) => label),
    })),
    questions?.map((question) => ({
      id: question.id,
      options: question.options.map(({ label }) => label),
    })),
  );
  const serialized = JSON.stringify(remote);
  assert.notInclude(serialized, "providerQuestionId");
  assert.notInclude(serialized, "providerValue");
  assert.notInclude(serialized, unsafeLabel);
});

it("omits the whole request when raw provider question IDs duplicate", () => {
  assert.isNull(
    questionsFromNative([
      nativeQuestion({ id: "duplicate-question" }),
      nativeQuestion({ id: "duplicate-question", question: "A second question." }),
    ]),
  );
});

it("keeps credential-shaped and opaque question IDs private", () => {
  const opaque = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const questions = questionsFromNative([
    nativeQuestion({ id: "password:hunter2" }),
    nativeQuestion({ id: opaque, question: "A second question." }),
  ]);
  assert.isNotNull(questions);
  assert.deepStrictEqual(
    questions?.map((question) => question.id),
    ["question-1", "question-2"],
  );
  assert.deepStrictEqual(
    questions?.map((question) => question.providerQuestionId),
    ["password:hunter2", opaque],
  );
  const serialized = JSON.stringify(
    toRemotePendingInteraction(makeInteraction({ questions: questions ?? [] })),
  );
  assert.notInclude(serialized, "hunter2");
  assert.notInclude(serialized, opaque);
  assert.notInclude(serialized, "providerQuestionId");
});

it("redacts quoted credentials while preserving private option mappings", () => {
  const unsafeLabel = '{"password":"hunter2"}';
  const questions = questionsFromNative([
    nativeQuestion({
      header: "'password': hunter2",
      question: 'password: "hunter 2 with spaces"',
      options: [
        { label: unsafeLabel, description: "token: 'a b c'" },
        { label: "Safe", description: "Keep." },
      ],
    }),
  ]);
  assert.isNotNull(questions);
  assert.notInclude(questions?.[0]?.header ?? "", "hunter2");
  assert.notInclude(questions?.[0]?.header ?? "", "password");
  assert.strictEqual(questions?.[0]?.prompt, "[redacted]");
  assert.strictEqual(questions?.[0]?.options[0]?.label, "Option 1");
  assert.strictEqual(questions?.[0]?.options[0]?.description, "[redacted]");
  assert.strictEqual(questions?.[0]?.options[0]?.providerValue, unsafeLabel);
  assert.strictEqual(questions?.[0]?.options[1]?.label, "Safe");
  assert.strictEqual(questions?.[0]?.options[1]?.providerValue, "Safe");
  const serialized = JSON.stringify(
    toRemotePendingInteraction(makeInteraction({ questions: questions ?? [] })),
  );
  assert.notInclude(serialized, "hunter2");
  assert.notInclude(serialized, "a b c");
  assert.notInclude(serialized, "providerValue");
});

it("redacts credential values containing escaped quotes without losing private mappings", () => {
  for (const credential of [
    String.raw`{"password":"prefix\"secret-tail"}`,
    String.raw`'password': 'prefix\'secret-tail'`,
  ]) {
    const questions = questionsFromNative([
      nativeQuestion({
        header: credential,
        question: credential,
        options: [{ label: credential, description: credential }],
      }),
    ]);
    assert.isNotNull(questions);
    assert.strictEqual(questions?.[0]?.options[0]?.providerValue, credential);
    assert.strictEqual(questions?.[0]?.options[0]?.label, "Option 1");
    const serialized = JSON.stringify(
      toRemotePendingInteraction(makeInteraction({ questions: questions ?? [] })),
    );
    assert.notInclude(serialized, "prefix");
    assert.notInclude(serialized, "secret-tail");
  }
});

it("uses native option values when present for reversible provider answers", () => {
  const questions = questionsFromNative([
    nativeQuestion({
      options: [
        { label: "Allow", description: "Allow once.", value: "native:allow" },
        { label: "Allow", description: "Allow again.", value: "native:allow-again" },
      ],
    }),
  ]);

  assert.isNotNull(questions);
  assert.deepStrictEqual(questions?.[0]?.options, [
    {
      label: "Allow",
      description: "Allow once.",
      providerValue: "native:allow",
    },
    {
      label: "Allow (2)",
      description: "Allow again.",
      providerValue: "native:allow-again",
    },
  ]);
});

it("maps omitted, true, and false native custom-answer flags per policy with and without options", () => {
  const CASES = [
    { flag: "omitted", allowCustomAnswer: undefined },
    { flag: "true", allowCustomAnswer: true },
    { flag: "false", allowCustomAnswer: false },
  ] as const;

  for (const { flag, allowCustomAnswer } of CASES) {
    const overrides = allowCustomAnswer === undefined ? {} : { allowCustomAnswer };
    const withOptions = questionsFromNative([
      nativeQuestion({
        id: `with-options-${flag}`,
        multiSelect: true,
        ...overrides,
      }),
    ]);
    const zeroOptions = questionsFromNative([
      nativeQuestion({
        id: `zero-options-${flag}`,
        options: [],
        multiSelect: true,
        ...overrides,
      }),
    ]);

    const expectedAllows = allowCustomAnswer !== false;
    if (allowCustomAnswer === false) {
      // explicit false + zero options is invalid and nonactionable
      assert.isNull(zeroOptions);
    } else {
      // omitted or true + zero options is a valid freeform question
      assert.isNotNull(zeroOptions);
      assert.deepStrictEqual(zeroOptions?.[0]?.options, []);
      assert.strictEqual(zeroOptions?.[0]?.id, `zero-options-${flag}`);
      assert.strictEqual(zeroOptions?.[0]?.providerQuestionId, `zero-options-${flag}`);
      assert.isTrue(zeroOptions?.[0]?.allowsCustomAnswer);
      assert.isTrue(zeroOptions?.[0]?.multiSelect);
      const zeroRemote = toRemotePendingInteraction(
        makeInteraction({ questions: zeroOptions ?? [] }),
      );
      assert.deepStrictEqual(zeroRemote.questions, [
        {
          id: `zero-options-${flag}`,
          header: "Environment",
          prompt: "Which environment should be used?",
          options: [],
          multiSelect: true,
          allowsCustomAnswer: true,
        },
      ]);
    }

    assert.isNotNull(withOptions);
    assert.deepStrictEqual(withOptions?.[0]?.options, [
      {
        label: "Local",
        description: "Use the local environment.",
        providerValue: "Local",
      },
      {
        label: "Remote",
        description: "Use the connected environment.",
        providerValue: "Remote",
      },
    ]);
    assert.strictEqual(withOptions?.[0]?.id, `with-options-${flag}`);
    assert.strictEqual(withOptions?.[0]?.providerQuestionId, `with-options-${flag}`);
    assert.strictEqual(withOptions?.[0]?.allowsCustomAnswer, expectedAllows);
    const withRemote = toRemotePendingInteraction(
      makeInteraction({ questions: withOptions ?? [] }),
    );
    assert.deepStrictEqual(
      withRemote.questions.map((question) => ({
        id: question.id,
        options: question.options.map(({ label }) => label),
        allowsCustomAnswer: question.allowsCustomAnswer,
        multiSelect: question.multiSelect,
      })),
      [
        {
          id: `with-options-${flag}`,
          options: ["Local", "Remote"],
          allowsCustomAnswer: expectedAllows,
          multiSelect: true,
        },
      ],
    );
  }

  // An explicit false keeps selectable choices usable while the service
  // rejects freeform values against these choices.
  const falseWithOptions = questionsFromNative([
    nativeQuestion({ id: "false-choices", allowCustomAnswer: false }),
  ]);
  assert.isNotNull(falseWithOptions);
  assert.strictEqual(falseWithOptions?.[0]?.allowsCustomAnswer, false);
  assert.strictEqual(
    toRemotePendingInteraction(makeInteraction({ questions: falseWithOptions ?? [] })).questions[0]
      ?.allowsCustomAnswer,
    false,
  );
});

it("rejects malformed, empty, and over-limit native question sets", () => {
  assert.isNull(questionsFromNative(undefined));
  assert.isNull(questionsFromNative(null));
  assert.isNull(questionsFromNative([]));
  assert.isNull(
    questionsFromNative(
      Array.from({ length: 4 }, (_, index) => nativeQuestion({ id: `q-${index}` })),
    ),
  );
  assert.isNull(
    questionsFromNative([
      nativeQuestion({
        options: Array.from({ length: 4 }, (_, index) => ({
          label: `Choice ${index}`,
          description: "Choice",
        })),
      }),
    ]),
  );
  assert.isNull(questionsFromNative([nativeQuestion({ id: "" })]));
  assert.isNull(questionsFromNative([nativeQuestion({ options: [{ label: "Only label" }] })]));
  assert.isNull(questionsFromNative([nativeQuestion({ options: [], allowCustomAnswer: false })]));
});

it("drops unknown nested native metadata while retaining usable fields", () => {
  const secret = "nested-secret-value";
  const questions = questionsFromNative([
    {
      ...nativeQuestion({
        options: [
          {
            label: "Continue",
            description: "Continue safely.",
            providerEnvelope: { credentials: secret },
          },
        ],
      }),
      providerEnvelope: {
        credentials: secret,
        nested: { token: secret },
      },
    },
  ]);

  assert.isNotNull(questions);
  assert.strictEqual(questions?.[0]?.prompt, "Which environment should be used?");
  const serialized = JSON.stringify(
    toRemotePendingInteraction(makeInteraction({ questions: questions ?? [] })),
  );
  assert.notInclude(serialized, secret);
  assert.notInclude(serialized, "providerEnvelope");
});

it("re-sanitizes legacy records and strips provider-only fields from the DTO", () => {
  const interaction = makeInteraction({
    summary: "token=summary-secret",
    questions: [
      {
        id: "unsafe legacy id\n",
        providerQuestionId: "Which private choice should be used?",
        header: "password=header-secret",
        prompt: "Read /root/private and run `cat .env`?",
        options: [
          {
            label: "https://secret.example",
            description: "password=option-secret",
            providerValue: "/root/private",
          },
        ],
        multiSelect: false,
        allowsCustomAnswer: false,
      },
    ],
  });

  const remote = toRemotePendingInteraction(interaction);
  const serialized = JSON.stringify(remote);
  assert.strictEqual(remote.questions[0]?.id, "question-1");
  assert.strictEqual(remote.questions[0]?.options[0]?.label, "Option 1");
  assert.notInclude(serialized, "header-secret");
  assert.notInclude(serialized, "option-secret");
  assert.notInclude(serialized, "secret.example");
  assert.notInclude(serialized, "/root/private");
  assert.notInclude(serialized, "providerQuestionId");
  assert.notInclude(serialized, "providerValue");
  assert.deepStrictEqual(decodeRemotePendingInteraction(remote), remote);
});

it("fails all provider approvals closed and preserves remote lifecycle fields", () => {
  const pending = toRemotePendingInteraction(
    makeInteraction({
      kind: "approval",
      canApprove: true,
      summary: "Command approval requested",
      questions: [],
    }),
  );
  assert.strictEqual(pending.status, "pending");
  assert.isFalse(pending.canApprove);
  assert.deepStrictEqual(pending.allowedActions, ["decline", "cancel"]);
  assert.strictEqual(pending.createdAt, CREATED_AT);
  assert.strictEqual(pending.updatedAt, CREATED_AT);

  const responding = toRemotePendingInteraction(
    makeInteraction({
      kind: "approval",
      status: "responding",
      canApprove: true,
      responseAction: "approve",
      responseCommandId: null,
      questions: [],
      updatedAt: "2026-07-22T00:00:01.000Z",
    }),
  );
  assert.strictEqual(responding.status, "responding");
  assert.isFalse(responding.canApprove);
  assert.deepStrictEqual(responding.allowedActions, []);
  assert.strictEqual(responding.updatedAt, "2026-07-22T00:00:01.000Z");
});

it("does not present terminal interaction records as pending", () => {
  for (const status of ["resolved", "stale"] as const) {
    assert.throws(() => toRemotePendingInteraction(makeInteraction({ status })));
  }
});
