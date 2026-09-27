import { Fragment } from "react";
import { AbsoluteFill, Easing, Img, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK } from "../../fonts";
import type { ParsedStoryProps, StoryScene } from "./schema";

type Theme = ParsedStoryProps["theme"];

const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) } as const;

/** Headline size for the canvas and the title's length. */
function titleSize(title: string, width: number, height: number): number {
  const base = height > width ? 96 : 84; // 1080-wide portrait; 1920-wide landscape uses the height scale
  const scale = height > width ? width / 1080 : height / 1080;
  const len = title.length;
  return Math.round((len > 100 ? base * 0.66 : len > 60 ? base * 0.8 : base) * scale);
}

/**
 * One scene: kicker, title (word by word), body, over an optional
 * full-bleed image that slowly pushes in. Opaque, so fade() crossfades.
 * Reveals start at frame 10, after the incoming crossfade covers the page.
 */
export const Scene: React.FC<{ scene: StoryScene; theme: Theme; isFirst: boolean }> = ({ scene, theme, isFirst }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const portrait = height >= width;
  const unit = (portrait ? width : height) / 1080;
  const start = isFirst ? 2 : 10;
  const words = scene.title.split(/\s+/);
  const wordAt = (i: number) => start + 6 + i * 2;
  const bodyAt = wordAt(words.length - 1) + 8;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.background }}>
      {scene.image ? (
        <AbsoluteFill>
          <Img
            src={scene.image}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              scale: interpolate(frame, [0, durationInFrames], [1, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          />
          <AbsoluteFill
            style={{
              background: `linear-gradient(180deg, ${theme.background}33 0%, ${theme.background}99 45%, ${theme.background}F2 75%)`,
            }}
          />
        </AbsoluteFill>
      ) : null}
      <AbsoluteFill
        style={{
          padding: portrait
            ? `${Math.round(height * 0.14)}px ${Math.round(width * 0.09)}px ${Math.round(height * 0.2)}px`
            : `${Math.round(height * 0.16)}px ${Math.round(width * 0.08)}px ${Math.round(height * 0.2)}px`,
          display: "flex",
          flexDirection: "column",
          justifyContent: scene.image ? "flex-end" : "center",
          maxWidth: portrait ? undefined : Math.round(width * 0.72),
        }}
      >
        {scene.kicker ? (
          <Interactive.Div
            name="Kicker"
            style={{
              fontFamily: FONT_STACK.mono,
              fontWeight: 500,
              fontSize: Math.round(30 * unit),
              letterSpacing: 4 * unit,
              textTransform: "uppercase",
              color: theme.accent,
              marginBottom: Math.round(32 * unit),
              opacity: interpolate(frame, [start, start + 18], [0, 1], ease),
              translate: interpolate(frame, [start, start + 18], ["0px 24px", "0px 0px"], ease),
            }}
          >
            {scene.kicker}
          </Interactive.Div>
        ) : null}
        <div
          style={{
            fontFamily: FONT_STACK[theme.font],
            fontWeight: theme.font === "sans" ? 700 : 500,
            fontSize: titleSize(scene.title, width, height),
            lineHeight: 1.08,
            letterSpacing: theme.font === "mono" ? 0 : -1.5 * unit,
            color: theme.foreground,
          }}
        >
          {words.map((word, i) => (
            <Fragment key={i}>
              <span
                style={{
                  display: "inline-block",
                  opacity: interpolate(frame, [wordAt(i), wordAt(i) + 12], [0, 1], ease),
                  translate: interpolate(frame, [wordAt(i), wordAt(i) + 12], ["0px 20px", "0px 0px"], ease),
                }}
              >
                {word}
              </span>
              {i < words.length - 1 ? " " : null}
            </Fragment>
          ))}
        </div>
        {scene.body ? (
          <Interactive.Div
            name="Body"
            style={{
              fontFamily: FONT_STACK.sans,
              fontWeight: 400,
              fontSize: Math.round(44 * unit),
              lineHeight: 1.35,
              color: theme.muted,
              marginTop: Math.round(40 * unit),
              opacity: interpolate(frame, [bodyAt, bodyAt + 18], [0, 1], ease),
              translate: interpolate(frame, [bodyAt, bodyAt + 18], ["0px 20px", "0px 0px"], ease),
            }}
          >
            {scene.body}
          </Interactive.Div>
        ) : null}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** Brand mark, URL and footer line: on every frame, above the transitions, never animated. */
export const Chrome: React.FC<{ props: ParsedStoryProps }> = ({ props }) => {
  const { width, height } = useVideoConfig();
  const unit = (height >= width ? width : height) / 1080;
  const { theme, brand, footer } = props;
  const side = Math.round(width * (height >= width ? 0.09 : 0.08));
  if (!brand?.name && !brand?.url && !footer) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {brand?.name ? (
        <Interactive.Div
          name="Brand"
          style={{
            position: "absolute",
            top: Math.round(height * 0.06),
            left: side,
            display: "flex",
            alignItems: "center",
            gap: Math.round(16 * unit),
            fontFamily: FONT_STACK.sans,
            fontWeight: 700,
            fontSize: Math.round(38 * unit),
            color: theme.foreground,
          }}
        >
          <div style={{ width: 22 * unit, height: 22 * unit, borderRadius: 999, backgroundColor: theme.accent }} />
          {brand.name}
        </Interactive.Div>
      ) : null}
      {footer || brand?.url ? (
        <Interactive.Div
          name="Footer"
          style={{
            position: "absolute",
            left: side,
            right: side,
            bottom: Math.round(height * (height >= width ? 0.09 : 0.07)),
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: Math.round(40 * unit),
            borderTop: `${Math.max(1, Math.round(2 * unit))}px solid ${theme.muted}55`,
            paddingTop: Math.round(24 * unit),
          }}
        >
          <div style={{ flex: 1, fontFamily: FONT_STACK.mono, fontSize: Math.round(24 * unit), lineHeight: 1.45, color: theme.muted }}>
            {footer ?? ""}
          </div>
          {brand?.url ? (
            <div
              style={{
                fontFamily: FONT_STACK.mono,
                fontWeight: 500,
                fontSize: Math.round(30 * unit),
                whiteSpace: "nowrap",
                color: theme.accent,
              }}
            >
              {brand.url}
            </div>
          ) : null}
        </Interactive.Div>
      ) : null}
    </AbsoluteFill>
  );
};
