import { describe, expect, it } from "vitest";
import { renderComposition } from "../src/node/render.js";

describe("renderComposition", () => {
  it("refuses to start once its signal has fired", async () => {
    const ctl = new AbortController();
    ctl.abort("canceled");
    await expect(
      renderComposition({ serveUrl: "/nowhere", compositionId: "X", inputProps: {}, output: "/tmp/never.mp4", signal: ctl.signal }),
    ).rejects.toBe("canceled");
  });

  it("wants exactly one of entryPoint and serveUrl", async () => {
    await expect(renderComposition({ compositionId: "X", inputProps: {}, output: "/tmp/never.mp4" })).rejects.toThrow(/exactly one/);
  });
});
