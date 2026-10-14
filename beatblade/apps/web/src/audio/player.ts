// Audio: AudioBuffer komplett vorab dekodieren, mit AudioBufferSourceNode abspielen.
// Einzige Zeitquelle ist die Audio-Uhr (audioContext.currentTime bzw. getOutputTimestamp fuer
// Bild-genaue Interpolation). Ausgabe-Latenz und Kalibrierung werden abgezogen.
import { settings } from '../settings';

export class AudioPlayer {
  ctx: AudioContext;
  gain: GainNode;
  buffer: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  private startCtx = 0;        // Kontext-Zeit, zu der Songzeit 0 erklingt (ohne Latenz)
  private pausedAt = 0;
  playing = false;
  onEnded: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination);
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
    const src = this.ctx.createBufferSource(); src.buffer = this.buffer; src.connect(this.gain);
    const when = this.ctx.currentTime + 0.05 + lead;
    this.startCtx = when - from;
    src.start(when, Math.max(0, from));
    src.onended = () => { if (this.src === src && this.playing) { this.playing = false; this.onEnded?.(); } };
    this.src = src; this.playing = true;
  }

  pause() { if (!this.playing) return; this.pausedAt = this.rawTime(); this.stopSource(); this.playing = false; }
  /** nach Pause: kurzer Vorlauf (Countdown) */
  resumeFrom(lead = 3) { this.play(this.pausedAt, lead); }
  stop() { this.stopSource(); this.playing = false; this.pausedAt = 0; }
  private stopSource() { if (this.src) { this.src.onended = null; try { this.src.stop(); } catch { /* schon gestoppt */ } this.src.disconnect(); this.src = null; } }

  /** Songzeit ohne Latenzkorrektur */
  rawTime(): number { return this.playing ? this.ctx.currentTime - this.startCtx : this.pausedAt; }

  /**
   * Songzeit, die der Spieler gerade HOERT: Kontextzeit minus Startzeit minus Ausgabe-Latenz minus
   * Kalibrierung. getOutputTimestamp liefert bereits die Zeit am Ausgang; sonst outputLatency abziehen.
   */
  songTime(): number {
    if (!this.playing) return this.pausedAt - settings.latencyMs / 1000;
    const ts = this.ctx.getOutputTimestamp?.();
    let heard: number;
    if (ts && ts.contextTime !== undefined && ts.performanceTime) heard = ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    else heard = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    return heard - this.startCtx - settings.latencyMs / 1000;
  }

  get duration() { return this.buffer?.duration ?? 0; }

  /** kurzer Klick (Metronom/Kalibrierung) zur Kontextzeit at */
  click(at: number, freq = 1200, gain = 0.4) {
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.value = freq; g.gain.setValueAtTime(gain, at); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
    o.connect(g).connect(this.gain); o.start(at); o.stop(at + 0.07);
  }

  /** kurzer Schnitt-Sound */
  slice(intensity = 1) {
    const t = this.ctx.currentTime, len = 0.08;
    const b = this.ctx.createBuffer(1, Math.floor(this.ctx.sampleRate * len), this.ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.25));
    const s = this.ctx.createBufferSource(); s.buffer = b;
    const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
    const g = this.ctx.createGain(); g.gain.value = 0.18 * intensity;
    s.connect(f).connect(g).connect(this.gain); s.start(t);
  }
}
