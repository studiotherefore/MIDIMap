import { fileURLToPath } from 'node:url';
// Runs the editor and experiment-4 browser checks one after another (headless Chrome).
// Needs the local server: `npm start` (http://localhost:8000). Uses the author's Chrome.
// Not included here (run them by hand): svreal.mjs (real Google, a visible window),
// svapp.mjs / apptest.mjs (start the Mac app; quit the running one first),
// kick-editor.mjs (HEADED=1 for real-hardware timing), clock-exp3/kick-exp3 (experiment 3).
import { execFileSync } from 'node:child_process';

const SUITES = ['parity', 'phase2', 'projects', 'phase4', 'phase5', 'phase6', 'clock-editor', 'take', 'take2'];
let failed = 0;
for (const name of SUITES) {
  let out = '';
  try {
    out = execFileSync('node', [fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))], { encoding: 'utf8', timeout: 900000 });
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || err.message}`;
  }
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const ok = !fails.length && /passed/.test(out);
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n${fails.join('\n') || out.slice(-600)}`}`);
}
console.log(failed ? `\n${failed} suite(s) failed` : '\nall editor suites passed');
process.exit(failed ? 1 : 0);
