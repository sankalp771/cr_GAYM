/**
 * Game audio, synthesised rather than sampled.
 *
 * Everything here is generated with oscillators and a noise buffer, so the game
 * ships no audio files: nothing to license, nothing to host, nothing to
 * download before the first move. It also means an explosion can be pitched by
 * how deep into a cascade it is, which a fixed sample cannot do.
 *
 * This module is deliberately outside `lib/engine/` — it touches Web Audio and
 * localStorage, and the engine is pure.
 */

const MUTE_STORAGE_KEY = "cr-gaym:muted";

type SoundName = "place" | "explode" | "victory" | "eliminate";

let context: AudioContext | null = null;
let masterGain: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let muted = false;
let initialised = false;

function canUseAudio() {
  return typeof window !== "undefined" && typeof window.AudioContext !== "undefined";
}

/** Read the persisted preference. Safe to call during render; never throws. */
export function loadMutePreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === "true";
  } catch {
    // Private browsing and blocked storage both throw here. Sound on is a fine default.
    return false;
  }
}

export function setMuted(next: boolean) {
  muted = next;
  if (masterGain && context) {
    masterGain.gain.setTargetAtTime(next ? 0 : 0.9, context.currentTime, 0.015);
  }
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, String(next));
  } catch {
    // Preference simply will not persist. Not worth failing a click over.
  }
}

/**
 * Must be called from a user gesture: browsers refuse to start an AudioContext
 * any other way, and one created outside a gesture stays suspended forever.
 */
export function primeAudio() {
  if (!canUseAudio()) return;

  if (!initialised) {
    initialised = true;
    muted = loadMutePreference();

    context = new AudioContext();
    masterGain = context.createGain();
    masterGain.gain.value = muted ? 0 : 0.9;
    masterGain.connect(context.destination);

    // Half a second of white noise, reused for every percussive transient.
    const frames = Math.floor(context.sampleRate * 0.5);
    noiseBuffer = context.createBuffer(1, frames, context.sampleRate);
    const channel = noiseBuffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      channel[i] = Math.random() * 2 - 1;
    }
  }

  if (context?.state === "suspended") {
    void context.resume();
  }
}

function tone(options: {
  frequency: number;
  endFrequency?: number;
  duration: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}) {
  if (!context || !masterGain) return;

  const { frequency, endFrequency, duration, type = "sine", gain = 0.25, delay = 0 } = options;
  const start = context.currentTime + delay;

  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency !== undefined) {
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);
  }

  const envelope = context.createGain();
  // Ramped rather than set instantly: a square-edged envelope clicks.
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(gain, start + Math.min(0.02, duration * 0.25));
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(envelope);
  envelope.connect(masterGain);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function noise(options: { duration: number; gain?: number; frequency?: number; delay?: number }) {
  if (!context || !masterGain || !noiseBuffer) return;

  const { duration, gain = 0.2, frequency = 1200, delay = 0 } = options;
  const start = context.currentTime + delay;

  const source = context.createBufferSource();
  source.buffer = noiseBuffer;

  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(frequency, start);
  filter.frequency.exponentialRampToValueAtTime(Math.max(80, frequency * 0.35), start + duration);
  filter.Q.value = 0.9;

  const envelope = context.createGain();
  envelope.gain.setValueAtTime(gain, start);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(masterGain);
  source.start(start);
  source.stop(start + duration + 0.02);
}

/**
 * @param intensity 0..1 — how deep into a cascade this is. Deeper explosions sit
 * lower and hit harder, so a long chain audibly builds instead of repeating one
 * sound at one pitch.
 */
export function playSound(name: SoundName, intensity = 0) {
  if (!context || muted) return;

  const depth = Math.min(1, Math.max(0, intensity));

  switch (name) {
    case "place":
      tone({ frequency: 340, endFrequency: 520, duration: 0.09, type: "triangle", gain: 0.16 });
      break;

    case "explode": {
      const base = 220 - depth * 90;
      tone({ frequency: base, endFrequency: base * 0.4, duration: 0.22, type: "sawtooth", gain: 0.12 + depth * 0.06 });
      noise({ duration: 0.16 + depth * 0.1, gain: 0.1 + depth * 0.08, frequency: 1800 - depth * 900 });
      break;
    }

    case "eliminate":
      tone({ frequency: 300, endFrequency: 90, duration: 0.45, type: "sine", gain: 0.16 });
      break;

    case "victory":
      // A rising major triad — unmistakably an ending rather than another move.
      [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
        tone({ frequency, duration: 0.5, type: "triangle", gain: 0.14, delay: index * 0.11 });
      });
      break;
  }
}

/**
 * Short haptic pulse where supported. Silently does nothing on desktop and on
 * iOS Safari, which does not implement the Vibration API.
 */
export function vibrate(pattern: number | number[]) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers throw if the document is not visible.
  }
}
