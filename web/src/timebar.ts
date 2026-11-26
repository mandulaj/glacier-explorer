import type { TimeSeries } from "./data";
import { EVENTS, periodAt, PERIODS, type Period, type TimelineEvent } from "./timeline";

/** Bottom time slider: old (left) to present (right), ice-volume curve as backdrop. */
export class TimeBar {
  private slider = document.getElementById("time") as HTMLInputElement;
  private playButton = document.getElementById("play") as HTMLButtonElement;
  private speed = document.getElementById("speed") as HTMLSelectElement;
  private label = document.getElementById("age-label")!;
  private sub = document.getElementById("age-sub")!;
  private period = document.getElementById("age-period")!;
  private tip = document.getElementById("event-tip")!;
  private markers: { event: TimelineEvent; button: HTMLButtonElement }[] = [];
  /** event or period under the pointer (or keyboard focus); wins over the event the slider is passing */
  private hovered: TimelineEvent | Period | null = null;
  private hideTimer = 0;
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
    this.buildTimeline();
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
    const period = periodAt(age);
    this.period.textContent = period?.name ?? "";
    this.period.title = period?.name ?? "";
    this.updateTip();
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

  /** Period bands along the top and clickable event markers. */
  private buildTimeline() {
    const left = (age: number) => (1 - Math.min(age, this.maxAge) / this.maxAge) * 100;

    // the bubble holds a link, so it must stay open while the pointer travels to it
    const hover = (item: TimelineEvent | Period | null) => () => {
      clearTimeout(this.hideTimer);
      if (item) {
        this.hovered = item;
        this.updateTip();
      } else {
        this.hideTimer = window.setTimeout(() => {
          this.hovered = null;
          this.updateTip();
        }, 300);
      }
    };
    const bind = (el: HTMLElement, item: TimelineEvent | Period) => {
      el.addEventListener("pointerenter", hover(item));
      el.addEventListener("pointerleave", hover(null));
      el.addEventListener("focus", hover(item));
      el.addEventListener("blur", hover(null));
    };
    this.tip.addEventListener("pointerenter", () => clearTimeout(this.hideTimer));
    this.tip.addEventListener("pointerleave", hover(null));

    const periods = document.getElementById("periods")!;
    for (const p of PERIODS) {
      const span = document.createElement("span");
      const width = left(p.to) - left(p.from);
      span.style.left = `${left(p.from)}%`;
      span.style.width = `${width}%`;
      span.style.background = p.color;
      span.textContent = width > 22 ? p.name : width > 4 ? p.short : "";
      bind(span, p);
      periods.append(span);
    }

    const events = document.getElementById("events")!;
    for (const event of EVENTS) {
      const button = document.createElement("button");
      button.type = "button";
      button.style.left = `${left(event.age)}%`;
      button.setAttribute("aria-label", `${event.title}, ${event.age} thousand years ago`);
      button.addEventListener("click", () => (this.age = event.age));
      bind(button, event);
      events.append(button);
      this.markers.push({ event, button });
    }
  }

  /** Show the hovered event or period, or the event the slider is passing. */
  private updateTip() {
    const age = this.age;
    const near = this.markers.reduce<TimelineEvent | null>(
      (best, m) => (Math.abs(m.event.age - age) < 0.6 && (!best || Math.abs(m.event.age - age) < Math.abs(best.age - age)) ? m.event : best),
      null,
    );
    const shown = this.hovered ?? near;
    for (const m of this.markers) m.button.classList.toggle("active", m.event === shown);
    this.tip.hidden = !shown;
    if (!shown) return;

    const isEvent = "age" in shown;
    const title = document.createElement("strong");
    title.textContent = isEvent ? shown.title : shown.name;
    const when = document.createElement("em");
    const years = (ka: number) => (ka * 1000).toLocaleString("en");
    when.textContent = isEvent ? `about ${years(shown.age)} years ago` : `${years(shown.from)} to ${shown.to === 0 ? "today" : `${years(shown.to)} years ago`}`;
    const parts: (Node | string)[] = [title, when];
    if (shown.detail) parts.push(document.createElement("br"), shown.detail);
    if (shown.sources?.length) {
      parts.push(document.createElement("br"), shown.sources.length > 1 ? "Sources: " : "Source: ");
      shown.sources.forEach((source, i) => {
        const link = document.createElement("a");
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = source.label;
        parts.push(...(i ? ["; ", link] : [link]));
      });
    }
    this.tip.replaceChildren(...parts);

    // keep the bubble inside the track
    const track = this.tip.parentElement!.clientWidth;
    const centre = isEvent ? shown.age : (Math.min(shown.from, this.maxAge) + shown.to) / 2;
    const x = (1 - centre / this.maxAge) * track;
    this.tip.style.left = `${Math.min(Math.max(x - 125, 0), Math.max(track - 250, 0))}px`;
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
