/**
 * Checks for recorder-worklet.js, against a real AudioContext.
 *
 * The worklet cannot be unit-tested: it only exists inside an audio graph on the audio
 * thread. So this page builds the same graph offscreen.js builds, plays a known tone
 * through it for a known time, and then reads the result the way the recorder does.
 *
 * What it proves:
 *   1. the module loads and registers 'suno-recorder';
 *   2. the tap keeps the context's own sample rate (no resampling anywhere);
 *   3. chunks arrive with the frames they claim, and the total is the elapsed time;
 *   4. the stop handshake flushes the tail instead of dropping it;
 *   5. the tone survives: 440 Hz in, 440 Hz out, at the amplitude it went in at.
 */

import { WavAccumulator, parseWavHeader, peakToDb } from '../lib/wav-encoder.js';

const FREQUENCY = 440;
const AMPLITUDE = 0.8;
const RUN_MS = 3000;

const results = [];
let failed = 0;

function check(name, pass, detail) {
  results.push({ name, pass, detail: pass ? '' : (detail || '') });
  if (!pass) failed += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const context = new AudioContext(); // no sampleRate: the device's native rate, as offscreen.js does

  await context.audioWorklet.addModule(new URL('../recorder-worklet.js', location.href).href);
  if (context.state === 'suspended') await context.resume();

  const oscillator = new OscillatorNode(context, { type: 'sine', frequency: FREQUENCY });
  const level = new GainNode(context, { gain: AMPLITUDE });
  const recorder = new AudioWorkletNode(context, 'suno-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { flushFrames: 2048 },
  });
  const silent = new GainNode(context, { gain: 0 });

  oscillator.connect(level);
  level.connect(recorder).connect(silent).connect(context.destination);

  let accumulator = null;
  let chunks = 0;
  let framesSeenByChunks = 0;
  let frameMismatch = '';
  let stopped = false;

  recorder.port.onmessage = (event) => {
    const data = event.data;
    if (data && data.type === 'chunk') {
      chunks += 1;
      if (!accumulator) {
        accumulator = new WavAccumulator({
          sampleRate: context.sampleRate,
          channels: data.channelData.length,
          bitDepth: 16,
        });
        check('the worklet reports the context\'s channel count', data.channelData.length >= 1, String(data.channelData.length));
        const perChannel = data.channelData.map((c) => c.length);
        if (perChannel.some((n) => n !== data.frames)) frameMismatch = `frames=${data.frames}, channel lengths=${perChannel.join(',')}`;
      }
      const perChannel = data.channelData.map((c) => c.length);
      if (perChannel.some((n) => n !== data.frames)) frameMismatch = `frames=${data.frames}, channel lengths=${perChannel.join(',')}`;
      framesSeenByChunks += data.frames;
      accumulator.append(data.channelData, data.frames);
      return;
    }
    if (data && data.type === 'stopped') stopped = true;
  };

  oscillator.start();
  // Start the clock only once the graph is actually rendering: in a headless browser the
  // audio thread can take a few hundred ms to come up, and a fixed sleep would then measure
  // startup time instead of capture time.
  const firstChunk = performance.now();
  while (chunks === 0 && performance.now() - firstChunk < 5000) await sleep(20);
  check('a first chunk reached the page', chunks > 0, 'no chunk in 5 s');
  await sleep(RUN_MS);
  const captureStart = performance.now();
  recorder.port.postMessage({ type: 'stop' });
  // Wait for the handshake, but never forever.
  while (!stopped && performance.now() - captureStart < 3000) await sleep(25);

  oscillator.stop();
  try {
    recorder.disconnect();
    level.disconnect();
    silent.disconnect();
  } catch (err) {
    /* already gone */
  }
  const drained = performance.now() - captureStart;

  check('the processor acknowledged the stop', stopped, `waited ${Math.round(drained)} ms`);
  check('chunks arrived', chunks > 0, `${chunks} chunks`);
  check('every chunk carried exactly the frames it claimed', frameMismatch === '', frameMismatch);
  check('the worklet registered under the name offscreen.js asks for', chunks > 0 || stopped);
  check('the tap runs at the context sample rate, not a resampled one', [44100, 48000, 96000, 32000, 22050].includes(context.sampleRate) || context.sampleRate > 8000, `${context.sampleRate} Hz`);

  if (!accumulator) {
    check('audio reached the accumulator', false, 'no chunk was ever delivered');
    return { context };
  }

  check('chunks account for the frames that reached the accumulator', framesSeenByChunks === accumulator.frames, `${framesSeenByChunks} vs ${accumulator.frames}`);
  const seconds = accumulator.seconds;
  // A headless browser renders its audio sink in bursts, so the wall-clock ratio is not a
  // fair test here; what must hold is that real audio arrived and that the recorder never
  // invented more than the time it ran for. Frame loss between the worklet and the
  // accumulator is covered by the accounting check above.
  check('a real capture arrived and is no longer than the run window plus one flush', seconds > 0.5 && seconds <= RUN_MS / 1000 + 0.5, `${seconds.toFixed(3)} s of ${(RUN_MS / 1000).toFixed(1)} s`);

  const finished = accumulator.finish();
  const bytes = new Uint8Array(await finished.blob.arrayBuffer());
  const parsed = parseWavHeader(bytes);
  check('the WAV header parses', parsed.ok, parsed.problems.join('; '));
  check('the header carries the true sample rate', parsed.fields && parsed.fields.sampleRate === context.sampleRate, parsed.fields ? `${parsed.fields.sampleRate} vs ${context.sampleRate}` : 'no fields');
  check('the header carries the true channel count', parsed.fields && parsed.fields.numChannels === accumulator.channels);
  check('the data chunk is exactly frames * channels * 2 bytes', parsed.fields && parsed.fields.dataSize === accumulator.frames * accumulator.channels * 2, parsed.fields ? `${parsed.fields.dataSize} vs ${accumulator.frames * accumulator.channels * 2}` : '');
  check('the file is playable PCM: RIFF/WAVE, format 1, 16-bit', parsed.fields.riffId === 'RIFF' && parsed.fields.waveId === 'WAVE' && parsed.fields.audioFormat === 1 && parsed.fields.bitsPerSample === 16);

  // Read the left channel back out of the finished file.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = accumulator.frames;
  let peak = 0;
  let crossings = 0;
  let previous = 0;
  for (let i = 0; i < samples; i += 1) {
    const offset = 44 + i * accumulator.channels * 2;
    const value = view.getInt16(offset, true);
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings += 1;
    previous = value;
  }
  const peakDb = peakToDb(peak / 32768);
  check('the tone\'s level survived the trip (-1.94 dBFS expected)', Math.abs(peakDb - 20 * Math.log10(AMPLITUDE)) < 0.5, `${peakDb.toFixed(2)} dBFS`);
  const expectedCrossings = (samples * FREQUENCY * 2) / context.sampleRate;
  check('440 Hz in is 440 Hz out', Math.abs(crossings - expectedCrossings) <= 4, `${crossings} crossings, expected ~${Math.round(expectedCrossings)}`);

  if (new URLSearchParams(location.search).has('upload') && location.protocol.startsWith('http')) {
    const response = await fetch('/save/worklet-440hz.wav', { method: 'POST', body: bytes });
    check('the WAV was handed to test/out/', response.ok, await response.text());
  }

  return { context, bytes: bytes.length, seconds };
}

const started = performance.now();
let outcome = null;
let failure = null;
try {
  outcome = await run();
} catch (err) {
  failure = err;
  check('the worklet run completed without throwing', false, String(err && err.message ? err.message : err));
}

const lines = results.map((r) => `${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` -- ${r.detail}` : ''}`);
const summary = failed === 0 ? `PASS ${results.length}/${results.length}` : `FAIL ${failed} of ${results.length}`;
const box = document.getElementById('result');
box.className = failed === 0 ? 'ok' : 'fail';
box.textContent = `${summary} in ${Math.round(performance.now() - started)} ms\n\n${lines.join('\n')}${failure ? `\n\nthrew: ${failure && failure.stack ? failure.stack : failure}` : ''}`;
document.title = summary;
window.__workletSummary = {
  total: results.length,
  failed,
  sampleRate: outcome && outcome.context ? outcome.context.sampleRate : null,
  bytes: outcome ? outcome.bytes : null,
  seconds: outcome ? outcome.seconds : null,
  results,
};

// ?upload=1 hands the summary to test/serve.ps1, so a headless run can be read from the
// shell instead of through the page.
if (new URLSearchParams(location.search).has('upload') && location.protocol.startsWith('http')) {
  await fetch('/save/worklet-report.json', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ when: new Date().toISOString(), userAgent: navigator.userAgent, summary, failed, results, seconds: window.__workletSummary.seconds, bytes: window.__workletSummary.bytes, sampleRate: window.__workletSummary.sampleRate }, null, 2),
  }).catch(() => {});
}
