# video-kit

Programmatic video for all my projects, built on [Remotion](https://www.remotion.dev).
Data in, mp4 out: a voiced, sound-designed video from JSON, from any project,
in any language.

Two parts:

- **The library** (`@banfimatei/video-kit`, this repo's root) for projects that
  write their own Remotion compositions: voiceover (ElevenLabs, OpenAI, Gemini,
  espeak), sound effects, scenes that stretch to fit their voice lines, and one
  call to render.
- **The render service** (`service/`, deployed on Railway): an HTTP API with
  built-in templates, where projects can also upload their own compositions
  ("sites") and render them without installing Remotion or Chrome.

```
your project ──POST /v1/renders──▶ render service ──▶ TTS ──▶ headless Chrome ──▶ mp4
             ◀──── signed link ────  (queue, volume, retention)
```

## Use the service from a project

Any language: it's plain HTTP with a bearer key.

```bash
curl -s "$VIDEO_KIT_URL/v1/renders" \
  -H "Authorization: Bearer $VIDEO_KIT_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "composition": "Story",
    "props": {
      "aspect": "9:16",
      "brand": { "name": "Layway", "url": "layway.app" },
      "scenes": [
        { "kicker": "New", "title": "Split any payment", "narration": "Split any payment, in seconds." },
        { "title": "Pay back when it suits you", "body": "No interest, ever." }
      ]
    }
  }'
# → 202 {"id":"…","status":"queued",…}

curl -s "$VIDEO_KIT_URL/v1/renders/<id>" -H "Authorization: Bearer $VIDEO_KIT_API_KEY"
# → {"status":"done","result":{"videoUrl":"https://…/files/<id>/video.mp4?exp=…&sig=…", …}}
```

From TypeScript, with the client (fetch only; Node, Bun, Deno, edge):

```ts
import { createVideoKitClient } from "@banfimatei/video-kit/client";

const kit = createVideoKitClient({ baseUrl: process.env.VIDEO_KIT_URL!, apiKey: process.env.VIDEO_KIT_API_KEY! });
const job = await kit.renderAndWait({ composition: "Story", props: { scenes: [{ title: "Hello" }] } });
const mp4 = await kit.download(job); // Uint8Array
```

Or the CLI: `npx video-kit render Story --props=props.json --out=story.mp4`.

### API

All `/v1` routes need `Authorization: Bearer <RENDER_API_KEY>`.

| Method and path | What it does |
| --- | --- |
| `GET /healthz` | Liveness, version and queue size (no auth). |
| `GET /v1/templates[?site=name]` | Compositions you can render, with sizes, default props and (for built-ins) the JSON Schema of their props. |
| `POST /v1/renders` | Queue a render. Body: `composition`, `props`, and optionally `site` (default `builtin`), `tts`, `kind` (`video` or `still`), `frame`, `poster` (frame or `false`), `webhookUrl`. Returns `202` and the job. |
| `GET /v1/renders/:id` | The job: `status` (`queued`, `running`, `done`, `failed`, `canceled`), `stage`, `progress`, `position` while queued, `error`, and when done `result` with signed `videoUrl` / `posterUrl` / `stillUrl`. Every read signs fresh links. |
| `GET /v1/renders` | The 50 most recent jobs. |
| `DELETE /v1/renders/:id` | Cancel a queued or running render; on a finished one, delete it and its files. |
| `GET /v1/sites` | Uploaded sites. |
| `PUT /v1/sites/:name` | Upload a site: a gzipped tarball of a `remotion bundle` directory. Replaces the previous version; renders in flight keep theirs. |
| `DELETE /v1/sites/:name` | Remove a site. |
| `GET /files/:id/<file>` | A render's `video.mp4`, `video.poster.png` or `still.png`, by signed link (or bearer key). Supports `Range`. |

Webhooks: with `webhookUrl`, the finished job is POSTed as JSON with
`X-Video-Kit-Signature: sha256=<hex HMAC of the body>`, signed with the
service's signing secret (retried 3 times).

Limits (environment variables): `MAX_QUEUE` (25), `MAX_RENDER_SECONDS` (180),
`MAX_SITE_MB` (300), `MAX_BODY_KB` (1024). Finished renders are deleted after
`RETENTION_DAYS` (7); links last `URL_TTL_HOURS` (168) at most.

### Built-in template: Story

A narrated multi-scene short for anything: kicker, title and body per scene,
over an optional image; persistent brand line and footer; per-scene voice with
each scene stretched to fit its line; quiet house sound design. Full schema:
`GET /v1/templates` or [`service/remotion/templates/story/schema.ts`](service/remotion/templates/story/schema.ts).

| Prop | |
| --- | --- |
| `aspect` | `9:16` (default), `4:5`, `1:1`, `16:9` |
| `theme` | `background`, `foreground`, `muted`, `accent` colors; headline `font`: `sans`, `serif`, `mono` |
| `brand` | `name` (top left), `url` (bottom right) |
| `footer` | A line on every frame, never animated: a disclaimer or credit |
| `scenes[]` | `title` (required), `kicker`, `body`, `image` (https), `narration`, `seconds` (minimum), `id` |
| `soundDesign` | `house` (default) or `none` |
| `sfx[]` | Extra sounds: `{ sound, at, scene?, volume?, playbackRate? }` |

### Your own compositions: sites

When the built-ins aren't enough, render your project's own Remotion
compositions (your brand, your layouts) on the service:

```bash
# in your Remotion project
npx video-kit site deploy myproject             # bundles src/index.ts, uploads it
npx video-kit render MyComposition --site=myproject --props=props.json --out=out.mp4
```

Without the CLI, upload the output of `npx remotion bundle` yourself:
`tar -czf site.tgz -C build . && curl -X PUT --data-binary @site.tgz -H "Content-Type: application/gzip" -H "Authorization: Bearer …" $VIDEO_KIT_URL/v1/sites/myproject`.

The service voices a site's `props.narration` (an object of scene id → text)
into `props.voiceover` (scene id → `{ src, durationInSeconds }`) before it
renders, so a composition gets a voice by reading those two props, which is
what the library below is for.

## Use the library in a Remotion project

```bash
npm install github:banfimatei/video-kit    # needs read access to this repo
```

Inside compositions:

```tsx
import { audioPropsSchema, fitScenesToVoice, SfxCues, VoiceTrack, Sfx } from "@banfimatei/video-kit";

const schema = z.object({ title: z.string(), ...audioPropsSchema.shape }); // narration, voiceover, soundDesign, sfx

const t = fitScenesToVoice(
  [{ id: "intro", frames: 90 }, { id: "main", frames: 150 }],
  { fps, voiceover: props.voiceover, transitionFrames: 12 },
);
// t.durations → <TransitionSeries.Sequence durationInFrames>, t.durationInFrames → calculateMetadata
<VoiceTrack voiceover={props.voiceover} starts={t.voiceStarts} />
<SfxCues cues={props.sfx} starts={t.starts} />
<Sfx sound="whoosh" from={t.starts.main! - 4} volume={0.3} />
```

Sounds: house cues (`tick`, `whoosh`, `thud`, `chime`, `riser`, `page`,
generated by `scripts/make-sfx.ts`, bundled, license-free), the
[@remotion/sfx](https://www.remotion.dev/docs/sfx) catalog as `remotion:<name>`,
any URL, or any file in your `public/`.

In Node:

```ts
import { renderComposition } from "@banfimatei/video-kit/node";

await renderComposition({
  entryPoint: "src/index.ts",
  compositionId: "MyVideo",
  inputProps: { narration: { intro: "Hello.", main: "Here's the thing." } },
  output: "out/my-video.mp4",
  tts: "elevenlabs", // or openai | gemini | espeak | none; default: whichever key is set
});
```

`@banfimatei/video-kit/core` has the schemas and timing without any browser
assets, for validating props in Node.

### Voice providers

| `tts` | Needs | Tuning |
| --- | --- | --- |
| `elevenlabs` | `ELEVENLABS_API_KEY` | `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`, `OPENAI_TTS_INSTRUCTIONS` |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` |
| `espeak` | `espeak-ng` installed | Robotic: offline tests and CI |

Clips are cached by a hash of provider, voice and text, so re-rendering the
same script costs nothing.

## Deploying the service (Railway)

The repo deploys as one Railway service from the root `Dockerfile`
(`railway.json` sets the health check). It needs:

- a **volume** mounted at `/data` (renders, sites, voice cache, job records);
- `RENDER_API_KEY` (32+ random characters);
- a TTS key if you want voices (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY` or
  `GEMINI_API_KEY`);
- a public domain. `RAILWAY_PUBLIC_DOMAIN` is used for links automatically.

Everything else has defaults: see [`service/.env.example`](service/.env.example).
One render runs at a time (`RENDER_CONCURRENCY`); each is a headless Chrome,
so give the service 2+ GB of RAM per concurrent render.

## Local development

```bash
npm install                       # builds the library (prepare)
npm test                          # library + service tests
cd service
npm run bundle                    # built-in templates → service/bundle
npm run studio                    # preview the built-in templates
RENDER_API_KEY=dev-key-0123456789ab npm run dev
VIDEO_KIT_URL=http://localhost:8080 VIDEO_KIT_API_KEY=dev-key-0123456789ab SMOKE_TTS=espeak npm run smoke
```

Where Remotion can't download its headless Chrome, set
`REMOTION_BROWSER_EXECUTABLE` to a local one.

## License

Remotion is not MIT. It is free for individuals, companies of up to three
people and non-profits; bigger companies need a
[Company License](https://www.remotion.pro/license). This service is used
across my own projects, which is covered as an individual; renders for a
company's product fall under that company's size. TTS output is governed by
each provider's terms. The house sound effects are generated here and carry no
license.
