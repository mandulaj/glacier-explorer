import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { createProgram, EARTH_CIRCUMFERENCE, uniformLocations } from "./surface";

/**
 * The sea as a translucent surface at the sea level of the displayed time.
 * Like the ice, it is simply depth-tested against the terrain (which includes
 * the seabed, see seabed.ts), so the shoreline is wherever the water surface
 * meets the ground: lower the sea and the shallow northern Adriatic dries out.
 */

export interface SeaLevelCurve {
  age: number[]; // ka, ascending
  level: number[]; // m relative to today
  source: string;
}

/**
 * The mesh is a square centred on the map centre and scaled to the view, and all
 * large numbers are combined in double precision before they reach the GPU.
 * With world-sized single-precision coordinates the surface height wobbles by
 * metres as the camera moves, which on a flat seabed moves the shoreline by kilometres.
 */
const CELLS = 96;

const mx = (lon: number) => (lon + 180) / 360;
const my = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const EARTH = EARTH_CIRCUMFERENCE;

const VERT = `#version 300 es
precision highp float;
in vec2 a_pos; // -0.5 .. 0.5 across the square
uniform mat4 u_matrix; // square-local position (and metres of height) to clip space
uniform float u_level;
uniform float u_centreY; // mercator y of the square's centre
uniform float u_size;
void main() {
  // height in mercator units grows with 1 / cos(latitude)
  float stretch = cosh(3.141592653589793 * (1.0 - 2.0 * (u_centreY + a_pos.y * u_size)));
  gl_Position = u_matrix * vec4(a_pos, u_level * stretch, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  float alpha = u_opacity;
  fragColor = vec4(vec3(0.27, 0.50, 0.68) * alpha, alpha);
}`;

export class SeaLayer implements CustomLayerInterface {
  readonly id = "sea";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  visible = true;
  exaggeration = 1;

  private map!: MlMap;
  private program!: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private vao!: WebGLVertexArrayObject;
  private indexCount = 0;
  private level = 0;

  constructor(private curve: SeaLevelCurve | null) {}

  /** Sea level (m relative to today) at an age in ka. */
  levelAt(age: number): number {
    const c = this.curve;
    if (!c) return 0;
    let i = 0;
    while (i < c.age.length - 2 && c.age[i + 1] < age) i++;
    const t = Math.min(Math.max((age - c.age[i]) / (c.age[i + 1] - c.age[i]), 0), 1);
    return c.level[i] + (c.level[i + 1] - c.level[i]) * t;
  }

  setAge(age: number) {
    this.level = this.levelAt(age);
    this.map?.triggerRepaint();
  }

  onAdd(map: MlMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);
    const uv = new Float32Array((CELLS + 1) * (CELLS + 1) * 2);
    for (let j = 0, k = 0; j <= CELLS; j++) for (let i = 0; i <= CELLS; i++) uv.set([i / CELLS - 0.5, j / CELLS - 0.5], 2 * k++);
    const index = new Uint32Array(CELLS * CELLS * 6);
    for (let j = 0, k = 0; j < CELLS; j++) {
      for (let i = 0; i < CELLS; i++, k += 6) {
        const a = j * (CELLS + 1) + i;
        const b = a + CELLS + 1;
        index.set([a, b, a + 1, a + 1, b, b + 1], k);
      }
    }
    this.indexCount = index.length;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.visible) return;
    // square around the map centre, generous enough for tilted views
    const centre = this.map.getCenter();
    const bounds = this.map.getBounds();
    const cx = mx(centre.lng);
    const cy = my(Math.min(Math.max(centre.lat, -84), 84));
    const reach = Math.max(
      Math.abs(mx(bounds.getEast()) - cx),
      Math.abs(mx(bounds.getWest()) - cx),
      Math.abs(my(Math.max(bounds.getSouth(), -84)) - cy),
      Math.abs(my(Math.min(bounds.getNorth(), 84)) - cy),
    );
    const size = Math.min(Math.max(reach * 2.4, 1e-4), 2);

    // mercator -> clip (doubles), composed with the square's placement; the height
    // column converts metres to mercator units (the latitude stretch is applied in the shader)
    const m = args.defaultProjectionData.mainMatrix as ArrayLike<number>;
    const matrix = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
      matrix[r] = m[r] * size;
      matrix[4 + r] = m[4 + r] * size;
      matrix[8 + r] = m[8 + r] / EARTH;
      matrix[12 + r] = m[r] * cx + m[4 + r] * cy + m[12 + r];
    }
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.u_matrix, false, matrix);
    gl.uniform1f(u.u_centreY, cy);
    gl.uniform1f(u.u_size, size);
    // a touch below the nominal level, so land lying exactly at sea level stays dry
    gl.uniform1f(u.u_level, (this.level - 0.2) * this.exaggeration);
    gl.uniform1f(u.u_opacity, 0.62);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }
}
