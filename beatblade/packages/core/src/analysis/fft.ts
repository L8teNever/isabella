// Radix-2-FFT (in-place, reell -> komplex) mit vorberechneten Twiddle-Faktoren.

export class FFT {
  readonly n: number;
  private cos: Float64Array;
  private sin: Float64Array;
  private rev: Uint32Array;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(n: number) {
    if (n & (n - 1)) throw new Error('FFT-Groesse muss eine Zweierpotenz sein');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos((2 * Math.PI * i) / n); this.sin[i] = -Math.sin((2 * Math.PI * i) / n); }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** Transformiert input (Laenge n) – Ergebnis in this.re / this.im */
  forward(input: ArrayLike<number>): void {
    const { n, re, im, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const tr = cos[k * step], ti = sin[k * step];
          const a = start + k, b = a + half;
          const xr = re[b] * tr - im[b] * ti, xi = re[b] * ti + im[b] * tr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /** Betragsspektrum (n/2+1 Werte) in out schreiben */
  magnitude(out: Float32Array): void {
    const { re, im } = this;
    for (let i = 0; i < out.length; i++) out[i] = Math.hypot(re[i], im[i]);
  }
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
