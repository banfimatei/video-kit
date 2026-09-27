import { Audio } from "@remotion/media";
import type { Voiceover } from "../schema.js";
import { own } from "../timing/fitScenesToVoice.js";
import { resolveSound } from "./library.js";

/**
 * Plays each scene's voice line where fitScenesToVoice() placed it.
 *
 *   const t = fitScenesToVoice(scenes, { fps, voiceover, transitionFrames: 12 });
 *   <VoiceTrack voiceover={props.voiceover} starts={t.voiceStarts} />
 */
export const VoiceTrack: React.FC<{
  voiceover: Voiceover | null | undefined;
  starts: Record<string, number | null>;
  volume?: number;
}> = ({ voiceover, starts, volume = 1 }) => {
  if (!voiceover) return null;
  return (
    <>
      {Object.entries(voiceover).map(([scene, clip]) => {
        const from = own(starts, scene);
        if (!clip || from === null || from === undefined) return null;
        return (
          <Audio
            key={scene}
            name={`Voice: ${scene}`}
            src={resolveSound(clip.src)}
            from={from}
            volume={() => volume}
          />
        );
      })}
    </>
  );
};
