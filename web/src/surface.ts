/** WebGL helpers and GLSL shared by the ice mesh and the particle system. */

export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;

/** GLSL shared by the ice mesh and the particles: ice surface position in clip space. */
export const SURFACE_GLSL = `
uniform mat4 u_matrix;
uniform sampler2D u_bed;
uniform sampler2D u_ice0;
uniform sampler2D u_ice1;
uniform float u_mix;
uniform float u_exaggeration;
uniform vec4 u_bounds;

float thickness(vec2 uv) { return mix(texture(u_ice0, uv).r, texture(u_ice1, uv).r, u_mix); }
float surface(vec2 uv) { return texture(u_bed, uv).r + thickness(uv); }
float stretch(vec2 uv) { // 1 / cos(latitude)
  return cosh(3.141592653589793 * (1.0 - 2.0 * mix(u_bounds.y, u_bounds.w, uv.y)));
}
vec4 project(vec2 uv, float elevation) {
  float z = elevation * u_exaggeration * stretch(uv) / ${EARTH_CIRCUMFERENCE.toFixed(1)};
  return u_matrix * vec4(uv, z, 1.0);
}
`;

/** GLSL to decode flow frames (see pipeline/flow.py). */
export const FLOW_GLSL = `
uniform sampler2D u_flow0;
uniform sampler2D u_flow1;
uniform float u_flowMix;
const float LOG_VMAX = 8.006700845; // log(1 + 3000)

vec4 flowTexel(vec2 uv) { return mix(texture(u_flow0, uv), texture(u_flow1, uv), u_flowMix) * 255.0; }
/** surface velocity (east, north) in m / year */
vec2 velocity(vec4 texel) {
  vec2 f = (texel.rg - 128.0) / 127.0;
  return sign(f) * (exp(abs(f) * LOG_VMAX) - 1.0);
}
`;

export function createProgram(gl: WebGL2RenderingContext, vert: string, frag: string, feedback?: string[]): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vert],
    [gl.FRAGMENT_SHADER, frag],
  ] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader error");
    gl.attachShader(program, sh);
  }
  if (feedback) gl.transformFeedbackVaryings(program, feedback, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link error");
  return program;
}

export function uniformLocations(gl: WebGL2RenderingContext, program: WebGLProgram) {
  const out: Record<string, WebGLUniformLocation | null> = {};
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(program, i)!.name;
    out[name] = gl.getUniformLocation(program, name);
  }
  return out;
}

/** Textures and transforms shared between the ice mesh and the particle system for one frame. */
export interface SurfaceState {
  matrix: Float32Array;
  bounds: [number, number, number, number];
  exaggeration: number;
  bed: WebGLTexture;
  ice0: WebGLTexture;
  ice1: WebGLTexture;
  mix: number;
  flow0: WebGLTexture | null;
  flow1: WebGLTexture | null;
  flowMix: number;
}

/** Bind the uniforms declared by SURFACE_GLSL / FLOW_GLSL (texture units 0..4). */
export function bindSurface(gl: WebGL2RenderingContext, u: Record<string, WebGLUniformLocation | null>, s: SurfaceState) {
  gl.uniformMatrix4fv(u.u_matrix, false, s.matrix);
  gl.uniform4fv(u.u_bounds, s.bounds);
  gl.uniform1f(u.u_exaggeration, s.exaggeration);
  gl.uniform1f(u.u_mix, s.mix);
  gl.uniform1f(u.u_flowMix, s.flowMix);
  const textures = [s.bed, s.ice0, s.ice1, s.flow0, s.flow1];
  ["u_bed", "u_ice0", "u_ice1", "u_flow0", "u_flow1"].forEach((name, unit) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
    gl.uniform1i(u[name], unit);
  });
}
