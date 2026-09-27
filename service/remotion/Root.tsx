import "./fonts";
import { Composition, type CalculateMetadataFunction } from "remotion";
import { STORY_SAMPLE_PROPS } from "./templates/story/defaults";
import { ASPECTS, STORY_FPS, storySchema, storyTimeline, type StoryProps } from "./templates/story/schema";
import { Story } from "./templates/story/Story";


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
        defaultProps={STORY_SAMPLE_PROPS}
      />
    </>
  );
};
