/**
 * Suno WAV Recorder - RIFF/WAVE encoder for integer PCM.
 *
 * The recorder taps float samples off an AudioWorklet and writes them out as a plain
 * PCM WAV: an uncompressed container, so what the tab played is what lands on disk,
 * bit for bit at the chosen depth. 16-bit is the default; 24-bit is supported for the
 * same code path (the header says 24, each sample takes three bytes).
 *
 * Deliberately not here: resampling, dithering, noise shaping, compression. A capture
 * should not colour the audio it is capturing.
 *
 * Everything is little-endian, which is what the RIFF spec asks for and what every
 * consumer of a WAV expects. The typed-array fast path assumes a little-endian host;
 * the host check below falls back to per-sample byte writing on a big-endian one.
 */

/** "RIFF" + size + "WAVE" + "fmt " + 16 + 16 bytes + "data" + size. */
export const WAV_HEADER_BYTES = 44;

/** WAVE format tag 1 = integer PCM. */
export const WAV_FORMAT_PCM = 1;

export const SUPPORTED_BIT_DEPTHS = Object.freeze([16, 24]);
export const DEFAULT_BIT_DEPTH = 16;

/** Bytes of interleaved PCM held in the staging buffer before it joins the chunk list. */
export const PCM_CHUNK_BYTES = 64 * 1024;

const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Lowest dB a peak meter reports; below this the meter says "silent". */
export const METER_FLOOR_DB = -96;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * @param {unknown} bitDepth
 * @returns {16|24}
 * @throws {RangeError} for anything but 16 or 24
 */
export function normalizeBitDepth(bitDepth) {
  if (bitDepth === undefined || bitDepth === null) return DEFAULT_BIT_DEPTH;
  const depth = Number(bitDepth);
  if (!SUPPORTED_BIT_DEPTHS.includes(depth)) {
    throw new RangeError(`Unsupported bit depth ${String(bitDepth)}; use 16 or 24.`);
  }
  return depth;
}

/** @param {16|24} bitDepth */
export function bytesPerSample(bitDepth) {
  const depth = normalizeBitDepth(bitDepth);
  return depth / 8;
}

/**
 * @param {{sampleRate: number, channels: number, bitDepth?: 16|24, frames: number}} options
 * @returns {{sampleRate: number, channels: number, bitDepth: 16|24, frames: number}}
 */
function checkedFormat({ sampleRate, channels, bitDepth, frames }) {
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`sampleRate must be a positive number, got ${String(sampleRate)}.`);
  }
  const channelCount = Number(channels);
  if (!Number.isInteger(channelCount) || channelCount < 1 || channelCount > 8) {
    throw new RangeError(`channels must be a whole number from 1 to 8, got ${String(channels)}.`);
  }
  const frameCount = Number(frames);
  if (!Number.isInteger(frameCount) || frameCount < 0) {
    throw new RangeError(`frames must be a whole number of 0 or more, got ${String(frames)}.`);
  }
  return {
    sampleRate: Math.round(rate),
    channels: channelCount,
    bitDepth: normalizeBitDepth(bitDepth),
    frames: frameCount,
  };
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The header field values for a file of this shape, named as the RIFF spec names them.
 * Split out from the writer so tests and the brief can quote real numbers instead of
 * trusting the byte writer.
 *
 * @param {{sampleRate: number, channels: number, bitDepth?: 16|24, frames: number}} options
 */
export function wavHeaderFields({ sampleRate, channels, bitDepth, frames }) {
  const format = checkedFormat({ sampleRate, channels, bitDepth, frames });
  const bytes = bytesPerSample(format.bitDepth);
  const blockAlign = format.channels * bytes;
  const dataSize = format.frames * blockAlign;
  return Object.freeze({
    riffId: 'RIFF',
    /** 4 (WAVE) + 24 (fmt chunk) + 8 (data header) + dataSize. */
    riffSize: 36 + dataSize,
    waveId: 'WAVE',
    fmtId: 'fmt ',
    /** 16 for PCM; larger values mean WAVE_FORMAT_EXTENSIBLE. */
    fmtSize: 16,
    audioFormat: WAV_FORMAT_PCM,
    numChannels: format.channels,
    sampleRate: format.sampleRate,
    /** sampleRate * blockAlign, the field players use to sanity-check the file. */
    byteRate: format.sampleRate * blockAlign,
    blockAlign,
    bitsPerSample: format.bitDepth,
    dataId: 'data',
    dataSize,
    headerBytes: WAV_HEADER_BYTES,
    totalBytes: WAV_HEADER_BYTES + dataSize,
    frames: format.frames,
  });
}

/**
 * A 44-byte RIFF/WAVE header for a file that will hold `frames` frames.
 *
 * @param {{sampleRate: number, channels: number, bitDepth?: 16|24, frames: number}} options
 * @returns {Uint8Array} exactly WAV_HEADER_BYTES long
 */
export function encodeWavHeader(options) {
  const fields = wavHeaderFields(options);
  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, fields.riffId);
  view.setUint32(4, fields.riffSize, true);
  writeAscii(view, 8, fields.waveId);
  writeAscii(view, 12, fields.fmtId);
  view.setUint32(16, fields.fmtSize, true);
  view.setUint16(20, fields.audioFormat, true);
  view.setUint16(22, fields.numChannels, true);
  view.setUint32(24, fields.sampleRate, true);
  view.setUint32(28, fields.byteRate, true);
  view.setUint16(32, fields.blockAlign, true);
  view.setUint16(34, fields.bitsPerSample, true);
  writeAscii(view, 36, fields.dataId);
  view.setUint32(40, fields.dataSize, true);
  return bytes;
}

/**
 * Read a header back. Used by the tests, and the honest way to report what a file says.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ok: boolean, fields: object|null, problems: string[]}}
 */
export function parseWavHeader(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const problems = [];
  if (bytes.byteLength < WAV_HEADER_BYTES) {
    return { ok: false, fields: null, problems: [`file is ${bytes.byteLength} bytes, shorter than a 44-byte header`] };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffId = readAscii(view, 0, 4);
  const waveId = readAscii(view, 8, 4);
  const fmtId = readAscii(view, 12, 4);
  const dataId = readAscii(view, 36, 4);
  const fields = {
    riffId,
    riffSize: view.getUint32(4, true),
    waveId,
    fmtId,
    fmtSize: view.getUint32(16, true),
    audioFormat: view.getUint16(20, true),
    numChannels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataId,
    dataSize: view.getUint32(40, true),
    totalBytes: bytes.byteLength,
  };
  if (riffId !== 'RIFF') problems.push(`RIFF id is "${riffId}", not "RIFF"`);
  if (waveId !== 'WAVE') problems.push(`form type is "${waveId}", not "WAVE"`);
  if (fmtId !== 'fmt ') problems.push(`first chunk is "${fmtId}", not "fmt "`);
  if (dataId !== 'data') problems.push(`second chunk is "${dataId}", not "data"`);
  if (fields.audioFormat !== WAV_FORMAT_PCM) problems.push(`audioFormat is ${fields.audioFormat}, not 1 (PCM)`);
  if (fields.riffSize !== 36 + fields.dataSize) {
    problems.push(`riffSize ${fields.riffSize} does not equal 36 + dataSize ${36 + fields.dataSize}`);
  }
  if (fields.byteRate !== fields.sampleRate * fields.blockAlign) {
    problems.push(`byteRate ${fields.byteRate} does not equal sampleRate * blockAlign ${fields.sampleRate * fields.blockAlign}`);
  }
  if (fields.blockAlign !== fields.numChannels * (fields.bitsPerSample / 8)) {
    problems.push(`blockAlign ${fields.blockAlign} does not match ${fields.numChannels} channels at ${fields.bitsPerSample} bits`);
  }
  if (fields.dataSize !== fields.totalBytes - WAV_HEADER_BYTES) {
    problems.push(`dataSize ${fields.dataSize} does not match the ${fields.totalBytes - WAV_HEADER_BYTES} bytes present after the header`);
  }
  return { ok: problems.length === 0, fields, problems };
}

/* -------------------------------------------------------------------------- */
/* Sample conversion                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One float sample (-1..1, as Web Audio hands it over) to signed 16-bit.
 * Values at or past full scale saturate instead of wrapping: a clip has to sound like a
 * clip, never like a click from a sign flip.
 *
 * @param {number} sample
 * @returns {number} -32768..32767
 */
export function floatToInt16(sample) {
  if (sample !== sample) return 0; // NaN
  if (sample >= 1) return 32767;
  if (sample <= -1) return -32768;
  return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
}

/**
 * One float sample to signed 24-bit.
 *
 * @param {number} sample
 * @returns {number} -8388608..8388607
 */
export function floatToInt24(sample) {
  if (sample !== sample) return 0; // NaN
  if (sample >= 1) return 0x7fffff;
  if (sample <= -1) return -0x800000;
  return sample < 0 ? Math.round(sample * 0x800000) : Math.round(sample * 0x7fffff);
}

/** Signed 16-bit back to the float Web Audio uses. */
export function int16ToFloat(value) {
  return value < 0 ? value / 0x8000 : value / 0x7fff;
}

/** Signed 24-bit back to float. */
export function int24ToFloat(value) {
  return value < 0 ? value / 0x800000 : value / 0x7fffff;
}

/**
 * Peak amplitude of a block, in dBFS, floored so a silent block still has a number to show.
 *
 * @param {number} peak linear amplitude, 0..1
 * @param {number} [floorDb]
 */
export function peakToDb(peak, floorDb = METER_FLOOR_DB) {
  if (!(peak > 0)) return floorDb;
  const db = 20 * Math.log10(peak > 1 ? 1 : peak);
  return db < floorDb ? floorDb : db;
}

/* -------------------------------------------------------------------------- */
/* Interleaving                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Interleave per-channel float blocks into little-endian PCM bytes.
 *
 * @param {Float32Array[]} channelData one Float32Array per channel, all frameCount long
 * @param {number} frameCount
 * @param {16|24} [bitDepth]
 * @returns {Uint8Array} frameCount * channels * bytesPerSample long
 */
export function interleavePcm(channelData, frameCount, bitDepth = DEFAULT_BIT_DEPTH) {
  const depth = normalizeBitDepth(bitDepth);
  const channels = channelData.length;
  const frames = Number(frameCount);
  if (!Number.isInteger(frames) || frames < 0) {
    throw new RangeError(`frameCount must be a whole number of 0 or more, got ${String(frameCount)}.`);
  }
  if (channels < 1 || channels > 8) {
    throw new RangeError(`channelData must hold 1 to 8 channels, got ${channels}.`);
  }
  for (let c = 0; c < channels; c += 1) {
    if (!(channelData[c] instanceof Float32Array)) {
      throw new TypeError(`channelData[${c}] is not a Float32Array.`);
    }
    if (channelData[c].length < frames) {
      throw new RangeError(`channelData[${c}] has ${channelData[c].length} frames, need ${frames}.`);
    }
  }

  if (depth === 16) {
    const out = new Int16Array(frames * channels);
    let index = 0;
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        out[index] = floatToInt16(channelData[c][i]);
        index += 1;
      }
    }
    if (HOST_IS_LITTLE_ENDIAN) {
      return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    }
    // A big-endian host: write the bytes by hand instead of trusting the typed array.
    const bytes = new Uint8Array(out.length * 2);
    for (let i = 0; i < out.length; i += 1) {
      const value = out[i] < 0 ? out[i] + 0x10000 : out[i];
      bytes[i * 2] = value & 0xff;
      bytes[i * 2 + 1] = (value >> 8) & 0xff;
    }
    return bytes;
  }

  const bytes = new Uint8Array(frames * channels * 3);
  let offset = 0;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const value = floatToInt24(channelData[c][i]);
      const unsigned = value < 0 ? value + 0x1000000 : value;
      bytes[offset] = unsigned & 0xff;
      bytes[offset + 1] = (unsigned >> 8) & 0xff;
      bytes[offset + 2] = (unsigned >> 16) & 0xff;
      offset += 3;
    }
  }
  return bytes;
}

/**
 * Read PCM bytes back into per-channel float blocks. The inverse of interleavePcm, used
 * by the tests to prove the round trip.
 *
 * @param {Uint8Array} bytes
 * @param {number} channels
 * @param {16|24} [bitDepth]
 * @returns {Float32Array[]}
 */
export function deinterleavePcm(bytes, channels, bitDepth = DEFAULT_BIT_DEPTH) {
  const depth = normalizeBitDepth(bitDepth);
  const bytesPer = depth / 8;
  const frameCount = Math.floor(bytes.byteLength / (channels * bytesPer));
  const out = [];
  for (let c = 0; c < channels; c += 1) out.push(new Float32Array(frameCount));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < frameCount; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const offset = (i * channels + c) * bytesPer;
      if (depth === 16) {
        out[c][i] = int16ToFloat(view.getInt16(offset, true));
      } else {
        const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
        const signed = raw & 0x800000 ? raw - 0x1000000 : raw;
        out[c][i] = int24ToFloat(signed);
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Whole-file encode                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Encode a complete buffer in one go: header + interleaved PCM.
 * For a long capture use WavAccumulator instead; this copies everything twice.
 *
 * @param {{channelData: Float32Array[], sampleRate: number, bitDepth?: 16|24, frames?: number}} options
 * @returns {ArrayBuffer}
 */
export function encodeWav({ channelData, sampleRate, bitDepth = DEFAULT_BIT_DEPTH, frames }) {
  const channelCount = channelData.length;
  const frameCount = Number.isInteger(frames) ? frames : (channelData[0] ? channelData[0].length : 0);
  const header = encodeWavHeader({ sampleRate, channels: channelCount, bitDepth, frames: frameCount });
  const pcm = interleavePcm(channelData, frameCount, bitDepth);
  const out = new Uint8Array(header.byteLength + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, header.byteLength);
  return out.buffer;
}

/**
 * @param {{channelData: Float32Array[], sampleRate: number, bitDepth?: 16|24, frames?: number}} options
 * @returns {Blob}
 */
export function encodeWavBlob(options) {
  return new Blob([encodeWav(options)], { type: 'audio/wav' });
}

/* -------------------------------------------------------------------------- */
/* Streaming accumulator                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Collects PCM from an AudioWorklet as it arrives and hands back one WAV Blob at the end.
 *
 * Why a chunk list instead of one big growing typed array: growing a typed array doubles
 * its size and copies, so the worst moment costs 3x the audio. A list of fixed 64 KiB
 * chunks costs one copy per chunk and never re-copies what is already collected. The
 * Blob at the end is the one unavoidable full-size copy (Chromium copies Blob parts into
 * the blob store), so peak memory is about 2x the finished file.
 */
export class WavAccumulator {
  /**
   * @param {{sampleRate: number, channels: number, bitDepth?: 16|24, chunkBytes?: number}} options
   */
  constructor({ sampleRate, channels, bitDepth = DEFAULT_BIT_DEPTH, chunkBytes = PCM_CHUNK_BYTES }) {
    const format = checkedFormat({ sampleRate, channels, bitDepth, frames: 0 });
    this.sampleRate = format.sampleRate;
    this.channels = format.channels;
    this.bitDepth = format.bitDepth;
    this.bytesPerFrame = format.channels * bytesPerSample(format.bitDepth);
    const size = Math.floor(Number(chunkBytes));
    // A chunk has to hold a whole number of frames or the interleaving would split one.
    this.chunkBytes = Math.max(this.bytesPerFrame, Math.floor(size / this.bytesPerFrame) * this.bytesPerFrame);
    this.frames = 0;
    this.closed = false;
    this._chunks = [];
    this._stage = new Uint8Array(this.chunkBytes);
    this._stageUsed = 0;
  }

  /** Seconds captured so far, at the true sample rate. */
  get seconds() {
    return this.frames / this.sampleRate;
  }

  /** Size the finished WAV will have. */
  get bytes() {
    return WAV_HEADER_BYTES + this.frames * this.bytesPerFrame;
  }

  /** The header the finished file will carry, for a progress readout or a test. */
  headerFields() {
    return wavHeaderFields({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitDepth: this.bitDepth,
      frames: this.frames,
    });
  }

  /**
   * Append one block of float frames, already de-interleaved by channel.
   *
   * @param {Float32Array[]} channelData one Float32Array per channel, frameCount long
   * @param {number} frameCount
   */
  append(channelData, frameCount) {
    if (this.closed) throw new Error('This accumulator is already finished.');
    const frames = Number(frameCount);
    if (!Number.isInteger(frames) || frames <= 0) return;
    if (channelData.length !== this.channels) {
      throw new RangeError(`expected ${this.channels} channels, got ${channelData.length}.`);
    }

    let done = 0;
    while (done < frames) {
      const room = (this.chunkBytes - this._stageUsed) / this.bytesPerFrame;
      const take = Math.min(frames - done, room);
      const slice = [];
      for (let c = 0; c < this.channels; c += 1) {
        slice.push(channelData[c].subarray(done, done + take));
      }
      const pcm = interleavePcm(slice, take, this.bitDepth);
      this._stage.set(pcm, this._stageUsed);
      this._stageUsed += pcm.byteLength;
      this.frames += take;
      done += take;
      if (this._stageUsed >= this.chunkBytes) this._sealChunk();
    }
  }

  /**
   * Close the file and return it. The accumulator is unusable afterwards.
   *
   * `as: 'blob'` is what the recorder hands to chrome.downloads. `as: 'bytes'` returns the
   * same bytes as one Uint8Array instead, which is what the tests compare against and what
   * any caller that writes the file itself would want.
   *
   * @param {{as?: 'blob'|'bytes', type?: string}} [options]
   * @returns {{blob: Blob|null, data: Uint8Array|null, bytes: number, frames: number, seconds: number, sampleRate: number, channels: number, bitDepth: 16|24}}
   */
  finish({ as = 'blob', type = 'audio/wav' } = {}) {
    if (this.closed) throw new Error('This accumulator is already finished.');
    if (as !== 'blob' && as !== 'bytes') throw new RangeError(`finish() cannot return "${String(as)}"; use "blob" or "bytes".`);
    this.closed = true;
    if (this._stageUsed > 0) this._sealChunk();

    const header = encodeWavHeader({
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitDepth: this.bitDepth,
      frames: this.frames,
    });
    const parts = [header, ...this._chunks];
    this._chunks = [];
    this._stage = new Uint8Array(0);
    this._stageUsed = 0;

    const byteLength = WAV_HEADER_BYTES + this.frames * this.bytesPerFrame;
    let blob = null;
    let data = null;
    if (as === 'bytes') {
      data = new Uint8Array(byteLength);
      let offset = 0;
      for (const part of parts) {
        data.set(part, offset);
        offset += part.byteLength;
      }
    } else {
      blob = new Blob(parts, { type });
    }

    return {
      blob,
      data,
      bytes: byteLength,
      frames: this.frames,
      seconds: this.frames / this.sampleRate,
      sampleRate: this.sampleRate,
      channels: this.channels,
      bitDepth: this.bitDepth,
    };
  }

  /** Hand the filled staging buffer to the chunk list and start a fresh one. */
  _sealChunk() {
    if (this._stageUsed === 0) return;
    this._chunks.push(this._stageUsed === this._stage.byteLength ? this._stage : this._stage.slice(0, this._stageUsed));
    this._stage = new Uint8Array(this.chunkBytes);
    this._stageUsed = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}
