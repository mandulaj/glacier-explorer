import type { FeatureCollection, Point } from "geojson";
import { fetchBytes, type Manifest } from "./data";
import { bindSurface, createProgram, SURFACE_GLSL, uniformLocations, type SurfaceState } from "./surface";

/**
 * Debris transport (see pipeline/debris.py): paths of rock debris riding on
 * the ice, and the places where the ice dropped it.
 */

export interface DebrisData {
  /** line segments: per vertex u, v, age (ka), region index */
  lines: Float32Array;
  /** where and when each trajectory was deposited */
  deposits: FeatureCollection<Point, { age: number; region: number }>;
}

const TRAIL_KA = 2.5; // length of the visible path behind each piece of debris
const LIFT = 45; // metres above the ice surface

export async function loadDebris(manifest: Manifest): Promise<DebrisData> {
  const info = manifest.debris!;
  const bytes = await fetchBytes(info.file);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const step = info.frameYears / 1000;
  const [x0, y0, x1, y1] = manifest.mercatorBounds;

  // first pass: count segments
  const count = view.getUint32(0, true);
  let segments = 0;
  for (let t = 0, o = 4; t < count; t++) {
    const n = view.getUint16(o, true);
    segments += n - 1;
    o += 8 + n * 4;
  }

  const lines = new Float32Array(segments * 2 * 4);
  const deposits: DebrisData["deposits"] = { type: "FeatureCollection", features: [] };
  for (let t = 0, o = 4, k = 0; t < count; t++) {
    const n = view.getUint16(o, true);
    const region = view.getUint8(o + 2);
    const start = view.getFloat32(o + 4, true);
    o += 8;
    let u = 0;
    let v = 0;
    for (let i = 0; i < n; i++, o += 4) {
      const pu = u;
      const pv = v;
      u = view.getUint16(o, true) / 65535;
      v = view.getUint16(o + 2, true) / 65535;
      if (i > 0) {
        lines.set([pu, pv, start - (i - 1) * step, region, u, v, start - i * step, region], k);
        k += 8;
      }
    }
    const mx = x0 + u * (x1 - x0);
    const my = y0 + v * (y1 - y0);
    deposits.features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [mx * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI],
      },
      properties: { age: start - (n - 1) * step, region },
    });
  }
  return { lines, deposits };
}

const VERT = `#version 300 es
precision highp float;
// one instance per path segment, drawn as a screen-space quad
in vec4 a_from; // u, v, age, region
in vec4 a_to;
${SURFACE_GLSL}
uniform sampler2D u_palette;
uniform vec2 u_viewport;
uniform float u_width;
out float v_age;
out float v_thk;
out vec3 v_color;
void main() {
  float along = float(gl_VertexID & 1);
  float side = float(gl_VertexID >> 1) * 2.0 - 1.0;
  vec4 from = project(a_from.xy, surface(a_from.xy) + ${LIFT.toFixed(1)});
  vec4 to = project(a_to.xy, surface(a_to.xy) + ${LIFT.toFixed(1)});
  vec2 dir = (to.xy / to.w - from.xy / from.w) * u_viewport;
  float len = length(dir);
  vec2 normal = len > 1e-4 ? vec2(-dir.y, dir.x) / len : vec2(0.0);
  vec4 clip = along > 0.5 ? to : from;
  clip.xy += normal * side * u_width / u_viewport * clip.w;
  gl_Position = clip;

  vec4 data = along > 0.5 ? a_to : a_from;
  v_age = data.z;
  v_thk = thickness(data.xy);
  v_color = texelFetch(u_palette, ivec2(int(a_from.w + 0.5), 0), 0).rgb;
}`;

const FRAG = `#version 300 es
precision highp float;
uniform float u_age;
in float v_age;
in float v_thk;
in vec3 v_color;
out vec4 fragColor;
void main() {
  // show the part of each path travelled during the last few thousand years
  float behind = (v_age - u_age) / ${TRAIL_KA.toFixed(1)};
  if (behind < 0.0 || behind > 1.0 || v_thk <= 0.0) discard;
  float alpha = pow(1.0 - behind, 1.5);
  fragColor = vec4(v_color * alpha, alpha);
}`;

/** Draws debris paths on the ice surface; used by the ice layer. */
export class DebrisPaths {
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null>;
  private vao: WebGLVertexArrayObject;
  private palette: WebGLTexture;
  private segmentCount: number;

  constructor(
    private gl: WebGL2RenderingContext,
    data: DebrisData,
    colors: string[],
  ) {
    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);
    this.segmentCount = data.lines.length / 8;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data.lines, gl.STATIC_DRAW);
    ["a_from", "a_to"].forEach((name, i) => {
      const loc = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    });
    gl.bindVertexArray(null);

    const rgba = new Uint8Array(colors.length * 4);
    colors.forEach((c, i) => {
      const n = parseInt(c.slice(1), 16);
      rgba.set([(n >> 16) & 255, (n >> 8) & 255, n & 255, 255], i * 4);
    });
    this.palette = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, colors.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }

  render(gl: WebGL2RenderingContext, surface: SurfaceState, age: number) {
    gl.useProgram(this.program);
    bindSurface(gl, this.uniforms, surface);
    gl.uniform1f(this.uniforms.u_age, age);
    gl.uniform2f(this.uniforms.u_viewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uniforms.u_width, 1.3 * (window.devicePixelRatio || 1));
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.uniform1i(this.uniforms.u_palette, 5);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.segmentCount);
    gl.bindVertexArray(null);
  }

  dispose() {
    this.gl.deleteProgram(this.program);
    this.gl.deleteVertexArray(this.vao);
    this.gl.deleteTexture(this.palette);
  }
}
