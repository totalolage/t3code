import { describe, expect, it } from "vite-plus/test";

import {
  isF8yDesktopVersion,
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
  resolveDesktopUpdaterChannel,
} from "./updateChannels.ts";

describe("desktop update channels", () => {
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("latest");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("nightly");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });

  it("routes f8y builds to their feed without changing other build channels", () => {
    expect(isF8yDesktopVersion("1.2.3-f8y.20260825.53")).toBe(true);
    expect(resolveDesktopUpdaterChannel("1.2.3-f8y.20260825.53", "latest")).toBe("f8y");
    expect(resolveDesktopUpdaterChannel("1.2.3-f8y.20260825.53", "nightly")).toBe("f8y");
    expect(resolveDesktopUpdaterChannel("1.2.3", "latest")).toBe("latest");
    expect(resolveDesktopUpdaterChannel("1.2.3", "nightly")).toBe("nightly");
  });
});
