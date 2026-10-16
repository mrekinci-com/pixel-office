import {runTests} from './run-tests.mjs';

process.exitCode = await runTests([
  ['tests/browser.ts'],
  ['tests/browser.b13.ts'],
  ['tests/browser.a3.ts'],
  ['tests/browser.b1.ts'],
  ['tests/browser.b11.ts'],
  ['tests/browser.b14.ts'],
  ['tests/browser.b15.ts'],
]);
