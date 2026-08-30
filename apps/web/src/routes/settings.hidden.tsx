import { createFileRoute } from "@tanstack/react-router";

import { HiddenThreadsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/hidden")({
  component: HiddenThreadsPanel,
});
