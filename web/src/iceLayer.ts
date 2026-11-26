import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { ContourLabels } from "./contourLabels";
import { RAMPS, rampTable, type IceMode } from "./colormaps";
import { DebrisPaths, type DebrisData } from "./debris";
import { fetchBytes, fetchRaster, type Manifest } from "./data";
import { FrameSet, TextureCache } from "./frames";
import { Particles } from "./particles";
import { bindSurface, createProgram, EARTH_CIRCUMFERENCE, FLOW_GLSL, SURFACE_GLSL, uniformLocations, type SurfaceState } from "./surface";

/**
 * Semi-transparent ice surface drawn above MapLibre's 3D terrain.
 *
 * Geometry: one regular mesh over the model domain; vertex height is
 * bed + extended thickness, blended between the two frames around the
 * current time. Beyond the modelled margin the surface dives below ground
 * (see pipeline/build.py), so the depth test against the high-resolution
 * terrain cuts the visible margin along the real valley walls and lets
 * peaks stand out as nunataks.
 */

const FINE_MAX_RATE = 1.5; // ka / s; above this only the 1 ka frames are used
const MESH_STEP = 2; // mesh cell = 2 data pixels (~1.5 km); the modelled surface is smooth

const MODE_INDEX: Record<IceMode, number> = { plain: 0, speed: 1, sliding: 2, temperature: 3, erosion: 0 };

const VERT = `#version 300 es
precision highp float;
in vec2 a_uv;
${SURFACE_GLSL}
uniform vec2 u_texel;
out float v_thk;
out float v_surface;
out vec3 v_normal;
out vec2 v_uv;

void main() {
  float thk = thickness(a_uv);
  float s = texture(u_bed, a_uv).r + thk;
  gl_Position = project(a_uv, s);

  // surface normal in east / north / up, from central differences
  float ground = (u_bounds.z - u_bounds.x) * u_texel.x * ${EARTH_CIRCUMFERENCE.toFixed(1)} / stretch(a_uv);
  float dx = (surface(a_uv + vec2(u_texel.x, 0.0)) - surface(a_uv - vec2(u_texel.x, 0.0))) / (2.0 * ground);
  float dy = (surface(a_uv - vec2(0.0, u_texel.y)) - surface(a_uv + vec2(0.0, u_texel.y))) / (2.0 * ground);
  v_normal = vec3(-dx, -dy, 1.0);
  v_thk = thk;
  v_surface = s;
  v_uv = a_uv;
}`;

const FRAG = `#version 300 es
precision highp float;
uniform float u_opacity;
uniform int u_mode;
uniform sampler2D u_lut;
${FLOW_GLSL}
in float v_thk;
in float v_surface;
in vec3 v_normal;
in vec2 v_uv;
out vec4 fragColor;

const vec3 LIGHT = normalize(vec3(-0.55, 0.55, 0.63)); // from north-west, like the hillshade

void main() {
  if (v_thk < -60.0) discard;
  // ice slopes are gentle; steepen them for shading so the surface reads as relief
  vec3 n = normalize(vec3(v_normal.xy * 6.0, 1.0));
  float shade = 0.74 + 0.36 * clamp(dot(n, LIGHT), 0.0, 1.0);
  float deep = smoothstep(0.0, 700.0, v_thk);
  vec3 color = mix(vec3(0.60, 0.80, 0.94), vec3(0.90, 0.95, 1.0), deep);

  if (u_mode > 0) {
    vec4 texel = flowTexel(v_uv);
    float t;
    if (u_mode == 1) {
      t = log(max(length(velocity(texel)), 1.0)) / log(1000.0);
    } else if (u_mode == 2) {
      t = log(max(exp(texel.b / 255.0 * LOG_VMAX) - 1.0, 1.0)) / log(1000.0);
    } else {
      float below = (255.0 - texel.a) * 0.05; // K below the pressure melting point
      t = below < 0.15 ? 1.0 : 0.9 * (1.0 - clamp(below / 8.0, 0.0, 1.0));
    }
    color = texture(u_lut, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  }
  color *= shade;

  // surface elevation contours every 100 m (stronger every 500 m) make the ice shape readable
  float w = fwidth(v_surface);
  float minor = 1.0 - smoothstep(0.0, 1.2 * w, abs(fract(v_surface / 100.0 + 0.5) - 0.5) * 100.0);
  float major = 1.0 - smoothstep(0.0, 1.8 * w, abs(fract(v_surface / 500.0 + 0.5) - 0.5) * 500.0);
  float fade = 1.0 - smoothstep(25.0, 60.0, w); // hide where lines would merge
  color = mix(color, vec3(0.20, 0.38, 0.55), max(minor * 0.22, major * 0.45) * fade);

  // thin ice near the margin is translucent, thick ice nearly opaque
  float alpha = u_opacity * mix(0.5, 1.0, smoothstep(0.0, 300.0, v_thk));
  fragColor = vec4(min(color, 1.0) * alpha, alpha);
}`;

export class IceLayer implements CustomLayerInterface {
  readonly id = "ice";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  opacity = 0.9;
  visible = true;
  exaggeration = 1;
  mode: IceMode = "plain";
  showParticles = false;
  showDebris = false;
  showContourLabels = true;

  private map!: MlMap;
  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao!: WebGLVertexArrayObject;
  private indexCount = 0;
  private bedTexture: WebGLTexture | null = null;
  private bedData: Float32Array | null = null;
  private labels: ContourLabels | null = null;
  private luts = new Map<IceMode, WebGLTexture>();
  private particles: Particles | null = null;
  private debris: DebrisPaths | null = null;
  private debrisData: DebrisData | null = null;

  private age = 24;
  /** every frame (100-year steps when built that way) and the 1 ka subset used while time moves fast */
  private iceFrames: FrameSet<Float32Array>;
  private coarseFrames: FrameSet<Float32Array>;
  private coarseTextures!: TextureCache<Float32Array>;
  private rate = 0; // ka per second, smoothed
  private lastChange = 0;
  private flowFrames: FrameSet<Uint8Array> | null;
  private iceTextures!: TextureCache<Float32Array>;
  private flowTextures!: TextureCache<Uint8Array>;

  constructor(private manifest: Manifest) {
    const { width, height, ice, flow } = manifest;
    const repaint = () => this.map?.triggerRepaint();
    const load = (file: string) => fetchRaster(file, width, height, ice);
    this.iceFrames = new FrameSet(manifest.frames, load, repaint);
    this.coarseFrames = new FrameSet(manifest.frames.filter((f) => Number.isInteger(f.age)), load, repaint);
    this.flowFrames = flow ? new FrameSet(flow.frames, fetchBytes, repaint) : null;
  }

  setDebris(data: DebrisData) {
    this.debrisData = data;
    this.map?.triggerRepaint();
  }

  get hasFlow() {
    return this.flowFrames !== null;
  }

  private get needsFlow() {
    return this.hasFlow && (this.showParticles || MODE_INDEX[this.mode] > 0);
  }

  get currentAge() {
    return this.age;
  }

  setAge(age: number) {
    const now = performance.now();
    const dt = Math.max((now - this.lastChange) / 1000, 1e-3);
    this.rate = dt > 0.5 ? 0 : 0.7 * this.rate + 0.3 * (Math.abs(age - this.age) / dt);
    this.lastChange = now;
    this.age = age;
    this.coarseFrames.request(age);
    // fetching every 100-year frame cannot keep up with fast playback or scrubbing
    if (this.rate < FINE_MAX_RATE) this.iceFrames.request(age);
    if (this.needsFlow) this.flowFrames!.request(age);
    this.map?.triggerRepaint();
  }

  private floatTexture(data: Float32Array): WebGLTexture {
    const gl = this.gl;
    const filter = gl.getExtension("OES_texture_float_linear") ? gl.LINEAR : gl.NEAREST;
    return this.texture(gl.R32F, gl.RED, gl.FLOAT, data, this.manifest.width, this.manifest.height, filter);
  }

  private texture(internal: number, format: number, type: number, data: ArrayBufferView, w: number, h: number, filter: number) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.gl = gl;
    const { width, height, bed } = this.manifest;

    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);
    this.iceTextures = new TextureCache(gl, (d) => this.floatTexture(d), 12);
    this.coarseTextures = new TextureCache(gl, (d) => this.floatTexture(d), 6);
    this.flowTextures = new TextureCache(gl, (d) => this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, d, width, height, gl.LINEAR), 8);
    for (const mode of ["speed", "sliding", "temperature"] as const) {
      this.luts.set(mode, this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, rampTable(RAMPS[mode]), 256, 1, gl.LINEAR));
    }
    this.particles = new Particles(gl);
    this.labels = new ContourLabels(map.getCanvasContainer());

    // regular mesh; uv is both position inside the domain rectangle and texture coordinate
    const nx = Math.ceil(width / MESH_STEP);
    const ny = Math.ceil(height / MESH_STEP);
    const uv = new Float32Array((nx + 1) * (ny + 1) * 2);
    for (let j = 0, k = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        uv[k++] = i / nx;
        uv[k++] = j / ny;
      }
    }
    const index = new Uint32Array(nx * ny * 6);
    for (let j = 0, k = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + nx + 1;
        index.set([a, b, a + 1, a + 1, b, b + 1], k);
        k += 6;
      }
    }
    this.indexCount = index.length;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "a_uv");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    fetchRaster(bed.file, width, height, bed).then((data) => {
      this.bedData = data;
      this.bedTexture = this.floatTexture(data);
      map.triggerRepaint();
    });
    this.setAge(this.age);
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    this.iceTextures.dispose();
    this.coarseTextures.dispose();
    this.flowTextures.dispose();
    this.particles?.dispose();
    this.labels?.canvas.remove();
    this.debris?.dispose();
    this.debris = null;
    for (const tex of this.luts.values()) gl.deleteTexture(tex);
    gl.deleteTexture(this.bedTexture);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }

  /** Domain rectangle in uv that is currently on screen (for particle seeding). */
  private viewRect(): [number, number, number, number] {
    const [x0, y0, x1, y1] = this.manifest.mercatorBounds;
    const b = this.map.getBounds();
    const mx = (lng: number) => (lng + 180) / 360;
    const my = (lat: number) => {
      const s = Math.sin((lat * Math.PI) / 180);
      return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
    };
    const clamp = (v: number) => Math.min(Math.max(v, 0), 1);
    return [
      clamp((mx(b.getWest()) - x0) / (x1 - x0)),
      clamp((my(b.getNorth()) - y0) / (y1 - y0)),
      clamp((mx(b.getEast()) - x0) / (x1 - x0)),
      clamp((my(b.getSouth()) - y0) / (y1 - y0)),
    ];
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    this.labels?.clear();
    if (!this.visible || !this.bedTexture) return;
    // full time resolution when those frames are loaded, otherwise the 1 ka subset
    const fine = this.iceFrames.peek(this.age);
    const ice = fine ?? this.coarseFrames.pair(this.age);
    if (!ice) return;
    const iceTextures = fine ? this.iceTextures : this.coarseTextures;
    if (!fine && performance.now() - this.lastChange > 250) this.iceFrames.request(this.age); // time has settled
    const flow = this.needsFlow ? this.flowFrames!.pair(this.age) : null;

    // mercator [0,1] -> clip, pre-multiplied with the domain rectangle so the
    // shaders work in domain-local coordinates (keeps float32 precision)
    const m = args.defaultProjectionData.mainMatrix as ArrayLike<number>;
    const [x0, y0, x1, y1] = this.manifest.mercatorBounds;
    const matrix = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
      matrix[r] = m[r] * (x1 - x0);
      matrix[4 + r] = m[4 + r] * (y1 - y0);
      matrix[8 + r] = m[8 + r];
      matrix[12 + r] = m[r] * x0 + m[4 + r] * y0 + m[12 + r];
    }

    const state: SurfaceState = {
      matrix,
      bounds: this.manifest.mercatorBounds,
      exaggeration: this.exaggeration,
      bed: this.bedTexture,
      ice0: iceTextures.get(ice.i0, ice.a),
      ice1: iceTextures.get(ice.i1, ice.b),
      mix: ice.mix,
      flow0: flow ? this.flowTextures.get(flow.i0, flow.a) : null,
      flow1: flow ? this.flowTextures.get(flow.i1, flow.b) : null,
      flowMix: flow?.mix ?? 0,
    };

    const mode = flow ? MODE_INDEX[this.mode] : 0;
    const u = this.uniforms;
    gl.useProgram(this.program);
    bindSurface(gl, u, state);
    gl.uniform1f(u.u_opacity, this.mode === "erosion" ? this.opacity * 0.35 : this.opacity);
    gl.uniform1i(u.u_mode, mode);
    gl.uniform2f(u.u_texel, 1 / this.manifest.width, 1 / this.manifest.height);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.luts.get(this.mode) ?? this.luts.get("speed")!);
    gl.uniform1i(u.u_lut, 5);

    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // pass 1: depth only, so that ice hidden behind nearer ice is not blended twice
    gl.depthMask(true);
    gl.colorMask(false, false, false, false);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);

    // pass 2: colour of the nearest ice surface
    gl.depthMask(false);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    if (this.showContourLabels && this.labels && this.bedData) {
      this.labels.draw({
        bed: this.bedData,
        a: ice.a,
        b: ice.b,
        mix: ice.mix,
        width: this.manifest.width,
        height: this.manifest.height,
        matrix,
        bounds: this.manifest.mercatorBounds,
        exaggeration: this.exaggeration,
        view: this.viewRect(),
      });
    }

    if (this.showDebris && this.debrisData) {
      this.debris ??= new DebrisPaths(gl, this.debrisData, this.manifest.debris!.regions.map((r) => r.color));
      this.debris.render(gl, state, this.age);
    }

    if (this.showParticles && flow && this.particles) {
      const canvas = this.map.getCanvas();
      this.particles.render(gl, state, {
        view: this.viewRect(),
        viewport: [canvas.width, canvas.height],
        light: this.mode === "speed" || this.mode === "sliding" || this.mode === "temperature",
      });
      this.map.triggerRepaint(); // keep animating
    }

    gl.depthMask(true);
  }
}
