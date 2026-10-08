import type { EnvironmentId } from "@t3tools/contracts";
import { XCircleIcon } from "lucide-react";
import { useCallback } from "react";

import { isElectron } from "~/env";
import { usePrimarySessionState } from "~/environments/primary";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serviceUpdateEnvironment, useServiceUpdateStatus } from "~/state/serviceUpdate";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "./ui/button";
import {
  type ProviderOperateAccess,
  resolvePrimaryOperateAccess,
} from "./settings/ProviderSettingsPanel.logic";
import {
  type ServiceUpdateBannerViewModel,
  resolveServiceUpdateBannerView,
} from "./ServiceUpdateBanner.logic";

/**
 * Global banner for the server's own update-and-drain cycle. Everything shown
 * comes from the server's status subscription; idle, disabled, and unsupported
 * servers render nothing, never a fake progress indicator.
 */
export function ServiceUpdateBanner() {
  const environmentId = usePrimaryEnvironmentId();
  const { status } = useServiceUpdateStatus(environmentId);
  const operateAccess = useServiceUpdateOperateAccess(environmentId);
  const cancelUpdate = useAtomCommand(serviceUpdateEnvironment.cancel, { reportFailure: false });
  const view = resolveServiceUpdateBannerView({ status, operateAccess });

  const handleCancel = useCallback(() => {
    if (environmentId !== null) {
      void cancelUpdate({ environmentId, input: {} });
    }
  }, [cancelUpdate, environmentId]);

  if (view === null) {
    return null;
  }
  return <ServiceUpdateBannerPresentation view={view} onCancel={handleCancel} />;
}

/**
 * Operate access for the primary environment's session, using the same
 * decision the provider settings use: the desktop app owns its server
 * outright, a browser session checks its cookie session's scopes. `pending`
 * hides the cancel action rather than offering a write that may be rejected.
 */
function useServiceUpdateOperateAccess(environmentId: EnvironmentId | null): ProviderOperateAccess {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primarySession = usePrimarySessionState();
  if (environmentId === null || primaryEnvironmentId !== environmentId) {
    return "pending";
  }
  if (isElectron) {
    return "granted";
  }
  return resolvePrimaryOperateAccess({
    isPrimary: true,
    hasDesktopBridge: false,
    session: primarySession.data,
    isPending: primarySession.isPending,
    hasError: primarySession.error !== null,
  });
}

export function ServiceUpdateBannerPresentation({
  view,
  onCancel,
}: {
  readonly view: ServiceUpdateBannerViewModel;
  readonly onCancel?: () => void;
}) {
  return (
    <div
      role="status"
      data-service-update-banner
      className="fixed inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-border bg-card px-4 py-2 text-sm shadow-sm"
    >
      <XCircleIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-foreground">{view.heading}</span>
        <span className="truncate text-xs text-muted-foreground">{view.detail}</span>
        {view.queueLabel !== null ? (
          <span className="truncate text-xs text-muted-foreground">{view.queueLabel}</span>
        ) : null}
      </div>
      {view.cancellable ? (
        <Button size="sm" variant="outline" onClick={() => onCancel?.()}>
          Cancel update
        </Button>
      ) : null}
    </div>
  );
}
