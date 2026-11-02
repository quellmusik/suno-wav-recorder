/**
 * Suno WAV Recorder - toolbar popup.
 *
 * The popup never touches audio. It is a view over the message contract in
 * lib/messages.js:
 *
 *   -> background   GET_STATE on open
 *                   START_CAPTURE {tabId}   on Start
 *                   STOP_CAPTURE            on Stop
 *                   RETRY_DOWNLOAD          on Retry save
 *   <- background   STARTED, STOPPING, STATE, CAPTURE_READY, CAPTURE_PROGRESS,
 *                   CAPTURE_DONE, CAPTURE_ERROR, ERROR
 *
 * Messages carry an advisory `target`; anything aimed at the offscreen recorder is
 * ignored here, because chrome.runtime.sendMessage fans out to every context that has
 * a listener.
 *
 * popup.css holds every style. This file only sets text, attributes and the --peak
 * custom property whose width is the meter.
 */

import { MSG, TARGET } from './lib/messages.js';

/** Mirrors METER_FLOOR_DB in lib/wav-encoder.js: the level that draws an empty meter. */
const METER_FLOOR_DB = -96;

/** How often the local clock advances the timer when no CAPTURE_PROGRESS arrives. */
const TICK_MS = 250;

/** CAPTURE_PROGRESS lands every 500 ms; trust it over the local clock inside this window. */
const PROGRESS_GRACE_MS = 1200;

const HINT_NEEDS_SUNO = 'Open a Suno song tab first';

const STATUS = {
  idle: 'Idle',
  blocked: HINT_NEEDS_SUNO,
  starting: 'Starting the capture',
  recording: 'Recording',
  stopping: 'Finishing the WAV',
  encoded: 'WAV ready to save',
  error: 'Stopped with an error',
};

const PRIMARY_LABEL = {
  idle: 'Start recording',
  blocked: 'Start recording',
  starting: 'Starting\u2026',
  recording: 'Stop recording',
  stopping: 'Finishing\u2026',
  encoded: 'Start recording',
  error: 'Start recording',
};

const runtime = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null;
const tabsApi = (typeof chrome !== 'undefined' && chrome.tabs) ? chrome.tabs : null;

const ui = {
  status: document.getElementById('status'),
  timer: document.getElementById('timer'),
  meter: document.getElementById('meter'),
  meterFill: document.getElementById('meter-fill'),
  meterDb: document.getElementById('meter-db'),
  readout: document.getElementById('readout'),
  primary: document.getElementById('start-stop'),
  retry: document.getElementById('retry'),
  error: document.getElementById('error'),
  hint: document.getElementById('hint'),
};

const view = {
  phase: 'idle',
  tabId: null,
  tabAllowed: false,
  startedAt: 0,
  elapsedSeconds: 0,
  peakDb: null,
  lastProgressAt: 0,
  format: null,
  pendingFilename: '',
  error: '',
  errorRetryable: false,
  hint: 'Press Start, then play the song from the beginning.',
  busy: false,
};

let tickTimer = null;

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** suno.com itself or any subdomain of it, http(s) only. */
function isSunoUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let url;
  try {
    url = new URL(raw);
  } catch (err) {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return url.hostname === 'suno.com' || url.hostname.endsWith('.suno.com');
}

function channelsLabel(channels) {
  const count = Number(channels) || 0;
  if (count === 1) return 'mono';
  if (count === 2) return 'stereo';
  if (count > 2) return `${count} channels`;
  return '';
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Send one contract message and resolve with the worker's reply. chrome.runtime
 * .lastError is turned into an ERROR reply instead of being swallowed, so a dead
 * worker or a reloaded extension shows up on the error line.
 */
function sendMessage(message) {
  return new Promise((resolve) => {
    if (!runtime) {
      resolve({ type: MSG.ERROR, message: 'Brave extension APIs are not available on this page.' });
      return;
    }
    try {
      runtime.sendMessage(message, (reply) => {
        const lastError = runtime.lastError;
        if (lastError) {
          resolve({ type: MSG.ERROR, message: lastError.message || 'The extension worker did not answer.' });
          return;
        }
        resolve(reply && typeof reply === 'object' ? reply : {});
      });
    } catch (err) {
      resolve({ type: MSG.ERROR, message: (err && err.message) ? err.message : String(err) });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function renderMeter() {
  const db = view.peakDb;
  const finite = Number.isFinite(db);
  const bounded = finite ? Math.max(METER_FLOOR_DB, Math.min(0, db)) : METER_FLOOR_DB;
  const level = clamp01((bounded - METER_FLOOR_DB) / (0 - METER_FLOOR_DB));

  ui.meterFill.style.setProperty('--peak', level.toFixed(4));

  let levelName = '';
  if (finite && db >= -1) levelName = 'hot';
  else if (finite && db >= -6) levelName = 'warm';
  if (levelName) ui.meterFill.dataset.level = levelName;
  else delete ui.meterFill.dataset.level;

  ui.meter.setAttribute('aria-valuenow', String(Math.round(bounded)));
  ui.meterDb.textContent = finite ? `${db.toFixed(1)} dBFS` : 'no signal';
}

function renderReadout() {
  const format = view.format;
  const known = format && format.sampleRate > 0 && format.channels > 0 && format.bitDepth > 0;

  if (known) {
    const parts = [
      `${format.sampleRate.toLocaleString('en-US')} Hz`,
      channelsLabel(format.channels),
      `${format.bitDepth}-bit PCM`,
    ];
    const size = formatSize(format.bytes);
    if (size) parts.push(size);
    ui.readout.textContent = parts.join(' \u00b7 ');
    ui.readout.dataset.known = 'true';
    ui.readout.title = `${format.filename || 'WAV'}: ${parts.join(', ')}`;
    return;
  }

  delete ui.readout.dataset.known;
  ui.readout.removeAttribute('title');

  if (view.phase === 'recording' || view.phase === 'stopping' || view.phase === 'starting') {
    ui.readout.textContent = 'Capturing the tab output at the device rate, no resample';
    return;
  }
  ui.readout.textContent = 'Sample rate, channels and bit depth show when the WAV is written';
}

function render() {
  document.documentElement.dataset.phase = view.phase;

  ui.status.textContent = STATUS[view.phase] || 'Idle';
  ui.timer.textContent = formatTime(view.elapsedSeconds);
  renderMeter();
  renderReadout();

  const recording = view.phase === 'recording';
  ui.primary.textContent = PRIMARY_LABEL[view.phase] || PRIMARY_LABEL.idle;
  ui.primary.dataset.mode = recording ? 'stop' : 'start';
  // Stop stays available even when the popup was reopened on a different tab: the stop
  // is for the running session, not for the tab in front of the user.
  ui.primary.disabled = view.busy || view.phase === 'stopping' || (!view.tabAllowed && !recording);

  ui.hint.textContent = view.hint;
  // While an error is showing it owns the bottom of the 240 px popup, so the hint steps
  // aside and the reason has room to be read in full.
  ui.hint.hidden = Boolean(view.error);
  ui.error.hidden = !view.error;
  ui.error.textContent = view.error;
  // The line is clamped to two rows so the 240 px popup never scrolls; the full text stays
  // reachable on hover, and role="alert" already announced all of it.
  if (view.error) ui.error.title = view.error;
  else ui.error.removeAttribute('title');
  ui.retry.hidden = !view.errorRetryable;
}

/* -------------------------------------------------------------------------- */
/* Timer                                                                      */
/* -------------------------------------------------------------------------- */

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    if (view.phase !== 'recording') return;
    const now = Date.now();
    // CAPTURE_PROGRESS carries the recorder's own clock; while it is arriving, do not
    // fight it with a local estimate.
    if (view.lastProgressAt && now - view.lastProgressAt < PROGRESS_GRACE_MS) return;
    const seconds = view.startedAt
      ? Math.max(0, Math.round((now - view.startedAt) / 1000))
      : view.elapsedSeconds;
    if (seconds === view.elapsedSeconds) return;
    view.elapsedSeconds = seconds;
    ui.timer.textContent = formatTime(seconds);
  }, TICK_MS);
}

/* -------------------------------------------------------------------------- */
/* State changes                                                              */
/* -------------------------------------------------------------------------- */

function beginRecording() {
  if (view.phase !== 'recording') {
    view.startedAt = Date.now();
    view.elapsedSeconds = 0;
    view.lastProgressAt = 0;
  }
  view.phase = 'recording';
  view.busy = false;
  view.error = '';
  view.errorRetryable = false;
  startTick();
  render();
}

function markStopping() {
  view.busy = false;
  view.phase = 'stopping';
  view.peakDb = null;
  stopTick();
  render();
}

function onProgress(message) {
  // A null reading means "no measurement", not zero: Number(null) is 0, which would draw
  // the meter at full scale and the clock at 0:00.
  const seconds = (message.seconds === null || message.seconds === undefined || message.seconds === '')
    ? NaN
    : Number(message.seconds);
  if (Number.isFinite(seconds) && seconds >= 0) {
    view.elapsedSeconds = Math.floor(seconds);
    ui.timer.textContent = formatTime(view.elapsedSeconds);
  }
  view.lastProgressAt = Date.now();
  const db = (message.peakDb === null || message.peakDb === undefined || message.peakDb === '')
    ? NaN
    : Number(message.peakDb);
  view.peakDb = Number.isFinite(db) ? db : null;
  renderMeter();
}

function onDone(message) {
  stopTick();
  view.phase = 'encoded';
  view.peakDb = null;
  view.error = '';
  view.errorRetryable = false;
  view.busy = false;
  view.format = {
    sampleRate: Number(message.sampleRate) || 0,
    channels: Number(message.channels) || 0,
    bitDepth: Number(message.bitDepth) || 0,
    bytes: Number(message.bytes) || 0,
    filename: typeof message.filename === 'string' ? message.filename : '',
  };
  render();
}

function onError(message) {
  stopTick();
  view.phase = 'error';
  view.peakDb = null;
  view.busy = false;
  view.error = (message && typeof message.message === 'string' && message.message.trim())
    ? message.message.trim()
    : 'The recording stopped with an error.';
  view.errorRetryable = Boolean(message && message.retryable);
  if (message && typeof message.filename === 'string' && message.filename) {
    view.pendingFilename = message.filename;
  }
  render();
}

/**
 * Adopt the worker's view of the world (GET_STATE, or a STATE reply). This is what makes
 * a popup opened mid-recording show the running session instead of a fresh Start button.
 */
function applyState(state) {
  if (!state || typeof state !== 'object') return;

  if (state.capturing) {
    view.phase = 'recording';
    view.startedAt = Number(state.startedAt) || Date.now();
    view.elapsedSeconds = Math.max(0, Math.round(Number(state.elapsedSeconds) || 0));
    view.error = '';
    view.errorRetryable = false;
    view.lastProgressAt = 0;
    startTick();
    return;
  }

  stopTick();
  view.peakDb = null;

  if (state.stopping) {
    view.phase = 'stopping';
    return;
  }

  if (state.canRetryDownload) {
    view.pendingFilename = typeof state.pendingFilename === 'string' ? state.pendingFilename : '';
    view.phase = 'error';
    view.errorRetryable = true;
    view.error = view.pendingFilename
      ? `The recording ${view.pendingFilename} is still in memory and has not been saved.`
      : 'The last recording is still in memory and has not been saved.';
    return;
  }

  view.phase = view.tabAllowed ? 'idle' : 'blocked';
  view.error = '';
  view.errorRetryable = false;
  if (!view.tabAllowed) view.hint = HINT_NEEDS_SUNO;
}

/* -------------------------------------------------------------------------- */
/* Messages from the worker                                                   */
/* -------------------------------------------------------------------------- */

function onRuntimeMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (message.target && message.target !== TARGET.POPUP && message.target !== TARGET.BACKGROUND) return;

  switch (message.type) {
    case MSG.STARTED:
    case MSG.CAPTURE_READY:
      beginRecording();
      break;
    case MSG.STOPPING:
      markStopping();
      break;
    case MSG.CAPTURE_PROGRESS:
      onProgress(message);
      break;
    case MSG.CAPTURE_DONE:
      onDone(message);
      break;
    case MSG.CAPTURE_ERROR:
    case MSG.ERROR:
      onError(message);
      break;
    case MSG.STATE:
      applyState(message);
      render();
      break;
    default:
      break;
  }
}

/** Turn whatever the worker answered into a view state. */
function applyReply(reply, action) {
  const type = reply && reply.type;

  if (type === MSG.STARTED || type === MSG.CAPTURE_READY) {
    beginRecording();
    return;
  }
  if (type === MSG.STOPPING) {
    markStopping();
    return;
  }
  if (type === MSG.CAPTURE_DONE) {
    onDone(reply);
    return;
  }
  if (type === MSG.STATE) {
    view.busy = false;
    applyState(reply);
    render();
    return;
  }
  if (type === MSG.CAPTURE_ERROR || type === MSG.ERROR) {
    onError(reply);
    return;
  }

  view.busy = false;
  if (action === 'start') {
    onError({ type: MSG.CAPTURE_ERROR, message: 'The recorder did not answer. Reload the extension at brave://extensions and try again.' });
    return;
  }
  view.phase = view.tabAllowed ? 'idle' : 'blocked';
  if (!view.tabAllowed) view.hint = HINT_NEEDS_SUNO;
  render();
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

async function onPrimaryClick() {
  if (view.busy) return;

  if (view.phase === 'recording') {
    view.busy = true;
    render();
    const reply = await sendMessage({ type: MSG.STOP_CAPTURE });
    view.busy = false;
    applyReply(reply, 'stop');
    return;
  }

  if (!view.tabAllowed || !Number.isInteger(view.tabId)) {
    view.hint = HINT_NEEDS_SUNO;
    view.phase = 'blocked';
    render();
    return;
  }

  view.busy = true;
  view.phase = 'starting';
  view.error = '';
  view.errorRetryable = false;
  view.peakDb = null;
  render();

  const reply = await sendMessage({ type: MSG.START_CAPTURE, tabId: view.tabId });
  view.busy = false;
  applyReply(reply, 'start');
}

async function onRetryClick() {
  if (view.busy) return;
  view.busy = true;
  view.error = 'Trying the save again\u2026';
  view.errorRetryable = false;
  render();

  const reply = await sendMessage({ type: MSG.RETRY_DOWNLOAD });
  view.busy = false;

  if (reply && reply.type === MSG.ERROR) {
    onError(reply);
    return;
  }
  if (reply && reply.type === MSG.CAPTURE_ERROR) {
    onError(reply);
    return;
  }
  view.error = 'Brave is writing the WAV to your Downloads folder.';
  view.errorRetryable = false;
  render();
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

/** Which tab is in front, and is it a Suno tab? */
async function checkActiveTab() {
  view.tabId = null;
  view.tabAllowed = false;

  if (!tabsApi || typeof tabsApi.query !== 'function') return;

  try {
    const found = await tabsApi.query({ active: true, currentWindow: true });
    const tab = Array.isArray(found) ? found[0] : null;
    if (tab && Number.isInteger(tab.id)) {
      view.tabId = tab.id;
      view.tabAllowed = isSunoUrl(tab.url || tab.pendingUrl || '');
    }
  } catch (err) {
    view.tabId = null;
    view.tabAllowed = false;
  }

  if (!view.tabAllowed) view.hint = HINT_NEEDS_SUNO;
}

async function init() {
  render();

  if (!runtime) {
    onError({ type: MSG.ERROR, message: 'Brave extension APIs are not available on this page. Open the popup from the toolbar icon.' });
    return;
  }

  runtime.onMessage.addListener(onRuntimeMessage);
  window.addEventListener('pagehide', stopTick, { once: true });

  await checkActiveTab();

  const reply = await sendMessage({ type: MSG.GET_STATE });
  if (reply && reply.type === MSG.STATE) {
    applyState(reply);
  } else if (!view.tabAllowed) {
    view.phase = 'blocked';
  }
  render();
}

ui.primary.addEventListener('click', onPrimaryClick);
ui.retry.addEventListener('click', onRetryClick);

void init();
