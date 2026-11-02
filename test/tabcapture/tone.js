/**
 * The stand-in for a Suno tab: a real tab, playing a real tone through Web Audio.
 *
 * Tab capture hands over whatever the tab renders, so a tab playing 440 Hz at 0.8 full
 * scale is the cleanest possible signal to check the recorder against: after the trip
 * through tabCapture -> getUserMedia -> MediaStreamAudioSourceNode -> AudioWorklet ->
 * WAV, the file must still be 440 Hz at -1.94 dBFS.
 *
 * The context is created with no sampleRate option, exactly as offscreen.js does, so the
 * tone is generated at the same native rate the recorder will run at.
 */

const state = document.getElementById('state');

const context = new AudioContext();
const oscillator = new OscillatorNode(context, { type: 'sine', frequency: 440 });
const level = new GainNode(context, { gain: 0.8 });
const analyser = new AnalyserNode(context, { fftSize: 2048 });

oscillator.connect(level);
level.connect(analyser);
level.connect(context.destination);
oscillator.start();

window.__tone = { context, oscillator, level };

async function resume() {
  if (context.state === 'suspended') {
    try {
      await context.resume();
    } catch (err) {
      state.textContent = `could not resume the audio context: ${err && err.message ? err.message : err}`;
      return;
    }
  }
  state.textContent = `playing at ${context.sampleRate} Hz, context ${context.state}`;
  document.title = `tone 440 Hz @ ${context.sampleRate} Hz (${context.state})`;
}

// Browsers start a context suspended without a gesture; test runs pass
// --autoplay-policy=no-user-gesture-required, and a click resumes it in a normal window.
void resume();
window.addEventListener('pointerdown', () => void resume(), { once: true });
