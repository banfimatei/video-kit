import { audioPropsSchema } from "@banfimatei/video-kit/core";
import { z } from "zod";

export const ASPECTS = {
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
} as const;

export const storySceneSchema = z.object({
  /** Stable id for narration, voiceover and sfx keys. Default s0, s1, … */
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .optional(),
  kicker: z.string().max(80).optional(),
  title: z.string().min(1).max(160),
  body: z.string().max(400).optional(),
  /** Full-bleed background image (https URL), slowly zoomed, darkened under the type. */
  image: z.string().url().optional(),
  /** What the voice says over this scene. */
  narration: z.string().max(1200).optional(),
  /** Minimum on-screen seconds; the scene still stretches to fit its narration. */
  seconds: z.number().positive().max(60).optional(),
});

export const storyThemeSchema = z.object({
  background: z.string().default("#121212"),
  foreground: z.string().default("#F5F3EE"),
  muted: z.string().default("#A8A39A"),
  accent: z.string().default("#6C84FF"),
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
  scenes: z.array(storySceneSchema).min(1).max(20),
  ...audioPropsSchema.shape,
});

export type StoryProps = z.input<typeof storySchema>;
export type ParsedStoryProps = z.output<typeof storySchema>;
export type StoryScene = z.infer<typeof storySceneSchema>;

export const sceneId = (scene: StoryScene, index: number) => scene.id ?? `s${index}`;

/**
 * Parse, apply defaults, and lift each scene's `narration` into the
 * top-level `narration` record the renderer voices (explicit top-level
 * entries win). Run before rendering, in Node.
 */
export function prepareStoryProps(input: unknown): ParsedStoryProps {
  const props = storySchema.parse(input);
  const fromScenes = Object.fromEntries(
    props.scenes.map((s, i) => [sceneId(s, i), s.narration ?? null] as const),
  );
  const narration = { ...fromScenes, ...(props.narration ?? {}) };
  const hasText = Object.values(narration).some((t) => t && t.trim());
  return { ...props, narration: hasText ? narration : undefined };
}
