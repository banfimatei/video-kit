import { audioPropsSchema, fitScenesToVoice, HOUSE_SOUNDS, sfxCueSchema } from "@banfimatei/video-kit/core";
import * as remotionSfx from "@remotion/sfx";
import { z } from "zod";

export const ASPECTS = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
} as const;

const HTTPS = /^https:\/\//i;
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/;

export const storySceneSchema = z.object({
  /** Stable id for narration, voiceover and sfx keys, unique within the video. Default s0, s1, … */
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .refine((id) => id !== "__proto__", "id can't be __proto__")
    .optional(),
  kicker: z.string().max(80).optional(),
  title: z.string().min(1).max(160),
  body: z.string().max(400).optional(),
  /** Full-bleed background image (https URL or a data: PNG/JPEG/WebP/GIF), slowly zoomed, darkened under the type. */
  image: z
    .string()
    .refine((u) => HTTPS.test(u) || DATA_IMAGE.test(u), "image must be an https URL or a data:image/(png|jpeg|webp|gif);base64 URI")
    .optional(),
  /** What the voice says over this scene. */
  narration: z.string().max(1200).optional(),
  /** Minimum on-screen seconds; the scene still stretches to fit its narration. */
  seconds: z.number().positive().max(60).optional(),
});

/**
 * A hex colour, #rgb or #rrggbb, always output as #rrggbb. Colours go into
 * CSS (and get alpha suffixes appended, like `${background}99`), so nothing
 * but a plain hex value may get through.
 */
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "colours are hex: #rgb or #rrggbb")
  .transform((c) => (c.length === 4 ? `#${[...c.slice(1)].map((d) => d + d).join("")}` : c).toUpperCase());

export const storyThemeSchema = z.object({
  background: hexColor.default("#121212"),
  foreground: hexColor.default("#F5F3EE"),
  muted: hexColor.default("#A8A39A"),
  accent: hexColor.default("#6C84FF"),
  /** Headline face; body text is always the sans. */
  font: z.enum(["serif", "sans", "mono"]).default("sans"),
});

export const storySchema = z.object({
  aspect: z.enum(["9:16", "4:5", "1:1", "16:9"]).default("9:16"),
  theme: storyThemeSchema.default({
    background: "#121212",
    foreground: "#F5F3EE",
    muted: "#A8A39A",
    accent: "#6C84FF",
    font: "sans",
  }),
  /** Brand mark top-left and URL bottom-right, on every frame. */
  brand: z
    .object({
      name: z.string().max(40).optional(),
      url: z.string().max(60).optional(),
    })
    .optional(),
  /** A line on every frame, never animated: a disclaimer, a credit. */
  footer: z.string().max(160).optional(),
  scenes: z
    .array(storySceneSchema)
    .min(1)
    .max(20)
    .superRefine((scenes, ctx) => {
      const seen = new Map<string, number>();
      scenes.forEach((s, i) => {
        const id = sceneId(s, i);
        const first = seen.get(id);
        if (first !== undefined) {
          ctx.addIssue({ code: "custom", path: [i, "id"], message: `Scene id "${id}" is already used by scene ${first}; ids must be unique.` });
        } else seen.set(id, i);
      });
    }),
  ...audioPropsSchema.shape,
  /** Voice lines by scene id; each scene's own `narration` fills in the rest. */
  narration: z.record(z.string(), z.string().max(1200).nullable()).nullable().optional(),
  /** Extra sounds: a house cue, an @remotion/sfx name ("remotion:ding") or an https URL. */
  sfx: z
    .array(
      sfxCueSchema.extend({
        sound: z
          .string()
          .refine(isStorySound, `sound must be a house cue (${HOUSE_SOUNDS.join(", ")}), remotion:<a @remotion/sfx name> or an https URL`),
      }),
    )
    .max(100)
    .optional(),
});

const REMOTION_SOUNDS = new Set(Object.keys(remotionSfx));

function isStorySound(sound: string): boolean {
  if ((HOUSE_SOUNDS as readonly string[]).includes(sound)) return true;
  if (sound.startsWith("remotion:")) return REMOTION_SOUNDS.has(sound.slice("remotion:".length));
  return HTTPS.test(sound);
}

/** Every remote URL the props make Chrome fetch (the service checks each host). */
export function storyUrls(props: ParsedStoryProps): string[] {
  return [
    ...props.scenes.flatMap((s) => (s.image && HTTPS.test(s.image) ? [s.image] : [])),
    ...(props.sfx ?? []).flatMap((c) => (HTTPS.test(c.sound) ? [c.sound] : [])),
  ];
}

export type StoryProps = z.input<typeof storySchema>;
export type ParsedStoryProps = z.output<typeof storySchema>;
export type StoryScene = z.infer<typeof storySceneSchema>;

export function sceneId(scene: Pick<StoryScene, "id">, index: number): string {
  return scene.id ?? `s${index}`;
}

/**
 * Parse, apply defaults, and lift each scene's `narration` into the
 * top-level `narration` record the renderer voices (explicit top-level
 * entries win; keys that aren't scene ids are dropped, since nothing would
 * play them). Run before rendering, in Node.
 */
export function prepareStoryProps(input: unknown): ParsedStoryProps {
  const props = storySchema.parse(input);
  const ids = props.scenes.map((s, i) => sceneId(s, i));
  const fromScenes = Object.fromEntries(props.scenes.map((s, i) => [ids[i], s.narration ?? null] as const));
  const explicit = Object.entries(props.narration ?? {}).filter(([k]) => ids.includes(k));
  const narration = { ...fromScenes, ...Object.fromEntries(explicit) };
  const hasText = Object.values(narration).some((t) => t && t.trim());
  // Every key explicit (null or empty, never absent): Remotion fills absent
  // keys from the composition's sample defaultProps, which would put the
  // sample brand and footer into this video.
  return {
    ...props,
    brand: props.brand ?? {},
    footer: props.footer ?? "",
    narration: hasText ? narration : null,
    voiceover: null,
    soundDesign: props.soundDesign ?? "house",
    sfx: props.sfx ?? [],
  };
}

export const STORY_FPS = 30;
export const STORY_TRANSITION = 12;

const words = (s?: string) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

/** Reading time for a scene's type, clamped to 3–12s, or its `seconds` if longer. */
export function sceneSeconds(scene: StoryScene): number {
  const auto = Math.min(12, Math.max(3, 1.8 + 0.28 * (words(scene.title) + words(scene.body))));
  return Math.max(auto, scene.seconds ?? 0);
}

/** Scene cuts and voice placement; read by calculateMetadata and the component alike. */
export function storyTimeline(props: Pick<StoryProps, "scenes" | "voiceover">, fps = STORY_FPS) {
  return fitScenesToVoice(
    props.scenes.map((s, i) => ({ id: sceneId(s, i), frames: Math.round(sceneSeconds(s) * fps) })),
    { fps, voiceover: props.voiceover, transitionFrames: STORY_TRANSITION },
  );
}

/** The video's length before any voice stretches it: a floor the service checks at submit. */
export function storyMinSeconds(props: ParsedStoryProps): number {
  return storyTimeline({ scenes: props.scenes }).durationInFrames / STORY_FPS;
}

