import { MessageId, ThreadId, type ServiceUpdateState } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

import { ServiceUpdateBannerPresentation } from "./ServiceUpdateBanner";
import {
  type ServiceUpdateBannerViewModel,
  resolveServiceUpdateBannerView,
} from "./ServiceUpdateBanner.logic";

const draining = {
  status: "draining",
  targetVersion: "1.2.3",
  activeTurnCount: 2,
  queuedTurnCount: 1,
  queuedTurns: [
    {
      threadId: ThreadId.make("thread:service-update"),
      messageId: MessageId.make("message:service-update"),
    },
  ],
  startedAt: "2026-10-06T00:00:00.000Z",
} satisfies Extract<ServiceUpdateState, { readonly status: "draining" }>;

describe("resolveServiceUpdateBannerView", () => {
  it("renders nothing for idle and missing lifecycle state", () => {
    expect(
      resolveServiceUpdateBannerView({ status: { status: "idle" }, operateAccess: "granted" }),
    ).toBeNull();
    expect(resolveServiceUpdateBannerView({ status: null, operateAccess: "granted" })).toBeNull();
  });

  it("reports the native drain counts and offers cancellation to an operator", () => {
    expect(resolveServiceUpdateBannerView({ status: draining, operateAccess: "granted" })).toEqual({
      kind: "draining",
      heading: "Preparing service update 1.2.3",
      detail: "Waiting for 2 active turns to finish.",
      queueLabel: "Queue: 1 queued turn.",
      cancellable: true,
    });
  });

  it("keeps drain status visible without cancellation access", () => {
    const view = resolveServiceUpdateBannerView({ status: draining, operateAccess: "denied" });
    expect(view?.kind).toBe("draining");
    expect(view?.cancellable).toBe(false);
  });

  it("never offers cancellation after activation begins", () => {
    expect(
      resolveServiceUpdateBannerView({
        status: {
          status: "activating",
          targetVersion: "1.2.3",
          queuedTurnCount: 1,
          queuedTurns: draining.queuedTurns,
          startedAt: draining.startedAt,
        },
        operateAccess: "granted",
      }),
    ).toMatchObject({ kind: "activating", cancellable: false });
  });
});

describe("ServiceUpdateBannerPresentation", () => {
  async function renderView(
    view: ServiceUpdateBannerViewModel,
    onCancel: () => void,
  ): Promise<ReactTestRenderer> {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<ServiceUpdateBannerPresentation view={view} onCancel={onCancel} />);
    });
    return renderer!;
  }

  async function unmount(renderer: ReactTestRenderer): Promise<void> {
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  }

  it("dispatches a simple cancel request from the drain banner", async () => {
    const onCancel = vi.fn();
    const renderer = await renderView(
      {
        kind: "draining",
        heading: "Preparing service update 1.2.3",
        detail: "Waiting for 2 active turns to finish.",
        queueLabel: "Queue: 1 queued turn.",
        cancellable: true,
      },
      onCancel,
    );
    const button = renderer.root.findAll(
      (node) => node.type === "button" && node.props.onClick !== undefined,
    )[0];
    if (button === undefined) throw new Error("Missing cancel button.");
    await act(async () => button.props.onClick());
    expect(onCancel).toHaveBeenCalledOnce();
    await unmount(renderer);
  });

  it("renders activation without a cancel action", async () => {
    const renderer = await renderView(
      {
        kind: "activating",
        heading: "Activating service update 1.2.3",
        detail: "The server is restarting to finish the update.",
        queueLabel: null,
        cancellable: false,
      },
      vi.fn(),
    );
    expect(renderer.root.findAll((node) => node.props.onClick !== undefined)).toHaveLength(0);
    await unmount(renderer);
  });
});
