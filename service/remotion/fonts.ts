import { loadFont } from "@remotion/fonts";
import inter400 from "@fontsource/inter/files/inter-latin-400-normal.woff2";
import inter700 from "@fontsource/inter/files/inter-latin-700-normal.woff2";
import mono500 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2";
import newsreader500 from "@fontsource/newsreader/files/newsreader-latin-500-normal.woff2";

// Bundled, so renders need no network. loadFont() holds each frame until ready.
loadFont({ family: "Inter", url: inter400, weight: "400" });
loadFont({ family: "Inter", url: inter700, weight: "700" });
loadFont({ family: "JetBrains Mono", url: mono500, weight: "500" });
loadFont({ family: "Newsreader", url: newsreader500, weight: "500" });

export const FONT_STACK = {
  sans: "Inter, sans-serif",
  serif: "Newsreader, serif",
  mono: "'JetBrains Mono', monospace",
} as const;
