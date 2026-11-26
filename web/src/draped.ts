import type { CustomLayerInterface, CustomTerrainRenderInput, Map as MlMap } from "maplibre-gl";
import { rampTable, type Ramp } from "./colormaps";
import { fetchRaster, type Encoding, type FrameRef, type Manifest } from "./data";
import { FrameSet, TextureCache } from "./frames";
import { createProgram, uniformLocations } from "./surface";

/**
 * A raster draped on the terrain, coloured through a ramp: cumulative erosion
 * (time-dependent) or deglaciation age (static). Being on the ground, it stays
 * visible where the ice has gone. Uses MapLibre's (experimental)
 * `renderToTerrainTile` hook: the layer is drawn into every terrain tile
 * texture, between the hillshade and the vector layers.
 */

export interface DrapedConfig {
  id: string;
  frames: FrameRef[];
  encoding: Encoding;
  ramp: Ramp;
  /** values mapped to the two ends of the ramp; below the low end the layer is transparent */
  range: [number, number];
}

const VERT = `#version 300 es
in vec2 a_pos;
uniform vec4 u_tile;   // mercator x0, y0 (north-west corner) and size of the tile
uniform vec4 u_bounds; // mercator bounds of the data
out vec2 v_uv;
void main() {
  // clip (-1, -1) is the tile's south-west corner, (1, 1) its north-east corner
  vec2 mercator = u_tile.xy + vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5) * u_tile.zw;
  v_uv = (mercator - u_bounds.xy) / (u_bounds.zw - u_bounds.xy);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform sampler2D u_lut;
uniform float u_mix;
uniform float u_opacity;
uniform vec2 u_range;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  if (any(lessThan(v_uv, vec2(0.0))) || any(greaterThan(v_uv, vec2(1.0)))) discard;
  float value = mix(texture(u_a, v_uv).r, texture(u_b, v_uv).r, u_mix); // log10(m)
  float t = (value - u_range.x) / (u_range.y - u_range.x);
  float alpha = u_opacity * smoothstep(-0.08, 0.06, t);
  vec3 color = texture(u_lut, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  fragColor = vec4(color * alpha, alpha);
}`;

export class DrapedLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  terrainTileRevision = 0;

  private map!: MlMap;
  private program!: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao!: WebGLVertexArrayObject;
  private lut!: WebGLTexture;
  private frames: FrameSet<Float32Array>;
  private textures!: TextureCache<Float32Array>;
  private visible = false;
  private age = 0;

  constructor(
    private manifest: Manifest,
    private config: DrapedConfig,
  ) {
    const { width, height } = manifest;
    this.id = config.id;
    this.frames = new FrameSet(config.frames, (file) => fetchRaster(file, width, height, config.encoding), () => this.invalidate(), 6);
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    this.invalidate();
  }

  setAge(age: number) {
    this.age = age;
    if (this.visible) this.invalidate();
  }

  /** Ask MapLibre to redraw the terrain tile textures. */
  invalidate() {
    this.terrainTileRevision++;
    this.map?.triggerRepaint();
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const texture = (internal: number, format: number, type: number, data: ArrayBufferView, w: number, h: number) => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
      const filter = type === gl.FLOAT && !gl.getExtension("OES_texture_float_linear") ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };
    this.lut = texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, rampTable(this.config.ramp), 256, 1);
    const { width, height } = this.manifest;
    this.textures = new TextureCache(gl, (d) => texture(gl.R32F, gl.RED, gl.FLOAT, d, width, height), 6);
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    this.textures.dispose();
    gl.deleteTexture(this.lut);
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }

  /** Only used without 3D terrain, which this app always has. */
  render() {}

  renderToTerrainTile(gl: WebGL2RenderingContext, { tileID }: CustomTerrainRenderInput) {
    if (!this.visible) return;
    const pair = this.frames.pair(this.age);
    if (!pair) return;

    const { x, y, z } = tileID.canonical;
    const size = 1 / 2 ** z;
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniform4f(u.u_tile, (x + (tileID.wrap ?? 0) * 2 ** z) * size, y * size, size, size);
    gl.uniform4fv(u.u_bounds, this.manifest.mercatorBounds);
    gl.uniform1f(u.u_mix, pair.mix);
    gl.uniform1f(u.u_opacity, 0.9);
    gl.uniform2fv(u.u_range, this.config.range);
    [this.textures.get(pair.i0, pair.a), this.textures.get(pair.i1, pair.b), this.lut].forEach((tex, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
    });
    gl.uniform1i(u.u_a, 0);
    gl.uniform1i(u.u_b, 1);
    gl.uniform1i(u.u_lut, 2);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}
