import { EnvironmentId } from "@t3tools/contracts";
import type {
  EnvironmentConnectionPhase,
  EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";

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
