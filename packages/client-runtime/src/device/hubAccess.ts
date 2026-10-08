import { mergeRemoteQueryParameters, type RemoteQueryParameter } from "@t3tools/shared/remote";

/** Credentials for media requests that cannot set bearer or DPoP headers. */
export interface DeviceHubAccess {
  /** Absolute environment URL ending in `/api/device-hub`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  /** Empty for cookie sessions; includes a short-lived ticket for bearer and DPoP sessions. */
  readonly query: Readonly<Record<string, string>>;
  /** Routing parameters for a saved bearer connection. */
  readonly queryParameters?: readonly RemoteQueryParameter[];
  /** Whether requests must include session cookies. */
  readonly credentials: boolean;
}

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  const queryParameters = access.queryParameters ?? [];
  if (entries.length === 0 && queryParameters.length === 0) return url;

  const serviceUrl = new URL(url);
  for (const [key, value] of entries) {
    serviceUrl.searchParams.append(key, value);
  }
  return mergeRemoteQueryParameters(serviceUrl.toString(), queryParameters);
};
