import type { Note, Segment } from "./tracks";

/**
 * Plays a track minute by minute with the Web Audio API. It only ever plays
 * what `source` returns: a minute that has not been released (paid for and
 * checked by the server) is not there, and the player waits at its start.
 *
 * Pausing suspends the audio clock, so notes already scheduled resume exactly
 * where they stopped.
 */

/** How far ahead notes are scheduled; background tabs run timers about once a second. */
const LOOKAHEAD = 2;
const MINUTE = 60;

export type PlayerState = "paused" | "playing" | "waiting" | "ended";

export interface PlayerStatus {
  state: PlayerState;
  minute: number;
  /** Seconds into `minute`. */
  offset: number;
  chord?: string;
}

const mtof = (n: number) => 440 * 2 ** ((n - 69) / 12);

export class Player {
  private readonly ctx = new AudioContext();
  private readonly master: GainNode;
  private readonly echo: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly timer: ReturnType<typeof setInterval>;
  private state: PlayerState = "paused";
  private minute = 0;
  /** Audio-clock time at which `minute` began; NaN until it has. */
  private start = NaN;
  /** The next note to schedule. */
  private next = { minute: 0, i: 0 };

  /** Must be constructed in a click handler: browsers only start audio on a user gesture. */
  constructor(
    readonly track: string,
    private readonly source: (minute: number) => Segment | undefined,
    private readonly minutes: number,
  ) {
    const ctx = this.ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyser.smoothingTimeConstant = 0.8;
    const compressor = ctx.createDynamicsCompressor();
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(compressor).connect(this.analyser).connect(ctx.destination);

    // A dark feedback delay, for space.
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.42;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.38;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 1800;
    this.echo = ctx.createGain();
    this.echo.gain.value = 0.5;
    this.echo.connect(delay).connect(tone).connect(feedback).connect(delay);
    tone.connect(this.master);

    void ctx.suspend();
    this.timer = setInterval(() => this.tick(), 200);
  }

  play(): void {
    if (this.state === "ended" || this.state === "playing" || this.state === "waiting") return;
    if (Number.isNaN(this.start)) {
      this.state = "waiting"; // the minute starts once it is released
      this.tick();
    } else {
      this.state = "playing";
      void this.ctx.resume();
    }
  }

  pause(): void {
    if (this.state === "ended") return;
    this.state = "paused";
    void this.ctx.suspend();
  }

  dispose(): void {
    clearInterval(this.timer);
    void this.ctx.close();
  }

  status(): PlayerStatus {
    const offset = Number.isNaN(this.start) ? 0 : Math.min(MINUTE, Math.max(0, this.ctx.currentTime - this.start));
    const chord = this.source(this.minute)?.chords.filter((c) => c.t <= offset).pop()?.name;
    return { state: this.state, minute: this.minute, offset, ...(chord && { chord }) };
  }

  /** Loudness in `bands` frequency bands, 0–1 each. */
  levels(bands: number): number[] {
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return Array.from({ length: bands }, (_, b) => (data[b] ?? 0) / 255);
  }

  private tick(): void {
    if (this.state === "waiting") {
      if (!this.source(this.minute)) return;
      this.state = "playing";
      this.start = this.ctx.currentTime + 0.1;
      void this.ctx.resume();
    }
    if (this.state !== "playing") return;

    const now = this.ctx.currentTime;
    if (now >= this.start + MINUTE) {
      if (this.minute + 1 >= this.minutes) {
        this.state = "ended";
        void this.ctx.suspend();
        return;
      }
      this.minute++;
      this.start += MINUTE;
      if (!this.source(this.minute)) {
        // Not paid for (yet): stop the clock at the boundary.
        this.start = NaN;
        this.state = "waiting";
        void this.ctx.suspend();
        return;
      }
    }
    this.schedule(now + LOOKAHEAD);
  }

  /** Schedules every note starting before `horizon`, running into the next minute if it is released. */
  private schedule(horizon: number): void {
    for (;;) {
      if (this.next.minute < this.minute) this.next = { minute: this.minute, i: 0 };
      const { minute } = this.next;
      const segment = this.source(minute);
      if (!segment) return;
      const base = this.start + (minute - this.minute) * MINUTE;
      let { i } = this.next;
      while (i < segment.notes.length && base + segment.notes[i].t < horizon) this.voice(segment.notes[i++], base);
      this.next = { minute, i };
      if (i < segment.notes.length || base + MINUTE >= horizon || minute + 1 >= this.minutes) return;
      this.next = { minute: minute + 1, i: 0 };
    }
  }

  private voice(note: Note, base: number): void {
    const ctx = this.ctx;
    const t0 = Math.max(base + note.t, ctx.currentTime);
    const f = mtof(note.n);
    const env = ctx.createGain();
    env.gain.value = 0;
    env.connect(this.master);
    const oscs: OscillatorNode[] = [];
    const osc = (type: OscillatorType, freq: number, gain: number, to: AudioNode) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g).connect(to);
      oscs.push(o);
      return o;
    };
    let end: number;

    switch (note.voice) {
      case "pad": {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = 900;
        lp.connect(env);
        osc("triangle", f, 1, lp);
        osc("sawtooth", f * 1.004, 0.25, lp);
        osc("sawtooth", f * 0.996, 0.25, lp);
        const attack = Math.min(1.5, note.d / 3);
        end = t0 + note.d + 1.5;
        env.gain.setValueAtTime(0, t0);
        env.gain.linearRampToValueAtTime(note.v, t0 + attack);
        env.gain.setValueAtTime(note.v, t0 + note.d);
        env.gain.linearRampToValueAtTime(0, end);
        break;
      }
      case "bass": {
        osc("sine", f, 1, env);
        osc("triangle", f * 2, 0.15, env);
        end = t0 + note.d + 0.4;
        env.gain.setValueAtTime(0, t0);
        env.gain.linearRampToValueAtTime(note.v, t0 + 0.04);
        env.gain.setTargetAtTime(note.v * 0.6, t0 + 0.04, 0.4);
        env.gain.setTargetAtTime(0, t0 + note.d, 0.12);
        break;
      }
      case "bell": {
        osc("sine", f, 1, env);
        osc("sine", f * 2.76, 0.18, env);
        osc("sine", f * 5.4, 0.05, env);
        end = t0 + note.d + 2.5;
        env.gain.setValueAtTime(0, t0);
        env.gain.linearRampToValueAtTime(note.v, t0 + 0.005);
        env.gain.exponentialRampToValueAtTime(0.0001, end);
        env.connect(this.echo);
        break;
      }
      case "pluck": {
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 2;
        lp.frequency.setValueAtTime(3200, t0);
        lp.frequency.exponentialRampToValueAtTime(380, t0 + 0.5);
        lp.connect(env);
        osc("triangle", f, 1, lp);
        osc("square", f * 1.003, 0.12, lp);
        end = t0 + note.d + 0.8;
        env.gain.setValueAtTime(0, t0);
        env.gain.linearRampToValueAtTime(note.v, t0 + 0.004);
        env.gain.exponentialRampToValueAtTime(0.0001, end);
        env.connect(this.echo);
        break;
      }
    }

    for (const o of oscs) {
      o.start(t0);
      o.stop(end);
    }
    oscs[0].onended = () => env.disconnect();
  }
}
