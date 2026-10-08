import type { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  normalizeRemoteQueryParameters,
  parseRemotePairingUrlFields,
  type RemoteQueryParameter,
} from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";

import { isIpLiteral, pairingUrlInput } from "../../lib/connection";

export { pairingConnectionInputFromUrl } from "../../lib/connection";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

export class PairingQrPayloadEmptyError extends Schema.TaggedError<PairingQrPayloadEmptyError>()(
  "PairingQrPayloadEmptyError",
  {},
) {
  override get message(): string {
    return "Scanned QR code did not contain a pairing URL.";
  }
}

export function buildPairingUrl(
  host: string,
  code: string,
  queryParameters?: ReadonlyArray<RemoteQueryParameter>,
): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  const parsed = parseRemotePairingUrlFields(pairingUrlInput(h));
  const normalizedQueryParameters =
    queryParameters === undefined
      ? (parsed?.queryParameters ?? [])
      : normalizeRemoteQueryParameters(queryParameters);
  const effectiveCode = c || parsed?.pairingCode || "";

  if (!effectiveCode && queryParameters === undefined) return h;

  try {
    const url = new URL(
      parsed?.host ?? (h.includes("://") ? h : `${isIpLiteral(h) ? "http" : "https"}://${h}`),
    );
    url.search = "";
    for (const parameter of normalizedQueryParameters) {
      url.searchParams.append(parameter.key, parameter.value);
    }
    url.hash =
      effectiveCode === "" ? "" : new URLSearchParams([["token", effectiveCode]]).toString();
    return url.toString();
  } catch {
    return effectiveCode === "" ? h : `${h}#token=${effectiveCode}`;
  }
}

export function parsePairingUrl(url: string): {
  host: string;
  code: string;
  queryParameters: ReadonlyArray<RemoteQueryParameter>;
} {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "", queryParameters: [] };

  const parsed = parseRemotePairingUrlFields(pairingUrlInput(trimmed));
  if (parsed) {
    return {
      host: parsed.host,
      code: parsed.pairingCode,
      queryParameters: parsed.queryParameters,
    };
  }
  return { host: trimmed, code: "", queryParameters: [] };
}

export function buildPairingConnectionInput(
  host: string,
  code: string,
  queryParameters?: ReadonlyArray<RemoteQueryParameter>,
): ConnectionOnboarding.PairingConnectionInput {
  const parsed = parsePairingUrl(host);
  const selectedQueryParameters = queryParameters ?? parsed.queryParameters;

  return {
    host: parsed.host,
    pairingCode: code.trim() || parsed.code,
    queryParameters: normalizeRemoteQueryParameters(selectedQueryParameters),
  };
}

export function extractPairingUrlFromQrPayload(payload: string): string {
  const trimmed = payload.trim();
  if (!trimmed) {
    throw new PairingQrPayloadEmptyError({});
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === "t3code:") {
      const pairingUrl = url.searchParams.get(MOBILE_PAIRING_URL_PARAM)?.trim() ?? "";
      if (pairingUrl.length > 0) {
        return pairingUrl;
      }
    }
  } catch {
    // Treat non-URL payloads as raw pairing-url text so the normal input validation can decide.
  }

  return trimmed;
}
