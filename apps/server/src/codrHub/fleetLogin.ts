/**
 * Login-unit text for the fleet parent. The parent is not `t3 service install`.
 *
 * @module codrHub/fleetLogin
 */

export const FLEET_LABEL = "com.deacondp.codrhub.fleet";
export const FLEET_TASK_NAME = "CodrHubFleet";

export type FleetLoginPlan = {
  readonly nodePath: string;
  readonly scriptPath: string;
  readonly repoRoot: string;
  readonly logPath: string;
  readonly runArgs: readonly string[];
};

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const renderLaunchdPlist = (
  plan: FleetLoginPlan,
): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(FLEET_LABEL)}</string>
  <key>WorkingDirectory</key>
  <string>${xml(plan.repoRoot)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(plan.nodePath)}</string>
    <string>${xml(plan.scriptPath)}</string>
${plan.runArgs.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODR_HUB_FLEET_SUPERVISED</key>
    <string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(plan.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(plan.logPath)}</string>
</dict>
</plist>
`;

const systemdQuote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

export const renderSystemdUnit = (plan: FleetLoginPlan): string => `[Unit]
Description=Codr-Hub fleet supervisor

[Service]
Type=simple
WorkingDirectory=${systemdQuote(plan.repoRoot)}
ExecStart=${[plan.nodePath, plan.scriptPath, ...plan.runArgs].map((arg) => systemdQuote(arg.replaceAll("$", () => "$$"))).join(" ")}
Environment=CODR_HUB_FLEET_SUPERVISED=1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;

const windowsQuote = (value: string): string =>
  `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;

/** One logon task. `schtasks` restarts nothing on its own. The parent loop stays up. */
export const renderWindowsTaskCommand = (plan: FleetLoginPlan): string =>
  [plan.nodePath, plan.scriptPath, ...plan.runArgs].map(windowsQuote).join(" ");
