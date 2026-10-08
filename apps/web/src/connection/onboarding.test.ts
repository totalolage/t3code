import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolvePairingCommandInput } from "./onboarding";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolvePairingCommandInput", () => {
  it("converts a configured-hosted /pair link into the nested backend target", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(
      resolvePairingCommandInput({
        pairingUrl:
          "https://preview.t3.codes/pair?host=https%3A%2F%2Fbackend.example%2F%3Froute%3Done%26route%3Dtwo#token=code",
      }),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "code",
      queryParameters: [
        { key: "route", value: "one" },
        { key: "route", value: "two" },
      ],
    });
  });

  it("converts a default-hosted /pair link without configuration", () => {
    expect(
      resolvePairingCommandInput({
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=code",
      }),
    ).toEqual({
      host: "https://desktop.tailnet.ts.net:44342",
      pairingCode: "code",
      queryParameters: [],
    });
  });

  it("resolves a default-origin link as direct when a custom origin is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const input = resolvePairingCommandInput({
      pairingUrl: "https://app.t3.codes/pair?host=router.example&host=second#token=code",
    });
    expect("pairingUrl" in input).toBe(false);
    expect(input).toEqual({
      host: "https://app.t3.codes",
      pairingCode: "code",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });

  it("lets explicit query parameters override URL-derived ones", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");
    const hostedUrl =
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fbackend.example%2F%3Froute%3Done%26route%3Dtwo#token=code";

    expect(
      resolvePairingCommandInput({ pairingUrl: hostedUrl, queryParameters: [] }),
    ).toMatchObject({ host: "https://backend.example", pairingCode: "code", queryParameters: [] });

    expect(
      resolvePairingCommandInput({
        pairingUrl: hostedUrl,
        queryParameters: [{ key: "route", value: "x" }],
      }),
    ).toMatchObject({
      host: "https://backend.example",
      pairingCode: "code",
      queryParameters: [{ key: "route", value: "x" }],
    });
  });

  it("resolves direct backend pairing links into structured targets", () => {
    expect(
      resolvePairingCommandInput({
        pairingUrl:
          "https://backend.example/pair?route=one&route=two&token=search-token#token=code",
      }),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "code",
      queryParameters: [
        { key: "route", value: "one" },
        { key: "route", value: "two" },
      ],
    });

    expect(
      resolvePairingCommandInput({
        pairingUrl: "https://router.example/pair?host=one&host=two#token=code",
      }),
    ).toEqual({
      host: "https://router.example",
      pairingCode: "code",
      queryParameters: [
        { key: "host", value: "one" },
        { key: "host", value: "two" },
      ],
    });
  });

  it("keeps an explicit pairing code when the parsed link carries no token", () => {
    expect(
      resolvePairingCommandInput({ pairingUrl: "backend.example", pairingCode: "typed-code" }),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "typed-code",
      queryParameters: [],
    });
  });

  it("passes malformed input through for the runtime to report", () => {
    expect(resolvePairingCommandInput({ pairingUrl: "not a url" })).toEqual({
      pairingUrl: "not a url",
    });
    expect(resolvePairingCommandInput({ host: "backend.example", pairingCode: "code" })).toEqual({
      host: "backend.example",
      pairingCode: "code",
    });
  });
});
