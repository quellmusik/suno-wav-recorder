/**
 * background.js against a fake `chrome`, in a plain page.
 *
 * The service worker cannot be imported the way a page imports a module, so this file stands in
 * a fake extension API first and then imports background.js, which runs its top-level wiring
 * against it. From there every message in the contract can be pushed through the worker's own
 * onMessage listener and what it did afterwards can be read off the fake.
 *
 * What that buys over the end-to-end run: the download's "complete" branch. A real saveAs
 * download needs somebody to click Save in Brave's dialog, and this test drives
 * chrome.downloads.onChanged directly instead, so the close-the-recorder-document step is
 * checked every time.
 */

const results = [];
const detail = document.getElementById('detail');
const resultsEl = document.getElementById('results');
let failed = 0;

function check(name, pass, info) {
  results.push({ name, pass: Boolean(pass), info: pass ? '' : (info || '') });
  if (!pass) failed += 1;
  const li = document.createElement('li');
  li.className = pass ? 'ok' : 'bad';
  li.textContent = `${pass ? 'PASS' : 'FAIL'}  ${name}${pass || !info ? '' : ` — ${info}`}`;
  resultsEl.appendChild(li);
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* The fake                                                                   */
/* -------------------------------------------------------------------------- */

const log = {
  badge: [],
  downloads: [],
  relays: [],
  offscreen: [],
  messages: [],
};

const fake = {
  runtime: {
    lastError: null,
    getURL: (path) => `chrome-extension://faketest/${path}`,
    sendMessage: (message) => {
      log.relays.push(message);
      log.messages.push(message);
      return Promise.resolve({});
    },
    onMessage: { listeners: [], addListener(fn) { this.listeners.push(fn); } },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
  },
  action: {
    setBadgeText: ({ text }) => { log.badge.push(text); return Promise.resolve(); },
    setBadgeBackgroundColor: () => Promise.resolve(),
    setBadgeTextColor: () => Promise.resolve(),
  },
  tabs: {
    onRemoved: { addListener() {} },
    get: (tabId) => Promise.resolve({ id: tabId, url: 'http://127.0.0.1/test/page.html', active: true, status: 'complete' }),
    query: () => Promise.resolve([]),
  },
  downloads: {
    onChanged: {
      listeners: [],
      addListener(fn) { this.listeners.push(fn); },
      removeListener(fn) { this.listeners = this.listeners.filter((l) => l !== fn); },
    },
    download: (options) => {
      log.downloads.push(options);
      return Promise.resolve(77);
    },
    search: () => Promise.resolve([]),
  },
  offscreen: {
    open: false,
    hasDocument() { return Promise.resolve(this.open); },
    createDocument(options) {
      log.offscreen.push({ action: 'create', options });
      this.open = true;
      return Promise.resolve();
    },
    closeDocument() {
      log.offscreen.push({ action: 'close' });
      this.open = false;
      return Promise.resolve();
    },
  },
  storage: {
    session: {
      get: () => Promise.resolve({}),
      set: () => Promise.resolve(),
    },
  },
};

Object.defineProperty(globalThis, 'chrome', { value: fake, writable: true, configurable: true });

// tabCapture is only exercised for its absence/guards here; the live run covers the real one.
fake.tabCapture = {
  getMediaStreamId: ({ targetTabId }, callback) => {
    callback(`fake-stream-for-${targetTabId}`);
    return undefined;
  },
};

const { MSG, sanitizeWavFilename, BADGE } = await import('../lib/messages.js');
await import('../background.js');
await tick(50);

const listener = fake.runtime.onMessage.listeners[0];
check('background.js registered a runtime.onMessage listener', typeof listener === 'function');

/** Send a message the way chrome does: resolve with the async reply, or undefined. */
function send(message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const keepOpen = listener(message, { id: 'faketest' }, finish);
    if (keepOpen !== true) finish(undefined);
  });
}

function fireDownload(delta) {
  for (const fn of [...fake.downloads.onChanged.listeners]) fn(delta);
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

check('an unknown message type is not claimed', listener({ type: 'NOT_A_CONTRACT_TYPE' }, {}, () => {}) === false);
check('a message with no type is not claimed', listener({}, {}, () => {}) === false);
check('its own OFFSCREEN_* commands are not handled by the worker', listener({ type: MSG.OFFSCREEN_START, streamId: 'x', target: 'offscreen' }, {}, () => {}) === false);

/* -------------------------------------------------------------------------- */
/* START / STOP guards                                                        */
/* -------------------------------------------------------------------------- */

const noTab = await send({ type: MSG.START_CAPTURE });
check('START_CAPTURE with no tab answers ERROR', noTab && noTab.type === MSG.ERROR, JSON.stringify(noTab));
check('the no-tab error tells the person what to do', Boolean(noTab && /tab/i.test(noTab.message || '')), String(noTab && noTab.message));

const idleStop = await send({ type: MSG.STOP_CAPTURE });
check('STOP_CAPTURE with nothing recording answers ERROR', idleStop && idleStop.type === MSG.ERROR, JSON.stringify(idleStop));

const idleRetry = await send({ type: MSG.RETRY_DOWNLOAD });
check('RETRY_DOWNLOAD with nothing pending answers ERROR', idleRetry && idleRetry.type === MSG.ERROR, JSON.stringify(idleRetry));

const stateReply = await send({ type: MSG.GET_STATE });
check('GET_STATE answers STATE', stateReply && stateReply.type === MSG.STATE, JSON.stringify(stateReply));
check('GET_STATE reports nothing capturing at rest', stateReply && stateReply.capturing === false, JSON.stringify(stateReply));

/* A brave:// tab must be refused with a readable reason, not a raw chrome error. */
fake.tabs.get = () => Promise.resolve({ id: 9, url: 'brave://settings', status: 'complete' });
const internal = await send({ type: MSG.START_CAPTURE, tabId: 9 });
check('START_CAPTURE on a brave:// tab answers ERROR', internal && internal.type === MSG.ERROR, JSON.stringify(internal));
check('the internal-page error names the reason', Boolean(internal && /brave:|internal|cannot record/i.test(internal.message || '')), String(internal && internal.message));
fake.tabs.get = (tabId) => Promise.resolve({ id: tabId, url: 'http://127.0.0.1/test/page.html', active: true, status: 'complete' });

/* -------------------------------------------------------------------------- */
/* Ready: badge and relay                                                     */
/* -------------------------------------------------------------------------- */

log.badge.length = 0;
await send({ type: MSG.CAPTURE_READY, tabId: 12 });
await tick();
check('CAPTURE_READY sets the badge to REC', log.badge.includes(BADGE.TEXT), JSON.stringify(log.badge));
const readyRelay = log.relays.find((m) => m.type === MSG.CAPTURE_READY && m.target === 'popup');
check('CAPTURE_READY is relayed to the popup', Boolean(readyRelay), JSON.stringify(log.relays.slice(-4)));

log.relays.length = 0;
await send({ type: MSG.CAPTURE_PROGRESS, seconds: 3.25, peakDb: -9.5 });
await tick();
const progressRelay = log.relays.find((m) => m.type === MSG.CAPTURE_PROGRESS && m.target === 'popup');
check('CAPTURE_PROGRESS is relayed with its numbers', progressRelay && progressRelay.seconds === 3.25 && progressRelay.peakDb === -9.5, JSON.stringify(progressRelay));

/* -------------------------------------------------------------------------- */
/* Done: sanitised filename, download, then the recorder document is released  */
/* -------------------------------------------------------------------------- */

log.downloads.length = 0;
log.offscreen.length = 0;
log.badge.length = 0;
// A recorder document has to exist for the worker to have anything to close afterwards.
await fake.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'test' });
log.offscreen.length = 0;
await send({
  type: MSG.CAPTURE_DONE,
  blobUrl: 'blob:chrome-extension://faketest/1',
  filename: 'suno: "Take 1"?.wav',
  bytes: 123456,
  sampleRate: 48000,
  channels: 2,
  bitDepth: 16,
});
await tick(40);

check('CAPTURE_DONE clears the badge', log.badge.includes(BADGE.CLEAR), JSON.stringify(log.badge));
const download = log.downloads[0];
check('CAPTURE_DONE asks chrome.downloads for the blob', Boolean(download) && download.url === 'blob:chrome-extension://faketest/1', JSON.stringify(download));
check('the download is a saveAs download', Boolean(download) && download.saveAs === true, JSON.stringify(download));
check('the filename was sanitised on the way through', Boolean(download) && download.filename === sanitizeWavFilename('suno: "Take 1"?.wav'), String(download && download.filename));
check('the recorder document is NOT closed while the file is still saving', !log.offscreen.some((e) => e.action === 'close'), JSON.stringify(log.offscreen));

/* The branch nobody can click through in an automated browser: the save finishes. */
fireDownload({ id: 77, state: { current: 'complete' } });
await tick(60);
check('the recorder document is closed once the download completes', log.offscreen.some((e) => e.action === 'close'), JSON.stringify(log.offscreen));
check('the recorder document is really gone afterwards', await fake.offscreen.hasDocument() === false);

/* -------------------------------------------------------------------------- */
/* Interrupted save: tell the popup, keep the recording                       */
/* -------------------------------------------------------------------------- */

log.downloads.length = 0;
log.offscreen.length = 0;
log.relays.length = 0;
await send({ type: MSG.CAPTURE_DONE, blobUrl: 'blob:chrome-extension://faketest/2', filename: 'take2.wav', bytes: 4096, sampleRate: 44100, channels: 1, bitDepth: 16 });
await tick(40);
fireDownload({ id: 77, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
await tick(60);
const retryError = log.relays.find((m) => m.type === MSG.CAPTURE_ERROR && m.target === 'popup');
check('an interrupted save is reported as a retryable error', Boolean(retryError) && retryError.retryable === true, JSON.stringify(retryError));
check('an interrupted save keeps the recorder document open', !log.offscreen.some((e) => e.action === 'close'), JSON.stringify(log.offscreen));

const retryReply = await send({ type: MSG.RETRY_DOWNLOAD });
check('RETRY_DOWNLOAD after an interrupted save answers STATE', retryReply && retryReply.type === MSG.STATE, JSON.stringify(retryReply));
check('RETRY_DOWNLOAD reports the pending filename', Boolean(retryReply && /take2\.wav/.test(String(retryReply.pendingFilename || ''))), JSON.stringify(retryReply));
await tick(40);
check('RETRY_DOWNLOAD starts the download again', log.downloads.length >= 2, `${log.downloads.length} download calls`);

/* -------------------------------------------------------------------------- */
/* Error relay                                                                */
/* -------------------------------------------------------------------------- */

log.badge.length = 0;
log.relays.length = 0;
log.offscreen.length = 0;
await send({ type: MSG.CAPTURE_ERROR, message: 'The tab stopped sharing audio.' });
await tick(40);
check('CAPTURE_ERROR clears the badge', log.badge.includes(BADGE.CLEAR), JSON.stringify(log.badge));
check('CAPTURE_ERROR is relayed to the popup', log.relays.some((m) => m.type === MSG.CAPTURE_ERROR && m.target === 'popup'), JSON.stringify(log.relays));
check('CAPTURE_ERROR releases the recorder document', log.offscreen.some((e) => e.action === 'close'), JSON.stringify(log.offscreen));

/* -------------------------------------------------------------------------- */
/* The worker must not reach for anything a service worker lacks              */
/* -------------------------------------------------------------------------- */

let source = '';
try {
  const response = await fetch('../background.js');
  source = await response.text();
} catch (err) {
  source = '';
}
check('background.js was read for a source audit', source.length > 1000, `${source.length} chars`);
// Comments talk about the APIs the worker avoids; only code counts, so strip them first.
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const forbidden = [
  ['URL.createObjectURL', /URL\.createObjectURL/],
  // `document.` must be followed by a member, so the phrase "offscreen document.*exist" in a
  // regex literal inside the worker does not count as DOM access.
  ['document.', /\bdocument\s*\.\s*[A-Za-z_$]/],
  ['window.', /\bwindow\s*\.\s*[A-Za-z_$]/],
  ['new AudioContext', /new AudioContext/],

  ['localStorage', /\blocalStorage\b/],
  ['XMLHttpRequest', /XMLHttpRequest/],
];
for (const [name, pattern] of forbidden) {
  check(`background.js does not use ${name}`, !pattern.test(code));
}
check('background.js uses chrome.downloads.download', /chrome\.downloads\.download/.test(code));

detail.textContent = JSON.stringify({ failed, results }, null, 2);
// The same "PASS n/n" / "FAIL n of m" title every other page test uses, so run-tests.ps1
// can read the result back the way it reads the rest of the suite.
const failedNames = results.filter((r) => !r.pass).map((r) => r.name).join(' | ');
document.title = failed === 0
  ? `PASS ${results.length}/${results.length}`
  : `FAIL ${failed} of ${results.length}: ${failedNames}`;
