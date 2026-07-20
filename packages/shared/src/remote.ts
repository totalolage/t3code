import * as Schema from "effect/Schema";

const PAIRING_TOKEN_PARAM = "token";
const HOSTED_PAIRING_HOST_PARAM = "host";
const HOSTED_PAIRING_LABEL_PARAM = "label";
const SUPPORTED_REMOTE_BACKEND_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export const RemoteQueryParameter = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
});
export type RemoteQueryParameter = typeof RemoteQueryParameter.Type;

export const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

export class RemoteBackendUrlMissingError extends Schema.TaggedErrorClass<RemoteBackendUrlMissingError>()(
  "RemoteBackendUrlMissingError",
  {},
) {
  override get message(): string {
    return "Enter a backend URL.";
  }
}

export class RemotePairingUrlInvalidError extends Schema.TaggedErrorClass<RemotePairingUrlInvalidError>()(
  "RemotePairingUrlInvalidError",
  {
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Pairing URL is invalid.";
  }
}

export class RemoteBackendUrlInvalidError extends Schema.TaggedErrorClass<RemoteBackendUrlInvalidError>()(
  "RemoteBackendUrlInvalidError",
  {
    source: Schema.Literals(["direct-host", "hosted-pairing-host"]),
    cause: Schema.optional(Schema.Defect()),
    protocol: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return "Backend URL is invalid.";
  }
}

export class RemotePairingTokenMissingError extends Schema.TaggedErrorClass<RemotePairingTokenMissingError>()(
  "RemotePairingTokenMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Pairing URL is missing its token.";
  }
}

export class RemotePairingCodeMissingError extends Schema.TaggedErrorClass<RemotePairingCodeMissingError>()(
  "RemotePairingCodeMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return "Enter a pairing code.";
  }
}

export class RemoteQueryParameterKeyMissingError extends Schema.TaggedErrorClass<RemoteQueryParameterKeyMissingError>()(
  "RemoteQueryParameterKeyMissingError",
  { index: Schema.Number },
) {
  override get message(): string {
    return "Query parameter keys cannot be empty.";
  }
}

export class RemoteQueryParameterReservedError extends Schema.TaggedErrorClass<RemoteQueryParameterReservedError>()(
  "RemoteQueryParameterReservedError",
  { key: Schema.String },
) {
  override get message(): string {
    return "Use the Pairing code field instead of a token query parameter.";
  }
}

export const RemotePairingTargetError = Schema.Union([
  RemoteBackendUrlMissingError,
  RemotePairingUrlInvalidError,
  RemoteBackendUrlInvalidError,
  RemotePairingTokenMissingError,
  RemotePairingCodeMissingError,
  RemoteQueryParameterKeyMissingError,
  RemoteQueryParameterReservedError,
]);
export type RemotePairingTargetError = typeof RemotePairingTargetError.Type;

const hasSupportedRemoteBackendProtocol = (url: URL): boolean =>
  SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(url.protocol);

const queryParametersFromUrl = (url: URL): ReadonlyArray<RemoteQueryParameter> =>
  [...url.searchParams.entries()]
    .filter(([key]) => key !== PAIRING_TOKEN_PARAM)
    .map(([key, value]) => ({ key, value }));

export const normalizeRemoteQueryParameters = (
  input: ReadonlyArray<RemoteQueryParameter>,
): ReadonlyArray<RemoteQueryParameter> =>
  input.flatMap((parameter, index) => {
    const key = parameter.key.trim();
    if (key === "" && parameter.value === "") {
      return [];
    }
    if (key === "") {
      throw new RemoteQueryParameterKeyMissingError({ index });
    }
    if (key === PAIRING_TOKEN_PARAM) {
      throw new RemoteQueryParameterReservedError({ key });
    }
    return [{ key, value: parameter.value }];
  });

export const appendRemoteQueryParameters = (
  input: string,
  parameters: ReadonlyArray<RemoteQueryParameter>,
): string => {
  const url = new URL(input);
  for (const parameter of parameters) {
    url.searchParams.append(parameter.key, parameter.value);
  }
  return url.toString();
};

interface NormalizedRemoteBaseUrl {
  readonly url: URL;
  readonly queryParameters: ReadonlyArray<RemoteQueryParameter>;
}

const normalizeRemoteBaseUrl = (
  rawValue: string,
  source: RemoteBackendUrlInvalidError["source"],
): NormalizedRemoteBaseUrl => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    throw new RemoteBackendUrlMissingError();
  }

  const withoutLeadingSlashes = trimmed.replace(/^\/+/, "");
  const normalizedInput = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(withoutLeadingSlashes)
    ? withoutLeadingSlashes
    : `https://${withoutLeadingSlashes}`;
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch (cause) {
    throw new RemoteBackendUrlInvalidError({ source, cause });
  }
  if (!hasSupportedRemoteBackendProtocol(url)) {
    throw new RemoteBackendUrlInvalidError({
      source,
      protocol: url.protocol,
    });
  }
  const queryParameters = queryParametersFromUrl(url);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return { url, queryParameters };
};

const toHttpBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") {
    next.protocol = "http:";
  } else if (next.protocol === "wss:") {
    next.protocol = "https:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

const toWsBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "http:") {
    next.protocol = "ws:";
  } else if (next.protocol === "https:") {
    next.protocol = "wss:";
  }
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly queryParameters: ReadonlyArray<RemoteQueryParameter>;
}

export interface ParsedRemotePairingFields {
  readonly host: string;
  readonly pairingCode: string;
  readonly queryParameters: ReadonlyArray<RemoteQueryParameter>;
}

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
};

export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);
  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
};

export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
};

export const readHostedPairingRequest = (url: URL): HostedPairingRequest | null => {
  const host = url.searchParams.get(HOSTED_PAIRING_HOST_PARAM)?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get(HOSTED_PAIRING_LABEL_PARAM)?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  };
};

export const parseRemotePairingUrlFields = (input: string): ParsedRemotePairingFields | null => {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    const urlLikeInput =
      /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(trimmed) || trimmed.startsWith("//")
        ? trimmed
        : `https://${trimmed}`;
    const url = new URL(urlLikeInput);
    const hosted = readHostedPairingRequest(url);
    if (hosted) {
      const normalized = normalizeRemoteBaseUrl(hosted.host, "hosted-pairing-host");
      return {
        host: toHttpBaseUrl(normalized.url).replace(/\/$/u, ""),
        pairingCode: hosted.token,
        queryParameters: normalized.queryParameters,
      };
    }
    const normalized = normalizeRemoteBaseUrl(url.toString(), "direct-host");
    return {
      host: toHttpBaseUrl(normalized.url).replace(/\/$/u, ""),
      pairingCode: getPairingTokenFromUrl(url) ?? "",
      queryParameters: normalized.queryParameters,
    };
  } catch {
    return null;
  }
};

export const resolveRemotePairingTarget = (input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
}): ResolvedRemotePairingTarget => {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(pairingUrl);
    } catch (cause) {
      throw new RemotePairingUrlInvalidError({ cause });
    }
    if (!hasSupportedRemoteBackendProtocol(url)) {
      throw new RemotePairingUrlInvalidError({
        protocol: url.protocol,
      });
    }
    const hostedPairingRequest = readHostedPairingRequest(url);
    if (hostedPairingRequest) {
      const hostedBackend = normalizeRemoteBaseUrl(
        hostedPairingRequest.host,
        "hosted-pairing-host",
      );
      return {
        credential: hostedPairingRequest.token,
        httpBaseUrl: toHttpBaseUrl(hostedBackend.url),
        wsBaseUrl: toWsBaseUrl(hostedBackend.url),
        queryParameters: normalizeRemoteQueryParameters(
          input.queryParameters ?? hostedBackend.queryParameters,
        ),
      };
    }

    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) {
      throw new RemotePairingTokenMissingError({ host: url.host });
    }
    const normalized = normalizeRemoteBaseUrl(url.toString(), "direct-host");
    return {
      credential,
      httpBaseUrl: toHttpBaseUrl(normalized.url),
      wsBaseUrl: toWsBaseUrl(normalized.url),
      queryParameters: normalizeRemoteQueryParameters(
        input.queryParameters ?? normalized.queryParameters,
      ),
    };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) {
    throw new RemoteBackendUrlMissingError();
  }
  const normalizedHost = normalizeRemoteBaseUrl(host, "direct-host");
  if (!pairingCode) {
    throw new RemotePairingCodeMissingError({ host: normalizedHost.url.host });
  }

  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost.url),
    wsBaseUrl: toWsBaseUrl(normalizedHost.url),
    queryParameters: normalizeRemoteQueryParameters(
      input.queryParameters ?? normalizedHost.queryParameters,
    ),
  };
};
