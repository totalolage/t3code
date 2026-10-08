import { describe, expect, it } from "vite-plus/test";

import { resolveNativeAssetUrl } from "./nativeAssetUrl";

const baseUrl = "https://environment.example/root/";

describe("resolveNativeAssetUrl", () => {
  it.each([
    [
      "uploads/file.bin?ticket=upload-ticket#upload",
      "https://environment.example/root/uploads/file.bin?ticket=upload-ticket&client=mobile#upload",
    ],
    [
      "context/file.txt?path=src%2Fmain.ts#context",
      "https://environment.example/root/context/file.txt?path=src%2Fmain.ts&client=mobile#context",
    ],
    [
      "assets/image.png#asset",
      "https://environment.example/root/assets/image.png?client=mobile#asset",
    ],
  ])("resolves relative upload, context, and asset URLs: %s", (relativeUrl, expected) => {
    expect(
      resolveNativeAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [{ key: "client", value: "mobile" }],
        },
        relativeUrl,
      ),
    ).toBe(expected);
  });

  it("preserves service-owned query parameters and the fragment over config collisions", () => {
    expect(
      resolveNativeAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [
            { key: "ticket", value: "config-ticket" },
            { key: "path", value: "config-path" },
            { key: "client", value: "mobile" },
          ],
        },
        "assets/file.bin?ticket=service-ticket&path=service-path#download",
      ),
    ).toBe(
      "https://environment.example/root/assets/file.bin?ticket=service-ticket&path=service-path&client=mobile#download",
    );
  });

  it("keeps duplicate config parameters in their original order", () => {
    expect(
      resolveNativeAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [
            { key: "tag", value: "first" },
            { key: "tag", value: "second" },
            { key: "empty", value: "" },
          ],
        },
        "assets/file.bin#asset",
      ),
    ).toBe("https://environment.example/root/assets/file.bin?tag=first&tag=second&empty=#asset");
  });

  it("does not copy the pairing token into an asset URL", () => {
    expect(
      resolveNativeAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [
            { key: "token", value: "must-not-leak" },
            { key: "client", value: "mobile" },
          ],
        },
        "assets/file.bin",
      ),
    ).toBe("https://environment.example/root/assets/file.bin?client=mobile");
  });

  it.each([
    ["primary", "https://primary.example/", "uploads/file.bin?ticket=t#upload"],
    ["relay", "https://relay.example/", "assets/file.bin?path=p#asset"],
  ])(
    "leaves a %s URL unchanged when it has no config parameters",
    (_kind, httpBaseUrl, relativeUrl) => {
      expect(resolveNativeAssetUrl({ httpBaseUrl }, relativeUrl)).toBe(
        new URL(relativeUrl, httpBaseUrl).toString(),
      );
    },
  );

  it.each([
    [
      "other-origin",
      "https://cdn.example/external.png?ticket=service#asset",
      "https://cdn.example/external.png?ticket=service#asset",
    ],
    [
      "protocol-relative external",
      "//cdn.example/external.png?ticket=service#asset",
      "https://cdn.example/external.png?ticket=service#asset",
    ],
    ["data", "data:image/png;base64,ZmFrZQ==", "data:image/png;base64,ZmFrZQ=="],
  ])("does not merge config parameters into %s URLs", (_kind, relativeUrl, expected) => {
    expect(
      resolveNativeAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [{ key: "client", value: "mobile" }],
        },
        relativeUrl,
      ),
    ).toBe(expected);
  });

  it.each([
    ["invalid relative URL", baseUrl, "https://[invalid"],
    ["invalid base URL", "not a URL", "assets/file.bin"],
  ])("returns null for an %s", (_kind, httpBaseUrl, relativeUrl) => {
    expect(resolveNativeAssetUrl({ httpBaseUrl }, relativeUrl)).toBeNull();
  });

  it("uses updated connection inputs for each resolution", () => {
    const relativeUrl = "assets/file.bin#asset";
    expect(
      resolveNativeAssetUrl(
        {
          httpBaseUrl: "https://first.example/",
          queryParameters: [{ key: "client", value: "first" }],
        },
        relativeUrl,
      ),
    ).toBe("https://first.example/assets/file.bin?client=first#asset");
    expect(
      resolveNativeAssetUrl(
        {
          httpBaseUrl: "https://second.example/",
          queryParameters: [{ key: "client", value: "second" }],
        },
        relativeUrl,
      ),
    ).toBe("https://second.example/assets/file.bin?client=second#asset");
  });
});
