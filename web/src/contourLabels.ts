import { EARTH_CIRCUMFERENCE } from "./surface";

/**
 * Elevation numbers on the ice surface contours.
 *
 * The contour lines themselves are drawn by the ice shader; here we find where
 * a sparse lattice of grid rows and columns crosses a contour level and draw
 * the level there on a 2D canvas above the map, projected at the height of
 * the ice surface. The lattice is anchored to the data grid, so labels stay
 * put while the map moves.
 */

export interface LabelInput {
  bed: Float32Array;
  /** extended thickness of the two frames around the current time, and their blend */
  a: Float32Array;
  b: Float32Array;
  mix: number;
  width: number;
  height: number;
  /** domain-local uv (+ mercator z) to clip space, as used by the ice shader */
  matrix: Float32Array;
  bounds: [number, number, number, number];
  exaggeration: number;
  /** uv rectangle on screen */
  view: [number, number, number, number];
}

const MIN_SPACING = 85; // CSS px between labels

export class ContourLabels {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;

  constructor(container: HTMLElement) {
    Object.assign(this.canvas.style, { position: "absolute", inset: "0", width: "100%", height: "100%", pointerEvents: "none" });
    container.append(this.canvas);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(input: LabelInput) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { bed, a, b, mix, width: W, height: H, matrix: m, bounds, view } = input;
    const x0 = Math.max(1, Math.floor(view[0] * W));
    const x1 = Math.min(W - 2, Math.ceil(view[2] * W));
    const y0 = Math.max(1, Math.floor(view[1] * H));
    const y1 = Math.min(H - 2, Math.ceil(view[3] * H));
    if (x1 <= x0 || y1 <= y0) return;

    // 100 m lines when zoomed in, the stronger 500 m lines otherwise (as in the shader)
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (bounds[1] + bounds[3])))) * 180) / Math.PI;
    const viewKm = (((x1 - x0) / W) * (bounds[2] - bounds[0]) * EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / 1000;
    const interval = viewKm < 140 ? 100 : 500;
    // lattice spacing: a power of two in data pixels, about 8 lines across the view
    const step = Math.max(2, 2 ** Math.round(Math.log2(Math.max(x1 - x0, y1 - y0) / 8)));

    const thk = (i: number) => a[i] + (b[i] - a[i]) * mix;
    const placed: [number, number][] = [];
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.fillStyle = "#1c4468";

    const place = (px: number, py: number, level: number) => {
      const u = (px + 0.5) / W;
      const v = (py + 0.5) / H;
      const my = bounds[1] + v * (bounds[3] - bounds[1]);
      const z = (level * input.exaggeration * Math.cosh(Math.PI * (1 - 2 * my))) / EARTH_CIRCUMFERENCE;
      const cw = m[3] * u + m[7] * v + m[11] * z + m[15];
      if (cw <= 0) return;
      const sx = ((m[0] * u + m[4] * v + m[8] * z + m[12]) / cw + 1) * 0.5 * cssW;
      const sy = (1 - (m[1] * u + m[5] * v + m[9] * z + m[13]) / cw) * 0.5 * cssH;
      if (sx < 20 || sx > cssW - 20 || sy < 20 || sy > cssH - 20) return;
      for (const [qx, qy] of placed) if (Math.hypot(qx - sx, qy - sy) < MIN_SPACING) return;
      placed.push([sx, sy]);
      const text = String(level);
      ctx.strokeText(text, sx, sy);
      ctx.fillText(text, sx, sy);
    };

    /** Walk along a lattice line and report contour crossings between neighbouring pixels. */
    const scan = (start: number, stride: number, count: number, px: number, py: number, dx: number, dy: number) => {
      let i = start;
      let t0 = thk(i);
      let s0 = bed[i] + t0;
      for (let k = 0; k < count; k++, i += stride) {
        const t1 = thk(i + stride);
        const s1 = bed[i + stride] + t1;
        if (t0 > 0 && t1 > 0) {
          const l0 = Math.floor(s0 / interval);
          const l1 = Math.floor(s1 / interval);
          if (l0 !== l1) {
            const level = Math.max(l0, l1) * interval;
            const f = (level - s0) / (s1 - s0);
            place(px + (k + f) * dx, py + (k + f) * dy, level);
          }
        }
        t0 = t1;
        s0 = s1;
      }
    };

    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) scan(y * W + x0, 1, x1 - x0, x0, y, 1, 0);
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) scan(y0 * W + x, W, y1 - y0, x, y0, 0, 1);
  }
}
