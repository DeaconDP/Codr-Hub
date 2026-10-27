import { describe, expect, it } from "@effect/vitest";

import {
  FLEET_LABEL,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsTaskCommand,
} from "./fleetLogin.ts";

const plan = {
  nodePath: "/usr/local/bin/node",
  scriptPath: "/work/Codr-Hub/scripts/codr-hub-fleet/parent.ts",
  repoRoot: "/work/Codr-Hub",
  logPath: "/work/Codr-Hub/.t3/userdata/codr-hub/fleet.log",
  runArgs: ["--run", "--home-dir", "/work/Fleet data & checks", "--port", "15123"],
};

describe("fleet login units", () => {
  it("starts the fleet parent at login and restarts it only after a failed exit", () => {
    const plist = renderLaunchdPlist(plan);
    expect(plist).toContain(FLEET_LABEL);
    expect(plist).toContain("--run");
    expect(plist).toContain("CODR_HUB_FLEET_SUPERVISED");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).not.toContain("com.t3tools.t3code");
    expect(plist).toContain("<string>--home-dir</string>");
    expect(plist).toContain("<string>/work/Fleet data &amp; checks</string>");
    expect(plist).toContain("<string>15123</string>");

    const unit = renderSystemdUnit(plan);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("CODR_HUB_FLEET_SUPERVISED=1");
    expect(unit).not.toContain("t3code.service");
    expect(unit).toContain('"--home-dir" "/work/Fleet data & checks" "--port" "15123"');

    expect(renderWindowsTaskCommand(plan)).toContain(
      '"--home-dir" "/work/Fleet data & checks" "--port" "15123"',
    );
  });

  it("preserves paths with spaces and service expansion characters", () => {
    const unit = renderSystemdUnit({
      ...plan,
      nodePath: "/work/Node tools/node",
      repoRoot: "/work/100% project",
      runArgs: ["--run", "--home-dir", "/work/$data/100%"],
    });
    expect(unit).toContain('WorkingDirectory="/work/100%% project"');
    expect(unit).toContain('ExecStart="/work/Node tools/node"');
    expect(unit).toContain('"/work/$$data/100%%"');

    const windows = renderWindowsTaskCommand({
      ...plan,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      runArgs: ["--run", "--home-dir", "C:\\Fleet data\\"],
    });
    expect(windows).toContain('"C:\\Program Files\\nodejs\\node.exe"');
    expect(windows).toContain('"C:\\Fleet data\\\\"');
  });
});
