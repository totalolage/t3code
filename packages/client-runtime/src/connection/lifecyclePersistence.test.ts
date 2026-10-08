import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";
import { prepareBearerConnectionUpdate } from "./onboarding.ts";
import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
} from "../platform/storageDocument.ts";

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeUnknownEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);

const ENVIRONMENT_ID = EnvironmentId.make("environment-parameters");
const CONNECTION_ID = "bearer:environment-parameters";
const BEARER_TOKEN = "bearer-token-preserved";
const QUERY_PARAMETERS = [
  { key: "scope", value: "first" },
  { key: "format", value: "" },
  { key: "scope", value: "日本語" },
];

const LEGACY_ENVIRONMENT_ID = EnvironmentId.make("legacy-environment");
const LEGACY_CONNECTION_ID = "bearer:legacy-environment";
const LEGACY_CATALOG_JSON = `{
  "schemaVersion": 1,
  "targets": [
    {
      "_tag": "BearerConnectionTarget",
      "environmentId": "legacy-environment",
      "label": "Legacy environment",
      "connectionId": "bearer:legacy-environment"
    }
  ],
  "profiles": [
    {
      "_tag": "BearerConnectionProfile",
      "connectionId": "bearer:legacy-environment",
      "environmentId": "legacy-environment",
      "label": "Legacy environment",
      "httpBaseUrl": "https://legacy.example.test/",
      "wsBaseUrl": "wss://legacy.example.test/"
    }
  ],
  "credentials": [
    {
      "connectionId": "bearer:legacy-environment",
      "credential": {
        "_tag": "BearerConnectionCredential",
        "token": "legacy-token"
      }
    }
  ],
  "remoteDpopTokens": []
}`;

describe("connection catalog persistence lifecycle", () => {
  it.effect("preserves bearer query pairs across save, load, and metadata update", () =>
    Effect.gen(function* () {
      const target = new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Original environment",
        connectionId: CONNECTION_ID,
      });
      const profile = new BearerConnectionProfile({
        connectionId: CONNECTION_ID,
        environmentId: ENVIRONMENT_ID,
        label: target.label,
        httpBaseUrl: "https://original.example.test/",
        wsBaseUrl: "wss://original.example.test/",
        queryParameters: QUERY_PARAMETERS,
      });
      const credential = new BearerConnectionCredential({ token: BEARER_TOKEN });
      const registration = new BearerConnectionRegistration({ target, profile, credential });

      const savedCatalogJson = yield* encodeConnectionCatalogDocument(
        registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, registration),
      );
      const loadedCatalog = yield* decodeConnectionCatalogDocument(savedCatalogJson);

      const loadedTarget = loadedCatalog.targets[0];
      if (loadedTarget === undefined || loadedTarget._tag !== "BearerConnectionTarget") {
        throw new Error("Expected a bearer target after loading the catalog.");
      }
      const loadedProfile = loadedCatalog.profiles[0];
      if (loadedProfile === undefined || loadedProfile._tag !== "BearerConnectionProfile") {
        throw new Error("Expected a bearer profile after loading the catalog.");
      }
      const loadedCredentialEntry = loadedCatalog.credentials[0];
      if (loadedCredentialEntry === undefined) {
        throw new Error("Expected a bearer credential after loading the catalog.");
      }
      const loadedCredential = loadedCredentialEntry.credential;
      if (loadedCredential._tag !== "BearerConnectionCredential") {
        throw new Error("Expected a bearer credential after loading the catalog.");
      }

      expect(loadedTarget.environmentId).toBe(ENVIRONMENT_ID);
      expect(loadedTarget.connectionId).toBe(CONNECTION_ID);
      expect(loadedProfile.environmentId).toBe(ENVIRONMENT_ID);
      expect(loadedProfile.connectionId).toBe(CONNECTION_ID);
      expect(loadedProfile.httpBaseUrl).toBe("https://original.example.test/");
      expect(loadedProfile.wsBaseUrl).toBe("wss://original.example.test/");
      expect(loadedProfile.queryParameters).toEqual(QUERY_PARAMETERS);
      expect(loadedCredentialEntry.connectionId).toBe(CONNECTION_ID);
      expect(loadedCredential.token).toBe(BEARER_TOKEN);

      const updatedRegistration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId: ENVIRONMENT_ID,
          label: "  Updated environment  ",
          httpBaseUrl: "https://updated.example.test/new-path?discarded=from-base",
        },
        entry: Option.some({
          target: loadedTarget,
          profile: Option.some(loadedProfile),
          enabled: true,
        }),
        credential: Option.some(loadedCredential),
      });
      const updatedCatalog = registerConnectionInCatalog(loadedCatalog, updatedRegistration);
      const reloadedCatalog = yield* decodeConnectionCatalogDocument(
        yield* encodeConnectionCatalogDocument(updatedCatalog),
      );

      expect(reloadedCatalog.targets).toHaveLength(1);
      expect(reloadedCatalog.profiles).toHaveLength(1);
      expect(reloadedCatalog.credentials).toHaveLength(1);

      const reloadedTarget = reloadedCatalog.targets[0];
      if (reloadedTarget === undefined || reloadedTarget._tag !== "BearerConnectionTarget") {
        throw new Error("Expected one bearer target after updating the catalog.");
      }
      const reloadedProfile = reloadedCatalog.profiles[0];
      if (reloadedProfile === undefined || reloadedProfile._tag !== "BearerConnectionProfile") {
        throw new Error("Expected one bearer profile after updating the catalog.");
      }
      const reloadedCredentialEntry = reloadedCatalog.credentials[0];
      if (reloadedCredentialEntry === undefined) {
        throw new Error("Expected one bearer credential after updating the catalog.");
      }
      const reloadedCredential = reloadedCredentialEntry.credential;
      if (reloadedCredential._tag !== "BearerConnectionCredential") {
        throw new Error("Expected one bearer credential after updating the catalog.");
      }

      expect(reloadedTarget.environmentId).toBe(ENVIRONMENT_ID);
      expect(reloadedTarget.connectionId).toBe(CONNECTION_ID);
      expect(reloadedTarget.label).toBe("Updated environment");
      expect(reloadedProfile.environmentId).toBe(ENVIRONMENT_ID);
      expect(reloadedProfile.connectionId).toBe(CONNECTION_ID);
      expect(reloadedProfile.label).toBe("Updated environment");
      expect(reloadedProfile.httpBaseUrl).toBe("https://updated.example.test/");
      expect(reloadedProfile.wsBaseUrl).toBe("wss://updated.example.test/");
      expect(reloadedProfile.queryParameters).toEqual(QUERY_PARAMETERS);
      expect(reloadedCredentialEntry.connectionId).toBe(CONNECTION_ID);
      expect(reloadedCredential.token).toBe(BEARER_TOKEN);
    }),
  );

  it.effect("loads a legacy bearer profile without query parameters", () =>
    Effect.gen(function* () {
      const loadedCatalog = yield* decodeConnectionCatalogDocument(LEGACY_CATALOG_JSON);

      expect(loadedCatalog.schemaVersion).toBe(1);
      expect(loadedCatalog.targets).toHaveLength(1);
      expect(loadedCatalog.profiles).toHaveLength(1);
      expect(loadedCatalog.credentials).toHaveLength(1);

      const target = loadedCatalog.targets[0];
      if (target === undefined || target._tag !== "BearerConnectionTarget") {
        throw new Error("Expected the legacy catalog to contain a bearer target.");
      }
      const profile = loadedCatalog.profiles[0];
      if (profile === undefined || profile._tag !== "BearerConnectionProfile") {
        throw new Error("Expected the legacy catalog to contain a bearer profile.");
      }
      const credentialEntry = loadedCatalog.credentials[0];
      if (credentialEntry === undefined) {
        throw new Error("Expected the legacy catalog to contain a bearer credential.");
      }
      const credential = credentialEntry.credential;
      if (credential._tag !== "BearerConnectionCredential") {
        throw new Error("Expected the legacy catalog to contain a bearer credential.");
      }

      expect(target.environmentId).toBe(LEGACY_ENVIRONMENT_ID);
      expect(target.connectionId).toBe(LEGACY_CONNECTION_ID);
      expect(profile.environmentId).toBe(LEGACY_ENVIRONMENT_ID);
      expect(profile.connectionId).toBe(LEGACY_CONNECTION_ID);
      expect(profile.queryParameters).toEqual([]);
      expect(credentialEntry.connectionId).toBe(LEGACY_CONNECTION_ID);
      expect(credential.token).toBe("legacy-token");
    }),
  );
});
