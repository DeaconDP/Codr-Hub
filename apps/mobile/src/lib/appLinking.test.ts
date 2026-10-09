import { describe, expect, it } from "vite-plus/test";

import { shouldHandleAppLink } from "./appLinking";

describe("shouldHandleAppLink", () => {
  it.each([
    "codrhub://",
    "codrhub:///",
    "codrhub-dev://",
    "codrhub-preview://",
    "t3code://",
    "t3code-dev://",
  ])("ignores scheme-only URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(false);
  });

  it.each([
    "codrhub://threads/env-1/thread-1",
    "codrhub://pair?pairingUrl=x",
    "codrhub-dev://settings/usage?tab=limits",
  ])("handles path-bearing URL %s", (url) => {
    expect(shouldHandleAppLink(url)).toBe(true);
  });

  it.each(["codrhub://expo-development-client/?url=x", "codrhub://expo-sharing/anything"])(
    "ignores lifecycle URL %s",
    (url) => {
      expect(shouldHandleAppLink(url)).toBe(false);
    },
  );
});
