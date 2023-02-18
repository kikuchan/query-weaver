module.exports = {
  env: {
    node: true,
  },
  parser: '@typescript-eslint/parser',
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  plugins: ['@typescript-eslint'],
  rules: {
    '@typescript-eslint/no-inferrable-types': 'off',
    'no-inner-declarations': 'off',
    'no-console': 'warn',
    'no-return-await': 'off',
    'no-mixed-operators': 'warn',
    'no-unused-vars': 'off', // covered by "@typescript-eslint/no-unused-vars"

    'comma-dangle': ['error', 'always-multiline'],
    semi: ['error', 'always'],
    quotes: ['error', 'single'],
    camelcase: 'off',
    'space-before-function-paren': [
      'error',
      {
        anonymous: 'never',
        named: 'never',
        asyncArrow: 'always',
      },
    ],

    '@typescript-eslint/no-unused-vars': 'warn',
  },
};
