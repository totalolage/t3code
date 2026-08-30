import { describe, expect, it } from "vite-plus/test";

import {
  deriveToolActivityPresentation,
  resolveLegacyOpenCodeTodoWritePresentation,
  resolveLegacyOpenCodeToolDetail,
  summarizeOpenCodeToolInput,
} from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });
});

describe("resolveLegacyOpenCodeToolDetail", () => {
  it("rewrites a legacy read detail with markup to the input-derived detail", () => {
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail:
          "\n  <path>/repo/src/auth.ts</path>\n<skill_content>huge raw xml payload</skill_content>",
        data: {
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "/repo/src/auth.ts" },
            output: "<path>/repo/src/auth.ts</path>",
          },
        },
      }),
    ).toBe("/repo/src/auth.ts");
  });

  it("covers the skill_content markup family for read tools and is case-insensitive on the tool name", () => {
    const data = {
      state: {
        status: "completed",
        input: { pattern: "*.ts" },
      },
    };
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<skill_content>huge raw xml payload</skill_content>",
        data: { tool: "READ", ...data },
      }),
    ).toBe("*.ts");
  });

  it("rewrites a legacy skill detail to the skill name", () => {
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<skill_content>entire skill markdown body</skill_content>",
        data: {
          tool: "skill",
          state: {
            status: "completed",
            input: { name: "release-notes" },
          },
        },
      }),
    ).toBe("release-notes");
  });

  it("rewrites legacy task details preferring description over prompt", () => {
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<task_result>raw subagent transcript</task_result>",
        data: {
          tool: "task",
          state: {
            status: "completed",
            input: {
              description: "Review the auth flow",
              prompt: "Read every file",
              command: "Continue implementation",
            },
          },
        },
      }),
    ).toBe("Review the auth flow");
  });

  it("rewrites legacy todowrite JSON to the active task", () => {
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail:
          '[{"content":"Inspect bar header implementation","status":"in_progress","priority":"high"}]',
        data: {
          tool: "todowrite",
          state: {
            status: "completed",
            input: {
              todos: [
                { content: "Adjust hero contrast", status: "pending", priority: "high" },
                {
                  content: "Inspect bar header implementation",
                  status: "in_progress",
                  priority: "high",
                },
              ],
            },
          },
        },
      }),
    ).toBe("Inspect bar header implementation");
  });

  it("matches the task markup family for bare <task prefixes", () => {
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<task>raw subagent transcript</task>",
        data: {
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Explore the repo" },
          },
        },
      }),
    ).toBe("Explore the repo");
  });

  it("bounds derived details to 160 chars with an ellipsis like the server helper", () => {
    const prompt = `${"p".repeat(100)}\n${"q".repeat(100)}`;
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<task_result>raw subagent transcript</task_result>",
        data: { tool: "task", state: { status: "completed", input: { prompt } } },
      }),
    ).toBe(`${"p".repeat(100)} ${"q".repeat(58)}…`);
  });

  it("keeps an exactly-160-char derived detail unchanged", () => {
    const prompt = "x".repeat(160);
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<task_result>raw subagent transcript</task_result>",
        data: { tool: "task", state: { status: "completed", input: { prompt } } },
      }),
    ).toBe(prompt);
  });

  it("collapses whitespace in derived details and skips empty or non-string fields", () => {
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<task_result>raw subagent transcript</task_result>",
        data: {
          tool: "task",
          state: {
            status: "completed",
            input: { command: 42, description: null, prompt: "  hello\n  world  " },
          },
        },
      }),
    ).toBe("hello world");
  });

  it("follows the input key priority: command, filePath, path, pattern", () => {
    const detail = "<path>/repo/src/auth.ts</path>";
    const resolve = (input: Record<string, unknown>) =>
      resolveLegacyOpenCodeToolDetail({ detail, data: { tool: "read", state: { input } } });
    expect(resolve({ command: "bun test", filePath: "/a.ts" })).toBe("bun test");
    expect(resolve({ filePath: "/a.ts", path: "/b.ts" })).toBe("/a.ts");
    expect(resolve({ path: "/b.ts", pattern: "*.ts" })).toBe("/b.ts");
    expect(resolve({ pattern: "*.ts", url: "https://t3.codes" })).toBe("*.ts");
    expect(resolve({ url: "https://t3.codes", name: "t3" })).toBe("https://t3.codes");
  });

  it("returns undefined for legacy details with no useful input", () => {
    const detail = "<task_result>raw subagent transcript</task_result>";
    expect(
      resolveLegacyOpenCodeToolDetail({ detail, data: { tool: "task", state: { input: {} } } }),
    ).toBe(undefined);
    expect(resolveLegacyOpenCodeToolDetail({ detail, data: { tool: "task" } })).toBe(undefined);
    expect(
      resolveLegacyOpenCodeToolDetail({ detail, data: { tool: "task", state: { input: [] } } }),
    ).toBe(undefined);
    expect(resolveLegacyOpenCodeToolDetail({ detail: "   ", data: { tool: "task" } })).toBe(
      undefined,
    );
  });

  it("leaves unknown tools and non-markup prose unchanged", () => {
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<task_result>raw subagent transcript</task_result>",
        data: { tool: "mcp_database", state: { input: { sql: "select 1" } } },
      }),
    ).toBe("<task_result>raw subagent transcript</task_result>");
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "Exploring repository structure",
        data: { tool: "task", state: { input: {} } },
      }),
    ).toBe("Exploring repository structure");
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "  kept detail  ",
        data: { tool: "read", state: { input: { filePath: "/a.ts" } } },
      }),
    ).toBe("kept detail");
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: "<task_result>legitimate custom output</task_result>",
        data: { tool: "toString" },
      }),
    ).toBe("<task_result>legitimate custom output</task_result>");
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: '[{"content":"legitimate custom output"}]',
        data: { tool: "mcp_database" },
      }),
    ).toBe('[{"content":"legitimate custom output"}]');
    expect(
      resolveLegacyOpenCodeToolDetail({
        detail: '[{"content":"unrecognized todowrite output"}]',
        data: { tool: "todowrite", state: { input: {} } },
      }),
    ).toBe('[{"content":"unrecognized todowrite output"}]');
  });
});

describe("summarizeOpenCodeToolInput", () => {
  it("falls back to the first pending todo when none is in progress", () => {
    expect(
      summarizeOpenCodeToolInput("todowrite", {
        todos: [
          { content: "Write the migration", status: "completed" },
          { content: "Run the test suite", status: "pending" },
        ],
      }),
    ).toBe("Run the test suite");
  });

  it("falls back to the most recent completed todo when all are complete", () => {
    expect(
      summarizeOpenCodeToolInput("todowrite", {
        todos: [
          { content: "Write the migration", status: "completed" },
          { content: "Run the test suite", status: "completed" },
        ],
      }),
    ).toBe("Run the test suite");
  });

  it("bounds long todo details to 160 chars with an ellipsis", () => {
    const content = "z".repeat(200);
    expect(
      summarizeOpenCodeToolInput("todowrite", {
        todos: [{ content, status: "in_progress" }],
      }),
    ).toBe(`${"z".repeat(159)}…`);
  });

  it("falls back to a task command only after description and prompt", () => {
    expect(
      summarizeOpenCodeToolInput("task", {
        description: "Review the auth flow",
        prompt: "Read every file",
        command: "Continue implementation",
      }),
    ).toBe("Review the auth flow");
    expect(
      summarizeOpenCodeToolInput("task", {
        prompt: "Read every file",
        command: "Continue implementation",
      }),
    ).toBe("Read every file");
    expect(summarizeOpenCodeToolInput("task", { command: "Continue implementation" })).toBe(
      "Continue implementation",
    );
  });
});

describe("resolveLegacyOpenCodeTodoWritePresentation", () => {
  it("matches the exact legacy persisted todowrite shape", () => {
    expect(
      resolveLegacyOpenCodeTodoWritePresentation({
        summary: "todowrite",
        itemType: "file_change",
        data: {
          tool: "todowrite",
          state: {
            status: "completed",
            input: { todos: [{ content: "Inspect bar header", status: "in_progress" }] },
          },
        },
      }),
    ).toEqual({ title: "Update task list", itemType: "dynamic_tool_call" });
  });

  it("leaves current-server rows, other classifications, and unrelated tools untouched", () => {
    const todos = { todos: [{ content: "Inspect bar header", status: "pending" }] };
    expect(
      resolveLegacyOpenCodeTodoWritePresentation({
        summary: "Update task list",
        itemType: "dynamic_tool_call",
        data: { tool: "todowrite", state: { input: todos } },
      }),
    ).toBeUndefined();
    expect(
      resolveLegacyOpenCodeTodoWritePresentation({
        summary: "todowrite",
        itemType: "dynamic_tool_call",
        data: { tool: "todowrite", state: { input: todos } },
      }),
    ).toBeUndefined();
    expect(
      resolveLegacyOpenCodeTodoWritePresentation({
        summary: "todowrite",
        itemType: "file_change",
        data: { tool: "write", state: { input: todos } },
      }),
    ).toBeUndefined();
    expect(
      resolveLegacyOpenCodeTodoWritePresentation({
        summary: "todowrite",
        itemType: "file_change",
        data: { tool: "todowrite", state: { input: {} } },
      }),
    ).toBeUndefined();
  });
});
