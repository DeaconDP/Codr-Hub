import { createFileRoute } from "@tanstack/react-router";

import { HubPage } from "../components/hub/HubPage";

export const Route = createFileRoute("/hub")({
  component: HubPage,
});
