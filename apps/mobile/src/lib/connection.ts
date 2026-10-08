import type {
  ConnectionOnboarding,
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import {
  normalizeRemoteQueryParameters,
  parseRemotePairingUrlFields,
  type RemoteQueryParameter,
} from "@t3tools/shared/remote";

export interface SavedRemoteConnection {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string | null;
  readonly authenticationMethod?: "bearer" | "dpop";
  readonly dpopAccessToken?: string;
  readonly relayManaged?: true;
  readonly queryParameters?: ReadonlyArray<RemoteQueryParameter>;
}

export type RemoteClientConnectionState = EnvironmentConnectionPhase;

export type ThreadHidingPresentation = Pick<EnvironmentPresentation, "connection" | "serverConfig">;

const CONNECT_TO_ENVIRONMENT_REASON = "Connect to this environment to hide or unhide threads.";
const UPDATE_ENVIRONMENT_SERVER_REASON =
  "Update this environment’s server to hide or unhide threads.";

export function threadHidingUnavailableReason(
  presentation: ThreadHidingPresentation | null,
): string | null {
  if (presentation === null || presentation.connection.phase !== "connected") {
    return CONNECT_TO_ENVIRONMENT_REASON;
  }

  return presentation.serverConfig?.environment.capabilities.threadHiding === true
    ? null
    : UPDATE_ENVIRONMENT_SERVER_REASON;
}

export function isIpLiteral(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    if (hostname.includes(":")) return true;

    const octets = hostname.split(".");
    return (
      octets.length === 4 &&
      octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    );
  } catch {
    return false;
  }
}

export function pairingUrlInput(input: string): string {
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input) || input.startsWith("//");
  return hasScheme || !isIpLiteral(input) ? input : `http://${input}`;
}

export function pairingConnectionInputFromUrl(
  value: string,
): ConnectionOnboarding.PairingConnectionInput {
  const input = value.trim();
  const parsed = input === "" ? null : parseRemotePairingUrlFields(pairingUrlInput(input));

  return {
    host: parsed?.host ?? input,
    pairingCode: parsed?.pairingCode ?? "",
    queryParameters: normalizeRemoteQueryParameters(parsed?.queryParameters ?? []),
  };
}

export function isRelayManagedConnection(
  connection: Pick<SavedRemoteConnection, "authenticationMethod" | "relayManaged">,
): boolean {
  return connection.relayManaged === true || connection.authenticationMethod === "dpop";
}

export function toStableSavedRemoteConnection(
  connection: SavedRemoteConnection,
): SavedRemoteConnection {
  if (!isRelayManagedConnection(connection) || !connection.dpopAccessToken) {
    return connection;
  }

  const { dpopAccessToken: _, ...stableConnection } = connection;
  return stableConnection;
}
