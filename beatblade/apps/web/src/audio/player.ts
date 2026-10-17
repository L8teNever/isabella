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

// ---------- Duett: Spiel des Partners hoeren (Raumklang von seiner Position) ----------
/** Treffer des Partners leiser als eigene, Fehler gut hoerbar (mal Einstellung „Partner hören“) */
export const PARTNER_HIT_VOLUME = 0.3;
export const PARTNER_MISS_VOLUME = 1;
/** kommt ein Ereignis spaeter an als seine Songzeit: hoechstens so viel (s) zu spaet spielen, sonst verwerfen */
export const PARTNER_LATE_MAX = 0.3;

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
  /** Partner-Kanal: GainNode + PannerNode (HRTF) */
  partnerBus: GainNode;
  partnerPan: PannerNode;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination);
    this.music = this.ctx.createGain(); this.music.connect(this.gain);
    this.setVolume(settings.volume);
    this.partnerPan = this.ctx.createPanner();
    Object.assign(this.partnerPan, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, maxDistance: 20, rolloffFactor: 0.6 });
    this.partnerBus = this.ctx.createGain();
    this.partnerBus.connect(this.partnerPan).connect(this.gain);
  }

  /** Zuhoerer = eigener Kopf (Spielfeld-Koordinaten), Quelle = Partner-Charakter */
  setSpatial(head: { x: number; y: number; z: number }, fwd: { x: number; y: number; z: number }, up: { x: number; y: number; z: number }, src: { x: number; y: number; z: number }) {
    const L = this.ctx.listener, t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setValueAtTime(head.x, t); L.positionY.setValueAtTime(head.y, t); L.positionZ.setValueAtTime(head.z, t);
      L.forwardX.setValueAtTime(fwd.x, t); L.forwardY.setValueAtTime(fwd.y, t); L.forwardZ.setValueAtTime(fwd.z, t);
      L.upX.setValueAtTime(up.x, t); L.upY.setValueAtTime(up.y, t); L.upZ.setValueAtTime(up.z, t);
    } else { L.setPosition(head.x, head.y, head.z); L.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z); }
    const P = this.partnerPan;
    if (P.positionX) { P.positionX.setValueAtTime(src.x, t); P.positionY.setValueAtTime(src.y, t); P.positionZ.setValueAtTime(src.z, t); }
    else P.setPosition(src.x, src.y, src.z);
  }

  /**
   * Ereignis des Partners (Treffer, Fehler ...) zu seiner Songzeit `at` abspielen: liegt sie noch vor uns, genau dann;
   * ist sie hoechstens PARTNER_LATE_MAX vorbei, sofort; sonst verwerfen (keine Ton-Lawine nach einem Haenger).
   * Gibt zurueck, ob gespielt wird.
   */
  partnerSound(kind: string, at: number, volume: number): boolean {
    if (volume <= 0) return false;
    const now = this.ctx.currentTime;
    let t = this.playing ? this.startCtx + at : now;
    if (t < now) { if (now - t > PARTNER_LATE_MAX) return false; t = now; }
    const v = volume * (kind === 'hit' || kind === 'combo' ? PARTNER_HIT_VOLUME : PARTNER_MISS_VOLUME);
    const out = this.partnerBus;
    const tone = (type: OscillatorType, f0: number, f1: number, dur: number, g0: number, at0 = t) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), lp = this.ctx.createBiquadFilter();
      o.type = type; o.frequency.setValueAtTime(f0, at0); o.frequency.exponentialRampToValueAtTime(f1, at0 + dur);
      lp.type = 'lowpass'; lp.frequency.value = 900;
      g.gain.setValueAtTime(g0 * v, at0); g.gain.exponentialRampToValueAtTime(0.0001, at0 + dur);
      o.connect(lp).connect(g).connect(out); o.start(at0); o.stop(at0 + dur + 0.02);
    };
    const noise = (dur: number, freq: number, type: BiquadFilterType, g0: number) => {
      const b = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * dur), this.ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.3));
      const src = this.ctx.createBufferSource(); src.buffer = b;
      const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
      const g = this.ctx.createGain(); g.gain.value = g0 * v;
      src.connect(f).connect(g).connect(out); src.start(t);
    };
    switch (kind) {
      case 'hit': noise(0.06, 3000, 'highpass', 0.5); break;
      // dumpfer Fehl-Ton (anders als der eigene Combo-Bruch)
      case 'miss': tone('sine', 150, 55, 0.28, 0.9); noise(0.12, 300, 'lowpass', 0.5); break;
      case 'badcut': tone('square', 190, 120, 0.09, 0.35); tone('square', 160, 100, 0.12, 0.35, t + 0.11); break;
      case 'bomb': noise(0.35, 380, 'lowpass', 1.2); break;
      case 'wall': tone('sawtooth', 95, 70, 0.3, 0.45); break;
      case 'railLost': tone('triangle', 420, 140, 0.35, 0.6); break;
      case 'combo': tone('triangle', 660, 660, 0.14, 0.4); tone('triangle', 990, 990, 0.2, 0.35, t + 0.08); break;
    }
    return true;
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
