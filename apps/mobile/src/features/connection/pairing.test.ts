import { AuthStandardClientScopes, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import type { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";
import {
  RemoteQueryParameterKeyMissingError,
  RemoteQueryParameterReservedError,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  buildPairingConnectionInput,
  buildPairingUrl,
  extractPairingUrlFromQrPayload,
  pairingConnectionInputFromUrl,
  PairingQrPayloadEmptyError,
  parsePairingUrl,
} from "./pairing";
import { ClientPresentation } from "../../../../../packages/client-runtime/src/platform/capabilities.ts";
import { layerRemoteHttpClient } from "../../../../../packages/client-runtime/src/rpc/http.ts";
import { preparePairingRegistration } from "../../../../../packages/client-runtime/src/connection/onboarding.ts";

const CLIENT_PRESENTATION_LAYER = Layer.succeed(
  ClientPresentation,
  ClientPresentation.of({
    metadata: {
      label: "T3 Code Test",
      deviceType: "desktop",
      os: "Test OS",
    },
  }),
);

function pairingHttpLayer(calls: Array<{ readonly url: string; readonly init: RequestInit }>) {
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const requestUrl = new URL(url);

    if (requestUrl.pathname === "/.well-known/t3/environment") {
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
          },
        }),
      );
    }

    if (requestUrl.pathname === "/oauth/token") {
      return Promise.resolve(
        Response.json({
          access_token: "bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: AuthStandardClientScopes.join(" "),
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  return layerRemoteHttpClient(fetchFn);
}

describe("buildPairingUrl", () => {
  it("uses HTTP for a schemeless IP address", () => {
    expect(buildPairingUrl("192.168.1.100:3773", "pairing-token")).toBe(
      "http://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("keeps HTTPS as the default for a schemeless hostname", () => {
    expect(buildPairingUrl("remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });

  it("preserves an explicit scheme for an IP address", () => {
    expect(buildPairingUrl("https://192.168.1.100:3773", "pairing-token")).toBe(
      "https://192.168.1.100:3773/#token=pairing-token",
    );
  });

  it("preserves existing host routing parameters when none are supplied", () => {
    expect(
      buildPairingUrl(
        "https://remote.example.com?route=one&token=old-token&route=two",
        "pairing-token",
      ),
    ).toBe("https://remote.example.com/?route=one&route=two#token=pairing-token");
  });

  it("clears existing host routing parameters with an explicit empty list", () => {
    expect(
      buildPairingUrl("https://remote.example.com?route=one&route=two", "pairing-token", []),
    ).toBe("https://remote.example.com/#token=pairing-token");
  });

  it("retains a direct URL credential when the separate code is empty", () => {
    expect(
      buildPairingUrl(
        "https://remote.example.com/pair?route=one&token=query-token#token=fragment-token",
        "",
      ),
    ).toBe("https://remote.example.com/?route=one#token=fragment-token");
  });

  it("normalizes hosted URLs to their backend and preserves nested routing parameters", () => {
    expect(
      buildPairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F%3Fproxy%3Done%26proxy%3Dtwo#token=pairing-token",
        "",
      ),
    ).toBe("https://desktop.tailnet.ts.net/?proxy=one&proxy=two#token=pairing-token");
  });

  it("clears nested hosted routing parameters with an explicit empty list", () => {
    expect(
      buildPairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F%3Fproxy%3Done%26proxy%3Dtwo#token=pairing-token",
        "",
        [],
      ),
    ).toBe("https://desktop.tailnet.ts.net/#token=pairing-token");
  });

  it("lets an explicit code replace a direct or hosted URL credential", () => {
    expect(
      buildPairingUrl("https://remote.example.com/pair?route=one#token=old-token", "new-token"),
    ).toBe("https://remote.example.com/?route=one#token=new-token");
    expect(
      buildPairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F%3Fproxy%3Done#token=old-token",
        "new-token",
      ),
    ).toBe("https://desktop.tailnet.ts.net/?proxy=one#token=new-token");
  });

  it("normalizes explicit query parameter rows without changing their order or values", () => {
    expect(
      buildPairingUrl("https://remote.example.com?old=one&old=two", "pairing-token", [
        { key: "  route  ", value: "one two" },
        { key: "", value: "" },
        { key: "route", value: "three" },
      ]),
    ).toBe("https://remote.example.com/?route=one+two&route=three#token=pairing-token");
  });

  it("rejects an explicit blank key when its value is not empty", () => {
    expect(() =>
      buildPairingUrl("https://remote.example.com", "pairing-token", [
        { key: "  ", value: "value" },
      ]),
    ).toThrowError(RemoteQueryParameterKeyMissingError);
  });

  it("rejects an explicit token query parameter", () => {
    expect(() =>
      buildPairingUrl("https://remote.example.com", "pairing-token", [
        { key: " token ", value: "query-token" },
      ]),
    ).toThrowError(RemoteQueryParameterReservedError);
  });

  it("keeps malformed raw hosts unchanged when their separate code is empty", () => {
    expect(buildPairingUrl("not a url", "")).toBe("not a url");
  });
});

describe("buildPairingConnectionInput", () => {
  it("returns normalized structured input for a plain IP host", () => {
    const input: ConnectionOnboarding.PairingConnectionInput = buildPairingConnectionInput(
      "192.168.1.100:3773",
      " pairing-token ",
      [
        { key: "  route  ", value: "one" },
        { key: "", value: "" },
      ],
    );

    expect(input).toEqual({
      host: "http://192.168.1.100:3773",
      pairingCode: "pairing-token",
      queryParameters: [{ key: "route", value: "one" }],
    });
    expect(input).not.toHaveProperty("pairingUrl");
  });

  it("extracts embedded credentials while allowing an explicit code override", () => {
    expect(
      buildPairingConnectionInput("https://backend.example/pair#token=embedded-token", ""),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "embedded-token",
      queryParameters: [],
    });
    expect(
      buildPairingConnectionInput("https://backend.example/pair#token=embedded-token", "new-token"),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "new-token",
      queryParameters: [],
    });
  });

  it("uses explicit query parameter rows, including an empty override", () => {
    const host = "https://backend.example/pair?route=one&token=pairing-token";

    expect(buildPairingConnectionInput(host, "")).toEqual({
      host: "https://backend.example",
      pairingCode: "pairing-token",
      queryParameters: [{ key: "route", value: "one" }],
    });
    expect(buildPairingConnectionInput(host, "", [])).toEqual({
      host: "https://backend.example",
      pairingCode: "pairing-token",
      queryParameters: [],
    });
  });

  it("builds structured input from a pairing URL", () => {
    expect(
      pairingConnectionInputFromUrl(
        "https://backend.example/pair?route=one&route=two#token=pairing-token",
      ),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "pairing-token",
      queryParameters: [
        { key: "route", value: "one" },
        { key: "route", value: "two" },
      ],
    });
  });

  it("keeps a host query parameter routed to the backend host", () => {
    const input: ConnectionOnboarding.PairingConnectionInput = buildPairingConnectionInput(
      "https://backend.example",
      "code",
      [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    );
    const target = resolveRemotePairingTarget(input);

    expect(target).toMatchObject({
      httpBaseUrl: "https://backend.example/",
      wsBaseUrl: "wss://backend.example/",
      credential: "code",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });
});

describe("buildPairingConnectionInput integration", () => {
  it.effect("prepares discovery and bootstrap requests against the backend host", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const input = buildPairingConnectionInput("https://backend.example", "code", [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ]);

      const registration = yield* preparePairingRegistration(input).pipe(
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))),
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://backend.example/.well-known/t3/environment?host=router.example&host=second",
        "https://backend.example/oauth/token?host=router.example&host=second",
      ]);
      expect(calls.every((call) => new URL(call.url).hostname === "backend.example")).toBe(true);
      expect(registration.profile.queryParameters).toEqual([
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ]);
    }),
  );
});

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(PairingQrPayloadEmptyError);
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrowError(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("reads hosted pairing links into backend host fields", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
      queryParameters: [],
    });
  });

  it("round-trips duplicate query parameters without treating the token as one", () => {
    const pairingUrl = buildPairingUrl("https://remote.example.com", "pairing-token", [
      { key: "tag", value: "a b" },
      { key: "tag", value: "two" },
    ]);

    expect(parsePairingUrl(pairingUrl)).toEqual({
      host: "https://remote.example.com",
      code: "pairing-token",
      queryParameters: [
        { key: "tag", value: "a b" },
        { key: "tag", value: "two" },
      ],
    });
  });

  it("retains routing parameters from the nested host in hosted pairing links", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%2F%3Fproxy%3Done%26proxy%3Dtwo#token=pairing-token",
      ),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net",
      code: "pairing-token",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("keeps query routing pairs separate from query and fragment credentials", () => {
    expect(
      parsePairingUrl(
        "https://remote.example.com/pair?route=one&token=query-token&route=two#token=fragment-token",
      ),
    ).toEqual({
      host: "https://remote.example.com",
      code: "fragment-token",
      queryParameters: [
        { key: "route", value: "one" },
        { key: "route", value: "two" },
      ],
    });
  });

  it("infers HTTP for schemeless IPv4 and IPv6 pairing URLs", () => {
    expect(parsePairingUrl("192.168.1.100:3773?route=one#token=pairing-token")).toEqual({
      host: "http://192.168.1.100:3773",
      code: "pairing-token",
      queryParameters: [{ key: "route", value: "one" }],
    });
    expect(parsePairingUrl("[fd00::1]:3773#token=pairing-token")).toEqual({
      host: "http://[fd00::1]:3773",
      code: "pairing-token",
      queryParameters: [],
    });
  });

  it("keeps HTTPS for a schemeless hostname pairing URL", () => {
    expect(parsePairingUrl("remote.example.com:3773#token=pairing-token")).toEqual({
      host: "https://remote.example.com:3773",
      code: "pairing-token",
      queryParameters: [],
    });
  });

  it("falls back to raw text for an unparseable host", () => {
    expect(parsePairingUrl("not a pairing URL")).toEqual({
      host: "not a pairing URL",
      code: "",
      queryParameters: [],
    });
  });
});
