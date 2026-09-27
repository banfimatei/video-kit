import { z } from "zod";
import { prepareStoryProps, storySchema } from "../remotion/templates/story/schema.js";

/**
 * Built-in templates (remotion/, bundled into service/bundle). Each prepares
 * its props in Node before rendering: parse, apply defaults, and lift
 * whatever narration the template has into the top-level `narration` record
 * the renderer voices. Validation failures become a 400 at submit time.
 */
export const BUILTIN_TEMPLATES: Record<string, { schema: z.ZodType; prepare: (props: unknown) => Record<string, unknown> }> = {
  Story: { schema: storySchema, prepare: (p) => prepareStoryProps(p) as Record<string, unknown> },
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
