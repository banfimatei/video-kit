import { z } from "zod";
import {
  prepareStoryProps,
  sceneId,
  storyMinSeconds,
  storySceneFrame,
  storySchema,
  storyUrls,
  type ParsedStoryProps,
} from "../remotion/templates/story/schema.js";

export interface BuiltinTemplate {
  schema: z.ZodType;
  /** Parse, apply defaults, lift narration. Throws a ZodError on bad input. */
  prepare: (props: unknown) => Record<string, unknown>;
  /** Remote URLs in prepared props that headless Chrome will fetch. */
  urls: (props: Record<string, unknown>) => string[];
  /** The video's length before voice stretches it, so an over-long request is a 400 before any TTS is paid for. */
  minSeconds: (props: Record<string, unknown>) => number;
  /** The ids a still may name with `scene`, in order. */
  sceneIds: (props: Record<string, unknown>) => string[];
  /**
   * The frame a still of `scene` shows, on the timeline of `props` as they
   * are rendered (voiceover included); undefined for an unknown id.
   */
  sceneFrame: (props: Record<string, unknown>, scene: string) => number | undefined;
}

/**
 * Built-in templates (remotion/, bundled into service/bundle). Each prepares
 * its props in Node before rendering: parse, apply defaults, and lift
 * whatever narration the template has into the top-level `narration` record
 * the renderer voices. Validation failures become a 400 at submit time.
 */
export const BUILTIN_TEMPLATES: Record<string, BuiltinTemplate> = {
  Story: {
    schema: storySchema,
    prepare: (p) => prepareStoryProps(p) as Record<string, unknown>,
    urls: (p) => storyUrls(p as never),
    minSeconds: (p) => storyMinSeconds(p as never),
    sceneIds: (p) => (p as ParsedStoryProps).scenes.map((s, i) => sceneId(s, i)),
    sceneFrame: (p, scene) => storySceneFrame(p as never, scene),
  },
};

export function builtinJsonSchema(id: string): unknown {
  const t = BUILTIN_TEMPLATES[id];
  if (!t) return undefined;
  try {
    return z.toJSONSchema(t.schema, { io: "input", unrepresentable: "any" });
  } catch {
    return undefined;
  }
}
