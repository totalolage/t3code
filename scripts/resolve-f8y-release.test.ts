import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  InvalidF8yReleaseBaseVersionError,
  readF8yReleaseBaseVersion,
  resolveF8yReleaseMetadata,
  resolveF8yReleaseTargetVersion,
} from "./resolve-f8y-release.ts";

it.effect("increments the stable patch used for f8y release versions", () =>
  Effect.gen(function* () {
    assert.equal(yield* resolveF8yReleaseTargetVersion("0.0.28"), "0.0.29");
    assert.equal(yield* resolveF8yReleaseTargetVersion("1.2.3-beta.4+build.1"), "1.2.4");
  }),
);

it.effect("rejects invalid checked-in package versions", () =>
  Effect.gen(function* () {
    const error = yield* resolveF8yReleaseTargetVersion("f8y").pipe(Effect.flip);
    assert.instanceOf(error, InvalidF8yReleaseBaseVersionError);
    assert.equal(error.version, "f8y");
  }),
);

it("creates shared desktop and Android release metadata", () => {
  assert.deepStrictEqual(resolveF8yReleaseMetadata("0.0.29", "20260720", 42, "abcdef1234567890"), {
    baseVersion: "0.0.29",
    version: "0.0.29-f8y.20260720.42",
    tag: "v0.0.29-f8y.20260720.42",
    name: "T3 Code f8y 0.0.29-f8y.20260720.42 (abcdef123456)",
    shortSha: "abcdef123456",
    androidVersionCode: 42,
  });
});

it.layer(NodeServices.layer)("readF8yReleaseBaseVersion", (it) => {
  it.effect("reads and increments the desktop package version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "f8y-release-" });
      const packagePath = path.join(root, "apps/desktop/package.json");
      yield* fs.makeDirectory(path.dirname(packagePath), { recursive: true });
      yield* fs.writeFileString(packagePath, '{"version":"2.3.4"}');

      assert.equal(yield* readF8yReleaseBaseVersion(root), "2.3.5");
    }),
  );
});
