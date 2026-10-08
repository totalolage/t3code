import type { ServiceUpdateState } from "@t3tools/contracts";

import type { ProviderOperateAccess } from "./settings/ProviderSettingsPanel.logic.ts";

export interface ServiceUpdateBannerViewModel {
  readonly kind: "draining" | "activating";
  readonly heading: string;
  readonly detail: string;
  readonly queueLabel: string | null;
  readonly cancellable: boolean;
}

export interface ResolveServiceUpdateBannerViewInput {
  readonly status: ServiceUpdateState | null;
  readonly operateAccess: ProviderOperateAccess;
}

/** Project the server's scheduled-update lifecycle into the small public banner. */
export function resolveServiceUpdateBannerView(
  input: ResolveServiceUpdateBannerViewInput,
): ServiceUpdateBannerViewModel | null {
  const { status } = input;
  if (status === null || status.status === "idle") {
    return null;
  }

  const queueLabel =
    status.queuedTurnCount === 0
      ? null
      : `Queue: ${status.queuedTurnCount} queued turn${status.queuedTurnCount === 1 ? "" : "s"}.`;

  if (status.status === "draining") {
    return {
      kind: "draining",
      heading: `Preparing service update ${status.targetVersion}`,
      detail: `Waiting for ${status.activeTurnCount} active turn${status.activeTurnCount === 1 ? "" : "s"} to finish.`,
      queueLabel,
      cancellable: input.operateAccess === "granted",
    };
  }

  return {
    kind: "activating",
    heading: `Activating service update ${status.targetVersion}`,
    detail: "The server is restarting to finish the update.",
    queueLabel,
    cancellable: false,
  };
}
