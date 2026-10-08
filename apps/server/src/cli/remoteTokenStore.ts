import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const StoredRemoteToken = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expiresAtEpochMs: Schema.Finite,
});
export type StoredRemoteToken = typeof StoredRemoteToken.Type;

const StoredRemoteTokenJson = Schema.fromJsonString(StoredRemoteToken);
const decodeStoredRemoteToken = Schema.decodeUnknownEffect(StoredRemoteTokenJson);
const encodeStoredRemoteToken = Schema.encodeEffect(StoredRemoteTokenJson);

export class RemoteTokenStoreError extends Schema.TaggedError<RemoteTokenStoreError>()(
  "RemoteTokenStoreError",
  { operation: Schema.Literals(["read", "write"]) },
) {
  override get message(): string {
    return `Could not ${this.operation} the remote CLI access token.`;
  }
}

const resolvePaths = (path: Path.Path, stateDirectory: string, key: string) => {
  const tokenDirectory = path.join(stateDirectory, "tokens");
  const tokenPath = path.join(tokenDirectory, `${encodeURIComponent(key)}.json`);
  return { stateDirectory, tokenDirectory, tokenPath };
};

export const readRemoteToken = Effect.fn("remoteTokenStore.readRemoteToken")(function* (
  stateDirectory: string,
  key: string,
): Effect.fn.Return<
  Option.Option<StoredRemoteToken>,
  RemoteTokenStoreError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { tokenPath } = resolvePaths(path, stateDirectory, key);
  const raw = yield* fileSystem.readFileString(tokenPath).pipe(
    Effect.map(Option.some),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(new RemoteTokenStoreError({ operation: "read" })),
    ),
  );
  if (Option.isNone(raw)) return Option.none<StoredRemoteToken>();

  yield* fileSystem
    .chmod(tokenPath, 0o600)
    .pipe(Effect.mapError(() => new RemoteTokenStoreError({ operation: "read" })));
  return yield* decodeStoredRemoteToken(raw.value.trim()).pipe(
    Effect.map(Option.some),
    Effect.mapError(() => new RemoteTokenStoreError({ operation: "read" })),
  );
});

export const writeRemoteToken = Effect.fn("remoteTokenStore.writeRemoteToken")(function* (
  stateDirectory: string,
  key: string,
  token: StoredRemoteToken,
): Effect.fn.Return<
  void,
  RemoteTokenStoreError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const { tokenDirectory, tokenPath } = resolvePaths(path, stateDirectory, key);
  const encoded = yield* encodeStoredRemoteToken(token).pipe(
    Effect.mapError(() => new RemoteTokenStoreError({ operation: "write" })),
  );

  yield* fileSystem
    .makeDirectory(tokenDirectory, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(() => new RemoteTokenStoreError({ operation: "write" })));
  yield* fileSystem
    .chmod(stateDirectory, 0o700)
    .pipe(Effect.mapError(() => new RemoteTokenStoreError({ operation: "write" })));
  yield* fileSystem
    .chmod(tokenDirectory, 0o700)
    .pipe(Effect.mapError(() => new RemoteTokenStoreError({ operation: "write" })));

  const temporaryPath = `${tokenPath}.${yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => new RemoteTokenStoreError({ operation: "write" })),
  )}.tmp`;
  let temporaryFileCreated = false;
  const write = Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fileSystem.open(temporaryPath, { flag: "wx", mode: 0o600 });
      temporaryFileCreated = true;
      yield* file.writeAll(new TextEncoder().encode(`${encoded}\n`));
      yield* file.sync;
    }),
  ).pipe(
    Effect.andThen(fileSystem.chmod(temporaryPath, 0o600)),
    Effect.andThen(fileSystem.rename(temporaryPath, tokenPath)),
    Effect.andThen(fileSystem.chmod(tokenPath, 0o600)),
    Effect.mapError(() => new RemoteTokenStoreError({ operation: "write" })),
  );

  yield* write.pipe(
    Effect.catch((error) =>
      temporaryFileCreated
        ? fileSystem
            .remove(temporaryPath, { force: true })
            .pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))
        : Effect.fail(error),
    ),
  );
});
