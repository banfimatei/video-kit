import * as remotionSfx from "@remotion/sfx";
import { staticFile } from "remotion";
import type { HouseSound } from "../schema.js";
import chime from "../../assets/sfx/chime.wav";
import page from "../../assets/sfx/page.wav";
import riser from "../../assets/sfx/riser.wav";
import thud from "../../assets/sfx/thud.wav";
import tick from "../../assets/sfx/tick.wav";
import whoosh from "../../assets/sfx/whoosh.wav";

/**
 * House cues: quiet, printed-page sounds synthesized by scripts/make-sfx.ts.
 * They ship inside this package and the Remotion bundler emits them with the
 * project, so they play with no network and carry no licence.
 */
export const HOUSE_SFX = { tick, whoosh, thud, chime, riser, page } as const satisfies Record<HouseSound, string>;
export type HouseSfx = keyof typeof HOUSE_SFX;
export const HOUSE_SFX_NAMES = Object.keys(HOUSE_SFX) as HouseSfx[];

/** The @remotion/sfx catalog (whoosh, pageTurn, ding, vineBoom …), streamed from remotion.media at render time. */
export const REMOTION_SFX: Readonly<Record<string, string>> = { ...remotionSfx };

/**
 * Turn a sound reference into something <Audio> can play:
 * - a house cue: "tick", "whoosh", "thud", "chime", "riser", "page"
 * - an @remotion/sfx name: "remotion:vineBoom"
 * - an http(s) URL
 * - a path under the project's public/: "sfx/boom.wav"
 */
export function resolveSound(sound: string): string {
  if (Object.prototype.hasOwnProperty.call(HOUSE_SFX, sound)) {
    return HOUSE_SFX[sound as HouseSfx];
  }
  if (sound.startsWith("remotion:")) {
    const name = sound.slice("remotion:".length);
    const url = Object.prototype.hasOwnProperty.call(REMOTION_SFX, name)
      ? REMOTION_SFX[name]
      : undefined;
    if (!url) {
      throw new Error(
        `Unknown @remotion/sfx sound "${name}". Known: ${Object.keys(REMOTION_SFX).join(", ")}.`,
      );
    }
    return url;
  }
  if (/^https?:\/\//i.test(sound) || sound.startsWith("data:")) return sound;
  return staticFile(sound.replace(/^\/+/, ""));
}
