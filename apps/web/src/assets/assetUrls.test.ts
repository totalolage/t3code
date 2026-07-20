import { describe, expect, it } from "vite-plus/test";

import { resolveAssetUrl } from "./assetUrls";

describe("resolveAssetUrl", () => {
  it("resolves an environment-relative asset URL", () => {
    expect(
      resolveAssetUrl("https://environment.example/base/", "/api/assets/signed-token/favicon.png"),
    ).toBe("https://environment.example/api/assets/signed-token/favicon.png");
  });

  it("rejects an invalid environment base URL", () => {
    expect(resolveAssetUrl("not a URL", "/api/assets/signed-token/favicon.png")).toBeNull();
  });

  it("appends ordered connection parameters after signed asset parameters", () => {
    expect(
      resolveAssetUrl("https://environment.example/", "/api/assets/file.png?signed=asset-token", [
        { key: "proxy", value: "one" },
        { key: "proxy", value: "two" },
      ]),
    ).toBe(
      "https://environment.example/api/assets/file.png?signed=asset-token&proxy=one&proxy=two",
    );
  });
});
