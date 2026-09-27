import { Fragment } from "react";
import { AbsoluteFill, Easing, Img, Interactive, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK } from "../../fonts";
import { sceneType, type StoryFrame } from "./layout";
import type { ParsedStoryProps, StoryScene } from "./schema";

type Theme = ParsedStoryProps["theme"];

const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) } as const;

/**
 * One scene: kicker, title (word by word), body, over an optional
 * full-bleed image that slowly pushes in. Opaque, so fade() crossfades.
 * Reveals start at frame 10, after the incoming crossfade covers the page.
 */
export const Scene: React.FC<{ scene: StoryScene; theme: Theme; isFirst: boolean; layout: StoryFrame }> = ({
  scene,
  theme,
  isFirst,
  layout,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const unit = layout.unit;
  const type = sceneType(scene, theme.font, layout);
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
          // The content box from storyFrame(): clear of the brand above and the footer below.
          top: layout.content.top,
          bottom: layout.content.bottom,
          left: layout.side,
          width: layout.content.width,
          height: layout.content.height,
          display: "flex",
          flexDirection: "column",
          justifyContent: scene.image ? "flex-end" : "center",
        }}
      >
        {scene.kicker ? (
          <Interactive.Div
            name="Kicker"
            style={{
              fontFamily: FONT_STACK.mono,
              fontWeight: 500,
              fontSize: Math.round(type.kicker),
              lineHeight: 1.25,
              letterSpacing: 4 * unit,
              textTransform: "uppercase",
              color: theme.accent,
              marginBottom: Math.round(type.kickerGap),
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
            fontSize: type.title,
            lineHeight: 1.08,
            letterSpacing: type.titleTracking,
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
              fontSize: type.body,
              lineHeight: 1.35,
              color: theme.muted,
              marginTop: type.bodyGap,
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
export const Chrome: React.FC<{ props: ParsedStoryProps; layout: StoryFrame }> = ({ props, layout }) => {
  const { unit, side } = layout;
  const { theme, brand, footer } = props;
  if (!brand?.name && !brand?.url && !footer) return null;
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {brand?.name ? (
        <Interactive.Div
          name="Brand"
          style={{
            position: "absolute",
            top: layout.brandTop,
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
            bottom: layout.footerBottom,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: Math.round(40 * unit),
            borderTop: `${Math.max(1, Math.round(2 * unit))}px solid ${theme.muted}55`,
            paddingTop: Math.round(24 * unit),
          }}
        >
          <div style={{ flex: 1, minWidth: 0, fontFamily: FONT_STACK.mono, fontSize: Math.round(24 * unit), lineHeight: 1.45, color: theme.muted }}>
            {footer ?? ""}
          </div>
          {brand?.url ? (
            <div
              style={{
                fontFamily: FONT_STACK.mono,
                fontWeight: 500,
                fontSize: Math.round(30 * unit),
                whiteSpace: "nowrap",
                maxWidth: layout.urlMaxWidth,
                overflow: "hidden",
                textOverflow: "ellipsis",
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
