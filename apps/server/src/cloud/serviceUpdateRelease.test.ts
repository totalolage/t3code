import { describe, expect, it } from "@effect/vitest";

import {
  parseServiceUpdateChecksum,
  selectServiceUpdateRelease,
  ServiceUpdateReleaseError,
  verifyServiceUpdateChecksum,
} from "./serviceUpdateRelease.ts";

const repository = "totalolage/t3code";
const currentVersion = "0.0.40-f8y.20260912.42";

function asset(name: string, version: string, repositoryName = repository) {
  const [owner, repo] = repositoryName.split("/");
  return {
    name,
    browser_download_url: `https://github.com/${owner}/${repo}/releases/download/v${version}/${name}`,
  };
}

function release(
  version: string,
  options: {
    readonly draft?: boolean;
    readonly prerelease?: boolean;
    readonly assets?: ReadonlyArray<Record<string, unknown>>;
    readonly tag?: string;
  } = {},
) {
  const binaryName = `t3-${version}-linux-x64`;
  return {
    tag_name: options.tag ?? `v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? true,
    assets: options.assets ?? [asset(binaryName, version), asset(`${binaryName}.sha256`, version)],
  };
}

function select(
  releases: unknown,
  overrides: Partial<Parameters<typeof selectServiceUpdateRelease>[0]> = {},
) {
  return selectServiceUpdateRelease({
    currentVersion,
    repository,
    platform: "linux",
    architecture: "x64",
    releases,
    ...overrides,
  });
}

describe("selectServiceUpdateRelease", () => {
  it("selects the greatest eligible release independent of feed order", () => {
    const selected = select([
      release("0.0.40-f8y.20260912.43"),
      release("0.0.41-f8y.20260912.1"),
      release("0.0.40-f8y.20260913.1"),
    ]);

    expect(selected).toEqual({
      version: "0.0.41-f8y.20260912.1",
      tag: "v0.0.41-f8y.20260912.1",
      binaryName: "t3-0.0.41-f8y.20260912.1-linux-x64",
      binaryUrl:
        "https://github.com/totalolage/t3code/releases/download/v0.0.41-f8y.20260912.1/t3-0.0.41-f8y.20260912.1-linux-x64",
      checksumsUrl:
        "https://github.com/totalolage/t3code/releases/download/v0.0.41-f8y.20260912.1/t3-0.0.41-f8y.20260912.1-linux-x64.sha256",
    });
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("compares huge canonical core components without rounding", () => {
    const selected = select([release("999999999999999999999999999999.0.0-f8y.20260912.1")], {
      currentVersion: "999999999999999999999999999998.0.0",
    });
    expect(selected?.version).toBe("999999999999999999999999999999.0.0-f8y.20260912.1");
  });

  it("orders F8Y releases above plain baselines only at the same or higher core version", () => {
    expect(select([release("0.0.40-f8y.20260912.1")], { currentVersion: "0.0.40" })?.version).toBe(
      "0.0.40-f8y.20260912.1",
    );
    expect(select([release("0.0.39-f8y.20260912.99")], { currentVersion: "0.0.40" })).toBeNull();
    expect(
      select([release("1.2.2-f8y.20260912.99"), release("1.2.4-f8y.20260912.1")], {
        currentVersion: "1.2.3",
      })?.version,
    ).toBe("1.2.4-f8y.20260912.1");
  });

  it("matches the retained F Linux binary and per-asset checksum names", () => {
    const selected = select([release(currentVersion)], {
      currentVersion: "0.0.40-f8y.20260912.41",
    });
    expect(selected?.binaryName).toBe(`t3-${currentVersion}-linux-x64`);
    expect(selected?.checksumsUrl).toBe(
      `https://github.com/${repository}/releases/download/v${currentVersion}/t3-${currentVersion}-linux-x64.sha256`,
    );
  });

  it("excludes equal, older, draft, nonchannel, invalid-date, and invalid-run releases", () => {
    expect(
      select([
        release(currentVersion),
        release("0.0.40-f8y.20260912.41"),
        release("0.0.39-f8y.20260912.99"),
        release("0.0.40-f8y.20260912.43", { draft: true }),
        release("0.0.40-f8y.20260912.44", { tag: "v0.0.40" }),
        release("0.0.40-f8y.20260229.45"),
        release("0.0.40-f8y.20260912.2100000001"),
      ]),
    ).toBeNull();
  });

  it("accepts an f8y prerelease regardless of the prerelease flag", () => {
    expect(select([release("0.0.40-f8y.20260912.43", { prerelease: false })])?.version).toBe(
      "0.0.40-f8y.20260912.43",
    );
  });

  it("returns no candidate when disabled or unsupported", () => {
    expect(select([release("0.0.40-f8y.20260912.43")], { repository: "" })).toBeNull();
    expect(select([release("0.0.40-f8y.20260912.43")], { platform: "darwin" })).toBeNull();
    expect(select([release("0.0.40-f8y.20260912.43")], { architecture: "arm64" })).toBeNull();
  });

  it("excludes wrong-platform binaries and legacy sidecars", () => {
    const version = "0.0.40-f8y.20260912.43";
    expect(
      select([
        release(version, {
          assets: [
            asset(`t3-${version}-darwin-arm64`, version),
            asset(`t3-${version}-darwin-arm64.sha256`, version),
          ],
        }),
        release(version, {
          assets: [
            asset(`t3-${version}-linux-x64`, version),
            asset(`t3-${version}-linux-x64.checksum`, version),
          ],
        }),
      ]),
    ).toBeNull();
  });

  it("rejects invalid repository, response shape, URLs, duplicate assets, and conflicts", () => {
    expect(() => select([], { repository: "https://github.com/totalolage/t3code" })).toThrow(
      ServiceUpdateReleaseError,
    );
    expect(() => select([], { repository: "totalolage/../t3code" })).toThrow(
      ServiceUpdateReleaseError,
    );
    expect(() => select({}, {})).toThrow("must be an array");
    expect(() =>
      select(Array.from({ length: 101 }, () => release("0.0.40-f8y.20260912.43"))),
    ).toThrow("at most 100");

    const version = "0.0.40-f8y.20260912.43";
    expect(() =>
      select([
        release(version, {
          assets: [
            asset(`t3-${version}-linux-x64`, version),
            asset(`t3-${version}-linux-x64`, version),
            asset(`t3-${version}-linux-x64.sha256`, version),
          ],
        }),
      ]),
    ).toThrow("exactly one");

    const wrongUrlRelease = release(version);
    wrongUrlRelease.assets[0]!["browser_download_url"] = "https://example.com/update";
    expect(() => select([wrongUrlRelease])).toThrow("configured GitHub download URL");

    const first = release(version);
    const second = release(version);
    second.assets[0]!["browser_download_url"] =
      "https://github.com/totalolage/t3code/releases/download/v0.0.40-f8y.20260912.43/other";
    expect(() => select([first, second])).toThrow("Conflicting GitHub release entries");
  });

  it("rejects newline-suffixed tags and malformed release fields", () => {
    expect(
      select([release("0.0.40-f8y.20260912.43", { tag: "v0.0.40-f8y.20260912.43\n" })]),
    ).toBeNull();
    expect(() =>
      select([
        {
          tag_name: "v0.0.40-f8y.20260912.43",
          draft: false,
          prerelease: true,
          assets: [{ name: "binary" }],
        },
      ]),
    ).toThrow("browser_download_url");
  });

  it("fails closed for a noncanonical current version", () => {
    expect(() => select([], { currentVersion: "01.0.40" })).toThrow("Invalid current version");
    expect(() => select([], { currentVersion: "0.0.40.0" })).toThrow("Invalid current version");
  });
});

describe("parseServiceUpdateChecksum", () => {
  const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("reads the first digest token from F's per-binary sidecar", () => {
    expect(parseServiceUpdateChecksum(`${digest}  t3-runtime.bin\r\n`)).toBe(digest);
    expect(parseServiceUpdateChecksum(`${digest.toUpperCase()}\n`)).toBe(digest);
  });

  it("rejects malformed, missing, and oversized sidecars", () => {
    const cases = [
      "",
      `${"A".repeat(63)}\n`,
      "not-a-checksum\n",
      `${digest}\n${"x".repeat(128 * 1024)}\n`,
    ];
    for (const contents of cases) {
      expect(() => parseServiceUpdateChecksum(contents)).toThrow(ServiceUpdateReleaseError);
    }
  });
});

describe("verifyServiceUpdateChecksum", () => {
  const expectedDigest = "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592";
  const payload = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");

  it("hashes split chunks once with real streaming Node crypto", () => {
    let yielded = 0;
    const chunks = {
      *[Symbol.iterator](): Iterator<Uint8Array> {
        yielded += 1;
        yield payload.subarray(0, 10);
        yielded += 1;
        yield payload.subarray(10, 25);
        yielded += 1;
        yield payload.subarray(25);
      },
    };

    verifyServiceUpdateChecksum(chunks, expectedDigest);
    expect(yielded).toBe(3);
  });

  it("rejects invalid digests and tampered bytes", () => {
    expect(() => verifyServiceUpdateChecksum([payload], expectedDigest.toUpperCase())).toThrow(
      "exactly 64 lowercase hexadecimal",
    );
    expect(() => verifyServiceUpdateChecksum([payload], "0".repeat(64))).toThrow("mismatch");
    expect(() =>
      verifyServiceUpdateChecksum(
        [new TextEncoder().encode("The quick brown fox jumps over the lazy cat")],
        expectedDigest,
      ),
    ).toThrow("mismatch");
  });
});
