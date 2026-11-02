/**
 * Suno WAV Recorder - the in-page record pill.
 *
 * Runs as a classic content script (manifest.json loads it with no "type"), so it cannot
 * import lib/messages.js; the strings below mirror that contract exactly:
 *
 *   send   START_CAPTURE, STOP_CAPTURE
 *   hear   STARTED, STOPPING, CAPTURE_READY, CAPTURE_DONE, CAPTURE_ERROR
 *
 * The pill stays hidden until the page actually has a player, sits out of the layout flow
 * (position: fixed, appended to <html>) and removes itself on unload. It is not the way
 * the capture works: the popup owns Start/Stop too, and both speak the same messages.
 */

(function () {
  'use strict';

  // Frames exist all over a Suno page. Only the top frame draws the pill, and only once.
  if (window.top !== window.self) return;
  if (!/(^|\.)suno\.com$/i.test(location.hostname)) return;
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
  if (!document.documentElement) return;

  const PILL_ID = 'suno-wav-pill';
  if (document.getElementById(PILL_ID)) return;

  const MSG = Object.freeze({
    START_CAPTURE: 'START_CAPTURE',
    STOP_CAPTURE: 'STOP_CAPTURE',
    STARTED: 'STARTED',
    STOPPING: 'STOPPING',
    CAPTURE_READY: 'CAPTURE_READY',
    CAPTURE_DONE: 'CAPTURE_DONE',
    CAPTURE_ERROR: 'CAPTURE_ERROR',
  });

  const TARGET_POPUP = 'popup';
  const TARGET_BACKGROUND = 'background';

  /** A Suno player is on the page when one of these exists. */
  const PLAYER_SELECTORS = [
    'audio',
    '[data-testid*="player" i]',
    '[data-testid*="Player"]',
    '[class*="player" i]',
    '[aria-label*="player" i]',
    '[class*="PlayBar" i]',
  ];

  /** The page mutates constantly; re-check for a player at most this often. */
  const RECHECK_MS = 400;

  /** How long "Saved" stays on the pill before it returns to "Record this song". */
  const SAVED_MS = 4000;

  const LABELS = {
    idle: 'Record this song',
    starting: 'Starting\u2026',
    recording: 'Stop recording',
    stopping: 'Finishing\u2026',
    encoded: 'Saved',
    error: 'Try again',
  };

  const ui = { host: null, button: null, dot: null, label: null, time: null, live: null };

  let state = 'idle';
  let busy = false;
  let startedAt = 0;
  let elapsedSeconds = 0;
  let tickTimer = null;
  let savedTimer = null;
  let recheckTimer = null;
  let observer = null;
  let tornDown = false;

  /* ------------------------------------------------------------------------ */
  /* Messages                                                                 */
  /* ------------------------------------------------------------------------ */

  function send(type) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type }, (reply) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ type: MSG.CAPTURE_ERROR, message: lastError.message || 'The extension did not answer.' });
            return;
          }
          resolve(reply && typeof reply === 'object' ? reply : {});
        });
      } catch (err) {
        resolve({
          type: MSG.CAPTURE_ERROR,
          message: 'The extension was reloaded. Refresh this Suno tab to reconnect.',
        });
      }
    });
  }

  /* ------------------------------------------------------------------------ */
  /* State                                                                    */
  /* ------------------------------------------------------------------------ */

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function announce(text) {
    if (ui.live) ui.live.textContent = text;
  }

  function setState(next, message) {
    if (state === 'stopping' && next === 'idle') return;
    state = next;

    if (ui.host) {
      ui.host.dataset.state = next;
      ui.button.disabled = busy || next === 'stopping' || next === 'starting';
      ui.label.textContent = LABELS[next] || LABELS.idle;
      ui.time.hidden = next !== 'recording';
      if (next !== 'recording') ui.time.textContent = '0:00';
      ui.button.title = (next === 'error' && message) ? message : '';
    }

    if (next === 'recording') {
      startTick();
      announce('Recording. Press Stop recording to finish the WAV.');
    } else {
      stopTick();
    }

    if (next === 'encoded') {
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => {
        savedTimer = null;
        if (state === 'encoded') setState('idle');
      }, SAVED_MS);
      announce('The WAV was saved.');
    }

    if (next === 'error' && message) announce(message);
  }

  function startTick() {
    if (tickTimer) return;
    tickTimer = setInterval(() => {
      if (state !== 'recording') return;
      elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      if (ui.time) ui.time.textContent = formatTime(elapsedSeconds);
    }, 500);
  }

  function stopTick() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* DOM                                                                      */
  /* ------------------------------------------------------------------------ */

  function build() {
    const host = document.createElement('div');
    host.id = PILL_ID;
    host.hidden = true;
    host.dataset.state = 'idle';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Suno WAV Recorder');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suno-wav-pill__button';
    button.title = '';

    const dot = document.createElement('span');
    dot.className = 'suno-wav-pill__dot';
    dot.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'suno-wav-pill__label';
    label.textContent = LABELS.idle;

    const time = document.createElement('span');
    time.className = 'suno-wav-pill__time';
    time.hidden = true;
    time.textContent = '0:00';

    const live = document.createElement('span');
    live.className = 'suno-wav-pill__live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');

    button.appendChild(dot);
    button.appendChild(label);
    button.appendChild(time);
    host.appendChild(button);
    host.appendChild(live);

    // <html>, not <body>: a page that swaps its body cannot take the pill with it, and
    // nothing in the flow moves because the pill is position: fixed.
    document.documentElement.appendChild(host);

    ui.host = host;
    ui.button = button;
    ui.dot = dot;
    ui.label = label;
    ui.time = time;
    ui.live = live;

    button.addEventListener('click', onClick);
  }

  function hasPlayer() {
    for (let i = 0; i < PLAYER_SELECTORS.length; i += 1) {
      try {
        if (document.querySelector(PLAYER_SELECTORS[i])) return true;
      } catch (err) {
        /* an exotic selector should never break the row; skip it */
      }
    }
    return false;
  }

  function syncVisibility() {
    if (!ui.host || tornDown) return;
    const show = hasPlayer();
    if (ui.host.hidden !== !show) ui.host.hidden = !show;
  }

  function watchForPlayer() {
    syncVisibility();
    if (observer) return;
    observer = new MutationObserver(() => {
      if (recheckTimer) return;
      recheckTimer = setTimeout(() => {
        recheckTimer = null;
        syncVisibility();
      }, RECHECK_MS);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------------ */
  /* Actions                                                                  */
  /* ------------------------------------------------------------------------ */

  async function onClick() {
    if (busy) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
      setState('error', 'The extension was reloaded. Refresh this Suno tab to reconnect.');
      return;
    }

    busy = true;

    if (state === 'recording') {
      setState('stopping');
      busy = false;
      const reply = await send(MSG.STOP_CAPTURE);
      const type = reply && reply.type;
      if (type === MSG.STOPPING) return;
      if (reply && reply.message) setState('error', reply.message);
      return;
    }

    setState('starting');
    busy = false;

    // No tabId: a content script cannot read chrome.tabs. The worker falls back to the
    // active tab, which is this one, because the click happened here.
    const reply = await send(MSG.START_CAPTURE);
    const type = reply && reply.type;
    if (type === MSG.STARTED || type === MSG.CAPTURE_READY) {
      startedAt = Date.now();
      elapsedSeconds = 0;
      setState('recording');
      return;
    }
    if (reply && reply.message) setState('error', reply.message);
    else setState('error', 'The recorder did not answer. Open the extension popup to see why.');
  }

  /* ------------------------------------------------------------------------ */
  /* Mirror                                                                   */
  /* ------------------------------------------------------------------------ */

  function onRuntimeMessage(message) {
    if (tornDown || !message || typeof message.type !== 'string') return;
    if (message.target && message.target !== TARGET_POPUP && message.target !== TARGET_BACKGROUND) return;

    switch (message.type) {
      case MSG.STARTED:
      case MSG.CAPTURE_READY:
        if (state !== 'recording') {
          startedAt = Date.now();
          elapsedSeconds = 0;
        }
        setState('recording');
        break;
      case MSG.STOPPING:
        setState('stopping');
        break;
      case MSG.CAPTURE_DONE:
        setState('encoded');
        break;
      case MSG.CAPTURE_ERROR:
        setState('error', message.message || 'The recording stopped with an error.');
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Teardown                                                                 */
  /* ------------------------------------------------------------------------ */

  function teardown() {
    if (tornDown) return;
    tornDown = true;
    stopTick();
    if (savedTimer) clearTimeout(savedTimer);
    if (recheckTimer) clearTimeout(recheckTimer);
    savedTimer = null;
    recheckTimer = null;
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch (err) {
      /* the context may already be gone */
    }
    if (ui.host && ui.host.parentNode) ui.host.parentNode.removeChild(ui.host);
    ui.host = null;
    ui.button = null;
    ui.dot = null;
    ui.label = null;
    ui.time = null;
    ui.live = null;
  }

  /* ------------------------------------------------------------------------ */
  /* Boot                                                                     */
  /* ------------------------------------------------------------------------ */

  build();
  watchForPlayer();
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  window.addEventListener('pagehide', teardown, { once: true });
  window.addEventListener('beforeunload', teardown, { once: true });
})();
