import { describe, expect, it } from "vite-plus/test";

import { isThreadHidden } from "./threadHidden.ts";

describe("isThreadHidden", () => {
  it("treats a missing or null timestamp as visible", () => {
    expect(isThreadHidden({})).toBe(false);
    expect(isThreadHidden({ hiddenAt: null })).toBe(false);
    expect(isThreadHidden({ hiddenAt: undefined })).toBe(false);
  });

  it("recognizes a hidden timestamp", () => {
    expect(isThreadHidden({ hiddenAt: "2026-06-01T00:00:00.000Z" })).toBe(true);
  });
});
