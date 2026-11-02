/**
 * Suno WAV Recorder - the offscreen document.
 *
 * background.js opens this page because it is the only context in a Manifest V3 extension
 * with a DOM: getUserMedia, AudioContext and AudioWorklet all live here, and a service
 * worker has none of them.
 *
 * The path a sample takes:
 *
 *   tab capture stream
 *     -> MediaStreamAudioSourceNode            (the tab's audio, at the context's own rate)
 *          -> GainNode(1) -> destination       (keeps the song audible while recording)
 *          -> AudioWorkletNode 'suno-recorder' -> GainNode(0) -> destination
 *                                              (a silent branch; it exists only so the
 *                                               audio graph keeps pulling the worklet)
 *     -> Float32 blocks, 8192 frames at a time, transferred to this page
 *     -> WavAccumulator: interleaved to 16-bit (or 24-bit) PCM as it arrives
 *     -> RIFF/WAVE Blob -> blob: URL -> CAPTURE_DONE -> chrome.downloads
 *
 * Nothing here resamples. `new AudioContext()` without a sampleRate runs at the output
 * device's native rate, which is the rate the tab is already producing, so the WAV carries
 * exactly the samples the tab played, header included. MediaRecorder is deliberately not
 * used anywhere: it would re-encode to Opus/AAC and throw away what this extension exists
 * to keep.
 *
 * Message contract (lib/messages.js):
 *   background -> here  OFFSCREEN_START {streamId, tabId, bitDepth?}  -> replies {ok}
 *                       OFFSCREEN_STOP                               -> replies {ok}
 *   here -> background  CAPTURE_READY {tabId}
 *                       CAPTURE_PROGRESS {seconds, peakDb}   every 500 ms
 *                       CAPTURE_DONE {blobUrl, filename, bytes, sampleRate, channels, bitDepth}
 *                       CAPTURE_ERROR {message}
 */

import { MSG, TARGET } from './lib/messages.js';
import { WavAccumulator, normalizeBitDepth, peakToDb, METER_FLOOR_DB } from './lib/wav-encoder.js';

/** The worklet processor, shipped beside this file. */
const WORKLET_PATH = 'recorder-worklet.js';

/** The name the worklet registers itself under (must match registerProcessor). */
const PROCESSOR_NAME = 'suno-recorder';

/** 16-bit is the format the WAV's own header advertises; 24 is available for a request. */
const DEFAULT_BIT_DEPTH = 16;

/** How often the popup's timer and meter get an update. */
const PROGRESS_INTERVAL_MS = 500;

/** Frames the worklet collects before handing a chunk over (~171 ms at 48 kHz). */
const WORKLET_FLUSH_FRAMES = 8192;

/** A stop that never comes back must not leave the recording stuck forever. */
const WORKLET_STOP_TIMEOUT_MS = 3000;

/** @type {null | object} the one live recording */
let session = null;

/** True between OFFSCREEN_START and the graph being live. */
let starting = false;

/** A stop that arrived while the graph was still being built. */
let stopAfterStart = false;

/* -------------------------------------------------------------------------- */
/* Messaging                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Send to the background worker. Fire and forget: a closed worker is not this page's
 * problem, and a rejected send must never become an unhandled rejection that kills the
 * recording.
 *
 * @param {object} message
 */
function post(message) {
  const payload = { ...message, target: TARGET.BACKGROUND };
  try {
    const result = chrome.runtime.sendMessage(payload);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) {
    console.warn('[suno-wav] could not reach the background worker:', errText(err));
  }
}

function errText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/** Turn a thrown getUserMedia / AudioContext failure into something a person can act on. */
function explainStartError(err) {
  const raw = errText(err).trim();
  const lower = raw.toLowerCase();
  if (/invalid state|stream id|not associated|no stream/.test(lower)) {
    return `Brave could not reconnect to the tab's audio (${raw}). Click the extension icon on the Suno tab and press Record again; a stream id is only good for a few seconds.`;
  }
  if (/notallowed|permission|denied/.test(lower)) {
    return `Brave blocked audio capture for this tab (${raw}). Press Record from the extension icon on the Suno tab itself.`;
  }
  if (/could not start audio source|devices? not found|no audio track/.test(lower)) {
    return 'That tab is not playing anything, so Brave had no audio to hand over. Start the Suno song, then press Record.';
  }
  if (/addmodule|worklet|audioworklet/.test(lower)) {
    return `The recorder's audio processor did not load (${raw}). Reload the extension at brave://extensions and try again.`;
  }
  return raw || 'The recorder could not start and gave no reason.';
}

/** `suno-recording-2026-11-01T16-04-22-118Z.wav`: ISO 8601, with colons and dots made Windows-safe. */
function wavFilename(date = new Date()) {
  const stamp = date.toISOString().replace(/[:.]/g, '-');
  return `suno-recording-${stamp}.wav`;
}

/* -------------------------------------------------------------------------- */
/* Start                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @param {{streamId?: string, tabId?: number, bitDepth?: 16|24}} message
 * @returns {Promise<boolean>} true when the recording is live
 */
async function startCapture(message) {
  if (starting) return false;
  if (session) {
    // background.js retries OFFSCREEN_START until the recorder answers, so the same start
    // can arrive twice. The same stream id means it is the same take: answer it as live
    // rather than reporting an error that would clear the badge on a running recording.
    const streamId = typeof message.streamId === 'string' ? message.streamId : '';
    if (!streamId || streamId === session.streamId) {
      post({ type: MSG.CAPTURE_READY, tabId: session.tabId });
      return true;
    }
    post({ type: MSG.CAPTURE_ERROR, message: 'A recording is already running. Stop it before starting another.' });
    return false;
  }

  starting = true;
  let stream = null;
  let context = null;

  try {
    const streamId = typeof message.streamId === 'string' ? message.streamId.trim() : '';
    if (!streamId) {
      throw new Error('Brave passed no tab stream, so there is nothing to record. Click the extension icon on the Suno tab and press Record.');
    }
    const bitDepth = normalizeBitDepth(message.bitDepth);

    // tabCapture's stream id is only usable through this non-standard constraint.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      throw new Error('The tab handed over a stream with no audio track. Make sure the Suno song is playing.');
    }

    // No `sampleRate` here on purpose: the context takes the output device's native rate,
    // which is the rate the tab is producing, so no resampling ever happens. 'playback'
    // only asks for a bigger buffer, which is what a recorder wants; it does not move
    // the rate.
    context = new AudioContext({ latencyHint: 'playback' });

    await context.audioWorklet.addModule(chrome.runtime.getURL(WORKLET_PATH));
    if (context.state === 'suspended') await context.resume();

    const source = context.createMediaStreamSource(stream);

    // Channel count is left at the node's default ('max'), so the tap sees the tab's own
    // channel layout rather than a layout forced on it here.
    const recorder = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { flushFrames: WORKLET_FLUSH_FRAMES },
    });

    // Tab capture takes the tab's audio away from the speakers, so this branch is what
    // keeps the song audible while it records.
    const monitor = new GainNode(context, { gain: 1 });
    source.connect(monitor).connect(context.destination);

    // The tap branch: pulled by the graph, silent at the speakers.
    const silent = new GainNode(context, { gain: 0 });
    source.connect(recorder).connect(silent).connect(context.destination);

    const live = {
      stream,
      context,
      source,
      recorder,
      monitor,
      silent,
      streamId,
      tabId: Number.isInteger(message.tabId) ? message.tabId : null,
      sampleRate: context.sampleRate,
      bitDepth,
      /** Set by the first chunk, when the real channel count is known. */
      accumulator: null,
      channels: 0,
      /** Peak since the last progress report. */
      peak: 0,
      stopping: false,
      drainResolve: null,
      progressTimer: null,
    };

    recorder.port.onmessage = (event) => onWorkletMessage(live, event.data);

    session = live;
    starting = false;

    live.progressTimer = setInterval(() => reportProgress(live), PROGRESS_INTERVAL_MS);

    // A tab close or a revoked share ends the track; that is a normal end of the take,
    // so save what was captured instead of throwing it away.
    for (const track of audioTracks) {
      track.addEventListener('ended', () => {
        if (session === live && !live.stopping) void stopCapture('the tab stopped sharing audio');
      });
    }

    console.log(`[suno-wav] recording at ${live.sampleRate} Hz, ${bitDepth}-bit PCM`);
    post({ type: MSG.CAPTURE_READY, tabId: live.tabId });

    if (stopAfterStart) {
      stopAfterStart = false;
      void stopCapture('stop was pressed while the recorder was starting');
    }
    return true;
  } catch (err) {
    starting = false;
    stopAfterStart = false;
    const messageText = explainStartError(err);
    console.error('[suno-wav] could not start:', err);
    await teardownPartial({ stream, context });
    post({ type: MSG.CAPTURE_ERROR, message: messageText });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* While recording                                                            */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} live the session this port belongs to
 * @param {any} data
 */
function onWorkletMessage(live, data) {
  if (!data || typeof data !== 'object') return;

  if (data.type === 'chunk') {
    // A chunk that lands after the stop handshake is a duplicate of one already counted.
    const channelData = Array.isArray(data.channelData) ? data.channelData.filter((c) => c instanceof Float32Array) : [];
    if (channelData.length === 0) return;

    if (!live.accumulator) {
      live.channels = channelData.length;
      live.accumulator = new WavAccumulator({
        sampleRate: live.sampleRate,
        channels: live.channels,
        bitDepth: live.bitDepth,
      });
    }
    try {
      live.accumulator.append(fitChannels(channelData, live.channels), data.frames);
    } catch (err) {
      console.error('[suno-wav] could not write audio:', err);
      if (!live.stopping) {
        void abortRecording(live, `The recording stopped because the audio could not be written (${errText(err)}).`);
      }
      return;
    }
    const peak = Number(data.peak);
    if (Number.isFinite(peak) && peak > live.peak) live.peak = peak;
    return;
  }

  if (data.type === 'stopped') {
    const resolve = live.drainResolve;
    live.drainResolve = null;
    if (typeof resolve === 'function') resolve();
    return;
  }

  if (data.type === 'flushed') return;

  if (data.type === 'error') {
    const text = typeof data.message === 'string' && data.message ? data.message : 'The audio processor failed.';
    if (!live.stopping) void abortRecording(live, text);
  }
}

/**
 * Keep the accumulator's channel count even if the stream changes layout mid-take:
 * extra channels are dropped, missing ones repeat the last one. Silently recording a
 * broken file is worse than recording a mixed-down one.
 *
 * @param {Float32Array[]} channelData
 * @param {number} channels
 * @returns {Float32Array[]}
 */
function fitChannels(channelData, channels) {
  if (channelData.length === channels) return channelData;
  const fitted = [];
  for (let c = 0; c < channels; c += 1) {
    fitted.push(channelData[Math.min(c, channelData.length - 1)]);
  }
  return fitted;
}

/** @param {object} live */
function reportProgress(live) {
  if (live.stopping) return;
  const seconds = live.accumulator ? live.accumulator.seconds : 0;
  const peakDb = Math.round(peakToDb(live.peak, METER_FLOOR_DB) * 10) / 10;
  live.peak = 0;
  post({ type: MSG.CAPTURE_PROGRESS, seconds, peakDb });
}

/* -------------------------------------------------------------------------- */
/* Stop                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Take the frames still inside the worklet, then let it go. Resolves when the worklet has
 * acknowledged, or when the timeout says it never will.
 *
 * @param {object} live
 * @returns {Promise<void>}
 */
function drainWorklet(live) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.drainResolve = null;
      resolve();
    };
    const timer = setTimeout(() => {
      console.warn('[suno-wav] the audio processor did not confirm the final flush');
      finish();
    }, WORKLET_STOP_TIMEOUT_MS);
    live.drainResolve = finish;
    try {
      live.recorder.port.postMessage({ type: 'stop' });
    } catch (err) {
      console.warn('[suno-wav] could not ask the processor to stop:', errText(err));
      finish();
    }
  });
}

/**
 * End the take, encode it and hand the blob URL over.
 *
 * @param {string} [reason] why it ended, when it was not the popup's Stop button
 * @returns {Promise<boolean>} true when a WAV was handed to background.js
 */
async function stopCapture(reason) {
  const live = session;
  if (!live) {
    if (starting) stopAfterStart = true;
    return false;
  }
  if (live.stopping) return false;
  live.stopping = true;

  if (live.progressTimer) {
    clearInterval(live.progressTimer);
    live.progressTimer = null;
  }

  // 1. Last frames out of the worklet. Message order guarantees every chunk posted before
  //    'stopped' is appended before this resolves.
  await drainWorklet(live);

  // 2. Nothing new can arrive: unhook the graph, then let the stream go.
  try {
    live.recorder.port.onmessage = null;
  } catch (err) {
    /* the port is already gone */
  }
  await teardownPartial(live);
  session = null;

  const accumulator = live.accumulator;
  if (!accumulator) {
    post({
      type: MSG.CAPTURE_ERROR,
      message: reason
        ? `The capture ended (${reason}) before any audio arrived, so there is nothing to save.`
        : 'No audio was captured, so there is nothing to save. Start the Suno song playing and record again.',
    });
    return false;
  }

  if (accumulator.frames === 0) {
    post({
      type: MSG.CAPTURE_ERROR,
      message: 'The recording is empty: the tab never sent a sample. Start the Suno song playing and record again.',
    });
    return false;
  }

  // 3. Close the file: header with the true rate, channel count and depth, then every PCM
  //    chunk that was collected.
  let result;
  try {
    result = accumulator.finish();
  } catch (err) {
    console.error('[suno-wav] could not build the WAV:', err);
    post({ type: MSG.CAPTURE_ERROR, message: `The WAV could not be assembled (${errText(err)}).` });
    return false;
  }

  const filename = wavFilename();
  const blobUrl = URL.createObjectURL(result.blob);
  console.log(`[suno-wav] encoded ${filename}: ${result.bytes} bytes, ${result.seconds.toFixed(1)} s`);
  post({
    type: MSG.CAPTURE_DONE,
    blobUrl,
    filename,
    bytes: result.bytes,
    sampleRate: result.sampleRate,
    channels: result.channels,
    bitDepth: result.bitDepth,
  });
  return true;
}

/**
 * Fail mid-take: tell the popup and let the graph go. Nothing is saved, because a WAV
 * whose tail is missing would be handed over as if it were complete.
 *
 * @param {object} live
 * @param {string} message
 */
async function abortRecording(live, message) {
  if (live.stopping) return;
  live.stopping = true;
  if (live.progressTimer) {
    clearInterval(live.progressTimer);
    live.progressTimer = null;
  }
  try {
    live.recorder.port.postMessage({ type: 'stop' });
  } catch (err) {
    /* already stopped */
  }
  await teardownPartial(live);
  if (session === live) session = null;
  post({ type: MSG.CAPTURE_ERROR, message });
}

/**
 * Release whatever part of the graph exists. Safe to call twice, and safe on a session
 * that never got past getUserMedia.
 *
 * @param {{stream?: MediaStream|null, context?: AudioContext|null, source?: AudioNode, recorder?: AudioWorkletNode, monitor?: GainNode, silent?: GainNode}|null} live
 */
async function teardownPartial(live) {
  if (!live) return;
  if (live.progressTimer) {
    clearInterval(live.progressTimer);
    live.progressTimer = null;
  }
  for (const node of [live.source, live.recorder, live.monitor, live.silent]) {
    try {
      if (node) node.disconnect();
    } catch (err) {
      /* already disconnected */
    }
  }
  if (live.stream) {
    for (const track of live.stream.getTracks()) {
      try {
        track.stop();
      } catch (err) {
        /* already stopped */
      }
    }
  }
  if (live.context) {
    try {
      await live.context.close();
    } catch (err) {
      console.warn('[suno-wav] could not close the audio context:', errText(err));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  if (message.target && message.target !== TARGET.OFFSCREEN) return false;

  switch (message.type) {
    case MSG.OFFSCREEN_START:
      void startCapture(message).then((ok) => sendResponse({ ok, type: MSG.CAPTURE_READY }));
      return true;

    case MSG.OFFSCREEN_STOP:
      void stopCapture().then((ok) => sendResponse({ ok, type: MSG.CAPTURE_DONE }));
      return true;

    default:
      return false;
  }
});

console.log('[suno-wav] recorder page ready');
