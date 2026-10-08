import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { LegacyConnectionMigrationError, migrateLegacyConnectionCatalog } from "./migration";

describe("migrateLegacyConnectionCatalog", () => {
  it.effect("migrates bearer and relay-managed connections into the new catalog", () =>
    Effect.gen(function* () {
      const bearerEnvironmentId = EnvironmentId.make("bearer-environment");
      const relayEnvironmentId = EnvironmentId.make("relay-environment");
      const bearerToken = "  bearer-token  ";
      const queryParameters = [
        { key: "  proxy  ", value: " first " },
        { key: "proxy", value: "second" },
        { key: "", value: "" },
        { key: "empty", value: "" },
      ];
      const catalog = yield* migrateLegacyConnectionCatalog(
        JSON.stringify({
          connections: [
            {
              environmentId: bearerEnvironmentId,
              environmentLabel: "Local Mac",
              pairingUrl: "https://local.example.test/pair",
              displayUrl: "https://local.example.test",
              httpBaseUrl: "https://local.example.test",
              wsBaseUrl: "wss://local.example.test",
              bearerToken,
              authenticationMethod: "bearer",
              queryParameters,
            },
            {
              environmentId: relayEnvironmentId,
              environmentLabel: "Cloud Mac",
              pairingUrl: "https://relay.example.test",
              displayUrl: "https://relay.example.test",
              httpBaseUrl: "https://relay.example.test",
              wsBaseUrl: "wss://relay.example.test",
              bearerToken: null,
              authenticationMethod: "dpop",
              relayManaged: true,
            },
          ],
        }),
      );

      expect(catalog.targets).toHaveLength(2);
      expect(
        catalog.targets.find((target) => target.environmentId === bearerEnvironmentId)?._tag,
      ).toBe("BearerConnectionTarget");
      expect(
        catalog.targets.find((target) => target.environmentId === relayEnvironmentId)?._tag,
      ).toBe("RelayConnectionTarget");
      expect(catalog.profiles).toHaveLength(1);
      expect(catalog.profiles[0]).toMatchObject({
        connectionId: `bearer:${bearerEnvironmentId}`,
        environmentId: bearerEnvironmentId,
        queryParameters,
      });
      expect(catalog.credentials).toHaveLength(1);
      expect(catalog.credentials[0]?.connectionId).toBe(`bearer:${bearerEnvironmentId}`);
      expect(catalog.credentials[0]?.credential).toMatchObject({
        _tag: "BearerConnectionCredential",
        token: bearerToken,
      });
    }),
  );

  it.effect("defaults missing legacy query parameters through the bearer profile", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("legacy-without-parameters");
      const catalog = yield* migrateLegacyConnectionCatalog(
        JSON.stringify({
          connections: [
            {
              environmentId,
              environmentLabel: "Legacy",
              pairingUrl: "https://legacy.example.test/pair",
              displayUrl: "https://legacy.example.test",
              httpBaseUrl: "https://legacy.example.test",
              wsBaseUrl: "wss://legacy.example.test",
              bearerToken: "legacy-token",
              authenticationMethod: "bearer",
            },
          ],
        }),
      );

      expect(catalog.targets[0]?.environmentId).toBe(environmentId);
      expect(catalog.profiles[0]).toMatchObject({
        environmentId,
        queryParameters: [],
      });
    }),
  );

  it.effect("fails malformed legacy query parameters instead of discarding them", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        migrateLegacyConnectionCatalog(
          JSON.stringify({
            connections: [
              {
                environmentId: EnvironmentId.make("malformed-parameters"),
                environmentLabel: "Malformed",
                pairingUrl: "https://malformed.example.test/pair",
                displayUrl: "https://malformed.example.test",
                httpBaseUrl: "https://malformed.example.test",
                wsBaseUrl: "wss://malformed.example.test",
                bearerToken: "malformed-token",
                authenticationMethod: "bearer",
                queryParameters: [{ key: "proxy", value: 42 }],
              },
            ],
          }),
        ),
      );

      expect(error).toBeInstanceOf(LegacyConnectionMigrationError);
      expect(error.message).toContain("Could not decode");
    }),
  );

  it.effect("fails legacy bearer entries with null or blank credentials", () =>
    Effect.gen(function* () {
      for (const [name, bearerToken] of [
        ["null", null],
        ["empty", ""],
        ["whitespace", "   "],
      ] as const) {
        const error = yield* Effect.flip(
          migrateLegacyConnectionCatalog(
            JSON.stringify({
              connections: [
                {
                  environmentId: EnvironmentId.make(`invalid-bearer-${name}`),
                  environmentLabel: "Invalid",
                  pairingUrl: "https://invalid.example.test/pair",
                  displayUrl: "https://invalid.example.test",
                  httpBaseUrl: "https://invalid.example.test",
                  wsBaseUrl: "wss://invalid.example.test",
                  bearerToken,
                  authenticationMethod: "bearer",
                },
              ],
            }),
          ),
        );

        expect(error).toBeInstanceOf(LegacyConnectionMigrationError);
        expect(error.message).toContain("missing bearer credential");
      }
    }),
  );
});
