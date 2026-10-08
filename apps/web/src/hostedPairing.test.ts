import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedChannelSelectionUrl,
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  isHostedStaticApp,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not classify direct backend host routing URLs as hosted pairing", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const directBackendUrl = new URL(
      "https://backend.example.com/pair?host=router&host=second#token=ABCD1234",
    );
    const wrongPathUrl = new URL("https://app.t3.codes/connect?host=router&token=ABCD1234");

    expect(readHostedPairingRequest(directBackendUrl)).toBeNull();
    expect(hasHostedPairingRequest(directBackendUrl)).toBe(false);
    expect(readHostedPairingRequest(wrongPathUrl)).toBeNull();
    expect(hasHostedPairingRequest(wrongPathUrl)).toBe(false);
  });

  it("extracts nested pairs from the configured hosted origin and exact pair path", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const url = new URL(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fbackend.example.com%2F%3Fproxy%3Done%26proxy%3Dtwo#token=ABCD1234",
    );

    expect(readHostedPairingRequest(url)).toEqual({
      host: "https://backend.example.com",
      token: "ABCD1234",
      label: "",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("reads a normalized hosted host and repeated nested query parameters", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const url = new URL(
      "https://app.t3.codes/pair?host=https%3A%2F%2F100.64.1.2%3A3773%2F%3Fproxy%3Done%26proxy%3Dtwo&token=ABCD1234",
    );

    expect(readHostedPairingRequest(url)).toEqual({
      host: "https://100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("excludes outer hosted-page metadata from backend query parameters", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const url = new URL(
      "https://app.t3.codes/pair?host=https%3A%2F%2Fbackend.example.com%2F%3Fproxy%3Done%26proxy%3Dtwo&label=Workstation&outer=ignored&token=search-token#token=ABCD1234",
    );

    expect(readHostedPairingRequest(url)).toEqual({
      host: "https://backend.example.com",
      token: "ABCD1234",
      label: "Workstation",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("keeps legacy hosted links without backend query parameters", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const url = new URL("https://app.t3.codes/pair?host=backend.example.com%3A3773#token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "https://backend.example.com:3773",
      token: "ABCD1234",
      label: "",
      queryParameters: [],
    });
  });

  it("rejects hosted links with an invalid nested backend host", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const url = new URL(
      "https://app.t3.codes/pair?host=https%3A%2F%2F%5Binvalid&label=Workstation&outer=ignored#token=ABCD1234",
    );

    expect(readHostedPairingRequest(url)).toBeNull();
    expect(hasHostedPairingRequest(url)).toBe(false);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }),
    );

    expect(url.origin).toBe("https://preview.t3.codes");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("builds hosted channel selection URLs through the configured router origin", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    const url = new URL(
      buildHostedChannelSelectionUrl({
        channel: "nightly",
      }),
    );

    expect(url.origin).toBe("https://app.t3.codes");
    expect(url.pathname).toBe("/__t3code/channel");
    expect(url.searchParams.get("channel")).toBe("nightly");
    expect(url.searchParams.has("next")).toBe(false);
  });

  it("ignores incomplete hosted pairing requests", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");

    expect(
      hasHostedPairingRequest(new URL("https://app.t3.codes/pair?host=backend.example.com")),
    ).toBe(false);
    expect(hasHostedPairingRequest(new URL("https://app.t3.codes/pair?token=ABCD1234"))).toBe(
      false,
    );
  });

  it("detects the hosted static app only when no backend URL is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://preview.t3.codes/"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://preview.t3.codes/pair"))).toBe(true);
    expect(isHostedStaticApp(new URL("https://backend.example.com/"))).toBe(false);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://preview.t3.codes/"))).toBe(false);
  });

  it("detects hosted channel aliases as static apps", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://app.t3.codes");
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");
    vi.stubEnv("VITE_HTTP_URL", "");
    vi.stubEnv("VITE_WS_URL", "");

    expect(isHostedStaticApp(new URL("https://nightly.app.t3.codes/"))).toBe(true);

    vi.stubEnv("VITE_HTTP_URL", "https://backend.example.com");
    expect(isHostedStaticApp(new URL("https://nightly.app.t3.codes/"))).toBe(false);
  });
});
