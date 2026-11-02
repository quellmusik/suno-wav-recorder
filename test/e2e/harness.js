/**
 * The driver for the end-to-end run, loaded as an extension page
 * (chrome-extension://<id>/e2e-harness.html) so it has the same APIs popup.js has.
 *
 * It plays the popup's role: send START_CAPTURE, listen for the relayed CAPTURE_* messages,
 * send STOP_CAPTURE, and watch chrome.downloads until the WAV is written. Everything it sees is
 * posted to the local driver at /save/e2e-report.json, so a run leaves a machine-readable report
 * behind even when nobody is looking at the tab.
 *
 * Query params (drive.ps1 sets them):
 *   serve    - origin of the local test server, e.g. http://127.0.0.1:8788
 *   tone     - URL of the page that plays the test tone
 *   ms       - how long to record, in milliseconds
 *   savewait - how long to wait for the download to reach "complete", in milliseconds
 */

const params = new URLSearchParams(location.search);
const SERVE = params.get('serve') || location.origin;
const TONE = params.get('tone') || `${SERVE}/e2e-tone.html`;
const RECORD_MS = Number(params.get('ms') || 6000);
const SAVE_WAIT_MS = Number(params.get('savewait') || 120000);
const START_TIMEOUT_MS = 20000;
const DONE_TIMEOUT_MS = 30000;
const INVOKE_WAIT_MS = Number(params.get('invokewait') || 60000);
const MODE = params.get('mode') === 'stub' ? 'stub' : 'capture';

const stepsEl = document.getElementById('steps');
const dumpEl = document.getElementById('dump');

const state = {
  stage: 'boot',
  tabId: null,
  startedAt: null,
  readyAt: null,
  stoppedAt: null,
  doneAt: null,
  recordedSeconds: null,
  badgeWhileRecording: null,
  badgeAfterDone: null,
  offscreenWhileRecording: null,
  offscreenAfterDone: null,
  startReply: null,
  stopReply: null,
  capture: null,
  lastProgress: null,
  progressCount: 0,
  downloads: [],
  downloadHistory: [],
  downloadComplete: false,
  sawInProgress: false,
  savedPath: null,
  errors: [],
};

const events = [];
const checks = [];

/** type -> finish(message), registered by waitForType. */
const waiters = new Map();

function note(stage, detail) {
  state.stage = stage;
  events.push({ at: new Date().toISOString(), stage, detail: detail || '' });
  render();
  void post();
}

function check(name, pass, detail) {
  checks.push({ name, pass: Boolean(pass), detail: pass ? '' : (detail || '') });
  render();
}

function render() {
  stepsEl.textContent = '';
  for (const c of checks) {
    const li = document.createElement('li');
    li.className = c.pass ? 'ok' : 'bad';
    li.textContent = `${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
    stepsEl.appendChild(li);
  }
  dumpEl.textContent = JSON.stringify({ ...state, events, checks }, null, 2);
}

/** Serialised so two reports never interleave into a half-written file. */
let posting = Promise.resolve();
function post() {
  const body = JSON.stringify({ ...state, events, checks, href: location.href });
  posting = posting
    .then(() => fetch(`${SERVE}/save/e2e-report.json`, { method: 'POST', body, headers: { 'content-type': 'application/json' } }))
    .catch(() => {});
  return posting;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** chrome.runtime.sendMessage as a promise that always settles, even with no receiver. */
function rpc(message) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ type: 'NO_REPLY_IN_TIME' });
    }, START_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        resolve(err ? { type: 'NO_REPLY', message: err.message } : (reply || { type: 'EMPTY_REPLY' }));
      });
    } catch (err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ type: 'THREW', message: String((err && err.message) || err) });
    }
  });
}

async function badgeText() {
  try {
    return await chrome.action.getBadgeText({});
  } catch (err) {
    return `unavailable: ${String((err && err.message) || err)}`;
  }
}

async function offscreenCount() {
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return Array.isArray(contexts) ? contexts.length : -1;
  } catch (err) {
    return `unavailable: ${String((err && err.message) || err)}`;
  }
}

/** Wait until the tab reports status "complete", or give up. */
async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') return true;
    } catch (err) {
      return false;
    }
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

/** Resolves on the next relayed message of one type, or null on timeout. */
function waitForType(type, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      waiters.delete(type);
      resolve(value);
    }
    waiters.set(type, finish);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== 'string') return false;
  // Background relays carry target 'popup'; our own commands to the offscreen document carry
  // target 'offscreen' and are not meant for us.
  if (message.target && message.target !== 'popup' && message.target !== 'background') return false;

  const waiter = waiters.get(message.type);
  if (waiter) waiter(message);

  switch (message.type) {
    case 'CAPTURE_READY':
      state.readyAt = Date.now();
      note('ready');
      break;
    case 'CAPTURE_PROGRESS':
      state.progressCount += 1;
      state.lastProgress = { seconds: message.seconds, peakDb: message.peakDb, at: Date.now() };
      if (state.stage === 'starting' || state.stage === 'ready') state.stage = 'recording';
      break;
    case 'CAPTURE_DONE':
      state.doneAt = Date.now();
      state.capture = {
        filename: message.filename,
        bytes: message.bytes,
        sampleRate: message.sampleRate,
        channels: message.channels,
        bitDepth: message.bitDepth,
      };
      note('done');
      break;
    case 'CAPTURE_ERROR':
    case 'ERROR':
      state.errors.push(String(message.message || message.type));
      note('error', String(message.message || ''));
      break;
    default:
      break;
  }
  void post();
  return false;
});

function summarise(item) {
  return {
    id: item.id,
    state: item.state,
    filename: item.filename,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    fileSize: item.fileSize,
    exists: item.exists,
    error: item.error || null,
    url: String(item.url || '').slice(0, 64),
  };
}

async function pollDownloads() {
  try {
    const items = await chrome.downloads.search({});
    state.downloads = (items || []).map(summarise);
    const mine = state.downloads.find((item) => String(item.filename || '').toLowerCase().endsWith('.wav'))
      || state.downloads.find((item) => String(item.url || '').toLowerCase().startsWith('blob:'))
      || state.downloads[0]
      || null;
    if (mine) {
      const last = state.downloadHistory[state.downloadHistory.length - 1];
      if (!last || last.state !== mine.state || last.bytesReceived !== mine.bytesReceived) {
        state.downloadHistory.push({
          at: new Date().toISOString(),
          state: mine.state,
          bytesReceived: mine.bytesReceived,
          totalBytes: mine.totalBytes,
          filename: mine.filename,
          error: mine.error,
        });
      }
    }
    return mine;
  } catch (err) {
    state.errors.push(`downloads.search failed: ${String((err && err.message) || err)}`);
    return null;
  }
}

async function listCommands() {
  try {
    const commands = await chrome.commands.getAll();
    return commands.map((c) => ({ name: c.name, shortcut: c.shortcut }));
  } catch (err) {
    return [`unavailable: ${String((err && err.message) || err)}`];
  }
}

/**
 * START_CAPTURE until Brave accepts it. The first attempts fail with "Extension has not been
 * invoked for the current page" until someone presses the extension's shortcut (or clicks its
 * icon) with the recorded tab focused; that press is what the driver asks the agent for.
 */
async function startCaptureWithInvocation(tabId, waitMs) {
  const deadline = Date.now() + waitMs;
  let attempts = 0;
  let reply = null;
  let neededInvocation = false;
  while (Date.now() < deadline) {
    attempts += 1;
    reply = await rpc({ type: 'START_CAPTURE', tabId });
    if (reply && (reply.type === 'STARTED' || reply.type === 'CAPTURE_READY')) {
      state.invocationAttempts = attempts;
      return { reply, attempts, neededInvocation };
    }
    if (reply && /invoked|gesture|activeTab/i.test(String(reply.message || ''))) {
      neededInvocation = true;
      state.stage = 'need-invocation';
      state.invocationHint = reply.message;
      render();
      await post();
    }
    await sleep(1200);
  }
  return { reply, attempts, neededInvocation };
}

async function main() {
  if (MODE === 'stub') return stubMain();
  note('boot', location.href);

  check('the harness runs as an extension page', location.protocol === 'chrome-extension:', location.origin);
  check('chrome.tabCapture is exposed to this extension', Boolean(chrome.tabCapture), 'chrome.tabCapture missing');
  check('chrome.offscreen is exposed to this extension', Boolean(chrome.offscreen), 'chrome.offscreen missing');
  check('chrome.downloads is exposed to this extension', Boolean(chrome.downloads), 'chrome.downloads missing');

  // 1. A real tab that really plays audio, focused, so tabCapture has something to hand over.
  note('opening-tone-tab');
  const toneTab = await chrome.tabs.create({ url: TONE, active: true });
  state.tabId = toneTab.id;
  const loaded = await waitForTabComplete(toneTab.id);
  check('the tone tab finished loading', loaded, 'the tone page never reached status complete');
  await sleep(1500); // let the oscillator actually run before capture starts

  // 2. Start. tabCapture only hands over a stream for a tab the extension has been invoked
  //    on, so a run that was not started from a real click on the toolbar icon has to wait for
  //    one: the driver's window gets the shortcut from the throwaway manifest pressed while the
  //    tone tab is focused, and START_CAPTURE is retried until the grant lands.
  note('starting');
  const start = await startCaptureWithInvocation(toneTab.id, INVOKE_WAIT_MS);
  const startReply = start.reply || { type: 'NO_ATTEMPT' };
  state.startReply = startReply;
  state.startAttempts = start.attempts;
  if (start.neededInvocation) {
    state.commands = await listCommands();
  }
  check('START_CAPTURE was answered', !['NO_REPLY_IN_TIME', 'NO_REPLY', 'THREW', 'EMPTY_REPLY', 'NO_ATTEMPT'].includes(startReply.type), `${startReply.type}${startReply.message ? ': ' + startReply.message : ''}`);
  check('START_CAPTURE answered STARTED', ['STARTED', 'CAPTURE_READY'].includes(startReply.type), `${startReply.type}${startReply.message ? ': ' + startReply.message : ''}`);

  if (!['STARTED', 'CAPTURE_READY'].includes(startReply.type)) {
    note('start-failed', startReply.message || startReply.type);
    check('a recording reached CAPTURE_READY', false, startReply.message || startReply.type);
    await post();
    return;
  }
  state.startedAt = Date.now();

  const ready = await waitForType('CAPTURE_READY', START_TIMEOUT_MS);
  check('the offscreen document reported CAPTURE_READY', Boolean(ready), 'no CAPTURE_READY within 20 s');

  await sleep(600);
  state.badgeWhileRecording = await badgeText();
  state.offscreenWhileRecording = await offscreenCount();
  check('the badge shows REC while recording', state.badgeWhileRecording === 'REC', `badge text was ${JSON.stringify(state.badgeWhileRecording)}`);
  check('one offscreen document is open while recording', state.offscreenWhileRecording === 1, `getContexts returned ${JSON.stringify(state.offscreenWhileRecording)}`);
  note('recording');

  // 3. Record, then stop.
  await sleep(RECORD_MS);
  note('stopping');
  const stopReply = await rpc({ type: 'STOP_CAPTURE' });
  state.stopReply = stopReply;
  check('STOP_CAPTURE was answered', !['NO_REPLY_IN_TIME', 'NO_REPLY', 'THREW'].includes(stopReply.type), stopReply.message || stopReply.type);
  check('STOP_CAPTURE answered STOPPING', stopReply.type === 'STOPPING', stopReply.message || stopReply.type);
  state.stoppedAt = Date.now();

  const done = await waitForType('CAPTURE_DONE', DONE_TIMEOUT_MS);
  check('the offscreen document reported CAPTURE_DONE', Boolean(done), 'no CAPTURE_DONE within 30 s');
  check('progress messages arrived while recording', state.progressCount >= 2, `${state.progressCount} CAPTURE_PROGRESS messages`);
  if (state.lastProgress) {
    check('the level meter saw audio above its floor', Number(state.lastProgress.peakDb) > -60, `last peakDb ${state.lastProgress.peakDb}`);
  }
  if (state.capture) {
    state.recordedSeconds = (Date.now() - (state.startedAt || Date.now())) / 1000;
    check('CAPTURE_DONE carries a WAV filename', /\.wav$/i.test(String(state.capture.filename || '')), String(state.capture.filename));
    check('CAPTURE_DONE carries a plausible byte count', Number(state.capture.bytes) > 10000, String(state.capture.bytes));
    check('CAPTURE_DONE carries a real sample rate', Number(state.capture.sampleRate) >= 8000, String(state.capture.sampleRate));
    check('CAPTURE_DONE carries a 16- or 24-bit depth', [16, 24].includes(Number(state.capture.bitDepth)), String(state.capture.bitDepth));
  }

  state.badgeAfterDone = await badgeText();
  check('the badge is cleared once the recording is done', state.badgeAfterDone === '', `badge text was ${JSON.stringify(state.badgeAfterDone)}`);

  // 4. The download: background.js asks Brave to save the blob, and the file has to land.
  note('awaiting-download');
  const deadline = Date.now() + SAVE_WAIT_MS;
  let item = null;
  while (Date.now() < deadline) {
    item = await pollDownloads();
    if (item && item.state === 'in_progress') state.sawInProgress = true;
    if (item && (item.state === 'complete' || item.state === 'interrupted')) break;
    await sleep(400);
  }
  await post();

  state.downloadComplete = Boolean(item && item.state === 'complete');
  check('a .wav download was created', Boolean(item), 'chrome.downloads never listed a .wav download');
  check('the download reached state "complete"', state.downloadComplete, item ? `${item.state}${item.error ? ' (' + item.error + ')' : ''}` : 'no download');
  if (state.downloadComplete) {
    check('the saved file is non-empty', Number(item.fileSize) > 10000, String(item.fileSize));
    check('the saved file exists on disk', item.exists === true, String(item.exists));
    state.savedPath = item.filename;
  }

  // 5. The recorder document is released only after the file is written.
  state.offscreenAfterDone = await offscreenCount();
  if (state.downloadComplete) {
    for (let i = 0; i < 24 && state.offscreenAfterDone !== 0; i += 1) {
      await sleep(250);
      state.offscreenAfterDone = await offscreenCount();
    }
    check('the offscreen document is closed after the save', state.offscreenAfterDone === 0, `getContexts returned ${JSON.stringify(state.offscreenAfterDone)}`);
  }

  note(state.downloadComplete ? 'finished' : 'finished-without-download');
  await post();
}

/**
 * "stub" mode: the same harness, but the offscreen document's side of the contract is played
 * by this page. It sends the CAPTURE_* messages a real recorder would send, around a real WAV
 * built by lib/wav-encoder.js, and then watches what background.js does with them: the badge,
 * the relays, the download, and the state it reports. That makes the whole background contract
 * checkable with no tab to capture and nobody to click anything, which is what a machine with
 * nobody at the keyboard can run.
 */
async function stubMain() {
  note('stub-boot', location.href);
  const { encodeWavBlob } = await import('./lib/wav-encoder.js');

  check('the harness runs as an extension page', location.protocol === 'chrome-extension:', location.origin);

  // Nothing running: both commands must say so instead of throwing.
  const idleStop = await rpc({ type: 'STOP_CAPTURE' });
  check('STOP_CAPTURE with nothing recording answers ERROR', idleStop.type === 'ERROR' && /no recording/i.test(String(idleStop.message || '')), JSON.stringify(idleStop));
  const idleRetry = await rpc({ type: 'RETRY_DOWNLOAD' });
  check('RETRY_DOWNLOAD with nothing pending answers ERROR', idleRetry.type === 'ERROR' && /no finished recording/i.test(String(idleRetry.message || '')), JSON.stringify(idleRetry));
  const idleState = await rpc({ type: 'GET_STATE' });
  check('GET_STATE answers STATE', idleState.type === 'STATE', JSON.stringify(idleState));
  check('GET_STATE reports nothing capturing', idleState.capturing === false, JSON.stringify(idleState));

  // A message type nobody handles must not be answered at all.
  const unknown = await rpc({ type: 'NOT_A_CONTRACT_TYPE' });
  check('an unknown message type is ignored', ['NO_REPLY', 'NO_REPLY_IN_TIME'].includes(unknown.type), JSON.stringify(unknown));

  // 1. CAPTURE_READY: the badge and the state follow.
  note('stub-ready');
  const tabId = 4242;
  await rpc({ type: 'CAPTURE_READY', tabId }).catch(() => {});
  await sleep(700);
  state.badgeWhileRecording = await badgeText();
  check('CAPTURE_READY sets the badge to REC', state.badgeWhileRecording === 'REC', JSON.stringify(state.badgeWhileRecording));
  const liveState = await rpc({ type: 'GET_STATE' });
  state.stateWhileRecording = liveState;
  check('GET_STATE reports the recording after CAPTURE_READY', liveState.capturing === true, JSON.stringify(liveState));

  // 2. CAPTURE_PROGRESS is relayed onward.
  note('stub-progress');
  await rpc({ type: 'CAPTURE_PROGRESS', seconds: 1.5, peakDb: -12.5 }).catch(() => {});
  await sleep(500);
  check('CAPTURE_PROGRESS was relayed to the popup', Boolean(state.lastProgress) && Math.abs(Number(state.lastProgress.seconds) - 1.5) < 0.01, JSON.stringify(state.lastProgress));

  // 3. CAPTURE_DONE with a deliberately awkward filename: background.js has to sanitise it,
  //    clear the badge, and get Brave to write the file.
  note('stub-done');
  await sleep(500);
  const sampleRate = 48000;
  const seconds = 2;
  const channels = 2;
  const frames = sampleRate * seconds;
  const left = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) left[i] = 0.15 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  const blob = encodeWavBlob({ channelData: [left, left], sampleRate, bitDepth: 16 });
  const blobUrl = URL.createObjectURL(blob);
  state.stubBytes = blob.size;
  const proposedName = 'suno: "Take 1"?.wav';
  await rpc({
    type: 'CAPTURE_DONE',
    blobUrl,
    filename: proposedName,
    bytes: blob.size,
    sampleRate,
    channels,
    bitDepth: 16,
  }).catch(() => {});
  await sleep(700);
  state.badgeAfterDone = await badgeText();
  check('CAPTURE_DONE clears the badge', state.badgeAfterDone === '', JSON.stringify(state.badgeAfterDone));
  const doneState = await rpc({ type: 'GET_STATE' });
  check('GET_STATE reports nothing capturing after CAPTURE_DONE', doneState.capturing === false, JSON.stringify(doneState));

  // 4. The download, with the filename sanitised on the way through.
  note('awaiting-download');
  const deadline = Date.now() + SAVE_WAIT_MS;
  let item = null;
  while (Date.now() < deadline) {
    item = await pollDownloads();
    if (item && item.state === 'in_progress') state.sawInProgress = true;
    if (item && (item.state === 'complete' || item.state === 'interrupted')) break;
    await sleep(300);
  }
  await post();

  state.downloadComplete = Boolean(item && item.state === 'complete');
  check('a .wav download was created', Boolean(item), 'chrome.downloads never listed a .wav download');
  if (item) {
    check('the filename was sanitised', !/[":?]/.test(String(item.filename || '').split(/[\\/]/).pop()), String(item.filename));
    if (item.filename) check('the filename still ends in .wav', /\.wav$/i.test(String(item.filename)), String(item.filename));
  }
  check('the download reached state "complete"', state.downloadComplete, item ? `${item.state}${item.error ? ' (' + item.error + ')' : ''}` : 'no download');
  if (state.downloadComplete) {
    check('the saved file is the size the harness sent', Math.abs(Number(item.fileSize) - blob.size) <= 2, `file ${item.fileSize} vs blob ${blob.size}`);
    check('the saved file exists on disk', item.exists === true, String(item.exists));
    state.savedPath = item.filename;
  }

  note(state.downloadComplete ? 'finished' : 'finished-without-download');
  await post();
}

main().catch(async (err) => {
  state.errors.push(String((err && err.stack) || err));
  note('crashed', String((err && err.message) || err));
  await post();
});
