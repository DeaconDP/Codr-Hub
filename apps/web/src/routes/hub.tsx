import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/hub")({
  component: HubLayout,
});

function HubLayout() {
  return <Outlet />;
}
