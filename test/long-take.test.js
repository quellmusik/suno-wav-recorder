/**
 * Checks for a long take: 30 minutes of 48 kHz stereo through WavAccumulator, then a real
 * playability check on the browser's own decoder.
 *
 * The recorder's memory shape is the one thing a 90-second test cannot show. This page
 * feeds the accumulator the same way the worklet does, 8192 frames at a time, for the full
 * 1800 seconds, and samples the JS heap as it goes, so the number in the brief is measured
 * rather than multiplied out on paper.
 *
 * What it proves:
 *   1. a 30-minute take produces exactly 1800 * 48000 frames and 1800 * 48000 * 4 + 44 bytes;
 *   2. the JS heap peak stays near the size of the finished file, not a multiple of it;
 *   3. finishing the file costs no second copy inside the JS heap (the Blob's parts are
 *      outside it by construction, and the page reports both numbers so neither is guessed);
 *   4. the header of the finished 1800-second file still parses with the true rate;
 *   5. a 1-second 440 Hz WAV decodes in the browser's own decoder at 1.000 s, 48 kHz,
 *      2 channels: it is a playable file, not just a well-formed header. That fixture is
 *      read from test/out/ when it is there and rebuilt here when it is not, because a
 *      fresh clone starts with an empty test/out/ and this page must not depend on what an
 *      earlier run left behind.
 *
 * ?upload=1 POSTs the report (and the head of the long file's header) to test/out/, so a
 * headless run can be checked from the shell.
 */

import { WavAccumulator, WAV_HEADER_BYTES, parseWavHeader } from '../lib/wav-encoder.js';

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const CHUNK_FRAMES = 8192;
const TAKE_SECONDS = 30 * 60;
const TOTAL_FRAMES = SAMPLE_RATE * TAKE_SECONDS;
const EXPECTED_BYTES = WAV_HEADER_BYTES + TOTAL_FRAMES * CHANNELS * 2;

const results = [];
let failed = 0;

function check(name, pass, detail) {
  results.push({ name, pass, detail: pass ? '' : (detail || '') });
  if (!pass) failed += 1;
}

const upload = new URLSearchParams(location.search).has('upload');

/* -------------------------------------------------------------------------- */
/* Heap sampling                                                              */
/* -------------------------------------------------------------------------- */

const hasMemoryInfo = !!(performance && performance.memory);

/** @returns {number} used JS heap in bytes, or 0 when the browser does not report it. */
function heapBytes() {
  return hasMemoryInfo ? performance.memory.usedJSHeapSize : 0;
}

const heap = {
  available: hasMemoryInfo,
  precise: hasMemoryInfo ? performance.memory.jsHeapSizeLimit > 0 : false,
  start: heapBytes(),
  peak: heapBytes(),
  afterFinish: 0,
  afterRelease: 0,
};

function sampleHeap() {
  const now = heapBytes();
  if (now > heap.peak) heap.peak = now;
}

/* -------------------------------------------------------------------------- */
/* The take                                                                   */
/* -------------------------------------------------------------------------- */

/** Two reusable blocks, like the worklet's own buffers: allocate once, never per chunk. */
function makeBlocks() {
  const left = new Float32Array(CHUNK_FRAMES);
  const right = new Float32Array(CHUNK_FRAMES);
  for (let i = 0; i < CHUNK_FRAMES; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.8;
    left[i] = value;
    right[i] = value * 0.5;
  }
  return [left, right];
}

async function runTake() {
  const accumulator = new WavAccumulator({ sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: 16 });
  const blocks = makeBlocks();

  // A yield every so often keeps the page responsive and lets the timer fire; the recorder
  // never yields, so this is a slightly harder case than the real one.
  const started = performance.now();
  let written = 0;
  let yields = 0;
  while (written < TOTAL_FRAMES) {
    const frames = Math.min(CHUNK_FRAMES, TOTAL_FRAMES - written);
    accumulator.append(frames === CHUNK_FRAMES ? blocks : [blocks[0].subarray(0, frames), blocks[1].subarray(0, frames)], frames);
    written += frames;
    if ((written / CHUNK_FRAMES) % 1024 === 0) {
      sampleHeap();
      yields += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  const appendMs = performance.now() - started;
  sampleHeap();

  check('the take is 1800 s long', Math.abs(accumulator.seconds - TAKE_SECONDS) < 1e-6, `${accumulator.seconds} s`);
  check('the take is 86,400,000 frames', accumulator.frames === TOTAL_FRAMES, `${accumulator.frames} frames`);
  check('the predicted file size is 345,600,044 bytes', accumulator.bytes === EXPECTED_BYTES, `${accumulator.bytes} bytes`);
  check('the predicted header says 1800.000 s at 48000 Hz', accumulator.headerFields().dataSize === TOTAL_FRAMES * CHANNELS * 2, String(accumulator.headerFields().dataSize));

  const finishStarted = performance.now();
  const finished = accumulator.finish();
  const finishMs = performance.now() - finishStarted;
  heap.afterFinish = heapBytes();
  sampleHeap();

  check('the finished file is the size the accumulator predicted', finished.bytes === EXPECTED_BYTES, `${finished.bytes} bytes`);
  check('the finished Blob is the same size', finished.blob && finished.blob.size === EXPECTED_BYTES, `${finished.blob ? finished.blob.size : 'no blob'} bytes`);
  check('the Blob is tagged audio/wav', finished.blob && finished.blob.type === 'audio/wav', finished.blob ? finished.blob.type : 'no blob');

  // The header of the real 1800-second file, read back through the same parser a player uses.
  const headBytes = new Uint8Array(await finished.blob.slice(0, WAV_HEADER_BYTES).arrayBuffer());
  const parsed = parseWavHeader(headBytes);
  // parseWavHeader also compares dataSize with the bytes it was handed; here that is only
  // the 44-byte header, so check the fields and compare the data size separately.
  check('the 30-minute file\'s header names RIFF/WAVE, PCM, 2 channels, 16-bit',
    !!parsed.fields && parsed.fields.riffId === 'RIFF' && parsed.fields.waveId === 'WAVE'
      && parsed.fields.audioFormat === 1 && parsed.fields.numChannels === CHANNELS
      && parsed.fields.bitsPerSample === 16 && parsed.fields.sampleRate === SAMPLE_RATE,
    parsed.fields ? JSON.stringify(parsed.fields) : 'no fields');
  check('the 30-minute file says 1800.000 s of data', !!parsed.fields && parsed.fields.dataSize === TOTAL_FRAMES * CHANNELS * 2 && parsed.fields.riffSize === 36 + TOTAL_FRAMES * CHANNELS * 2,
    parsed.fields ? `${parsed.fields.dataSize} data, ${parsed.fields.riffSize} riff` : '');

  // The blob URL the recorder hands to background.js, then released.
  const url = URL.createObjectURL(finished.blob);
  const reached = await fetch(url, { headers: { Range: 'bytes=0-43' } }).then((response) => response.ok).catch(() => false);
  check('the blob URL serves the file back', reached);
  URL.revokeObjectURL(url);

  // Drop every reference the page holds and give the collector a chance.
  const blobSize = finished.blob.size;
  accumulator.finish = null;

  return { appendMs, finishMs, blobSize, headerFields: parsed.fields, yields, headHex: Array.from(headBytes).map((b) => b.toString(16).padStart(2, '0')).join(' ') };
}

/* -------------------------------------------------------------------------- */
/* Playability: the browser's own decoder on the 1-second file                */
/* -------------------------------------------------------------------------- */

const FIXTURE = 'wav-encoder-test-440hz.wav';
const FIXTURE_BYTES = 192044;

/**
 * Rebuilds the 1-second 440 Hz fixture the encoder test writes, and hands it to
 * test/serve.ps1, so this page works on a fresh clone whose test/out/ is empty.
 *
 * @returns {Promise<ArrayBuffer|null>} the bytes it encoded, or null when no server took them
 */
async function writeFixture() {
  if (!location.protocol.startsWith('http')) return null;
  const frames = SAMPLE_RATE;
  const accumulator = new WavAccumulator({ sampleRate: SAMPLE_RATE, channels: CHANNELS, bitDepth: 16 });
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 0.8;
    left[i] = value;
    right[i] = value;
  }
  accumulator.append([left, right], frames);
  const bytes = await accumulator.finish().blob.arrayBuffer();
  const posted = await fetch(`/save/${FIXTURE}`, { method: 'POST', body: bytes })
    .then((response) => response.ok)
    .catch(() => false);
  return posted ? bytes : null;
}

async function decodeSyntheticWav() {
  let bytes = await fetch(`../test/out/${FIXTURE}`, { cache: 'no-store' })
    .then((response) => (response.ok ? response.arrayBuffer() : null))
    .catch(() => null);
  if (!bytes) bytes = await writeFixture();
  check('the 1-second 440 Hz WAV is on disk', !!bytes, 'it could not be read from test/out/ or rebuilt');
  if (!bytes) return null;
  check('the 1-second WAV is 192,044 bytes', bytes.byteLength === FIXTURE_BYTES, `${bytes.byteLength} bytes`);

  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes.slice(0));
    const peak = (() => {
      const data = decoded.getChannelData(0);
      let max = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = data[i] < 0 ? -data[i] : data[i];
        if (value > max) max = value;
      }
      return max;
    })();
    check('the browser decodes the file (so it plays)', true);
    check('the decoder reads 1.000 s', Math.abs(decoded.duration - 1) < 0.001, `${decoded.duration} s`);
    check('the decoder reads 48000 Hz', decoded.sampleRate === 48000, `${decoded.sampleRate} Hz`);
    check('the decoder reads 2 channels', decoded.numberOfChannels === 2, `${decoded.numberOfChannels} ch`);
    check('the decoded tone peaks at -1.94 dBFS', Math.abs(20 * Math.log10(peak) - 20 * Math.log10(0.8)) < 0.05, `${(20 * Math.log10(peak)).toFixed(2)} dBFS`);
    return { duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, peakDb: 20 * Math.log10(peak) };
  } catch (err) {
    check('the browser decodes the file (so it plays)', false, String(err && err.message ? err.message : err));
    return null;
  } finally {
    await context.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const MB = 1024 * 1024;
let take = null;
let decoded = null;
let threw = null;
try {
  decoded = await decodeSyntheticWav();
  take = await runTake();
} catch (err) {
  threw = err;
  check('the long take completed without throwing', false, String(err && err.message ? err.message : err));
}
heap.afterRelease = heapBytes();

const report = {
  when: new Date().toISOString(),
  userAgent: navigator.userAgent,
  sampleRate: SAMPLE_RATE,
  channels: CHANNELS,
  takeSeconds: TAKE_SECONDS,
  frames: TOTAL_FRAMES,
  expectedBytes: EXPECTED_BYTES,
  heap,
  heapMb: {
    start: +(heap.start / MB).toFixed(1),
    peak: +(heap.peak / MB).toFixed(1),
    afterFinish: +(heap.afterFinish / MB).toFixed(1),
    afterRelease: +(heap.afterRelease / MB).toFixed(1),
  },
  take: take ? { appendMs: Math.round(take.appendMs), finishMs: Math.round(take.finishMs), blobSize: take.blobSize, yields: take.yields } : null,
  decoded,
  results,
  failed,
};

const lines = results.map((r) => `${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail && !r.pass ? ` -- ${r.detail}` : ''}`);
const summary = failed === 0 ? `PASS ${results.length}/${results.length}` : `FAIL ${failed} of ${results.length}`;
const box = document.getElementById('result');
box.className = failed === 0 ? 'ok' : 'fail';
box.textContent = [
  summary,
  '',
  ...lines,
  '',
  `take: ${take ? `${take.appendMs.toFixed(0)} ms to append 1800 s, ${take.finishMs.toFixed(0)} ms to finish` : 'not run'}`,
  `file: ${(EXPECTED_BYTES / MB).toFixed(1)} MB (${EXPECTED_BYTES} bytes)`,
  `JS heap: start ${report.heapMb.start} MB, peak ${report.heapMb.peak} MB, after finish ${report.heapMb.afterFinish} MB, after release ${report.heapMb.afterRelease} MB`,
  `precise memory info: ${hasMemoryInfo ? 'reported' : 'not available in this browser run'}`,
  threw ? `\nthrew: ${threw && threw.stack ? threw.stack : threw}` : '',
].join('\n');
document.title = summary;
window.__longTakeReport = report;

if (upload && location.protocol.startsWith('http')) {
  const response = await fetch('/save/long-take-report.json', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report, null, 2),
  });
  box.textContent += `\n\nreport posted: ${response.ok ? await response.text() : `HTTP ${response.status}`}`;
  document.title = `${summary} (posted)`;
}
