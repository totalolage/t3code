import type { RemoteQueryParameter } from "@t3tools/shared/remote";

import { parsePairingUrl } from "./pairing";

export interface PairingHostFields {
  readonly host: string;
  readonly code: string;
  readonly queryParameters: ReadonlyArray<RemoteQueryParameter>;
}

/**
 * Applies pasted host text to the pairing fields. A URL paste always imports
 * the host and its ordered parameters; a tokenless parameter URL keeps the
 * code the user already entered instead of erasing it with the empty parse
 * result (same rule as the web connection editor's `preservePairingCode`).
 */
export function applyPairingHostInput(
  current: PairingHostFields,
  value: string,
): PairingHostFields {
  const parsed = parsePairingUrl(value);
  if (parsed.code.length > 0 || parsed.queryParameters.length > 0 || /[?#][^?#=]*=/u.test(value)) {
    return {
      host: parsed.host,
      code: parsed.code === "" ? current.code : parsed.code,
      queryParameters: parsed.queryParameters,
    };
  }

  return { ...current, host: value };
}
