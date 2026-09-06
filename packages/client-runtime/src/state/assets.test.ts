import { describe, expect, it } from "@effect/vitest";
import { type AssetCreateUrlResult, EnvironmentId } from "@t3tools/contracts";
import type { RemoteQueryParameter } from "@t3tools/shared/remote";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createProjectFaviconCache } from "../projectFaviconCache.ts";
import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  InvalidAssetCollectionKeyError,
  parseAssetCollectionKey,
  resolveAssetUrl,
  assetUrlStateFromResult,
} from "./assets.ts";

const ENVIRONMENT_QUERY_PARAMETERS: ReadonlyArray<RemoteQueryParameter> = [
  { key: "proxy", value: "fork route" },
];

describe("asset URLs", () => {
  it("preserves endpoint query parameters when resolving a relative asset URL", () => {
    expect(
      resolveAssetUrl(
        "https://environment.example.test/base",
        "/api/assets/icon.svg",
        ENVIRONMENT_QUERY_PARAMETERS,
      ),
    ).toBe("https://environment.example.test/api/assets/icon.svg?proxy=fork+route");
  });

  it("preserves endpoint query parameters and image dimensions in resolved image state", () => {
    const result = AsyncResult.success({
      relativeUrl: "/api/assets/image.png",
      expiresAt: 4_000_000_000_000,
      imageDimensions: { width: 640, height: 480 },
    });

    expect(
      assetUrlStateFromResult(
        result,
        "https://environment.example.test",
        ENVIRONMENT_QUERY_PARAMETERS,
      ),
    ).toEqual({
      _tag: "Success",
      url: "https://environment.example.test/api/assets/image.png?proxy=fork+route",
      imageDimensions: { width: 640, height: 480 },
    });
  });
});

describe("asset collection keys", () => {
  it("preserves malformed JSON and its native cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseAssetCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidAssetCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.any(SyntaxError) });
  });

  it("rejects invalid asset collection shapes", () => {
    const key = JSON.stringify(["environment-1", [{ _tag: "unknown" }]]);

    expect(() => parseAssetCollectionKey(key)).toThrowError(InvalidAssetCollectionKeyError);
  });
});

describe("createAssetEnvironmentAtoms", () => {
  it("keys asset URL queries by environment and resource", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: {
        resource: {
          _tag: "project-favicon" as const,
          cwd: "/repo/original",
        },
      },
    };

    expect(assets.createUrl(originalTarget)).toBe(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
          },
        },
      }),
    );
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/next",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
            path: "brand/icon.svg",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(assets.createUrl(originalTarget));
  });

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const resources = [
      { _tag: "attachment" as const, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});

describe("project favicon URL cache", () => {
  it("renders a persisted thumbnail immediately in a fresh registry and refreshes it remotely", async () => {
    const image = "data:image/png;base64,aWNvbg==";
    const replacement = "data:image/png;base64,bmV3";
    const records = new Map<string, unknown>();
    const storage = {
      list: async () => [...records.values()],
      put: async (key: string, entry: unknown) => {
        records.set(key, entry);
      },
      remove: async (key: string) => {
        records.delete(key);
      },
    };
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const previousCache = createProjectFaviconCache({ storage, load: async () => image });
    await previousCache.resolve(
      target,
      "https://remote.test/api/assets/old/v1-icon.png",
      new AbortController().signal,
    );
    await previousCache.flush();
    let loadedUrl: string | undefined;
    const cache = createProjectFaviconCache({
      storage,
      load: async (url) => {
        loadedUrl = url;
        return replacement;
      },
    });
    await cache.hydrate();
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.initial(),
    );
    const connection = Atom.make<
      Option.Option<{
        readonly httpBaseUrl: string;
        readonly queryParameters: ReadonlyArray<RemoteQueryParameter>;
      }>
    >(Option.none());
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => connection,
      imageCache: cache,
    })(target);
    const unmount = registry.mount(favicon);
    try {
      expect(registry.get(favicon)).toBe(image);
      let unsubscribe = () => {};
      const refreshed = new Promise<void>((resolve) => {
        unsubscribe = registry.subscribe(favicon, (value) => {
          if (value === replacement) resolve();
        });
      });
      registry.set(
        connection,
        Option.some({
          httpBaseUrl: "https://remote.test",
          queryParameters: ENVIRONMENT_QUERY_PARAMETERS,
        }),
      );
      registry.set(
        result,
        AsyncResult.success({
          relativeUrl: "/api/assets/new/v2-icon.png",
          expiresAt: 4_000_000_000_000,
        }),
      );
      expect(registry.get(favicon)).toBe(image);
      await refreshed;
      unsubscribe();
      expect(registry.get(favicon)).toBe(replacement);
      expect(loadedUrl).toBe("https://remote.test/api/assets/new/v2-icon.png?proxy=fork+route");
      registry.set(connection, Option.none());
      registry.set(result, AsyncResult.failure(Cause.die("offline")));
      expect(registry.get(favicon)).toBe(replacement);
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("retains icons across outages and remounts, then accepts refreshed and missing icons", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.initial(),
    );
    const connection = Atom.make(
      Option.some({
        httpBaseUrl: "https://remote.test",
        queryParameters: ENVIRONMENT_QUERY_PARAMETERS,
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => connection,
    })({ environmentId: EnvironmentId.make("remote"), cwd: "/workspace" });
    let unmount = registry.mount(favicon);
    try {
      expect(registry.get(favicon)).toBeNull();
      registry.set(
        result,
        AsyncResult.success({
          expiresAt: 4_000_000_000_000,
          relativeUrl: "/api/assets/token-a/icon.svg",
        }),
      );
      expect(registry.get(favicon)).toBe(
        "https://remote.test/api/assets/token-a/icon.svg?proxy=fork+route",
      );

      registry.set(connection, Option.none());
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(registry.get(favicon)).toBe(
        "https://remote.test/api/assets/token-a/icon.svg?proxy=fork+route",
      );
      unmount();
      unmount = registry.mount(favicon);
      expect(registry.get(favicon)).toBe(
        "https://remote.test/api/assets/token-a/icon.svg?proxy=fork+route",
      );

      registry.set(result, AsyncResult.initial());
      registry.set(
        connection,
        Option.some({
          httpBaseUrl: "https://reconnected.test",
          queryParameters: ENVIRONMENT_QUERY_PARAMETERS,
        }),
      );
      expect(registry.get(favicon)).toBe(
        "https://remote.test/api/assets/token-a/icon.svg?proxy=fork+route",
      );
      registry.set(
        result,
        AsyncResult.success({
          expiresAt: 4_000_000_000_000,
          relativeUrl: "/api/assets/token-b/icon.svg",
        }),
      );
      expect(registry.get(favicon)).toBe(
        "https://reconnected.test/api/assets/token-b/icon.svg?proxy=fork+route",
      );

      registry.set(
        result,
        AsyncResult.success({
          expiresAt: 4_000_000_000_000,
          relativeUrl: "/api/assets/token-c/project-favicon-missing",
        }),
      );
      expect(registry.get(favicon)).toBe(
        "https://reconnected.test/api/assets/token-c/project-favicon-missing?proxy=fork+route",
      );
      registry.set(connection, Option.none());
      expect(registry.get(favicon)).toBe(
        "https://reconnected.test/api/assets/token-c/project-favicon-missing?proxy=fork+route",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });

  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () =>
        Atom.make(
          Option.some({
            httpBaseUrl: "https://remote.test",
            queryParameters: ENVIRONMENT_QUERY_PARAMETERS,
          }),
        ),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe(
        "https://remote.test/api/assets/token/icon.svg?proxy=fork+route",
      );
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg?proxy=fork+route",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
