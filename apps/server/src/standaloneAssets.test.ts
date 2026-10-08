// @effect-diagnostics nodeBuiltinImport:off - tests exercise the filesystem materialization boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { embeddedWebAssets } from "./standaloneAssetManifest.ts";
import { materializeStandaloneWebAssets, resolveStandaloneStaticDir } from "./standaloneAssets.ts";

const makeFixtureDirectory = (): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-standalone-assets-fixture-"));

const standaloneOutputDirectories = (): Set<string> =>
  new Set(
    NodeFS.readdirSync(NodeOS.tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("t3-standalone-web-"))
      .map((entry) => NodePath.join(NodeOS.tmpdir(), entry.name)),
  );

describe("standalone web assets", () => {
  it("keeps the default manifest empty without creating a directory", () => {
    const before = standaloneOutputDirectories();

    expect(embeddedWebAssets).toEqual({});
    expect(resolveStandaloneStaticDir()).toBeUndefined();
    expect(standaloneOutputDirectories()).toEqual(before);
  });

  it("materializes nested assets with byte-exact contents", () => {
    const fixtureDirectory = makeFixtureDirectory();
    let outputDirectory: string | undefined;
    try {
      const indexBytes = Buffer.from([0, 60, 104, 116, 109, 108, 62, 255]);
      const nestedBytes = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
      const indexSource = NodePath.join(fixtureDirectory, "index.html");
      const nestedSource = NodePath.join(fixtureDirectory, "nested.bin");
      NodeFS.writeFileSync(indexSource, indexBytes);
      NodeFS.writeFileSync(nestedSource, nestedBytes);

      outputDirectory = materializeStandaloneWebAssets({
        "index.html": indexSource,
        "assets/icons/nested.bin": nestedSource,
      });
      expect(outputDirectory).toBeDefined();
      if (outputDirectory === undefined) throw new Error("Expected an output directory.");

      expect(NodeFS.readFileSync(NodePath.join(outputDirectory, "index.html"))).toEqual(indexBytes);
      expect(
        NodeFS.readFileSync(NodePath.join(outputDirectory, "assets/icons/nested.bin")),
      ).toEqual(nestedBytes);
    } finally {
      if (outputDirectory !== undefined) {
        NodeFS.rmSync(outputDirectory, { force: true, recursive: true });
      }
      NodeFS.rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it("requires index.html and rejects traversal or absolute paths before writing", () => {
    const fixtureDirectory = makeFixtureDirectory();
    const source = NodePath.join(fixtureDirectory, "asset.js");
    NodeFS.writeFileSync(source, "asset");
    const before = standaloneOutputDirectories();
    try {
      expect(() => materializeStandaloneWebAssets({ "asset.js": source })).toThrow(/index\.html/u);

      for (const assetPath of [
        "../outside.js",
        "nested/../../outside.js",
        "/outside.js",
        "C:\\outside.js",
      ]) {
        expect(() =>
          materializeStandaloneWebAssets({ "index.html": source, [assetPath]: source }),
        ).toThrow(/Invalid standalone web asset path/u);
      }

      expect(standaloneOutputDirectories()).toEqual(before);
    } finally {
      NodeFS.rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });

  it("removes a partial output directory when an embedded file cannot be copied", () => {
    const fixtureDirectory = makeFixtureDirectory();
    const indexSource = NodePath.join(fixtureDirectory, "index.html");
    const missingSource = NodePath.join(fixtureDirectory, "missing.js");
    NodeFS.writeFileSync(indexSource, "index");
    const before = standaloneOutputDirectories();
    try {
      expect(() =>
        materializeStandaloneWebAssets({
          "index.html": indexSource,
          "assets/missing.js": missingSource,
        }),
      ).toThrow();

      expect(standaloneOutputDirectories()).toEqual(before);
    } finally {
      NodeFS.rmSync(fixtureDirectory, { force: true, recursive: true });
    }
  });
});
