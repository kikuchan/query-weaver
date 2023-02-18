import babel from "@rollup/plugin-babel";
import typescript from "@rollup/plugin-typescript";

const extensions = [".ts", ".tsx", ".js", ".jsx"];

export default [
  {
    input: "src/index.ts",

    output: {
      dir: "dist/cjs",
      format: "cjs",
      exports: "named",
      sourcemap: true,
    },

    plugins: [
      babel({
        extensions,
        babelHelpers: "bundled",
      }),
      typescript({
        declaration: true,
        rootDir: "src",
        declarationDir: "dist/cjs",
      }),
    ],

    external: ["pg-escape"],
  },

  {
    input: "src/index.ts",
    output: {
      dir: "dist/esm",
      format: "es",
      exports: "named",
      sourcemap: true,
      entryFileNames: "[name].mjs",
    },

    plugins: [
      babel({
        extensions,
        babelHelpers: "bundled",
      }),
      typescript({
        declaration: true,
        rootDir: "src",
        declarationDir: "dist/esm",
      }),
    ],

    external: ["pg-escape"],
  },
];
