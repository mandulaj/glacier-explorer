import type { TimeSeries } from "./data";

/** Bottom time slider: old (left) to present (right), ice-volume curve as backdrop. */
export class TimeBar {
  private slider = document.getElementById("time") as HTMLInputElement;
  private playButton = document.getElementById("play") as HTMLButtonElement;
  private speed = document.getElementById("speed") as HTMLSelectElement;
  private label = document.getElementById("age-label")!;
  private sub = document.getElementById("age-sub")!;
  private canvas = document.getElementById("curve") as HTMLCanvasElement;
  private playing = false;
  private last = 0;

  constructor(
    private maxAge: number,
    private series: TimeSeries,
    initialAge: number,
    private onChange: (age: number) => void,
  ) {
    this.slider.max = String(maxAge);
    this.slider.value = String(maxAge - initialAge);
    this.slider.addEventListener("input", () => this.emit());
    this.playButton.addEventListener("click", () => this.toggle());
    window.addEventListener("keydown", (e) => {
      // Space is "fly up" (see fly.ts), so playback is on P
      if (e.code === "KeyP" && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
    });
    new ResizeObserver(() => this.drawCurve()).observe(this.canvas);
    this.drawTicks();
    this.emit();
  }

  get age() {
    return this.maxAge - Number(this.slider.value);
  }

  set age(age: number) {
    this.slider.value = String(this.maxAge - age);
    this.emit();
  }

  private emit() {
    const age = this.age;
    this.label.textContent = age < 0.05 ? "Present" : `${age.toFixed(1)} ka`;
    this.sub.textContent = age < 0.05 ? "model state" : `${Math.round(age * 1000).toLocaleString("en")} years ago`;
    this.onChange(age);
  }

  private toggle() {
    this.playing = !this.playing;
    this.playButton.textContent = this.playing ? "❚❚" : "▶";
    this.playButton.setAttribute("aria-label", this.playing ? "Pause" : "Play");
    if (this.playing) {
      if (this.age <= 0.01) this.age = this.maxAge;
      this.last = performance.now();
      requestAnimationFrame((t) => this.tick(t));
    }
  }

  private tick(now: number) {
    if (!this.playing) return;
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    const next = this.age - dt * Number(this.speed.value);
    if (next <= 0) {
      this.age = 0;
      this.toggle();
      return;
    }
    this.age = next;
    requestAnimationFrame((t) => this.tick(t));
  }

  private drawTicks() {
    const ticks = document.getElementById("ticks")!;
    for (let age = 0; age <= this.maxAge; age += 20) {
      const span = document.createElement("span");
      span.style.left = `${(1 - age / this.maxAge) * 100}%`;
      span.textContent = age === 0 ? "today" : `${age} ka`;
      if (age === 0) span.style.transform = "translateX(-100%)";
      ticks.append(span);
    }
  }

  private drawCurve() {
    const { canvas, series, maxAge } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = Math.round(canvas.clientWidth * dpr));
    const h = (canvas.height = Math.round(canvas.clientHeight * dpr));
    const ctx = canvas.getContext("2d")!;
    const peak = Math.max(...series.slvol);
    ctx.beginPath();
    ctx.moveTo(0, h);
    series.age.forEach((age, i) => ctx.lineTo((1 - age / maxAge) * w, h - (series.slvol[i] / peak) * (h - 4 * dpr)));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = "rgba(96, 160, 214, 0.45)";
    ctx.fill();
    ctx.strokeStyle = "rgba(31, 111, 178, 0.9)";
    ctx.lineWidth = dpr;
    ctx.stroke();
  }
}
