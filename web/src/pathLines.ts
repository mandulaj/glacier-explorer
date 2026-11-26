import { bindSurface, createProgram, SURFACE_GLSL, uniformLocations, type SurfaceState } from "./surface";

/** Lines lying on the ice surface (flow traces, section line). Translucent groups add up where paths overlap, showing density. */

const LIFT = 60; // metres above the ice

const VERT = `#version 300 es
precision highp float;
in vec4 a_segment; // from uv, to uv
${SURFACE_GLSL}
uniform vec2 u_viewport;
uniform float u_width;
void main() {
  float along = float(gl_VertexID & 1);
  float side = float(gl_VertexID >> 1) * 2.0 - 1.0;
  vec4 from = project(a_segment.xy, max(surface(a_segment.xy), texture(u_bed, a_segment.xy).r) + ${LIFT.toFixed(1)});
  vec4 to = project(a_segment.zw, max(surface(a_segment.zw), texture(u_bed, a_segment.zw).r) + ${LIFT.toFixed(1)});
  vec2 dir = (to.xy / to.w - from.xy / from.w) * u_viewport;
  float len = length(dir);
  vec2 normal = len > 1e-4 ? vec2(-dir.y, dir.x) / len : vec2(0.0);
  vec4 clip = along > 0.5 ? to : from;
  clip.xy += normal * side * u_width / u_viewport * clip.w;
  gl_Position = clip;
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec3 u_color;
uniform float u_alpha;
out vec4 fragColor;
void main() { fragColor = vec4(u_color * u_alpha, u_alpha); }`;

interface Group {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
  color: [number, number, number];
  alpha: number;
  width: number;
}

export interface PathGroup {
  /** one or more paths, each a flat list of uv points [u0, v0, u1, v1, ...] */
  paths: number[][];
  color: [number, number, number];
  alpha?: number;
  /** CSS px */
  width?: number;
}

export class PathLines {
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private groups: Group[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);
  }

  /** Replace all lines. */
  set(groups: PathGroup[]) {
    const gl = this.gl;
    for (const g of this.groups) {
      gl.deleteVertexArray(g.vao);
      gl.deleteBuffer(g.buffer);
    }
    this.groups = [];
    for (const group of groups) {
      const segments: number[] = [];
      for (const p of group.paths) for (let i = 0; i + 3 < p.length; i += 2) segments.push(p[i], p[i + 1], p[i + 2], p[i + 3]);
      if (!segments.length) continue;
      const vao = gl.createVertexArray()!;
      const buffer = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(segments), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.program, "a_segment");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, 1);
      gl.bindVertexArray(null);
      this.groups.push({ vao, buffer, count: segments.length / 4, color: group.color, alpha: group.alpha ?? 1, width: group.width ?? 2.2 });
    }
  }

  get empty() {
    return this.groups.length === 0;
  }

  render(gl: WebGL2RenderingContext, surface: SurfaceState) {
    if (this.empty) return;
    gl.useProgram(this.program);
    bindSurface(gl, this.uniforms, surface);
    gl.uniform2f(this.uniforms.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const g of this.groups) {
      gl.uniform3fv(this.uniforms.u_color, g.color);
      gl.uniform1f(this.uniforms.u_alpha, g.alpha);
      gl.uniform1f(this.uniforms.u_width, g.width * (window.devicePixelRatio || 1));
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
