import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BearerConnectionProfile, ConnectionProfile } from "./catalog.ts";

const LEGACY_PROFILE = {
  _tag: "BearerConnectionProfile" as const,
  connectionId: "bearer:legacy-environment",
  environmentId: "legacy-environment",
  label: "Legacy environment",
  httpBaseUrl: "https://legacy.example.test/",
  wsBaseUrl: "wss://legacy.example.test/",
  queryParameters: [
    { key: "  proxy  ", value: "first" },
    { key: "proxy", value: "second" },
    { key: "token", value: "legacy-token" },
  ],
};

const decodeConnectionProfile = Schema.decodeUnknownSync(ConnectionProfile);
const decodeBearerConnectionProfile = Schema.decodeUnknownSync(BearerConnectionProfile);

describe("connection catalog", () => {
  it("decodes legacy bearer profiles without changing their IDs or query pairs", () => {
    const decoded = decodeConnectionProfile(LEGACY_PROFILE);

    expect(decoded).toEqual(LEGACY_PROFILE);
    expect(decoded).toMatchObject({
      connectionId: "bearer:legacy-environment",
      environmentId: "legacy-environment",
      queryParameters: LEGACY_PROFILE.queryParameters,
    });
  });

  it("defaults missing bearer query parameters on decode and construction", () => {
    const input = {
      _tag: LEGACY_PROFILE._tag,
      connectionId: LEGACY_PROFILE.connectionId,
      environmentId: EnvironmentId.make(LEGACY_PROFILE.environmentId),
      label: LEGACY_PROFILE.label,
      httpBaseUrl: LEGACY_PROFILE.httpBaseUrl,
      wsBaseUrl: LEGACY_PROFILE.wsBaseUrl,
    };

    expect(decodeBearerConnectionProfile(input).queryParameters).toEqual([]);
    expect(new BearerConnectionProfile(input).queryParameters).toEqual([]);
  });
});
