/**
 * What anyone can see before paying. The music itself is composed by
 * compose.ts, which only the server route imports: each minute's score is sent
 * after its payment has been checked on-chain.
 */
export interface Track {
  id: string;
  title: string;
  mood: string;
}

export const TRACKS: Track[] = [
  { id: "tide", title: "Tide tables", mood: "D dorian · 64 bpm · slow pads and bells" },
  { id: "lantern", title: "Lantern hours", mood: "A aeolian · 72 bpm · plucked, a little busier" },
  { id: "quarry", title: "Quarry light", mood: "F lydian · 56 bpm · sparse, low and wide" },
];

export type Voice = "pad" | "bass" | "bell" | "pluck";

/** One note: `t` seconds into the minute, `d` seconds long, MIDI note `n`, velocity `v` (0–1). */
export interface Note {
  t: number;
  d: number;
  n: number;
  v: number;
  voice: Voice;
}

/** One paid minute of a track: everything the browser needs to play it. */
export interface Segment {
  track: string;
  minute: number;
  bpm: number;
  chords: { t: number; name: string }[];
  notes: Note[];
}
