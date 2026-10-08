// @effect-diagnostics nodeBuiltinImport:off - The verifier is exercised against real disposable files and a real Node CLI process.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { verifyF8yRelease } from "./verify-f8y-release.ts";

const fixtureParent = "/tmp/opencode/rewrite-f8y-releases/metadata";
const scriptPath = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "verify-f8y-release.ts",
);
const repositoryRoot = NodePath.resolve(NodePath.dirname(scriptPath), "..");
const releaseDatePart = "20260912";
const validVersion = `1.2.3-f8y.${releaseDatePart}.7`;
const nextVersion = `1.2.3-f8y.${releaseDatePart}.8`;
const validReleaseDate = "2026-09-12T00:00:00.000Z";
const primaryKinds = ["dmg", "appImage", "apk", "darwin", "linux"] as const;
type PrimaryKind = (typeof primaryKinds)[number];
const checksumKinds = ["dmg", "appImage", "darwin", "linux"] as const;

const fixtureWriteOrder: ReadonlyArray<PrimaryKind> = ["linux", "appImage", "apk", "dmg", "darwin"];

type MetadataOptions = {
  readonly version?: string;
  readonly url?: string;
  readonly path?: string;
  readonly fileSha512?: string;
  readonly metadataSha512?: string;
  readonly size?: number;
  readonly includeReleaseDate?: boolean;
  readonly releaseDate?: string;
  readonly duplicateVersion?: string;
  readonly duplicateFileUrl?: string;
  readonly topLevelAdditionalField?: string;
  readonly fileAdditionalField?: string;
  readonly multipleFiles?: boolean;
  readonly blockMapSize?: number | string;
  readonly omitTopLevel?: "version" | "files" | "path" | "sha512";
  readonly omitFile?: "url" | "sha512" | "size";
};

type Fixture = {
  readonly directory: string;
  readonly version: string;
  readonly files: Readonly<Record<PrimaryKind, string>>;
  readonly metadataPath: string;
  readonly appImageDigest: string;
  readonly appImageSize: number;
  readonly primaryNames: readonly string[];
};

type CliResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(
    directories.map((directory) => NodeFSP.rm(directory, { force: true, recursive: true })),
  );
});

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function sha512Base64(contents: Uint8Array): string {
  return NodeCrypto.createHash("sha512").update(contents).digest("base64");
}

function makeDmgContents(): Buffer {
  const contents = Buffer.alloc(512, 0x41);
  contents.write("koly", contents.length - 512, "ascii");
  return contents;
}

function makeElfContents(options: { readonly appImage: boolean }): Buffer {
  const contents = Buffer.alloc(64, options.appImage ? 0x42 : 0x45);
  contents.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  if (options.appImage) {
    contents.set([0x41, 0x49, 2], 8);
  }
  contents.writeUInt16LE(2, 16);
  contents.writeUInt16LE(62, 18);
  contents.writeUInt32LE(1, 20);
  contents.writeUInt16LE(64, 40);
  return contents;
}

function appendAppImageBlockMap(contents: Uint8Array, blockMapSize: number): Buffer {
  const blockMap = Buffer.from([0x31, 0x42, 0x53, 0x64, 0x75, 0x86, 0x97, 0xa8]);
  if (blockMap.length !== blockMapSize) {
    throw new Error(`Unexpected block map fixture size: ${blockMap.length}`);
  }
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(blockMapSize, 0);
  return Buffer.concat([contents, blockMap, trailer]);
}

function makeApkContents(): Buffer {
  const contents = Buffer.alloc(30);
  contents.set([0x50, 0x4b, 0x03, 0x04], 0);
  contents.writeUInt16LE(20, 4);
  return contents;
}

function makeMachOContents(): Buffer {
  const contents = Buffer.alloc(32, 0x43);
  contents.writeUInt32LE(0xfeedfacf, 0);
  contents.writeUInt32LE(0x0100000c, 4);
  contents.writeUInt32LE(2, 12);
  contents.writeUInt32LE(0, 16);
  contents.writeUInt32LE(0, 20);
  return contents;
}

function metadataYaml(fixture: Fixture, options: MetadataOptions = {}): string {
  const lines: string[] = [];
  const omitTopLevel = options.omitTopLevel;
  const omitFile = options.omitFile;
  const url = options.url ?? fixture.files.appImage;
  const fileSha512 = options.fileSha512 ?? fixture.appImageDigest;
  const metadataSha512 = options.metadataSha512 ?? fixture.appImageDigest;
  const size = options.size ?? fixture.appImageSize;

  if (omitTopLevel !== "version") {
    lines.push(`version: ${yamlString(options.version ?? fixture.version)}`);
    if (options.duplicateVersion !== undefined) {
      lines.push(`version: ${yamlString(options.duplicateVersion)}`);
    }
  }

  if (omitTopLevel !== "files") {
    lines.push("files:");
    lines.push(omitFile === "url" ? "  -" : `  - url: ${yamlString(url)}`);
    if (omitFile !== "url" && options.duplicateFileUrl !== undefined) {
      lines.push(`    url: ${yamlString(options.duplicateFileUrl)}`);
    }
    if (omitFile !== "sha512") lines.push(`    sha512: ${yamlString(fileSha512)}`);
    if (omitFile !== "size") lines.push(`    size: ${String(size)}`);
    if (options.blockMapSize !== undefined) {
      const blockMapSize =
        typeof options.blockMapSize === "string"
          ? yamlString(options.blockMapSize)
          : String(options.blockMapSize);
      lines.push(`    blockMapSize: ${blockMapSize}`);
    }
    if (options.fileAdditionalField !== undefined) {
      lines.push(`    ${options.fileAdditionalField}: "unexpected"`);
    }
    if (options.multipleFiles) {
      lines.push(`  - url: ${yamlString(fixture.files.linux)}`);
      lines.push(`    sha512: ${yamlString("wrong-second-file")}`);
      lines.push("    size: 1");
    }
  }

  if (omitTopLevel !== "path") {
    lines.push(`path: ${yamlString(options.path ?? fixture.files.appImage)}`);
  }
  if (omitTopLevel !== "sha512") {
    lines.push(`sha512: ${yamlString(metadataSha512)}`);
  }
  if (options.includeReleaseDate !== false) {
    lines.push(`releaseDate: ${yamlString(options.releaseDate ?? validReleaseDate)}`);
  }
  if (options.topLevelAdditionalField !== undefined) {
    lines.push(`${options.topLevelAdditionalField}: "unexpected"`);
  }

  return `${lines.join("\n")}\n`;
}

async function createFixture(
  options: {
    readonly version?: string;
    readonly includeReleaseDate?: boolean;
  } = {},
): Promise<Fixture> {
  await NodeFSP.mkdir(fixtureParent, { recursive: true });
  const directory = await NodeFSP.mkdtemp(NodePath.join(fixtureParent, "verify-f8y-"));
  temporaryDirectories.push(directory);

  const version = options.version ?? validVersion;
  const files = {
    dmg: `T3-Code-${version}-arm64.dmg`,
    appImage: `T3-Code-${version}-x86_64.AppImage`,
    apk: `T3-Code-${version}-android.apk`,
    darwin: `t3-${version}-darwin-arm64`,
    linux: `t3-${version}-linux-x64`,
  } as const;
  const contents = {
    dmg: makeDmgContents(),
    appImage: makeElfContents({ appImage: true }),
    apk: makeApkContents(),
    darwin: makeMachOContents(),
    linux: makeElfContents({ appImage: false }),
  } as const;
  const primaryNames = [...primaryKinds.map((kind) => files[kind]), "f8y-linux.yml"].sort();
  const fixture: Fixture = {
    directory,
    version,
    files,
    metadataPath: NodePath.join(directory, "f8y-linux.yml"),
    appImageDigest: sha512Base64(contents.appImage),
    appImageSize: contents.appImage.length,
    primaryNames,
  };

  for (const kind of fixtureWriteOrder) {
    await NodeFSP.writeFile(NodePath.join(directory, files[kind]), contents[kind]);
  }
  const metadataOptions: MetadataOptions =
    options.includeReleaseDate === false ? { includeReleaseDate: false } : {};
  await NodeFSP.writeFile(fixture.metadataPath, metadataYaml(fixture, metadataOptions), "utf8");

  return fixture;
}

async function writeMetadata(fixture: Fixture, contents: string): Promise<void> {
  await NodeFSP.writeFile(fixture.metadataPath, contents, "utf8");
}

async function refreshAppImageMetadata(
  fixture: Fixture,
  contents: Uint8Array,
  options: Pick<MetadataOptions, "blockMapSize"> = {},
): Promise<void> {
  const digest = sha512Base64(contents);
  await writeMetadata(
    fixture,
    metadataYaml(fixture, {
      fileSha512: digest,
      metadataSha512: digest,
      size: contents.byteLength,
      ...options,
    }),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function expectedSidecarNames(fixture: Fixture): readonly string[] {
  return checksumKinds.map((kind) => `${fixture.files[kind]}.sha256`).sort();
}

function expectedReleaseFiles(fixture: Fixture): readonly string[] {
  return [...fixture.primaryNames, ...expectedSidecarNames(fixture)].sort();
}

function sidecarPath(fixture: Fixture, name: string): string {
  return NodePath.join(fixture.directory, `${name}.sha256`);
}

async function expectedSidecars(fixture: Fixture): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    checksumKinds.map(async (kind) => {
      const name = fixture.files[kind];
      const digest = NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(fixture.directory, name)))
        .digest("hex");
      return [`${name}.sha256`, `${digest}  ${name}\n`] as const;
    }),
  );
  return new Map(entries);
}

async function expectNoSidecars(fixture: Fixture): Promise<void> {
  for (const name of expectedSidecarNames(fixture)) {
    expect(await pathExists(NodePath.join(fixture.directory, name))).toBe(false);
  }
}

async function expectInitialFailure(
  fixture: Fixture,
  options: { readonly version?: string; readonly directory?: string } = {},
): Promise<void> {
  await expect(
    verifyF8yRelease({
      version: options.version ?? fixture.version,
      directory: options.directory ?? fixture.directory,
    }),
  ).rejects.toBeDefined();
  await expectNoSidecars(fixture);
}

async function runCli(args: ReadonlyArray<string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(NodeProcess.execPath, [scriptPath, ...args], {
      cwd: repositoryRoot,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ status: code ?? -1, stdout, stderr });
    });
  });
}

describe("verifyF8yRelease", () => {
  it("accepts six primary files and emits only F's four deterministic checksum sidecars", async () => {
    const fixture = await createFixture();
    const sidecars = await expectedSidecars(fixture);
    const releaseFiles = expectedReleaseFiles(fixture);

    expect(fixture.primaryNames).toHaveLength(6);
    expect(fixture.primaryNames).toEqual(
      [
        fixture.files.dmg,
        fixture.files.appImage,
        fixture.files.apk,
        fixture.files.darwin,
        fixture.files.linux,
        "f8y-linux.yml",
      ].sort(),
    );
    await expectNoSidecars(fixture);
    const first = await verifyF8yRelease({
      version: fixture.version,
      directory: fixture.directory,
    });

    expect(first).toEqual({ files: releaseFiles });
    for (const [name, contents] of sidecars) {
      expect(await NodeFSP.readFile(NodePath.join(fixture.directory, name), "utf8")).toBe(contents);
    }
    expect((await NodeFSP.readdir(fixture.directory)).sort()).toEqual(releaseFiles);

    const sidecarsBeforeRepeat = new Map(
      await Promise.all(
        [...sidecars.keys()].map(
          async (name) =>
            [name, await NodeFSP.readFile(NodePath.join(fixture.directory, name))] as const,
        ),
      ),
    );
    const second = await verifyF8yRelease({
      version: fixture.version,
      directory: fixture.directory,
    });

    expect(second).toEqual(first);
    for (const name of sidecars.keys()) {
      expect(await NodeFSP.readFile(NodePath.join(fixture.directory, name))).toEqual(
        sidecarsBeforeRepeat.get(name),
      );
    }
  });

  it("accepts metadata without the optional releaseDate", async () => {
    const fixture = await createFixture({ includeReleaseDate: false });

    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).resolves.toEqual({ files: expectedReleaseFiles(fixture) });
  });

  it("accepts a matching preexisting sidecar without changing its bytes", async () => {
    const fixture = await createFixture();
    const sidecars = await expectedSidecars(fixture);
    const sidecarName = `${fixture.files.dmg}.sha256`;
    const expectedContents = sidecars.get(sidecarName);
    expect(expectedContents).toBeDefined();
    if (expectedContents === undefined) return;
    await NodeFSP.writeFile(
      NodePath.join(fixture.directory, sidecarName),
      expectedContents,
      "utf8",
    );

    const before = await NodeFSP.readFile(NodePath.join(fixture.directory, sidecarName));
    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).resolves.toEqual({ files: expectedReleaseFiles(fixture) });
    expect(await NodeFSP.readFile(NodePath.join(fixture.directory, sidecarName))).toEqual(before);
  });

  it("accepts the maximum allowed run number", async () => {
    const fixture = await createFixture({ version: `1.2.3-f8y.${releaseDatePart}.2100000000` });

    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).resolves.toBeDefined();
  });

  it("rejects noncanonical versions, impossible dates, and out-of-range runs", async () => {
    const invalidVersions = [
      "1.2.3",
      `01.2.3-f8y.${releaseDatePart}.1`,
      `1.02.3-f8y.${releaseDatePart}.1`,
      `1.2.03-f8y.${releaseDatePart}.1`,
      `1.2.3-f8y.${releaseDatePart}.0`,
      `1.2.3-f8y.${releaseDatePart}.2100000001`,
      `1.2.3-f8y.${releaseDatePart}.01`,
      "1.2.3-f8y.20260230.1",
      "1.2.3-f8y.20261301.1",
      `1.2.3-f8y.${releaseDatePart}.1\n`,
      `v1.2.3-f8y.${releaseDatePart}.1`,
    ];

    for (const version of invalidVersions) {
      const fixture = await createFixture();
      await expectInitialFailure(fixture, { version });
    }
  });

  it("rejects a primary whose filename carries a different release version", async () => {
    const fixture = await createFixture();
    await NodeFSP.rename(
      NodePath.join(fixture.directory, fixture.files.dmg),
      NodePath.join(fixture.directory, `T3-Code-${nextVersion}-arm64.dmg`),
    );

    await expectInitialFailure(fixture);
  });

  it("rejects the legacy x64 AppImage name instead of the builder's x86_64 output", async () => {
    const fixture = await createFixture();
    await NodeFSP.rename(
      NodePath.join(fixture.directory, fixture.files.appImage),
      NodePath.join(fixture.directory, `T3-Code-${fixture.version}-x64.AppImage`),
    );

    await expectInitialFailure(fixture);
  });

  it("rejects every missing primary, including both standalone binaries", async () => {
    for (const kind of primaryKinds) {
      const fixture = await createFixture();
      await NodeFSP.rm(NodePath.join(fixture.directory, fixture.files[kind]));
      await expectInitialFailure(fixture);
    }
  });

  it("rejects missing metadata before creating the aggregate", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(fixture.metadataPath);

    await expectInitialFailure(fixture);
  });

  it("rejects unknown sidecars and the I-only aggregate checksum", async () => {
    const sidecars = [
      `${validVersion}.sha256`,
      `${validVersion}.sig`,
      "f8y-linux.yml.bak",
      "SHA256SUMS",
      `T3-Code-${validVersion}-android.apk.sha256`,
    ];

    for (const sidecar of sidecars) {
      const fixture = await createFixture();
      await NodeFSP.writeFile(NodePath.join(fixture.directory, sidecar), "sidecar\n", "utf8");
      await expectInitialFailure(fixture);
    }
  });

  it("rejects every wrong binary magic, architecture, and truncated header", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly kind: PrimaryKind;
      readonly mutate: (contents: Buffer) => Buffer;
    }> = [
      {
        label: "DMG koly magic",
        kind: "dmg",
        mutate: (contents) => {
          contents.write("nope", contents.length - 512, "ascii");
          return contents;
        },
      },
      {
        label: "DMG high-bit footer bytes",
        kind: "dmg",
        mutate: (contents) => {
          contents.set([0xeb, 0xef, 0xec, 0xf9], contents.length - 512);
          return contents;
        },
      },
      {
        label: "DMG truncated footer",
        kind: "dmg",
        mutate: (contents) => contents.subarray(0, 511),
      },
      {
        label: "AppImage ELF magic",
        kind: "appImage",
        mutate: (contents) => {
          contents[0] = 0;
          return contents;
        },
      },
      {
        label: "AppImage architecture",
        kind: "appImage",
        mutate: (contents) => {
          contents.writeUInt16LE(3, 18);
          return contents;
        },
      },
      {
        label: "AppImage truncated header",
        kind: "appImage",
        mutate: (contents) => contents.subarray(0, 63),
      },
      {
        label: "APK ZIP magic",
        kind: "apk",
        mutate: (contents) => {
          contents[0] = 0;
          return contents;
        },
      },
      {
        label: "APK truncated header",
        kind: "apk",
        mutate: (contents) => contents.subarray(0, 29),
      },
      {
        label: "Mach-O magic",
        kind: "darwin",
        mutate: (contents) => {
          contents.writeUInt32LE(0, 0);
          return contents;
        },
      },
      {
        label: "Mach-O architecture",
        kind: "darwin",
        mutate: (contents) => {
          contents.writeUInt32LE(7, 4);
          return contents;
        },
      },
      {
        label: "Mach-O truncated header",
        kind: "darwin",
        mutate: (contents) => contents.subarray(0, 31),
      },
      {
        label: "Linux ELF magic",
        kind: "linux",
        mutate: (contents) => {
          contents[0] = 0;
          return contents;
        },
      },
      {
        label: "Linux ELF architecture",
        kind: "linux",
        mutate: (contents) => {
          contents.writeUInt16LE(3, 18);
          return contents;
        },
      },
      {
        label: "Linux ELF truncated header",
        kind: "linux",
        mutate: (contents) => contents.subarray(0, 63),
      },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      const path = NodePath.join(fixture.directory, fixture.files[testCase.kind]);
      const contents = await NodeFSP.readFile(path);
      const mutated = testCase.mutate(Buffer.from(contents));
      await NodeFSP.writeFile(path, mutated);
      if (testCase.kind === "appImage") {
        await refreshAppImageMetadata(fixture, mutated);
      }
      await expectInitialFailure(fixture);
    }
  });

  it("accepts an AppImage type 1 marker when metadata matches the mutated bytes", async () => {
    const fixture = await createFixture();
    const path = NodePath.join(fixture.directory, fixture.files.appImage);
    const contents = Buffer.from(await NodeFSP.readFile(path));
    contents[10] = 1;
    await NodeFSP.writeFile(path, contents);
    await refreshAppImageMetadata(fixture, contents);

    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).resolves.toBeDefined();
  });

  it("accepts an app-builder blockMapSize bound to the AppImage trailer", async () => {
    const fixture = await createFixture();
    const path = NodePath.join(fixture.directory, fixture.files.appImage);
    const contents = appendAppImageBlockMap(await NodeFSP.readFile(path), 8);
    await NodeFSP.writeFile(path, contents);
    await refreshAppImageMetadata(fixture, contents, { blockMapSize: 8 });

    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).resolves.toEqual({ files: expectedReleaseFiles(fixture) });
    const sidecars = await expectedSidecars(fixture);
    expect(await NodeFSP.readFile(sidecarPath(fixture, fixture.files.appImage), "utf8")).toBe(
      sidecars.get(`${fixture.files.appImage}.sha256`),
    );
    expect((await NodeFSP.readdir(fixture.directory)).sort()).toEqual(
      expectedReleaseFiles(fixture),
    );
  });

  it("rejects invalid blockMapSize metadata before creating sidecars", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly blockMapSize: number | string;
    }> = [
      { label: "string", blockMapSize: "8" },
      { label: "zero", blockMapSize: 0 },
      { label: "fractional", blockMapSize: 8.5 },
      { label: "negative", blockMapSize: -1 },
      { label: "larger than file minus trailer", blockMapSize: 73 },
      { label: "unsafe integer", blockMapSize: Number.MAX_SAFE_INTEGER + 1 },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      const path = NodePath.join(fixture.directory, fixture.files.appImage);
      const contents = appendAppImageBlockMap(await NodeFSP.readFile(path), 8);
      await NodeFSP.writeFile(path, contents);
      await refreshAppImageMetadata(fixture, contents, {
        blockMapSize: testCase.blockMapSize,
      });

      await expect(
        verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
        testCase.label,
      ).rejects.toBeDefined();
      await expectNoSidecars(fixture);
    }
  });

  it("rejects a blockMapSize that disagrees with the AppImage trailer", async () => {
    const fixture = await createFixture();
    const path = NodePath.join(fixture.directory, fixture.files.appImage);
    const contents = appendAppImageBlockMap(await NodeFSP.readFile(path), 8);
    await NodeFSP.writeFile(path, contents);
    await refreshAppImageMetadata(fixture, contents, { blockMapSize: 7 });

    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).rejects.toBeDefined();
    await expectNoSidecars(fixture);
  });

  it("rejects an AppImage with a bad marker or type", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly mutate: (contents: Buffer) => void;
    }> = [
      {
        label: "marker",
        mutate: (contents) => contents.set([0x58, 0x58], 8),
      },
      {
        label: "type",
        mutate: (contents) => {
          contents[10] = 3;
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      const path = NodePath.join(fixture.directory, fixture.files.appImage);
      const contents = Buffer.from(await NodeFSP.readFile(path));
      testCase.mutate(contents);
      await NodeFSP.writeFile(path, contents);
      await refreshAppImageMetadata(fixture, contents);
      await expectInitialFailure(fixture);
    }
  });

  it("rejects a zero-length primary", async () => {
    const fixture = await createFixture();
    await NodeFSP.writeFile(NodePath.join(fixture.directory, fixture.files.dmg), Buffer.alloc(0));

    await expectInitialFailure(fixture);
  });

  it("rejects a primary replaced by a directory", async () => {
    const fixture = await createFixture();
    const primaryPath = NodePath.join(fixture.directory, fixture.files.appImage);
    await NodeFSP.rm(primaryPath);
    await NodeFSP.mkdir(primaryPath);

    await expectInitialFailure(fixture);
    expect((await NodeFSP.lstat(primaryPath)).isDirectory()).toBe(true);
  });

  it("rejects a checksum sidecar directory without replacing it", async () => {
    const fixture = await createFixture();
    const checksumPath = sidecarPath(fixture, fixture.files.dmg);
    await NodeFSP.mkdir(checksumPath);

    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).rejects.toBeDefined();
    expect((await NodeFSP.lstat(checksumPath)).isDirectory()).toBe(true);
  });

  it("rejects a symlinked primary instead of following it", async () => {
    const fixture = await createFixture();
    const targetFixture = await createFixture();
    const primaryPath = NodePath.join(fixture.directory, fixture.files.appImage);
    await NodeFSP.rm(primaryPath);
    await NodeFSP.symlink(
      NodePath.join(targetFixture.directory, targetFixture.files.appImage),
      primaryPath,
    );

    await expectInitialFailure(fixture);
    expect((await NodeFSP.lstat(primaryPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked checksum sidecar instead of following it", async () => {
    const fixture = await createFixture();
    const targetFixture = await createFixture();
    await verifyF8yRelease({ version: targetFixture.version, directory: targetFixture.directory });
    const checksumName = `${fixture.files.dmg}.sha256`;
    const checksumPath = NodePath.join(fixture.directory, checksumName);
    const targetPath = NodePath.join(targetFixture.directory, checksumName);
    await NodeFSP.symlink(targetPath, checksumPath);

    await expect(
      verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
    ).rejects.toBeDefined();
    expect((await NodeFSP.lstat(checksumPath)).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked input directory", async () => {
    const targetFixture = await createFixture();
    const linkPath = await NodeFSP.mkdtemp(NodePath.join(fixtureParent, "verify-f8y-link-"));
    temporaryDirectories.push(linkPath);
    await NodeFSP.rm(linkPath, { force: true, recursive: true });
    await NodeFSP.symlink(targetFixture.directory, linkPath, "dir");

    await expect(
      verifyF8yRelease({ version: targetFixture.version, directory: linkPath }),
    ).rejects.toBeDefined();
    expect((await NodeFSP.lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expectNoSidecars(targetFixture);
  });

  it("rejects wrong metadata version, path, URL, and external/traversal/query references", async () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly options: (fixture: Fixture) => MetadataOptions;
    }> = [
      {
        label: "version",
        options: () => ({ version: nextVersion }),
      },
      {
        label: "path",
        options: (fixture) => ({ path: `other-${fixture.files.appImage}` }),
      },
      {
        label: "URL",
        options: (fixture) => ({ url: `other-${fixture.files.appImage}` }),
      },
      {
        label: "external path",
        options: (fixture) => ({ path: `https://example.test/${fixture.files.appImage}` }),
      },
      {
        label: "traversal path",
        options: (fixture) => ({ path: `../${fixture.files.appImage}` }),
      },
      {
        label: "query path",
        options: (fixture) => ({ path: `${fixture.files.appImage}?download=1` }),
      },
      {
        label: "external URL",
        options: (fixture) => ({ url: `https://example.test/${fixture.files.appImage}` }),
      },
      {
        label: "traversal URL",
        options: (fixture) => ({ url: `../${fixture.files.appImage}` }),
      },
      {
        label: "query URL",
        options: (fixture) => ({ url: `${fixture.files.appImage}?download=1` }),
      },
    ];

    for (const testCase of cases) {
      const fixture = await createFixture();
      await writeMetadata(fixture, metadataYaml(fixture, testCase.options(fixture)));
      await expectInitialFailure(fixture);
    }
  });

  it("rejects incorrect size and either sha512 metadata field", async () => {
    const wrongSha512 = sha512Base64(Buffer.from("not-the-appimage"));
    const cases: ReadonlyArray<(fixture: Fixture) => MetadataOptions> = [
      (fixture) => ({ size: fixture.appImageSize + 1 }),
      () => ({ fileSha512: wrongSha512 }),
      () => ({ metadataSha512: wrongSha512 }),
    ];

    for (const options of cases) {
      const fixture = await createFixture();
      await writeMetadata(fixture, metadataYaml(fixture, options(fixture)));
      await expectInitialFailure(fixture);
    }
  });

  it("requires exactly one file mapping and all required metadata fields", async () => {
    const cases: ReadonlyArray<(fixture: Fixture) => MetadataOptions> = [
      () => ({ multipleFiles: true }),
      () => ({ omitTopLevel: "version" }),
      () => ({ omitTopLevel: "files" }),
      () => ({ omitTopLevel: "path" }),
      () => ({ omitTopLevel: "sha512" }),
      () => ({ omitFile: "url" }),
      () => ({ omitFile: "sha512" }),
      () => ({ omitFile: "size" }),
    ];

    for (const options of cases) {
      const fixture = await createFixture();
      await writeMetadata(fixture, metadataYaml(fixture, options(fixture)));
      await expectInitialFailure(fixture);
    }
  });

  it("rejects duplicate YAML keys at the top level and in a file mapping", async () => {
    const cases: ReadonlyArray<(fixture: Fixture) => MetadataOptions> = [
      () => ({ duplicateVersion: nextVersion }),
      (fixture) => ({ duplicateFileUrl: `other-${fixture.files.appImage}` }),
    ];

    for (const options of cases) {
      const fixture = await createFixture();
      await writeMetadata(fixture, metadataYaml(fixture, options(fixture)));
      await expectInitialFailure(fixture);
    }
  });

  it("rejects additional top-level and file-mapping fields", async () => {
    const cases: ReadonlyArray<(fixture: Fixture) => MetadataOptions> = [
      () => ({ topLevelAdditionalField: "extra" }),
      () => ({ fileAdditionalField: "extra" }),
    ];

    for (const options of cases) {
      const fixture = await createFixture();
      await writeMetadata(fixture, metadataYaml(fixture, options(fixture)));
      await expectInitialFailure(fixture);
    }
  });

  it("rejects malformed YAML and an invalid optional releaseDate", async () => {
    const malformed = await createFixture();
    await writeMetadata(malformed, "version: [unterminated\n");
    await expectInitialFailure(malformed);

    for (const releaseDate of [
      "not-a-timestamp",
      "2026-13-01T00:00:00.000Z",
      "2026-02-30T00:00:00.000Z",
      "2026-09-12T00:00:00.000",
    ]) {
      const fixture = await createFixture();
      await writeMetadata(fixture, metadataYaml(fixture, { releaseDate }));
      await expectInitialFailure(fixture);
    }
  });

  it("rejects a stale or corrupt sidecar without changing its bytes", async () => {
    const fixture = await createFixture();
    const sidecars = await expectedSidecars(fixture);
    await verifyF8yRelease({ version: fixture.version, directory: fixture.directory });
    const name = `${fixture.files.dmg}.sha256`;
    const checksumPath = NodePath.join(fixture.directory, name);
    const original = sidecars.get(name);
    expect(original).toBeDefined();
    if (original === undefined) return;

    const cases = [
      {
        label: "stale",
        contents: `0${original.slice(1)}`,
      },
      { label: "corrupt", contents: "not-a-checksum\n" },
    ];

    for (const testCase of cases) {
      await NodeFSP.writeFile(checksumPath, testCase.contents, "utf8");
      await expect(
        verifyF8yRelease({ version: fixture.version, directory: fixture.directory }),
      ).rejects.toBeDefined();
      expect(await NodeFSP.readFile(checksumPath, "utf8")).toBe(testCase.contents);
    }
  });

  it("runs the strict Node CLI successfully for a valid fixture", async () => {
    const fixture = await createFixture();
    const sidecars = await expectedSidecars(fixture);
    const result = await runCli(["--version", fixture.version, "--directory", fixture.directory]);

    expect(result.status, result.stderr).toBe(0);
    for (const [name, contents] of sidecars) {
      expect(await NodeFSP.readFile(NodePath.join(fixture.directory, name), "utf8")).toBe(contents);
    }
  });

  it("rejects missing, unknown, duplicate, and extra CLI arguments with exit 1", async () => {
    const fixture = await createFixture();
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly args: ReadonlyArray<string>;
    }> = [
      { label: "no arguments", args: [] },
      { label: "missing version", args: ["--directory", fixture.directory] },
      { label: "missing directory", args: ["--version", fixture.version] },
      { label: "missing version value", args: ["--version"] },
      { label: "missing directory value", args: ["--directory"] },
      {
        label: "unknown option",
        args: ["--version", fixture.version, "--directory", fixture.directory, "--unknown"],
      },
      {
        label: "duplicate version",
        args: [
          "--version",
          fixture.version,
          "--version",
          fixture.version,
          "--directory",
          fixture.directory,
        ],
      },
      {
        label: "duplicate directory",
        args: [
          "--version",
          fixture.version,
          "--directory",
          fixture.directory,
          "--directory",
          fixture.directory,
        ],
      },
      {
        label: "extra positional",
        args: ["--version", fixture.version, "--directory", fixture.directory, "extra"],
      },
    ];

    for (const testCase of cases) {
      const result = await runCli(testCase.args);
      expect(result.status, `${testCase.label}: ${result.stderr}`).toBe(1);
      await expectNoSidecars(fixture);
    }
  });

  it("returns exit 1 for a valid CLI invocation whose release fails verification", async () => {
    const fixture = await createFixture();
    await NodeFSP.writeFile(NodePath.join(fixture.directory, fixture.files.linux), Buffer.alloc(0));
    const result = await runCli(["--version", fixture.version, "--directory", fixture.directory]);

    expect(result.status, result.stderr).toBe(1);
    await expectNoSidecars(fixture);
  });
});
