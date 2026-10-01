import { z } from "zod";
import type { Config } from "./config.js";
import { assertPublicUrls, ResolveError, UnsafeTargetError } from "./net.js";
import { BUILTIN, HttpError } from "./sites.js";
import { BUILTIN_TEMPLATES } from "./templates.js";

/**
 * Check and clean a render's props at submit time, so bad input is a 400 and
 * the job stores only what it will render:
 * - `voiceover` and `musicTrack` are dropped: the service voices `narration`
 *   and composes music itself, and a
 *   client-supplied URL would have headless Chrome fetch anything.
 * - built-in templates parse their props (defaults applied, unknown keys
 *   gone), and every remote URL in them must be on a public host.
 * - narration is capped (MAX_NARRATION_LINES, MAX_NARRATION_CHARS), since
 *   each line is a paid TTS call.
 * - a video that can't fit MAX_RENDER_SECONDS is refused before any voice is
 *   paid for (stills have no length limit).
 */
export async function checkProps(
  cfg: Config,
  site: string,
  composition: string,
  raw: Record<string, unknown>,
  kind: "video" | "still" = "video",
): Promise<Record<string, unknown>> {
  const { voiceover: _dropped, musicTrack: _track, ...rest } = raw;
  let props: Record<string, unknown> = rest;

  const template = site === BUILTIN ? BUILTIN_TEMPLATES[composition] : undefined;
  if (template) {
    try {
      props = template.prepare(props);
    } catch (err) {
      if (err instanceof z.ZodError) {
        throw new HttpError(
          400,
          "Invalid props",
          err.issues.map((i) => ({ path: ["props", ...i.path].join("."), message: i.message })),
        );
      }
      throw err;
    }
    const floor = template.minSeconds(props);
    if (kind === "video" && floor > cfg.MAX_RENDER_SECONDS) {
      throw new HttpError(400, `These scenes run at least ${floor.toFixed(1)}s; the limit is ${cfg.MAX_RENDER_SECONDS}s.`);
    }
    try {
      await assertPublicUrls(template.urls(props), { allowPrivate: cfg.ALLOW_PRIVATE_URLS });
    } catch (err) {
      if (err instanceof UnsafeTargetError || err instanceof ResolveError) throw new HttpError(400, `Refusing media: ${err.message}`);
      throw err;
    }
  }

  checkNarration(cfg, props.narration, kind);
  return props;
}

function checkNarration(cfg: Config, narration: unknown, kind: "video" | "still"): void {
  if (narration === undefined || narration === null) return;
  if (typeof narration !== "object" || Array.isArray(narration)) {
    throw new HttpError(400, "props.narration must be an object of scene id → text.");
  }
  const entries = Object.entries(narration);
  if (entries.length > cfg.MAX_NARRATION_LINES) {
    throw new HttpError(400, `props.narration has ${entries.length} lines; the limit is ${cfg.MAX_NARRATION_LINES}.`);
  }
  let chars = 0;
  for (const [key, text] of entries) {
    if (text !== null && typeof text !== "string") {
      throw new HttpError(400, `props.narration.${key.slice(0, 40)} must be text or null.`);
    }
    chars += text?.length ?? 0;
  }
  if (chars > cfg.MAX_NARRATION_CHARS) {
    throw new HttpError(400, `props.narration is ${chars} characters; the limit is ${cfg.MAX_NARRATION_CHARS}.`);
  }
  // Even fast speech is under ~25 characters a second, so this much text can't fit the length limit.
  if (kind === "video" && chars / 25 > cfg.MAX_RENDER_SECONDS) {
    throw new HttpError(400, `props.narration needs at least ${Math.round(chars / 25)}s of voice; the limit is ${cfg.MAX_RENDER_SECONDS}s.`);
  }
}
