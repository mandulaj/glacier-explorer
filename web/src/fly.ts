import { MercatorCoordinate, type Map as MlMap } from "maplibre-gl";

/**
 * Game-style flying: W / S forward and back, A / D sideways, E or Space up,
 * Q down (Shift is left alone: MapLibre uses it for box zoom and rotation),
 * speed scaling with height above ground. F (or the menu button)
 * captures the mouse for looking around; Esc releases it.
 *
 * The camera pose is taken from the map when a flight starts and again after
 * any mouse or touch navigation, so flying mixes with the normal controls.
 */

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
const MOVE_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "KeyE", "KeyQ", "Space"]);
const MIN_CLEARANCE = 150; // metres above the terrain
const LOOK_SPEED = 0.12; // degrees per pixel of mouse movement

function metresPerUnit(lat: number) {
  return EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180);
}

interface Pose {
  /** camera position in normalised Web Mercator (y grows southwards) */
  x: number;
  y: number;
  alt: number;
  bearing: number;
  pitch: number;
}

export class FlyControls {
  private keys = new Set<string>();
  private running = false;
  private last = 0;
  private look = { dx: 0, dy: 0 };
  private release = 0;
  /** pose held while flying; null = read it from the map again */
  private current: Pose | null = null;

  constructor(
    private map: MlMap,
    private onLookChange: (active: boolean) => void = () => {},
  ) {
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("mousemove", (e) => {
      if (!this.looking) return;
      this.look.dx += e.movementX;
      this.look.dy += e.movementY;
      this.start();
    });
    // the user moved the map by other means: our held pose is stale
    map.on("move", (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) this.current = null;
    });
    document.addEventListener("pointerlockchange", () => {
      this.onLookChange(this.looking);
      if (!this.looking) this.keys.clear();
    });
  }

  get looking() {
    return document.pointerLockElement === this.map.getCanvas();
  }

  toggleLook() {
    if (this.looking) document.exitPointerLock();
    else void this.map.getCanvas().requestPointerLock();
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const target = e.target as HTMLElement;
    if (target.tagName === "SELECT" || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && (target as HTMLInputElement).type === "text")) return;
    if (down && (e.ctrlKey || e.metaKey || e.altKey)) return;
    if (down && e.code === "KeyF" && !e.repeat) {
      this.toggleLook();
      return;
    }
    if (!MOVE_KEYS.has(e.code)) return;
    if (e.code === "Space") e.preventDefault();
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (down) this.start();
  }

  private start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    clearTimeout(this.release);
    // while flying the view centre must not be snapped onto the terrain, or the camera bobs over every ridge
    this.map.setCenterClampedToGround(false);
    requestAnimationFrame((t) => this.step(t));
  }

  private stop() {
    this.running = false;
    this.current = null;
    // hand the camera back to normal navigation once things are quiet
    this.release = window.setTimeout(() => {
      if (!this.running && !this.looking) this.map.setCenterClampedToGround(true);
    }, 1500);
  }

  /**
   * Camera position from MapLibre's centre / zoom / pitch / bearing description.
   * Done in mercator units exactly as MapLibre does the reverse, so that
   * deriving and re-applying the pose every frame does not drift.
   */
  private pose(): Pose {
    const map = this.map;
    const center = map.getCenter();
    const c = MercatorCoordinate.fromLngLat(center);
    const pitch = map.getPitch();
    const bearing = map.getBearing();
    const fov = (map.getVerticalFieldOfView() * Math.PI) / 180;
    const height = map.getContainer().clientHeight;
    const distance = (0.5 * height) / Math.tan(fov / 2) / (512 * 2 ** map.getZoom()); // mercator units
    const p = (pitch * Math.PI) / 180;
    const b = (bearing * Math.PI) / 180;
    const back = distance * Math.sin(p);
    return {
      x: c.x - back * Math.sin(b),
      y: c.y + back * Math.cos(b),
      alt: map.getCenterElevation() + distance * Math.cos(p) * metresPerUnit(center.lat),
      bearing,
      pitch,
    };
  }

  private step(now: number) {
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    const k = (code: string) => (this.keys.has(code) ? 1 : 0);
    const forward = k("KeyW") - k("KeyS");
    const right = k("KeyD") - k("KeyA");
    const up = Math.max(k("Space"), k("KeyE")) - k("KeyQ");
    const turning = this.look.dx !== 0 || this.look.dy !== 0;
    if (!forward && !right && !up && !turning) {
      if (this.keys.size === 0 && !this.looking) return this.stop();
      requestAnimationFrame((t) => this.step(t));
      return;
    }

    const map = this.map;
    const pose = (this.current ??= this.pose());
    const position = new MercatorCoordinate(pose.x, pose.y).toLngLat();
    const ground = map.queryTerrainElevation(position) ?? 0;
    // faster when high above the ground, slower for a close look
    const speed = Math.max(pose.alt - ground, 400) * 0.6;

    pose.bearing += this.look.dx * LOOK_SPEED;
    pose.pitch = Math.min(Math.max(pose.pitch - this.look.dy * LOOK_SPEED, 0), map.getMaxPitch());
    this.look.dx = this.look.dy = 0;

    const b = (pose.bearing * Math.PI) / 180;
    const unit = (speed * dt) / metresPerUnit(position.lat); // metres to mercator units at the camera
    pose.x += (forward * Math.sin(b) + right * Math.cos(b)) * unit;
    pose.y -= (forward * Math.cos(b) - right * Math.sin(b)) * unit;
    pose.alt = Math.max(pose.alt + up * speed * 0.7 * dt, ground + MIN_CLEARANCE);

    const camera = new MercatorCoordinate(pose.x, pose.y).toLngLat();
    map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(camera, pose.alt, pose.bearing, pose.pitch));
    requestAnimationFrame((t) => this.step(t));
  }
}
