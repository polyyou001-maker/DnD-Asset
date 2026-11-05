// Three.js diorama for the creator: a small low-poly island with the live sprite on it.
import * as THREE from 'three';
import { Actor } from '../prototype/src/actor.js';
import { emoteBubble } from '../prototype/src/labels.js';

const DIR_NAMES = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'];

export class Stage {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.yaw = 0;
    this.pitch = THREE.MathUtils.degToRad(18);
    this.dist = 4.6;
    this.facing = 0; // character faces the camera
    this.state = 'idle';
    this.turntable = false;
    this.clock = new THREE.Clock();
    this.#buildIsland();
    this.#bindDrag();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  #buildIsland() {
    const lam = (color, extra) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
    const g = new THREE.Group();
    const top = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 0.18, 10), lam(0x7cc95a));
    top.position.y = -0.09;
    const dirt = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.2, 0.9, 10), lam(0x9a6a44));
    dirt.position.y = -0.63;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(1.2, 0.8, 10), lam(0x7a5238));
    tip.position.y = -1.48; tip.rotation.x = Math.PI;
    g.add(top, dirt, tip);
    // stones, flowers, a lantern
    const rand = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rand() * 0.4, r = 1.55 + rand() * 0.2;
      const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.09 + rand() * 0.07), lam(0xb8b4c8));
      stone.position.set(Math.cos(a) * r, 0.03, Math.sin(a) * r);
      g.add(stone);
    }
    const petals = [0xff8ab0, 0xfff07a, 0xffffff, 0xb08aff];
    for (let i = 0; i < 14; i++) {
      const a = rand() * Math.PI * 2, r = 0.7 + rand() * 0.9;
      const f = new THREE.Mesh(new THREE.OctahedronGeometry(0.045), new THREE.MeshBasicMaterial({ color: petals[i % 4] }));
      f.position.set(Math.cos(a) * r, 0.05, Math.sin(a) * r);
      g.add(f);
    }
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 1.3, 6), lam(0x3a3446));
    pole.position.set(-1.25, 0.65, -0.7);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.16), new THREE.MeshBasicMaterial({ color: 0xffd68a }));
    lamp.position.set(-1.25, 1.36, -0.7);
    g.add(pole, lamp);
    this.island = g;
    this.scene.add(g);

    this.scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x4a3a5a, 1.4));
    const key = new THREE.DirectionalLight(0xffe6c0, 2.2);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const lantern = new THREE.PointLight(0xffb060, 3, 4, 1.5);
    lantern.position.copy(lamp.position);
    this.scene.add(lantern);
    this.lantern = lantern;
  }

  #bindDrag() {
    const dom = this.renderer.domElement;
    let drag = null;
    dom.addEventListener('pointerdown', (e) => { drag = e.clientX; dom.setPointerCapture(e.pointerId); });
    dom.addEventListener('pointermove', (e) => {
      if (drag == null) return;
      this.yaw -= (e.clientX - drag) * 0.01;
      drag = e.clientX;
    });
    dom.addEventListener('pointerup', () => (drag = null));
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = THREE.MathUtils.clamp(this.dist * (e.deltaY > 0 ? 1.1 : 0.9), 3.5, 10);
    }, { passive: false });
  }

  setSheet(sheet) {
    if (this.actor) {
      this.scene.remove(this.actor.root);
      this.actor.texture.dispose();
      this.actor.material.dispose();
    }
    this.actor = new Actor({ name: 'hero', sheet, stats: { maxHp: 1 }, team: 'player', world: null });
    this.actor.facing = this.facing;
    this.actor.setState(this.state);
    this.scene.add(this.actor.root);
  }

  turn(step) { this.facing += step * (Math.PI / 4); }

  play(state) {
    this.state = state;
    if (!this.actor) return;
    if (state === 'attack' || state === 'hit') {
      this.actor.playOnce(state).then(() => { if (this.state === state) this.state = 'idle'; });
    } else this.actor.setState(state);
  }

  emote(symbol) {
    if (!this.actor) return;
    this.actor.labels.forEach((l) => (l.t = l.life));
    this.actor.addLabel(emoteBubble(symbol, 1.75));
  }

  get direction() {
    const rel = this.facing - this.yaw;
    return DIR_NAMES[(((Math.round(-rel / (Math.PI / 4))) % 8) + 8) % 8];
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    if (this.turntable) this.facing += dt * 0.8;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(Math.sin(this.yaw) * cp * this.dist, 0.75 + Math.sin(this.pitch) * this.dist, Math.cos(this.yaw) * cp * this.dist);
    this.camera.lookAt(0, 0.72, 0);
    this.island.position.y = Math.sin(t * 1.2) * 0.03;
    this.lantern.intensity = 3 + Math.sin(t * 7) * 0.25;
    if (this.actor) {
      this.actor.root.position.y = this.island.position.y;
      this.actor.facing = this.facing;
      if (this.actor.state !== this.state && this.state !== 'attack' && this.state !== 'hit') this.actor.setState(this.state);
      this.actor.update(dt, this.yaw, [1, 1, 1]);
    }
    this.onFrame?.();
    this.renderer.render(this.scene, this.camera);
  }
}
