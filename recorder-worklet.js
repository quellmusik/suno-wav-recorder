/**
 * Suno WAV Recorder - the PCM tap.
 *
 * An AudioWorkletProcessor runs on the audio thread, one 128-frame render quantum at a
 * time, ahead of any main-thread work. That is the only place a tap can copy samples
 * without the tab's timing, a GC pause or a busy offscreen document ever dropping one:
 * a main-thread ScriptProcessorNode would glitch under load, and MediaRecorder would
 * hand back a compressed copy that has already thrown detail away.
 *
 * What it does with a block:
 *   1. copies each channel of the quantum into a per-channel Float32Array that grows by
 *      doubling, so allocating is rare (one 128-frame allocation per block would churn
 *      the audio thread's heap and risk a drop-out);
 *   2. tracks the peak absolute sample, for the level meter;
 *   3. once about 8192 frames have piled up (~170 ms at 48 kHz), hands that chunk to the
 *      offscreen document and transfers its buffers, so the audio thread keeps nothing.
 *
 * No resampling and no mixing: the frames leave at the context's own rate, in the channel
 * layout the tab produced. Silence is passed through as zero frames like any other audio,
 * because a gap in a recording is a fact, not something to paper over.
 */

/** Frames held before a chunk is posted: 8192 is ~171 ms at 48 kHz, ~186 ms at 44.1 kHz. */
const DEFAULT_FLUSH_FRAMES = 8192;

/** A tab capture is stereo in practice; cap the tap so a strange stream cannot balloon. */
const DEFAULT_MAX_CHANNELS = 8;

class SunoRecorderProcessor extends AudioWorkletProcessor {
  /**
   * @param {{processorOptions?: {flushFrames?: number, maxChannels?: number}}} [options]
   */
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};

    const flushFrames = Number(opts.flushFrames);
    this._flushFrames = Number.isFinite(flushFrames) && flushFrames >= 128
      ? Math.floor(flushFrames)
      : DEFAULT_FLUSH_FRAMES;

    const maxChannels = Number(opts.maxChannels);
    this._maxChannels = Number.isFinite(maxChannels) && maxChannels >= 1
      ? Math.min(Math.floor(maxChannels), 32)
      : DEFAULT_MAX_CHANNELS;

    /** @type {Float32Array[]} one growing buffer per channel; empty until the first block. */
    this._buffers = [];
    this._capacity = 0;
    this._channelCount = 0;

    /** Frames waiting in the buffers, and frames captured since the tap opened. */
    this._pending = 0;
    this._totalFrames = 0;

    /** Peak absolute sample since the last chunk, 0..1. */
    this._peak = 0;

    /** Set by a 'stop' message: process() then returns false and the node is released. */
    this._closed = false;

    this.port.onmessage = (event) => this._onMessage(event.data);
  }

  /* ---------------------------------------------------------------------- */
  /* Audio thread                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * @param {Float32Array[][]} inputs
   * @returns {boolean} true keeps the node alive
   */
  process(inputs) {
    if (this._closed) return false;

    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) {
      // No signal this quantum (a muted tab, or before the stream starts). Keep the node
      // alive: a tab that is paused is not a tab that has stopped.
      return true;
    }

    const frames = input[0].length;
    if (frames === 0) return true;

    if (this._channelCount === 0) {
      this._channelCount = Math.min(input.length, this._maxChannels);
      this._grow(this._flushFrames);
    }

    this._grow(this._pending + frames);

    for (let c = 0; c < this._channelCount; c += 1) {
      // A mono stream feeding a multi-channel node reuses channel 0 rather than going silent.
      const source = input[c < input.length ? c : input.length - 1];
      this._buffers[c].set(source, this._pending);
      for (let i = 0; i < frames; i += 1) {
        const value = source[i] < 0 ? -source[i] : source[i];
        if (value > this._peak) this._peak = value;
      }
    }

    this._pending += frames;
    this._totalFrames += frames;

    if (this._pending >= this._flushFrames) this._flush(false);
    return true;
  }

  /**
   * Make room for `frames` in every channel buffer, doubling so the copies are rare.
   * @param {number} frames
   */
  _grow(frames) {
    if (frames <= this._capacity) return;
    let capacity = this._capacity > 0 ? this._capacity : this._flushFrames;
    while (capacity < frames) capacity *= 2;
    const grown = [];
    for (let c = 0; c < this._channelCount; c += 1) {
      const next = new Float32Array(capacity);
      if (this._pending > 0) next.set(this._buffers[c].subarray(0, this._pending), 0);
      grown.push(next);
    }
    this._buffers = grown;
    this._capacity = capacity;
  }

  /**
   * Copy the pending frames out and post them. Never async: the audio thread blocks the
   * whole graph while a message is being built, so this stays a copy and a post.
   *
   * @param {boolean} announce post a 'flushed' acknowledgement the main thread can await
   */
  _flush(announce) {
    const frames = this._pending;
    const peak = this._peak;

    if (frames > 0) {
      const channelData = [];
      const transfer = [];
      for (let c = 0; c < this._channelCount; c += 1) {
        // slice() allocates exactly the pending length, so the buffer can be transferred
        // and the audio thread keeps no reference to it.
        const chunk = this._buffers[c].slice(0, frames);
        channelData.push(chunk);
        transfer.push(chunk.buffer);
      }
      this._pending = 0;
      this._peak = 0;
      this.port.postMessage({ type: 'chunk', channelData, frames, peak, totalFrames: this._totalFrames }, transfer);
    }

    if (announce) {
      // The main thread's stop/flush handshake resolves on this, whatever the frame count.
      this.port.postMessage({ type: 'flushed', frames, totalFrames: this._totalFrames, peak });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Main thread                                                            */
  /* ---------------------------------------------------------------------- */

  /** @param {{type?: string}} data */
  _onMessage(data) {
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'flush') {
      this._flush(true);
      return;
    }
    if (data.type === 'stop') {
      // Last frames out, then refuse to process: the node releases once process() says false.
      if (!this._closed) {
        this._flush(true);
        this._closed = true;
        this._pending = 0;
        this._buffers = [];
        this._capacity = 0;
        this.port.postMessage({ type: 'stopped', totalFrames: this._totalFrames });
      }
    }
  }
}

registerProcessor('suno-recorder', SunoRecorderProcessor);
