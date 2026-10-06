import { MusicBed, nudgeToBeat, nudgeToStrongCue, own, SfxCues, VoiceTrack, type MusicTrack, type SfxCue } from "@banfimatei/video-kit";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { AbsoluteFill, useVideoConfig } from "remotion";
import { storyFrame } from "./layout";
import { Chrome, Scene } from "./Scene";
import { sceneId, STORY_TRANSITION, storySchema, storyTimeline, type StoryProps } from "./schema";

/**
 * Quiet cues: a tick as each title lands, a whoosh through each crossfade, a
 * chime on the last scene. With a music bed, a tick may slide onto a beat and
 * a whoosh or chime onto a strong cue, and only when it is already close.
 */
function houseCues(ids: string[], fps: number, starts: Record<string, number | null>, track: MusicTrack | null | undefined): SfxCue[] {
  const align = (scene: string, at: number, kind: "beat" | "strong") => {
    if (!track) return at;
    const start = (own(starts, scene) ?? 0) / fps;
    const nudged = kind === "beat" ? nudgeToBeat(start + at, track.beats) : nudgeToStrongCue(start + at, track.strongCues);
    return Math.max(0, nudged - start);
  };
  const cues: SfxCue[] = [];
  ids.forEach((id, i) => {
    cues.push({ sound: "tick", scene: id, at: align(id, (i === 0 ? 8 : 16) / fps, "beat"), volume: 0.22 });
    if (i > 0) cues.push({ sound: "whoosh", scene: id, at: align(id, 0, "strong"), volume: 0.22 });
  });
  if (ids.length > 1) cues.push({ sound: "chime", scene: ids[ids.length - 1], at: align(ids[ids.length - 1], 30 / fps, "strong"), volume: 0.25 });
  return cues;
}

/**
 * A narrated multi-scene short for any project: kicker, title and body per
 * scene over an optional image, a persistent brand line, per-scene voice
 * (fit to its line) and house sound design. Props: ./schema.ts.
 */
export const Story: React.FC<StoryProps> = (raw) => {
  const props = storySchema.parse(raw);
  const { fps, width, height } = useVideoConfig();
  const layout = storyFrame(props, width, height);
  const t = storyTimeline(props, fps);
  const ids = props.scenes.map((s, i) => sceneId(s, i));

  return (
    <AbsoluteFill style={{ backgroundColor: props.theme.background }}>
      <TransitionSeries>
        {props.scenes.flatMap((scene, i) => [
          i > 0 ? (
            <TransitionSeries.Transition
              key={`t-${ids[i]}`}
              presentation={fade()}
              timing={linearTiming({ durationInFrames: STORY_TRANSITION })}
            />
          ) : null,
          <TransitionSeries.Sequence key={ids[i]} name={`Scene ${ids[i]}`} durationInFrames={t.durations[ids[i]] as number}>
            <Scene scene={scene} theme={props.theme} isFirst={i === 0} layout={layout} />
          </TransitionSeries.Sequence>,
        ])}
      </TransitionSeries>
      <Chrome props={props} layout={layout} />
      <VoiceTrack voiceover={props.voiceover} starts={t.voiceStarts} />
      <MusicBed track={props.musicTrack} volume={0.2} duckTo={0.1} voiceover={props.voiceover} voiceStarts={t.voiceStarts} />
      {props.soundDesign === "none" ? null : (
        <SfxCues cues={houseCues(ids, fps, t.starts, props.musicTrack)} starts={t.starts} label="House" leadFrames={(c) => (c.sound === "whoosh" ? 4 : 0)} />
      )}
      <SfxCues cues={props.sfx} starts={t.starts} />
    </AbsoluteFill>
  );
};
