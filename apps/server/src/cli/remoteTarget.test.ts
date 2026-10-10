import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { RemoteCliError, resolveCliTarget } from "./remoteTarget.ts";

const descriptor = {
  environmentId: EnvironmentId.make("target-environment"),
  label: "Target environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.1",
  capabilities: { repositoryIdentity: true },
} satisfies ExecutionEnvironmentDescriptor;

const fetchLayer = (run: (request: Request) => Response | Promise<Response>) => {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(
      String(input),
      init as globalThis.RequestInit,
    ) as unknown as Request;
    return (await run(request)) as unknown as globalThis.Response;
  }) as unknown as typeof globalThis.fetch;
  return FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
};

const withTemporaryBase = <A, E, R>(run: (baseDir: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "remote-target-" });
      return yield* run(baseDir);
    }),
  );

const provideNodeServices = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const installLocalRuntime = Effect.fn(function* (
  baseDir: string,
  environmentId = descriptor.environmentId,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
  yield* fileSystem.makeDirectory(derivedPaths.stateDir, { recursive: true });
  yield* fileSystem.writeFileString(derivedPaths.environmentIdPath, `${environmentId}\n`);
  const state = yield* makePersistedServerRuntimeState({
    config: { host: "127.0.0.1", devUrl: undefined },
    port: 3_773,
  });
  const runtimePath = path.join(baseDir, "userdata", "server-runtime.json");
  yield* persistServerRuntimeState({
    path: runtimePath,
    state,
  });
  return { runtimePath, state };
});

const installLocalDevRuntime = Effect.fn(function* (baseDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, new URL("http://localhost"));
  yield* fileSystem.makeDirectory(derivedPaths.stateDir, { recursive: true });
  yield* fileSystem.writeFileString(
    derivedPaths.environmentIdPath,
    `${descriptor.environmentId}\n`,
  );
  const state = yield* makePersistedServerRuntimeState({
    config: { host: "127.0.0.1", devUrl: new URL("http://localhost:5733") },
    port: 3_773,
  });
  const runtimePath = path.join(baseDir, "dev", "server-runtime.json");
  yield* persistServerRuntimeState({ path: runtimePath, state });
});

describe("remote CLI target resolution", () => {
  it.effect("normalizes a remote URL, fetches its descriptor, and isolates its token key", () => {
    const requests: Array<Request> = [];
    return provideNodeServices(
      withTemporaryBase((baseDir) =>
        Effect.gen(function* () {
          const target = yield* resolveCliTarget({
            host: "https://remote.example/project?route=blue",
            baseDir,
          });

          assert.equal(target.kind, "remote");
          assert.equal(target.httpBaseUrl, "https://remote.example");
          assert.equal(target.tokenStateDirectory, `${baseDir}/remote-cli`);
          assert.equal(target.tokenKey, "https://remote.example");
          assert.deepEqual(target.environment, descriptor);
          assert.equal(requests[0]?.url, "https://remote.example/.well-known/t3/environment");
        }),
      ).pipe(
        Effect.provide(
          fetchLayer((request) => {
            requests.push(request);
            return jsonResponse(descriptor);
          }),
        ),
      ),
    );
  });

  it.effect("rejects invalid remote hosts without making a request", () => {
    const requests: Array<Request> = [];
    return provideNodeServices(
      resolveCliTarget({ host: "ftp://remote.example", baseDir: "/unused" }).pipe(Effect.flip),
    ).pipe(
      Effect.provide(
        fetchLayer((request) => {
          requests.push(request);
          return jsonResponse(descriptor);
        }),
      ),
      Effect.map((error) => {
        assert.instanceOf(error, RemoteCliError);
        assert.equal(error.reason, "invalid-host");
        assert.lengthOf(requests, 0);
        return error;
      }),
    );
  });

  it.effect(
    "pins a local server config only after live PID, identity, and descriptor checks",
    () => {
      const requests: Array<Request> = [];
      return provideNodeServices(
        withTemporaryBase((baseDir) =>
          Effect.gen(function* () {
            yield* installLocalRuntime(baseDir);
            const target = yield* resolveCliTarget({ baseDir });

            assert.equal(target.kind, "local");
            if (target.kind !== "local") throw new Error("Expected a local target.");
            assert.equal(target.httpBaseUrl, "http://127.0.0.1:3773");
            assert.equal(target.tokenStateDirectory, `${baseDir}/userdata/local-cli`);
            assert.equal(target.tokenKey, "environment:target-environment");
            assert.deepEqual(target.environment, descriptor);
            assert.equal(target.serverConfig.baseDir, baseDir);
            assert.equal(target.serverConfig.stateDir, `${baseDir}/userdata`);
            assert.equal(
              target.serverConfig.serverRuntimeStatePath,
              `${baseDir}/userdata/server-runtime.json`,
            );
            assert.equal(requests[0]?.url, "http://127.0.0.1:3773/.well-known/t3/environment");
          }),
        ).pipe(
          Effect.provide(
            fetchLayer((request) => {
              requests.push(request);
              return jsonResponse(descriptor);
            }),
          ),
        ),
      );
    },
  );

  it.effect("pins the discovered dev state directory and recorded web URL", () => {
    return provideNodeServices(
      withTemporaryBase((baseDir) =>
        Effect.gen(function* () {
          yield* installLocalDevRuntime(baseDir);
          const target = yield* resolveCliTarget({ baseDir });
          assert.equal(target.kind, "local");
          if (target.kind !== "local") throw new Error("Expected a local target.");

          assert.equal(target.serverConfig.stateDir, `${baseDir}/dev`);
          assert.equal(target.serverConfig.devUrl?.toString(), "http://localhost:5733/");
          assert.equal(
            target.serverConfig.serverRuntimeStatePath,
            `${baseDir}/dev/server-runtime.json`,
          );
        }),
      ).pipe(Effect.provide(fetchLayer(() => jsonResponse(descriptor)))),
    );
  });

  it.effect("distinguishes stale servers from live servers with another identity", () =>
    provideNodeServices(
      withTemporaryBase((baseDir) =>
        Effect.gen(function* () {
          const installed = yield* installLocalRuntime(baseDir, "different-environment");
          const mismatch = yield* resolveCliTarget({ baseDir }).pipe(Effect.flip);
          assert.instanceOf(mismatch, RemoteCliError);
          assert.equal(mismatch.reason, "local-server-mismatch");

          yield* persistServerRuntimeState({
            path: installed.runtimePath,
            state: { ...installed.state, pid: 4_194_305 },
          });
          const notRunning = yield* resolveCliTarget({ baseDir }).pipe(Effect.flip);
          assert.instanceOf(notRunning, RemoteCliError);
          assert.equal(notRunning.reason, "local-server-not-running");
        }),
      ).pipe(Effect.provide(fetchLayer(() => jsonResponse(descriptor)))),
    ),
  );

  it.effect("suppresses malformed-state diagnostics without mutating the source file", () => {
    const secretSentinel = "runtime-state-secret-sentinel";
    const emittedLogs: Array<string> = [];
    const logger = Logger.make<unknown, void>((options) => {
      emittedLogs.push(`${String(options.message)}\n${Cause.pretty(options.cause)}`);
    });

    return provideNodeServices(
      withTemporaryBase((baseDir) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const runtimePath = path.join(baseDir, "userdata", "server-runtime.json");
          const runtimeContents = `{"version":1,"pid":${String(
            process.pid,
          )},"port":"${secretSentinel}","origin":"http://127.0.0.1:3773","startedAt":"2026-06-20T00:00:00.000Z"}\n`;
          yield* fileSystem.makeDirectory(path.dirname(runtimePath), { recursive: true });
          yield* fileSystem.writeFileString(runtimePath, runtimeContents);

          const error = yield* resolveCliTarget({ baseDir }).pipe(Effect.flip);
          assert.instanceOf(error, RemoteCliError);
          assert.equal(error.reason, "local-server-not-running");
          assert.notInclude(error.message, secretSentinel);
          assert.notInclude(String(error), secretSentinel);
          assert.notInclude(emittedLogs.join("\n"), secretSentinel);
          assert.lengthOf(emittedLogs, 0);
          assert.equal(yield* fileSystem.readFileString(runtimePath), runtimeContents);
          assert.deepEqual(yield* fileSystem.readDirectory(baseDir), ["userdata"]);
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            fetchLayer(() => jsonResponse(descriptor)),
            Logger.layer([logger]),
            Layer.succeed(References.MinimumLogLevel, "Trace"),
          ),
        ),
      ),
    );
  });
});
