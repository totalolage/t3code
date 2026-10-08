import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  RelayConnectionRegistration,
  RelayConnectionTarget,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  type ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { RemoteQueryParameter } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const LegacySavedRemoteConnection = Schema.Struct({
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  pairingUrl: Schema.String,
  displayUrl: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  queryParameters: Schema.optionalKey(Schema.Array(RemoteQueryParameter)),
  bearerToken: Schema.NullOr(Schema.String),
  authenticationMethod: Schema.optionalKey(Schema.Literals(["bearer", "dpop"])),
  dpopAccessToken: Schema.optionalKey(Schema.String),
  relayManaged: Schema.optionalKey(Schema.Literal(true)),
});

const LegacyConnectionDocument = Schema.Struct({
  connections: Schema.optionalKey(Schema.Array(LegacySavedRemoteConnection)),
});
const decodeLegacyConnectionDocument = Schema.decodeUnknownEffect(LegacyConnectionDocument);

export class LegacyConnectionMigrationError extends Schema.TaggedError<LegacyConnectionMigrationError>()(
  "LegacyConnectionMigrationError",
  {
    message: Schema.String,
  },
) {}

function isRelayManaged(connection: typeof LegacySavedRemoteConnection.Type): boolean {
  return connection.relayManaged === true || connection.authenticationMethod === "dpop";
}

const migrateConnection = Effect.fn("mobile.connectionMigration.migrateConnection")(function* (
  document: ConnectionCatalogDocument,
  connection: typeof LegacySavedRemoteConnection.Type,
): Effect.fn.Return<ConnectionCatalogDocument, LegacyConnectionMigrationError> {
  if (isRelayManaged(connection)) {
    return registerConnectionInCatalog(
      document,
      new RelayConnectionRegistration({
        target: new RelayConnectionTarget({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        }),
      }),
    );
  }

  const bearerToken = connection.bearerToken;
  if (bearerToken === null || bearerToken.trim() === "") {
    return yield* Effect.fail(
      new LegacyConnectionMigrationError({
        message: `Could not migrate legacy connection ${connection.environmentId}: missing bearer credential.`,
      }),
    );
  }

  const connectionId = `bearer:${connection.environmentId}`;
  return registerConnectionInCatalog(
    document,
    new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionId,
      }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        httpBaseUrl: connection.httpBaseUrl,
        wsBaseUrl: connection.wsBaseUrl,
        queryParameters: connection.queryParameters,
      }),
      credential: new BearerConnectionCredential({
        token: bearerToken,
      }),
    }),
  );
});

export const migrateLegacyConnectionCatalog = Effect.fn(
  "mobile.connectionMigration.migrateCatalog",
)(function* (raw: string) {
  const parsed = yield* Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new LegacyConnectionMigrationError({
        message: `Could not parse the legacy mobile connection catalog: ${String(cause)}`,
      }),
  });
  const legacy = yield* decodeLegacyConnectionDocument(parsed).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyConnectionMigrationError({
          message: `Could not decode the legacy mobile connection catalog: ${String(cause)}`,
        }),
    ),
  );

  let catalog = EMPTY_CONNECTION_CATALOG_DOCUMENT;
  for (const connection of legacy.connections ?? []) {
    catalog = yield* migrateConnection(catalog, connection);
  }
  return catalog;
});
