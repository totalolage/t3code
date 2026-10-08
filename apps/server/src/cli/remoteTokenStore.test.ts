import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  readRemoteToken,
  RemoteTokenStoreError,
  type StoredRemoteToken as StoredRemoteTokenType,
  writeRemoteToken,
} from "./remoteTokenStore.ts";

const posixHost = HostProcessPlatform.defaultValue() !== "win32";
const tokenDirectory = (path: Path.Path, stateDirectory: string) =>
  path.join(stateDirectory, "tokens");
const tokenPath = (path: Path.Path, stateDirectory: string, key: string) =>
  path.join(tokenDirectory(path, stateDirectory), `${encodeURIComponent(key)}.json`);

const withTemporaryHome = <A, E, R>(run: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "remote-token-" });
      return yield* run(baseDir);
    }),
  );

const provideNodeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const storedToken = {
  accessToken: "remote-access-token",
  expiresAtEpochMs: 1_900_000_000_000,
} satisfies StoredRemoteTokenType;

it.effect("reads the existing F filename and two-field JSON shape", () =>
  provideNodeServices(
    withTemporaryHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(baseDir, "remote-cli");
        const key = "https://legacy.example.test";
        const directory = tokenDirectory(path, stateDirectory);
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        yield* fileSystem.writeFileString(
          tokenPath(path, stateDirectory, key),
          '{"accessToken":"legacy-token","expiresAtEpochMs":1800000000000}',
        );

        const result = yield* readRemoteToken(stateDirectory, key);
        if (Option.isNone(result)) throw new Error("Expected a stored remote token.");
        assert.deepStrictEqual(result.value, {
          accessToken: "legacy-token",
          expiresAtEpochMs: 1_800_000_000_000,
        });
      }),
    ),
  ),
);

it.effect("returns None when a token file is missing", () =>
  provideNodeServices(
    withTemporaryHome((baseDir) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const stateDirectory = path.join(baseDir, "remote-cli");
        const result = yield* readRemoteToken(stateDirectory, "environment:missing");
        assert.isTrue(Option.isNone(result));
      }),
    ),
  ),
);

it.effect("rejects malformed and invalid records with a redacted error", () =>
  provideNodeServices(
    withTemporaryHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(baseDir, "remote-cli");
        const directory = tokenDirectory(path, stateDirectory);
        yield* fileSystem.makeDirectory(directory, { recursive: true });
        const cases = [
          ["malformed", '{"accessToken":"secret-body",', "secret-body"],
          ["empty", '{"accessToken":"","expiresAtEpochMs":1}', ""],
          ["infinite", '{"accessToken":"secret-token","expiresAtEpochMs":1e999}', "secret-token"],
        ] as const;

        for (const [key, contents, secret] of cases) {
          yield* fileSystem.writeFileString(tokenPath(path, stateDirectory, key), contents);
          const error = yield* readRemoteToken(stateDirectory, key).pipe(Effect.flip);
          assert.instanceOf(error, RemoteTokenStoreError);
          assert.equal(error.message, "Could not read the remote CLI access token.");
          assert.notInclude(error.message, baseDir);
          if (secret.length > 0) assert.notInclude(error.message, secret);
          assert.notInclude(error.message, contents);
        }
      }),
    ),
  ),
);

it.effect("writes private directories and atomically replaces a permissive file", () =>
  provideNodeServices(
    withTemporaryHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const pathService = yield* Path.Path;
        const stateDirectory = pathService.join(baseDir, "remote-cli");
        const key = "https://remote.example.test/api";
        const directory = tokenDirectory(pathService, stateDirectory);
        const path = tokenPath(pathService, stateDirectory, key);
        yield* writeRemoteToken(stateDirectory, key, storedToken);
        assert.deepStrictEqual(
          yield* readRemoteToken(stateDirectory, key),
          Option.some(storedToken),
        );

        if (posixHost) {
          assert.equal((yield* fileSystem.stat(stateDirectory)).mode & 0o777, 0o700);
          assert.equal((yield* fileSystem.stat(directory)).mode & 0o777, 0o700);
          assert.equal((yield* fileSystem.stat(path)).mode & 0o777, 0o600);
        }

        if (posixHost) {
          yield* fileSystem.chmod(stateDirectory, 0o755);
          yield* fileSystem.chmod(directory, 0o755);
          yield* fileSystem.chmod(path, 0o644);
        }
        const replacement = { ...storedToken, accessToken: "replacement-token" };
        yield* writeRemoteToken(stateDirectory, key, replacement);
        assert.deepStrictEqual(
          yield* readRemoteToken(stateDirectory, key),
          Option.some(replacement),
        );

        if (posixHost) {
          assert.equal((yield* fileSystem.stat(stateDirectory)).mode & 0o777, 0o700);
          assert.equal((yield* fileSystem.stat(directory)).mode & 0o777, 0o700);
          assert.equal((yield* fileSystem.stat(path)).mode & 0o777, 0o600);
        }
      }),
    ),
  ),
);

it.effect("keeps independent keys separate and leaves no temporary files", () =>
  provideNodeServices(
    withTemporaryHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDirectory = path.join(baseDir, "remote-cli");
        const keyA = "https://remote.example.test";
        const keyB = "environment:environment-2";
        yield* writeRemoteToken(stateDirectory, keyA, storedToken);
        yield* writeRemoteToken(stateDirectory, keyB, {
          ...storedToken,
          accessToken: "second-token",
        });

        assert.deepStrictEqual(
          yield* readRemoteToken(stateDirectory, keyA),
          Option.some(storedToken),
        );
        assert.deepStrictEqual(
          yield* readRemoteToken(stateDirectory, keyB),
          Option.some({ ...storedToken, accessToken: "second-token" }),
        );
        const names = yield* fileSystem.readDirectory(tokenDirectory(path, stateDirectory));
        assert.deepStrictEqual(
          names.sort(),
          [`${encodeURIComponent(keyA)}.json`, `${encodeURIComponent(keyB)}.json`].sort(),
        );
      }),
    ),
  ),
);

it.effect("keeps legacy local token files separate from remote token files", () =>
  provideNodeServices(
    withTemporaryHome((baseDir) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const remoteStateDirectory = path.join(baseDir, "remote-cli");
        const localStateDirectory = path.join(baseDir, "userdata", "local-cli");
        const key = "environment:fixture";
        const localDirectory = tokenDirectory(path, localStateDirectory);
        yield* fileSystem.makeDirectory(localDirectory, { recursive: true });
        yield* fileSystem.writeFileString(
          tokenPath(path, localStateDirectory, key),
          '{"accessToken":"legacy-local-token","expiresAtEpochMs":1800000000000}',
        );

        assert.deepStrictEqual(
          yield* readRemoteToken(localStateDirectory, key),
          Option.some({ accessToken: "legacy-local-token", expiresAtEpochMs: 1_800_000_000_000 }),
        );
        assert.isTrue(Option.isNone(yield* readRemoteToken(remoteStateDirectory, key)));

        yield* writeRemoteToken(remoteStateDirectory, key, storedToken);
        assert.deepStrictEqual(
          yield* readRemoteToken(localStateDirectory, key),
          Option.some({ accessToken: "legacy-local-token", expiresAtEpochMs: 1_800_000_000_000 }),
        );
        assert.deepStrictEqual(
          yield* readRemoteToken(remoteStateDirectory, key),
          Option.some(storedToken),
        );
      }),
    ),
  ),
);
