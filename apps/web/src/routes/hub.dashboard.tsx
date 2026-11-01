import { createFileRoute } from "@tanstack/react-router";

import { HubDashboardPage } from "../components/hub/HubDashboardPage";

export const Route = createFileRoute("/hub/dashboard")({
  component: HubDashboardPage,
});
