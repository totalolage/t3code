import { describe, expect, it } from "@effect/vitest";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make } from "./catalog-store";
import {
  MobileSecureStorage,
  MobileSecureStorageError,
} from "../persistence/mobile-secure-storage";

function makeStorage(
  initial: Readonly<Record<string, string>>,
  options: { readonly setItemError?: MobileSecureStorageError } = {},
) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const storage = MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      options.setItemError === undefined
        ? Effect.sync(() => {
            values.set(key, value);
          })
        : Effect.fail(options.setItemError),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values };
}

describe("mobile connection catalog storage", () => {
  it.effect("preserves an invalid current catalog and propagates a typed error", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        schemaVersion: 1,
        targets: [],
        profiles: [
          {
            _tag: "BearerConnectionProfile",
            connectionId: "bearer:current-environment",
            environmentId: "current-environment",
            label: "Current",
            httpBaseUrl: "https://current.example.test",
            wsBaseUrl: "wss://current.example.test",
            queryParameters: [{ key: "proxy", value: 42 }],
          },
        ],
        credentials: [],
        remoteDpopTokens: [],
      });
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: raw,
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const error = yield* Effect.flip(catalog.read);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("remote-unavailable");
      expect([...memory.values.entries()]).toEqual([[CONNECTION_CATALOG_KEY, raw]]);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("preserves an invalid legacy catalog and propagates a typed error", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        connections: [
          {
            environmentId: "legacy-environment",
            environmentLabel: "Legacy",
            pairingUrl: "https://legacy.example.test/pair",
            displayUrl: "https://legacy.example.test",
            httpBaseUrl: "https://legacy.example.test",
            wsBaseUrl: "wss://legacy.example.test",
            bearerToken: "legacy-token",
            authenticationMethod: "bearer",
            queryParameters: [{ key: "proxy", value: 42 }],
          },
        ],
      });
      const memory = makeStorage({
        [LEGACY_CONNECTIONS_KEY]: raw,
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const error = yield* Effect.flip(catalog.read);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("remote-unavailable");
      expect([...memory.values.entries()]).toEqual([[LEGACY_CONNECTIONS_KEY, raw]]);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("does not fall back to legacy data when the current catalog is invalid", () =>
    Effect.gen(function* () {
      const currentRaw = JSON.stringify({
        schemaVersion: 1,
        targets: [],
        profiles: [
          {
            _tag: "BearerConnectionProfile",
            connectionId: "bearer:current-environment",
            environmentId: "current-environment",
            label: "Current",
            httpBaseUrl: "https://current.example.test",
            wsBaseUrl: "wss://current.example.test",
            queryParameters: [{ key: "proxy", value: 42 }],
          },
        ],
        credentials: [],
        remoteDpopTokens: [],
      });
      const legacyRaw = JSON.stringify({
        connections: [
          {
            environmentId: "legacy-environment",
            environmentLabel: "Legacy",
            pairingUrl: "https://legacy.example.test/pair",
            displayUrl: "https://legacy.example.test",
            httpBaseUrl: "https://legacy.example.test",
            wsBaseUrl: "wss://legacy.example.test",
            bearerToken: "legacy-token",
            authenticationMethod: "bearer",
          },
        ],
      });
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: currentRaw,
        [LEGACY_CONNECTIONS_KEY]: legacyRaw,
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const error = yield* Effect.flip(catalog.read);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("remote-unavailable");
      expect([...memory.values.entries()]).toEqual([
        [CONNECTION_CATALOG_KEY, currentRaw],
        [LEGACY_CONNECTIONS_KEY, legacyRaw],
      ]);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("migrates valid legacy data before removing the legacy record", () =>
    Effect.gen(function* () {
      const bearerEnvironmentId = "legacy-bearer-environment";
      const relayEnvironmentId = "legacy-relay-environment";
      const queryParameters = [
        { key: "  proxy  ", value: " first " },
        { key: "proxy", value: "second" },
        { key: "", value: "" },
        { key: "empty", value: "" },
      ];
      const legacyRaw = JSON.stringify({
        connections: [
          {
            environmentId: bearerEnvironmentId,
            environmentLabel: "Legacy bearer",
            pairingUrl: "https://legacy-bearer.example.test/pair",
            displayUrl: "https://legacy-bearer.example.test",
            httpBaseUrl: "https://legacy-bearer.example.test",
            wsBaseUrl: "wss://legacy-bearer.example.test",
            bearerToken: "legacy-bearer-token",
            authenticationMethod: "bearer",
            queryParameters,
          },
          {
            environmentId: relayEnvironmentId,
            environmentLabel: "Legacy relay",
            pairingUrl: "https://legacy-relay.example.test/pair",
            displayUrl: "https://legacy-relay.example.test",
            httpBaseUrl: "https://legacy-relay.example.test",
            wsBaseUrl: "wss://legacy-relay.example.test",
            bearerToken: null,
            authenticationMethod: "dpop",
            relayManaged: true,
          },
        ],
      });
      const memory = makeStorage({ [LEGACY_CONNECTIONS_KEY]: legacyRaw });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const document = yield* catalog.read;
      expect(document.targets.map((target) => target.environmentId)).toEqual([
        bearerEnvironmentId,
        relayEnvironmentId,
      ]);
      expect(document.profiles[0]).toMatchObject({
        environmentId: bearerEnvironmentId,
        queryParameters,
      });
      expect(document.credentials[0]).toMatchObject({
        connectionId: `bearer:${bearerEnvironmentId}`,
        credential: { token: "legacy-bearer-token" },
      });
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
    }),
  );

  it.effect("preserves mixed valid and invalid legacy data without partial migration", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        connections: [
          {
            environmentId: "valid-bearer-environment",
            environmentLabel: "Valid bearer",
            pairingUrl: "https://valid-bearer.example.test/pair",
            displayUrl: "https://valid-bearer.example.test",
            httpBaseUrl: "https://valid-bearer.example.test",
            wsBaseUrl: "wss://valid-bearer.example.test",
            bearerToken: "valid-bearer-token",
            authenticationMethod: "bearer",
          },
          {
            environmentId: "invalid-bearer-environment",
            environmentLabel: "Invalid bearer",
            pairingUrl: "https://invalid-bearer.example.test/pair",
            displayUrl: "https://invalid-bearer.example.test",
            httpBaseUrl: "https://invalid-bearer.example.test",
            wsBaseUrl: "wss://invalid-bearer.example.test",
            bearerToken: "   ",
            authenticationMethod: "bearer",
          },
        ],
      });
      const memory = makeStorage({ [LEGACY_CONNECTIONS_KEY]: raw });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const error = yield* Effect.flip(catalog.read);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("remote-unavailable");
      expect([...memory.values.entries()]).toEqual([[LEGACY_CONNECTIONS_KEY, raw]]);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("keeps valid legacy data when writing the migrated catalog fails", () =>
    Effect.gen(function* () {
      const raw = JSON.stringify({
        connections: [
          {
            environmentId: "write-failure-environment",
            environmentLabel: "Write failure",
            pairingUrl: "https://write-failure.example.test/pair",
            displayUrl: "https://write-failure.example.test",
            httpBaseUrl: "https://write-failure.example.test",
            wsBaseUrl: "wss://write-failure.example.test",
            bearerToken: "write-failure-token",
            authenticationMethod: "bearer",
          },
        ],
      });
      const memory = makeStorage(
        { [LEGACY_CONNECTIONS_KEY]: raw },
        {
          setItemError: new MobileSecureStorageError({
            operation: "write",
            key: CONNECTION_CATALOG_KEY,
            cause: new Error("write failed"),
          }),
        },
      );
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const error = yield* Effect.flip(catalog.read);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.reason).toBe("remote-unavailable");
      expect([...memory.values.entries()]).toEqual([[LEGACY_CONNECTIONS_KEY, raw]]);
      expect(memory.deleted).toEqual([]);
    }),
  );

  it.effect("retains query parameters when decoding a current catalog", () =>
    Effect.gen(function* () {
      const environmentId = "current-environment";
      const connectionId = `bearer:${environmentId}`;
      const queryParameters = [
        { key: "  proxy  ", value: " first " },
        { key: "proxy", value: "second" },
        { key: "", value: "" },
        { key: "empty", value: "" },
      ];
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [
            {
              _tag: "BearerConnectionTarget",
              environmentId,
              label: "Current",
              connectionId,
            },
          ],
          profiles: [
            {
              _tag: "BearerConnectionProfile",
              connectionId,
              environmentId,
              label: "Current",
              httpBaseUrl: "https://current.example.test",
              wsBaseUrl: "wss://current.example.test",
              queryParameters,
            },
          ],
          credentials: [
            {
              connectionId,
              credential: {
                _tag: "BearerConnectionCredential",
                token: "current-token",
              },
            },
          ],
          remoteDpopTokens: [],
        }),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage, memory.storage),
      );

      const document = yield* catalog.read;
      expect(document.targets[0]).toMatchObject({ environmentId, connectionId });
      expect(document.profiles[0]).toMatchObject({ queryParameters });
      expect(document.credentials[0]).toMatchObject({ connectionId });
      expect(document.credentials[0]?.credential).toMatchObject({ token: "current-token" });
      expect(memory.deleted).toEqual([]);
    }),
  );
});
