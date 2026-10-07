// A small 3D water bottle built from code (no model file): a lathe-turned glass
// body, a water column that can drain, a cap, a label band and a soft glow disc.
// Units are screen pixels like the rest of the stage; the bottle is ~40 px tall.

import * as THREE from "three";

const BODY_PROFILE: [number, number][] = [
  [0, 0], [8, 0], [9, 1.2], [9, 25], [7.5, 30], [4.4, 33.5], [4.4, 38], [0, 38],
];
const WATER_PROFILE: [number, number][] = [
  [0, 0], [7.6, 0], [8.1, 0.06], [8.1, 1], [0, 1],
];
const WATER_MAX = 26; // px of water when full

export class Bottle {
  readonly group = new THREE.Group(); // positioned by the stage
  private water: THREE.Mesh;
  private glow: THREE.Mesh;
  private level = 1;

  constructor() {
    const lathe = (pts: [number, number][]) =>
      new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 28);

    const glass = new THREE.Mesh(
      lathe(BODY_PROFILE),
      new THREE.MeshStandardMaterial({
        color: 0xd8f3ff,
        roughness: 0.08,
        metalness: 0,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );

    this.water = new THREE.Mesh(
      lathe(WATER_PROFILE),
      new THREE.MeshStandardMaterial({ color: 0x2fa8ff, roughness: 0.2, transparent: true, opacity: 0.88 }),
    );
    this.water.position.y = 1.4;

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(4.9, 4.9, 5, 20),
      new THREE.MeshStandardMaterial({ color: 0x14c8ff, roughness: 0.35, emissive: 0x0a5f80, emissiveIntensity: 0.6 }),
    );
    cap.position.y = 40;

    const label = new THREE.Mesh(
      new THREE.CylinderGeometry(9.25, 9.25, 7, 28, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, side: THREE.DoubleSide }),
    );
    label.position.y = 13;

    const stripe = new THREE.Mesh(
      new THREE.CylinderGeometry(9.3, 9.3, 1.6, 28, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x14c8ff, side: THREE.DoubleSide }),
    );
    stripe.position.y = 13;

    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(30, 40),
      new THREE.MeshBasicMaterial({
        color: 0x4fd1ff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.glow.position.set(0, 20, -14);

    // Draw order: water first, then label, then the glass shell on top.
    this.water.renderOrder = 1;
    label.renderOrder = 2;
    stripe.renderOrder = 3;
    glass.renderOrder = 4;
    this.group.add(this.glow, this.water, label, stripe, cap, glass);
    this.setLevel(1);
    this.group.visible = false;
  }

  /** 0 = empty, 1 = full. */
  setLevel(level: number) {
    this.level = Math.max(0, Math.min(1, level));
    this.water.scale.y = Math.max(0.001, this.level * WATER_MAX);
    this.water.visible = this.level > 0.01;
  }

  get fill() {
    return this.level;
  }

  /** Glow strength 0..1 (used while the bottle is being offered). */
  setGlow(strength: number) {
    (this.glow.material as THREE.MeshBasicMaterial).opacity = 0.28 * strength;
  }
}
