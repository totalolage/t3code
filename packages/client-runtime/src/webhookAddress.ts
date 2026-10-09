import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

/**
 * Where a sender can call a webhook task, as a client shows it. With a public
 * base URL or T3 Connect the server returns the full URL; without either the
 * path is resolved on the address this client reaches the environment at.
 */
export interface WebhookAddress {
  /** The URL to give a sender, or the bare path when no address is known. */
  readonly address: string;
  /** Whether `address` is a full URL a sender can call. */
  readonly copyable: boolean;
  /** One line on who can reach `address`; null for a T3 Connect URL. */
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return {
      address: endpoint.url,
      copyable: true,
      note:
        endpoint.urlSource === "public-base-url"
          ? "Goes straight to this environment's public base URL. Requests fail while it is offline."
          : null,
    };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Set a public base URL or link T3 Connect for a full URL.",
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Set a public base URL or link T3 Connect for one senders can reach."
      : "Works wherever this environment's address is reachable, for example over Tailscale. Set a public base URL or link T3 Connect for one senders can reach.",
  };
}
