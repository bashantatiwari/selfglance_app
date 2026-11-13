// The 3D stage: one transparent WebGL canvas covering the whole overlay window.
//
// Key trick: an OrthographicCamera whose frustum is exactly the window size in
// CSS pixels, with y pointing UP from the bottom edge. So "1 world unit = 1 pixel"
// and placing the character at (x, 0) means "standing on the taskbar at x".

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { Bottle } from "./Bottle";
import type { CharacterManifest, ClipName, Rect } from "./types";

type Mode = "hidden" | "idle" | "walking" | "flying" | "dragging" | "falling" | "hanging";
type BottleMode = "none" | "held" | "offered" | "drinking" | "stowing";
/** Resting poses: stand, sit beside you, sit facing the screen to watch, doze off. */
export type Pose = "stand" | "sit" | "watch" | "sleep";

const FPS_CAP = 30;
const GRAVITY = 2600; // px / s²
const EDGE = 50; // keep the character's centre this far from the screen sides
const BOTTLE_HELD = 1.35; // bottle scale in the hand (~54 px tall)
const BOTTLE_OFFERED = 1.75; // a little bigger while he offers it (~70 px)
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

async function loadAsset(url: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  if (url.toLowerCase().endsWith(".fbx")) {
    const obj = await new FBXLoader().loadAsync(url);
    return { scene: obj, animations: obj.animations };
  }
  const gltf = await new GLTFLoader().loadAsync(url);
  return { scene: gltf.scene, animations: gltf.animations };
}

export class CharacterStage {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 4000);
  private timer = new THREE.Timer();
  private root = new THREE.Group(); // positioned in screen pixels, feet at root.y
  private model?: THREE.Object3D;
  private holdBone?: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private actions = new Map<ClipName, THREE.AnimationAction>();
  private current?: THREE.AnimationAction;
  private looping: ClipName = "idle"; // what one-shot clips return to
  private thread: THREE.Mesh; // the "web" line used by the web-drop entrance
  private ring: THREE.Group; // holographic ring under the feet, shown on hover
  private bottle = new Bottle();
  private bottleMode: BottleMode = "none";
  private drinkDone?: () => void;
  private manifest!: CharacterManifest;
  private bodyW = 0; // on-screen width in px, for the hit box and where the bottle is held
  private mode: Mode = "hidden";
  private facing = 0; // target rotation around y (relative to the model's front)
  private pose: Pose = "stand";
  private nod = 0; // forward head tilt while dozing
  private legs: THREE.Object3D[] = []; // upper-leg bones, bent to sit
  private hipHeight = 0; // px from feet to hips, how far the body drops when sitting
  private sit = 0; // 0 = standing, 1 = seated (eased)
  private walkTarget = 0;
  private walkResolve?: () => void;
  private fallResolve?: (impact: number) => void;
  private vx = 0;
  private vy = 0;
  private flight?: { from: number; to: number; t: number; dur: number; done: () => void };
  private highlight = 0;
  private highlightTarget = 0;
  private time = 0;
  private size = { w: window.innerWidth, h: window.innerHeight };
  private sinceRender = 0;
  private raf = 0;
  private tmp = new THREE.Vector3();

  /** Called every rendered frame with the character's on-screen rectangle. */
  onFrame?: (rect: Rect | null) => void;
  /** Called whenever a clip starts (e.g. to say "Hey!" when he waves). */
  onClip?: (name: ClipName) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera.position.set(0, 0, 1000);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(300, 800, 600);
    this.scene.add(sun);
    this.scene.add(this.root);
    this.scene.add(this.bottle.group);

    this.thread = new THREE.Mesh(
      new THREE.CylinderGeometry(1.2, 1.2, 1, 6),
      new THREE.MeshBasicMaterial({ color: 0xe8eef5 }),
    );
    this.thread.visible = false;
    this.scene.add(this.thread);

    this.ring = this.makeRing();
    this.root.add(this.ring);

    this.root.visible = false;
    this.resize();
    window.addEventListener("resize", this.resize);
    this.raf = requestAnimationFrame(this.loop);
  }

  get width() {
    return this.size.w;
  }
  get x() {
    return this.root.position.x;
  }
  /** In the middle of something (walking, flying, hanging). Hidden isn't busy: he must be
   * free to come back, or he'd stay away for good after a meeting or a game. */
  get busy() {
    return this.mode !== "idle" && this.mode !== "hidden";
  }
  get isHanging() {
    return this.mode === "hanging";
  }
  get visible() {
    return this.mode !== "hidden";
  }

  async load(baseUrl: string, manifest: CharacterManifest) {
    this.manifest = manifest;
    this.bodyW = manifest.height * 0.55;
    const { scene: model, animations } = await loadAsset(`${baseUrl}/${manifest.model}`);

    // Scale the model so it is exactly manifest.height pixels tall, feet at y = 0.
    const box = new THREE.Box3().setFromObject(model);
    const scale = manifest.height / (box.max.y - box.min.y);
    model.scale.multiplyScalar(scale);
    model.position.y = -box.min.y * scale;
    const holder = new THREE.Group(); // holder turns; the model keeps its own transform
    holder.add(model);
    this.root.add(holder);
    this.model = holder;
    // Loaders sanitize node names ("Palm2.L" → "Palm2L"), so look bones up the same way.
    const bone = (name: string) =>
      model.getObjectByName(name) ?? model.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name));
    if (manifest.holdBone) this.holdBone = bone(manifest.holdBone);
    // Sitting is done procedurally (bend the hips, lower the body), so any humanoid can sit.
    this.legs = (manifest.legBones ?? []).map(bone).filter((b): b is THREE.Object3D => !!b);
    if (this.legs.length) {
      holder.updateMatrixWorld(true);
      this.hipHeight = this.legs[0].getWorldPosition(new THREE.Vector3()).y;
    }

    this.mixer = new THREE.AnimationMixer(model);
    for (const [logical, clipName] of Object.entries(manifest.clips ?? {}) as [ClipName, string][]) {
      const clip = THREE.AnimationClip.findByName(animations, clipName);
      if (clip) this.actions.set(logical, this.mixer.clipAction(clip));
    }
    // Separate animation files (e.g. Mixamo "idle.fbx", "waving.fbx").
    for (const [logical, ref] of Object.entries(manifest.animations ?? {}) as [ClipName, { file: string; clip?: string }][]) {
      try {
        const asset = await loadAsset(`${baseUrl}/${ref.file}`);
        const clip = ref.clip ? THREE.AnimationClip.findByName(asset.animations, ref.clip) : asset.animations[0];
        if (clip) this.actions.set(logical, this.mixer.clipAction(clip));
      } catch (err) {
        console.warn(`Animation ${logical} (${ref.file}) failed to load`, err);
      }
    }
    // One-shot clips (wave, celebrate...) return to the current loop when they finish.
    this.mixer.addEventListener("finished", () => this.play(this.looping));
  }

  /** Crossfade to a clip. `once` plays it a single time, then returns to the current loop. */
  play(name: ClipName, once = false) {
    if (!once) this.looping = name;
    if (once) this.onClip?.(name);
    const next = this.actions.get(name) ?? this.actions.get("idle");
    if (!next || (next === this.current && !once)) return;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    next.enabled = true;
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, 0.25, false);
    next.play();
    this.current = next;
  }

  /** Glowing ring under the feet (hover feedback). */
  setHighlight(on: boolean) {
    this.highlightTarget = on ? 1 : 0;
  }

  /** Sit down (waiting) or stand back up. */
  setSitting(on: boolean) {
    this.setPose(on ? "sit" : "stand");
  }

  /** Change the resting pose. "watch" angles him toward the screen's centre while still facing you. */
  setPose(pose: Pose) {
    if (this.mode !== "idle" && this.mode !== "hidden") return;
    this.pose = pose;
    // Watching: sits facing you, turned a little toward the middle of the screen — a friend
    // beside you on the sofa, half-watching with you (you still see his face).
    const towardCentre = this.x > this.size.w / 2 ? -1 : 1;
    this.facing = pose === "watch" ? towardCentre * 0.55 : 0;
    if (this.mixer) this.mixer.timeScale = pose === "sleep" ? 0.35 : 1;
    this.play(pose === "stand" || this.legs.length ? "idle" : "sit");
  }

  get currentPose() {
    return this.pose;
  }

  walkTo(x: number): Promise<void> {
    if (this.mode !== "idle" && this.mode !== "walking") return Promise.resolve();
    this.walkResolve?.();
    this.walkTarget = this.clampX(x);
    this.facing = this.walkTarget > this.x ? Math.PI / 2 : -Math.PI / 2;
    this.mode = "walking";
    this.resetPose();
    this.play("walk");
    return new Promise((resolve) => (this.walkResolve = resolve));
  }

  /** Web-drop entrance: hang from a thread at the top of the screen and slide down to the floor at x. */
  webDrop(x: number): Promise<void> {
    this.root.position.set(this.clampX(x), this.size.h + 40, 0);
    this.root.visible = true;
    this.resetPose();
    this.play("hang");
    return this.fly(this.size.h + 40, 0, 1.6).then(() => {
      this.mode = "idle";
      this.play("idle");
      this.play("wave", true);
    });
  }

  /** Turn toward a point on screen (DOM x) while staying put, or back to you (null). */
  lookToward(domX: number | null) {
    if (this.mode !== "idle") return;
    this.facing = domX === null ? 0 : Math.sign(domX - this.x) * 0.75;
  }

  /** Swing in on the thread and hang beside a point on screen (DOM coords) — used to point things out. */
  hangAt(domX: number, domY: number): Promise<void> {
    const side = domX > this.size.w - 160 ? -1 : 1; // hang just beside the target, not on top of it
    const x = this.clampX(domX + side * this.manifest.height * 0.45);
    const y = Math.max(0, Math.min(this.size.h - this.manifest.height, this.size.h - domY - this.manifest.height * 0.6));
    this.root.position.set(x, this.size.h + 40, 0);
    this.root.visible = true;
    this.resetPose();
    this.facing = -side * 0.5; // turn a little toward the target
    this.play("hang");
    return this.fly(this.size.h + 40, y, 1.2).then(() => {
      this.mode = "hanging";
      this.play("wave", true); // "here!"
    });
  }

  /** Reverse of webDrop: climb the thread out of view. */
  webClimb(): Promise<void> {
    if (this.mode === "hidden") return Promise.resolve();
    this.facing = 0;
    this.play("hang");
    return this.fly(this.root.position.y, this.size.h + 40, 0.9).then(() => {
      this.root.visible = false;
      this.mode = "hidden";
    });
  }

  // --- Water bottle ---------------------------------------------------------------------
  /** Put a full bottle in the character's hand. */
  holdBottle() {
    this.bottle.setLevel(1);
    this.bottle.group.scale.setScalar(0.001); // pops into the hand (see updateBottle)
    this.bottle.group.visible = true;
    this.bottleMode = "held";
  }

  /** Offer the held bottle — a little bigger (true) — or back to normal size (false). */
  offerBottle(on: boolean) {
    if (this.bottleMode === "none" || this.bottleMode === "drinking") return;
    this.bottleMode = on ? "offered" : "held";
  }

  /** Drain the bottle, then make it vanish. Resolves when it is gone. */
  drinkBottle(): Promise<void> {
    if (this.bottleMode === "none") return Promise.resolve();
    this.bottleMode = "drinking";
    return new Promise((resolve) => (this.drinkDone = resolve));
  }

  /** Put the bottle away (it shrinks out of his hand); used for "Later". */
  stowBottle() {
    if (this.bottleMode !== "none") this.bottleMode = "stowing";
  }

  dropBottle() {
    this.bottleMode = "none";
    this.bottle.group.visible = false;
  }

  /** The bottle's on-screen rectangle (DOM coordinates), for clicking it. */
  bottleRect(): Rect | null {
    if (this.bottleMode === "none" || !this.bottle.group.visible) return null;
    const p = this.bottle.group.position;
    const s = this.bottle.group.scale.x;
    return { x: p.x - 16 * s, y: this.size.h - p.y - 46 * s, w: 32 * s, h: 50 * s };
  }

  // --- Dragging and throwing ------------------------------------------------------------
  grab() {
    if (this.mode === "hidden" || this.mode === "flying") return false;
    this.walkResolve?.();
    this.mode = "dragging";
    this.resetPose();
    this.play("hang");
    return true;
  }

  /** Move to a pointer position given in DOM coordinates (top-left origin). */
  dragTo(domX: number, domY: number) {
    if (this.mode !== "dragging") return;
    const holdY = this.manifest.height * 0.9; // held near the head
    this.root.position.x = this.clampX(domX);
    this.root.position.y = Math.max(0, this.size.h - domY - holdY);
  }

  /** Let go with a throw velocity (DOM px/s). Bounces off the edges; resolves on landing with impact speed. */
  release(vxDom = 0, vyDom = 0): Promise<number> {
    if (this.mode !== "dragging") return Promise.resolve(0);
    this.mode = "falling";
    this.vx = Math.max(-2600, Math.min(2600, vxDom));
    this.vy = Math.max(-2600, Math.min(2600, -vyDom));
    return new Promise((resolve) => (this.fallResolve = resolve));
  }

  /** Hop straight up and land. */
  jump(): Promise<number> {
    if (this.mode !== "idle") return Promise.resolve(0);
    this.resetPose();
    this.mode = "falling";
    this.vx = 0;
    this.vy = 1050;
    this.play("hang");
    return new Promise((resolve) => (this.fallResolve = resolve));
  }

  /** True when he can be sent walking (standing or already walking). */
  get canWalk() {
    return this.mode === "idle" || this.mode === "walking";
  }

  /** Character bounds in DOM coordinates (top-left origin). */
  rect(): Rect | null {
    if (!this.root.visible || !this.manifest) return null;
    const h = this.manifest.height;
    const w = this.bodyW;
    return { x: this.x - w / 2, y: this.size.h - this.root.position.y - h, w, h };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
  }

  private resetPose() {
    this.pose = "stand";
    this.facing = 0;
    if (this.mixer) this.mixer.timeScale = 1;
  }

  private clampX(x: number) {
    return Math.max(EDGE, Math.min(this.size.w - EDGE, x));
  }

  private fly(from: number, to: number, dur: number): Promise<void> {
    this.mode = "flying";
    return new Promise((done) => (this.flight = { from, to, t: 0, dur, done }));
  }

  private makeRing() {
    const group = new THREE.Group();
    const mat = (opacity: number) =>
      new THREE.MeshBasicMaterial({
        color: 0x4fd1ff,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
    const outer = new THREE.Mesh(new THREE.RingGeometry(46, 50, 64), mat(0.9));
    const inner = new THREE.Mesh(new THREE.RingGeometry(30, 32, 64, 1, 0, Math.PI * 1.4), mat(0.7));
    inner.name = "spin";
    const glow = new THREE.Mesh(new THREE.CircleGeometry(46, 48), mat(0.18));
    group.add(glow, outer, inner);
    group.rotation.x = -Math.PI / 2.4; // lie on the floor, tilted toward the camera
    group.position.set(0, 2, -40);
    group.scale.setScalar(0.001);
    return group;
  }

  private resize = () => {
    this.size = { w: window.innerWidth, h: window.innerHeight };
    this.renderer.setSize(this.size.w, this.size.h, false);
    Object.assign(this.camera, { left: 0, right: this.size.w, top: this.size.h, bottom: 0 });
    this.camera.updateProjectionMatrix();
  };

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.timer.update();
    this.sinceRender += this.timer.getDelta();
    if (this.sinceRender < 1 / FPS_CAP) return; // keep the GPU and battery calm
    const step = Math.min(this.sinceRender, 0.1);
    this.sinceRender = 0;
    this.time += step;

    this.updateMovement(step);
    this.mixer?.update(step);
    this.applyPose(step);
    if (this.model) {
      // Smoothly turn toward the direction of travel (or face the user when idle).
      const target = this.facing + (this.manifest.turn ?? 0);
      const r = this.model.rotation;
      r.y += (target - r.y) * Math.min(1, step * 8);
      const nodTarget = this.pose === "sleep" ? 0.18 + Math.sin(this.time * 0.9) * 0.05 : 0;
      this.nod += (nodTarget - this.nod) * Math.min(1, step * 3);
      r.x = this.nod;
    }
    this.root.updateMatrixWorld(true);
    this.updateBottle(step);
    this.updateRing(step);
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.(this.rect());
  };

  private updateBottle(dt: number) {
    const g = this.bottle.group;
    if (this.bottleMode === "none" || !this.root.visible) {
      g.visible = false;
      return;
    }
    g.visible = true;

    // The bottle sits still in his hand; when offered it just grows a little so you notice it.
    const hand = this.tmp;
    if (this.holdBone) this.holdBone.getWorldPosition(hand);
    else hand.set(this.x + this.bodyW * 0.42, this.root.position.y + this.manifest.height * 0.45, 0);

    const target =
      this.bottleMode === "offered" ? BOTTLE_OFFERED : this.bottleMode === "drinking" || this.bottleMode === "stowing" ? g.scale.x : BOTTLE_HELD;
    // Springy grow so it "pops" in.
    const s = g.scale.x + (target - g.scale.x) * Math.min(1, dt * 9);
    g.scale.setScalar(Math.max(0.001, s));
    g.position.set(hand.x, hand.y - 17 * g.scale.x, 60);
    g.rotation.set(0, 0, 0);

    if (this.bottleMode === "stowing") {
      g.scale.setScalar(Math.max(0.001, g.scale.x - dt * 5));
      if (g.scale.x <= 0.01) this.dropBottle();
    }

    if (this.bottleMode === "drinking") {
      // Drain over ~1.3 s, then shrink away.
      if (this.bottle.fill > 0) {
        this.bottle.setLevel(this.bottle.fill - dt / 1.3);
      } else {
        g.scale.setScalar(Math.max(0.001, g.scale.x - dt * 4));
        if (g.scale.x <= 0.01) {
          this.dropBottle();
          this.drinkDone?.();
          this.drinkDone = undefined;
        }
      }
    }
  }

  /** Procedural pose layer on top of whatever clip is playing: sitting. */
  private applyPose(dt: number) {
    const sitTarget = this.pose === "stand" || this.mode !== "idle" ? 0 : 1;
    this.sit += (sitTarget - this.sit) * Math.min(1, dt * 5);
    if (this.model && this.legs.length) {
      for (const leg of this.legs) leg.rotateX(-1.45 * this.sit);
      this.model.position.y = -this.hipHeight * 0.82 * this.sit;
    }
  }

  private updateRing(dt: number) {
    this.highlight += (this.highlightTarget - this.highlight) * Math.min(1, dt * 10);
    const s = Math.max(0.001, this.highlight * (1 + Math.sin(this.time * 4) * 0.03));
    this.ring.scale.setScalar(s);
    this.ring.visible = this.highlight > 0.01 && this.root.position.y < 4;
    const spin = this.ring.getObjectByName("spin");
    if (spin) spin.rotation.z += dt * 2.2;
  }

  private updateMovement(dt: number) {
    if (this.mode === "walking") {
      const dx = this.walkTarget - this.x;
      const stepPx = 95 * dt;
      if (Math.abs(dx) <= stepPx) {
        this.root.position.x = this.walkTarget;
        this.mode = "idle";
        this.facing = 0;
        this.play("idle");
        this.walkResolve?.();
      } else {
        this.root.position.x += Math.sign(dx) * stepPx;
      }
    }

    if (this.mode === "hanging") {
      this.root.rotation.z = Math.sin(this.time * 1.6) * 0.04; // a slow sway on the thread
    }

    if (this.mode === "dragging") {
      // Dangle: a gentle pendulum while held.
      this.root.rotation.z = Math.sin(this.time * 5) * 0.08;
    }

    if (this.mode === "falling") {
      const p = this.root.position;
      this.vy -= GRAVITY * dt;
      p.x += this.vx * dt;
      p.y += this.vy * dt;
      // Tumble a little with sideways speed.
      this.root.rotation.z = Math.max(-0.6, Math.min(0.6, -this.vx * 0.0003));
      // Bounce off the side walls and the top of the screen.
      if (p.x < EDGE || p.x > this.size.w - EDGE) {
        p.x = this.clampX(p.x);
        this.vx = -this.vx * 0.55;
      }
      const ceiling = this.size.h - this.manifest.height;
      if (p.y > ceiling) {
        p.y = ceiling;
        this.vy = -Math.abs(this.vy) * 0.4;
      }
      if (p.y <= 0) {
        p.y = 0;
        const impact = Math.abs(this.vy);
        if (impact > 700) {
          // Bounce, losing energy each time.
          this.vy = impact * 0.38;
          this.vx *= 0.7;
        } else {
          this.root.rotation.z = 0;
          this.vx = 0;
          this.vy = 0;
          this.mode = "idle";
          this.play(this.looping === "hang" ? "idle" : this.looping);
          this.fallResolve?.(impact);
        }
      }
    }

    if (this.mode === "flying" && this.flight) {
      const f = this.flight;
      f.t = Math.min(f.dur, f.t + dt);
      const p = easeInOut(f.t / f.dur);
      this.root.position.y = f.from + (f.to - f.from) * p;
      this.root.rotation.z = Math.sin(f.t * 6) * 0.06 * (1 - p); // a tiny sway feels physical
      if (f.t >= f.dur) {
        this.root.rotation.z = 0;
        this.flight = undefined;
        f.done();
      }
    }

    // The web thread runs from the top edge down to the character's hands.
    this.thread.visible = this.mode === "flying" || this.mode === "hanging";
    if (this.thread.visible && this.manifest) {
      const top = this.size.h + 10;
      const hands = this.root.position.y + this.manifest.height * 0.92;
      const len = Math.max(1, top - hands);
      this.thread.scale.y = len;
      this.thread.position.set(this.x, hands + len / 2, -5);
    }
  }
}
