/**
 * Shared message contract for Suno WAV Recorder.
 *
 * Three contexts talk over chrome.runtime messages:
 *   popup  -> background : START_CAPTURE, STOP_CAPTURE, RETRY_DOWNLOAD, GET_STATE
 *   background -> popup  : STARTED, STOPPING, STATE, CAPTURE_READY, CAPTURE_PROGRESS,
 *                          CAPTURE_DONE, CAPTURE_ERROR, ERROR
 *   background -> offscreen : OFFSCREEN_START, OFFSCREEN_STOP
 *   offscreen -> background : CAPTURE_READY, CAPTURE_PROGRESS, CAPTURE_DONE, CAPTURE_ERROR
 *
 * Every message carries a `target` field ('popup' | 'offscreen' | 'background') because
 * chrome.runtime.sendMessage fans out to every extension context that has a listener.
 * A receiver should act only on messages whose type it knows, and may ignore any message
 * whose `target` is not its own context. The field is advisory; `type` is the contract.
 */

export const MSG = Object.freeze({
  // popup -> background
  START_CAPTURE: 'START_CAPTURE',
  STOP_CAPTURE: 'STOP_CAPTURE',
  RETRY_DOWNLOAD: 'RETRY_DOWNLOAD',
  GET_STATE: 'GET_STATE',

  // background -> popup (replies and relays)
  STARTED: 'STARTED',
  STOPPING: 'STOPPING',
  STATE: 'STATE',
  ERROR: 'ERROR',

  // background -> offscreen
  OFFSCREEN_START: 'OFFSCREEN_START',
  OFFSCREEN_STOP: 'OFFSCREEN_STOP',

  // offscreen -> background
  CAPTURE_READY: 'CAPTURE_READY',
  CAPTURE_PROGRESS: 'CAPTURE_PROGRESS',
  CAPTURE_DONE: 'CAPTURE_DONE',
  CAPTURE_ERROR: 'CAPTURE_ERROR',
});

export const TARGET = Object.freeze({
  POPUP: 'popup',
  OFFSCREEN: 'offscreen',
  BACKGROUND: 'background',
});

/** Static HTML file that hosts the recorder (must be bundled with the extension). */
export const OFFSCREEN_PATH = 'offscreen.html';

/** Badge state shown on the toolbar action while a recording is running. */
export const BADGE = Object.freeze({
  TEXT: 'REC',
  COLOR: '#D7263D',
  TEXT_COLOR: '#FFFFFF',
  CLEAR: '',
});

/** Fallback name when the offscreen document supplies none. */
export const FALLBACK_WAV_FILENAME = 'suno-recording.wav';

/**
 * Make a filename safe for chrome.downloads.download: relative, no separators, no
 * "..", no characters Windows rejects, always ending in .wav.
 *
 * @param {string} name    the name proposed by the offscreen document
 * @param {string} [fallback]
 * @returns {string}
 */
export function sanitizeWavFilename(name, fallback = FALLBACK_WAV_FILENAME) {
  let base = typeof name === 'string' ? name : '';
  // chrome.downloads treats an absolute path or a ".." segment as an error.
  base = base.replace(/^.*[\\/]/, '');
  base = base.replace(/[\\/:*?"<>|]+/g, ' ');
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\u0000-\u001f\u007f]+/g, ' ');
  base = base.replace(/\s+/g, ' ').trim();
  base = base.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (base.length > 120) base = base.slice(0, 120).trim();
  if (!base) return fallback;
  if (!/\.wav$/i.test(base)) base = `${base}.wav`;
  return base;
}
