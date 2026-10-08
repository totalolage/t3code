import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  serverConfigs: new Map<
    string,
    {
      readonly environment: {
        readonly capabilities: { readonly threadHiding?: boolean };
      };
    }
  >(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.serverConfigs,
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => testState.serverConfigs,
  },
}));

import {
  readEnvironmentSupportsHiding,
  resolveThreadDetailRef,
  useEnvironmentSupportsHiding,
} from "./entities";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

function setThreadHidingCapability(environmentId: EnvironmentId, value: boolean | undefined): void {
  testState.serverConfigs.set(environmentId, {
    environment: {
      capabilities: value === undefined ? {} : { threadHiding: value },
    },
  });
}

beforeEach(() => {
  testState.serverConfigs.clear();
});

describe("resolveThreadDetailRef", () => {
  it("does not subscribe to a reserved draft thread before it enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: true,
      }),
    ).toBeNull();
  });

  it("subscribes once the reserved draft thread enters the shell index", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: true,
        waitForShell: true,
      }),
    ).toBe(threadRef);
  });

  it("keeps direct server-thread lookups enabled when the shell has not loaded it", () => {
    expect(
      resolveThreadDetailRef(threadRef, {
        shellExists: false,
        waitForShell: false,
      }),
    ).toBe(threadRef);
  });
});

describe("thread-hiding capability", () => {
  it.each([
    ["missing", undefined, false],
    ["false", false, false],
    ["true", true, true],
  ] as const)("reads an explicitly advertised %s capability", (_, capability, expected) => {
    setThreadHidingCapability(threadRef.environmentId, capability);

    expect(readEnvironmentSupportsHiding(threadRef.environmentId)).toBe(expected);
    const readHookSupport = useEnvironmentSupportsHiding;
    expect(readHookSupport(threadRef.environmentId)).toBe(expected);
  });

  it("returns false for a null environment and reads the requested environment", () => {
    const activeEnvironmentId = EnvironmentId.make("environment-active");
    const requestedEnvironmentId = EnvironmentId.make("environment-requested");
    setThreadHidingCapability(activeEnvironmentId, false);
    setThreadHidingCapability(requestedEnvironmentId, true);

    expect(useEnvironmentSupportsHiding(null)).toBe(false);
    expect(readEnvironmentSupportsHiding(requestedEnvironmentId)).toBe(true);
    const readHookSupport = useEnvironmentSupportsHiding;
    expect(readHookSupport(requestedEnvironmentId)).toBe(true);
  });
});
