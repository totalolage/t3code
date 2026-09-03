import { assert, it } from "@effect/vitest";

import {
  FFF_NATIVE_LIBRARY_BY_TARGET,
  resolveFffNativeLibrary,
} from "./standaloneNativeLibrary.ts";

const serverDir = "/repo/apps/server";

it("targets the platform optional packages for both release artifacts", () => {
  assert.deepEqual(FFF_NATIVE_LIBRARY_BY_TARGET["bun-darwin-arm64"], {
    npmPackage: "@ff-labs/fff-bin-darwin-arm64",
    filename: "libfff_c.dylib",
  });
  assert.deepEqual(FFF_NATIVE_LIBRARY_BY_TARGET["bun-linux-x64-baseline"], {
    npmPackage: "@ff-labs/fff-bin-linux-x64-gnu",
    filename: "libfff_c.so",
  });
});

it("resolves the native library next to the installed fff-node package", () => {
  const resolved = resolveFffNativeLibrary({
    target: "bun-linux-x64-baseline",
    serverDir,
    exists: (path) => path === "/store/@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so",
    fffNodePackageDir: "/store/@ff-labs/fff-node",
  });

  assert.deepEqual(resolved, {
    filePath: "/store/@ff-labs/fff-bin-linux-x64-gnu/libfff_c.so",
    filename: "libfff_c.so",
  });
});

it("fails with the remediation when the platform package is missing", () => {
  assert.throws(
    () =>
      resolveFffNativeLibrary({
        target: "bun-darwin-arm64",
        serverDir,
        exists: () => false,
        fffNodePackageDir: "/store/@ff-labs/fff-node",
      }),
    /@ff-labs\/fff-bin-darwin-arm64/u,
  );
});
