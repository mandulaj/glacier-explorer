import earcut from "earcut";
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from "maplibre-gl";
import { createProgram, EARTH_CIRCUMFERENCE, uniformLocations } from "./surface";

/**
 * The Eurasian ice sheet around the Alps, as outlines from published reconstructions
 * (pipeline/context.py). There is no thickness, so the ice is drawn flat: draped on the
 * terrain on land, and as a sheet on the water where the ice stood in the sea.
 *
 * Outlines exist for a few dozen moments only. Between two of them the older one fades
 * into the younger one.
 */

export interface ContextData {
  slices: {
    age: number; // ka
    source: string;
    area: number; // million km2
    /** polygons of rings of [lon, lat] */
    polygons: number[][][][];
  }[];
}

const SOURCE = "context";
const LAYERS = ["context-a", "context-b"] as const;
const COLOR = "#eaf2f8";
const OPACITY = 0.8;
const ATTRIBUTION =
  'Ice sheet: <a href="https://doi.org/10.1111/bor.12142" target="_blank" rel="noopener">DATED-1</a>, ' +
  '<a href="https://doi.org/10.1038/s41467-019-11601-2" target="_blank" rel="noopener">Batchelor et al. 2019</a>';

const mx = (lon: number) => (lon + 180) / 360;
const my = (lat: number) => {
  const s = Math.sin((Math.min(Math.max(lat, -85), 85) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** Mesh coordinates are relative to this point, which keeps them precise in single floats. */
const ORIGIN = { x: mx(25), y: my(62) };
/** The sheet on the water stands this far above sea level (m). */
const FREEBOARD = 40;

const VERT = `#version 300 es
precision highp float;
in vec2 a_pos;      // mercator, relative to the origin
uniform mat4 u_matrix;
uniform float u_height;
uniform float u_originY;
void main() {
  // height in mercator units grows with 1 / cos(latitude)
  float stretch = cosh(3.141592653589793 * (1.0 - 2.0 * (u_originY + a_pos.y)));
  gl_Position = u_matrix * vec4(a_pos, u_height * stretch, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  fragColor = vec4(u_color.rgb * u_color.a, u_color.a);
}`;

interface Mesh {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  count: number;
}

/** The part of the ice sheet that stands in the sea, drawn on the water surface. */
class MarineIce implements CustomLayerInterface {
  readonly id = "context-marine";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;
  visible = false;
  seaLevel = 0;
  exaggeration = 1;
  /** slice index and opacity of the two outlines being blended */
  blend: [number, number][] = [];

  private gl!: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private meshes = new Map<number, Mesh | null>();

  constructor(private data: ContextData) {}

  onAdd(_map: MlMap, gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.program = createProgram(gl, VERT, FRAG);
    this.uniforms = uniformLocations(gl, this.program);
  }

  onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
    for (const mesh of this.meshes.values()) {
      if (!mesh) continue;
      gl.deleteVertexArray(mesh.vao);
      mesh.buffers.forEach((b) => gl.deleteBuffer(b));
    }
    this.meshes.clear();
    gl.deleteProgram(this.program);
  }

  private mesh(slice: number): Mesh | null {
    let mesh = this.meshes.get(slice);
    if (mesh !== undefined) return mesh;
    const gl = this.gl;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const polygon of this.data.slices[slice].polygons) {
      const flat: number[] = [];
      const holes: number[] = [];
      for (const ring of polygon) {
        if (flat.length) holes.push(flat.length / 2);
        for (const [lon, lat] of ring) flat.push(mx(lon) - ORIGIN.x, my(lat) - ORIGIN.y);
      }
      const base = positions.length / 2;
      for (const i of earcut(flat, holes)) indices.push(base + i);
      for (const v of flat) positions.push(v);
    }
    if (!indices.length) {
      mesh = null;
    } else {
      const vao = gl.createVertexArray()!;
      const vertexBuffer = gl.createBuffer()!;
      const indexBuffer = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.program, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      mesh = { vao, buffers: [vertexBuffer, indexBuffer], count: indices.length };
    }
    this.meshes.set(slice, mesh);
    return mesh;
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.visible || !this.blend.length) return;
    // mercator -> clip in doubles, composed with the shift to the mesh origin; the height
    // column converts metres to mercator units (the latitude stretch is applied in the shader)
    const m = args.defaultProjectionData.mainMatrix as ArrayLike<number>;
    const matrix = new Float32Array(16);
    for (let r = 0; r < 4; r++) {
      matrix[r] = m[r];
      matrix[4 + r] = m[4 + r];
      matrix[8 + r] = m[8 + r] / EARTH_CIRCUMFERENCE;
      matrix[12 + r] = m[r] * ORIGIN.x + m[4 + r] * ORIGIN.y + m[12 + r];
    }
    const u = this.uniforms;
    const color = [parseInt(COLOR.slice(1, 3), 16) / 255, parseInt(COLOR.slice(3, 5), 16) / 255, parseInt(COLOR.slice(5, 7), 16) / 255];
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.u_matrix, false, matrix);
    gl.uniform1f(u.u_originY, ORIGIN.y);
    gl.uniform1f(u.u_height, (this.seaLevel + FREEBOARD) * this.exaggeration);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    for (const [slice, opacity] of this.blend) {
      const mesh = opacity > 0 ? this.mesh(slice) : null;
      if (!mesh) continue;
      gl.uniform4f(u.u_color, color[0], color[1], color[2], opacity);
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }
}

export class ContextIce {
  private marine: MarineIce;
  private shown: [number, number] = [-1, -1];
  private age = 0;
  private on = false;
  private sea = true;

  /**
   * @param before style layer below which the draped outlines go
   * @param beforeMarine style layer below which the sheet on the water goes (above the sea)
   */
  constructor(private map: MlMap, private data: ContextData, before: string, beforeMarine: string) {
    map.addSource(SOURCE, {
      type: "geojson",
      attribution: ATTRIBUTION,
      data: {
        type: "FeatureCollection",
        features: data.slices.map((s, slice) => ({
          type: "Feature" as const,
          properties: { slice },
          geometry: { type: "MultiPolygon" as const, coordinates: s.polygons },
        })),
      },
    });
    for (const id of LAYERS) {
      map.addLayer(
        {
          id,
          type: "fill",
          source: SOURCE,
          filter: ["==", ["get", "slice"], -1],
          layout: { visibility: "none" },
          paint: { "fill-color": COLOR, "fill-opacity": 0, "fill-outline-color": "#7f9bb0" },
        },
        before,
      );
    }
    this.marine = new MarineIce(data);
    map.addLayer(this.marine, beforeMarine);
  }

  /** Age range (ka) covered by the outlines. */
  get range(): [number, number] {
    const s = this.data.slices;
    return [s[0].age, s[s.length - 1].age];
  }

  set visible(on: boolean) {
    this.on = on;
    for (const id of LAYERS) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    this.marine.visible = on && this.sea;
    this.update();
  }

  get visible() {
    return this.on;
  }

  /** Without the sea the seabed is dry ground, and the draped outline is all there is to show. */
  set seaVisible(on: boolean) {
    this.sea = on;
    this.marine.visible = this.on && on;
    this.map.triggerRepaint();
  }

  set exaggeration(value: number) {
    this.marine.exaggeration = value;
  }

  setAge(age: number, seaLevel: number) {
    this.age = age;
    this.marine.seaLevel = seaLevel;
    if (this.on) this.update();
  }

  /** Description of what is shown at the current time, for the menu. */
  describe(): string {
    const s = this.data.slices;
    const [young, old] = this.bracket();
    const nearest = Math.abs(s[young].age - this.age) <= Math.abs(s[old].age - this.age) ? s[young] : s[old];
    return nearest.polygons.length ? `${nearest.source}, ${nearest.age} ka` : "no ice sheet";
  }

  /** Indices of the outlines just younger and just older than the current age. */
  private bracket(): [number, number] {
    const s = this.data.slices;
    let i = 0;
    while (i < s.length - 2 && s[i + 1].age <= this.age) i++;
    return [i, Math.min(i + 1, s.length - 1)];
  }

  private update() {
    const s = this.data.slices;
    const [young, old] = this.bracket();
    const span = s[old].age - s[young].age;
    const t = span > 0 ? Math.min(Math.max((this.age - s[young].age) / span, 0), 1) : 0;
    // share of the older outline; outside the record nothing is shown
    const inside = this.age >= s[0].age && this.age <= s[s.length - 1].age;
    const weights: [number, number][] = [
      [young, inside ? OPACITY * (1 - t) : 0],
      [old, inside ? OPACITY * t : 0],
    ];
    weights.forEach(([slice, opacity], k) => {
      if (this.shown[k] !== slice) {
        this.shown[k] = slice;
        this.map.setFilter(LAYERS[k], ["==", ["get", "slice"], slice]);
      }
      this.map.setPaintProperty(LAYERS[k], "fill-opacity", opacity);
    });
    this.marine.blend = weights;
    this.map.triggerRepaint();
  }
}
