import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyRemotePairingUrlToFields,
  getRemotePairingUrlFields,
  isEditableRemoteBearerConnection,
  resolveRemoteConnectionFields,
  type RemoteConnectionFieldsValue,
} from "./remoteConnectionForm";

const baseFields: RemoteConnectionFieldsValue = {
  host: "backend.example.com",
  pairingCode: "PAIRCODE",
  queryParameters: [{ key: "existing", value: "value" }],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("remote connection field transformations", () => {
  it("fills host, pairing code, and ordered duplicate parameters from a direct pairing URL", () => {
    expect(
      applyRemotePairingUrlToFields(
        baseFields,
        "https://remote.example.com/pair?tag=one&tag=two#token=pairing-token",
      ),
    ).toEqual({
      host: "https://remote.example.com",
      pairingCode: "pairing-token",
      queryParameters: [
        { key: "tag", value: "one" },
        { key: "tag", value: "two" },
      ],
    });
  });

  it("uses only nested host parameters when filling a hosted pairing URL", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    expect(
      applyRemotePairingUrlToFields(
        baseFields,
        "https://app.t3.codes/pair?host=https%3A%2F%2Fremote.example.com%2F%3Fproxy%3Done%26proxy%3Dtwo&outer=ignored#token=pairing-token",
      ),
    ).toEqual({
      host: "https://remote.example.com",
      pairingCode: "pairing-token",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("extracts nested backend pairs from a custom hosted app origin", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(
      applyRemotePairingUrlToFields(
        baseFields,
        "https://preview.t3.codes/pair?host=https%3A%2F%2Fremote.example.com%2F%3Fproxy%3Done%26proxy%3Dtwo#token=pairing-token",
      ),
    ).toEqual({
      host: "https://remote.example.com",
      pairingCode: "pairing-token",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("keeps a direct backend destination while preserving duplicate host routing pairs", () => {
    expect(
      applyRemotePairingUrlToFields(
        baseFields,
        "https://router.example.com/pair?host=one&host=two#token=pairing-token",
      ),
    ).toEqual({
      host: "https://router.example.com",
      pairingCode: "pairing-token",
      queryParameters: [
        { key: "host", value: "one" },
        { key: "host", value: "two" },
      ],
    });
  });

  it("accepts tokenless parameter URLs only through explicit paste handling", () => {
    const tokenlessUrl = "https://remote.example.com/pair?proxy=one&proxy=two";

    expect(applyRemotePairingUrlToFields(baseFields, tokenlessUrl)).toEqual({
      ...baseFields,
      host: tokenlessUrl,
    });
    expect(
      applyRemotePairingUrlToFields(baseFields, tokenlessUrl, { acceptTokenlessUrl: true }),
    ).toEqual({
      host: "https://remote.example.com",
      pairingCode: "PAIRCODE",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
    expect(getRemotePairingUrlFields(baseFields, "https://remote.example.com")).toBeNull();
  });

  it("retains duplicate routing pairs when a tokenless direct backend URL is pasted", () => {
    expect(
      applyRemotePairingUrlToFields(
        baseFields,
        "https://router.example.com/pair?host=one&host=two",
        { acceptTokenlessUrl: true },
      ),
    ).toEqual({
      host: "https://router.example.com",
      pairingCode: "PAIRCODE",
      queryParameters: [
        { key: "host", value: "one" },
        { key: "host", value: "two" },
      ],
    });
  });

  it("keeps the existing pairing code when an edit paste imports tokenless parameters", () => {
    expect(
      applyRemotePairingUrlToFields(
        { ...baseFields, pairingCode: "saved-access-token", queryParameters: [] },
        "https://remote.example.com/pair?proxy=one&proxy=two",
        { acceptTokenlessUrl: true, preservePairingCode: true },
      ),
    ).toEqual({
      host: "https://remote.example.com",
      pairingCode: "saved-access-token",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("keeps ordinary host edits as typed and keeps the saved token private", () => {
    expect(applyRemotePairingUrlToFields(baseFields, "new-backend.example.com")).toEqual({
      ...baseFields,
      host: "new-backend.example.com",
    });

    expect(
      applyRemotePairingUrlToFields(
        { ...baseFields, pairingCode: "" },
        "https://remote.example.com/pair?proxy=one#token=new-token",
        { preservePairingCode: true },
      ),
    ).toEqual({
      host: "https://remote.example.com",
      pairingCode: "",
      queryParameters: [{ key: "proxy", value: "one" }],
    });
  });

  it("lets an explicit empty row list clear URL query parameters", () => {
    expect(
      resolveRemoteConnectionFields({
        host: "https://remote.example.com?proxy=one&proxy=two",
        pairingCode: "pairing-token",
        queryParameters: [],
      }),
    ).toMatchObject({
      httpBaseUrl: "https://remote.example.com/",
      queryParameters: [],
    });
  });

  it("submits an empty list after imported rows are removed", () => {
    const imported = applyRemotePairingUrlToFields(
      baseFields,
      "https://remote.example.com/pair?proxy=one&proxy=two",
      { acceptTokenlessUrl: true },
    );

    expect(
      resolveRemoteConnectionFields({
        ...imported,
        queryParameters: [],
      }),
    ).toMatchObject({
      httpBaseUrl: "https://remote.example.com/",
      queryParameters: [],
    });
  });
});

const environmentId = EnvironmentId.make("remote-environment");

function bearerEntry(connectionId = "bearer:remote-environment"): ConnectionCatalogEntry {
  const target = new BearerConnectionTarget({
    environmentId,
    label: "Remote",
    connectionId,
  });
  return {
    target,
    enabled: true,
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId,
        label: "Remote",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        queryParameters: [],
      }),
    ),
  };
}

describe("isEditableRemoteBearerConnection", () => {
  it("allows an ordinary saved bearer connection", () => {
    expect(isEditableRemoteBearerConnection(bearerEntry())).toBe(true);
  });

  it("excludes desktop-local bearer, SSH, relay, and primary connections", () => {
    expect(isEditableRemoteBearerConnection(bearerEntry("local:wsl:Ubuntu"))).toBe(false);

    const sshTarget = new SshConnectionTarget({
      environmentId,
      label: "SSH",
      connectionId: "ssh:remote-environment",
    });
    const sshProfile = new SshConnectionProfile({
      connectionId: "ssh:remote-environment",
      environmentId,
      label: "SSH",
      target: { alias: "devbox", hostname: "devbox", username: null, port: null },
    });
    expect(
      isEditableRemoteBearerConnection({
        target: sshTarget,
        profile: Option.some(sshProfile),
        enabled: true,
      }),
    ).toBe(false);

    const relayTarget = new RelayConnectionTarget({ environmentId, label: "Relay" });
    expect(
      isEditableRemoteBearerConnection({
        target: relayTarget,
        profile: Option.none(),
        enabled: true,
      }),
    ).toBe(false);

    const primaryTarget = new PrimaryConnectionTarget({
      environmentId,
      label: "Primary",
      httpBaseUrl: "http://127.0.0.1:4780/",
      wsBaseUrl: "ws://127.0.0.1:4780/",
    });
    expect(
      isEditableRemoteBearerConnection({
        target: primaryTarget,
        profile: Option.none(),
        enabled: true,
      }),
    ).toBe(false);
  });
});
