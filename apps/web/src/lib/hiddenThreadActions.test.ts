import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  presentations: new Map<string, { readonly connection: { readonly phase: string } }>(),
  supportsHiding: new Map<string, boolean>(),
}));

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (environmentId: string) => testState.presentations.get(environmentId) ?? null,
  },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsHiding: (environmentId: string) =>
    testState.supportsHiding.get(environmentId) === true,
}));
vi.mock("../state/presentation", () => ({
  environmentPresentations: {
    presentationAtom: (environmentId: string) => environmentId,
  },
}));

import { getHiddenThreadActionEligibility, requestHiddenThreadUnhide } from "./hiddenThreadActions";

const TARGET_ENVIRONMENT_ID = EnvironmentId.make("environment-target");
const OTHER_ENVIRONMENT_ID = EnvironmentId.make("environment-other");
const TARGET = scopeThreadRef(TARGET_ENVIRONMENT_ID, ThreadId.make("thread-1"));

function setEnvironment(
  environmentId: EnvironmentId,
  phase: string,
  supportsHiding: boolean | undefined,
): void {
  testState.presentations.set(environmentId, { connection: { phase } });
  if (supportsHiding === undefined) {
    testState.supportsHiding.delete(environmentId);
  } else {
    testState.supportsHiding.set(environmentId, supportsHiding);
  }
}

beforeEach(() => {
  testState.presentations.clear();
  testState.supportsHiding.clear();
});

describe("getHiddenThreadActionEligibility", () => {
  it("allows unhide only for a connected environment that advertises hiding", () => {
    expect(getHiddenThreadActionEligibility(true, "connected")).toEqual({
      canUnhide: true,
      reason: null,
      guidance: null,
    });
  });

  it.each([
    ["missing", false, "connected", "unsupported"],
    ["false", false, "connected", "unsupported"],
    ["offline", true, "offline", "disconnected"],
    ["reconnecting", true, "reconnecting", "disconnected"],
    ["missing target", true, null, "missing-environment"],
  ] as const)("explains why %s cannot unhide", (_, supportsHiding, phase, reason) => {
    expect(getHiddenThreadActionEligibility(supportsHiding, phase)).toMatchObject({
      canUnhide: false,
      reason,
    });
  });
});

describe("requestHiddenThreadUnhide", () => {
  it("mutates when the target environment is currently supported and connected", async () => {
    setEnvironment(TARGET_ENVIRONMENT_ID, "connected", true);
    const mutate = vi.fn(async (target: typeof TARGET) => target);

    await expect(requestHiddenThreadUnhide(TARGET, mutate)).resolves.toEqual({
      _tag: "Mutated",
      result: TARGET,
    });
    expect(mutate).toHaveBeenCalledExactlyOnceWith(TARGET);
  });

  it.each([
    ["missing capability", "connected", undefined, "unsupported"],
    ["false capability", "connected", false, "unsupported"],
    ["offline", "offline", true, "disconnected"],
    ["reconnecting", "reconnecting", true, "disconnected"],
  ] as const)("does not mutate for a %s target", async (_, phase, supportsHiding, reason) => {
    setEnvironment(TARGET_ENVIRONMENT_ID, phase, supportsHiding);
    const mutate = vi.fn(async () => undefined);

    await expect(requestHiddenThreadUnhide(TARGET, mutate)).resolves.toMatchObject({
      _tag: "Blocked",
      eligibility: { reason },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("does not mutate when the target environment is missing", async () => {
    const mutate = vi.fn(async () => undefined);

    await expect(requestHiddenThreadUnhide(TARGET, mutate)).resolves.toMatchObject({
      _tag: "Blocked",
      eligibility: { reason: "missing-environment" },
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("reads capability and connection state from the target environment", async () => {
    setEnvironment(TARGET_ENVIRONMENT_ID, "connected", false);
    setEnvironment(OTHER_ENVIRONMENT_ID, "offline", true);
    const mutate = vi.fn(async () => undefined);

    await expect(requestHiddenThreadUnhide(TARGET, mutate)).resolves.toMatchObject({
      _tag: "Blocked",
      eligibility: { reason: "unsupported" },
    });
    expect(mutate).not.toHaveBeenCalled();

    setEnvironment(TARGET_ENVIRONMENT_ID, "connected", true);
    setEnvironment(OTHER_ENVIRONMENT_ID, "reconnecting", false);
    await expect(requestHiddenThreadUnhide(TARGET, mutate)).resolves.toEqual({
      _tag: "Mutated",
      result: undefined,
    });
    expect(mutate).toHaveBeenCalledExactlyOnceWith(TARGET);
  });
});
