import {
  WS_METHODS,
  type EnvironmentId,
  type ServerLifecycleStreamEvent,
  type ServiceUpdateState,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const serviceUpdateState = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:service-update:state",
  tag: WS_METHODS.subscribeServerLifecycle,
  transform: (events) =>
    events.pipe(
      Stream.filterMap((event: ServerLifecycleStreamEvent) =>
        event.type === "serviceUpdate" ? Result.succeed(event.payload) : Result.failVoid,
      ),
    ),
});

export const serviceUpdateEnvironment = {
  status: serviceUpdateState,
  cancel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:service-update:cancel",
    tag: WS_METHODS.serverCancelServiceUpdate,
  }),
};

export function useServiceUpdateStatus(environmentId: EnvironmentId | null): {
  readonly status: ServiceUpdateState | null;
  readonly loaded: boolean;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serviceUpdateEnvironment.status({ environmentId, input: {} }),
  );
  return { status: query.data, loaded: query.data !== null };
}
