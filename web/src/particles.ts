import { bindSurface, createProgram, FLOW_GLSL, SURFACE_GLSL, uniformLocations, type SurfaceState } from "./surface";

/**
 * Flow particles: advected on the GPU (transform feedback) through the surface
 * velocity field and drawn as short streaks lying on the ice surface.
 *
 * Real speeds span 1 to 1000 m / year, so displayed motion uses a compressed
 * (square-root) speed, scaled to the size of the view.
 */

const COUNT = 14000;
const FLOATS = 4; // uv.x, uv.y, age (s), lifetime (s)
const TRAIL_SECONDS = 0.9;
const LIFT = 30; // metres above the ice surface, avoids z-fighting

const MOTION_GLSL = `
uniform float u_step; // u per second per unit of compressed speed
uniform float u_aspect; // domain width / height: converts a step in u to the same distance in v
/** displayed displacement rate in uv / s */
vec2 motion(vec2 uv) {
  vec2 v = velocity(flowTexel(uv));
  float speed = length(v);
  if (speed < 0.5) return vec2(0.0);
  return v / speed * sqrt(speed) * u_step * vec2(1.0, -u_aspect);
}
`;

const UPDATE_VERT = `#version 300 es
precision highp float;
in vec4 a_particle;
out vec4 v_particle;
${SURFACE_GLSL}
${FLOW_GLSL}
${MOTION_GLSL}
uniform float u_dt;
uniform float u_seed;
uniform vec4 u_view;

float random(float salt) {
  return fract(sin(dot(vec2(float(gl_VertexID) * 0.0137 + salt, u_seed), vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = a_particle.xy;
  float age = a_particle.z + u_dt;
  float life = a_particle.w;
  bool outside = any(lessThan(uv, u_view.xy)) || any(greaterThan(uv, u_view.zw));
  if (age > life || outside || thickness(uv) <= 0.0) {
    uv = mix(u_view.xy, u_view.zw, vec2(random(0.1), random(0.7)));
    age = 0.0;
    life = 2.5 + 4.0 * random(1.3);
  } else {
    uv += motion(uv) * u_dt;
  }
  v_particle = vec4(uv, age, life);
  gl_Position = vec4(0.0);
}`;

const UPDATE_FRAG = `#version 300 es
void main() {}`;

const DRAW_VERT = `#version 300 es
precision highp float;
in vec4 a_particle;
${SURFACE_GLSL}
${FLOW_GLSL}
${MOTION_GLSL}
uniform vec2 u_viewport;
uniform float u_width;
out float v_alpha;

void main() {
  vec2 uv = a_particle.xy;
  float along = float(gl_VertexID & 1);      // 0 = tail, 1 = head
  float side = float(gl_VertexID >> 1) * 2.0 - 1.0;
  vec2 m = motion(uv);
  vec2 tail = uv - m * ${TRAIL_SECONDS.toFixed(1)};

  vec4 head_clip = project(uv, surface(uv) + ${LIFT.toFixed(1)});
  vec4 tail_clip = project(tail, surface(tail) + ${LIFT.toFixed(1)});
  vec2 dir = (head_clip.xy / head_clip.w - tail_clip.xy / tail_clip.w) * u_viewport;
  float len = length(dir);
  vec2 normal = len > 1e-4 ? vec2(-dir.y, dir.x) / len : vec2(0.0);

  vec4 clip = along > 0.5 ? head_clip : tail_clip;
  clip.xy += normal * side * u_width / u_viewport * clip.w;
  gl_Position = clip;

  float t = a_particle.z / a_particle.w;
  float fade = smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.75, 1.0, t));
  bool onIce = thickness(uv) > 0.0 && thickness(tail) > 0.0;
  v_alpha = onIce && len > 1.5 ? fade * 0.8 * along : 0.0;
}`;

const DRAW_FRAG = `#version 300 es
precision highp float;
uniform vec3 u_color;
in float v_alpha;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_color * v_alpha, v_alpha);
}`;

export interface ParticleView {
  /** uv rectangle on screen [u0, v0, u1, v1] */
  view: [number, number, number, number];
  viewport: [number, number];
  /** neutral dark streaks for coloured ice, blue ones for plain ice */
  light: boolean;
}

export class Particles {
  private update: WebGLProgram;
  private draw: WebGLProgram;
  private updateUniforms: Record<string, WebGLUniformLocation | null>;
  private drawUniforms: Record<string, WebGLUniformLocation | null>;
  private buffers: WebGLBuffer[];
  private updateVaos: WebGLVertexArrayObject[];
  private drawVaos: WebGLVertexArrayObject[];
  private feedback: WebGLTransformFeedback;
  private current = 0;
  private last = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.update = createProgram(gl, UPDATE_VERT, UPDATE_FRAG, ["v_particle"]);
    this.draw = createProgram(gl, DRAW_VERT, DRAW_FRAG);
    this.updateUniforms = uniformLocations(gl, this.update);
    this.drawUniforms = uniformLocations(gl, this.draw);
    this.feedback = gl.createTransformFeedback()!;

    // start "expired" so every particle is seeded inside the view on the first update
    const initial = new Float32Array(COUNT * FLOATS);
    for (let i = 0; i < COUNT; i++) initial.set([-1, -1, 1, 0], i * FLOATS);

    this.buffers = [0, 1].map(() => {
      const buffer = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, initial, gl.DYNAMIC_COPY);
      return buffer;
    });
    const vao = (program: WebGLProgram, buffer: WebGLBuffer, divisor: number) => {
      const v = gl.createVertexArray()!;
      gl.bindVertexArray(v);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      const loc = gl.getAttribLocation(program, "a_particle");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, FLOATS, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(loc, divisor);
      return v;
    };
    this.updateVaos = this.buffers.map((b) => vao(this.update, b, 0));
    this.drawVaos = this.buffers.map((b) => vao(this.draw, b, 1));
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  render(gl: WebGL2RenderingContext, surface: SurfaceState, view: ParticleView) {
    const now = performance.now();
    const dt = this.last ? Math.min((now - this.last) / 1000, 0.05) : 0.016;
    this.last = now;

    // the fastest ice (1000 m/a, compressed speed ~32) crosses the view in about 30 s
    const viewWidthUv = Math.max(view.view[2] - view.view[0], 1e-4);
    const step = viewWidthUv / (30 * Math.sqrt(1000));
    const aspect = (surface.bounds[2] - surface.bounds[0]) / (surface.bounds[3] - surface.bounds[1]);

    // --- advect: buffer[current] -> buffer[next]
    const next = 1 - this.current;
    gl.useProgram(this.update);
    bindSurface(gl, this.updateUniforms, surface);
    gl.uniform1f(this.updateUniforms.u_dt, dt);
    gl.uniform1f(this.updateUniforms.u_seed, Math.random() * 100);
    gl.uniform4fv(this.updateUniforms.u_view, view.view);
    gl.uniform1f(this.updateUniforms.u_step, step);
    gl.uniform1f(this.updateUniforms.u_aspect, aspect);
    gl.bindVertexArray(this.updateVaos[this.current]);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.buffers[next]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, COUNT);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    this.current = next;

    // --- draw streaks
    gl.useProgram(this.draw);
    bindSurface(gl, this.drawUniforms, surface);
    gl.uniform1f(this.drawUniforms.u_step, step);
    gl.uniform1f(this.drawUniforms.u_aspect, aspect);
    gl.uniform2fv(this.drawUniforms.u_viewport, view.viewport);
    gl.uniform1f(this.drawUniforms.u_width, 1.1 * (window.devicePixelRatio || 1));
    gl.uniform3fv(this.drawUniforms.u_color, view.light ? [0.1, 0.1, 0.12] : [0.04, 0.22, 0.42]);
    gl.bindVertexArray(this.drawVaos[this.current]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, COUNT);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    [...this.updateVaos, ...this.drawVaos].forEach((v) => gl.deleteVertexArray(v));
    gl.deleteTransformFeedback(this.feedback);
    gl.deleteProgram(this.update);
    gl.deleteProgram(this.draw);
  }
}
