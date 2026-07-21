import { HermesSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeHermesTextGeneration } from "../../textGeneration/HermesTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeHermesAdapter } from "../Layers/HermesAdapter.ts";
import { checkHermesProviderStatus, makePendingHermesProvider } from "../Layers/HermesProvider.ts";
import {
  makeHermesGatewayClient,
  type HermesGatewayClient,
} from "../hermes/HermesGatewayClient.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const DRIVER_KIND = ProviderDriverKind.make("hermes");
const SECRET_VARIABLE = "HERMES_GATEWAY_SECRET";
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const decodeSettings = Schema.decodeSync(HermesSettings);

export type HermesDriverEnv = Crypto.Crypto | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

function createClient(input: {
  readonly gatewayUrl: string;
  readonly secret: string | undefined;
}): HermesGatewayClient | undefined {
  if (!input.gatewayUrl.trim() || !input.secret?.trim()) return undefined;
  try {
    return makeHermesGatewayClient({
      gatewayUrl: input.gatewayUrl,
      secret: input.secret,
    });
  } catch {
    return undefined;
  }
}

export const HermesDriver: ProviderDriver<HermesSettings, HermesDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Hermes",
    supportsMultipleInstances: true,
  },
  configSchema: HermesSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const effectiveConfig = { ...config, enabled } satisfies HermesSettings;
      const secret = environment.find(
        (variable) => variable.name === SECRET_VARIABLE && variable.sensitive,
      )?.value;
      const client = createClient({ gatewayUrl: effectiveConfig.gatewayUrl, secret });
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const adapter = yield* makeHermesAdapter({
        instanceId,
        enabled,
        ...(client ? { client } : {}),
      });
      const textGeneration = makeHermesTextGeneration(client);
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<HermesSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingHermesProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkHermesProviderStatus(effectiveConfig, client).pipe(
          Effect.map(stampIdentity),
        ),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Hermes provider snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
