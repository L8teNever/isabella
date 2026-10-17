// Audio: AudioBuffer komplett vorab dekodieren, mit AudioBufferSourceNode abspielen.
// Einzige Zeitquelle ist die Audio-Uhr (audioContext.currentTime bzw. getOutputTimestamp fuer
// Bild-genaue Interpolation). Ausgabe-Latenz und Kalibrierung werden abgezogen.
import { settings } from '../settings';

// ---------- Verfehlt = stumm: Musik setzt am verfehlten Block kurz aus ----------
export const MUTE_LEVEL = 0;          // Lautstaerke waehrend des Aussetzers (0 = ganz stumm)
export const MUTE_HOLD = 0.16;        // Sekunden, die die Musik aussetzt
export const MUTE_FADE = 0.004;       // Ein-/Ausblend-Zeitkonstante (s) gegen Knacksen
export const MUTE_BACK = 0.025;       // Zeitkonstante fuers Wiederkommen (s)
/** Treffer-Sound auf den Notenzeitpunkt legen, solange der Treffer hoechstens so weit (s) daneben liegt */
export const HIT_SOUND_SNAP = 0.1;

export class AudioPlayer {
  ctx: AudioContext;
  gain: GainNode;
  /** nur die Musik (fuer Aussetzer), Effekte laufen ueber gain */
  music: GainNode;
  buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private startCtx = 0;        // Kontext-Zeit, zu der Songzeit 0 erklingt (ohne Latenz)
  private pausedAt = 0;
  playing = false;
  onEnded: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination);
    this.music = this.ctx.createGain(); this.music.connect(this.gain);
    this.setVolume(settings.volume);
  }

  setVolume(v: number) { this.gain.gain.value = Math.max(0, Math.min(1, v)); }
  async resume() { if (this.ctx.state !== 'running') await this.ctx.resume(); }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    this.buffer = await this.ctx.decodeAudioData(data.slice(0));
    return this.buffer;
  }

  /** Startet bei Songzeit `from`, mit Vorlauf `lead` Sekunden (Songzeit laeuft im Vorlauf negativ) */
  play(from = 0, lead = 0) {
    if (!this.buffer) return;
    this.stopSource();
    const src = this.ctx.createBufferSource(); src.buffer = this.buffer; src.connect(this.music);
    this.unmute(true);
    const when = this.ctx.currentTime + 0.05 + lead;
    this.startCtx = when - from;
    src.start(when, Math.max(0, from));
    src.onended = () => { if (this.src === src && this.playing) { this.playing = false; this.onEnded?.(); } };
    this.src = src; this.playing = true;
  }

  /**
   * Gemeinsamer Start (Duett): Songposition `from` soll zur lokalen Zeit `perfMs` (performance.now) ZU HOEREN sein.
   * Ausgabe-Latenz (outputDelay) und Kalibrierung (latencyMs) werden vorgezogen, damit zwei Geraete denselben Takt
   * gleichzeitig hoeren. Liegt der Zeitpunkt schon in der Vergangenheit (Wiedereinstieg), geht es an der passenden
   * Stelle weiter.
   */
  playAt(perfMs: number, from = 0) {
    if (!this.buffer) return;
    this.stopSource();
    const now = this.ctx.currentTime;
    // Kontextzeit, deren Sample zu perfMs am Ausgang ankommt
    let when = now + (perfMs - performance.now()) / 1000 - this.outputDelay() - settings.latencyMs / 1000;
    let off = from;
    if (when < now + 0.02) { off += now + 0.02 - when; when = now + 0.02; }
    this.startCtx = when - off;
    const src = this.ctx.createBufferSource(); src.buffer = this.buffer; src.connect(this.music);
    this.unmute(true);
    // vor Songbeginn (off < 0): erst spaeter einsetzen, Songzeit laeuft solange negativ
    src.start(Math.max(when, this.startCtx), Math.max(0, off));
    src.onended = () => { if (this.src === src && this.playing) { this.playing = false; this.onEnded?.(); } };
    this.src = src; this.playing = true;
  }

  pause() { if (!this.playing) return; this.unmute(true); this.pausedAt = this.rawTime(); this.stopSource(); this.playing = false; }
  /** nach Pause: kurzer Vorlauf (Countdown) */
  resumeFrom(lead = 3) { this.play(this.pausedAt, lead); }
  stop() { this.stopSource(); this.playing = false; this.pausedAt = 0; }
  private stopSource() { if (this.src) { this.src.onended = null; try { this.src.stop(); } catch { /* schon gestoppt */ } this.src.disconnect(); this.src = null; } }

  /** Verfehlt = stumm: Musik ab sofort fuer MUTE_HOLD aussetzen (erst wenn der Fehler feststeht, nie vorab) */
  muteNow() { if (this.playing) this.muteAt(this.rawTime()); }

  /** Musik an Songposition p (Sekunden im Song) fuer MUTE_HOLD aussetzen */
  muteAt(p: number) {
    const g = this.music.gain, now = this.ctx.currentTime;
    const at = Math.max(now, this.startCtx + p - 0.01);
    g.cancelScheduledValues(now); g.setValueAtTime(g.value, now);
    g.setTargetAtTime(MUTE_LEVEL, at, MUTE_FADE);
    g.setTargetAtTime(1, at + MUTE_HOLD, MUTE_BACK);
  }

  /** Aussetzer abbrechen (Block doch noch getroffen) */
  unmute(hard = false) {
    const g = this.music.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    if (hard) g.setValueAtTime(1, now); else { g.setValueAtTime(g.value, now); g.setTargetAtTime(1, now, MUTE_FADE); }
  }

  /** Songzeit ohne Latenzkorrektur */
  rawTime(): number { return this.playing ? this.ctx.currentTime - this.startCtx : this.pausedAt; }

  /**
   * Einzige Latenz-Quelle (Spiel UND Kalibrierung): wie weit (s) das gerade Gehoerte hinter der Kontextzeit liegt.
   * getOutputTimestamp liefert die Zeit am Ausgang; sonst Ausgabe- plus Verarbeitungs-Latenz.
   */
  outputDelay(): number {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime) {
      const heard = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      return Math.max(0, this.ctx.currentTime - heard);
    }
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  /** Songzeit, die der Spieler gerade HOERT: Kontextzeit minus Ausgabe-Latenz minus Startzeit minus Kalibrierung */
  songTime(): number {
    if (!this.playing) return this.pausedAt - settings.latencyMs / 1000;
    return this.ctx.currentTime - this.outputDelay() - this.startCtx - settings.latencyMs / 1000;
  }

  get duration() { return this.buffer?.duration ?? 0; }

  /** kurzer Klick (Metronom/Kalibrierung) zur Kontextzeit at */
  click(at: number, freq = 1200, gain = 0.4) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = freq; g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    o.connect(g).connect(this.gain); o.start(at); o.stop(at + 0.07);
  }

  /** Combo-Meilenstein: kurzer aufsteigender Akkord */
  chime(level = 1) {
    const t = this.ctx.currentTime, base = 523.25 * (1 + level * 0.5);
    [1, 1.25, 1.5, 2].forEach((m, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'triangle'; o.frequency.value = base * m;
      const at = t + i * 0.06;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.18, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.connect(g).connect(this.gain); o.start(at); o.stop(at + 0.4);
    });
  }

  /** Combo gerissen: tiefer, kurzer Ton nach unten */
  comboBreak() {
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    g.gain.setValueAtTime(0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g).connect(this.gain); o.start(t); o.stop(t + 0.4);
  }

  /** kurzer Schnitt-Sound; mit noteT erklingt er genau mit der Musik an dieser Songzeit (wenn der Treffer nah dran war) */
  slice(intensity = 1, noteT?: number) {
    let t = this.ctx.currentTime;
    if (noteT !== undefined && this.playing && Math.abs(this.songTime() - noteT) <= HIT_SOUND_SNAP) {
      // das Musik-Sample der Songzeit noteT wird zur Kontextzeit startCtx + noteT ausgegeben
      t = Math.max(t, this.startCtx + noteT);
    }
    const len = 0.08;
    const b = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * len), this.ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.25));
    const s = this.ctx.createBufferSource(); s.buffer = b;
    const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
    const g = this.ctx.createGain(); g.gain.value = 0.18 * intensity;
    s.connect(f).connect(g).connect(this.gain); s.start(t);
  }
}
