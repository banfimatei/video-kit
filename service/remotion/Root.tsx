import "./fonts";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { ASPECTS, storySchema, type StoryProps } from "./templates/story/schema";
import { Story } from "./templates/story/Story";
import { STORY_FPS, storyTimeline } from "./templates/story/timeline";

const storyMetadata: CalculateMetadataFunction<StoryProps> = ({ props }) => {
  const parsed = storySchema.parse(props);
  return {
    ...ASPECTS[parsed.aspect],
    durationInFrames: storyTimeline(parsed, STORY_FPS).durationInFrames,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Story"
        component={Story}
        schema={storySchema}
        calculateMetadata={storyMetadata}
        fps={STORY_FPS}
        width={1080}
        height={1920}
        defaultProps={{
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
        }}
      />
    </>
  );
};
