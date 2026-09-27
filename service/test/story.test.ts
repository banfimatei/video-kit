import { describe, expect, it } from "vitest";
import { STORY_SAMPLE_PROPS } from "../remotion/templates/story/defaults.js";
import { sceneType, storyFrame, wrapLines } from "../remotion/templates/story/layout.js";
import { ASPECTS, prepareStoryProps, storySchema } from "../remotion/templates/story/schema.js";
import { setup, type Ctx } from "./helpers.js";

let t: Ctx;

describe("Story props", () => {
  it("sets every sample default explicitly, so Remotion's merge can't add the sample brand or footer", () => {
    const p = prepareStoryProps({ scenes: [{ title: "Acme launches today" }] }) as Record<string, unknown>;
    for (const key of Object.keys(STORY_SAMPLE_PROPS)) expect(p[key], key).not.toBeUndefined();
    expect(p.brand).toEqual({});
    expect(p.footer).toBe("");
    // What the renderer sends to Chrome is JSON: absent and undefined keys look the same there.
    const sent = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    const merged = { ...STORY_SAMPLE_PROPS, ...sent };
    expect(merged.brand).toEqual({});
    expect(merged.footer).toBe("");
    expect(storySchema.parse(sent).scenes).toHaveLength(1);
  });

  it("rejects duplicate scene ids, including a default id taken explicitly", () => {
    expect(() => prepareStoryProps({ scenes: [{ id: "a", title: "1" }, { id: "a", title: "2" }] })).toThrow(/already used/);
    expect(() => prepareStoryProps({ scenes: [{ id: "s1", title: "1" }, { title: "2" }] })).toThrow(/already used/);
    expect(() => prepareStoryProps({ scenes: [{ id: "__proto__", title: "1" }] })).toThrow();
  });

  it("returns 400 for bad sounds, over-long lines and videos past the length limit", async () => {
    t = await setup({ MAX_RENDER_SECONDS: "30" });
    const post = (props: object) => t.post({ composition: "Story", props });
    const one = [{ title: "a" }];
    expect((await post({ scenes: one, sfx: [{ sound: "remotion:nope", at: 0 }] })).status).toBe(400);
    expect((await post({ scenes: one, sfx: [{ sound: "Whoosh", at: 0 }] })).status).toBe(400);
    expect((await post({ scenes: one, narration: { s0: "x".repeat(1201) } })).status).toBe(400);
    expect((await post({ scenes: [{ title: "a", seconds: 20 }, { title: "b", seconds: 20 }] })).status).toBe(400);
    expect((await post({ scenes: [{ title: "a", narration: "word ".repeat(200) }] })).status).toBe(400);
    expect((await post({ scenes: [{ id: "a", title: "1" }, { id: "a", title: "2" }] })).status).toBe(400);
    expect((await post({ scenes: one, sfx: [{ sound: "remotion:whoosh", at: 0 }] })).status).toBe(202);
  });
});

describe("Story props, round two", () => {
  it("takes only hex theme colours (they go into CSS)", async () => {
    t = await setup();
    const post = (theme: object) => t.post({ composition: "Story", props: { theme, scenes: [{ title: "a" }] } });
    expect((await post({ background: "#000 0%, #000 1%), url(https://127.0.0.1/x.png" })).status).toBe(400);
    expect((await post({ accent: "red" })).status).toBe(400);
    expect((await post({ muted: "rgb(1,2,3)" })).status).toBe(400);
    expect((await post({ background: "#0a0", accent: "#6C84FF" })).status).toBe(202);
    const p = prepareStoryProps({ theme: { background: "#0a0" }, scenes: [{ title: "a" }] });
    expect(p.theme.background).toBe("#00AA00");
  });

  it("accepts inline raster images, which need no host", async () => {
    t = await setup();
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    expect((await t.post({ composition: "Story", props: { scenes: [{ title: "a", image: png }] } })).status).toBe(202);
    expect((await t.post({ composition: "Story", props: { scenes: [{ title: "a", image: "data:image/svg+xml;base64,PHN2Zz4=" }] } })).status).toBe(400);
  });

  it("doesn't hold a still to the video length limit", async () => {
    t = await setup({ MAX_RENDER_SECONDS: "30" });
    const scenes = [{ title: "a", seconds: 20 }, { title: "b", seconds: 20 }];
    expect((await t.post({ composition: "Story", props: { scenes } })).status).toBe(400);
    expect((await t.post({ composition: "Story", kind: "still", frame: 10, props: { scenes } })).status).toBe(202);
  });
});

describe("Story layout", () => {
  const longest = {
    kicker: "K".repeat(80),
    title: "Quarterly results beat every estimate as revenue grows across all regions and the company raises its outlook for the rest of the year again",
    body: "Body text ".repeat(40),
  };
  const chrome = { brand: { name: "N".repeat(40), url: "https://www.northwind-analytics.com/reports/q3-2026-reviews" }, footer: "F ".repeat(80) };

  it("wraps greedily", () => {
    expect(wrapLines("aa bb cc", 10, 50, 10)).toBe(2); // "aa bb" = 50, then "cc"
    expect(wrapLines("a".repeat(30), 10, 100)).toBe(3); // one long word breaks
  });

  for (const [aspect, { width, height }] of Object.entries(ASPECTS)) {
    for (const font of ["sans", "serif", "mono"] as const) {
      it(`fits the longest allowed text between brand and footer at ${aspect} (${font})`, () => {
        const frame = storyFrame(chrome, width, height);
        const type = sceneType(longest, font, frame);
        expect(type.title, "title stays legible").toBeGreaterThanOrEqual(Math.round(84 * frame.unit * 0.66 * 0.4));
        // Content box is clear of the brand row and the footer block.
        expect(frame.content.top).toBeGreaterThan(frame.brandTop + 38 * frame.unit);
        expect(frame.content.height).toBeGreaterThan(height * 0.3);
        expect(frame.content.width).toBeLessThanOrEqual(width - 2 * frame.side);
      });
    }
  }

  it("keeps design sizes when the text is short", () => {
    const frame = storyFrame({}, 1080, 1920);
    expect(sceneType({ title: "Hello" }, "sans", frame).title).toBe(96);
  });
});
