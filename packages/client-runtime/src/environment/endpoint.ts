export * from "@t3tools/shared/advertisedEndpoint";
import { appendRemoteQueryParameters, type RemoteQueryParameter } from "@t3tools/shared/remote";

export const environmentEndpointUrl = (
  httpBaseUrl: string,
  pathname: string,
  queryParameters: ReadonlyArray<RemoteQueryParameter> = [],
): string => {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return appendRemoteQueryParameters(url.toString(), queryParameters);
};
