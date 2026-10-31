import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  customThemeNames,
  renderDefaultThemeVariablesJSON,
  renderUniwindThemesCSS,
} from "./generate-uniwind-themes.mts";

describe("generate mobile Uniwind themes", () => {
  it("gives every theme the same variables and a fixed Clerk palette for its appearance", () => {
    const css =
      NodeFS.readFileSync(NodePath.resolve(import.meta.dirname, "../global.css"), "utf8") +
      renderUniwindThemesCSS();
    const themes = new Map<string, Map<string, string>>(
      ["light", "dark", ...customThemeNames].map((name) => [name, new Map()]),
    );
    for (const [, name, body] of css.matchAll(/@variant ([\w-]+) \{([^}]+)\}/gu)) {
      const variables = themes.get(name!);
      for (const [, variable, value] of body!.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) {
        variables?.set(variable!, value!.trim().toLowerCase());
      }
    }

    const lightVariables = themes.get("light")!;
    for (const [name, variables] of themes) {
      expect([...variables.keys()].sort(), name).toEqual([...lightVariables.keys()].sort());
      const isDark = name === "dark" || name.endsWith("-dark");
      expect(
        Object.fromEntries(
          [...variables].filter(([variable]) => variable.startsWith("--color-clerk-")),
        ),
        name,
      ).toEqual({
        "--color-clerk-page": isDark ? "#0b0b0b" : "#fcfcfc",
        "--color-clerk-foreground": isDark ? "#e8e8e8" : "#27272a",
        "--color-clerk-foreground-muted": isDark ? "#8b8b8b" : "#71717b",
        "--color-clerk-border": isDark ? "#2a2a2a" : "#e4e4e7",
        "--color-clerk-danger": isDark ? "#f2b4a8" : "#c10007",
      });
    }
  });

  it("defaults missing appearance prefs to dark Cursor-Hub charcoal", () => {
    const variables = JSON.parse(renderDefaultThemeVariablesJSON());
    expect(variables.dark["--color-screen"]).toBe("#0b0b0b");
    expect(variables.dark["--color-primary"]).toBe("#ffffff");
  });
});
