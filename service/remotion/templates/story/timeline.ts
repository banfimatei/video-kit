import { fitScenesToVoice } from "@banfimatei/video-kit/core";
import type { StoryProps, StoryScene } from "./schema";
import { sceneId } from "./schema";

export const STORY_FPS = 30;
export const STORY_TRANSITION = 12;

const words = (s?: string) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

/** Reading time for a scene's type, clamped to 3–12s, or its `seconds` if longer. */
export function sceneSeconds(scene: StoryScene): number {
  const auto = Math.min(12, Math.max(3, 1.8 + 0.28 * (words(scene.title) + words(scene.body))));
  return Math.max(auto, scene.seconds ?? 0);
}

export function storyTimeline(props: Pick<StoryProps, "scenes" | "voiceover">, fps = STORY_FPS) {
  return fitScenesToVoice(
    props.scenes.map((s, i) => ({ id: sceneId(s, i), frames: Math.round(sceneSeconds(s) * fps) })),
    { fps, voiceover: props.voiceover, transitionFrames: STORY_TRANSITION },
  );
}
