import { bindSurface, createProgram, SURFACE_GLSL, uniformLocations, type SurfaceState } from "./surface";

/** Thick lines lying on the ice surface (flow traces). Each group has one colour. */

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
out vec4 fragColor;
void main() { fragColor = vec4(u_color, 1.0); }`;

interface Group {
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  count: number;
  color: [number, number, number];
}

export class PathLines {
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private groups: Group[] = [];

  constructor(private gl: WebGL2RenderingContext) {
    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);
  }

  /** Replace all lines. Each path is a flat list of uv points [u0, v0, u1, v1, ...]. */
  set(paths: { points: number[]; color: [number, number, number] }[]) {
    const gl = this.gl;
    for (const g of this.groups) {
      gl.deleteVertexArray(g.vao);
      gl.deleteBuffer(g.buffer);
    }
    this.groups = paths
      .filter((p) => p.points.length >= 4)
      .map((p) => {
        const n = p.points.length / 2 - 1;
        const data = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) data.set(p.points.slice(i * 2, i * 2 + 4), i * 4);
        const vao = gl.createVertexArray()!;
        const buffer = gl.createBuffer()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(this.program, "a_segment");
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(loc, 1);
        gl.bindVertexArray(null);
        return { vao, buffer, count: n, color: p.color };
      });
  }

  get empty() {
    return this.groups.length === 0;
  }

  render(gl: WebGL2RenderingContext, surface: SurfaceState) {
    if (this.empty) return;
    gl.useProgram(this.program);
    bindSurface(gl, this.uniforms, surface);
    gl.uniform2f(this.uniforms.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uniforms.u_width, 2.2 * (window.devicePixelRatio || 1));
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.disable(gl.BLEND);
    for (const g of this.groups) {
      gl.uniform3fv(this.uniforms.u_color, g.color);
      gl.bindVertexArray(g.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.count);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
  }

  dispose() {
    this.set([]);
    this.gl.deleteProgram(this.program);
  }
}
