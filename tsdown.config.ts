import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'tsdown';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf-8'));
const projectRoot = import.meta.dirname;
const outDir = path.join(projectRoot, 'dist');

export default defineConfig({
  format: ['esm', 'cjs'],
  fixedExtension: false,
  deps: {
    onlyBundle: ['@kikuchan/string-reader'],
  },
  minify: true,
  dts: true,
  outDir,
  onSuccess() {
    const distPkg = {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      type: 'module',
      main: './index.js',
      types: './index.d.ts',
      exports: {
        '.': {
          types: './index.d.ts',
          import: './index.js',
          default: './index.js',
        },
      },
      author: pkg.author,
      homepage: pkg.homepage,
      license: pkg.license,
    } as const;

    fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(distPkg, null, 2));
  },
});
