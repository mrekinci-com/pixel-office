import {runTests} from './run-tests.mjs';
const args = process.argv.slice(2);
process.exitCode = await runTests([
  ['tests/visual.browser.ts', ...args],
  ['tests/browser.b1.ts', '--visual', ...args],
  ['tests/browser.b11.ts', '--visual', ...args],
  ['tests/browser.b13.ts', '--visual', ...args],
  ['tests/browser.b14.ts', '--visual', ...args],
  ['tests/browser.b15.ts', '--visual', ...args],
]);
