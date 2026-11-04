// One Euro Filter (Casiez et al. 2012)
// 静止時は強く平滑化し、速く動くほどカットオフを上げて遅れを減らす。

function alpha(cutoff: number, dt: number) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  constructor(
    public minCutoff = 1,
    public beta = 0,
    public dCutoff = 1,
  ) {}

  reset() {
    this.x = null;
    this.dx = 0;
  }

  /** @param t 秒 */
  filter(value: number, t: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = t;
      return value;
    }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  /** 平滑化した速度 (単位/秒) */
  get velocity() {
    return this.dx;
  }
}
