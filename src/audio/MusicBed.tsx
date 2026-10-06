import { Audio } from "@remotion/media";
import { useVideoConfig } from "remotion";
import type { MusicTrack, Voiceover } from "../schema.js";
import { own } from "../timing/fitScenesToVoice.js";
import { resolveSound } from "./library.js";

/**
 * The render's music bed: faded in and out, and ducked while a voice line plays.
 *
 *   <MusicBed track={props.musicTrack} voiceover={props.voiceover} voiceStarts={t.voiceStarts} />
 *
 * The bed's `beats` and `strongCues` time the pictures, not this component.
 * Move an entrance with nudgeToBeat or nudgeToStrongCue, then play the bed here.
 */
export const MusicBed: React.FC<{
  track: MusicTrack | null | undefined;
  /** Level when nobody is speaking. Default 0.32, under the voice. */
  volume?: number;
  /** Level under a voice line. Default 0.12. */
  duckTo?: number;
  voiceover?: Voiceover | null;
  /** Frame each scene's line starts at, from fitScenesToVoice().voiceStarts. */
  voiceStarts?: Record<string, number | null>;
}> = ({ track, volume = 0.32, duckTo = 0.12, voiceover, voiceStarts }) => {
  const { fps, durationInFrames } = useVideoConfig();
  if (!track?.src) return null;
  const seconds = durationInFrames / fps;
  return (
    <Audio
      name="Music"
      src={resolveSound(track.src)}
      volume={(frame: number) => {
        const t = frame / fps;
        const fadeIn = Math.min(1, t / 0.4);
        const fadeOut = Math.min(1, Math.max(0, seconds - t) / 0.8);
        const level = voiceCovers(t, voiceover, voiceStarts, fps) ? duckTo : volume;
        return level * fadeIn * fadeOut;
      }}
    />
  );
};

function voiceCovers(
  t: number,
  voiceover: Voiceover | null | undefined,
  starts: Record<string, number | null> | undefined,
  fps: number,
): boolean {
  if (!voiceover || !starts) return false;
  for (const [scene, clip] of Object.entries(voiceover)) {
    if (!clip) continue;
    const from = own(starts, scene);
    if (from === null || from === undefined) continue;
    const start = from / fps;
    if (t >= start && t < start + clip.durationInSeconds) return true;
  }
  return false;
}
