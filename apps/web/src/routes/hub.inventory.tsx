import { createFileRoute } from "@tanstack/react-router";

import { HubInventoryPage } from "../components/hub/HubInventoryPage";

export const Route = createFileRoute("/hub/inventory")({
  component: HubInventoryPage,
});
