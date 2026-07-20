import {
  parseRemotePairingUrlFields,
  normalizeRemoteQueryParameters,
  type RemoteQueryParameter,
} from "@t3tools/shared/remote";
import * as Schema from "effect/Schema";

const MOBILE_PAIRING_URL_PARAM = "pairingUrl";

export class PairingQrPayloadEmptyError extends Schema.TaggedErrorClass<PairingQrPayloadEmptyError>()(
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
  queryParameters: ReadonlyArray<RemoteQueryParameter> = [],
): string {
  const h = host.trim();
  const c = code.trim();
  if (!h) return "";
  const normalizedQueryParameters = normalizeRemoteQueryParameters(queryParameters);

  try {
    const url = new URL(h.includes("://") ? h : `https://${h}`);
    url.search = "";
    for (const parameter of normalizedQueryParameters) {
      url.searchParams.append(parameter.key, parameter.value);
    }
    url.hash = c === "" ? "" : new URLSearchParams([["token", c]]).toString();
    return url.toString();
  } catch {
    return `${h}#token=${c}`;
  }
}

export function parsePairingUrl(url: string): {
  host: string;
  code: string;
  queryParameters: ReadonlyArray<RemoteQueryParameter>;
} {
  const trimmed = url.trim();
  if (!trimmed) return { host: "", code: "", queryParameters: [] };

  const parsed = parseRemotePairingUrlFields(trimmed);
  if (parsed) {
    return {
      host: parsed.host,
      code: parsed.pairingCode,
      queryParameters: parsed.queryParameters,
    };
  }
  return { host: trimmed, code: "", queryParameters: [] };
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
