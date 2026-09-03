// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Bun's single-file compile does not preserve the dynamically-resolved
 * @ff-labs/fff-node platform packages, so the matching native library is
 * embedded as an asset and materialized at startup (see
 * apps/server/src/standaloneFffNative.ts). Release builders are
 * self-hosted per target, so the host-installed optional package supplies
 * the library for its matching compile target.
 */
export const FFF_NATIVE_LIBRARY_BY_TARGET = {
  "bun-darwin-arm64": { npmPackage: "@ff-labs/fff-bin-darwin-arm64", filename: "libfff_c.dylib" },
  "bun-linux-x64-baseline": {
    npmPackage: "@ff-labs/fff-bin-linux-x64-gnu",
    filename: "libfff_c.so",
  },
} as const;

export type StandaloneBinaryTarget = keyof typeof FFF_NATIVE_LIBRARY_BY_TARGET;

export function resolveFffNativeLibrary(input: {
  readonly target: StandaloneBinaryTarget;
  readonly serverDir: string;
  readonly exists?: (path: string) => boolean;
  readonly fffNodePackageDir?: string;
}): { readonly filePath: string; readonly filename: string } {
  const native = FFF_NATIVE_LIBRARY_BY_TARGET[input.target];
  const exists = input.exists ?? NodeFS.existsSync;
  // The platform package sits next to the installed fff-node package, both in
  // pnpm's virtual store and in a hoisted node_modules layout. Resolve the
  // real path so symlinked installs land in the right sibling directory.
  const fffNodePackageDir =
    input.fffNodePackageDir ??
    NodeFS.realpathSync(NodePath.join(input.serverDir, "node_modules", "@ff-labs", "fff-node"));
  const packageName = native.npmPackage.slice("@ff-labs/".length);
  const filePath = NodePath.join(fffNodePackageDir, "..", packageName, native.filename);
  if (!exists(filePath)) {
    throw new Error(
      `The fff native library for ${input.target} is missing: ${filePath}. Install dependencies so the platform package ${native.npmPackage} is present.`,
    );
  }
  return { filePath, filename: native.filename };
}
