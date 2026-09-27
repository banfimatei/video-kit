import type { StoryProps } from "./schema.js";

/**
 * The Studio preview and the example GET /v1/templates shows. Remotion merges
 * these under every render's props, so prepareStoryProps() sets each of
 * these keys explicitly; nothing here can leak into a client's video.
 */
export const STORY_SAMPLE_PROPS: StoryProps = {
  aspect: "9:16",
  theme: { background: "#121212", foreground: "#F5F3EE", muted: "#A8A39A", accent: "#6C84FF", font: "sans" },
  brand: { name: "video-kit", url: "github.com/banfimatei" },
  footer: "Rendered from data by the video-kit render service.",
  scenes: [
    {
      kicker: "video-kit",
      title: "Videos from data, for every project",
      body: "Send scenes and narration; get back an mp4.",
      narration: "Videos from data, for every project. Send scenes and narration, get back an mp4.",
    },
    {
      kicker: "Voice",
      title: "Each scene stretches to fit its line",
      narration: "Each scene stretches to fit its voice line, so nothing is cut off.",
    },
    {
      kicker: "Sound",
      title: "House cues on every beat",
      body: "Or any sound effect you name.",
    },
  ],
};
