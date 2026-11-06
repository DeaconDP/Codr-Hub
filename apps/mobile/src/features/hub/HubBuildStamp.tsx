import { DevSettings, Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useHubPortfolio } from "./useHubPortfolio";

// Set by the fleet when it starts Metro, so a stale bundle is visible on the phone.
const BUILD = process.env.EXPO_PUBLIC_CODR_BUILD || null;

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "unknown");

export function HubBuildStamp() {
  const serverSha = useHubPortfolio().anySnapshot?.fleet?.sha ?? null;
  const stale = BUILD !== null && serverSha !== null && serverSha !== BUILD;
  const label = `App ${short(BUILD)} · server ${short(serverSha)}`;
  if (!stale) {
    return <Text className="text-center text-xs text-foreground-muted">{label}</Text>;
  }
  return (
    <Pressable accessibilityRole="button" onPress={() => DevSettings.reload()}>
      <Text className="text-center text-xs text-foreground-muted">
        {label}. The server has newer code. Tap to reload.
      </Text>
    </Pressable>
  );
}
