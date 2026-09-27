import { Audio } from "@remotion/media";
import { Sequence } from "remotion";
import { resolveSound } from "./library.js";

/**
 * One sound effect on the timeline:
 *
 *   <Sfx sound="whoosh" from={2 * fps} volume={0.3} />
 *   <Sfx sound="remotion:ding" from={90} />
 *   <Sfx sound="https://example.com/boom.wav" from={0} playbackRate={0.8} />
 */
export const Sfx: React.FC<{
  sound: string;
  from: number;
  volume?: number;
  playbackRate?: number;
  name?: string;
}> = ({ sound, from, volume = 1, playbackRate, name }) => {
  return (
    <Sequence name={name ?? `SFX: ${sound}`} from={Math.max(0, Math.round(from))} layout="none">
      <Audio src={resolveSound(sound)} volume={() => volume} playbackRate={playbackRate} />
    </Sequence>
  );
};
