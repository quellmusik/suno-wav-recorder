/**
 * The tab capture check: a real tab's audio, through the real offscreen recorder, to a WAV.
 *
 * This page has to be loaded as an extension page (chrome-extension://<id>/test/...), because
 * chrome.tabCapture and chrome.offscreen only exist there. test/run-tests.ps1 loads the
 * extension unpacked into a throwaway profile and opens this page, so the run is unattended.
 *
 * What it proves, in order:
 *   1. chrome.tabCapture.getMediaStreamId({targetTabId}) answers for a real tab;
 *   2. offscreen.js accepts that id and getUserMedia({audio:{mandatory:{chromeMediaSource:
 *      'tab', chromeMediaSourceId: id}}}) opens a stream with an audio track on it;
 *   3. the recorder produces CAPTURE_READY, then CAPTURE_PROGRESS every 500 ms with a live
 *      peak, then CAPTURE_DONE with a blob URL, a filename, and the true format;
 *   4. the WAV the recorder hands over decodes in the browser's own decoder, is as long as
 *      the take, and still carries 440 Hz at the level the tab played.
 *
 * The tab under test is a real suno.com page with a 440 Hz tone injected into it, because
 * tabCapture will only hand out a stream id for a tab this extension has access to (its
 * activeTab grant or its host permission) and it refuses chrome:// and chrome-extension://
 * pages outright. If suno.com cannot be reached, the run falls back to an extension page
 * that plays the same tone, and reports which one it used.
 *
 * background.js reacts to the same CAPTURE_DONE this harness listens for and starts a
 * download; the harness cancels that one so a test run leaves no WAV in Downloads.
 */

import { MSG, TARGET } from '../lib/messages.js';
import { parseWavHeader } from '../lib/wav-encoder.js';

const TAKE_MS = 4000;
const READY_TIMEOUT_MS = 15000;
const DONE_TIMEOUT_MS = 20000;
/** How long to wait for the toolbar click that grants activeTab; 15 s unless ?invokewait= says otherwise. */
const INVOKE_WAIT_MS = Number(new URLSearchParams(location.search).get('invokewait')) || 15000;
const TONE_HZ = 440;
const TONE_AMPLITUDE = 0.8;

const results = [];
let failed = 0;
const timeline = [];

/**
 * Where test/serve.ps1 is listening. An extension page's own origin is chrome-extension://,
 * so /save/... has to be spelled out in full to reach the shell.
 */
const SERVE_BASE = (new URLSearchParams(location.search).get('serve') || 'http://127.0.0.1:8787').replace(/\/$/, '');

function check(name, pass, detail) {
  results.push({ name, pass, detail: pass ? '' : (detail || '') });
  if (!pass) failed += 1;
}

function note(step, detail) {
  timeline.push({ at: Math.round(performance.now()), step, detail: detail === undefined ? '' : String(detail) });
}

/** The title doubles as a progress readout: /json/list can be read while the page runs. */
function progress(text) {
  document.title = text;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function upload() {
  const params = new URLSearchParams(location.search);
  if (!params.has('upload')) return false;
  // An extension page is chrome-extension://, which is not http but can still POST.
  return /^(https?|chrome-extension):$/.test(location.protocol);
}

/* -------------------------------------------------------------------------- */
/* Message traffic from the recorder and from background.js                    */
/* -------------------------------------------------------------------------- */

const capture = { ready: null, progress: [], done: null, error: null, bytes: null };

/** Resolvers waiting on the next occurrence of a message type. */
const waiters = new Map();
function waitFor(type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(type);
      reject(new Error(`timed out after ${timeoutMs} ms waiting for ${type}`));
    }, timeoutMs);
    waiters.set(type, (message) => {
      clearTimeout(timer);
      waiters.delete(type);
      resolve(message);
    });
  });
}

// Cancels the download background.js starts for the same CAPTURE_DONE, so a test run does
// not put a WAV in the user's Downloads folder.
const cancelledDownloads = [];
if (chrome.downloads && chrome.downloads.onCreated) {
  chrome.downloads.onCreated.addListener((item) => {
    cancelledDownloads.push({ id: item.id, filename: item.filename, url: item.url });
    try {
      chrome.downloads.cancel(item.id, () => {
        void chrome.runtime.lastError;
        try {
          chrome.downloads.erase({ id: item.id });
        } catch (err) {
          /* history entry already gone */
        }
      });
    } catch (err) {
      /* nothing to cancel */
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.type === MSG.CAPTURE_READY) {
    note('CAPTURE_READY', `tabId=${message.tabId}`);
    capture.ready = message;
    const waiter = waiters.get(MSG.CAPTURE_READY);
    if (waiter) waiter(message);
    return false;
  }
  if (message.type === MSG.CAPTURE_PROGRESS) {
    capture.progress.push({ seconds: message.seconds, peakDb: message.peakDb });
    return false;
  }
  if (message.type === MSG.CAPTURE_DONE) {
    note('CAPTURE_DONE', `${message.filename} ${message.bytes} bytes`);
    capture.done = message;
    // Start reading the blob before background.js's save can close the recorder document.
    if (typeof message.blobUrl === 'string') {
      capture.bytes = fetch(message.blobUrl)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(`blob fetch HTTP ${response.status}`))))
        .then((buffer) => new Uint8Array(buffer))
        .catch((err) => {
          note('blob fetch failed', err && err.message ? err.message : err);
          return null;
        });
    }
    const waiter = waiters.get(MSG.CAPTURE_DONE);
    if (waiter) waiter(message);
    return false;
  }
  if (message.type === MSG.CAPTURE_ERROR) {
    note('CAPTURE_ERROR', message.message);
    capture.error = message;
    for (const type of [MSG.CAPTURE_READY, MSG.CAPTURE_DONE]) {
      const waiter = waiters.get(type);
      if (waiter) waiter(message);
    }
    return false;
  }
  return false;
});

/* -------------------------------------------------------------------------- */
/* The tab under test                                                         */
/* -------------------------------------------------------------------------- */

/** Runs inside the page under test: a 440 Hz tone at 0.8 full scale, straight to the tab. */
function startToneInPage() {
  const context = new AudioContext();
  const oscillator = new OscillatorNode(context, { type: 'sine', frequency: 440 });
  const level = new GainNode(context, { gain: 0.8 });
  oscillator.connect(level);
  level.connect(context.destination);
  oscillator.start();
  window.__tabTone = { context, oscillator, level };
  if (context.state === 'suspended') void context.resume();
  return { state: context.state, sampleRate: context.sampleRate };
}

/**
 * A tab this extension is allowed to capture, playing 440 Hz.
 *
 * suno.com first: the manifest carries a host permission for it, which is what satisfies
 * tabCapture's "the extension must have access to this tab" check without a click. An
 * extension page of our own is only a fallback, because tabCapture refuses chrome-extension
 * pages regardless of permission.
 */
async function openToneTab() {
  const attempts = [];

  progress('opening https://suno.com');
  try {
    const tab = await chrome.tabs.create({ url: 'https://suno.com/', active: true });
    // Wait for the page to finish loading; executeScript fails on a tab still navigating.
    for (let i = 0; i < 60; i += 1) {
      await sleep(250);
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete') break;
    }
    const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: startToneInPage });
    note('tone injected into suno.com', JSON.stringify(injected && injected[0] ? injected[0].result : null));
    await sleep(1200);
    return { kind: 'suno.com', tabId: tab.id, url: (await chrome.tabs.get(tab.id)).url };
  } catch (err) {
    attempts.push(`suno.com: ${err && err.message ? err.message : err}`);
    note('suno.com attempt failed', attempts[attempts.length - 1]);
  }

  progress('opening the extension tone page');
  try {
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('test/tabcapture/tone.html'), active: true });
    await sleep(1500);
    return { kind: 'extension page', tabId: tab.id, url: 'test/tabcapture/tone.html' };
  } catch (err) {
    attempts.push(`extension page: ${err && err.message ? err.message : err}`);
  }

  return { kind: null, tabId: null, attempts };
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The programmatic form of a click on the toolbar icon: it is what grants the extension its
 * activeTab permission on the current tab, without which tabCapture refuses to hand out a
 * stream id. Chrome 127+ allows openPopup() from an extension page with no user gesture.
 */
async function invokeAction() {
  if (!chrome.action || typeof chrome.action.openPopup !== 'function') return 'chrome.action.openPopup is not available';
  try {
    await chrome.action.openPopup();
    return 'opened the action popup';
  } catch (err) {
    return `openPopup failed: ${err && err.message ? err.message : err}`;
  }
}

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return 'already open';
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Record a tab\'s audio and encode it to a WAV file for the person recording.',
  });
  return 'opened offscreen.html';
}

async function run() {
  progress('step 1: environment');
  const environment = {
    userAgent: navigator.userAgent,
    hasTabCapture: !!(chrome.tabCapture && chrome.tabCapture.getMediaStreamId),
    hasOffscreen: !!chrome.offscreen,
    // The rate the recorder will run at, measured the same way offscreen.js measures it.
    harnessSampleRate: new AudioContext().sampleRate,
  };
  check('chrome.tabCapture.getMediaStreamId exists', environment.hasTabCapture);
  check('chrome.offscreen exists', environment.hasOffscreen);
  note('environment', JSON.stringify(environment));

  const tone = await openToneTab();
  note('tab under test', `${tone.kind} id=${tone.tabId} ${tone.url || ''}`);
  check('a capturable tab playing 440 Hz was opened', !!tone.tabId, (tone.attempts || []).join(' | '));
  if (!tone.tabId) return { environment, blocked: (tone.attempts || []).join(' | ') };

  const live = await chrome.tabs.get(tone.tabId);
  check('the tab under test is the active tab', live.active === true, `active=${live.active}`);
  check('the tab under test is audible', live.audible === true, `audible=${live.audible} muted=${live.mutedInfo && live.mutedInfo.muted}`);

  // The stream id tabCapture hands out for it. tabCapture only captures a tab the extension
  // has been *invoked* on (its activeTab grant), which in normal use is a click on the
  // toolbar icon while the Suno tab is in front. Nothing programmatic grants that, so this
  // waits for a click: it retries for INVOKE_WAIT_MS while someone (or the runner's screen
  // automation) opens the popup once on the tab under test.
  let streamId = null;
  progress('step 2: waiting for the toolbar click (getMediaStreamId)');
  const idStarted = performance.now();
  let attempts = 0;
  let lastError = '';
  while (performance.now() - idStarted < INVOKE_WAIT_MS) {
    attempts += 1;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tone.tabId });
      break;
    } catch (err) {
      lastError = err && err.message ? err.message : String(err);
      if (attempts === 1) {
        const invoked = await invokeAction();
        note('first getMediaStreamId failed', `${lastError} -- ${invoked}`);
      }
    }
    await sleep(1500);
  }
  if (typeof streamId !== 'string' || !streamId) {
    note('getMediaStreamId threw', `${lastError} (after ${attempts} attempts over ${Math.round(performance.now() - idStarted)} ms)`);
    check('getMediaStreamId answered a stream id', false, lastError);
    return { environment, tone, blocked: lastError };
  }
  note('getMediaStreamId', `length ${streamId.length} after ${attempts} attempts in ${Math.round(performance.now() - idStarted)} ms`);
  check('getMediaStreamId answered a stream id', true);

  // The real recorder document, on that id.
  progress('step 3: opening the recorder');
  const offscreen = await ensureOffscreen();
  note('offscreen', offscreen);

  const readyPromise = waitFor(MSG.CAPTURE_READY, READY_TIMEOUT_MS);
  const started = await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_START, streamId, tabId: tone.tabId, bitDepth: 16, target: TARGET.OFFSCREEN });
  note('OFFSCREEN_START reply', JSON.stringify(started));
  check('the recorder accepted OFFSCREEN_START', !!(started && started.ok), JSON.stringify(started));

  const ready = await readyPromise.catch(() => null);
  check('the recorder answered CAPTURE_READY', !!capture.ready, capture.error ? capture.error.message : '');
  if (!capture.ready) {
    return { environment, tone, streamId: typeof streamId === 'string', blocked: capture.error ? capture.error.message : `no CAPTURE_READY (${ready ? 'got another message' : 'timeout'})` };
  }

  // Record for a known time.
  progress('step 4: recording');
  const takeStarted = performance.now();
  await sleep(TAKE_MS);

  progress('step 5: stopping');
  const donePromise = waitFor(MSG.CAPTURE_DONE, DONE_TIMEOUT_MS);
  await chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_STOP, target: TARGET.OFFSCREEN });
  await donePromise.catch(() => null);

  check('the recorder answered CAPTURE_DONE', !!capture.done, capture.error ? capture.error.message : 'no CAPTURE_DONE');
  check('the recorder reported no error', !capture.error, capture.error ? capture.error.message : '');
  check('progress arrived about every 500 ms', capture.progress.length >= Math.floor(TAKE_MS / 500) - 1, `${capture.progress.length} updates in ${Math.round(performance.now() - takeStarted)} ms`);
  const loudest = capture.progress.reduce((max, p) => (typeof p.peakDb === 'number' && p.peakDb > max ? p.peakDb : max), -Infinity);
  check('the level meter saw the tone (about -1.9 dBFS)', loudest > -6, `loudest peakDb ${loudest}`);

  if (!capture.done) return { environment, tone, blocked: capture.error ? capture.error.message : 'no CAPTURE_DONE' };

  // The file itself.
  progress('step 6: reading the WAV');
  const meta = {
    filename: capture.done.filename,
    bytes: capture.done.bytes,
    sampleRate: capture.done.sampleRate,
    channels: capture.done.channels,
    bitDepth: capture.done.bitDepth,
  };
  note('CAPTURE_DONE meta', JSON.stringify(meta));
  check('CAPTURE_DONE carries a filename ending .wav', /^suno-recording-.*\.wav$/.test(String(meta.filename)), String(meta.filename));
  check('CAPTURE_DONE says 16-bit PCM', meta.bitDepth === 16, String(meta.bitDepth));
  check('CAPTURE_DONE reports the recorder sample rate', meta.sampleRate === environment.harnessSampleRate, `${meta.sampleRate} vs ${environment.harnessSampleRate}`);
  check('CAPTURE_DONE reports at least one channel', meta.channels >= 1, String(meta.channels));

  const bytes = capture.bytes ? await capture.bytes : null;
  check('the blob URL served the WAV back', !!bytes, capture.bytes ? '' : 'no bytes');
  if (!bytes) return { environment, tone, meta, blocked: 'the blob URL did not serve the file' };

  check('the file is the size CAPTURE_DONE claimed', bytes.byteLength === meta.bytes, `${bytes.byteLength} vs ${meta.bytes}`);
  // parseWavHeader also compares dataSize with the bytes handed to it; here that is the
  // 44-byte header only, so check the format fields and compare the data size separately.
  const parsed = parseWavHeader(bytes.subarray(0, 44));
  check('the header says RIFF/WAVE, PCM, the reported rate/channels/depth',
    !!parsed.fields
      && parsed.fields.riffId === 'RIFF' && parsed.fields.waveId === 'WAVE'
      && parsed.fields.audioFormat === 1
      && parsed.fields.sampleRate === meta.sampleRate
      && parsed.fields.numChannels === meta.channels
      && parsed.fields.bitsPerSample === meta.bitDepth,
    parsed.fields ? JSON.stringify(parsed.fields) : 'no fields');
  check('the header\'s data size matches the bytes that follow', !!parsed.fields && parsed.fields.dataSize === bytes.byteLength - 44, parsed.fields ? `${parsed.fields.dataSize} vs ${bytes.byteLength - 44}` : '');

  // Decode it: the browser's own decoder is the playability test.
  progress('step 7: decoding the captured WAV');
  const context = new AudioContext();
  let decoded = null;
  try {
    const buffer = await context.decodeAudioData(bytes.slice(0).buffer);
    const seconds = buffer.duration;
    const data = buffer.getChannelData(0);
    let peak = 0;
    let crossings = 0;
    let previous = 0;
    for (let i = 0; i < data.length; i += 1) {
      const value = data[i];
      const magnitude = value < 0 ? -value : value;
      if (magnitude > peak) peak = magnitude;
      if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings += 1;
      previous = value;
    }
    const measuredHz = (crossings / 2) / seconds;
    const peakDb = 20 * Math.log10(peak || 1e-9);
    check('the captured WAV decodes in the browser', true);
    check('the captured WAV is about as long as the take', Math.abs(seconds - TAKE_MS / 1000) < 1.5, `${seconds.toFixed(3)} s`);
    check('the captured WAV decodes at the recorder\'s own rate', buffer.sampleRate === meta.sampleRate, `${buffer.sampleRate} vs ${meta.sampleRate}`);
    check('the captured WAV is 440 Hz', Math.abs(measuredHz - TONE_HZ) < 2, `${measuredHz.toFixed(2)} Hz`);
    check('the tone kept its level through tab capture', Math.abs(peakDb - 20 * Math.log10(TONE_AMPLITUDE)) < 1, `${peakDb.toFixed(2)} dBFS vs ${(20 * Math.log10(TONE_AMPLITUDE)).toFixed(2)}`);
    decoded = { duration: seconds, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, peakDb, measuredHz };
  } catch (err) {
    check('the captured WAV decodes in the browser', false, err && err.message ? err.message : String(err));
  } finally {
    await context.close();
  }

  if (upload()) {
    progress('step 8: uploading the captured WAV');
    // A POST with no content-type header is a "simple request": no CORS preflight, so it
    // reaches the shell's server from a chrome-extension:// origin.
    const saved = await fetch(`${SERVE_BASE}/save/tabcapture.wav`, { method: 'POST', body: bytes }).catch((err) => ({ ok: false, text: () => String(err) }));
    check('the captured WAV was handed to test/out/', saved.ok, String(await saved.text()));
  }

  await chrome.offscreen.closeDocument().catch(() => {});
  await chrome.tabs.remove(tone.tabId).catch(() => {});
  return { environment, tone, meta, decoded };
}

/* -------------------------------------------------------------------------- */

const started = performance.now();
let outcome = null;
let failure = null;
try {
  outcome = await run();
} catch (err) {
  failure = err;
  check('the tab capture run completed without throwing', false, String(err && err.message ? err.message : err));
}

const lines = results.map((r) => `${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail && !r.pass ? ` -- ${r.detail}` : ''}`);
const summary = failed === 0 ? `PASS ${results.length}/${results.length}` : `FAIL ${failed} of ${results.length}`;
const box = document.getElementById('result');
box.className = failed === 0 ? 'ok' : 'fail';
box.textContent = [
  summary,
  '',
  ...lines,
  '',
  `elapsed: ${Math.round(performance.now() - started)} ms`,
  outcome && outcome.blocked ? `blocked: ${outcome.blocked}` : '',
  '',
  'timeline:',
  ...timeline.map((t) => `  ${t.at} ms  ${t.step} ${t.detail}`),
  cancelledDownloads.length ? `\ncancelled downloads: ${JSON.stringify(cancelledDownloads)}` : '',
  failure ? `\nthrew: ${failure && failure.stack ? failure.stack : failure}` : '',
].join('\n');
document.title = summary;

const report = {
  when: new Date().toISOString(),
  summary,
  failed,
  total: results.length,
  results,
  timeline,
  outcome,
  cancelledDownloads,
  threw: failure ? String(failure && failure.stack ? failure.stack : failure) : null,
};
window.__tabCaptureReport = report;

if (upload()) {
  const response = await fetch(`${SERVE_BASE}/save/tabcapture-report.json`, {
    method: 'POST',
    // text/plain keeps this a "simple request", so no CORS preflight is needed.
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(report, null, 2),
  }).catch((err) => ({ ok: false, status: 0, text: () => String(err) }));
  box.textContent += `\n\nreport posted: ${response.ok ? 'ok' : `HTTP ${response.status}`}`;
  document.title = `${summary} (posted)`;
}
