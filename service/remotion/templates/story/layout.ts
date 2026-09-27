
/**
 * Where everything goes in a Story frame, computed from the text itself so
 * the longest title, body, footer and URL the schema allows still fit the
 * smallest aspect (1:1) without touching each other.
 *
 * Text is measured by estimate: an average advance per character for each
 * face (Inter, Newsreader, JetBrains Mono), and a greedy word wrap. The
 * averages lean wide, so real text comes out a little smaller than the
 * space, never larger.
 */

type Face = "sans" | "serif" | "mono";
type ChromeText = { brand?: { name?: string; url?: string } | null; footer?: string | null };
type SceneText = { kicker?: string; title: string; body?: string };

/** Average advance per character, as a fraction of the font size. */
const ADVANCE = { sansBold: 0.6, sans: 0.55, serif: 0.54, mono: 0.6 } as const;

export interface StoryFrame {
  width: number;
  height: number;
  portrait: boolean;
  /** 1 at 1080 px on the short side. */
  unit: number;
  /** Left and right margin of every element. */
  side: number;
  brandTop: number;
  footerBottom: number;
  /** The URL is cut with an ellipsis past this width. */
  urlMaxWidth: number;
  /** The box scene text must stay inside. */
  content: { top: number; bottom: number; width: number; height: number };
}

/** Lines `text` wraps to at `advance` px per character in a `width` px column. */
export function wrapLines(text: string, advance: number, width: number, spaceWidth = advance * 0.5): number {
  let lines = 1;
  let x = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = word.length * advance;
    if (x === 0) {
      x = w;
    } else if (x + spaceWidth + w <= width) {
      x += spaceWidth + w;
      continue;
    } else {
      lines++;
      x = w;
    }
    // A word wider than the column breaks over several lines.
    while (x > width) {
      lines++;
      x -= width;
    }
  }
  return lines;
}

export function storyFrame(props: ChromeText, width: number, height: number): StoryFrame {
  const portrait = height >= width;
  const unit = (portrait ? width : height) / 1080;
  const side = Math.round(width * (portrait ? 0.09 : 0.08));
  const row = width - 2 * side;
  const gap = 44 * unit;

  const brandTop = Math.round(height * 0.06);
  const brandBottom = props.brand?.name ? brandTop + 38 * unit * 1.3 : 0;

  const footerBottom = Math.round(height * (portrait ? 0.09 : 0.07));
  const urlMaxWidth = Math.round(row * 0.45);
  const url = props.brand?.url ?? "";
  const urlWidth = url ? Math.min(urlMaxWidth, url.length * 30 * unit * ADVANCE.mono) : 0;
  const footerWidth = row - urlWidth - (url ? 40 * unit : 0);
  const footerAdvance = 24 * unit * ADVANCE.mono;
  // Monospace: a space is as wide as any other character.
  const footerLines = props.footer ? wrapLines(props.footer, footerAdvance, footerWidth, footerAdvance) : 0;
  const footerHeight =
    props.footer || url ? 24 * unit + 2 * unit + Math.max(footerLines * 24 * unit * 1.45, url ? 30 * unit * 1.3 : 0) : 0;

  const top = Math.round(Math.max(height * (portrait ? 0.14 : 0.16), brandBottom + gap));
  const bottom = Math.round(Math.max(height * 0.2, footerHeight ? footerBottom + footerHeight + gap : 0));
  const contentWidth = portrait ? row : Math.min(row, Math.round(width * 0.72));
  return {
    width,
    height,
    portrait,
    unit,
    side,
    brandTop,
    footerBottom,
    urlMaxWidth,
    content: { top, bottom, width: contentWidth, height: height - top - bottom },
  };
}

export interface SceneType {
  kicker: number;
  kickerGap: number;
  title: number;
  titleTracking: number;
  body: number;
  bodyGap: number;
}

/** Type sizes for one scene: the design sizes, scaled down just enough for the text to fit the content box. */
export function sceneType(scene: SceneText, font: Face, frame: StoryFrame): SceneType {
  const { unit, content } = frame;
  const len = scene.title.length;
  const designTitle = (frame.height > frame.width ? 96 : 84) * unit * (len > 100 ? 0.66 : len > 60 ? 0.8 : 1);
  const tracking = font === "mono" ? 0 : -1.5 * unit;
  const titleAdvance = font === "sans" ? ADVANCE.sansBold : font === "serif" ? ADVANCE.serif : ADVANCE.mono;

  const kicker = 30 * unit;
  const kickerGap = 32 * unit;
  const kickerAdvance = kicker * ADVANCE.mono + 4 * unit; // mono plus letter spacing, spaces included
  const kickerHeight = scene.kicker
    ? wrapLines(scene.kicker, kickerAdvance, content.width, kickerAdvance) * kicker * 1.25 + kickerGap
    : 0;

  const at = (s: number): SceneType => ({
    kicker,
    kickerGap,
    title: Math.round(designTitle * s),
    titleTracking: tracking * s,
    body: Math.round(44 * unit * s),
    bodyGap: Math.round(40 * unit * s),
  });
  const needed = (t: SceneType) => {
    const titleSpace = font === "mono" ? t.title * ADVANCE.mono : t.title * 0.28;
    const titleLines = wrapLines(scene.title, t.title * titleAdvance + t.titleTracking, content.width, titleSpace);
    const bodyLines = scene.body ? wrapLines(scene.body, t.body * ADVANCE.sans, content.width, t.body * 0.28) : 0;
    return kickerHeight + titleLines * t.title * 1.08 + (scene.body ? t.bodyGap + bodyLines * t.body * 1.35 : 0);
  };

  for (let s = 1; s > 0.4; s -= 0.025) {
    const t = at(s);
    if (needed(t) <= content.height) return t;
  }
  return at(0.4);
}
