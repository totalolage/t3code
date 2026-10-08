import { describe, expect, it } from "vite-plus/test";

import {
  RemoteBackendUrlInvalidError,
  RemoteBackendUrlMissingError,
  RemotePairingTokenMissingError,
  RemotePairingUrlInvalidError,
  RemoteQueryParameterKeyMissingError,
  RemoteQueryParameterReservedError,
  mergeRemoteQueryParameters,
  normalizeRemoteQueryParameters,
  parseRemotePairingUrlFields,
  resolveRemotePairingTarget,
} from "./remote.ts";

describe("remote", () => {
  it("parses direct pairing URLs into a query-free host and ordered parameters", () => {
    expect(
      parseRemotePairingUrlFields(
        "https://remote.example.com/pair?tag=one&token=search-token&tag=two#token=hash-token",
      ),
    ).toEqual({
      host: "https://remote.example.com",
      pairingCode: "hash-token",
      queryParameters: [
        { key: "tag", value: "one" },
        { key: "tag", value: "two" },
      ],
    });
  });

  it("keeps direct host query parameters separate from hosted metadata", () => {
    expect(
      parseRemotePairingUrlFields(
        "https://backend.example/?host=router.example&host=second#token=x",
      ),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "x",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });

  it("treats an untrusted /pair path as a direct backend URL", () => {
    expect(
      parseRemotePairingUrlFields(
        "https://backend.example/pair?host=router.example&host=second#token=x",
      ),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "x",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });

  it("parses hosted pairing URLs from the nested host query", () => {
    expect(
      parseRemotePairingUrlFields(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fremote.example.com%2F%3Fproxy%3Done%26proxy%3Dtwo&label=Remote&outer=ignored#token=pairing-token",
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

  it("accepts a configured hosted origin for nested pairing parameters", () => {
    expect(
      parseRemotePairingUrlFields(
        "https://preview.t3.codes/pair?host=https%3A%2F%2Fremote.example.com%2F%3Fproxy%3Done%26proxy%3Dtwo#token=pairing-token",
        { hostedAppUrl: "https://preview.t3.codes" },
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

  it("treats the default hosted origin on a non-pair path as direct", () => {
    expect(
      parseRemotePairingUrlFields(
        "https://app.t3.codes/not-pair?host=router.example&host=second#token=x",
      ),
    ).toEqual({
      host: "https://app.t3.codes",
      pairingCode: "x",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });

  it("normalizes query parameter keys without changing values", () => {
    expect(
      normalizeRemoteQueryParameters([
        { key: "  proxy  ", value: "  value  " },
        { key: "", value: "" },
      ]),
    ).toEqual([{ key: "proxy", value: "  value  " }]);

    let emptyKeyError: unknown;
    try {
      normalizeRemoteQueryParameters([{ key: "\t", value: "value" }]);
    } catch (cause) {
      emptyKeyError = cause;
    }
    expect(emptyKeyError).toBeInstanceOf(RemoteQueryParameterKeyMissingError);
    expect(emptyKeyError).toMatchObject({ index: 0 });

    let reservedKeyError: unknown;
    try {
      normalizeRemoteQueryParameters([{ key: "  token  ", value: "value" }]);
    } catch (cause) {
      reservedKeyError = cause;
    }
    expect(reservedKeyError).toBeInstanceOf(RemoteQueryParameterReservedError);
    expect(reservedKeyError).toMatchObject({ key: "token" });
  });

  it("merges parameters after service-owned route parameters", () => {
    expect(
      mergeRemoteQueryParameters(
        "https://remote.example.com/ws?route=keep&owned=service#fragment",
        [
          { key: "owned", value: "configured" },
          { key: "tag", value: "one two" },
          { key: "tag", value: "three" },
          { key: "token", value: "must-not-leak" },
        ],
      ),
    ).toBe("https://remote.example.com/ws?route=keep&owned=service&tag=one+two&tag=three#fragment");
  });

  it("derives backend urls and token from a pairing url", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [],
    });
  });

  it("preserves duplicate host query parameters on a direct pairing URL", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://backend.example/?host=router.example&host=second#token=x",
      }),
    ).toEqual({
      credential: "x",
      httpBaseUrl: "https://backend.example/",
      wsBaseUrl: "wss://backend.example/",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });

  it("keeps an untrusted /pair URL on its direct backend route", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://backend.example/pair?host=router.example&host=second#token=x",
      }),
    ).toEqual({
      credential: "x",
      httpBaseUrl: "https://backend.example/",
      wsBaseUrl: "wss://backend.example/",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });

  it("accepts pairing urls that still use a query token", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair?token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [],
    });
  });

  it("preserves ordered duplicate query parameters from a direct pairing URL", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://remote.example.com/pair?token=pairing-token&tag=one&tag=two&empty=",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [
        { key: "tag", value: "one" },
        { key: "tag", value: "two" },
        { key: "empty", value: "" },
      ],
    });
  });

  it("derives backend urls from hosted app pairing links", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://desktop.tailnet.ts.net:44342/",
      wsBaseUrl: "wss://desktop.tailnet.ts.net:44342/",
      queryParameters: [],
    });
  });

  it("uses nested hosted query parameters instead of outer host metadata", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F%3Fproxy%3Done%26proxy%3Dtwo&label=Remote&outer=ignored#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://desktop.tailnet.ts.net:44342/",
      wsBaseUrl: "wss://desktop.tailnet.ts.net:44342/",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("uses nested parameters for an explicitly configured hosted origin", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl:
          "https://preview.t3.codes/pair?host=https%3A%2F%2Fremote.example.com%2F%3Fproxy%3Done%26proxy%3Dtwo#token=pairing-token",
        hostedAppUrl: "https://preview.t3.codes",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ],
    });
  });

  it("treats the default hosted origin on a non-pair path as direct", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://app.t3.codes/not-pair?host=router.example&host=second#token=x",
      }),
    ).toEqual({
      credential: "x",
      httpBaseUrl: "https://app.t3.codes/",
      wsBaseUrl: "wss://app.t3.codes/",
      queryParameters: [
        { key: "host", value: "router.example" },
        { key: "host", value: "second" },
      ],
    });
  });

  it("allows an explicit empty query parameter override", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://remote.example.com?proxy=one&proxy=two",
        pairingCode: "pairing-token",
        queryParameters: [],
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [],
    });
  });

  it("derives backend urls from a host and pairing code", () => {
    expect(
      resolveRemotePairingTarget({
        host: "https://remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [],
    });
  });

  it("parses protocol-relative pairing URLs without a window base", () => {
    expect(
      parseRemotePairingUrlFields("//backend.example/pair?route=one&route=two#token=code"),
    ).toEqual({
      host: "https://backend.example",
      pairingCode: "code",
      queryParameters: [
        { key: "route", value: "one" },
        { key: "route", value: "two" },
      ],
    });
  });

  it("treats a protocol-relative host as https", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//remote.example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [],
    });
  });

  it("preserves the port when normalizing a protocol-relative host", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//remote.example.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com:3000/",
      wsBaseUrl: "wss://remote.example.com:3000/",
      queryParameters: [],
    });
  });

  it("normalizes a protocol-relative host from a hosted pairing link", () => {
    expect(
      resolveRemotePairingTarget({
        pairingUrl: "https://app.t3.codes/pair?host=%2F%2Fremote.example.com#token=pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      queryParameters: [],
    });
  });

  it("collapses extra leading slashes instead of producing an empty host", () => {
    expect(
      resolveRemotePairingTarget({
        host: "///example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
      queryParameters: [],
    });
  });

  it("does not double-prepend https when the host already carries a scheme", () => {
    expect(
      resolveRemotePairingTarget({
        host: "//https://example.com",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://example.com/",
      wsBaseUrl: "wss://example.com/",
      queryParameters: [],
    });
  });

  it("preserves host ports when normalizing a bare host input", () => {
    expect(
      resolveRemotePairingTarget({
        host: "myserver.com:3000",
        pairingCode: "pairing-token",
      }),
    ).toEqual({
      credential: "pairing-token",
      httpBaseUrl: "https://myserver.com:3000/",
      wsBaseUrl: "wss://myserver.com:3000/",
      queryParameters: [],
    });
  });

  it("rejects unsupported direct pairing URL protocols", () => {
    let pairingUrlError: unknown;
    try {
      resolveRemotePairingTarget({
        pairingUrl: "ftp://remote.example.com/pair#token=pairing-token",
      });
    } catch (cause) {
      pairingUrlError = cause;
    }

    expect(pairingUrlError).toBeInstanceOf(RemotePairingUrlInvalidError);
    expect(pairingUrlError).toMatchObject({ protocol: "ftp:" });
    expect((pairingUrlError as RemotePairingUrlInvalidError).cause).toBeUndefined();
  });

  it("rejects unsupported hosted pairing backend protocols", () => {
    let hostError: unknown;
    try {
      resolveRemotePairingTarget({
        pairingUrl:
          "https://app.t3.codes/pair?host=ftp%3A%2F%2Fremote.example.com#token=pairing-token",
      });
    } catch (cause) {
      hostError = cause;
    }

    expect(hostError).toBeInstanceOf(RemoteBackendUrlInvalidError);
    expect(hostError).toMatchObject({ source: "hosted-pairing-host", protocol: "ftp:" });
    expect((hostError as RemoteBackendUrlInvalidError).cause).toBeUndefined();
  });

  it("rejects unsupported direct host protocols", () => {
    let hostError: unknown;
    try {
      resolveRemotePairingTarget({
        host: "ftp://remote.example.com",
        pairingCode: "pairing-token",
      });
    } catch (cause) {
      hostError = cause;
    }

    expect(hostError).toBeInstanceOf(RemoteBackendUrlInvalidError);
    expect(hostError).toMatchObject({ source: "direct-host", protocol: "ftp:" });
    expect((hostError as RemoteBackendUrlInvalidError).cause).toBeUndefined();
  });

  it("uses distinct structural errors for missing pairing inputs", () => {
    expect(() => resolveRemotePairingTarget({})).toThrowError(RemoteBackendUrlMissingError);
    expect(() =>
      resolveRemotePairingTarget({ pairingUrl: "https://remote.example.com/pair" }),
    ).toThrowError(RemotePairingTokenMissingError);
    expect(() =>
      resolveRemotePairingTarget({
        host: "https://user:secret@remote.example.com/path?token=sensitive#fragment",
      }),
    ).toThrowError(
      expect.objectContaining({
        _tag: "RemotePairingCodeMissingError",
        host: "remote.example.com",
      }),
    );
  });

  it("preserves URL parsing causes with their input source", () => {
    let pairingUrlError: unknown;
    try {
      resolveRemotePairingTarget({ pairingUrl: "not a url" });
    } catch (cause) {
      pairingUrlError = cause;
    }
    expect(pairingUrlError).toBeInstanceOf(RemotePairingUrlInvalidError);
    expect((pairingUrlError as RemotePairingUrlInvalidError).cause).toBeInstanceOf(TypeError);

    let hostError: unknown;
    try {
      resolveRemotePairingTarget({ host: "https://[invalid", pairingCode: "pairing-token" });
    } catch (cause) {
      hostError = cause;
    }
    expect(hostError).toBeInstanceOf(RemoteBackendUrlInvalidError);
    expect(hostError).toMatchObject({ source: "direct-host" });
    expect((hostError as RemoteBackendUrlInvalidError).cause).toBeInstanceOf(TypeError);
  });
});
