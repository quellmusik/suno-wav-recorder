/**
 * Does the tap keep both channels?
 *
 * The worklet node is created with outputChannelCount: [1] (offscreen.js does that because
 * its output goes to a silent gain and the samples only matter), so the question is whether
 * that also collapses the *input* to mono. A downmix would not be visible in a header: the
 * file would just say 1 channel. This page answers it with sound instead of reading code:
 * 440 Hz at 0.8 on the left, 990 Hz at 0.4 on the right, then the WAV is inspected per
 * channel, by zero crossings and by peak.
 *
 * What it proves:
 *   1. a stereo source reaches the processor as two channels, not one downmix;
 *   2. the finished file is stereo (header and data agree);
 *   3. the left channel still holds 440 Hz at -1.94 dBFS and the right 990 Hz at -7.96 dBFS;
 *   4. neither channel carries the other's tone (no crosstalk, no swap).
 */

import { WavAccumulator, parseWavHeader, peakToDb } from '../lib/wav-encoder.js';

const LEFT_HZ = 440;
const RIGHT_HZ = 990;
const LEFT_GAIN = 0.8;
const RIGHT_GAIN = 0.4;
/** How long to play before stopping; ?ms= overrides it (used to check the capture rate). */
const RUN_MS = Number(new URLSearchParams(location.search).get('ms')) || 1500;

const results = [];
let failed = 0;

function check(name, pass, detail) {
  results.push({ name, pass, detail: pass ? '' : (detail || '') });
  if (!pass) failed += 1;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Zero crossings in a second, which is twice the frequency for a pure tone. */
function zeroCrossingsPerSecond(samples, seconds) {
  let crossings = 0;
  let previous = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    const value = samples[i];
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings += 1;
    previous = value;
  }
  return crossings / seconds;
}

function peakOf(samples) {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] < 0 ? -samples[i] : samples[i];
    if (value > peak) peak = value;
  }
  return peak;
}

async function run() {
  const context = new AudioContext();
  await context.audioWorklet.addModule(new URL('../recorder-worklet.js', location.href).href);
  if (context.state === 'suspended') await context.resume();

  // One oscillator per side, merged into a stereo stream: the left tone must never reach
  // the right channel.
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2, numberOfOutputs: 1 });
  const leftOsc = new OscillatorNode(context, { type: 'sine', frequency: LEFT_HZ });
  const rightOsc = new OscillatorNode(context, { type: 'sine', frequency: RIGHT_HZ });
  const leftGain = new GainNode(context, { gain: LEFT_GAIN });
  const rightGain = new GainNode(context, { gain: RIGHT_GAIN });
  leftOsc.connect(leftGain).connect(merger, 0, 0);
  rightOsc.connect(rightGain).connect(merger, 0, 1);

  // Exactly the node offscreen.js builds.
  const recorder = new AudioWorkletNode(context, 'suno-recorder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { flushFrames: 4096 },
  });
  const silent = new GainNode(context, { gain: 0 });
  merger.connect(recorder).connect(silent).connect(context.destination);

  let accumulator = null;
  let channelCounts = [];
  let stopped = false;

  recorder.port.onmessage = (event) => {
    const data = event.data;
    if (data && data.type === 'chunk') {
      channelCounts.push(data.channelData.length);
      if (!accumulator) {
        accumulator = new WavAccumulator({
          sampleRate: context.sampleRate,
          channels: data.channelData.length,
          bitDepth: 16,
        });
      }
      accumulator.append(data.channelData, data.frames);
      return;
    }
    if (data && data.type === 'stopped') stopped = true;
  };

  leftOsc.start();
  rightOsc.start();
  await sleep(RUN_MS);
  recorder.port.postMessage({ type: 'stop' });
  const waitStarted = performance.now();
  while (!stopped && performance.now() - waitStarted < 3000) await sleep(25);
  leftOsc.stop();
  rightOsc.stop();
  for (const node of [leftOsc, rightOsc, leftGain, rightGain, merger, recorder, silent]) {
    try {
      node.disconnect();
    } catch (err) {
      /* already gone */
    }
  }

  check('the processor acknowledged the stop', stopped);
  check('the tap received two channels, not a downmix', channelCounts.length > 0 && channelCounts.every((c) => c === 2), `channel counts seen: ${[...new Set(channelCounts)].join(',') || 'none'}`);
  if (!accumulator) {
    check('audio reached the accumulator', false, 'no chunk arrived');
    return { context };
  }

  const finished = accumulator.finish();
  const bytes = new Uint8Array(await finished.blob.arrayBuffer());
  const parsed = parseWavHeader(bytes);
  check('the header says 2 channels', parsed.fields && parsed.fields.numChannels === 2, parsed.fields ? String(parsed.fields.numChannels) : 'no fields');
  check('the data chunk is frames * 2 channels * 2 bytes', parsed.fields && parsed.fields.dataSize === accumulator.frames * 4, parsed.fields ? `${parsed.fields.dataSize} vs ${accumulator.frames * 4}` : '');
  check('BlockAlign is 4 and ByteRate is 4 * the sample rate', parsed.fields && parsed.fields.blockAlign === 4 && parsed.fields.byteRate === parsed.fields.sampleRate * 4);

  const seconds = finished.seconds;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const left = new Float32Array(accumulator.frames);
  const right = new Float32Array(accumulator.frames);
  for (let i = 0; i < accumulator.frames; i += 1) {
    const offset = 44 + i * 4;
    left[i] = view.getInt16(offset, true) / 32768;
    right[i] = view.getInt16(offset + 2, true) / 32768;
  }

  const leftHz = zeroCrossingsPerSecond(left, seconds) / 2;
  const rightHz = zeroCrossingsPerSecond(right, seconds) / 2;
  const leftDb = peakToDb(peakOf(left));
  const rightDb = peakToDb(peakOf(right));

  check(`the left channel is ${LEFT_HZ} Hz`, Math.abs(leftHz - LEFT_HZ) < 3, `${leftHz.toFixed(1)} Hz`);
  check(`the right channel is ${RIGHT_HZ} Hz`, Math.abs(rightHz - RIGHT_HZ) < 3, `${rightHz.toFixed(1)} Hz`);
  check(`the left channel is at ${(20 * Math.log10(LEFT_GAIN)).toFixed(2)} dBFS`, Math.abs(leftDb - 20 * Math.log10(LEFT_GAIN)) < 0.3, `${leftDb.toFixed(2)} dBFS`);
  check(`the right channel is at ${(20 * Math.log10(RIGHT_GAIN)).toFixed(2)} dBFS`, Math.abs(rightDb - 20 * Math.log10(RIGHT_GAIN)) < 0.3, `${rightDb.toFixed(2)} dBFS`);

  // Crosstalk: a channel that also carried the other tone would show up as extra crossings.
  check('the left channel carries no 990 Hz tone', Math.abs(leftHz - LEFT_HZ) < 3 && Math.abs(leftHz - RIGHT_HZ) > 3, `${leftHz.toFixed(1)} Hz`);
  check('the right channel carries no 440 Hz tone', Math.abs(rightHz - RIGHT_HZ) < 3 && Math.abs(rightHz - LEFT_HZ) > 3, `${rightHz.toFixed(1)} Hz`);

  return {
    context,
    seconds,
    wallSeconds: RUN_MS / 1000,
    ratio: seconds / (RUN_MS / 1000),
    leftHz,
    rightHz,
    leftDb,
    rightDb,
    channels: parsed.fields ? parsed.fields.numChannels : null,
    header: parsed.fields,
  };
}

const started = performance.now();
let outcome = null;
let failure = null;
try {
  outcome = await run();
} catch (err) {
  failure = err;
  check('the stereo run completed without throwing', false, String(err && err.message ? err.message : err));
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
  outcome && outcome.context ? `context: ${outcome.context.sampleRate} Hz, ${outcome.seconds ? outcome.seconds.toFixed(3) : '?'} s captured` : '',
  failure ? `threw: ${failure && failure.stack ? failure.stack : failure}` : '',
].join('\n');
document.title = summary;

const report = {
  when: new Date().toISOString(),
  userAgent: navigator.userAgent,
  summary,
  failed,
  total: results.length,
  results,
  context: outcome && outcome.context ? outcome.context.sampleRate : null,
  seconds: outcome ? outcome.seconds : null,
  channels: outcome ? outcome.channels : null,
  leftHz: outcome ? outcome.leftHz : null,
  rightHz: outcome ? outcome.rightHz : null,
  leftDb: outcome ? outcome.leftDb : null,
  rightDb: outcome ? outcome.rightDb : null,
  header: outcome ? outcome.header : null,
  tookMs: Math.round(performance.now() - started),
};
window.__stereoReport = report;

if (new URLSearchParams(location.search).has('upload') && location.protocol.startsWith('http')) {
  const response = await fetch('/save/stereo-report.json', {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(report, null, 2),
  });
  box.textContent += `\n\nreport posted: ${response.ok ? 'ok' : `HTTP ${response.status}`}`;
}
