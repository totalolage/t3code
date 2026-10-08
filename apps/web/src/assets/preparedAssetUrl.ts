import type { AssetCreateUrlResult } from "@t3tools/contracts";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { type AssetUrlState, resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { mergeRemoteQueryParameters } from "@t3tools/shared/remote";
import type { AsyncResult } from "effect/reactivity";

/**
 * Resolves an asset URL against a prepared connection and merges the
 * connection's configured query parameters into same-origin http(s) results.
 * Service-owned query keys win over config, config duplicates keep their
 * order, and the reserved token key never crosses into asset URLs.
 */
export function resolvePreparedAssetUrl(
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

/** Web-local counterpart of the runtime's `assetUrlStateFromResult` that merges
 * the prepared connection's routing parameters into same-origin http(s) URLs. */
export function assetUrlStateFromPreparedResult(
  result: AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>,
  connection: Pick<PreparedConnection, "httpBaseUrl" | "queryParameters"> | null,
): AssetUrlState {
  if (result._tag === "Failure") return { _tag: "Failure" };
  if (connection === null || result._tag !== "Success") return { _tag: "Loading" };
  const url = resolvePreparedAssetUrl(connection, result.value.relativeUrl);
  if (url === null) return { _tag: "Failure" };
  return {
    _tag: "Success",
    url,
    expiresAt: result.value.expiresAt,
    ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
    ...(result.value.imageDimensions !== undefined
      ? { imageDimensions: result.value.imageDimensions }
      : {}),
  };
}
