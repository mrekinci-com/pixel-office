import {spawn} from 'node:child_process';

// Each program creates and cleans up its own test accounts and output directory.
export async function runTests(programs, concurrency = 3) {
  const queue = [...programs];
  let failed = false;
  await Promise.all(Array.from({length: concurrency}, async () => {
    while (queue.length) {
      const [script, ...args] = queue.shift();
      const status = await new Promise(resolve => {
        const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {stdio: 'inherit'});
        child.once('error', error => { console.error(`${script}: ${error.message}`); resolve(1); });
        child.once('exit', code => resolve(code ?? 1));
      });
      if (status !== 0) failed = true;
    }
  }));
  return failed ? 1 : 0;
}
