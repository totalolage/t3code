// @effect-diagnostics nodeBuiltinImport:off - standalone builder tests exercise Bun/Node filesystem APIs.
/// <reference types="bun" />

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildStandaloneBinary,
  collectWebAssets,
  createEmbeddedWebAssetsPlugin,
  createFffBunAliasPlugin,
  createMcpToolAccessBunCompatibilityPlugin,
  createPackageVersionPlugin,
  createStandaloneBuildConfig,
  formatSha256Checksum,
  generateEmbeddedWebAssetSource,
  parseBuildArguments,
  resolveTargetNativeLibrary,
  sha256File,
  StandaloneBuildInputError,
  type BunBuild,
} from "./buildStandaloneBinary.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-standalone-build-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeAsset(root: string, relativePath: string, contents = relativePath): string {
  const absolutePath = NodePath.join(root, relativePath);
  NodeFS.mkdirSync(NodePath.dirname(absolutePath), { recursive: true });
  NodeFS.writeFileSync(absolutePath, contents, "utf8");
  return absolutePath;
}

type ResolveCallback = (args: { readonly path: string; readonly resolveDir: string }) => unknown;
type LoadCallback = (args: { readonly path: string }) => unknown;

function capturePlugin(plugin: Bun.BunPlugin): {
  readonly resolve: ResolveCallback[];
  readonly load: LoadCallback[];
} {
  const resolve: ResolveCallback[] = [];
  const load: LoadCallback[] = [];
  const builder = {
    onResolve(_constraints: unknown, callback: unknown) {
      resolve.push(callback as ResolveCallback);
      return this;
    },
    onLoad(_constraints: unknown, callback: unknown) {
      load.push(callback as LoadCallback);
      return this;
    },
  } as unknown as Bun.PluginBuilder;
  plugin.setup(builder);
  return { resolve, load };
}

function compileOptions(config: Bun.BuildConfig): Bun.CompileBuildOptions {
  if (config.compile === null || typeof config.compile !== "object") {
    throw new Error("expected compile options");
  }
  return config.compile;
}

describe("buildStandaloneBinary", () => {
  it("transpiles only MCP tool access and preserves both static initializers", () => {
    const root = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../..",
    );
    const modulePath = NodePath.join(root, "apps/server/src/mcp/McpToolAccess.ts");
    const plugin = createMcpToolAccessBunCompatibilityPlugin({ repoRoot: root });
    const onLoad = capturePlugin(plugin).load[0];
    if (onLoad === undefined) throw new Error("expected MCP compatibility loader");

    const loaded = onLoad({ path: modulePath }) as {
      readonly contents: string;
      readonly loader: string;
      readonly resolveDir: string;
    };

    expect(loaded.loader).toBe("js");
    expect(loaded.resolveDir).toBe(NodePath.dirname(modulePath));
    expect(loaded.contents).not.toContain("Declaration<out Handler>");
    expect(loaded.contents).toContain("static {");
    expect(loaded.contents).toContain("declare = (handle) => new Declaration(builtHere, handle);");
    expect(loaded.contents).toContain(
      "checkedHandler = Struct.lambda((declaration) => declaration.#handle);",
    );
    expect(loaded.contents).toContain(
      "handlersLayer = (layer) => new HandlersLayer(builtHere, layer);",
    );
    expect(loaded.contents.indexOf("declare = (handle) => new Declaration")).toBeLessThan(
      loaded.contents.indexOf("checkedHandler = Struct.lambda"),
    );
    expect(onLoad({ path: NodePath.join(root, "apps/server/src/mcp/Other.ts") })).toBeUndefined();
  });

  it("fails closed when the scripts TypeScript compiler is unavailable or the source is malformed", () => {
    const root = makeTempDirectory();
    const modulePath = writeAsset(root, "apps/server/src/mcp/McpToolAccess.ts", "export const = ;");
    const missingCompilerPlugin = createMcpToolAccessBunCompatibilityPlugin({
      repoRoot: root,
      loadCompiler: () => undefined,
    });
    const missingCompilerLoad = capturePlugin(missingCompilerPlugin).load[0];
    if (missingCompilerLoad === undefined) throw new Error("expected MCP compatibility loader");
    expect(() => missingCompilerLoad({ path: modulePath })).toThrow(
      "does not expose the expected transpile API",
    );

    const repositoryRoot = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../../..",
    );
    const compilerRequire = NodeModule.createRequire(
      NodePath.join(repositoryRoot, "scripts/package.json"),
    );
    const malformedSourcePlugin = createMcpToolAccessBunCompatibilityPlugin({
      repoRoot: root,
      loadCompiler: () => compilerRequire("typescript-legacy") as unknown,
    });
    const malformedSourceLoad = capturePlugin(malformedSourcePlugin).load[0];
    if (malformedSourceLoad === undefined) throw new Error("expected MCP compatibility loader");
    expect(() => malformedSourceLoad({ path: modulePath })).toThrow(
      "TypeScript reported diagnostics for standalone MCP module",
    );
  });

  it("parses required options and enforces target-specific output names", () => {
    const root = makeTempDirectory();
    const parsed = parseBuildArguments(
      [
        "--target",
        "bun-linux-x64-baseline",
        "--outfile",
        "artifacts/t3-1.2.3-linux-x64",
        "--version",
        "1.2.3",
      ],
      { cwd: root, repoRoot: root },
    );

    expect(parsed).toEqual({
      target: "bun-linux-x64-baseline",
      outfile: NodePath.join(root, "artifacts/t3-1.2.3-linux-x64"),
      version: "1.2.3",
      webDir: NodePath.join(root, "apps/web/dist"),
    });
    expect(() => parseBuildArguments(["--target", "bun-linux-x64-baseline"])).toThrow(
      "Missing required option --outfile",
    );
    expect(() =>
      parseBuildArguments([
        "--target",
        "bun-linux-x64",
        "--outfile",
        "t3-1.2.3-linux-x64",
        "--version",
        "1.2.3",
      ]),
    ).toThrow("Invalid --target");
    expect(() =>
      parseBuildArguments([
        "--target",
        "bun-darwin-arm64",
        "--outfile",
        "t3-1.2.3-linux-x64",
        "--version",
        "1.2.3",
      ]),
    ).toThrow("Expected 't3-1.2.3-darwin-arm64'");
    expect(() =>
      parseBuildArguments([
        "--target",
        "bun-linux-x64-baseline",
        "--outfile",
        "t3-not-a-version-linux-x64",
        "--version",
        "not-a-version",
      ]),
    ).toThrow("Invalid --version");
  });

  it("walks every web file in deterministic order and generates static file imports", () => {
    const root = makeTempDirectory();
    const webDir = NodePath.join(root, "web");
    const paths = [
      ["index.html", "index"],
      ["assets/app.js", "app"],
      [".vite/manifest.json", "manifest"],
      ["nested/z.css", "css"],
    ] as const;
    for (const [relativePath, contents] of paths) writeAsset(webDir, relativePath, contents);

    const assets = collectWebAssets(webDir);
    expect(assets.map((asset) => asset.relativePath)).toEqual([
      ".vite/manifest.json",
      "assets/app.js",
      "index.html",
      "nested/z.css",
    ]);

    const source = generateEmbeddedWebAssetSource(assets.toReversed());
    expect(source).toContain(
      `import embeddedAsset0 from ${JSON.stringify(NodePath.join(webDir, ".vite/manifest.json"))} with { type: "file" };`,
    );
    expect(source.indexOf(".vite/manifest.json")).toBeLessThan(source.indexOf("assets/app.js"));
    expect(source).toContain("export const embeddedWebAssets = {");
    expect(source).toContain('"index.html": embeddedAsset2');

    const missingIndex = NodePath.join(root, "missing-index");
    writeAsset(missingIndex, "asset.js");
    expect(() => collectWebAssets(missingIndex)).toThrow("missing index.html");

    NodeFS.symlinkSync(NodePath.join(webDir, "index.html"), NodePath.join(webDir, "linked.html"));
    expect(() => collectWebAssets(webDir)).toThrow("Refusing symlink");
  });

  it("keeps the package version and asset manifest behind standalone-only plugins", async () => {
    const root = makeTempDirectory();
    const manifestPath = NodePath.join(root, "apps/server/src/standaloneAssetManifest.ts");
    const assetSource = 'export const embeddedWebAssets = { "index.html": "asset" };';
    const assetsPlugin = createEmbeddedWebAssetsPlugin({
      manifestPath,
      source: assetSource,
    });
    const assetsHooks = capturePlugin(assetsPlugin);
    expect(
      assetsHooks.resolve[0]?.({
        path: "./standaloneAssetManifest.ts",
        resolveDir: NodePath.dirname(manifestPath),
      }),
    ).toEqual({ path: NodePath.normalize(manifestPath), namespace: "t3-standalone-web-assets" });
    expect(
      assetsHooks.resolve[0]?.({ path: "./other.ts", resolveDir: NodePath.dirname(manifestPath) }),
    ).toBeUndefined();
    expect(assetsHooks.load[0]?.({ path: manifestPath })).toEqual({
      contents: assetSource,
      loader: "ts",
    });

    const packagePath = NodePath.resolve(
      NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const originalPackage = NodeFS.readFileSync(packagePath, "utf8");
    const packageHooks = capturePlugin(
      createPackageVersionPlugin({ packageJsonPath: packagePath, version: "9.8.7" }),
    );
    expect(
      packageHooks.resolve[0]?.({
        path: "../package.json",
        resolveDir: NodePath.dirname(NodePath.join(packagePath, "../src/bin.ts")),
      }),
    ).toEqual({
      path: NodePath.normalize(packagePath),
      namespace: "t3-standalone-package-version",
    });
    const loaded = packageHooks.load[0]?.({ path: packagePath }) as {
      contents: string;
      loader: string;
    };
    expect(JSON.parse(loaded.contents)).toMatchObject({ version: "9.8.7" });
    expect(NodeFS.readFileSync(packagePath, "utf8")).toBe(originalPackage);
  });

  it("aliases only fff-node, configures Bun compilation, and checks the target native library", () => {
    const root = makeTempDirectory();
    const nativeLibraryPath = writeAsset(root, "native/libfff_c.so", "native");
    const darwinNativeLibraryPath = writeAsset(root, "native/libfff_c.dylib", "native-darwin");
    const resolutions: Array<readonly [string, string]> = [];
    const aliasHooks = capturePlugin(
      createFffBunAliasPlugin({
        repoRoot: root,
        resolveModule: (specifier, parent) => {
          resolutions.push([specifier, parent]);
          return NodePath.join(root, "node_modules/@ff-labs/fff-bun/src/index.ts");
        },
      }),
    );
    expect(
      aliasHooks.resolve[0]?.({
        path: "@ff-labs/fff-node",
        resolveDir: "/tmp/outside-repository/importer",
      }),
    ).toEqual({ path: NodePath.join(root, "node_modules/@ff-labs/fff-bun/src/index.ts") });
    expect(resolutions).toEqual([["@ff-labs/fff-bun", NodePath.join(root, "apps/server")]]);

    const config = createStandaloneBuildConfig({
      target: "bun-linux-x64-baseline",
      version: "1.2.3",
      outfile: NodePath.join(root, "t3-1.2.3-linux-x64"),
      repoRoot: root,
      webAssets: [{ relativePath: "index.html", absolutePath: NodePath.join(root, "index.html") }],
      resolveModule: () => NodePath.join(root, "fff-bun.ts"),
    });
    expect(config.entrypoints).toEqual([NodePath.join(root, "apps/server/src/bin.ts")]);
    expect(config.target).toBe("bun");
    expect(config.packages).toBe("bundle");
    expect(config.external).toEqual([
      "node-pty",
      "node:sqlite",
      "@t3tools/shared/nodeSqliteClient",
    ]);
    expect(config.define).toEqual({
      __T3_BUN_STANDALONE__: "true",
      FFF_LIBC: '"gnu"',
    });
    expect(compileOptions(config)).toMatchObject({
      target: "bun-linux-x64-baseline",
      outfile: NodePath.join(root, "t3-1.2.3-linux-x64"),
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    });
    expect(config.plugins?.map((plugin) => plugin.name)).toEqual([
      "t3-standalone-fff-bun",
      "t3-standalone-mcp-typescript-compatibility",
      "t3-standalone-package-version",
      "t3-standalone-web-assets",
    ]);

    const darwinConfig = createStandaloneBuildConfig({
      target: "bun-darwin-arm64",
      version: "1.2.3",
      outfile: NodePath.join(root, "t3-1.2.3-darwin-arm64"),
      repoRoot: root,
      webAssets: [{ relativePath: "index.html", absolutePath: NodePath.join(root, "index.html") }],
      resolveModule: () => NodePath.join(root, "fff-bun.ts"),
    });
    expect(darwinConfig.define).toEqual({ __T3_BUN_STANDALONE__: "true" });
    expect(compileOptions(darwinConfig)).toMatchObject({
      target: "bun-darwin-arm64",
      outfile: NodePath.join(root, "t3-1.2.3-darwin-arm64"),
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    });

    const nativeResolutions: Array<readonly [string, string]> = [];
    const fffBunEntryPath = NodePath.join(root, "node_modules/@ff-labs/fff-bun/src/index.ts");
    expect(
      resolveTargetNativeLibrary("bun-linux-x64-baseline", {
        repoRoot: root,
        resolveModule: (specifier, parent) => {
          nativeResolutions.push([specifier, parent]);
          return specifier === "@ff-labs/fff-bun" ? fffBunEntryPath : nativeLibraryPath;
        },
      }),
    ).toBe(nativeLibraryPath);
    expect(nativeResolutions).toEqual([
      ["@ff-labs/fff-bun", NodePath.join(root, "apps/server")],
      [
        "@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so",
        NodePath.join(root, "node_modules/@ff-labs/fff-bun/src"),
      ],
    ]);
    nativeResolutions.length = 0;
    expect(
      resolveTargetNativeLibrary("bun-darwin-arm64", {
        repoRoot: root,
        resolveModule: (specifier, parent) => {
          nativeResolutions.push([specifier, parent]);
          return specifier === "@ff-labs/fff-bun" ? fffBunEntryPath : darwinNativeLibraryPath;
        },
      }),
    ).toBe(darwinNativeLibraryPath);
    expect(nativeResolutions).toEqual([
      ["@ff-labs/fff-bun", NodePath.join(root, "apps/server")],
      [
        "@ff-labs/fff-bin-darwin-arm64/libfff_c.dylib",
        NodePath.join(root, "node_modules/@ff-labs/fff-bun/src"),
      ],
    ]);
    expect(() =>
      resolveTargetNativeLibrary("bun-linux-x64-baseline", {
        repoRoot: root,
        resolveModule: (specifier) =>
          specifier === "@ff-labs/fff-bun" ? fffBunEntryPath : NodePath.join(root, "missing.so"),
      }),
    ).toThrow("is missing");
  });

  it("writes the binary and conventional digest atomically after a successful build", async () => {
    const root = makeTempDirectory();
    const webDir = NodePath.join(root, "web");
    writeAsset(webDir, "index.html", "<!doctype html>");
    const nativeLibraryPath = writeAsset(root, "native/libfff_c.so", "native");
    const outputDir = NodePath.join(root, "artifacts");
    const outfile = NodePath.join(outputDir, "t3-1.2.3-linux-x64");
    const originalPackage = NodeFS.readFileSync(
      NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../package.json"),
      "utf8",
    );
    let capturedConfig: Bun.BuildConfig | undefined;
    const fakeBuild: BunBuild = async (config) => {
      capturedConfig = config;
      const compile = compileOptions(config);
      if (compile.outfile === undefined) throw new Error("missing staged output");
      NodeFS.writeFileSync(compile.outfile, "standalone-binary", "utf8");
      return { outputs: [], success: true, logs: [] };
    };

    const result = await buildStandaloneBinary(
      { target: "bun-linux-x64-baseline", version: "1.2.3", outfile, webDir },
      { build: fakeBuild, resolveModule: () => nativeLibraryPath },
    );
    const expectedDigest = NodeCrypto.createHash("sha256")
      .update("standalone-binary")
      .digest("hex");
    expect(result.digest).toBe(expectedDigest);
    expect(NodeFS.readFileSync(outfile, "utf8")).toBe("standalone-binary");
    expect(NodeFS.readFileSync(`${outfile}.sha256`, "utf8")).toBe(
      formatSha256Checksum(expectedDigest, NodePath.basename(outfile)),
    );
    expect(capturedConfig?.entrypoints[0]).toBe(
      NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../src/bin.ts"),
    );
    expect(
      NodeFS.readFileSync(
        NodePath.resolve(
          NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
          "../package.json",
        ),
        "utf8",
      ),
    ).toBe(originalPackage);
    expect(NodeFS.readdirSync(outputDir).sort()).toEqual([
      NodePath.basename(outfile),
      `${NodePath.basename(outfile)}.sha256`,
    ]);
  });

  it("hashes files and removes staging output when Bun reports a build failure", async () => {
    const root = makeTempDirectory();
    const filePath = writeAsset(root, "input.bin", "hash me");
    expect(await sha256File(filePath)).toBe(
      NodeCrypto.createHash("sha256").update("hash me").digest("hex"),
    );
    expect(formatSha256Checksum("abc", "binary")).toBe("abc  binary\n");

    const webDir = NodePath.join(root, "web");
    writeAsset(webDir, "index.html");
    const nativeLibraryPath = writeAsset(root, "native/libfff_c.so", "native");
    const outputDir = NodePath.join(root, "artifacts");
    const outfile = NodePath.join(outputDir, "t3-1.2.3-linux-x64");
    const failingBuild: BunBuild = async () => ({
      outputs: [],
      success: false,
      logs: [{ message: "synthetic failure" }] as unknown as Bun.BuildOutput["logs"],
    });

    await expect(
      buildStandaloneBinary(
        { target: "bun-linux-x64-baseline", version: "1.2.3", outfile, webDir },
        { build: failingBuild, resolveModule: () => nativeLibraryPath },
      ),
    ).rejects.toThrow("synthetic failure");
    expect(NodeFS.readdirSync(outputDir)).toEqual([]);
  });

  it("surfaces AggregateError messages and removes staging output when Bun throws", async () => {
    const root = makeTempDirectory();
    const webDir = NodePath.join(root, "web");
    writeAsset(webDir, "index.html");
    const nativeLibraryPath = writeAsset(root, "native/libfff_c.so", "native");
    const outputDir = NodePath.join(root, "artifacts");
    const outfile = NodePath.join(outputDir, "t3-1.2.3-linux-x64");
    const missingModuleError = new Error("Could not resolve built-in module 'node:sqlite'.");
    const aggregate = new AggregateError([missingModuleError], "Bundle failed");
    const throwingBuild: BunBuild = async () => {
      throw aggregate;
    };

    const thrown = await buildStandaloneBinary(
      { target: "bun-linux-x64-baseline", version: "1.2.3", outfile, webDir },
      { build: throwingBuild, resolveModule: () => nativeLibraryPath },
    ).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(thrown).toBeInstanceOf(StandaloneBuildInputError);
    expect(thrown).toMatchObject({ cause: aggregate });
    expect((thrown as Error).message).toContain("Could not resolve built-in module 'node:sqlite'.");
    expect(NodeFS.readdirSync(outputDir)).toEqual([]);
  });
});
