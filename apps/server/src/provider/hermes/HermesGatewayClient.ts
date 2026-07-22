import { isHermesGatewayUrlQuerySafe } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const HermesGatewayOperation = Schema.Literals([
  "health",
  "models",
  "create-session",
  "get-session",
  "session-messages",
  "session-chat-stream",
  "chat-completion",
]);

export type HermesGatewayOperation = typeof HermesGatewayOperation.Type;

export class HermesGatewayClientError extends Schema.TaggedErrorClass<HermesGatewayClientError>()(
  "HermesGatewayClientError",
  {
    operation: HermesGatewayOperation,
    status: Schema.optional(Schema.Int),
    reason: Schema.Literals([
      "configuration",
      "authentication",
      "not-found",
      "transport",
      "protocol",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "configuration":
        return "Hermes gateway configuration is invalid.";
      case "authentication":
        return "Hermes gateway authentication failed.";
      case "not-found":
        return "The requested Hermes resource was not found.";
      case "transport":
        return "The Hermes gateway could not be reached.";
      case "protocol":
        return "The Hermes gateway returned an invalid response.";
    }
  }
}
const isHermesGatewayClientError = Schema.is(HermesGatewayClientError);

export interface HermesModel {
  readonly id: string;
}

export interface HermesSessionResource {
  readonly id: string;
  readonly model?: string | null;
  readonly title?: string | null;
}

export interface HermesMessageResource {
  readonly id?: string;
  readonly role?: string;
  readonly content?: unknown;
  readonly timestamp?: number | string;
  readonly tool_name?: string;
  readonly tool_calls?: unknown;
}

export interface HermesSseEvent {
  readonly event: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface HermesGatewayClient {
  readonly health: (signal?: AbortSignal) => Promise<{ readonly version?: string }>;
  readonly listModels: (signal?: AbortSignal) => Promise<ReadonlyArray<HermesModel>>;
  readonly createSession: (
    input: { readonly model?: string; readonly title?: string },
    signal?: AbortSignal,
  ) => Promise<HermesSessionResource>;
  readonly getSession: (sessionId: string, signal?: AbortSignal) => Promise<HermesSessionResource>;
  readonly listMessages: (
    sessionId: string,
    signal?: AbortSignal,
  ) => Promise<ReadonlyArray<HermesMessageResource>>;
  readonly streamSessionChat: (
    sessionId: string,
    input: { readonly message: unknown },
    onEvent: (event: HermesSseEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly chatCompletion: (
    input: {
      readonly model: string;
      readonly messages: ReadonlyArray<{ role: string; content: string }>;
    },
    signal?: AbortSignal,
  ) => Promise<string>;
}

export type HermesFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function normalizeHermesGatewayUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new HermesGatewayClientError({
      operation: "health",
      reason: "configuration",
    });
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HermesGatewayClientError({
      operation: "health",
      reason: "configuration",
    });
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !isHermesGatewayUrlQuerySafe(trimmed)
  ) {
    throw new HermesGatewayClientError({
      operation: "health",
      reason: "configuration",
    });
  }
  const query = parsed.search;
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  return `${parsed.toString().replace(/\/$/u, "")}${query}`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function responseError(
  operation: HermesGatewayOperation,
  status: number,
): HermesGatewayClientError {
  return new HermesGatewayClientError({
    operation,
    status,
    reason:
      status === 401 || status === 403
        ? "authentication"
        : status === 404
          ? "not-found"
          : "protocol",
  });
}

async function parseJsonResponse(
  operation: HermesGatewayOperation,
  response: Response,
): Promise<Readonly<Record<string, unknown>>> {
  if (!response.ok) {
    throw responseError(operation, response.status);
  }
  try {
    const decoded: unknown = await response.json();
    const record = asRecord(decoded);
    if (!record) throw new Error("Expected a JSON object");
    return record;
  } catch (cause) {
    if (isHermesGatewayClientError(cause)) throw cause;
    throw new HermesGatewayClientError({ operation, reason: "protocol", cause });
  }
}

async function parseSse(
  response: Response,
  onEvent: (event: HermesSseEvent) => void | Promise<void>,
): Promise<void> {
  if (!response.body) {
    throw new HermesGatewayClientError({
      operation: "session-chat-stream",
      reason: "protocol",
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeBlock = async (block: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    try {
      const decoded: unknown = JSON.parse(dataLines.join("\n"));
      const data = asRecord(decoded);
      if (!data) throw new Error("Expected SSE JSON object");
      await onEvent({ event, data });
    } catch (cause) {
      throw new HermesGatewayClientError({
        operation: "session-chat-stream",
        reason: "protocol",
        cause,
      });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 2_000_000) {
        throw new HermesGatewayClientError({
          operation: "session-chat-stream",
          reason: "protocol",
        });
      }
      let separator = buffer.search(/\r?\n\r?\n/u);
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        const match = buffer.slice(separator).match(/^\r?\n\r?\n/u);
        buffer = buffer.slice(separator + (match?.[0].length ?? 2));
        await consumeBlock(block);
        separator = buffer.search(/\r?\n\r?\n/u);
      }
      if (done) break;
    }
    if (buffer.trim()) await consumeBlock(buffer);
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    reader.releaseLock();
  }
}

export function makeHermesGatewayClient(input: {
  readonly gatewayUrl: string;
  readonly secret: string;
  readonly fetch?: HermesFetch;
}): HermesGatewayClient {
  const baseUrl = new URL(normalizeHermesGatewayUrl(input.gatewayUrl));
  const basePathname = baseUrl.pathname.replace(/\/+$/u, "");
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const urlFor = (path: string) => {
    const target = new URL(baseUrl);
    target.pathname = `${basePathname}/${path.replace(/^\/+/, "")}`;
    return target.toString();
  };

  const request = async (
    operation: HermesGatewayOperation,
    path: string,
    init: RequestInit,
    authenticated = true,
  ): Promise<Response> => {
    try {
      return await fetchImpl(urlFor(path), {
        ...init,
        redirect: "manual",
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
          ...(authenticated ? { Authorization: `Bearer ${input.secret}` } : {}),
        },
      });
    } catch (cause) {
      if (isHermesGatewayClientError(cause)) throw cause;
      throw new HermesGatewayClientError({ operation, reason: "transport", cause });
    }
  };

  return {
    health: async (signal) => {
      const response = await request(
        "health",
        "health",
        { method: "GET", ...(signal ? { signal } : {}) },
        false,
      );
      const json = await parseJsonResponse("health", response);
      return typeof json.version === "string" ? { version: json.version } : {};
    },
    listModels: async (signal) => {
      const response = await request("models", "v1/models", {
        method: "GET",
        ...(signal ? { signal } : {}),
      });
      const json = await parseJsonResponse("models", response);
      if (!Array.isArray(json.data)) {
        throw new HermesGatewayClientError({ operation: "models", reason: "protocol" });
      }
      return json.data.flatMap((entry) => {
        const record = asRecord(entry);
        return record && typeof record.id === "string" ? [{ id: record.id }] : [];
      });
    },
    createSession: async (sessionInput, signal) => {
      const response = await request("create-session", "api/sessions", {
        method: "POST",
        ...(signal ? { signal } : {}),
        body: JSON.stringify(sessionInput),
      });
      const json = await parseJsonResponse("create-session", response);
      const session = asRecord(json.session);
      if (!session || typeof session.id !== "string") {
        throw new HermesGatewayClientError({ operation: "create-session", reason: "protocol" });
      }
      return {
        id: session.id,
        ...(typeof session.model === "string" || session.model === null
          ? { model: session.model }
          : {}),
        ...(typeof session.title === "string" || session.title === null
          ? { title: session.title }
          : {}),
      };
    },
    getSession: async (sessionId, signal) => {
      const response = await request(
        "get-session",
        `api/sessions/${encodeURIComponent(sessionId)}`,
        { method: "GET", ...(signal ? { signal } : {}) },
      );
      const json = await parseJsonResponse("get-session", response);
      const session = asRecord(json.session);
      if (!session || typeof session.id !== "string") {
        throw new HermesGatewayClientError({ operation: "get-session", reason: "protocol" });
      }
      return {
        id: session.id,
        ...(typeof session.model === "string" || session.model === null
          ? { model: session.model }
          : {}),
        ...(typeof session.title === "string" || session.title === null
          ? { title: session.title }
          : {}),
      };
    },
    listMessages: async (sessionId, signal) => {
      const response = await request(
        "session-messages",
        `api/sessions/${encodeURIComponent(sessionId)}/messages`,
        { method: "GET", ...(signal ? { signal } : {}) },
      );
      const json = await parseJsonResponse("session-messages", response);
      return Array.isArray(json.data)
        ? json.data.flatMap((entry) => (asRecord(entry) ? [entry as HermesMessageResource] : []))
        : [];
    },
    streamSessionChat: async (sessionId, chatInput, onEvent, signal) => {
      const response = await request(
        "session-chat-stream",
        `api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
        {
          method: "POST",
          ...(signal ? { signal } : {}),
          body: JSON.stringify(chatInput),
          headers: { Accept: "text/event-stream" },
        },
      );
      if (!response.ok) throw responseError("session-chat-stream", response.status);
      await parseSse(response, onEvent);
    },
    chatCompletion: async (completionInput, signal) => {
      const response = await request("chat-completion", "v1/chat/completions", {
        method: "POST",
        ...(signal ? { signal } : {}),
        body: JSON.stringify({ ...completionInput, stream: false }),
      });
      const json = await parseJsonResponse("chat-completion", response);
      const choices = Array.isArray(json.choices) ? json.choices : [];
      const first = asRecord(choices[0]);
      const message = first ? asRecord(first.message) : null;
      if (!message || typeof message.content !== "string") {
        throw new HermesGatewayClientError({ operation: "chat-completion", reason: "protocol" });
      }
      return message.content;
    },
  };
}
