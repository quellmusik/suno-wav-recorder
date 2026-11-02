/**
 * Checks for lib/wav-encoder.js.
 *
 * A synthetic 1-second 440 Hz tone is encoded, then the bytes are read back the way a
 * player would read them: the header field by field, and the samples de-interleaved and
 * compared against the tone that went in. If the header lies or the samples shift by one
 * frame, one of these fails.
 *
 * Synchronous on purpose: the whole run has to finish before the load event so
 * `brave --headless --dump-dom test/wav-encoder.test.html` captures the result. Open the
 * same page in a browser to read it, and add ?emit=1 to get the WAV as base64.
 */

import {
  WAV_HEADER_BYTES,
  METER_FLOOR_DB,
  WavAccumulator,
  bytesPerSample,
  deinterleavePcm,
  encodeWav,
  encodeWavHeader,
  floatToInt16,
  floatToInt24,
  interleavePcm,
  normalizeBitDepth,
  parseWavHeader,
  peakToDb,
  wavHeaderFields,
} from '../lib/wav-encoder.js';

const SAMPLE_RATE = 48000;
const SECONDS = 1;
const FRAMES = SAMPLE_RATE * SECONDS;
const FREQUENCY = 440;

const results = [];
let failed = 0;

/**
 * @param {string} name
 * @param {boolean} pass
 * @param {string} [detail]
 */
function check(name, pass, detail) {
  if (pass) {
    results.push({ name, pass, detail: '' });
    return;
  }
  failed += 1;
  results.push({ name, pass, detail: detail || '' });
}

function near(actual, expected, tolerance) {
  return Math.abs(actual - expected) <= tolerance;
}

/** A 440 Hz sine at 0.8 full scale on the left, half that on the right, both channels. */
function makeTone() {
  const left = new Float32Array(FRAMES);
  const right = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i += 1) {
    const value = Math.sin((2 * Math.PI * FREQUENCY * i) / SAMPLE_RATE) * 0.8;
    left[i] = value;
    right[i] = value * 0.5;
  }
  return [left, right];
}

function expectedSample(i) {
  return Math.sin((2 * Math.PI * FREQUENCY * i) / SAMPLE_RATE) * 0.8;
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

const tone = makeTone();

const fields16 = wavHeaderFields({ sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 16, frames: FRAMES });
check('16-bit: RIFF/WAVE ids and a 16-byte fmt chunk', fields16.riffId === 'RIFF' && fields16.waveId === 'WAVE' && fields16.fmtId === 'fmt ' && fields16.fmtSize === 16);
check('16-bit: audioFormat is 1 (PCM)', fields16.audioFormat === 1);
check('16-bit: NumChannels 2, BitsPerSample 16, SampleRate 48000', fields16.numChannels === 2 && fields16.bitsPerSample === 16 && fields16.sampleRate === SAMPLE_RATE);
check('16-bit: BlockAlign = channels * bytes = 4', fields16.blockAlign === 4);
check('16-bit: ByteRate = 48000 * 4 = 192000', fields16.byteRate === 192000, `got ${fields16.byteRate}`);
check('16-bit: dataSize = 1 s * 192000 = 192000', fields16.dataSize === 192000, `got ${fields16.dataSize}`);
check('16-bit: riffSize = 36 + dataSize = 192036', fields16.riffSize === 192036, `got ${fields16.riffSize}`);
check('16-bit: totalBytes = 44 + dataSize = 192044', fields16.totalBytes === 192044, `got ${fields16.totalBytes}`);

const headerBytes = encodeWavHeader({ sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 16, frames: FRAMES });
check('header is exactly 44 bytes', headerBytes.byteLength === WAV_HEADER_BYTES, `got ${headerBytes.byteLength}`);
const ascii = (offset, length) => String.fromCharCode(...headerBytes.slice(offset, offset + length));
check('header bytes 0-3 read "RIFF"', ascii(0, 4) === 'RIFF', ascii(0, 4));
check('header bytes 8-11 read "WAVE"', ascii(8, 4) === 'WAVE', ascii(8, 4));
check('header bytes 12-15 read "fmt "', ascii(12, 4) === 'fmt ');
check('header bytes 36-39 read "data"', ascii(36, 4) === 'data');

/* -------------------------------------------------------------------------- */
/* 16-bit round trip                                                          */
/* -------------------------------------------------------------------------- */

const wav16 = encodeWav({ channelData: tone, sampleRate: SAMPLE_RATE, bitDepth: 16 });
check('16-bit file is header + data long', wav16.byteLength === 192044, `got ${wav16.byteLength}`);

const parsed16 = parseWavHeader(wav16);
check('parseWavHeader accepts the 16-bit file', parsed16.ok, parsed16.problems.join('; '));
check('parseWavHeader reads back the same fields', parsed16.fields.byteRate === 192000 && parsed16.fields.dataSize === 192000 && parsed16.fields.bitsPerSample === 16);

const pcm16 = new Uint8Array(wav16, WAV_HEADER_BYTES);
const back16 = deinterleavePcm(pcm16, 2, 16);
check('16-bit: de-interleaving returns the same frame count', back16[0].length === FRAMES, `got ${back16[0].length}`);

let worstLeft = 0;
let worstRight = 0;
for (let i = 0; i < FRAMES; i += 1) {
  const expectedLeft = expectedSample(i);
  const expectedRight = expectedLeft * 0.5;
  worstLeft = Math.max(worstLeft, Math.abs(back16[0][i] - expectedLeft));
  worstRight = Math.max(worstRight, Math.abs(back16[1][i] - expectedRight));
}
check('16-bit: left channel within one LSB of the tone', worstLeft <= 1 / 32767, `worst error ${worstLeft}`);
check('16-bit: right channel stayed half the left (no channel swap)', worstRight <= 1 / 32767, `worst error ${worstRight}`);
check('16-bit: peak reaches -1.9 dBFS for a 0.8 tone', near(peakToDb(Math.max(...Array.from(back16[0]).map(Math.abs))), 20 * Math.log10(0.8), 0.05));

/** Count sign changes: a 440 Hz tone over one second crosses zero 880 times. */
function countZeroCrossings(samples) {
  let crossings = 0;
  let previous = samples[0];
  for (let i = 1; i < samples.length; i += 1) {
    const value = samples[i];
    if ((previous < 0 && value >= 0) || (previous >= 0 && value < 0)) crossings += 1;
    previous = value;
  }
  return crossings;
}
const crossings = countZeroCrossings(back16[0]);
check('16-bit: 440 Hz is still 440 Hz after encoding (880 crossings in 1 s)', near(crossings, FREQUENCY * 2, 2), `got ${crossings}`);
check('16-bit: first sample is the tone\'s first sample', floatToInt16(expectedSample(0)) === floatToInt16(back16[0][0]) || near(back16[0][0], 0, 1 / 32767));

/* -------------------------------------------------------------------------- */
/* 24-bit                                                                     */
/* -------------------------------------------------------------------------- */

const fields24 = wavHeaderFields({ sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 24, frames: FRAMES });
check('24-bit: BitsPerSample 24, BlockAlign 6, ByteRate 288000', fields24.bitsPerSample === 24 && fields24.blockAlign === 6 && fields24.byteRate === 288000);
check('24-bit: dataSize = 1 s * 288000 = 288000', fields24.dataSize === 288000, `got ${fields24.dataSize}`);
check('bytesPerSample is 2 and 3', bytesPerSample(16) === 2 && bytesPerSample(24) === 3);

const wav24 = encodeWav({ channelData: tone, sampleRate: SAMPLE_RATE, bitDepth: 24 });
check('24-bit file is header + data long', wav24.byteLength === 288044, `got ${wav24.byteLength}`);
const parsed24 = parseWavHeader(wav24);
check('parseWavHeader accepts the 24-bit file', parsed24.ok, parsed24.problems.join('; '));

const back24 = deinterleavePcm(new Uint8Array(wav24, WAV_HEADER_BYTES), 2, 24);
let worst24 = 0;
for (let i = 0; i < FRAMES; i += 1) {
  worst24 = Math.max(worst24, Math.abs(back24[0][i] - expectedSample(i)));
}
check('24-bit: within one 24-bit LSB of the tone', worst24 <= 1 / 8388607, `worst error ${worst24}`);

/* -------------------------------------------------------------------------- */
/* Saturation and edge cases                                                  */
/* -------------------------------------------------------------------------- */

const loud = new Float32Array([2, -2, 1, -1, 0, Number.NaN, 0.5, -0.5]);
const interleavedLoud = interleavePcm([loud], 8, 16);
const loudBack = deinterleavePcm(interleavedLoud, 1, 16);
check('16-bit: +2 saturates to full scale, not a wrap', floatToInt16(2) === 32767 && near(loudBack[0][0], 1, 1e-9), String(loudBack[0][0]));
check('16-bit: -2 saturates to full negative scale', floatToInt16(-2) === -32768 && near(loudBack[0][1], -1, 1e-9), String(loudBack[0][1]));
check('16-bit: NaN becomes silence', floatToInt16(Number.NaN) === 0 && loudBack[0][5] === 0);
check('16-bit: 0.5 and -0.5 round trip', near(loudBack[0][6], 0.5, 1e-4) && near(loudBack[0][7], -0.5, 1e-4));
check('24-bit: +2 saturates to 8388607 and -2 to -8388608', floatToInt24(2) === 8388607 && floatToInt24(-2) === -8388608);
check('24-bit: NaN becomes silence', floatToInt24(Number.NaN) === 0);

const mono = new Float32Array(FRAMES);
for (let i = 0; i < FRAMES; i += 1) mono[i] = Math.sin((2 * Math.PI * FREQUENCY * i) / SAMPLE_RATE) * 0.5;
const wavMono = encodeWav({ channelData: [mono], sampleRate: SAMPLE_RATE, bitDepth: 16 });
const parsedMono = parseWavHeader(wavMono);
check('mono: header says 1 channel, BlockAlign 2, ByteRate 96000', parsedMono.fields.numChannels === 1 && parsedMono.fields.blockAlign === 2 && parsedMono.fields.byteRate === 96000);
check('mono: file is 44 + 96000 bytes', wavMono.byteLength === 96044, `got ${wavMono.byteLength}`);
check('44.1 kHz stereo: ByteRate 176400, dataSize 176400', (() => {
  const f = wavHeaderFields({ sampleRate: 44100, channels: 2, bitDepth: 16, frames: 44100 });
  return f.byteRate === 176400 && f.dataSize === 176400;
})());

let threw = false;
try {
  normalizeBitDepth(20);
} catch (err) {
  threw = err instanceof RangeError;
}
check('unsupported bit depth is refused, not silently rounded', threw);
check('bit depth default is 16', normalizeBitDepth(undefined) === 16);

/* -------------------------------------------------------------------------- */
/* Streaming accumulator: same bytes as a one-shot encode                     */
/* -------------------------------------------------------------------------- */

const accumulator = new WavAccumulator({ sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 16 });
// Uneven pieces on purpose, none of them a multiple of the 64 KiB chunk: the encoder has
// to split them and still land on the same bytes.
const pieces = [0, 3331, 20000, 20001, 32768, FRAMES];
for (let p = 1; p < pieces.length; p += 1) {
  const start = pieces[p - 1];
  const count = pieces[p] - start;
  accumulator.append([tone[0].subarray(start, start + count), tone[1].subarray(start, start + count)], count);
}
check('accumulator counts every frame it was given', accumulator.frames === FRAMES, `got ${accumulator.frames}`);
check('accumulator reports 1.000 s at 48 kHz', near(accumulator.seconds, 1, 1e-9));
check('accumulator predicts the file size', accumulator.bytes === 192044, `got ${accumulator.bytes}`);
const streamed = accumulator.finish({ as: 'bytes' });
check('streamed file is the same length as the one-shot encode', streamed.data.byteLength === wav16.byteLength, `${streamed.data.byteLength} vs ${wav16.byteLength}`);

let firstDiff = -1;
const oneShot = new Uint8Array(wav16);
for (let i = 0; i < oneShot.length; i += 1) {
  if (oneShot[i] !== streamed.data[i]) {
    firstDiff = i;
    break;
  }
}
check('streamed bytes are identical to the one-shot encode', firstDiff === -1, firstDiff === -1 ? '' : `first difference at byte ${firstDiff}`);
check('streamed header parses', parseWavHeader(streamed.data).ok);

// A tiny chunk size must still produce identical bytes: this is the path that seals a
// staging buffer mid-frame-run.
const tiny = new WavAccumulator({ sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 16, chunkBytes: 1000 });
for (let start = 0; start < FRAMES; start += 777) {
  const count = Math.min(777, FRAMES - start);
  tiny.append([tone[0].subarray(start, start + count), tone[1].subarray(start, start + count)], count);
}
const tinyOut = tiny.finish({ as: 'bytes' });
let tinyDiff = -1;
for (let i = 0; i < oneShot.length; i += 1) {
  if (oneShot[i] !== tinyOut.data[i]) {
    tinyDiff = i;
    break;
  }
}
check('a 1000-byte staging buffer still writes the same file', tinyDiff === -1, tinyDiff === -1 ? '' : `first difference at byte ${tinyDiff}`);

// 24-bit through the accumulator, for the same reason.
const accumulator24 = new WavAccumulator({ sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 24 });
accumulator24.append(tone, FRAMES);
const out24 = accumulator24.finish({ as: 'bytes' });
check('24-bit accumulator matches the one-shot 24-bit encode', (() => {
  const ref = new Uint8Array(wav24);
  if (out24.data.byteLength !== ref.byteLength) return false;
  for (let i = 0; i < ref.length; i += 1) if (ref[i] !== out24.data[i]) return false;
  return true;
})());

const finishedTwice = (() => {
  try {
    accumulator.append([tone[0].subarray(0, 10), tone[1].subarray(0, 10)], 10);
    return false;
  } catch (err) {
    return true;
  }
})();
check('a finished accumulator refuses more audio', finishedTwice);

const wrongChannelCount = (() => {
  try {
    const acc = new WavAccumulator({ sampleRate: SAMPLE_RATE, channels: 2, bitDepth: 16 });
    acc.append([mono], FRAMES);
    return false;
  } catch (err) {
    return err instanceof RangeError;
  }
})();
check('a channel-count mismatch is refused', wrongChannelCount);

/* -------------------------------------------------------------------------- */
/* Meter                                                                      */
/* -------------------------------------------------------------------------- */

check('peakToDb(1) is 0 dBFS', peakToDb(1) === 0);
check('peakToDb(0.5) is about -6.02 dBFS', near(peakToDb(0.5), -6.0206, 0.001));
check(`peakToDb(0) sits on the ${METER_FLOOR_DB} dB floor`, peakToDb(0) === METER_FLOOR_DB);

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const lines = results.map((r) => `${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.detail && !r.pass ? ` -- ${r.detail}` : ''}`);
const summary = failed === 0 ? `PASS ${results.length}/${results.length}` : `FAIL ${failed} of ${results.length}`;
document.title = summary;
const resultBox = document.getElementById('result');
resultBox.textContent = `${summary}\n\n${lines.join('\n')}`;
resultBox.className = failed === 0 ? 'ok' : 'fail';
window.__testSummary = { total: results.length, failed, results };

// Header values, quoted straight from the encoder, for the brief-back.
const quote = `header 16-bit stereo 48 kHz: ${JSON.stringify(fields16)}`;
resultBox.textContent += `\n\n${quote}`;

if (new URLSearchParams(location.search).has('emit')) {
  const bytes = new Uint8Array(wav16);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  const base64 = btoa(binary);
  const box = document.getElementById('b64');
  box.hidden = false;
  box.textContent = `<<<WAVBASE64>>>${base64}<<<ENDWAVBASE64>>>`;

  const blob = new Blob([wav16], { type: 'audio/wav' });
  const player = document.getElementById('player');
  player.hidden = false;
  player.src = URL.createObjectURL(blob);

  // A real download link, so the file can be saved and played (or checked byte by byte).
  const link = document.createElement('a');
  link.id = 'download';
  link.href = player.src;
  link.download = 'wav-encoder-test-440hz.wav';
  link.textContent = 'Download the 440 Hz test WAV';
  link.style.cssText = 'display:inline-block;margin:1rem 0;padding:.5rem 1rem;background:#2b6cb0;color:#fff;border-radius:6px;text-decoration:none';
  document.body.insertBefore(link, document.getElementById('result'));

  document.title = `${summary} (wav ${bytes.length} bytes)`;

  // ?upload=1 hands the very same bytes back to test/serve.ps1, which writes them to
  // test/out/, so the file can be checked from the shell instead of through a save dialog.
  if (new URLSearchParams(location.search).has('upload') && location.protocol.startsWith('http')) {
    const status = document.createElement('p');
    status.textContent = 'uploading the WAV to test/out/...';
    document.body.appendChild(status);
    fetch('/save/wav-encoder-test-440hz.wav', { method: 'POST', body: wav16 })
      .then((response) => response.text())
      .then((text) => {
        status.textContent = `uploaded: ${text}`;
        document.title = `${summary} (uploaded)`;
      })
      .catch((err) => {
        status.textContent = `upload failed: ${err}`;
      });
  }
}
