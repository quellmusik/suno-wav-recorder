/**
 * Checks that the recorder's module graph loads.
 *
 * offscreen.html loads offscreen.js as type=module, and offscreen.js imports lib/messages.js
 * and lib/wav-encoder.js by relative path. Get one of those paths wrong and nothing at all
 * runs, with a single console line nobody reads. This page asks the browser to import the
 * same files and says plainly whether it worked.
 *
 * offscreen.js needs chrome.runtime, which a page does not have, so a ReferenceError about
 * chrome is the pass: parsing and imports finished and execution stopped exactly at the
 * extension API.
 */

const results = [];
let failed = 0;

function check(name, pass, detail) {
  results.push({ name, pass, detail: pass ? '' : (detail || '') });
  if (!pass) failed += 1;
}

/** @returns {Promise<{ok: boolean, error?: Error}>} */
async function tryImport(specifier) {
  try {
    await import(specifier);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

const encoder = await tryImport('../lib/wav-encoder.js');
check('lib/wav-encoder.js imports with no error', encoder.ok, encoder.error && encoder.error.message);

const messages = await tryImport('../lib/messages.js');
check('lib/messages.js imports with no error', messages.ok, messages.error && messages.error.message);

const offscreen = await tryImport('../offscreen.js');
const offscreenError = offscreen.error;
/**
 * In Brave, `chrome` exists on an ordinary page but `chrome.runtime` does not, so the last
 * line offscreen.js executes is a ReferenceError about chrome or a TypeError reading
 * onMessage of undefined. Either one means parsing and imports finished.
 */
const stoppedAtChromeApi = !offscreen.ok && Boolean(offscreenError)
  && (offscreenError instanceof ReferenceError ? /chrome/i.test(offscreenError.message)
    : /chrome|onMessage|runtime/i.test(offscreenError.message));
const parsedFine = offscreen.ok || stoppedAtChromeApi || (offscreenError && offscreenError.name !== 'SyntaxError' && !/failed to (fetch|resolve)|404|Cannot find module/i.test(offscreenError.message));
check('offscreen.js parses and resolves its imports', parsedFine, offscreenError ? `${offscreenError.name}: ${offscreenError.message}` : '');
check('offscreen.js stopped only at the extension API (chrome.runtime)', offscreen.ok || stoppedAtChromeApi, offscreenError ? `${offscreenError.name}: ${offscreenError.message}` : 'offscreen.js loaded');

// The names offscreen.js reaches for on the shared contract must exist.
if (messages.ok) {
  const { MSG, TARGET, OFFSCREEN_PATH } = await import('../lib/messages.js');
  const needed = ['OFFSCREEN_START', 'OFFSCREEN_STOP', 'CAPTURE_READY', 'CAPTURE_PROGRESS', 'CAPTURE_DONE', 'CAPTURE_ERROR'];
  check('lib/messages.js exports every type the recorder uses', needed.every((key) => typeof MSG[key] === 'string'), needed.filter((k) => typeof MSG[k] !== 'string').join(', '));
  check('lib/messages.js has a background target', TARGET.BACKGROUND === 'background');
  check('the offscreen page is the file offscreen.html', OFFSCREEN_PATH === 'offscreen.html', OFFSCREEN_PATH);
}

if (encoder.ok) {
  const mod = await import('../lib/wav-encoder.js');
  const needed = ['WavAccumulator', 'encodeWav', 'encodeWavHeader', 'wavHeaderFields', 'interleavePcm', 'normalizeBitDepth', 'peakToDb', 'METER_FLOOR_DB'];
  check('lib/wav-encoder.js exports what offscreen.js imports', needed.every((key) => key in mod), needed.filter((k) => !(k in mod)).join(', '));
}

const lines = results.map((r) => `${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` -- ${r.detail}` : ''}`);
const summary = failed === 0 ? `PASS ${results.length}/${results.length}` : `FAIL ${failed} of ${results.length}`;
const box = document.getElementById('result');
box.className = failed === 0 ? 'ok' : 'fail';
box.textContent = `${summary}\n\n${lines.join('\n')}`;
document.title = failed === 0 ? summary : `${summary}: ${results.filter((r) => !r.pass).map((r) => r.name).join(' | ')}`;
window.__moduleSummary = { total: results.length, failed, results };
