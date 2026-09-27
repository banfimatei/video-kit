import { useVideoConfig } from "remotion";
import type { SfxCue } from "../schema.js";
import { own } from "../timing/fitScenesToVoice.js";
import { Sfx } from "./Sfx.js";

/**
 * Place cues on the timeline: each at `at` seconds into its `scene` (per
 * `starts`, e.g. fitScenesToVoice().starts) or into the video. Cues whose
 * scene was skipped are dropped. `leadFrames` shifts a cue earlier, e.g. so
 * a whoosh peaks in the middle of the crossfade it announces.
 */
export const SfxCues: React.FC<{
  cues: SfxCue[] | undefined;
  starts?: Record<string, number | null>;
  leadFrames?: (cue: SfxCue) => number;
  label?: string;
}> = ({ cues, starts = {}, leadFrames, label = "SFX" }) => {
  const { fps } = useVideoConfig();
  if (!cues?.length) return null;
  return (
    <>
      {cues.map((cue, i) => {
        const base = cue.scene === undefined ? 0 : own(starts, cue.scene);
        if (base === null || base === undefined) return null;
        return (
          <Sfx
            key={`${label}-${i}`}
            name={`${label}: ${cue.sound}`}
            sound={cue.sound}
            from={base + Math.round(cue.at * fps) - (leadFrames?.(cue) ?? 0)}
            volume={cue.volume ?? 1}
            playbackRate={cue.playbackRate}
          />
        );
      })}
    </>
  );
};
