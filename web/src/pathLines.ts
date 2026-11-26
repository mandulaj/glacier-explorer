import { bindSurface, createProgram, SURFACE_GLSL, uniformLocations, type SurfaceState } from "./surface";

/**
 * Paths lying on the ice surface: flow traces and the cross-section line.
 *
 * A group is either crisp (a plain line) or soft: a wide ribbon that fades
 * towards its edges. Many faint soft ribbons add up, so an ensemble of flow
 * paths reads as a density that is brightest where most paths run. Soft
 * groups can carry pulses that travel along the path to show the direction
 * of flow.
 */

const LIFT = 60; // metres above the ice

const VERT = `#version 300 es
precision highp float;
in vec4 a_segment; // from uv, to uv
in vec2 a_along;   // path length at both ends, in uv units
${SURFACE_GLSL}
uniform vec2 u_viewport;
uniform float u_width;
out float v_side;
out float v_along;
void main() {
  float end = float(gl_VertexID & 1);
  float side = float(gl_VertexID >> 1) * 2.0 - 1.0;
  vec4 from = project(a_segment.xy, max(surface(a_segment.xy), texture(u_bed, a_segment.xy).r) + ${LIFT.toFixed(1)});
  vec4 to = project(a_segment.zw, max(surface(a_segment.zw), texture(u_bed, a_segment.zw).r) + ${LIFT.toFixed(1)});
  vec2 dir = (to.xy / to.w - from.xy / from.w) * u_viewport;
  float len = length(dir);
  vec2 unit = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec4 clip = end > 0.5 ? to : from;
  // widen sideways, and lengthen a little so that neighbouring segments overlap at bends
  vec2 offset = vec2(-unit.y, unit.x) * side + unit * (end * 2.0 - 1.0) * 0.35;
  clip.xy += offset * u_width / u_viewport * clip.w;
  gl_Position = clip;
  v_side = side;
  v_along = mix(a_along.x, a_along.y, end);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_alpha;
uniform float u_soft;   // 0 = crisp line, 1 = ribbon fading to its edges
uniform vec3 u_pulse;   // period (uv units), phase, strength
in float v_side;
in float v_along;
out vec4 fragColor;
void main() {
  float across = mix(1.0, exp(-3.5 * v_side * v_side), u_soft);
  // a bright head with a fading tail, repeating along the path
  float wave = fract(v_along / u_pulse.x - u_pulse.y);
  float pulse = mix(1.0, 0.35 + 1.3 * wave * wave * wave, u_pulse.z);
  float alpha = clamp(u_alpha * across * pulse, 0.0, 1.0);
  fragColor = vec4(u_color * alpha, alpha);
}`;

export interface PathGroup {
  /** one or more paths, each a flat list of uv points [u0, v0, u1, v1, ...] */
  paths: number[][];
  color: [number, number, number];
  alpha?: number;
  /** half width in CSS px */
  width?: number;
  soft?: boolean;
  /** travelling pulses: distance between them (uv units) and direction along the path (+1 = towards its end) */
  pulse?: { period: number; direction: 1 | -1 };
}

interface Group {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
  options: PathGroup;
}

export class PathLines {
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private groups: Group[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);
  }

  /** Replace all paths. */
  set(groups: PathGroup[]) {
    const gl = this.gl;
    for (const g of this.groups) {
      gl.deleteVertexArray(g.vao);
      gl.deleteBuffer(g.buffer);
    }
    this.groups = [];
    for (const options of groups) {
      const data: number[] = []; // per segment: from uv, to uv, length at from, length at to
      for (const p of options.paths) {
        let along = 0;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const next = along + Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
          data.push(p[i], p[i + 1], p[i + 2], p[i + 3], along, next);
          along = next;
        }
      }
      if (!data.length) continue;
      const vao = gl.createVertexArray()!;
      const buffer = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const attribute = (name: string, size: number, offset: number) => {
        const loc = gl.getAttribLocation(this.program, name);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 24, offset);
        gl.vertexAttribDivisor(loc, 1);
      };
      attribute("a_segment", 4, 0);
      attribute("a_along", 2, 16);
      gl.bindVertexArray(null);
      this.groups.push({ vao, buffer, count: data.length / 6, options });
    }
  }

  get empty() {
    return this.groups.length === 0;
  }

  /** Whether the scene has to be redrawn every frame. */
  get animated() {
    return this.groups.some((g) => g.options.pulse);
  }

  render(gl: WebGL2RenderingContext, surface: SurfaceState) {
    if (this.empty) return;
    const u = this.uniforms;
    const seconds = (performance.now() / 1000) % 1000;
    gl.useProgram(this.program);
    bindSurface(gl, u, surface);
    gl.uniform2f(u.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const g of this.groups) {
      const o = g.options;
      gl.uniform3fv(u.u_color, o.color);
      gl.uniform1f(u.u_alpha, o.alpha ?? 1);
      gl.uniform1f(u.u_width, (o.width ?? 1.2) * (window.devicePixelRatio || 1));
      gl.uniform1f(u.u_soft, o.soft ? 1 : 0);
      // about one pulse every two seconds passes any point
      gl.uniform3f(u.u_pulse, o.pulse?.period ?? 1, o.pulse ? seconds * 0.5 * o.pulse.direction : 0, o.pulse ? 1 : 0);
      gl.bindVertexArray(g.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.count);
    }
    gl.bindVertexArray(null);
  }

  dispose() {
    this.set([]);
    this.gl.deleteProgram(this.program);
  }
}
