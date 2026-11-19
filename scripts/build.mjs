// Bundles the native Antigravity IDE extension and standalone Stop hook with esbuild.
// Empaqueta la extensión nativa de Antigravity IDE y el hook Stop independiente con esbuild.
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  minify: true,
};

await Promise.all([
  build({
    ...common,
    entryPoints: ["src/interfaces/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  }),
  build({
    ...common,
    entryPoints: ["src/interfaces/stop-hook.ts"],
    outfile: "dist/stop-hook.js",
  }),
]);

