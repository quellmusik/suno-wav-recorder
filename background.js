/**
 * Suno WAV Recorder - background service worker (Manifest V3, loaded as a module).
 *
 * Owns the capture lifecycle:
 *   1. popup asks to start -> this worker takes a stream id for the tab
 *      (chrome.tabCapture.getMediaStreamId) and hands it to the offscreen document,
 *      which is the only context with a DOM and therefore the only one that can call
 *      getUserMedia + encode a WAV.
 *   2. the offscreen document reports READY / PROGRESS / DONE / ERROR.
 *   3. on DONE this worker asks Brave to save the blob URL the offscreen document made
 *      and closes the offscreen document once the file is actually written.
 *
 * Nothing here touches the DOM, URL.createObjectURL or any API a service worker lacks:
 * a worker has no URL.createObjectURL, no AudioContext and no <a download>.
 *
 * Message contract (see lib/messages.js for the constants):
 *   popup -> here       START_CAPTURE {tabId}  -> STARTED | ERROR
 *                       STOP_CAPTURE           -> STOPPING | ERROR
 *                       GET_STATE              -> STATE
 *                       RETRY_DOWNLOAD         -> STATE | ERROR
 *   here -> offscreen   OFFSCREEN_START {streamId, tabId}
 *                       OFFSCREEN_STOP
 *   offscreen -> here   CAPTURE_READY {tabId?}
 *                       CAPTURE_PROGRESS {seconds, peakDb}
 *                       CAPTURE_DONE {blobUrl, filename, bytes, sampleRate, channels, bitDepth}
 *                       CAPTURE_ERROR {message}
 */

import {
  MSG,
  TARGET,
  OFFSCREEN_PATH,
  BADGE,
  sanitizeWavFilename,
} from './lib/messages.js';

const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

/** Give up watching a download after this long; the Save dialog may sit open for minutes. */
const DOWNLOAD_WATCH_MS = 10 * 60 * 1000;

/** The offscreen document attaches its listener during page load; a send can land first. */
const SEND_ATTEMPTS = 8;
const SEND_RETRY_MS = 150;

/** In-memory only: a worker restart re-hydrates what matters from chrome.storage.session. */
const state = {
  capturing: false,
  stopping: false,
  tabId: null,
  startedAt: null,
  /** { blobUrl, filename, downloadId } for a finished recording that is not on disk yet. */
  pendingDownload: null,
};

/** Set while chrome.offscreen.createDocument is in flight, so two callers cannot race. */
let creatingOffscreen = null;

const KNOWN_TYPES = new Set(Object.values(MSG));
const INTERNAL_SCHEME = /^(chrome|brave|edge|about|devtools|chrome-extension|brave-extension|view-source|data):/i;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Turn any thrown thing into a readable string. */
function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Messages are handled one at a time, in arrival order. The recorder can fire READY and
 * DONE back to back; without this, DONE's "clear the badge" can finish before READY's
 * "set the badge" and leave a REC badge on a finished session.
 */
let messageQueue = Promise.resolve();
function enqueue(task) {
  const run = messageQueue.then(task, task);
  messageQueue = run.then(() => undefined, () => undefined);
  return run;
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Call a chrome.* API that may be promise-based (Chrome 116+) or callback-based, and
 * resolve/reject exactly once. A synchronous throw (bad arguments, missing permission)
 * becomes a rejection instead of escaping into the message listener.
 */
function callChrome(fn, thisArg, args = []) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(errText(err) || 'Unknown chrome API error'));
    };
    const callback = (value) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) fail(new Error(lastError.message || 'chrome API error'));
      else ok(value);
    };
    let returned;
    try {
      returned = fn.apply(thisArg, [...args, callback]);
    } catch (err) {
      fail(err);
      return;
    }
    if (returned && typeof returned.then === 'function') {
      returned.then(ok, fail);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Toolbar badge                                                              */
/* -------------------------------------------------------------------------- */

async function setRecordingBadge() {
  try {
    await callChrome(chrome.action.setBadgeBackgroundColor, chrome.action, [{ color: BADGE.COLOR }]);
    if (typeof chrome.action.setBadgeTextColor === 'function') {
      await callChrome(chrome.action.setBadgeTextColor, chrome.action, [{ color: BADGE.TEXT_COLOR }]);
    }
    await callChrome(chrome.action.setBadgeText, chrome.action, [{ text: BADGE.TEXT }]);
  } catch (err) {
    console.warn('[suno-wav] could not set the badge:', errText(err));
  }
}

async function clearRecordingBadge() {
  try {
    await callChrome(chrome.action.setBadgeText, chrome.action, [{ text: BADGE.CLEAR }]);
  } catch (err) {
    console.warn('[suno-wav] could not clear the badge:', errText(err));
  }
}

/* -------------------------------------------------------------------------- */
/* Offscreen document lifecycle                                               */
/* -------------------------------------------------------------------------- */

/**
 * Is a recorder document already open?
 * chrome.offscreen.hasDocument() is Chrome 150+; chrome.runtime.getContexts() is 116+.
 * The extension declares minimum_chrome_version 116, so both are tried and a false
 * answer is not fatal: createDocument's "single offscreen document" error is swallowed.
 */
async function hasOffscreenDocument() {
  if (!chrome.offscreen) return false;
  if (typeof chrome.offscreen.hasDocument === 'function') {
    try {
      return Boolean(await chrome.offscreen.hasDocument());
    } catch (err) {
      console.warn('[suno-wav] hasDocument failed:', errText(err));
    }
  }
  if (chrome.runtime && typeof chrome.runtime.getContexts === 'function') {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [OFFSCREEN_URL],
      });
      return Array.isArray(contexts) && contexts.length > 0;
    } catch (err) {
      console.warn('[suno-wav] getContexts failed:', errText(err));
    }
  }
  return false;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('Brave did not expose the offscreen API. Check that the extension has the "offscreen" permission.');
  }
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }
  creatingOffscreen = (async () => {
    try {
      await callChrome(chrome.offscreen.createDocument, chrome.offscreen, [{
        url: OFFSCREEN_PATH,
        // USER_MEDIA: getUserMedia on the tab's stream. BLOBS: the WAV is a Blob that
        // the offscreen document hands to chrome.downloads through a blob: URL.
        reasons: ['USER_MEDIA', 'BLOBS'],
        justification: 'Record the audio of a Suno tab and encode it to a WAV file that the user saves.',
      }]);
    } catch (err) {
      const text = errText(err);
      if (!/single offscreen document|already (open|created|exists)|offscreen document.*exist/i.test(text)) {
        throw err;
      }
    }
  })();
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function closeOffscreenDocument() {
  try {
    if (!chrome.offscreen || typeof chrome.offscreen.closeDocument !== 'function') return;
    if (!(await hasOffscreenDocument())) return;
    await callChrome(chrome.offscreen.closeDocument, chrome.offscreen, []);
  } catch (err) {
    console.warn('[suno-wav] could not close the recorder document:', errText(err));
  }
}

/**
 * Send a command to the recorder document, creating it if needed. The retry loop covers
 * the moment right after creation when offscreen.js has not attached its listener yet.
 */
async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  const payload = { ...message, target: TARGET.OFFSCREEN };
  let lastError = null;
  for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage(payload);
    } catch (err) {
      lastError = err;
      await delay(SEND_RETRY_MS);
    }
  }
  throw lastError || new Error('The recorder page did not answer.');
}

/** Relay to the popup. A closed popup rejects the send; that is normal, not an error. */
async function relayToPopup(message) {
  try {
    await chrome.runtime.sendMessage({ ...message, target: TARGET.POPUP });
  } catch (err) {
    const text = errText(err);
    if (!/receiving end does not exist|message port closed|The message port/i.test(text)) {
      console.warn('[suno-wav] could not reach the popup:', text);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* tabCapture                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * chrome.tabCapture.getMediaStreamId({ targetTabId }).
 * Since Chrome 116 the id can be used by getUserMedia in another extension context
 * (the offscreen document); the id is single-use and expires within seconds.
 */
function getMediaStreamId(tabId) {
  return new Promise((resolve, reject) => {
    if (!chrome.tabCapture || typeof chrome.tabCapture.getMediaStreamId !== 'function') {
      reject(new Error('Brave did not expose the tabCapture API. Check that the extension has the "tabCapture" permission.'));
      return;
    }
    let settled = false;
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(errText(err)));
    };
    let returned;
    try {
      returned = chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) fail(new Error(lastError.message || 'tabCapture failed'));
        else ok(streamId);
      });
    } catch (err) {
      fail(err);
      return;
    }
    if (returned && typeof returned.then === 'function') {
      returned.then(ok, fail);
    }
  });
}

/**
 * A readable reason the tab cannot be recorded, or null when it looks fine.
 * tab.url is only present when the extension can see it; when it is absent (no "tabs"
 * permission), tabCapture's own error is mapped instead, in explainCaptureError().
 */
async function tabBlockReason(tabId) {
  let tab;
  try {
    tab = await callChrome(chrome.tabs.get, chrome.tabs, [tabId]);
  } catch (err) {
    return `That tab is no longer open (${errText(err)}). Reopen the Suno song and press Record again.`;
  }
  if (!tab) {
    return 'That tab is no longer open. Reopen the Suno song and press Record again.';
  }
  const url = tab.url || tab.pendingUrl || '';
  if (url && INTERNAL_SCHEME.test(url)) {
    return `Brave cannot record its own pages (${url.split('/')[0]}//...). Open the Suno song in a normal tab and press Record there.`;
  }
  if (typeof tab.discarded === 'boolean' && tab.discarded) {
    return 'That tab is asleep (discarded by Brave). Click it once so it wakes up, then press Record.';
  }
  return null;
}

/** Map chrome's terse tabCapture errors onto something a person can act on. */
function explainCaptureError(err, phase = 'start') {
  const raw = errText(err).trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return phase === 'stop'
      ? 'The recorder did not answer the stop request.'
      : 'Brave could not start the recording and gave no reason.';
  }
  if (/cannot capture|not allowed to (be )?captur|chrome:\/\/|brave:\/\/|edge:\/\/|chrome-extension:\/\/|extension pages/.test(lower)) {
    return `Brave cannot record this page (${raw}). Internal pages such as brave:// and the extensions gallery are off limits; open the Suno song in a normal tab.`;
  }
  if (/has not been invoked|not invoked|activeTab|user gesture|gesture required/.test(lower)) {
    return 'Brave only allows tab capture right after you click the extension. Click the Suno WAV Recorder icon on the Suno tab and press Record again.';
  }
  if (/no tab with id|tab was closed|invalid tab|no tab |tab not found/.test(lower)) {
    return 'That tab closed before the recording could start. Reopen Suno and press Record again.';
  }
  if (/active stream|already captur|capturing|stream.*(in use|already)/.test(lower)) {
    return 'Something is already capturing this tab. Stop the other recording (or the other extension) and press Record again.';
  }
  if (/receiving end does not exist|message port closed|port closed/.test(lower)) {
    return 'The recorder page stopped answering. Reload the extension at brave://extensions and try again.';
  }
  if (/permission|denied|blocked/.test(lower)) {
    return `Brave blocked tab capture for this page (${raw}). Check the extension's Site access at brave://extensions.`;
  }
  return phase === 'stop'
    ? `The recorder did not stop cleanly: ${raw}`
    : `Brave could not start the recording: ${raw}`;
}

/* -------------------------------------------------------------------------- */
/* Persisted state (survives the worker being suspended)                      */
/* -------------------------------------------------------------------------- */

async function persistState() {
  if (!chrome.storage || !chrome.storage.session) return;
  try {
    await chrome.storage.session.set({
      captureState: {
        capturing: state.capturing,
        tabId: state.tabId,
        startedAt: state.startedAt,
      },
    });
  } catch (err) {
    console.warn('[suno-wav] could not persist state:', errText(err));
  }
}

async function hydrateState() {
  if (!chrome.storage || !chrome.storage.session) return;
  try {
    const stored = await chrome.storage.session.get('captureState');
    const saved = stored && stored.captureState;
    if (saved && saved.capturing) {
      state.capturing = true;
      state.tabId = Number.isInteger(saved.tabId) ? saved.tabId : null;
      state.startedAt = toFiniteNumber(saved.startedAt, 0) || null;
      await setRecordingBadge();
    } else {
      await clearRecordingBadge();
    }
  } catch (err) {
    console.warn('[suno-wav] could not read state:', errText(err));
  }
}

function publicState() {
  return {
    capturing: state.capturing,
    stopping: state.stopping,
    tabId: state.tabId,
    startedAt: state.startedAt,
    elapsedSeconds: state.startedAt ? Math.max(0, Math.round((Date.now() - state.startedAt) / 1000)) : 0,
    canRetryDownload: Boolean(state.pendingDownload && state.pendingDownload.blobUrl),
    pendingFilename: state.pendingDownload ? state.pendingDownload.filename : null,
  };
}

/* -------------------------------------------------------------------------- */
/* Saving the WAV                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Watch a download until it lands. Resolves {state: 'complete'|'interrupted'|'timeout', error}.
 * The offscreen document must stay open until then: the WAV lives in its blob: URL and
 * closing the document drops it, which would truncate or kill the file.
 */
function waitForDownload(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        chrome.downloads.onChanged.removeListener(onChanged);
      } catch (err) {
        /* listener already gone */
      }
      resolve(result);
    };

    const onChanged = (delta) => {
      if (!delta || delta.id !== downloadId || !delta.state) return;
      const current = delta.state.current;
      if (current === 'complete' || current === 'interrupted') {
        finish({ state: current, error: delta.error ? delta.error.current : null });
      }
    };

    try {
      chrome.downloads.onChanged.addListener(onChanged);
    } catch (err) {
      finish({ state: 'timeout', error: errText(err) });
      return;
    }

    // A small file can finish before the listener is attached; check once.
    try {
      chrome.downloads.search({ id: downloadId }).then((items) => {
        const item = Array.isArray(items) ? items[0] : null;
        if (!item) return;
        if (item.state === 'complete' || item.state === 'interrupted') {
          finish({ state: item.state, error: item.error || null });
        }
      }).catch(() => { /* search is only a probe */ });
    } catch (err) {
      /* search is only a probe */
    }

    timer = setTimeout(() => finish({ state: 'timeout' }), timeoutMs);
  });
}

/**
 * Ask Brave to save the blob and, only once the file is written, release the recorder.
 * A failure keeps the offscreen document (and therefore the recording) alive so the
 * popup's "Retry save" can try again through RETRY_DOWNLOAD.
 */
async function saveBlob(blobUrl, filename) {
  let downloadId = null;
  try {
    downloadId = await callChrome(chrome.downloads.download, chrome.downloads, [{
      url: blobUrl,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    }]);
  } catch (err) {
    state.pendingDownload = { blobUrl, filename, downloadId: null };
    await relayToPopup({
      type: MSG.CAPTURE_ERROR,
      message: `Brave could not save the WAV file (${errText(err)}). The recording is still in memory; press Retry save to write it.`,
      retryable: true,
      filename,
    });
    return;
  }

  state.pendingDownload = { blobUrl, filename, downloadId };
  const outcome = await waitForDownload(downloadId, DOWNLOAD_WATCH_MS);

  if (outcome.state === 'complete') {
    state.pendingDownload = null;
    await closeOffscreenDocument();
    return;
  }

  if (outcome.state === 'interrupted') {
    state.pendingDownload = { blobUrl, filename, downloadId: null };
    await relayToPopup({
      type: MSG.CAPTURE_ERROR,
      message: `The save was cancelled or interrupted (${outcome.error || 'unknown reason'}). The recording is still in memory; press Retry save to write the WAV.`,
      retryable: true,
      filename,
    });
    return;
  }

  // 'timeout': the Save dialog is probably still open. Leave the document alone so the
  // blob URL stays valid; a later START or a Retry save reuses it.
  console.warn('[suno-wav] download still pending after the watch window; keeping the recorder document open.');
}

async function retryDownload() {
  const pending = state.pendingDownload;
  if (!pending || !pending.blobUrl) {
    return { type: MSG.ERROR, message: 'There is no finished recording waiting to be saved.' };
  }
  try {
    await ensureOffscreenDocument();
  } catch (err) {
    return { type: MSG.ERROR, message: explainCaptureError(err) };
  }
  void saveBlob(pending.blobUrl, pending.filename);
  return { type: MSG.STATE, ...publicState() };
}

/* -------------------------------------------------------------------------- */
/* Capture lifecycle                                                          */
/* -------------------------------------------------------------------------- */

async function startCapture(message) {
  if (state.capturing) {
    return { type: MSG.ERROR, message: 'A recording is already running. Stop it before starting another.' };
  }

  let tabId = Number(message && message.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    try {
      const tabs = await callChrome(chrome.tabs.query, chrome.tabs, [{ active: true, lastFocusedWindow: true }]);
      const active = Array.isArray(tabs) ? tabs[0] : null;
      tabId = active && Number.isInteger(active.id) ? active.id : null;
    } catch (err) {
      tabId = null;
    }
  }
  if (!Number.isInteger(tabId)) {
    return { type: MSG.ERROR, message: 'No tab was picked to record. Open the Suno song, then press Record.' };
  }

  const blocked = await tabBlockReason(tabId);
  if (blocked) return { type: MSG.ERROR, message: blocked };

  let streamId;
  try {
    streamId = await getMediaStreamId(tabId);
  } catch (err) {
    return { type: MSG.ERROR, message: explainCaptureError(err, 'start') };
  }
  if (!streamId || typeof streamId !== 'string') {
    return {
      type: MSG.ERROR,
      message: 'Brave did not return a stream for this tab. Make sure something is playing in the Suno tab and press Record again.',
    };
  }

  try {
    await sendToOffscreen({ type: MSG.OFFSCREEN_START, streamId, tabId });
  } catch (err) {
    return { type: MSG.ERROR, message: explainCaptureError(err, 'start') };
  }

  state.capturing = true;
  state.stopping = false;
  state.tabId = tabId;
  state.startedAt = Date.now();
  await persistState();
  await setRecordingBadge();
  return { type: MSG.STARTED };
}

async function stopCapture() {
  let open = false;
  try {
    open = await hasOffscreenDocument();
  } catch (err) {
    open = false;
  }
  if (!open && !state.capturing && !state.stopping) {
    return { type: MSG.ERROR, message: 'There is no recording in progress.' };
  }

  state.stopping = true;
  try {
    await sendToOffscreen({ type: MSG.OFFSCREEN_STOP });
  } catch (err) {
    state.stopping = false;
    state.capturing = false;
    await persistState();
    await clearRecordingBadge();
    return { type: MSG.ERROR, message: explainCaptureError(err, 'stop') };
  }
  await persistState();
  return { type: MSG.STOPPING };
}

/** CAPTURE_DONE: the WAV is encoded and waiting to be saved. */
async function finishCapture(message) {
  await clearRecordingBadge();
  state.capturing = false;
  state.stopping = false;
  state.tabId = null;
  state.startedAt = null;
  await persistState();

  const blobUrl = typeof message.blobUrl === 'string' ? message.blobUrl : '';
  const filename = sanitizeWavFilename(message.filename);

  // Metadata for the popup's "saved" line. The blob URL is deliberately not relayed:
  // it is only meaningful inside the context that created it.
  await relayToPopup({
    type: MSG.CAPTURE_DONE,
    filename,
    bytes: toFiniteNumber(message.bytes, 0),
    sampleRate: toFiniteNumber(message.sampleRate, 0),
    channels: toFiniteNumber(message.channels, 0),
    bitDepth: toFiniteNumber(message.bitDepth, 0),
  });

  if (!blobUrl) {
    await closeOffscreenDocument();
    await relayToPopup({
      type: MSG.CAPTURE_ERROR,
      message: 'The recorder finished but handed over no audio, so there is nothing to save.',
    });
    return;
  }

  // Not awaited: the save can sit on the Save dialog for minutes, and the message queue
  // must stay free for STOP / GET_STATE while it does.
  void saveBlob(blobUrl, filename);
}

/** CAPTURE_ERROR from the recorder. */
async function failCapture(message) {
  await clearRecordingBadge();
  state.capturing = false;
  state.stopping = false;
  state.tabId = null;
  state.startedAt = null;
  await persistState();

  const text = typeof message.message === 'string' && message.message.trim()
    ? message.message.trim()
    : 'The recorder stopped with an error and gave no reason.';
  await relayToPopup({ type: MSG.CAPTURE_ERROR, message: text });
  await closeOffscreenDocument();
}

/* -------------------------------------------------------------------------- */
/* Message routing                                                            */
/* -------------------------------------------------------------------------- */

async function handleMessage(message) {
  switch (message.type) {
    case MSG.START_CAPTURE:
      return startCapture(message);

    case MSG.STOP_CAPTURE:
      return stopCapture();

    case MSG.GET_STATE:
      return { type: MSG.STATE, ...publicState() };

    case MSG.RETRY_DOWNLOAD:
      return retryDownload();

    case MSG.CAPTURE_READY: {
      state.capturing = true;
      state.stopping = false;
      if (Number.isInteger(message.tabId)) state.tabId = message.tabId;
      if (!state.startedAt) state.startedAt = Date.now();
      await persistState();
      await setRecordingBadge();
      await relayToPopup({ type: MSG.CAPTURE_READY, tabId: state.tabId });
      return undefined;
    }

    case MSG.CAPTURE_PROGRESS: {
      const peakDb = Number(message.peakDb);
      await relayToPopup({
        type: MSG.CAPTURE_PROGRESS,
        seconds: toFiniteNumber(message.seconds, 0),
        peakDb: Number.isFinite(peakDb) ? peakDb : null,
      });
      return undefined;
    }

    case MSG.CAPTURE_DONE:
      await finishCapture(message);
      return undefined;

    case MSG.CAPTURE_ERROR:
      await failCapture(message);
      return undefined;

    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  if (!KNOWN_TYPES.has(message.type)) return false;
  // Our own commands to the recorder pass through here in other contexts; skip them.
  if (message.target === TARGET.OFFSCREEN) return false;

  enqueue(() => handleMessage(message, sender))
    .then((reply) => sendResponse(reply === undefined ? {} : reply))
    .catch((err) => {
      console.error('[suno-wav] message failed:', message.type, err);
      try {
        sendResponse({ type: MSG.ERROR, message: explainCaptureError(err, message.type === MSG.STOP_CAPTURE ? 'stop' : 'start') });
      } catch (sendErr) {
        /* the channel is already gone */
      }
    });
  // Keep the channel open for the async reply.
  return true;
});

/* If the recorded tab closes, end the take cleanly rather than leaving a dead badge. */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!state.capturing || state.tabId !== tabId) return;
  state.stopping = true;
  void persistState();
  void (async () => {
    try {
      // Only poke a recorder that is actually running; never create one just to stop it.
      if (!(await hasOffscreenDocument())) return;
      await sendToOffscreen({ type: MSG.OFFSCREEN_STOP });
    } catch (err) {
      console.warn('[suno-wav] tab closed and the recorder did not take the stop:', errText(err));
    }
  })();
});

chrome.runtime.onInstalled.addListener(() => {
  state.capturing = false;
  state.stopping = false;
  state.tabId = null;
  state.startedAt = null;
  state.pendingDownload = null;
  void clearRecordingBadge();
  void persistState();
});

chrome.runtime.onStartup.addListener(() => {
  void hydrateState();
});

void hydrateState();
