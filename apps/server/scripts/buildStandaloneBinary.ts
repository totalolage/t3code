#!/usr/bin/env bun
// @effect-diagnostics nodeBuiltinImport:off - standalone builder is a Bun/Node filesystem boundary.
/// <reference types="bun" />

import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

export const STANDALONE_TARGETS = ["bun-linux-x64-baseline", "bun-darwin-arm64"] as const;
export type StandaloneTarget = (typeof STANDALONE_TARGETS)[number];

type OutputSuffix = "linux-x64" | "darwin-arm64";
type NativeLibc = "gnu";

interface StandaloneTargetDetails {
  readonly outputSuffix: OutputSuffix;
  readonly nativeSpecifier: string;
  readonly libc?: NativeLibc;
}

const TARGET_DETAILS = {
  "bun-linux-x64-baseline": {
    outputSuffix: "linux-x64",
    nativeSpecifier: "@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so",
    libc: "gnu",
  },
  "bun-darwin-arm64": {
    outputSuffix: "darwin-arm64",
    nativeSpecifier: "@ff-labs/fff-bin-darwin-arm64/libfff_c.dylib",
  },
} as const satisfies Record<StandaloneTarget, StandaloneTargetDetails>;

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const BUILD_OPTION_NAMES = ["target", "outfile", "version", "web-dir"] as const;
type BuildOptionName = (typeof BUILD_OPTION_NAMES)[number];

export const STANDALONE_EXTERNALS = [
  "node-pty",
  "node:sqlite",
  "@t3tools/shared/nodeSqliteClient",
] as const;

export const STANDALONE_BUILD_USAGE = `Usage: bun scripts/buildStandaloneBinary.ts --target TARGET --outfile PATH --version VERSION [--web-dir PATH]

Targets:
  bun-linux-x64-baseline
  bun-darwin-arm64

The default web directory is apps/web/dist relative to the repository root.`;

export class StandaloneBuildArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StandaloneBuildArgumentError";
  }
}

export class StandaloneBuildInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StandaloneBuildInputError";
  }
}

export interface StandaloneBuildOptions {
  readonly target: StandaloneTarget;
  readonly outfile: string;
  readonly version: string;
  readonly webDir: string;
}

export interface ParseBuildArgumentsOptions {
  readonly cwd?: string;
  readonly repoRoot?: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStandaloneTarget(value: string): value is StandaloneTarget {
  return (STANDALONE_TARGETS as readonly string[]).includes(value);
}

function isBuildOptionName(value: string): value is BuildOptionName {
  return (BUILD_OPTION_NAMES as readonly string[]).includes(value);
}

function assertValidVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new StandaloneBuildArgumentError(
      `Invalid --version '${version}'. Expected a semantic version such as 1.2.3.`,
    );
  }
}

export function expectedOutputBasename(target: StandaloneTarget, version: string): string {
  return `t3-${version}-${TARGET_DETAILS[target].outputSuffix}`;
}

export function validateStandaloneBuildOptions(input: {
  readonly target: string;
  readonly outfile: string;
  readonly version: string;
  readonly webDir: string;
}): StandaloneBuildOptions {
  if (!isStandaloneTarget(input.target)) {
    throw new StandaloneBuildArgumentError(
      `Invalid --target '${input.target}'. Expected one of: ${STANDALONE_TARGETS.join(", ")}.`,
    );
  }
  if (input.outfile.trim().length === 0) {
    throw new StandaloneBuildArgumentError("Missing value for --outfile.");
  }
  if (input.version.trim().length === 0) {
    throw new StandaloneBuildArgumentError("Missing value for --version.");
  }
  assertValidVersion(input.version);
  if (input.webDir.trim().length === 0) {
    throw new StandaloneBuildArgumentError("Missing value for --web-dir.");
  }

  const outfile = NodePath.resolve(input.outfile);
  const expectedBasename = expectedOutputBasename(input.target, input.version);
  if (NodePath.basename(outfile) !== expectedBasename) {
    throw new StandaloneBuildArgumentError(
      `Invalid --outfile basename '${NodePath.basename(outfile)}'. Expected '${expectedBasename}'.`,
    );
  }

  return {
    target: input.target,
    outfile,
    version: input.version,
    webDir: NodePath.resolve(input.webDir),
  };
}

function optionValue(
  argv: ReadonlyArray<string>,
  index: number,
  name: BuildOptionName,
  inlineValue: string | undefined,
): string {
  if (inlineValue !== undefined) {
    if (inlineValue.length === 0) {
      throw new StandaloneBuildArgumentError(`Missing value for --${name}.`);
    }
    return inlineValue;
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new StandaloneBuildArgumentError(`Missing value for --${name}.`);
  }
  return value;
}

export function parseBuildArguments(
  argv: ReadonlyArray<string>,
  options: ParseBuildArgumentsOptions = {},
): StandaloneBuildOptions {
  const values: Partial<Record<BuildOptionName, string>> = {};
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined || !token.startsWith("--")) {
      throw new StandaloneBuildArgumentError(
        `Unexpected argument '${token ?? ""}'.\n\n${STANDALONE_BUILD_USAGE}`,
      );
    }

    const equalsIndex = token.indexOf("=");
    const rawName = token.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!isBuildOptionName(rawName)) {
      throw new StandaloneBuildArgumentError(
        `Unknown option '--${rawName}'.\n\n${STANDALONE_BUILD_USAGE}`,
      );
    }
    if (values[rawName] !== undefined) {
      throw new StandaloneBuildArgumentError(`Option --${rawName} was provided more than once.`);
    }

    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    values[rawName] = optionValue(argv, index, rawName, inlineValue);
    index += equalsIndex === -1 ? 2 : 1;
  }

  const target = values.target;
  const outfile = values.outfile;
  const version = values.version;
  if (target === undefined) {
    throw new StandaloneBuildArgumentError("Missing required option --target.");
  }
  if (outfile === undefined) {
    throw new StandaloneBuildArgumentError("Missing required option --outfile.");
  }
  if (version === undefined) {
    throw new StandaloneBuildArgumentError("Missing required option --version.");
  }

  const repoRoot = NodePath.resolve(options.repoRoot ?? REPO_ROOT);
  const cwd = NodePath.resolve(options.cwd ?? process.cwd());
  const webDir = values["web-dir"] ?? NodePath.join(repoRoot, "apps/web/dist");

  return validateStandaloneBuildOptions({
    target,
    outfile: NodePath.resolve(cwd, outfile),
    version,
    webDir: NodePath.resolve(cwd, webDir),
  });
}

export interface EmbeddedWebAsset {
  readonly relativePath: string;
  readonly absolutePath: string;
}

function statPath(
  path: string,
  description: string,
): NonNullable<ReturnType<typeof NodeFS.lstatSync>> {
  try {
    const stat = NodeFS.lstatSync(path);
    if (stat === undefined) {
      throw new Error("lstatSync returned no file metadata");
    }
    return stat;
  } catch (cause) {
    throw new StandaloneBuildInputError(`Unable to read ${description} '${path}'.`, { cause });
  }
}

export function collectWebAssets(webDir: string): EmbeddedWebAsset[] {
  const root = NodePath.resolve(webDir);
  const rootStat = statPath(root, "web directory");
  if (rootStat.isSymbolicLink()) {
    throw new StandaloneBuildInputError(`Refusing symlinked web directory '${root}'.`);
  }
  if (!rootStat.isDirectory()) {
    throw new StandaloneBuildInputError(`Web directory '${root}' is not a directory.`);
  }

  const assets: EmbeddedWebAsset[] = [];
  const walk = (directory: string): void => {
    const entries = NodeFS.readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    );
    for (const entry of entries) {
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new StandaloneBuildInputError(
          `Refusing symlink in web directory '${NodePath.relative(root, absolutePath)}'.`,
        );
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new StandaloneBuildInputError(
          `Unsupported non-file web asset '${NodePath.relative(root, absolutePath)}'.`,
        );
      }
      assets.push({
        relativePath: NodePath.relative(root, absolutePath).split(NodePath.sep).join("/"),
        absolutePath,
      });
    }
  };

  walk(root);
  assets.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  if (!assets.some((asset) => asset.relativePath === "index.html")) {
    throw new StandaloneBuildInputError(`Web directory '${root}' is missing index.html.`);
  }
  return assets;
}

function sortedUniqueAssets(assets: ReadonlyArray<EmbeddedWebAsset>): EmbeddedWebAsset[] {
  const sorted = [...assets].sort((left, right) =>
    compareStrings(left.relativePath, right.relativePath),
  );
  const seen = new Set<string>();
  for (const asset of sorted) {
    if (seen.has(asset.relativePath)) {
      throw new StandaloneBuildInputError(`Duplicate embedded web asset '${asset.relativePath}'.`);
    }
    seen.add(asset.relativePath);
  }
  return sorted;
}

export function generateEmbeddedWebAssetSource(assets: ReadonlyArray<EmbeddedWebAsset>): string {
  const sortedAssets = sortedUniqueAssets(assets);
  const imports = sortedAssets.map(
    (asset, index) =>
      `import embeddedAsset${index} from ${JSON.stringify(asset.absolutePath)} with { type: "file" };`,
  );
  const entries = sortedAssets.map(
    (asset, index) => `  ${JSON.stringify(asset.relativePath)}: embeddedAsset${index},`,
  );

  return [...imports, "", "export const embeddedWebAssets = {", ...entries, "} as const;", ""].join(
    "\n",
  );
}

function resolveImportPath(importPath: string, resolveDir: string): string {
  return NodePath.normalize(
    NodePath.isAbsolute(importPath) ? importPath : NodePath.resolve(resolveDir, importPath),
  );
}

export interface EmbeddedWebAssetPluginOptions {
  readonly manifestPath: string;
  readonly source: string;
}

export function createEmbeddedWebAssetsPlugin(
  options: EmbeddedWebAssetPluginOptions,
): Bun.BunPlugin {
  const manifestPath = NodePath.normalize(NodePath.resolve(options.manifestPath));
  return {
    name: "t3-standalone-web-assets",
    setup(build) {
      build.onResolve({ filter: /standaloneAssetManifest(?:\.ts)?$/ }, (args) => {
        if (resolveImportPath(args.path, args.resolveDir) !== manifestPath) return undefined;
        return { path: manifestPath, namespace: "t3-standalone-web-assets" };
      });
      build.onLoad({ filter: /.*/, namespace: "t3-standalone-web-assets" }, () => ({
        contents: options.source,
        loader: "ts",
      }));
    },
  };
}

export interface PackageVersionPluginOptions {
  readonly packageJsonPath: string;
  readonly version: string;
}

function readPackageJson(path: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(NodeFS.readFileSync(path, "utf8")) as unknown;
  } catch (cause) {
    throw new StandaloneBuildInputError(`Unable to read package metadata '${path}'.`, { cause });
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new StandaloneBuildInputError(`Package metadata '${path}' must contain a JSON object.`);
  }
  return decoded as Record<string, unknown>;
}

export function createPackageVersionPlugin(options: PackageVersionPluginOptions): Bun.BunPlugin {
  const packageJsonPath = NodePath.normalize(NodePath.resolve(options.packageJsonPath));
  return {
    name: "t3-standalone-package-version",
    setup(build) {
      build.onResolve({ filter: /package\.json$/ }, (args) => {
        if (resolveImportPath(args.path, args.resolveDir) !== packageJsonPath) return undefined;
        return { path: packageJsonPath, namespace: "t3-standalone-package-version" };
      });
      build.onLoad({ filter: /.*/, namespace: "t3-standalone-package-version" }, () => {
        const packageJson = readPackageJson(packageJsonPath);
        return {
          contents: JSON.stringify({ ...packageJson, version: options.version }),
          loader: "json",
        };
      });
    },
  };
}

export type ModuleResolver = (specifier: string, parent: string) => string;

const resolveWithBun: ModuleResolver = (specifier, parent) => {
  if (typeof Bun === "undefined") {
    throw new StandaloneBuildInputError(
      "Bun is required to resolve standalone build dependencies.",
    );
  }
  return Bun.resolveSync(specifier, parent);
};

export interface FffBunAliasPluginOptions {
  readonly repoRoot?: string;
  readonly resolveModule?: ModuleResolver;
}

export function createFffBunAliasPlugin(options: FffBunAliasPluginOptions = {}): Bun.BunPlugin {
  const repoRoot = NodePath.resolve(options.repoRoot ?? REPO_ROOT);
  const resolveModule = options.resolveModule ?? resolveWithBun;
  const fffBunEntry = resolveModule("@ff-labs/fff-bun", NodePath.join(repoRoot, "apps/server"));
  return {
    name: "t3-standalone-fff-bun",
    setup(build) {
      build.onResolve({ filter: /^@ff-labs\/fff-node$/ }, () => ({ path: fffBunEntry }));
    },
  };
}

interface TypeScriptDiagnostic {
  readonly category: number;
  readonly messageText: unknown;
}

interface TypeScriptLegacyCompiler {
  readonly ScriptTarget: { readonly ESNext: number };
  readonly ModuleKind: { readonly ESNext: number };
  transpileModule(
    input: string,
    options: {
      readonly fileName: string;
      readonly reportDiagnostics: true;
      readonly compilerOptions: { readonly target: number; readonly module: number };
    },
  ): { readonly outputText: string; readonly diagnostics: ReadonlyArray<TypeScriptDiagnostic> };
  flattenDiagnosticMessageText(messageText: unknown, newLine: string): string;
}

export interface McpToolAccessBunCompatibilityPluginOptions {
  readonly repoRoot?: string;
  readonly loadCompiler?: () => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadTypeScriptLegacy(repoRoot: string): unknown {
  try {
    // The compiler is an existing dev dependency of the scripts workspace.
    // Resolve it from that package instead of relying on hoisting into apps/server.
    const scriptsRequire = NodeModule.createRequire(
      NodePath.join(repoRoot, "scripts/package.json"),
    );
    return scriptsRequire("typescript-legacy") as unknown;
  } catch (cause) {
    throw new StandaloneBuildInputError(
      "The standalone Bun compatibility step requires the scripts workspace's TypeScript 6 compiler (typescript-legacy).",
      { cause },
    );
  }
}

function typeScriptLegacyCompiler(value: unknown): TypeScriptLegacyCompiler {
  if (!isRecord(value)) {
    throw new StandaloneBuildInputError(
      "The scripts workspace's TypeScript compiler does not expose the expected transpile API.",
    );
  }

  const scriptTarget = value.ScriptTarget;
  const moduleKind = value.ModuleKind;
  const transpileModule = value.transpileModule;
  const flattenDiagnosticMessageText = value.flattenDiagnosticMessageText;
  if (
    !isRecord(scriptTarget) ||
    typeof scriptTarget.ESNext !== "number" ||
    !isRecord(moduleKind) ||
    typeof moduleKind.ESNext !== "number" ||
    typeof transpileModule !== "function" ||
    typeof flattenDiagnosticMessageText !== "function"
  ) {
    throw new StandaloneBuildInputError(
      "The scripts workspace's TypeScript compiler does not expose the expected transpile API.",
    );
  }

  return value as unknown as TypeScriptLegacyCompiler;
}

function transpileMcpToolAccess(source: string, fileName: string, compilerValue: unknown): string {
  const compiler = typeScriptLegacyCompiler(compilerValue);
  let result: ReturnType<TypeScriptLegacyCompiler["transpileModule"]>;
  try {
    result = compiler.transpileModule(source, {
      fileName,
      reportDiagnostics: true,
      compilerOptions: {
        target: compiler.ScriptTarget.ESNext,
        module: compiler.ModuleKind.ESNext,
      },
    });
  } catch (cause) {
    throw new StandaloneBuildInputError(
      `TypeScript could not transpile standalone MCP module '${fileName}'.`,
      { cause },
    );
  }

  if (!Array.isArray(result.diagnostics)) {
    throw new StandaloneBuildInputError(
      `TypeScript returned malformed diagnostics for standalone MCP module '${fileName}'.`,
    );
  }
  if (result.diagnostics.length > 0) {
    const messages = result.diagnostics.map((diagnostic) => {
      if (
        !isRecord(diagnostic) ||
        typeof diagnostic.category !== "number" ||
        !("messageText" in diagnostic)
      ) {
        throw new StandaloneBuildInputError(
          `TypeScript returned a malformed diagnostic for standalone MCP module '${fileName}'.`,
        );
      }
      return compiler.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    });
    throw new StandaloneBuildInputError(
      `TypeScript reported diagnostics for standalone MCP module '${fileName}':\n${messages.join("\n")}`,
    );
  }
  if (typeof result.outputText !== "string" || result.outputText.trim().length === 0) {
    throw new StandaloneBuildInputError(
      `TypeScript returned no JavaScript for standalone MCP module '${fileName}'.`,
    );
  }
  return result.outputText;
}

export function createMcpToolAccessBunCompatibilityPlugin(
  options: McpToolAccessBunCompatibilityPluginOptions = {},
): Bun.BunPlugin {
  const repoRoot = NodePath.resolve(options.repoRoot ?? REPO_ROOT);
  const modulePath = NodePath.join(repoRoot, "apps/server/src/mcp/McpToolAccess.ts");
  const loadCompiler = options.loadCompiler ?? (() => loadTypeScriptLegacy(repoRoot));

  return {
    name: "t3-standalone-mcp-typescript-compatibility",
    setup(build) {
      build.onLoad({ filter: /McpToolAccess\.ts$/ }, (args) => {
        if (NodePath.resolve(args.path) !== modulePath) return undefined;

        let source: string;
        try {
          source = NodeFS.readFileSync(modulePath, "utf8");
        } catch (cause) {
          throw new StandaloneBuildInputError(
            `Unable to read standalone MCP module '${modulePath}'.`,
            { cause },
          );
        }
        return {
          contents: transpileMcpToolAccess(source, modulePath, loadCompiler()),
          loader: "js",
          resolveDir: NodePath.dirname(modulePath),
        };
      });
    },
  };
}

export function resolveTargetNativeLibrary(
  target: StandaloneTarget,
  options: { readonly repoRoot?: string; readonly resolveModule?: ModuleResolver } = {},
): string {
  const details = TARGET_DETAILS[target];
  const repoRoot = NodePath.resolve(options.repoRoot ?? REPO_ROOT);
  const resolveModule = options.resolveModule ?? resolveWithBun;
  let fffBunEntry: string;
  try {
    fffBunEntry = resolveModule("@ff-labs/fff-bun", NodePath.join(repoRoot, "apps/server"));
  } catch (cause) {
    throw new StandaloneBuildInputError(
      `The standalone-only dependency '@ff-labs/fff-bun' is not installed.`,
      { cause },
    );
  }
  let resolvedPath: string;
  try {
    resolvedPath = resolveModule(details.nativeSpecifier, NodePath.dirname(fffBunEntry));
  } catch (cause) {
    throw new StandaloneBuildInputError(
      `Required native library '${details.nativeSpecifier}' for ${target} is not installed.`,
      { cause },
    );
  }

  const absolutePath = NodePath.resolve(resolvedPath);
  let stat: ReturnType<typeof NodeFS.lstatSync>;
  try {
    stat = NodeFS.lstatSync(absolutePath);
  } catch (cause) {
    throw new StandaloneBuildInputError(
      `Required native library '${details.nativeSpecifier}' for ${target} is missing at '${absolutePath}'.`,
      { cause },
    );
  }
  if (!stat.isFile()) {
    throw new StandaloneBuildInputError(
      `Required native library '${details.nativeSpecifier}' for ${target} is not a regular file.`,
    );
  }
  return absolutePath;
}

export interface StandaloneBuildConfigOptions {
  readonly target: StandaloneTarget;
  readonly version: string;
  readonly outfile: string;
  readonly repoRoot?: string;
  readonly webAssets: ReadonlyArray<EmbeddedWebAsset>;
  readonly resolveModule?: ModuleResolver;
}

export function createStandaloneBuildConfig(
  options: StandaloneBuildConfigOptions,
): Bun.BuildConfig {
  const repoRoot = NodePath.resolve(options.repoRoot ?? REPO_ROOT);
  const details = TARGET_DETAILS[options.target];
  return {
    entrypoints: [NodePath.join(repoRoot, "apps/server/src/bin.ts")],
    target: "bun",
    packages: "bundle",
    external: [...STANDALONE_EXTERNALS],
    define: {
      __T3_BUN_STANDALONE__: "true",
      ...("libc" in details ? { FFF_LIBC: JSON.stringify(details.libc) } : {}),
    },
    compile: {
      target: options.target,
      outfile: options.outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    plugins: [
      createFffBunAliasPlugin({
        repoRoot,
        ...(options.resolveModule ? { resolveModule: options.resolveModule } : {}),
      }),
      createMcpToolAccessBunCompatibilityPlugin({ repoRoot }),
      createPackageVersionPlugin({
        packageJsonPath: NodePath.join(repoRoot, "apps/server/package.json"),
        version: options.version,
      }),
      createEmbeddedWebAssetsPlugin({
        manifestPath: NodePath.join(repoRoot, "apps/server/src/standaloneAssetManifest.ts"),
        source: generateEmbeddedWebAssetSource(options.webAssets),
      }),
    ],
  };
}

export type BunBuild = (config: Bun.BuildConfig) => Promise<Bun.BuildOutput>;

function runBunBuild(config: Bun.BuildConfig): Promise<Bun.BuildOutput> {
  if (typeof Bun === "undefined") {
    throw new StandaloneBuildInputError("Bun is required to build standalone binaries.");
  }
  return Bun.build(config);
}

function formatBuildLogs(logs: Bun.BuildOutput["logs"]): string {
  const messages = logs.map((log) => ("message" in log ? log.message : String(log)));
  return messages.length === 0 ? "Bun.build returned no diagnostics." : messages.join("\n");
}

function formatThrownBuildError(cause: unknown): string {
  if (cause instanceof AggregateError) {
    const messages = cause.errors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .filter((message) => message.length > 0);
    return messages.length === 0 ? cause.message : messages.join("\n");
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function assertRegularFile(path: string, description: string): void {
  let stat: ReturnType<typeof NodeFS.lstatSync>;
  try {
    stat = NodeFS.lstatSync(path);
  } catch (cause) {
    throw new StandaloneBuildInputError(`${description} was not written at '${path}'.`, { cause });
  }
  if (!stat.isFile()) {
    throw new StandaloneBuildInputError(`${description} was not written at '${path}'.`);
  }
}

export async function sha256File(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const stream = NodeFS.createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export function formatSha256Checksum(digest: string, basename: string): string {
  return `${digest}  ${basename}\n`;
}

export interface StandaloneBuildDependencies {
  readonly build?: BunBuild;
  readonly resolveModule?: ModuleResolver;
}

export interface StandaloneBuildResult {
  readonly target: StandaloneTarget;
  readonly version: string;
  readonly outfile: string;
  readonly checksumPath: string;
  readonly digest: string;
  readonly nativeLibraryPath: string;
  readonly webAssetCount: number;
}

export async function buildStandaloneBinary(
  input: StandaloneBuildOptions,
  dependencies: StandaloneBuildDependencies = {},
): Promise<StandaloneBuildResult> {
  const options = validateStandaloneBuildOptions(input);
  const webAssets = collectWebAssets(options.webDir);
  const resolveModule = dependencies.resolveModule ?? resolveWithBun;
  const nativeLibraryPath = resolveTargetNativeLibrary(options.target, {
    repoRoot: REPO_ROOT,
    resolveModule,
  });

  const outputDir = NodePath.dirname(options.outfile);
  NodeFS.mkdirSync(outputDir, { recursive: true });
  const outputBasename = NodePath.basename(options.outfile);
  const stagingDir = NodeFS.mkdtempSync(NodePath.join(outputDir, `.${outputBasename}.tmp-`));
  const stagedOutfile = NodePath.join(stagingDir, outputBasename);
  const stagedChecksumPath = `${stagedOutfile}.sha256`;
  const checksumPath = `${options.outfile}.sha256`;

  try {
    const buildConfig = createStandaloneBuildConfig({
      target: options.target,
      version: options.version,
      outfile: stagedOutfile,
      repoRoot: REPO_ROOT,
      webAssets,
      resolveModule,
    });
    const build = dependencies.build ?? runBunBuild;
    let result: Bun.BuildOutput;
    try {
      result = await build(buildConfig);
    } catch (cause) {
      throw new StandaloneBuildInputError(
        `Standalone build failed for ${options.target}.\n${formatThrownBuildError(cause)}`,
        { cause },
      );
    }
    if (!result.success) {
      throw new StandaloneBuildInputError(
        `Standalone build failed for ${options.target}.\n${formatBuildLogs(result.logs)}`,
      );
    }

    assertRegularFile(stagedOutfile, "Standalone binary");
    const digest = await sha256File(stagedOutfile);
    NodeFS.writeFileSync(
      stagedChecksumPath,
      formatSha256Checksum(digest, NodePath.basename(options.outfile)),
      "utf8",
    );
    NodeFS.renameSync(stagedOutfile, options.outfile);
    NodeFS.renameSync(stagedChecksumPath, checksumPath);

    return {
      target: options.target,
      version: options.version,
      outfile: options.outfile,
      checksumPath,
      digest,
      nativeLibraryPath,
      webAssetCount: webAssets.length,
    };
  } finally {
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export async function main(argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    // @effect-diagnostics-next-line globalConsole:off - the standalone CLI reports directly to stdout.
    console.log(STANDALONE_BUILD_USAGE);
    return;
  }
  const result = await buildStandaloneBinary(parseBuildArguments(argv));
  // @effect-diagnostics-next-line globalConsole:off - the standalone CLI reports directly to stdout.
  console.log(`Wrote ${result.outfile}`);
  // @effect-diagnostics-next-line globalConsole:off - the standalone CLI reports directly to stdout.
  console.log(`SHA-256 ${result.digest}`);
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    // @effect-diagnostics-next-line globalConsole:off - the standalone CLI reports failures to stderr.
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
