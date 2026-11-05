import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";

/** Opens a new-thread draft on a T3 project from the Hub tab. */
export function useStartHubThread() {
  const selectDetail = useSelectWorkspaceDetail();
  const selectTab = useSelectWorkspaceTab();
  return (target: { readonly environmentId: string; readonly id: string }) => {
    // A thread belongs to Chats; page tabs keep their tab bar over a pushed detail.
    selectTab("threads");
    selectDetail({
      name: "Thread",
      params: {
        draft: { environmentId: String(target.environmentId), projectId: String(target.id) },
      },
    });
  };
}
