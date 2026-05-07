'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  setupFilesAfterFramework: [],
  globalSetup: './tests/setup.global.js',
  globalTeardown: './tests/teardown.global.js',
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.js', '!src/index.js'],
  coverageThreshold: {
    global: { lines: 70, functions: 70, branches: 60 },
  },
  testTimeout: 15000,
  verbose: true,
};
