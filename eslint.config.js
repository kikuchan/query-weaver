import { includeIgnoreFile } from '@eslint/compat';
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import { defineConfig } from 'eslint/config';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';

const ignorePath = join(import.meta.dirname, '.prettierignore');

export default defineConfig(
  includeIgnoreFile(ignorePath),
  eslint.configs.recommended,
  tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  // Global rule adjustments
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'no-control-regex': 'off',
    },
  },
  // Test-only relaxations
  {
    files: ['packages/**/tests/**/*.spec.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
