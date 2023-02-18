import { build } from "esbuild";
import nodeExternalsPlugin from "esbuild-node-externals";

build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  outdir: "dist/cjs",
  format: "cjs",
  sourcemap: true,
  minify: false,
  plugins: [nodeExternalsPlugin()],
});
