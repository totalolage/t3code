import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  threadHidingUnavailableReason,
  type ThreadHidingPresentation,
} from "./thread-hiding-support";

const CONNECT_REASON = "Connect to this environment to hide or unhide threads.";
const UPDATE_REASON = "Update this environment’s server to hide or unhide threads.";

function serverConfig(
  threadHiding: boolean | undefined,
): NonNullable<ThreadHidingPresentation["serverConfig"]> {
  return {
    environment: { capabilities: { repositoryIdentity: false, threadHiding } },
  } as NonNullable<ThreadHidingPresentation["serverConfig"]>;
}

function presentation(
  phase: EnvironmentPresentation["connection"]["phase"],
  threadHiding: boolean | undefined,
): ThreadHidingPresentation {
  return {
    connection: { phase, error: null, traceId: null },
    serverConfig: serverConfig(threadHiding),
  };
}

describe("thread hiding support", () => {
  it("requires a connection before considering the capability", () => {
    expect(threadHidingUnavailableReason(null)).toBe(CONNECT_REASON);
    expect(threadHidingUnavailableReason(presentation("offline", true))).toBe(CONNECT_REASON);
  });

  it.each([
    ["missing capability", undefined],
    ["false capability", false],
  ] as const)("requires an explicit true capability for %s", (_label, threadHiding) => {
    expect(threadHidingUnavailableReason(presentation("connected", threadHiding))).toBe(
      UPDATE_REASON,
    );
  });

  it("allows a connected environment with the explicit capability", () => {
    expect(threadHidingUnavailableReason(presentation("connected", true))).toBeNull();
  });

  it("treats a connected environment without a server presentation as unavailable", () => {
    expect(
      threadHidingUnavailableReason({
        connection: { phase: "connected", error: null, traceId: null },
        serverConfig: null,
      }),
    ).toBe(UPDATE_REASON);
  });
});
