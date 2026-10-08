import { ConnectionOnboarding } from "@t3tools/client-runtime/connection";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { parseRemotePairingUrlFields } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";

import { configuredHostedAppUrl } from "~/hostedPairing";

import { connectionAtomRuntime } from "./runtime";

type BearerConnectionUpdateInput = ConnectionOnboarding.BearerConnectionUpdateInput;

type WebPairingCommandInput = ConnectionOnboarding.PairingConnectionInput;

/**
 * Converts any successfully parsed pairing URL into direct host/code/parameters
 * before the runtime parses it. Without this the runtime re-reads the link with
 * the default hosted origin, so a custom `VITE_HOSTED_APP_URL` would
 * misclassify a default-origin hosted link (and vice versa). Explicit
 * queryParameters win over URL-derived ones, including an empty override list.
 * Malformed input passes through unchanged for the runtime to report.
 */
export function resolvePairingCommandInput(input: WebPairingCommandInput): WebPairingCommandInput {
  const pairingUrl = input.pairingUrl?.trim();
  if (!pairingUrl) return input;
  try {
    const parsed = parseRemotePairingUrlFields(pairingUrl, {
      hostedAppUrl: configuredHostedAppUrl(),
    });
    if (!parsed) return input;
    const explicitPairingCode = input.pairingCode?.trim();
    return {
      host: parsed.host,
      pairingCode: parsed.pairingCode || explicitPairingCode || "",
      queryParameters: input.queryParameters ?? parsed.queryParameters,
      ...(input.expectedEnvironmentId === undefined
        ? {}
        : { expectedEnvironmentId: input.expectedEnvironmentId }),
    };
  } catch {
    return input;
  }
}

const onboardingScheduler = createAtomCommandScheduler();

export const connectPairing = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-pairing",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "singleFlight",
    key: (input: WebPairingCommandInput) => JSON.stringify(input),
  },
  execute: (input: WebPairingCommandInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerPairing(resolvePairingCommandInput(input))),
    ),
});

export const updateBearer = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:update-bearer",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: BearerConnectionUpdateInput) => input.environmentId,
  },
  execute: (input: BearerConnectionUpdateInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.updateBearer(input)),
    ),
});

export const connectSshEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:connection:connect-ssh",
  scheduler: onboardingScheduler,
  concurrency: {
    mode: "serial",
    key: (input: { readonly target: DesktopSshEnvironmentTarget }) => JSON.stringify(input.target),
  },
  execute: (input: ConnectionOnboarding.SshConnectionInput) =>
    ConnectionOnboarding.ConnectionOnboarding.pipe(
      Effect.flatMap((onboarding) => onboarding.registerSsh(input)),
    ),
});
