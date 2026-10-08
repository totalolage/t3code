import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

const testState = vi.hoisted(() => ({
  serverConfigs: new Map<
    string,
    {
      readonly environment: {
        readonly capabilities: { readonly threadHiding?: boolean };
      };
    }
  >(),
  presentations: new Map<string, { readonly connection: { readonly phase: string } }>(),
  presentationAtoms: new WeakMap<object, string>(),
  refreshArchivedThreadsForEnvironment: vi.fn<(environmentId: string) => void>(),
  routeParams: {} as Record<string, string>,
  threadShell: null as { environmentId: string; projectId: string } | null,
  hideMutation: vi.fn(),
  handleNewThread: vi.fn(),
  navigationCalls: [] as string[],
}));

vi.mock("../rpc/atomRegistry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rpc/atomRegistry")>();
  return {
    ...actual,
    appAtomRegistry: {
      ...actual.appAtomRegistry,
      get: (atom: unknown) => {
        if (typeof atom === "object" && atom !== null) {
          const environmentId = testState.presentationAtoms.get(atom);
          if (environmentId !== undefined) {
            return testState.presentations.get(environmentId) ?? null;
          }
        }
        return testState.serverConfigs;
      },
    },
  };
});
vi.mock("../lib/archivedThreadsState", () => ({
  refreshArchivedThreadsForEnvironment: testState.refreshArchivedThreadsForEnvironment,
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: {
    presentationAtom: (environmentId: string) => {
      const atom = {};
      testState.presentationAtoms.set(atom, environmentId);
      return atom;
    },
  },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (callback: unknown) => callback,
    useMemo: (create: () => unknown) => create(),
    useRef: (value: unknown) => ({ current: value }),
  };
});
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(async () => {}),
    get state() {
      return { matches: [{ params: testState.routeParams }] };
    },
  }),
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => testState.handleNewThread,
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../state/use-atom-command", async () => {
  const { threadEnvironment } = await import("../state/threads");
  return {
    useAtomCommand: (command: unknown) =>
      command === threadEnvironment.hide ? testState.hideMutation : vi.fn(async () => undefined),
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/entities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/entities")>();
  return {
    ...actual,
    readThreadShell: () => testState.threadShell,
  };
});

import {
  navigateAfterThreadDeletion,
  requestThreadUnpinConfirmation,
  requestThreadHidingAction,
  useThreadActions,
  ThreadArchiveBlockedError,
  ThreadHidingUnsupportedError,
} from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

function setThreadHidingCapability(environmentId: EnvironmentId, value: boolean | undefined): void {
  if (value === undefined) {
    testState.serverConfigs.delete(environmentId);
    return;
  }
  testState.serverConfigs.set(environmentId, {
    environment: { capabilities: { threadHiding: value } },
  });
}

function setConnectionPhase(environmentId: EnvironmentId, phase: string): void {
  testState.presentations.set(environmentId, { connection: { phase } });
}

function makeMutation() {
  return vi.fn<Parameters<typeof requestThreadHidingAction>[1]>(async () =>
    AsyncResult.success({ sequence: 1 }),
  );
}

afterEach(() => {
  testState.serverConfigs.clear();
  testState.presentations.clear();
  testState.routeParams = {};
  testState.threadShell = null;
  testState.hideMutation.mockReset();
  testState.handleNewThread.mockReset();
  testState.navigationCalls.length = 0;
  testState.refreshArchivedThreadsForEnvironment.mockClear();
  vi.restoreAllMocks();
});

describe("navigateAfterThreadDeletion", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });

  it("does not report an error after successful navigation", async () => {
    const addToast = vi.spyOn(toastManager, "add");

    await navigateAfterThreadDeletion(() => Promise.resolve());

    expect(addToast).not.toHaveBeenCalled();
  });
});

describe("ThreadArchiveBlockedError", () => {
  it("keeps the blocked thread context with the fixed message", () => {
    const error = new ThreadArchiveBlockedError({
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    });

    expect(error).toMatchObject({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(error.message).toBe("Cannot archive while the provider is active.");
  });
});

describe("requestThreadUnpinConfirmation", () => {
  it("skips the dialog when confirmation is disabled", async () => {
    let callCount = 0;
    const result = await requestThreadUnpinConfirmation({
      enabled: false,
      title: "Pinned thread",
      confirm: async () => {
        callCount += 1;
        return false;
      },
    });

    expect(result).toMatchObject({ _tag: "Success", value: true });
    expect(callCount).toBe(0);
  });

  it("degrades gracefully when dialogs are unavailable", async () => {
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Pinned thread",
      confirm: null,
    });

    expect(result).toMatchObject({ _tag: "Success", value: true });
  });

  it("uses the thread title and returns the user's decision", async () => {
    let message = "";
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Release prep",
      confirm: async (nextMessage) => {
        message = nextMessage;
        return false;
      },
    });

    expect(message).toBe(
      'Unpin thread "Release prep"?\nThis will move the thread out of your pinned section.',
    );
    expect(result).toMatchObject({ _tag: "Success", value: false });
  });

  it("keeps dialog failures observable", async () => {
    const result = await requestThreadUnpinConfirmation({
      enabled: true,
      title: "Pinned thread",
      confirm: () => Promise.reject(new Error("dialog unavailable")),
    });

    expect(result._tag).toBe("Failure");
  });
});

describe("requestThreadHidingAction", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-requested"),
    threadId: ThreadId.make("thread-1"),
  };

  it.each([
    ["missing", undefined],
    ["false", false],
  ] as const)("rejects when the target capability is %s", async (_, capability) => {
    setThreadHidingCapability(target.environmentId, capability);
    setConnectionPhase(target.environmentId, "connected");
    const mutate = makeMutation();

    const result = await requestThreadHidingAction(target, mutate);

    expect(result._tag).toBe("Failure");
    expect(mutate).not.toHaveBeenCalled();
    expect(testState.refreshArchivedThreadsForEnvironment).not.toHaveBeenCalled();
  });

  it("returns a typed unsupported error with the requested thread context", async () => {
    setConnectionPhase(target.environmentId, "connected");
    const mutate = makeMutation();

    const result = await requestThreadHidingAction(target, mutate);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      expect(error).toBeInstanceOf(ThreadHidingUnsupportedError);
      expect(error).toMatchObject({
        environmentId: target.environmentId,
        threadId: target.threadId,
      });
    }
  });

  it("mutates and refreshes only the requested environment when supported", async () => {
    const activeEnvironmentId = EnvironmentId.make("environment-active");
    setThreadHidingCapability(activeEnvironmentId, false);
    setThreadHidingCapability(target.environmentId, true);
    setConnectionPhase(activeEnvironmentId, "offline");
    setConnectionPhase(target.environmentId, "connected");
    const mutate = makeMutation();

    const result = await requestThreadHidingAction(target, mutate);

    expect(result).toMatchObject({ _tag: "Success", value: { sequence: 1 } });
    expect(mutate).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(testState.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
    expect(testState.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith(
      target.environmentId,
    );
  });

  it("reads capability state again when a later invocation changes", async () => {
    const mutate = makeMutation();
    setThreadHidingCapability(target.environmentId, true);
    setConnectionPhase(target.environmentId, "connected");

    await expect(requestThreadHidingAction(target, mutate)).resolves.toMatchObject({
      _tag: "Success",
    });

    setThreadHidingCapability(target.environmentId, false);
    const rejected = await requestThreadHidingAction(target, mutate);

    expect(rejected._tag).toBe("Failure");
    expect(mutate).toHaveBeenCalledOnce();
    expect(testState.refreshArchivedThreadsForEnvironment).toHaveBeenCalledOnce();
  });

  it.each([
    ["offline", "offline"],
    ["reconnecting", "reconnecting"],
  ] as const)("does not mutate while the target is %s", async (_, phase) => {
    setThreadHidingCapability(target.environmentId, true);
    setConnectionPhase(target.environmentId, phase);
    const mutate = makeMutation();

    const result = await requestThreadHidingAction(target, mutate);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      expect(error).toBeInstanceOf(EnvironmentRpcUnavailableError);
      if (isEnvironmentRpcUnavailableError(error)) {
        expect(error.environmentId).toBe(target.environmentId);
        expect(error.message).toBe(`Environment ${target.environmentId} is ${phase}.`);
      }
    }
    expect(mutate).not.toHaveBeenCalled();
    expect(testState.refreshArchivedThreadsForEnvironment).not.toHaveBeenCalled();
  });

  it("does not mutate when the target presentation is missing", async () => {
    setThreadHidingCapability(target.environmentId, true);
    const mutate = makeMutation();

    const result = await requestThreadHidingAction(target, mutate);

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      expect(error).toBeInstanceOf(EnvironmentRpcUnavailableError);
      if (isEnvironmentRpcUnavailableError(error)) {
        expect(error.environmentId).toBe(target.environmentId);
        expect(error.message).toBe(`Environment ${target.environmentId} is not connected.`);
      }
    }
    expect(mutate).not.toHaveBeenCalled();
    expect(testState.refreshArchivedThreadsForEnvironment).not.toHaveBeenCalled();
  });
});

describe("hideThread navigation", () => {
  const target = {
    environmentId: EnvironmentId.make("environment-hide-active"),
    threadId: ThreadId.make("thread-hide-active"),
  };

  function prepareActiveThread() {
    testState.routeParams = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    testState.threadShell = {
      environmentId: target.environmentId,
      projectId: "project-hide-active",
    };
    setThreadHidingCapability(target.environmentId, true);
    setConnectionPhase(target.environmentId, "connected");
    testState.handleNewThread.mockImplementation(async (projectRef) => {
      testState.navigationCalls.push("navigate");
      expect(projectRef).toMatchObject({
        environmentId: target.environmentId,
        projectId: "project-hide-active",
      });
    });
    testState.hideMutation.mockImplementation(async () => {
      testState.navigationCalls.push("hide");
      return AsyncResult.success({ sequence: 2 });
    });
  }

  it("leaves the hidden active thread only after the hide succeeds", async () => {
    prepareActiveThread();

    const result = await useThreadActions().hideThread(target, { navigateAway: true });

    expect(result).toMatchObject({ _tag: "Success", value: { sequence: 2 } });
    expect(testState.navigationCalls).toEqual(["hide", "navigate"]);
  });

  it("does not navigate when hiding fails", async () => {
    prepareActiveThread();
    testState.hideMutation.mockImplementation(async () => {
      testState.navigationCalls.push("hide");
      return AsyncResult.failure(Cause.fail(new Error("hide refused")));
    });

    const result = await useThreadActions().hideThread(target, { navigateAway: true });

    expect(result._tag).toBe("Failure");
    expect(testState.navigationCalls).toEqual(["hide"]);
  });

  it("does not navigate away from another scoped thread", async () => {
    prepareActiveThread();
    testState.routeParams = {
      environmentId: EnvironmentId.make("another-environment"),
      threadId: ThreadId.make("another-thread"),
    };

    const result = await useThreadActions().hideThread(target, { navigateAway: true });

    expect(result._tag).toBe("Success");
    expect(testState.navigationCalls).toEqual(["hide"]);
  });

  it.each([
    { environmentId: target.environmentId, threadId: "another-thread" },
    { environmentId: "another-environment", threadId: target.threadId },
  ])("preserves a newer scoped selection while hide is pending: %j", async (routeParams) => {
    prepareActiveThread();
    const success = AsyncResult.success({ sequence: 2 });
    let resolveMutation!: (value: typeof success) => void;
    const mutation = new Promise<typeof success>((resolve) => {
      resolveMutation = resolve;
    });
    testState.hideMutation.mockImplementation(() => {
      testState.navigationCalls.push("hide");
      return mutation;
    });

    const pendingHide = useThreadActions().hideThread(target, { navigateAway: true });
    expect(testState.navigationCalls).toEqual(["hide"]);
    testState.routeParams = routeParams;
    resolveMutation(success);

    expect(await pendingHide).toMatchObject({ _tag: "Success", value: { sequence: 2 } });
    expect(testState.navigationCalls).toEqual(["hide"]);
  });
});
