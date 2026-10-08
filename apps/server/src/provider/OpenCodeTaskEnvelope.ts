type OpenCodeTaskEnvelope = {
  readonly sessionId: string;
  readonly state: string;
  readonly result?: string;
  readonly error?: string;
};

type OpenCodeOpeningTag = {
  readonly name: string;
  readonly end: number;
};

const OPENCODE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*/;
const OPENCODE_TASK_STATES = new Set([
  "pending",
  "running",
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "canceled",
  "interrupted",
  "error",
]);

function skipWhitespace(text: string, start: number, end = text.length): number {
  let index = start;
  while (index < end && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function findTagEnd(text: string, start: number): number | undefined {
  let quote: "'" | '"' | undefined;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return undefined;
}

function parseQuotedAttributes(text: string): Map<string, string> | undefined {
  const attributes = new Map<string, string>();
  let index = 0;

  while (true) {
    index = skipWhitespace(text, index);
    if (index === text.length) {
      return attributes;
    }

    const nameMatch = OPENCODE_NAME_PATTERN.exec(text.slice(index));
    if (!nameMatch) {
      return undefined;
    }
    const name = nameMatch[0];
    index += name.length;
    index = skipWhitespace(text, index);
    if (text[index] !== "=") {
      return undefined;
    }
    index = skipWhitespace(text, index + 1);
    const quote = text[index];
    if (quote !== "'" && quote !== '"') {
      return undefined;
    }

    const valueStart = index + 1;
    const valueEnd = text.indexOf(quote, valueStart);
    if (valueEnd < 0 || attributes.has(name)) {
      return undefined;
    }
    attributes.set(name, text.slice(valueStart, valueEnd));
    index = valueEnd + 1;
    if (index < text.length && !/\s/.test(text[index] ?? "")) {
      return undefined;
    }
  }
}

function readOpeningTag(text: string, start: number): OpenCodeOpeningTag | undefined {
  if (text[start] !== "<" || text[start + 1] === "/") {
    return undefined;
  }

  const nameMatch = OPENCODE_NAME_PATTERN.exec(text.slice(start + 1));
  if (!nameMatch) {
    return undefined;
  }
  const name = nameMatch[0];
  const nameEnd = start + 1 + name.length;
  const tagEnd = findTagEnd(text, nameEnd);
  if (tagEnd === undefined || !parseQuotedAttributes(text.slice(nameEnd, tagEnd))) {
    return undefined;
  }

  return { name, end: tagEnd + 1 };
}

function isTag(tag: OpenCodeOpeningTag, name: string): boolean {
  return tag.name.toLowerCase() === name;
}

function findClosingTagAtTail(
  text: string,
  name: "task" | "task_result" | "task_error",
): number | undefined {
  return new RegExp(`</${name}\\s*>\\s*$`, "i").exec(text)?.index;
}

function parseEnvelope(text: string): OpenCodeTaskEnvelope | undefined {
  const openingStart = skipWhitespace(text, 0);
  const taskTag = readOpeningTag(text, openingStart);
  if (!taskTag || !isTag(taskTag, "task")) {
    return undefined;
  }

  const taskAttributesStart = openingStart + 1 + taskTag.name.length;
  const taskAttributesEnd = taskTag.end - 1;
  const taskAttributes = parseQuotedAttributes(text.slice(taskAttributesStart, taskAttributesEnd));
  const sessionId = taskAttributes?.get("id")?.trim();
  const state = taskAttributes?.get("state")?.trim();
  if (!sessionId || !state || !OPENCODE_TASK_STATES.has(state.toLowerCase())) {
    return undefined;
  }

  const closingOffset = findClosingTagAtTail(text.slice(taskTag.end), "task");
  if (closingOffset === undefined) {
    return undefined;
  }
  const closingStart = taskTag.end + closingOffset;
  const content = text.slice(taskTag.end, closingStart);

  let contentStart = skipWhitespace(content, 0);
  const summaryTag = readOpeningTag(content, contentStart);
  if (summaryTag && isTag(summaryTag, "summary")) {
    const summaryClosingMatch = /<\/summary\s*>/i.exec(content.slice(summaryTag.end));
    if (!summaryClosingMatch) {
      return undefined;
    }
    contentStart = skipWhitespace(
      content,
      summaryTag.end + summaryClosingMatch.index + summaryClosingMatch[0].length,
    );
  }

  const resultTag = readOpeningTag(content, contentStart);
  if (!resultTag || (!isTag(resultTag, "task_result") && !isTag(resultTag, "task_error"))) {
    return undefined;
  }

  const resultName = resultTag.name.toLowerCase() as "task_result" | "task_error";
  const resultClosingOffset = findClosingTagAtTail(content.slice(resultTag.end), resultName);
  if (resultClosingOffset === undefined) {
    return undefined;
  }

  const body = content.slice(resultTag.end, resultTag.end + resultClosingOffset).trim();
  return resultName === "task_result"
    ? { sessionId, state, result: body }
    : { sessionId, state, error: body };
}

export function parseOpenCodeTaskEnvelope(text: string): OpenCodeTaskEnvelope | undefined {
  return parseEnvelope(text);
}

export function unwrapOpenCodeTaskEnvelope(text: string): string {
  const envelope = parseOpenCodeTaskEnvelope(text);
  return envelope ? (envelope.result ?? envelope.error ?? "") : text;
}
