module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testEnvironment: 'node',
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  transform: {
    // The ESM-only dependencies of ripple-binary-codec and ripple-address-codec are compiled to CommonJS. Jest takes the
    // first matching pattern, so this one comes before the catch-all that would also match their `.js` files.
    '/node_modules/(@noble/hashes|@scure/base)/.+\\.js$': [
      'ts-jest',
      {
        tsconfig: { allowJs: true, module: 'commonjs', target: 'ES2021', esModuleInterop: true },
        diagnostics: false,
      },
    ],
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  transformIgnorePatterns: ['/node_modules/(?!\\.pnpm/(@noble\\+hashes|@scure\\+base)@|@noble/hashes/|@scure/base/)'],
  testTimeout: 180000,
};
