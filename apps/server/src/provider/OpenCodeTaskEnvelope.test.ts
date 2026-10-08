import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { parseOpenCodeTaskEnvelope, unwrapOpenCodeTaskEnvelope } from "./OpenCodeTaskEnvelope.ts";

const resultBody = [
  "Result text with embedded XML:",
  '<report><item status="ok">Keep this markup.</item></report>',
  "and code:",
  "```xml",
  "<task_result>literal code, not a second envelope</task_result>",
  "```",
].join("\n");

const errorBody = [
  "The child failed while reading this file:",
  "<error detail='preserve'>do not recursively parse this</error>",
].join("\n");

const opaqueBody = ["```text", "literal protocol markers: <task_result> and <task>", "```"].join(
  "\n",
);

const adjacentResultBody = [
  "```xml",
  "<task_result>one</task_result><task_result>two</task_result>",
  "```",
].join("\n");

const adjacentErrorBody = [
  "```xml",
  "<task_error>one</task_error><task_error>two</task_error>",
  "```",
].join("\n");

const fixtures = {
  result: {
    text: `<task id="ses_result" state="completed">\n<task_result>${resultBody}</task_result>\n</task>`,
    parsed: {
      sessionId: "ses_result",
      state: "completed",
      result: resultBody,
    },
  },
  error: {
    text: `<task\n  state='failed'\n  id='ses_error'\n  origin="subagent">\n  <summary>Background task failed</summary>\n  <task_error>${errorBody}</task_error>\n</task>`,
    parsed: {
      sessionId: "ses_error",
      state: "failed",
      error: errorBody,
    },
  },
  noSummary: {
    text: '<task id="ses_no_summary" state="running"><task_result>working</task_result></task>',
    parsed: {
      sessionId: "ses_no_summary",
      state: "running",
      result: "working",
    },
  },
  extraAttributes: {
    text: `<task id='ses_extra_attrs' state='completed' mode="background" data-source='task'>\n<task_result>accepted attributes are ignored</task_result>\n</task>`,
    parsed: {
      sessionId: "ses_extra_attrs",
      state: "completed",
      result: "accepted attributes are ignored",
    },
  },
  opaqueBody: {
    text: `<task id="ses_opaque" state="completed"><task_result>${opaqueBody}</task_result></task>`,
    parsed: {
      sessionId: "ses_opaque",
      state: "completed",
      result: opaqueBody,
    },
  },
  adjacentResultBody: {
    text: `<task id="ses_adjacent_result" state="completed"><task_result>${adjacentResultBody}</task_result></task>`,
    parsed: {
      sessionId: "ses_adjacent_result",
      state: "completed",
      result: adjacentResultBody,
    },
  },
  adjacentErrorBody: {
    text: `<task id="ses_adjacent_error" state="failed"><task_error>${adjacentErrorBody}</task_error></task>`,
    parsed: {
      sessionId: "ses_adjacent_error",
      state: "failed",
      error: adjacentErrorBody,
    },
  },
} as const;

describe("parseOpenCodeTaskEnvelope", () => {
  it("parses a genuine result envelope and preserves embedded content", () => {
    NodeAssert.deepStrictEqual(
      parseOpenCodeTaskEnvelope(fixtures.result.text),
      fixtures.result.parsed,
    );
  });

  it("parses a genuine error envelope with a summary and multiline attributes", () => {
    NodeAssert.deepStrictEqual(
      parseOpenCodeTaskEnvelope(fixtures.error.text),
      fixtures.error.parsed,
    );
  });

  it("parses a genuine envelope without a summary", () => {
    NodeAssert.deepStrictEqual(
      parseOpenCodeTaskEnvelope(fixtures.noSummary.text),
      fixtures.noSummary.parsed,
    );
  });

  it("ignores supported protocol extensions on the task wrapper", () => {
    NodeAssert.deepStrictEqual(
      parseOpenCodeTaskEnvelope(fixtures.extraAttributes.text),
      fixtures.extraAttributes.parsed,
    );
  });

  it("treats result text as opaque even when code contains unmatched protocol tags", () => {
    NodeAssert.deepStrictEqual(
      parseOpenCodeTaskEnvelope(fixtures.opaqueBody.text),
      fixtures.opaqueBody.parsed,
    );
  });

  it("treats adjacent protocol tags in result and error code as opaque", () => {
    NodeAssert.deepStrictEqual(
      parseOpenCodeTaskEnvelope(fixtures.adjacentResultBody.text),
      fixtures.adjacentResultBody.parsed,
    );
    NodeAssert.deepStrictEqual(
      parseOpenCodeTaskEnvelope(fixtures.adjacentErrorBody.text),
      fixtures.adjacentErrorBody.parsed,
    );
  });

  it("accepts every recognized provider task state", () => {
    for (const state of [
      "pending",
      "running",
      "completed",
      "failed",
      "stopped",
      "cancelled",
      "canceled",
      "interrupted",
      "error",
    ]) {
      NodeAssert.deepStrictEqual(
        parseOpenCodeTaskEnvelope(
          `<task id="ses_state_${state}" state="${state}"><task_result>x</task_result></task>`,
        ),
        { sessionId: `ses_state_${state}`, state, result: "x" },
      );
    }
  });

  it("rejects malformed, mismatched, duplicate, and non-content task bodies", () => {
    const malformed = [
      '<task id="ses_mismatch" state="completed"><task_result>bad</task_error></task>',
      '<task id="ses_unclosed" state="completed"><task_result>bad</task_result>',
      '<task id="ses_both" state="failed"><task_result>one</task_result><task_error>two</task_error></task>',
      '<task id="ses_text" state="completed">not a result body</task>',
      '<task id="ses_summary_twice" state="completed"><summary>one</summary><summary>two</summary><task_result>x</task_result></task>',
      '<task id="ses_inner_text" state="completed">prose<task_result>x</task_result></task>',
      '<task id="ses_bad_attr" state="completed" mode=background><task_result>x</task_result></task>',
    ];

    for (const text of malformed) {
      NodeAssert.equal(parseOpenCodeTaskEnvelope(text), undefined);
    }
  });

  it("requires a nonempty id and a recognized state attribute", () => {
    const missingRequiredAttribute = [
      '<task state="completed"><task_result>x</task_result></task>',
      '<task id="ses_missing_state"><task_result>x</task_result></task>',
      '<task id="   " state="completed"><task_result>x</task_result></task>',
      '<task id="ses_missing_state" state="   "><task_result>x</task_result></task>',
      '<task id="ses_unquoted" state=completed><task_result>x</task_result></task>',
      '<task id="ses_unknown_state" state="unknown"><task_result>x</task_result></task>',
    ];

    for (const text of missingRequiredAttribute) {
      NodeAssert.equal(parseOpenCodeTaskEnvelope(text), undefined);
    }
  });
});

describe("unwrapOpenCodeTaskEnvelope", () => {
  it("returns the result or error body without the protocol envelope", () => {
    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(fixtures.result.text), resultBody);
    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(fixtures.error.text), errorBody);
    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(fixtures.noSummary.text), "working");
    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(fixtures.opaqueBody.text), opaqueBody);
    NodeAssert.equal(
      unwrapOpenCodeTaskEnvelope(fixtures.adjacentResultBody.text),
      adjacentResultBody,
    );
    NodeAssert.equal(
      unwrapOpenCodeTaskEnvelope(fixtures.adjacentErrorBody.text),
      adjacentErrorBody,
    );
  });

  it("leaves bare result and error tags unchanged", () => {
    const bareResult = "<task_result>bare result</task_result>";
    const bareError = "<task_error>bare error</task_error>";

    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(bareResult), bareResult);
    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(bareError), bareError);
  });

  it("leaves prefix and suffix prose unchanged", () => {
    const text = `See ${fixtures.result.text} for details.`;
    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(text), text);
  });

  it("leaves fenced envelopes unchanged", () => {
    const text = `\n\`\`\`xml\n${fixtures.result.text}\n\`\`\`\n`;
    NodeAssert.equal(unwrapOpenCodeTaskEnvelope(text), text);
  });

  it("leaves malformed and ordinary task-looking text byte-for-byte unchanged", () => {
    const texts = [
      '<task id="ses_mismatch" state="completed"><task_result>bad</task_error></task>',
      '<task id="ses_no_result" state="completed">plain wrapper text</task>',
      '<task id="ses_unknown_state" state="unknown"><task_result>x</task_result></task>',
      "plain provider text",
      "<not-a-task><task_result>still visible</task_result></not-a-task>",
      '<task id="ses_extra" state="completed"><task_result>x</task_result></task> trailing prose',
    ];

    for (const text of texts) {
      NodeAssert.equal(unwrapOpenCodeTaskEnvelope(text), text);
    }
  });
});
