module.exports = {
  testEnvironment: 'node',

  transform: {
    '^.+\\.(ts|tsx)$': 'esbuild-jest',
  },
};
