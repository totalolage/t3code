import * as Cause from "effect/Cause";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ServerConfig,
} from "@t3tools/contracts";

import { createThreadVisibilityActions } from "./thread-visibility-action";
import {
  threadHidingUnavailableReason,
  type ThreadHidingPresentation,
} from "./thread-hiding-support";

function thread(environmentId: string, id: string) {
  return { environmentId: EnvironmentId.make(environmentId), id: ThreadId.make(id) } as const;
}

function serverConfig(
  environmentId: EnvironmentId,
  threadHiding: boolean | undefined,
): ServerConfig {
  const capabilities = {
    repositoryIdentity: false,
    ...(threadHiding === undefined ? {} : { threadHiding }),
  };
  return {
    environment: {
      environmentId,
      label: `Environment ${environmentId}`,
      platform: { os: "linux", arch: "x64", machine: "server" },
      serverVersion: "test",
      capabilities,
    },
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["bearer-access-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/repo",
    keybindingsConfigPath: "/repo/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/tmp/t3-logs",
      localTracingEnabled: false,
      otlpLogsEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

function presentation(
  environmentId: EnvironmentId,
  phase: EnvironmentPresentation["connection"]["phase"],
  threadHiding: boolean | undefined,
): ThreadHidingPresentation {
  return {
    connection: { phase, error: null, traceId: null },
    serverConfig: serverConfig(environmentId, threadHiding),
  };
}

describe("thread visibility actions", () => {
  it.each([
    ["hide", "hideThread"],
    ["unhide", "unhideThread"],
  ] as const)(
    "dispatches the scoped %s input and refreshes after success",
    async (action, method) => {
      const mutation = vi.fn(async () => AsyncResult.success(undefined));
      const refresh = vi.fn();
      const actions = createThreadVisibilityActions({
        hide: mutation,
        unhide: mutation,
        getUnavailableReason: () => null,
        onUnavailable: vi.fn(),
        onFailure: vi.fn(),
        onSucceeded: refresh,
      });
      const target = thread("environment-a", "thread-1");

      await expect(actions[method](target)).resolves.toBe(true);
      expect(mutation).toHaveBeenCalledWith({
        environmentId: "environment-a",
        input: { threadId: "thread-1" },
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(refresh).toHaveBeenCalledWith("environment-a");
      expect(action).toBe(method === "hideThread" ? "hide" : "unhide");
    },
  );

  it("reports failures without refreshing and releases the scoped key", async () => {
    const failure = new Error("Disconnected");
    const mutation = vi
      .fn()
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(failure)))
      .mockResolvedValueOnce(AsyncResult.success(undefined));
    const onFailure = vi.fn();
    const refresh = vi.fn();
    const actions = createThreadVisibilityActions({
      hide: mutation,
      unhide: mutation,
      getUnavailableReason: () => null,
      onUnavailable: vi.fn(),
      onFailure,
      onSucceeded: refresh,
    });
    const target = thread("environment-a", "thread-1");

    await expect(actions.hideThread(target)).resolves.toBe(false);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("hide", expect.anything());
    expect(refresh).not.toHaveBeenCalled();

    await expect(actions.hideThread(target)).resolves.toBe(true);
    expect(mutation).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledWith("environment-a");
  });

  it("deduplicates a thread while allowing different scoped IDs to run", async () => {
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof AsyncResult.success>>>();
    const mutation = vi.fn((_input: unknown) => pending.promise);
    const actions = createThreadVisibilityActions({
      hide: mutation,
      unhide: mutation,
      getUnavailableReason: () => null,
      onUnavailable: vi.fn(),
      onFailure: vi.fn(),
      onSucceeded: vi.fn(),
    });

    const first = actions.hideThread(thread("environment-a", "thread-1"));
    await Promise.resolve();
    await expect(actions.unhideThread(thread("environment-a", "thread-1"))).resolves.toBe(false);
    const otherEnvironment = actions.unhideThread(thread("environment-b", "thread-1"));
    const otherThread = actions.hideThread(thread("environment-a", "thread-2"));
    expect(mutation).toHaveBeenCalledTimes(3);

    pending.resolve(AsyncResult.success(undefined));
    await expect(first).resolves.toBe(true);
    await expect(otherEnvironment).resolves.toBe(true);
    await expect(otherThread).resolves.toBe(true);
  });

  it("blocks unavailable targets before haptics, RPC, and refresh", async () => {
    const reason = "Update this environment’s server to hide or unhide threads.";
    const mutation = vi.fn(async () => AsyncResult.success(undefined));
    const onStarted = vi.fn();
    const onUnavailable = vi.fn();
    const refresh = vi.fn();
    const actions = createThreadVisibilityActions({
      hide: mutation,
      unhide: mutation,
      getUnavailableReason: () => reason,
      onUnavailable,
      onStarted,
      onFailure: vi.fn(),
      onSucceeded: refresh,
    });
    const target = thread("environment-a", "thread-1");

    await expect(actions.hideThread(target)).resolves.toBe(false);
    await expect(actions.unhideThread(target)).resolves.toBe(false);

    expect(mutation).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledTimes(2);
    expect(onUnavailable).toHaveBeenNthCalledWith(1, reason);
    expect(onUnavailable).toHaveBeenNthCalledWith(2, reason);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rechecks the target environment capability for each attempt", async () => {
    let unavailableReason: string | null =
      "Update this environment’s server to hide or unhide threads.";
    const mutation = vi.fn(async () => AsyncResult.success(undefined));
    const onUnavailable = vi.fn();
    const onStarted = vi.fn();
    const refresh = vi.fn();
    const actions = createThreadVisibilityActions({
      hide: mutation,
      unhide: mutation,
      getUnavailableReason: () => unavailableReason,
      onUnavailable,
      onStarted,
      onFailure: vi.fn(),
      onSucceeded: refresh,
    });
    const target = thread("environment-a", "thread-1");

    await expect(actions.hideThread(target)).resolves.toBe(false);
    unavailableReason = null;
    await expect(actions.hideThread(target)).resolves.toBe(true);
    unavailableReason = "Connect to this environment to hide or unhide threads.";
    await expect(actions.unhideThread(target)).resolves.toBe(false);

    expect(mutation).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ["supported", EnvironmentId.make("environment-supported"), "connected", true],
    ["missing capability", EnvironmentId.make("environment-missing"), "connected", undefined],
    ["false capability", EnvironmentId.make("environment-false"), "connected", false],
    ["disconnected stale capability", EnvironmentId.make("environment-offline"), "offline", true],
  ] as const)(
    "uses the target environment’s real capability presentation for %s",
    async (_label, environmentId, phase, threadHiding) => {
      const presentations = new Map<EnvironmentId, ThreadHidingPresentation>([
        [
          EnvironmentId.make("environment-supported"),
          presentation(EnvironmentId.make("environment-supported"), "connected", true),
        ],
        [
          EnvironmentId.make("environment-missing"),
          presentation(EnvironmentId.make("environment-missing"), "connected", undefined),
        ],
        [
          EnvironmentId.make("environment-false"),
          presentation(EnvironmentId.make("environment-false"), "connected", false),
        ],
        [
          EnvironmentId.make("environment-offline"),
          presentation(EnvironmentId.make("environment-offline"), "offline", true),
        ],
      ]);
      const getUnavailableReason = vi.fn((targetEnvironmentId: EnvironmentId) =>
        threadHidingUnavailableReason(presentations.get(targetEnvironmentId) ?? null),
      );
      const mutation = vi.fn(async () => AsyncResult.success(undefined));
      const onStarted = vi.fn();
      const onUnavailable = vi.fn();
      const onSucceeded = vi.fn();
      const actions = createThreadVisibilityActions({
        hide: mutation,
        unhide: mutation,
        getUnavailableReason,
        onUnavailable,
        onStarted,
        onFailure: vi.fn(),
        onSucceeded,
      });
      const target = thread(String(environmentId), "thread-shared");
      const expectedReason = threadHidingUnavailableReason(
        presentations.get(environmentId) ?? presentation(environmentId, phase, threadHiding),
      );

      await expect(actions.hideThread(target)).resolves.toBe(expectedReason === null);
      await expect(actions.unhideThread(target)).resolves.toBe(expectedReason === null);
      expect(getUnavailableReason).toHaveBeenNthCalledWith(1, environmentId);
      expect(getUnavailableReason).toHaveBeenNthCalledWith(2, environmentId);

      if (expectedReason === null) {
        expect(mutation).toHaveBeenCalledTimes(2);
        expect(onStarted).toHaveBeenCalledTimes(2);
        expect(onSucceeded).toHaveBeenCalledTimes(2);
        expect(onUnavailable).not.toHaveBeenCalled();
      } else {
        expect(mutation).not.toHaveBeenCalled();
        expect(onStarted).not.toHaveBeenCalled();
        expect(onSucceeded).not.toHaveBeenCalled();
        expect(onUnavailable).toHaveBeenNthCalledWith(1, expectedReason);
        expect(onUnavailable).toHaveBeenNthCalledWith(2, expectedReason);
      }
    },
  );
});
