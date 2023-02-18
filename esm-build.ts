import { build } from "esbuild";
import nodeExternalsPlugin from "esbuild-node-externals";

build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/esm/index.mjs",
  sourcemap: true,
  minify: false,
  plugins: [nodeExternalsPlugin()],
});
