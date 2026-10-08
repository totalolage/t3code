import { createFileRoute } from "@tanstack/react-router";

import { HiddenThreadsPanel } from "../components/settings/HiddenThreadsPanel";

export const Route = createFileRoute("/settings/hidden")({
  component: HiddenThreadsPanel,
});
