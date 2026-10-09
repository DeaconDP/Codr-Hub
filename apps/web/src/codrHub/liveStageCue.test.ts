import { describe, expect, it } from "vite-plus/test";

import { liveStageCue } from "./liveStageCue";

const live = { active: true, failed: false };
const done = { active: false, failed: false };
const failed = { active: false, failed: true };

describe("liveStageCue", () => {
  it("enters only when a row first renders live", () => {
    expect(liveStageCue(null, live)).toBe("enter");
    expect(liveStageCue(null, done)).toBeNull();
    expect(liveStageCue(null, failed)).toBeNull();
  });

  it("completes when live work ends without failing", () => {
    expect(liveStageCue(live, done)).toBe("complete");
  });

  it("fails once when a row turns failed", () => {
    expect(liveStageCue(live, failed)).toBe("fail");
    expect(liveStageCue(live, { active: true, failed: true })).toBe("fail");
    expect(liveStageCue(failed, failed)).toBeNull();
  });

  it("stays still when nothing changed", () => {
    expect(liveStageCue(live, live)).toBeNull();
    expect(liveStageCue(done, done)).toBeNull();
  });
});
