import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import { assetUrlStateFromPreparedResult, resolvePreparedAssetUrl } from "./preparedAssetUrl";

const baseUrl = "https://environment.example/root/";

describe("resolvePreparedAssetUrl", () => {
  it("resolves relative upload, context, and asset URLs with config parameters", () => {
    expect(
      resolvePreparedAssetUrl(
        { httpBaseUrl: baseUrl, queryParameters: [{ key: "client", value: "web" }] },
        "uploads/file.bin?ticket=upload-ticket#upload",
      ),
    ).toBe(
      "https://environment.example/root/uploads/file.bin?ticket=upload-ticket&client=web#upload",
    );
    expect(
      resolvePreparedAssetUrl(
        { httpBaseUrl: baseUrl, queryParameters: [{ key: "client", value: "web" }] },
        "assets/image.png#asset",
      ),
    ).toBe("https://environment.example/root/assets/image.png?client=web#asset");
  });

  it("keeps duplicate config parameters in their original order", () => {
    expect(
      resolvePreparedAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [
            { key: "proxy", value: "a" },
            { key: "proxy", value: "b" },
          ],
        },
        "assets/file.bin#asset",
      ),
    ).toBe("https://environment.example/root/assets/file.bin?proxy=a&proxy=b#asset");
  });

  it("preserves service-owned query parameters and the fragment over config collisions", () => {
    expect(
      resolvePreparedAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [
            { key: "ticket", value: "config-ticket" },
            { key: "client", value: "web" },
          ],
        },
        "assets/file.bin?ticket=service-ticket#download",
      ),
    ).toBe(
      "https://environment.example/root/assets/file.bin?ticket=service-ticket&client=web#download",
    );
  });

  it("does not copy the pairing token into an asset URL", () => {
    expect(
      resolvePreparedAssetUrl(
        {
          httpBaseUrl: baseUrl,
          queryParameters: [
            { key: "token", value: "must-not-leak" },
            { key: "client", value: "web" },
          ],
        },
        "assets/file.bin",
      ),
    ).toBe("https://environment.example/root/assets/file.bin?client=web");
  });

  it.each([
    [
      "other-origin",
      "https://cdn.example/external.png?ticket=service#asset",
      "https://cdn.example/external.png?ticket=service#asset",
    ],
    ["data", "data:image/png;base64,ZmFrZQ==", "data:image/png;base64,ZmFrZQ=="],
  ])("does not merge config parameters into %s URLs", (_kind, relativeUrl, expected) => {
    expect(
      resolvePreparedAssetUrl(
        { httpBaseUrl: baseUrl, queryParameters: [{ key: "client", value: "web" }] },
        relativeUrl,
      ),
    ).toBe(expected);
  });

  it("returns the resolved URL unchanged when the connection has no parameters", () => {
    expect(resolvePreparedAssetUrl({ httpBaseUrl: baseUrl }, "assets/file.bin")).toBe(
      new URL("assets/file.bin", baseUrl).toString(),
    );
  });

  it.each([
    ["invalid relative URL", baseUrl, "https://[invalid"],
    ["invalid base URL", "not a URL", "assets/file.bin"],
  ])("returns null for an %s", (_kind, httpBaseUrl, relativeUrl) => {
    expect(resolvePreparedAssetUrl({ httpBaseUrl }, relativeUrl)).toBeNull();
  });

  describe("assetUrlStateFromPreparedResult", () => {
    const success = (relativeUrl: string) =>
      AsyncResult.success({
        relativeUrl,
        expiresAt: Number.MAX_SAFE_INTEGER,
        ...(relativeUrl.includes("served") ? { sourcePath: "/served/path" } : {}),
      });

    it("merges routing parameters into a same-origin success URL", () => {
      expect(
        assetUrlStateFromPreparedResult(success("assets/file.bin"), {
          httpBaseUrl: baseUrl,
          queryParameters: [
            { key: "proxy", value: "a" },
            { key: "proxy", value: "b" },
          ],
        }),
      ).toEqual({
        _tag: "Success",
        url: "https://environment.example/root/assets/file.bin?proxy=a&proxy=b",
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    });

    it("passes through sourcePath while merging parameters", () => {
      expect(
        assetUrlStateFromPreparedResult(success("assets/served.bin"), {
          httpBaseUrl: baseUrl,
          queryParameters: [{ key: "client", value: "web" }],
        }),
      ).toEqual({
        _tag: "Success",
        url: "https://environment.example/root/assets/served.bin?client=web",
        expiresAt: Number.MAX_SAFE_INTEGER,
        sourcePath: "/served/path",
      });
    });

    it("stays loading without a connection and fails without a result", () => {
      expect(assetUrlStateFromPreparedResult(success("assets/file.bin"), null)).toEqual({
        _tag: "Loading",
      });
      expect(
        assetUrlStateFromPreparedResult(AsyncResult.failure(Cause.fail(new Error("boom"))), {
          httpBaseUrl: baseUrl,
        }),
      ).toEqual({ _tag: "Failure" });
    });
  });
});
