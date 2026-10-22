---
name: launch
description: Turn the current project into a short shareable launch video with video-kit. Use when someone says "launch video", "brag about this", "let's brag", "share what I built", or "make a video of this project".
---

# Launch video

Make a 15–25 second film of the project in front of you and render it with video-kit. You own the story, the pictures and the copy. video-kit voices, lays a music bed with a beat grid, and renders.

The shape of this skill is adapted from [brag](https://github.com/latent-spaces/brag) (MIT). The renderer is video-kit, not Hyperframes.

Write everything to `launch-output/` (or `launch-output-YYYY-MM-DD-HHmmss/` if that folder already exists).

## Options

| Option | Default |
|---|---|
| `--tone` | a preset, or a freeform direction such as "fake Series A launch from 2016". Inferred when absent. |
| `--format` | `landscape` (1920×1080), `vertical` (1080×1920) or `square` (1080×1080). Story's names for these are `16:9`, `9:16`, `1:1`. |
| `--duration` | about 20 seconds, inside 15–25 |
| `--voice` | off. Narrate only when the user asks. |
| `--no-music` | music on |
| `--title` | inferred |

## 1. Inspect

Read the project. Skip `dist/`, lockfiles, tests, `.git`, and anything that could hold a secret (`.env`, keys, credentials). Nothing you read may appear on screen unless it is already public copy: no keys, no customer names, no internal hostnames. Substitute fictional stand-ins and say so in the plan.

From a site or app, in this order: the page the visitor sees, its CSS (exact colors and fonts), the README, routes and the screens of the real flow. The best material is the product in use, not the landing page describing it. Find two or three beats: entry, the key action, the result.

Answer, in `launch-output/plan.md`, before you design a frame:

1. What does it do, in one sentence?
2. Who is it for?
3. What is the line that earns a reaction?
4. What is the visual hook (a color, a control, a screen)?
5. What real UI or flow should be on screen?
6. What is the shortest film that lands it?
7. Which tone fits, and what is the freeform direction?
8. What should the one-line share caption say?

## 2. Plan

Shape, as a start rather than a template: hook (2–3s), reveal (2–4s), two or three highlights, punchline (2–4s). Scene durations sum to the target. 18–22 seconds is the usual length.

| Tone | Feel | Scenes |
|---|---|---|
| `default` | Punchy, playful, clean | 4–5, soft cuts |
| `polished` | Serious, restrained | 3–4, long holds |
| `yc-parody` | Deadpan startup launch, played straight | 4–5, one claim each, hard cuts |
| `chaotic` | Fast, loud | 6–8, some under 2s |
| `deadpan` | Dry, nothing is a joke | 3–4, empty space, slow fades |
| `cinematic` | Trailer scale | 4–5, big type |
| `app-store` | Feature cards | 4–6, smooth slides |

A freeform direction refines the preset. It does not throw the laws out.

**Short.** 15–25 seconds. Narration does not extend it.

**Clear to a stranger.** After one viewing they know what it does, who it is for, and how to get it.

**The hook is first.** The opening two seconds are the decision.

**Show the thing.** At least one scene is real UI, real copy, or the product doing its job. Prefer the working flow over a landing-page diagram. No abstract filler.

**Specific.** Use the project's own words. "Streamline your workflow" is banned, and so is any claim, number or testimonial the project does not make. Jokes and connective lines may be invented. Facts on screen may not.

**Readable.** Pace comes from motion and cuts. A label stays fully visible about 0.8s. A sentence stays about 0.3s per word, and at least 1.2s. Fast in, then hold.

**Alive.** Things that arrive one by one, and a simulated click, swipe or keystroke, beat a slide of three bullets.

**Funny earns it.** The humor is the project's, not a joke laid on top.

Record the project's background, text, accent and fonts as exact values. Record the storyboard with a duration per scene, what must be seen, and where a sequential reveal or a simulated action happens.

## 3. Build

Two ways. Use the first when the film has to show real UI. Use the second when it is type, color and a few images.

### A custom composition

A Remotion composition in the project, using video-kit:

```tsx
import { fitScenesToVoice, MusicBed, nudgeToBeat, nudgeToStrongCue, Sfx, VoiceTrack } from "@banfimatei/video-kit";
```

Reuse the project's real components, styles and assets when you can. Rebuild only what you cannot import.

If the composition parses props with zod, spread `audioPropsSchema.shape` into that schema (or the bed is stripped). Leave `musicTrack` null in any `defaultProps`: Remotion merges those under the render, and the renderer replaces null with the bed it composed.

Time the pictures against the bed the renderer will attach as `props.musicTrack`:

- A major reveal moves with `nudgeToStrongCue(time, track.strongCues)` (within 0.15s).
- A card, a stat or a line in a sequence moves with `nudgeToBeat(time, track.beats)` (within 0.10s).
- If the cue is farther away, keep the planned time. Readable text never steps faster than the reading floor, even when the beats do.
- One to three strong-cue locks in the whole film. The grid is a hint.

Play the bed with `<MusicBed track={props.musicTrack} />`. Pass `voiceover` and `voiceStarts` when there is a voice, so the bed ducks. Without a voice, leave the default level.

House cues, by how often they can play:

| Cue | Use |
|---|---|
| `click`, `key`, `soft` | Repeating UI: taps, typing, cards arriving. These are the dull ones. |
| `tick` | A title landing. Fine on each scene, brighter than a click. |
| `whoosh`, `thud` | One transition, not a roll. |
| `bell`, `chime` | One payoff in the whole film. |
| `page`, `riser` | Once. They are the brightest. |

Match the sound to the gesture and put it on the frame the motion starts. `deadpan` and `polished` get two or three cues. `chaotic` can be denser, and still not a bright sound on every frame. Vary `playbackRate` slightly when a key repeats, so it does not machine-gun.

Voice stays off unless the user asked. When it is on, the words complement the picture and do not read the titles aloud. Scenes stretch to the line (`fitScenesToVoice`); if the line makes the film longer than 25 seconds, cut the script.

### The Story template

For a type-led film, post the built-in `Story` composition. Set `aspect`, `theme` from the project's colors, `brand`, and `scenes` with `kicker`, `title`, `body`, an `image` only when you have a real one, and `seconds` so the scenes sum to the target. `footer` is a line that never animates: a credit or nothing (`""`).

Story plays `musicTrack`, ducks it under the voice, and nudges its own ticks and whooshes. You do not place those by hand. Add `sfx` for anything extra (`click`, `key`, `soft`, `bell`).

Story cannot recreate a product UI. If the film needs that, use a custom composition.

## 4. Render

With `VIDEO_KIT_URL` and `VIDEO_KIT_API_KEY` set, the service renders. Otherwise render locally (`--local`), which needs Remotion and Chrome.

Pick the poster frame yourself: a settled beat, text fully in, not a fade. Frame 60 is only the default, and it is often the wrong one.

```bash
npx video-kit render Story --props launch-output/props.json \
  --music --music-prompt "instrumental, warm, steady, no vocals, a clean ending" \
  --poster 48 --out launch-output/launch.mp4
```

`--no-music` omits `--music`. A custom composition uses `--local --entry <file>` and the same `--music` and `--poster` flags. `--voice` is `--tts` plus narration in the props; leave both off unless the user asked.

The poster png is written beside the mp4 (`launch.poster.png` locally, `video.poster.png` on the service). Frame 0 of the mp4 is that still when ffmpeg is available.

## 5. Deliver

`launch-output/share.txt`: one to three sentences, postable as-is, specific to this project, in the tone of the film. No "excited to share".

Then tell the user where the mp4 and the caption are, one sentence on the angle, and that you can re-roll a scene or change the tone.
