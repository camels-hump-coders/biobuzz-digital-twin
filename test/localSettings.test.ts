import { describe, expect, it } from "vitest";
import { defaultState, hydrateState, serializeSettings, settingsForFile } from "../src/state";

describe("machine-local settings stay out of the project file", () => {
  it("quality is not written to twin-settings.json and a file without it leaves the browser's choice alone", () => {
    const s = defaultState();
    s.quality = "performance";
    const file = settingsForFile(s);
    expect("quality" in file).toBe(false);
    expect(serializeSettings(s)).not.toMatch(/"quality"/);
    // a loaded file never carries it: hydrate falls back to auto, and applySettingsJson keeps the browser's value (main.ts)
    const h = hydrateState(JSON.parse(serializeSettings(s)));
    expect(h.quality).toBe("auto");
    expect(hydrateState({ quality: "nonsense" }).quality).toBe("auto");
    expect(hydrateState({ quality: "full" }).quality).toBe("full");
  });
});
