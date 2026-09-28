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

Or the CLI, once the library is installed (`npm install github:banfimatei/video-kit`):
`npx video-kit render Story --props props.json --out story.mp4`. Without
installing: `npx -p github:banfimatei/video-kit video-kit render …`.

The client only needs `fetch`: Remotion, React and zod are optional peers, so
a project that only calls the service installs none of them.

### API

All `/v1` routes need `Authorization: Bearer <RENDER_API_KEY>`.

| Method and path | What it does |
| --- | --- |
| `GET /healthz` | Liveness, version and queue size (no auth). `503` while the service drains for a restart. |
| `GET /v1/templates[?site=name]` | Compositions you can render, with sizes, default props and (for built-ins) the JSON Schema of their props. |
| `POST /v1/renders` | Queue a render. Body: `composition`, `props`, and optionally `site` (default `builtin`), `tts`, `kind` (`video` or `still`), `frame`, `poster` (frame or `false`), `webhookUrl`. Returns `202` and the job; `400` with the bad fields for invalid input, `429` when the queue is full, `503` while restarting. |
| `GET /v1/renders/:id` | The job: `status` (`queued`, `running`, `done`, `failed`, `canceled`), `stage`, `progress`, `position` while queued, `error`, and when done `result` with signed `videoUrl` / `posterUrl` / `stillUrl` and `expiresAt`. Every read signs fresh links, valid until `URL_TTL_HOURS` from now or the render's deletion, whichever is first. |
| `GET /v1/renders` | The 50 most recent jobs. |
| `DELETE /v1/renders/:id` | Cancel a queued or running render (at any stage: voicing, rendering, poster); on a finished one, delete it and its files. |
| `GET /v1/sites` | Uploaded sites. |
| `PUT /v1/sites/:name` | Upload a site: a gzipped tarball of a `remotion bundle` directory. Replaces the previous version; renders in flight keep theirs. |
| `DELETE /v1/sites/:name` | Remove a site; `409` while renders of it are queued or running. |
| `GET /files/:id/<file>` | A render's `video.mp4`, `video.poster.png` or `still.png`, by signed link (or bearer key). Supports `Range` and `HEAD`. |

Webhooks: with `webhookUrl`, the job is POSTed as JSON once it is `done`,
`failed` or `canceled` (including a cancel while queued), with
`X-Video-Kit-Signature: sha256=<hex HMAC-SHA256 of the raw body>` and
`X-Video-Kit-Job: <id>`. Delivery is at least once: up to 3 attempts (now,
+5s, +30s; a 4xx other than 408/429 stops early), redirects are not followed,
and a delivery still owed when the service restarts is sent after it. Dedupe
by job id. The URL must be http(s) on a public host (loopback, private,
link-local and `*.internal` are refused; `ALLOW_PRIVATE_URLS=1` lifts that).
Verify with the client:

```ts
import { verifyWebhook } from "@banfimatei/video-kit/client";
const ok = await verifyWebhook(rawBody, req.headers["x-video-kit-signature"], { secret: process.env.VIDEO_KIT_WEBHOOK_SECRET! });
```

The webhook key is the service's `WEBHOOK_SECRET`, or, when that isn't set,
the lowercase hex of HMAC-SHA256(`RENDER_API_KEY`, `"video-kit:webhook"`),
used as a UTF-8 string key (`webhookSecretFromApiKey(apiKey)` computes it).
Outside TypeScript: the signature is the hex HMAC-SHA256 of the raw body under
that key. Give receivers that key,
never the API key: it only verifies webhooks, while the API key can call the
whole API and sign download links. A receiver that is the same app that
calls the API already holds the key, and may pass `{ apiKey }` instead.

Limits (environment variables, defaults in brackets): `MAX_QUEUE` (25),
`MAX_RENDER_SECONDS` (180, the video's length), `JOB_TIMEOUT_MINUTES` (45),
`MAX_NARRATION_CHARS` (12000) and `MAX_NARRATION_LINES` (40) per render,
`MAX_SITE_MB` (300), `MAX_BODY_KB` (1024). Finished renders are deleted after
`RETENTION_DAYS` (7). Everything else: [`service/.env.example`](service/.env.example).

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
| `scenes[]` | `title` (required), `kicker`, `body`, `image` (https, public host), `narration`, `seconds` (minimum), `id` (unique; default `s0`, `s1`, …) |
| `narration` | Voice lines by scene id, overriding the scenes' own; keys that aren't scene ids are dropped |
| `soundDesign` | `house` (default) or `none` |
| `sfx[]` | Extra sounds: `{ sound, at, scene?, volume?, playbackRate? }`, where `sound` is a house cue, `remotion:<name>` from [@remotion/sfx](https://www.remotion.dev/docs/sfx), or an https URL |

Type is sized to fit the space between the brand and the footer: long titles
and bodies (all caps included) shrink, words too long for a line break, and a
long brand name or URL is cut with an ellipsis. A request whose scenes alone
run past `MAX_RENDER_SECONDS` is a `400` before any voice is paid for.

### Your own compositions: sites

When the built-ins aren't enough, render your project's own Remotion
compositions (your brand, your layouts) on the service:

```bash
# in your Remotion project, with the library installed (see below)
npx video-kit site deploy myproject             # bundles src/index.ts, uploads it
npx video-kit render MyComposition --site myproject --props props.json --out out.mp4
```

Without the CLI, upload the output of `npx remotion bundle` yourself:
`tar -czf site.tgz -C build . && curl -X PUT --data-binary @site.tgz -H "Content-Type: application/gzip" -H "Authorization: Bearer …" $VIDEO_KIT_URL/v1/sites/myproject`.

The service voices a site's `props.narration` (an object of scene id → text)
into `props.voiceover` (scene id → `{ src, durationInSeconds }`) before it
renders, so a composition gets a voice by reading those two props, which is
what the library below is for. The service owns `voiceover`: one sent by a
client is dropped.

`site deploy` bundles with Remotion's bundler API, which doesn't read
`remotion.config.ts`. If your bundle depends on it (Tailwind, a webpack
override), run `npx remotion bundle` and deploy that with `--bundle build`.
`--rspack` bundles with Rspack instead of webpack (faster).

## Use the library in a Remotion project

```bash
# needs read access to this repo; the Remotion packages are peers, at the same version as your remotion
npm install github:banfimatei/video-kit @remotion/media @remotion/sfx zod
npm install @remotion/bundler @remotion/renderer   # only for renderComposition / the CLI in Node
```

A project that only calls the service needs just the first package: the
client is fetch-only, and every peer is optional.

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
  tts: "elevenlabs", // or openai | gemini | deepgram | openrouter | espeak | none; default: whichever key is set
  ttsOptions: { voice: "flux-hannah-en" }, // optional: model and/or voice for this render, over the env defaults
});
```

`@banfimatei/video-kit/core` has the schemas and timing without any browser
assets, for validating props in Node. Scene ids must be unique
(`fitScenesToVoice` throws otherwise).

### Voice providers

| `tts` | Needs | Tuning |
| --- | --- | --- |
| `elevenlabs` | `ELEVENLABS_API_KEY` | `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_TTS_MODEL`, `OPENAI_TTS_VOICE`, `OPENAI_TTS_INSTRUCTIONS` |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_TTS_MODEL`, `GEMINI_TTS_VOICE` |
| `deepgram` | `DEEPGRAM_API_KEY` | `DEEPGRAM_TTS_MODEL`: an Aura-2 voice, which names model and voice together (default `aura-2-thalia-en`; e.g. `aura-2-apollo-en`, `aura-2-draco-en`, `aura-2-agustina-es`), or a Flux TTS voice `flux-<voice>-<lang>` (e.g. `flux-hannah-en`, `flux-miles-en`), sent to `/v2/speak`. Lines over 2000 characters are split at sentences. |
| `openrouter` | `OPENROUTER_API_KEY` | `OPENROUTER_TTS_MODEL` (default `google/gemini-3.8-flash-tts`; also Voxtral, Kokoro, MiniMax, Deepgram… — any model on [openrouter.ai/models?output_modalities=speech](https://openrouter.ai/models?output_modalities=speech)), `OPENROUTER_TTS_VOICE` (default `Charon`; voices are per model, listed as `supported_voices` in `GET /api/v1/models?output_modalities=speech`), `OPENROUTER_TTS_INSTRUCTIONS` (OpenAI models only), `OPENROUTER_TTS_FORMAT` (`pcm`, wrapped as WAV, or `mp3`; default pcm, mp3 for Mistral) |
| `espeak` | `espeak-ng` installed | Robotic: offline tests and CI |

Clips are cached by a hash of provider, voice and text, so re-rendering the
same script costs nothing.

## Deploying the service (Railway)

The repo deploys as one Railway service built from the root `Dockerfile`
(Railway picks it up on its own). Railway no longer reads `railway.json` for
new services, so these are service settings:

| Setting | Value |
| --- | --- |
| Volume | mounted at `/data` (renders, sites, voice cache, job records) |
| Healthcheck | path `/healthz`, timeout 300s (boot starts a Chrome to list the built-in templates) |
| Restart policy | on failure, 5 retries |
| Draining | the **variable** `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=300` (not the Settings field: the service reads the variable to know its window, and logs it at boot) |
| Start Command | leave empty. A start command replaces the image's entrypoint (`dumb-init`), and then renders can't drain on redeploy |
| Watch paths | `/src/**`, `/assets/**`, `/service/src/**`, `/service/remotion/**`, `/service/scripts/**`, `/package.json`, `/package-lock.json`, `/service/package.json`, `/tsconfig*.json`, `/service/tsconfig*.json`, `/Dockerfile`, `/.dockerignore` (docs-only commits don't restart it) |
| Variables | `RENDER_API_KEY` (32+ random characters); a TTS key for voices (`ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `OPENROUTER_API_KEY`) |
| Networking | a public domain; `RAILWAY_PUBLIC_DOMAIN` is used for links automatically |

Everything else has defaults: see [`service/.env.example`](service/.env.example).
One render runs at a time (`RENDER_CONCURRENCY`); each is a headless Chrome,
so give the service 2+ GB of RAM per concurrent render.

On a redeploy (a volume means Railway stops the old container before starting
the new one), the service stops taking new work (`503`), lets running renders
finish within the draining window, and fails only what is still running at
its end, with "The service restarted…" and a webhook. Renders still waiting
stay queued and run after the restart. The image runs node under
`dumb-init`, which reaps Chrome's processes and turns the stop signal into the
service's "drain" signal (Remotion kills its browsers on a plain SIGTERM).

## Local development

```bash
npm install                       # builds the library (prepare)
npm test                          # library + service tests
cd service
npm run bundle                    # built-in templates → service/bundle
npm run studio                    # preview the built-in templates
RENDER_API_KEY=dev-key-0123456789ab npm run dev   # or put it in service/.env
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
