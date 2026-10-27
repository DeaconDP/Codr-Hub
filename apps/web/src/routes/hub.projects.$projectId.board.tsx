import { createFileRoute } from "@tanstack/react-router";

import { HubBoardPage } from "../components/hub/HubBoardPage";

export const Route = createFileRoute("/hub/projects/$projectId/board")({
  component: HubBoardRoute,
});

function HubBoardRoute() {
  const { projectId } = Route.useParams();
  return <HubBoardPage projectId={projectId} />;
}
