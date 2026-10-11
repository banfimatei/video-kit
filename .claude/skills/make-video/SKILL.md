---
name: make-video
description: Make a narrated short video, or a still frame of one, from a brief, using the video-kit render service and its Story template. Use whenever the user asks for a video, short, reel, clip, promo, explainer, story, teaser, announcement or a frame of one, in any language, even if they don't say "video-kit".
---

# Make a video

The render service turns JSON into a voiced, sound-designed mp4. Your job is
the script and the look: write Story props, check the frames as stills, then
render. Everything runs through the CLI in this repo: `npx video-kit`.

## Setup

1. The CLI needs `VIDEO_KIT_URL` and `VIDEO_KIT_API_KEY`. If they aren't set,
   load them from the repo's `.env` when there is one:
   `set -a; . ./.env; set +a` (same shell as the commands below, so put both
   in one command). Without either, ask the user for the service URL and key;
   never guess them. The service's own `RENDER_API_KEY` is the key.
2. `npx video-kit templates` must answer with the Story template. A connection
   error means the URL is wrong or the host isn't reachable from here (in a
   cloud session, the Railway domain has to be allowed by the environment).
3. Work in `out/<slug>/` (gitignored): `props.json`, the stills and the mp4.

## Workflow

1. **Brief to script.** Decide aspect (9:16 for TikTok, Reels, Shorts and
   stories; 1:1 or 4:5 for feeds; 16:9 for YouTube and web), the number of
   scenes, and write every scene with its narration. Put brand name and URL in
   `brand` and anything legal in `footer`. Show the user the scene list before
   rendering when the brief leaves the content open; go straight to render
   when it's specific.
2. **Layout check, no voice.** Render a still of the longest scene (and the
   first, if it's different) with `--tts none`, so it is quick and costs no
   TTS: `npx video-kit render Story --props out/<slug>/props.json --tts none
   --scene s2 --out out/<slug>/s2.png`. Scene ids are the scenes' own `id`
   or `s0`, `s1`, … by position. Open the PNG with the Read tool and look:
   is the title readable at phone size, is nothing cut, does the image sit
   well under the type, do brand and footer fit? Long titles shrink to fit
   and over-long words break; if the type got small, shorten the text.
3. **Render.** `npx video-kit render Story --props out/<slug>/props.json
   --out out/<slug>/<slug>.mp4` with the voice the user wants (see Voices).
   The CLI streams progress on stderr and prints the job id and the signed
   `videoUrl` and `posterUrl` as JSON on stdout. Links last a week at most.
4. **Report.** The local file, the signed link, the length and the voice, in
   two lines. Offer one round of changes; a re-render reuses cached voice
   clips for unchanged lines, so edits are cheap.

Renders are queued one at a time and a 60-second video takes a minute or two.
`npx video-kit renders` lists recent jobs; `npx video-kit cancel <id>` stops
one. A `400` names the bad field: fix the props and resubmit.

## Writing the Story

A Story is 1–20 scenes, each a card with a `kicker` (a small label), a
`title` (the big line, required) and a `body` (a sentence or two), over an
optional full-bleed `image`, with its own `narration`. Scenes crossfade; each
stretches to fit its voice line, so a scene is as long as its narration plus
a breath, and at least 3 seconds.

- One idea per scene. Five to eight scenes make a 30–60 second video.
- Titles under eight words; bodies under twenty-five. Kicker: a label, not a
  sentence ("New", "Step 2", "Why it matters").
- Narration is the script. One or two spoken sentences per scene, 8–25 words,
  written for the ear: short, concrete, no slashes or parentheses, numbers
  as words where that's how they are said. Don't repeat the title verbatim.
  It can differ from the text on screen; the text is the headline, the voice
  is the story.
- First scene: the hook, one line. Last scene: the ask, with the brand URL on
  screen (the `brand.url` already shows bottom right).
- Write narration in the user's language; a voice that handles it is in
  Voices. Match on-screen text to the same language.
- `seconds` sets a scene's minimum length, for a scene that needs reading
  time without narration. Otherwise leave timing to the voice.
- Sound: `soundDesign: "house"` (default) adds quiet ticks, whooshes and a
  closing chime. `"none"` for a bare video. Extra `sfx` cues only when asked.

Limits the service enforces: titles 160 characters, bodies 400, narration
1200 per scene, 40 lines and 12000 characters per video, 20 scenes, and 180
seconds of video (the service refuses longer scripts before voicing them).
About 2.5 words per second of narration, plus 3 seconds minimum per scene,
tells you the length.

## Props

```json
{
  "aspect": "9:16",
  "theme": { "background": "#121212", "foreground": "#F5F3EE", "muted": "#A8A39A", "accent": "#6C84FF", "font": "sans" },
  "brand": { "name": "Layway", "url": "layway.app" },
  "footer": "Credit subject to approval.",
  "scenes": [
    { "id": "hook", "kicker": "New", "title": "Split any payment", "narration": "Split any payment, in seconds, from the app you already use." },
    { "id": "how", "title": "Three taps, done", "body": "Pick a purchase, choose a plan, confirm.", "image": "https://example.com/phone.jpg", "narration": "Pick a purchase, choose a plan, confirm. That's it." },
    { "id": "cta", "kicker": "Today", "title": "Try it at layway.app", "narration": "Try it today at layway dot app." }
  ],
  "soundDesign": "house"
}
```

| Prop | Notes |
| --- | --- |
| `aspect` | `9:16` (default), `4:5`, `1:1`, `16:9` |
| `theme` | Hex colours only. `font`: `sans` (Inter), `serif` (Newsreader), `mono` (JetBrains Mono) for headlines; body is always the sans. Dark background and light foreground by default; a light theme needs a dark `foreground` and `muted` |
| `brand` | `name` top left (40 chars), `url` bottom right (60) |
| `footer` | One line on every frame, never animated (160) |
| `scenes[].image` | An `https` URL on a public host (not localhost or a private network), or a `data:image/(png|jpeg|webp|gif);base64,…` URI for a local file. The request body is capped at 1 MB, so keep inline images under ~700 KB (resize first) |
| `scenes[].id` | Letters, digits, `_`, `-`; unique; default `s0`, `s1`, … |
| `sfx[]` | `{ "sound": "whoosh", "scene": "how", "at": 0.5, "volume": 0.3 }`. Sounds: `tick`, `whoosh`, `thud`, `chime`, `riser`, `page`, `remotion:<name>` from @remotion/sfx, or an https URL |

The full JSON Schema comes with `npx video-kit templates`.

## Voices and music

`--tts` picks the provider; without it the service uses whichever key it has.
`--voice` and `--model` pick a voice and model for this render:

| Provider | Good for | Voices |
| --- | --- | --- |
| `elevenlabs` | Best quality, most languages (`eleven_multilingual_v2`) | `--voice <voice id>`; the service's default voice otherwise |
| `openai` | Natural English, styled by instruction | `alloy`, `ash`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer` |
| `gemini` | Many languages | `Charon`, `Kore`, `Puck`, `Zephyr`, `Fenrir`, `Aoede` |
| `deepgram` | Fast, cheap English and Spanish | `--voice aura-2-thalia-en`, `aura-2-apollo-en`, `aura-2-draco-en`, `aura-2-agustina-es`, `flux-hannah-en`, `flux-miles-en` |
| `openrouter` | Any speech model on OpenRouter | `--model google/gemini-3.8-flash-tts --voice Kore` |
| `espeak` | Offline, robotic | Tests only |
| `none` | No voice | Layout stills, silent videos |

Ask which provider when the brief doesn't say and the service might have
several keys; otherwise let the service choose. A voice name the provider
doesn't have fails the render with its message; fix and resubmit.

`--music elevenlabs` adds an instrumental bed composed to the video's length;
`--music "warm acoustic guitar, unhurried"` prompts it. Only when asked:
it is a paid call and the Story template plays it under the voice.

## When the Story template isn't enough

Projects with their own Remotion compositions deploy them as a site
(`npx video-kit site deploy <name>`) and render with `--site <name>`; those
compositions define their own props (`npx video-kit templates --site <name>`),
and `--scene` doesn't apply to them (use `--still <frame>`). Building a new
built-in template is development work on the service: see CLAUDE.md.
