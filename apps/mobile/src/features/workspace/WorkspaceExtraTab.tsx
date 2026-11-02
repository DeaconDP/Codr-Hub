import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { HubRouteScreen } from "../hub/HubRouteScreen";
import { UsageRouteScreen } from "../usage/UsageRouteScreen";

export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "hub" ? <HubRouteScreen /> : <UsageRouteScreen workspace />}
    </>
  );
}
