/**
 * Server only: imported by app/api/segment/route.ts, never by a page, so no
 * client bundle can compose a minute it has not paid for. Each minute of each
 * track is generated from a seed, the same score every time it is asked for.
 */
import type { Note, Segment } from "./tracks";

const SALT = "ckb-session-kit/listen/v1";

const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const AEOLIAN = [0, 2, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];

interface Style {
  /** MIDI note of the tonic, in the pad's register. */
  root: number;
  mode: number[];
  /** A multiple of 8, so a minute holds a whole number of two-bar chords. */
  bpm: number;
  /** Chance of a lead note on each eighth. */
  density: number;
  lead: "bell" | "pluck";
}

const STYLES: Record<string, Style> = {
  tide: { root: 50, mode: DORIAN, bpm: 64, density: 0.22, lead: "bell" },
  lantern: { root: 57, mode: AEOLIAN, bpm: 72, density: 0.42, lead: "pluck" },
  quarry: { root: 53, mode: LYDIAN, bpm: 56, density: 0.14, lead: "bell" },
};

/** Scale degrees, one chord per two bars. */
const PROGRESSIONS = [
  [0, 5, 3, 4],
  [0, 3, 5, 4],
  [0, 4, 5, 3],
  [5, 3, 0, 4],
  [0, 2, 5, 3],
  [3, 4, 0, 5],
];

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const QUALITIES: Record<string, string> = { "4,7,11": "maj7", "3,7,10": "m7", "4,7,10": "7", "3,6,10": "m7b5", "4,6,11": "maj7#11" };

/** FNV-1a, then mulberry32: small, deterministic, and plenty for music. */
function rng(seed: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The MIDI note of scale degree `d` (any integer) above the root. */
function degree(style: Style, d: number): number {
  const len = style.mode.length;
  const octave = Math.floor(d / len);
  return style.root + 12 * octave + style.mode[((d % len) + len) % len];
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Minute `minute` of `track`, or undefined for a track that does not exist. */
export function compose(track: string, minute: number): Segment | undefined {
  const style = Object.hasOwn(STYLES, track) ? STYLES[track] : undefined;
  if (!style) return undefined;
  const random = rng(`${SALT}:${track}:${minute}`);
  const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];

  const beat = 60 / style.bpm;
  const chordLen = 8 * beat;
  const count = style.bpm / 8;
  const progression = pick(PROGRESSIONS);
  const notes: Note[] = [];
  const chords: Segment["chords"] = [];

  for (let c = 0; c < count; c++) {
    const t = c * chordLen;
    const d = progression[c % progression.length];
    const tones = [0, 2, 4, 6].map((k) => degree(style, d + k));
    const quality = QUALITIES[tones.slice(1).map((n) => n - tones[0]).join(",")] ?? "";
    chords.push({ t: round(t), name: NAMES[tones[0] % 12] + quality });

    // Pad: the four chord tones, overlapping into the next chord.
    for (const n of tones) notes.push({ t: round(t), d: round(chordLen + 0.6), n, v: 0.16, voice: "pad" });
    // Bass: the root an octave down, sometimes again halfway through.
    notes.push({ t: round(t), d: round(chordLen * 0.48), n: tones[0] - 12, v: 0.34, voice: "bass" });
    if (random() < 0.5) notes.push({ t: round(t + 4 * beat), d: round(chordLen * 0.45), n: tones[0] - 12, v: 0.26, voice: "bass" });
  }

  // Lead: a random walk over the scale an octave up, on an eighth-note grid.
  let step = 7 + Math.floor(random() * 5);
  const eighths = Math.floor(60 / (beat / 2));
  for (let e = 0; e < eighths; e++) {
    const onBeat = e % 2 === 0;
    if (random() > style.density * (onBeat ? 1.3 : 0.7)) continue;
    step = Math.max(5, Math.min(14, step + pick([-2, -1, -1, 0, 1, 1, 2])));
    notes.push({
      t: round((e * beat) / 2),
      d: round((beat / 2) * (1 + Math.floor(random() * 4))),
      n: degree(style, step),
      v: round(0.18 + random() * 0.2),
      voice: style.lead,
    });
  }

  notes.sort((a, b) => a.t - b.t);
  return { track, minute, bpm: style.bpm, chords, notes };
}
