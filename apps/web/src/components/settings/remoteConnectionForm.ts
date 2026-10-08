import type {
  BearerConnectionProfile,
  ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import {
  parseRemotePairingUrlFields,
  resolveRemotePairingTarget,
  type RemoteQueryParameter,
  type ResolvedRemotePairingTarget,
} from "@t3tools/shared/remote";
import * as Option from "effect/Option";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { configuredHostedAppUrl } from "~/hostedPairing";

export interface RemoteConnectionFieldsValue {
  readonly host: string;
  readonly pairingCode: string;
  readonly queryParameters: ReadonlyArray<RemoteQueryParameter>;
}

type RemotePairingUrlFieldOptions = {
  readonly preservePairingCode?: boolean;
  readonly acceptTokenlessUrl?: boolean;
};

function getRemotePairingUrlFields(
  current: RemoteConnectionFieldsValue,
  input: string,
  options: RemotePairingUrlFieldOptions = {},
): RemoteConnectionFieldsValue | null {
  const parsed = parseRemotePairingUrlFields(input, {
    hostedAppUrl: configuredHostedAppUrl(),
  });
  if (parsed === null) return null;

  // A tokenless URL is only an explicit paste candidate when it carries
  // parameters to import. A normal host paste must continue through the
  // browser's regular input path instead of being intercepted here.
  if (
    parsed.pairingCode === "" &&
    (options.acceptTokenlessUrl !== true || parsed.queryParameters.length === 0)
  ) {
    return null;
  }

  return {
    host: parsed.host,
    pairingCode:
      parsed.pairingCode === "" || options.preservePairingCode === true
        ? current.pairingCode
        : parsed.pairingCode,
    queryParameters: parsed.queryParameters,
  };
}

/**
 * Apply a pasted pairing URL to the fields without treating ordinary host
 * typing as a URL paste. Editing a saved connection keeps its existing token
 * private, so that mode updates only the host and parameters.
 */
export function applyRemotePairingUrlToFields(
  current: RemoteConnectionFieldsValue,
  input: string,
  options: RemotePairingUrlFieldOptions = {},
): RemoteConnectionFieldsValue {
  return getRemotePairingUrlFields(current, input, options) ?? { ...current, host: input };
}

export { getRemotePairingUrlFields };

export function resolveRemoteConnectionFields(
  fields: RemoteConnectionFieldsValue,
): ResolvedRemotePairingTarget {
  return resolveRemotePairingTarget({
    host: fields.host,
    pairingCode: fields.pairingCode,
    queryParameters: fields.queryParameters,
    hostedAppUrl: configuredHostedAppUrl(),
  });
}

export function getEditableRemoteBearerProfile(
  entry: ConnectionCatalogEntry,
): BearerConnectionProfile | null {
  if (entry.target._tag !== "BearerConnectionTarget") return null;
  if (isDesktopLocalConnectionTarget(entry.target)) return null;
  if (Option.isNone(entry.profile) || entry.profile.value._tag !== "BearerConnectionProfile") {
    return null;
  }
  return entry.profile.value;
}

export function isEditableRemoteBearerConnection(entry: ConnectionCatalogEntry): boolean {
  return getEditableRemoteBearerProfile(entry) !== null;
}
