/**
 * Bundle the built-in templates (remotion/) into service/bundle, the site the
 * service renders as "builtin". Run at image build time.
 */
import path from "node:path";
import { bundle } from "@remotion/bundler";

const root = path.resolve(import.meta.dirname, "..");
const out = await bundle({
  entryPoint: path.join(root, "remotion/index.ts"),
  publicDir: path.join(root, "remotion/public"),
  outDir: path.join(root, "bundle"),
  rspack: true,
});
console.error(`Bundled built-in templates to ${path.relative(process.cwd(), out)}`);
