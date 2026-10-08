import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { mergeRemoteQueryParameters } from "@t3tools/shared/remote";

export function resolveNativeAssetUrl(
  connection: Pick<PreparedConnection, "httpBaseUrl" | "queryParameters">,
  relativeUrl: string,
): string | null {
  const resolvedUrl = resolveAssetUrl(connection.httpBaseUrl, relativeUrl);
  if (resolvedUrl === null) return null;

  let baseUrl: URL;
  let url: URL;
  try {
    baseUrl = new URL(connection.httpBaseUrl);
    url = new URL(resolvedUrl);
  } catch {
    return null;
  }

  if (baseUrl.origin !== url.origin || (url.protocol !== "http:" && url.protocol !== "https:"))
    return resolvedUrl;

  const queryParameters = connection.queryParameters ?? [];
  if (queryParameters.length === 0) return resolvedUrl;
  return mergeRemoteQueryParameters(resolvedUrl, queryParameters);
}
