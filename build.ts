import { build, BuildOptions } from "esbuild";
import nodeExternalsPlugin from "esbuild-node-externals";

const common = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  logLevel: "info",
  sourcemap: true,
  minify: true,
  plugins: [nodeExternalsPlugin()],
  target: ["es2020"],
} as BuildOptions;

build({
  ...common,
  format: "esm",
  outfile: "./dist/index.esm.mjs",
});

build({
  ...common,
  format: "cjs",
  outfile: "./dist/index.cjs.js",
});
