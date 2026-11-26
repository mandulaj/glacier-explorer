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

/** The seabed is global (see seabed.ts); the mesh covers the mercator world. */
const LON: [number, number] = [-180, 180];
const LAT: [number, number] = [-80, 80];
const CELLS = 128;

const mx = (lon: number) => (lon + 180) / 360;
const my = (lat: number) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

const VERT = `#version 300 es
precision highp float;
in vec2 a_uv;
uniform mat4 u_matrix;
uniform vec4 u_bounds;
uniform float u_level;
void main() {
  float y = mix(u_bounds.y, u_bounds.w, a_uv.y);
  float stretch = cosh(3.141592653589793 * (1.0 - 2.0 * y));
  gl_Position = u_matrix * vec4(a_uv, u_level * stretch / ${EARTH_CIRCUMFERENCE.toFixed(1)}, 1.0);
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
  private bounds: [number, number, number, number] = [mx(LON[0]), my(LAT[1]), mx(LON[1]), my(LAT[0])];

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
    for (let j = 0, k = 0; j <= CELLS; j++) for (let i = 0; i <= CELLS; i++) uv.set([i / CELLS, j / CELLS], 2 * k++);
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
    const loc = gl.getAttribLocation(this.program, "a_uv");
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
    const m = args.defaultProjectionData.mainMatrix as ArrayLike<number>;
    const [x0, y0, x1, y1] = this.bounds;
    const matrix = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
      matrix[r] = m[r] * (x1 - x0);
      matrix[4 + r] = m[4 + r] * (y1 - y0);
      matrix[8 + r] = m[8 + r];
      matrix[12 + r] = m[r] * x0 + m[4 + r] * y0 + m[12 + r];
    }
    const u = this.uniforms;
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.u_matrix, false, matrix);
    gl.uniform4fv(u.u_bounds, this.bounds);
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
