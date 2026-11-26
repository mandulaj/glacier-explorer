import type { FrameRef } from "./data";

export interface FramePair<T> {
  a: T;
  b: T;
  /** blend factor from a (older) to b (younger) */
  mix: number;
  /** frame indices, useful as cache keys */
  i0: number;
  i1: number;
}

/**
 * Time-ordered frames (old to young) that are fetched lazily and cached.
 * `pair(age)` returns the two frames around a time; while those are still
 * loading it keeps returning the last complete pair so the display never blanks.
 */
export class FrameSet<T> {
  private data = new Map<number, T>();
  private pending = new Set<number>();
  private last: FramePair<T> | null = null;

  constructor(
    readonly frames: FrameRef[],
    private loader: (file: string) => Promise<T>,
    private onLoad: () => void,
    /** decoded frames kept in memory (each is several MB) */
    private max = 40,
  ) {}

  private touch(i: number): T | undefined {
    const d = this.data.get(i);
    if (d !== undefined) {
      this.data.delete(i); // move to the young end of the LRU order
      this.data.set(i, d);
    }
    return d;
  }

  bracket(age: number) {
    const f = this.frames;
    let i0 = 0;
    while (i0 < f.length - 2 && f[i0 + 1].age >= age) i0++;
    const i1 = Math.min(i0 + 1, f.length - 1);
    const span = f[i0].age - f[i1].age;
    const mix = span > 0 ? Math.min(Math.max((f[i0].age - age) / span, 0), 1) : 0;
    return { i0, i1, mix };
  }

  /** Start loading the frames around `age` (and a little ahead, for playback). */
  request(age: number) {
    const { i0, i1 } = this.bracket(age);
    for (const i of [i0, i1, i1 + 1, i0 - 1, i1 + 2]) this.load(i);
  }

  /** The exact pair around `age` if both frames are already loaded, without triggering any loading. */
  peek(age: number): FramePair<T> | null {
    const { i0, i1, mix } = this.bracket(age);
    const a = this.touch(i0);
    const b = this.touch(i1);
    return a && b ? { a, b, mix, i0, i1 } : null;
  }

  pair(age: number): FramePair<T> | null {
    const { i0, i1, mix } = this.bracket(age);
    const a = this.touch(i0);
    const b = this.touch(i1);
    if (a && b) this.last = { a, b, mix, i0, i1 };
    else this.request(age);
    return this.last;
  }

  private load(i: number) {
    if (i < 0 || i >= this.frames.length || this.data.has(i) || this.pending.has(i)) return;
    this.pending.add(i);
    this.loader(this.frames[i].file)
      .then((d) => {
        this.data.set(i, d);
        if (this.data.size > this.max) this.data.delete(this.data.keys().next().value!);
        this.onLoad();
      })
      .catch((e) => console.error(e))
      .finally(() => this.pending.delete(i));
  }
}

/** Small LRU cache of GPU textures keyed by frame index. */
export class TextureCache<T> {
  private textures = new Map<number, WebGLTexture>();

  constructor(
    private gl: WebGL2RenderingContext,
    private upload: (data: T) => WebGLTexture,
    private max = 12,
  ) {}

  get(index: number, data: T): WebGLTexture {
    let tex = this.textures.get(index);
    if (tex) {
      this.textures.delete(index);
    } else {
      tex = this.upload(data);
      if (this.textures.size >= this.max) {
        const [oldest, old] = this.textures.entries().next().value!;
        this.gl.deleteTexture(old);
        this.textures.delete(oldest);
      }
    }
    this.textures.set(index, tex);
    return tex;
  }

  dispose() {
    for (const tex of this.textures.values()) this.gl.deleteTexture(tex);
    this.textures.clear();
  }
}
