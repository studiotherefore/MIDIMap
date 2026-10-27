import { fileURLToPath } from 'node:url';
// Experiment 4: the sequencer layout (no tabs under the monitor; run strip in the
// transport; the take timeline always visible; take ▾; the info tab). Real Mapillary.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../package.json', import.meta.url));
const { chromium } = require('playwright');
const OUT = fileURLToPath(new URL('./output/', import.meta.url)); // git-ignored
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 1512, height: 860 } }); // a MacBook window
await ctx.route(/\/api\/(projects|presets|midi)/, (r) => r.fulfill({ json: { presets: {}, projects: {}, profiles: {}, updated: {} } }));
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://localhost:8000/experiments/record/');
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 20, null, { timeout: 90000 });
const ev = (f, a) => page.evaluate(f, a);
const key = (k) => page.keyboard.press(k);
const wait = (ms) => page.waitForTimeout(ms);
const view = () => page.click('#view', { position: { x: 300, y: 200 } });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail !== '' ? `  (${detail})` : ''}`); };
const box = (sel) => ev((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, w: r.width }; }, sel);

// 1. What's on screen by default.
check('no tabs under the monitor any more', await ev(() => !document.querySelector('#below-tabs') && !document.querySelector('[data-below-panel]')));
check('the take bar is there from the start', (await box('#take-rec'))?.h > 0 && (await box('#take-od'))?.h > 0 && (await box('#take-play'))?.h > 0);
check('with no takes: a hint says Q records one', await ev(() => !document.querySelector('#take-empty').hidden && document.querySelector('#take-empty').textContent.includes('Q records one')));
check('… and the menu button says so', (await page.textContent('#take-menu-btn')).includes('no take'));
check('the run strip is in the transport', await ev(() => document.querySelector('#strip').closest('.transport') !== null) && (await box('#strip')).w > 150, `${Math.round((await box('#strip')).w)} px wide`);
check('the top bar\'s recording is called "video"', (await page.textContent('#record')).startsWith('video'));
check('effects is the inspector\'s default tab; info is a tab', await ev(() => document.querySelector('#insp-tabs .on').dataset.tab === 'effects' && !!document.querySelector('#insp-tabs [data-tab="info"]')));
const tabRow = await ev(() => [...document.querySelectorAll('#insp-tabs button')].map((b) => Math.round(b.getBoundingClientRect().top)));
check('the six inspector tabs fit on one row', new Set(tabRow).size === 1, tabRow.join(' '));

// The run strip: click to go somewhere in the run.
await view();
const i0 = await ev(() => window.blend.S.index);
const sb = await box('#strip');
await page.mouse.click(sb.left + sb.w * 0.25, sb.top + sb.h / 2);
const i1 = await ev(() => window.blend.S.index);
check('clicking the strip jumps in the run', Math.abs(i1 - i0) > 50 && i1 < (await ev(() => window.blend.S.runA.length)) / 2, `${i0} → ${i1}`);
await ev((i) => { window.blend.S.index = i; }, i0);
await page.waitForFunction(() => /buffered (\d+)/.test(document.querySelector('#hud-buffer')?.textContent) && +RegExp.$1 >= 15, null, { timeout: 60000 });

// 2. Two takes, then what you see while one plays.
await view();
await key('b'); await key('Space');
for (const n of [1, 2]) {
  await key('q');
  await wait(700); await ev(() => { window.blend.look.bloom = Math.random(); window.blend.S.mix = Math.random(); });
  await wait(700); await key('ArrowUp');
  await wait(700); await key('ArrowDown'); await ev(() => { window.blend.look.hue = 40 + Math.random() * 100; });
  await wait(700);
  await key('q');
}
await key('Space');
const names = await ev(() => Object.keys(window.blend.take.all));
check('two takes, shown as chips', names.length === 2 && (await ev(() => document.querySelectorAll('#take-launchers .chip').length)) === 2, names.join(', '));
check('the hint is gone once there is a take', await ev(() => document.querySelector('#take-empty').hidden));
await key('w'); await wait(1500);
const tl = await box('#timeline');
const lanes = await ev(() => [...document.querySelectorAll('#lanes .lane')].map((l) => { const r = l.getBoundingClientRect(); return { n: l.querySelector('.lname').textContent, bottom: r.bottom }; }));
const shown = lanes.filter((l) => l.bottom <= tl.bottom + 1 && l.bottom <= 860);
check('while a take plays, its lanes are on screen without scrolling (5 at this window size)', shown.length >= 5, `${shown.length} of ${lanes.length}: ${shown.map((l) => l.n).join(' ')}`);
check('a beat ruler above the lanes', (await box('#lanes .ruler-c'))?.h > 10);
const barTops = await ev(() => [...document.querySelectorAll('.tbar > *')].filter((e) => e.getBoundingClientRect().height).map((e) => Math.round(e.getBoundingClientRect().top + e.getBoundingClientRect().height / 2)));
check('the take bar is one row', Math.max(...barTops) - Math.min(...barTops) <= 3, barTops.join(' '));
check('the position reads "beat n / length"', /beat \d+ \/ \d+/.test(await page.textContent('#take-pos')), await page.textContent('#take-pos'));
check('the playing take\'s chip is green', await ev(() => document.querySelector('#take-launchers .chip.playing')?.textContent === window.blend.take.current));
check('in / out / loop in the transport now act on the take (green)', await ev(() => ['#loop-in', '#loop-out', '#loop'].every((s) => document.querySelector(s).classList.contains('take'))));
await page.screenshot({ path: `${OUT}seqlayout-playing.png` });

// 3. Chips: playing → another chip switches on the next beat; the playing one stops.
const first = await ev(() => window.blend.take.current);
const other = names.find((n) => n !== first);
await ev((n) => [...document.querySelectorAll('#take-launchers .chip')].find((b) => b.textContent === n).click(), other);
check('while playing, clicking another take queues it for the next beat', await ev((n) => window.blend.take.current === n && (window.blend.take.pendingAt > 0 || window.blend.take.playing), other));
await wait(1000);
check('… and it plays', await ev((n) => window.blend.take.playing && window.blend.take.current === n, other));
await ev((n) => [...document.querySelectorAll('#take-launchers .chip')].find((b) => b.textContent === n).click(), other);
check('clicking the playing take stops it', await ev(() => !window.blend.take.playing && !window.blend.take.pendingAt));
check('stopped: in / out / loop are the run\'s again', await ev(() => !document.querySelector('#loop').classList.contains('take')));
await ev((n) => [...document.querySelectorAll('#take-launchers .chip')].find((b) => b.textContent === n).click(), first);
check('stopped, clicking a take just chooses it (W plays it)', await ev((n) => window.blend.take.current === n && !window.blend.take.playing && !window.blend.take.pendingAt, first));
check('… the menu button names it', (await page.textContent('#take-menu-btn')).startsWith(first));

// I / O: the run's when stopped.
await view();
await key('i');
check('stopped, I sets the run\'s loop in', await ev(() => window.blend.S.loopIn !== null && window.blend.take.prep.take.loopIn == null));
await key('Shift+KeyI'); await ev(() => { window.blend.S.loopIn = null; window.blend.S.loopOut = null; window.blend.S.loop = false; });

// 4. take ▾ holds editing and files; Esc or a click elsewhere closes it.
check('editing is out of sight until take ▾ opens', await ev(() => document.querySelector('#take-menu').hidden && !document.querySelector('#take-trim-in').getBoundingClientRect().height));
await page.click('#take-menu-btn');
check('take ▾: rename, trim, undo, clear a lane, pads, export, import, delete', await ev(() => !document.querySelector('#take-menu').hidden && ['#take-name', '#take-trim-in', '#take-trim-out', '#take-undo', '#take-to-pad', '#take-export', '#take-delete'].every((s) => document.querySelector(s).getBoundingClientRect().height > 0) && document.querySelectorAll('#take-clear-lanes [data-lane]').length >= 3));
const mb = await box('#take-menu');
check('it opens upwards over the picture, inside the window', mb.top >= 48 && mb.bottom <= (await box('#timeline')).top + 1, `${Math.round(mb.top)}–${Math.round(mb.bottom)}`);
await page.screenshot({ path: `${OUT}seqlayout-menu.png` });
await key('Escape');
check('Esc closes it', await ev(() => document.querySelector('#take-menu').hidden));
await page.click('#take-menu-btn');
await page.mouse.click(180, 640); // the left column, away from the menu
check('a click elsewhere closes it', await ev(() => document.querySelector('#take-menu').hidden));
check('lanes keep only mute and solo (clear moved to the menu)', await ev(() => !document.querySelector('#lanes .lane .c') && !!document.querySelector('#lanes .lane .m') && !!document.querySelector('#lanes .lane .s')));

// 5. The info tab has what "this run" and "this place" had.
await page.click('#insp-tabs [data-tab="info"]');
await page.waitForFunction(() => document.querySelector('#run-facts').textContent.includes('photos') && document.querySelector('#place-facts').textContent.includes('captured'), null, { timeout: 30000 }).catch(() => {});
check('info: the run\'s facts', (await page.textContent('#run-facts')).includes('photos'), (await page.textContent('#run-facts')).slice(0, 60));
check('info: this place (name, pad, capture details, credit)', (await page.inputValue('#place-name')).length > 0 && (await page.textContent('#place-facts')).includes('captured') && (await page.textContent('#place-note')).includes('Credit'));
const ib = await ev(() => [...document.querySelectorAll('[data-tab-panel="info"] input, [data-tab-panel="info"] select, [data-tab-panel="info"] button')].map((e) => Math.round(e.getBoundingClientRect().right)));
check('info fits the inspector (nothing past its edge)', Math.max(...ib) <= 1512, `rightmost ${Math.max(...ib)} px`);
await page.screenshot({ path: `${OUT}seqlayout-info.png` });
await page.click('#insp-tabs [data-tab="effects"]');

check('keyboard: Q / Shift+Q / W / ⌘Z still listed', await ev(() => document.body.innerHTML.includes('Q · W · Shift+W') && document.body.innerHTML.includes('Shift+Q · ⌘Z')));
check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} layout checks failed` : `\nall ${results.length} layout checks passed`);
process.exit(failed ? 1 : 0);
