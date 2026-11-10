// Animation lab: one hero on a training yard, every animation on a button or a key.
// Uses the real paper-doll set (art/paperdoll2/A) so each weapon's attack style can be checked
// from all 8 directions, walking by click (path) or keyboard (held keys, camera-relative).
import * as THREE from 'three';
import { World } from './world.js';
import { Actor, spriteDirection } from './actor.js';
import { CameraRig } from './cameraRig.js';
import { findPath, tileKey } from './grid.js';
import { floatingText } from './labels.js';
import { createPlaceholderSheet, PALETTES } from './placeholderSheet.js';
import { loadSet, compose, attackStyle } from '../../src/paperdoll2/composer.js';
import { CLASSES, EYE_COLORS } from '../../src/character/rules.js';
import { composeBody } from './bodySheet.js';
import { dyeLayer } from '../../src/paperdoll2/dye.js';

const SET_URL = new URL('../art/paperdoll2/A/', location.href).href;
const BODIES_URL = new URL('../art/bodies/', location.href).href;
const BODIES = [[null, 'Paper doll'], ['human', 'Human'], ['elf', 'Elf'], ['dwarf', 'Dwarf'], ['halfling', 'Halfling']];
const WEAPONS = [['longsword', 'Sword'], ['mace', 'Mace'], ['dagger', 'Dagger'], ['staff', 'Staff'], [null, 'Unarmed']];
const SHIELDS = [[null, 'None'], ['shield_kite', 'Kite'], ['shield_round', 'Round']];
const HAIRS = [['hair_short', 'Short'], ['hair_bob', 'Bob'], ['hair_long', 'Long'], ['hair_twintails', 'Twintails']];
const OUTFITS = Object.values(CLASSES).map((c) => c.kit.outfit);
const STATES = ['idle', 'walk', 'run', 'attack', 'block', 'hit', 'sit', 'dead'];
const DAMAGE = { slash: [8, 3], smash: [6, 3], stab: [4, 3], cast: [10, 0], punch: [1, 2] }; // [die, bonus]
const DIR_NAMES = ['S', 'SW', 'W', 'NW', 'N'];
const DUMMY_HP = 20;
const DEFAULT_LOOK = {
  outfit: 'outfit_fighter', hair: 'hair_short', hairColor: '#8a5a3a', skin: '#f6d2b8', eyes: '#3f7fe0',
  weapon: 'longsword', shield: 'shield_kite',
};

function savedLook() {
  try { return JSON.parse(localStorage.getItem('dnd.character'))?.look ?? null; } catch { return null; }
}

class Lab {
  constructor(set) {
    this.set = set;
    this.look = { ...DEFAULT_LOOK, ...savedLook() };
    this.speed = 1;
    this.repeat = false;
    this.turntable = false;
    this.keys = new Set();
    this.busy = false;        // an attack/block/hit is playing
    this.pendingHit = null;   // { t, target, style } — fires at the attack's impact frame
    this.bolts = [];
    this.body = null;         // null = paper-doll set A; else a frame-by-frame body (art/bodies/<name>)
    this.bodySheets = {};

    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.domElement.id = 'view';
    document.body.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
    this.camera = new CameraRig(this.cam, this.renderer.domElement);
    this.camera.distGoal = this.camera.dist = 10;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-9, -9);
    this.clock = new THREE.Clock();

    this.world = new World(this.scene, 'arena');
    const th = this.world.theme;
    this.scene.background = new THREE.Color(th.background);
    this.scene.fog = new THREE.Fog(th.fog.color, th.fog.near, th.fog.far);

    const dummySheet = createPlaceholderSheet(PALETTES.skeleton);
    this.dummies = this.world.monsterSpawns.map((t) => {
      const d = new Actor({ name: 'Dummy', sheet: dummySheet, stats: { maxHp: DUMMY_HP }, team: 'enemy', world: this.world });
      d.placeAt(t.x, t.z);
      d.facing = Math.atan2(this.world.spawn.x - t.x, this.world.spawn.z - t.z); // face the middle
      this.scene.add(d.root);
      return d;
    });

    this.hover = new THREE.Mesh(new THREE.RingGeometry(0.38, 0.46, 4, 1, Math.PI / 4),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false }));
    this.hover.rotation.x = -Math.PI / 2;
    this.scene.add(this.hover);

    this.rebuildHero();
    this.#bindInput();
    this.#buildPanel();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------- hero ----------
  rebuildHero() {
    const old = this.hero;
    const sheet = this.body ? this.bodySheet() : compose(this.set, this.look);
    this.hero = new Actor({ name: 'Hero', sheet, stats: { maxHp: 30 }, team: 'player', world: this.world });
    if (sheet.walkSpeed) this.hero.moveSpeed = sheet.walkSpeed; // drawn stride -> no foot sliding
    if (old) {
      old.stop(); // settles a pending walk (attackDummy awaits it)
      this.hero.placeAt(old.tx, old.tz);
      this.hero.facing = old.facing;
      this.scene.remove(old.root);
      if (!old.sheet.body) old.sheet.texture?.dispose(); // body sheets are cached and reused
      old.texture.dispose();
      old.material.dispose();
    } else {
      this.hero.placeAt(this.world.spawn.x, this.world.spawn.z);
      this.camera.focus.copy(this.hero.root.position);
    }
    this.scene.add(this.hero.root);
    this.busy = false;
    this.pendingHit = null;
    this.#syncButtons();
  }

  // One composed sheet per look; the Actors share them.
  bodySheet() {
    const b = this.bodySheets[this.body];
    const armed = attackStyle(this.set, this.look);
    const style = armed === 'punch' ? 'stab' : armed; // bare hands use the stab frames (spec)
    const { eyes, outfit, hair, hairColor, cloth1, cloth2 } = this.look;
    const worn = [outfit, hair].filter((id) => b.layers[id]); // clothes under hair
    const dye = (id, image) => dyeLayer(image, { id, slot: b.layers[id].slot === 'hair' ? 'hair' : 'body' },
      this.look, this.set.manifest);
    const layers = worn.map((id) => ({ image: dye(id, b.layers[id].image), back: b.layers[id].back && dye(id, b.layers[id].back) }));
    return (b.composed[[eyes, style, ...worn, hairColor, cloth1, cloth2].join(' ')] ??=
      composeBody(b.meta, b.image, b.eyes, eyes, style, layers));
  }

  // Frame-by-frame bodies (pipeline/bodies.py): sheet.json is the Actor sheet format minus the eyes.
  async setBody(name) {
    if (name && !this.bodySheets[name]) {
      try {
        const meta = await (await fetch(`${BODIES_URL}${name}/sheet.json`)).json();
        const [image, eyes] = ['sheet', 'eyes'].map((f) => Object.assign(new Image(), { src: `${BODIES_URL}${name}/${f}.png` }));
        await Promise.all([image.decode(), eyes.decode()]);
        const layers = {}; // hair and clothes made for this body so far (pipeline/layers.py)
        await Promise.all([...OUTFITS, ...HAIRS.map(([id]) => id)].map(async (id) => {
          const res = await fetch(`${BODIES_URL}${name}/layers/${id}/layer.json`);
          if (!res.ok) return;
          const info = await res.json();
          const load = async (file) => {
            const img = Object.assign(new Image(), { src: `${BODIES_URL}${name}/layers/${id}/${file}` });
            await img.decode();
            return img;
          };
          const [image, back] = await Promise.all([load('sheet.png'), info.back ? load(info.back) : null]);
          layers[id] = { ...info, image, back };
        }));
        this.bodySheets[name] = { meta, image, eyes, layers, composed: {} };
      } catch (e) {
        console.warn(`body ${name} not built yet`, e);
        return;
      }
    }
    this.body = name;
    this.rebuildHero();
  }

  setLook(patch) {
    Object.assign(this.look, patch);
    this.rebuildHero();
  }

  get dead() { return this.hero.state === 'dead'; }
  occupied() { return new Set(this.dummies.map((d) => tileKey(d.tx, d.tz))); }

  // Tile step one 8-way unit along the hero's facing.
  facingStep() {
    return [Math.round(Math.sin(this.hero.facing)), Math.round(Math.cos(this.hero.facing))];
  }

  dummyAt(x, z) { return this.dummies.find((d) => d.tx === x && d.tz === z); }

  // First dummy along the facing line, up to `range` tiles (for bolts).
  dummyInLine(range) {
    const [dx, dz] = this.facingStep();
    for (let i = 1; i <= range; i++) {
      const d = this.dummyAt(this.hero.tx + dx * i, this.hero.tz + dz * i);
      if (d) return d;
    }
    return null;
  }

  // ---------- actions ----------
  async play(state, target = null) {
    const h = this.hero;
    if (!h.sheet.states[state]) return; // e.g. a body that only has idle + walk so far
    if (state === 'dead') { this.toggleDead(); return; }
    if (this.dead || this.busy) return;
    h.stop();
    if (state === 'sit' || state === 'idle' || state === 'walk' || state === 'run') {
      h.setState(state === 'sit' && h.state === 'sit' ? 'idle' : state);
      return;
    }
    if (target) h.faceToward(target.root.position.x, target.root.position.z);
    this.busy = true;
    if (state === 'attack') {
      const style = h.sheet.attackStyle;
      const [dx, dz] = this.facingStep();
      const victim = style === 'cast' ? target ?? this.dummyInLine(6) : target ?? this.dummyAt(h.tx + dx, h.tz + dz);
      this.pendingHit = { t: h.sheet.attackHitTime, target: victim, style };
    }
    await h.playOnce(state);
    this.busy = false;
    if (this.repeat && h.state === 'idle' && !h.path.length) this.play(state, target);
  }

  toggleDead() {
    const h = this.hero;
    if (!h.sheet.states.dead) return;
    h.stop();
    this.busy = false;
    this.pendingHit = null;
    if (h.state === 'dead') h.setState('idle');
    else h.playOnce('dead');
  }

  impact({ target, style }) {
    if (style === 'cast') return this.#launchBolt(target);
    if (target) this.#damage(target, style);
  }

  #damage(dummy, style) {
    if (dummy.state === 'dead') return;
    const [die, bonus] = DAMAGE[style];
    const dmg = 1 + Math.floor(Math.random() * die) + bonus;
    dummy.hp -= dmg;
    dummy.flash = 1;
    dummy.addLabel(floatingText(String(dmg), '#ffffff', dummy.height));
    if (dummy.hp > 0) dummy.playOnce('hit');
    else {
      dummy.playOnce('dead');
      setTimeout(() => { dummy.hp = DUMMY_HP; dummy.setState('idle'); }, 2500);
    }
  }

  #launchBolt(target) {
    const h = this.hero;
    const from = h.root.position.clone().add(new THREE.Vector3(0, 0.95, 0));
    const [dx, dz] = this.facingStep();
    const to = target
      ? target.root.position.clone().add(new THREE.Vector3(0, 0.7, 0))
      : from.clone().add(new THREE.Vector3(dx * 6, -0.2, dz * 6));
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xbfe6ff }));
    const light = new THREE.PointLight(0x7ac4ff, 4, 3, 1.5);
    mesh.add(light);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.bolts.push({ mesh, to, target });
  }

  // Click on a dummy: walk to the nearest free tile next to it, then attack.
  async attackDummy(dummy) {
    const h = this.hero;
    if (this.dead || this.busy) return;
    const style = h.sheet.attackStyle;
    const near = Math.max(Math.abs(dummy.tx - h.tx), Math.abs(dummy.tz - h.tz));
    if (style !== 'cast' && near > 1) {
      const occ = this.occupied();
      let best = null;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const p = findPath(this.world, h.tx, h.tz, dummy.tx + dx, dummy.tz + dz, occ);
        if (p && (!best || p.length < best.length)) best = p;
      }
      if (!best) return;
      await h.walkPath(best);
      if (h.tx !== best.at(-1).x || h.tz !== best.at(-1).z) return; // interrupted by another order
    }
    this.play('attack', dummy);
  }

  walkTo(tile) {
    const h = this.hero;
    if (this.dead || this.busy) return;
    if (h.state === 'sit') h.setState('idle');
    const from = h.path[0] ?? { x: h.tx, z: h.tz };
    const path = findPath(this.world, from.x, from.z, tile.x, tile.z, this.occupied());
    if (path) h.walkPath(h.path.length ? [h.path[0], ...path] : path);
  }

  // Held WASD/arrows -> one 8-way grid step, relative to the camera.
  #keyStep() {
    const k = this.keys;
    const fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
    const right = (k.has('d') || k.has('arrowright') ? 1 : 0) - (k.has('a') || k.has('arrowleft') ? 1 : 0);
    if (!fwd && !right) return null;
    const y = this.camera.yawGoal;
    const vx = -Math.sin(y) * fwd + Math.cos(y) * right;
    const vz = -Math.cos(y) * fwd - Math.sin(y) * right;
    const a = Math.round(Math.atan2(vx, vz) / (Math.PI / 4)) * (Math.PI / 4);
    return [Math.round(Math.sin(a)), Math.round(Math.cos(a))];
  }

  #keyboardWalk() {
    const h = this.hero;
    if (this.dead || this.busy) return;
    const step = this.#keyStep();
    if (!step) return;
    // queue one step ahead so walking does not stop between tiles
    if (h.path.length > 1) return;
    const from = h.path[0] ?? { x: h.tx, z: h.tz };
    const path = findPath(this.world, from.x, from.z, from.x + step[0], from.z + step[1], this.occupied());
    if (path?.length === 1) {
      if (h.state === 'sit') h.setState('idle');
      if (h.path.length) h.path.push(path[0]);
      else h.walkPath(path);
    } else if (!h.path.length) {
      h.facing = Math.atan2(step[0], step[1]); // blocked: turn in place
    }
  }

  // ---------- input ----------
  #bindInput() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', (e) => this.#setPointer(e));
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.#setPointer(e);
      const pick = this.#pick();
      if (pick?.dummy) this.attackDummy(pick.dummy);
      else if (pick?.tile) this.walkTo(pick.tile);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
        this.keys.add(k);
        return;
      }
      if (e.repeat) return;
      if (k === ' ' || k === 'f') { e.preventDefault(); this.play('attack'); }
      else if (k === 'g') this.play('block');
      else if (k === 'h') this.play('hit');
      else if (k === 'k') this.toggleDead();
      else if (k === 'x') this.play('sit');
      else if (k === 'q') this.camera.rotateStep(-1);
      else if (k === 'e') this.camera.rotateStep(1);
      else if (k === 'b') {
        const i = SHIELDS.findIndex(([id]) => id === (this.look.shield ?? null));
        this.setLook({ shield: SHIELDS[(i + 1) % SHIELDS.length][0] });
      } else if (k === 'tab') {
        e.preventDefault();
        const ids = Object.keys(CLASSES);
        const cur = ids.findIndex((id) => CLASSES[id].kit.outfit === this.look.outfit);
        this.setLook({ ...CLASSES[ids[(cur + 1) % ids.length]].kit });
      } else if (k >= '1' && k <= String(WEAPONS.length)) this.setLook({ weapon: WEAPONS[+k - 1][0] });
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  #setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  #pick() {
    this.raycaster.setFromCamera(this.pointer, this.cam);
    const hit = this.raycaster.intersectObjects(this.dummies.map((d) => d.mesh))[0];
    if (hit) return { dummy: hit.object.userData.actor };
    const t = this.raycaster.intersectObject(this.world.terrain)[0];
    return t ? { tile: this.world.tiles[t.instanceId] } : null;
  }

  // ---------- panel ----------
  #buildPanel() {
    const btn = (parent, label, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { onClick(); b.blur(); });
      document.getElementById(parent).append(b);
      return b;
    };
    this.bodyBtns = BODIES.map(([id, name]) => [btn('bodies', name, () => this.setBody(id)), id]);
    this.eyeBtns = Object.entries(EYE_COLORS).map(([name, hex]) => [btn('eyes', name, () => this.setLook({ eyes: hex })), hex]);
    this.classBtns = Object.entries(CLASSES).map(([id, c]) => [btn('classes', c.name, () => this.setLook({ ...c.kit })), c.kit.outfit]);
    this.hairBtns = HAIRS.map(([id, name]) => [btn('hairs', name, () => this.setLook({ hair: id })), id]);
    this.weaponBtns = WEAPONS.map(([id, name], i) => [btn('weapons', `${name} ${i + 1}`, () => this.setLook({ weapon: id })), id]);
    this.shieldBtns = SHIELDS.map(([id, name]) => [btn('shields', name, () => this.setLook({ shield: id })), id]);
    for (const s of STATES) btn('states', s, () => this.play(s));
    btn('states', '⟲', () => (this.hero.facing += Math.PI / 4));
    btn('states', '⟳', () => (this.hero.facing -= Math.PI / 4));
    this.turnBtn = btn('states', 'Turntable', () => { this.turntable = !this.turntable; this.turnBtn.classList.toggle('on', this.turntable); });
    this.repeatBtn = btn('states', 'Repeat', () => { this.repeat = !this.repeat; this.repeatBtn.classList.toggle('on', this.repeat); });
    const speed = document.getElementById('speed');
    speed.addEventListener('input', () => {
      this.speed = +speed.value;
      document.getElementById('speed-v').textContent = `${this.speed.toFixed(2)}×`;
    });
    this.readout = document.getElementById('readout');
    this.#syncButtons();
  }

  #syncButtons() {
    if (!this.classBtns) return;
    for (const [b, id] of this.bodyBtns) b.classList.toggle('on', id === this.body);
    for (const [b, hex] of this.eyeBtns) b.classList.toggle('on', hex === this.look.eyes);
    for (const [b, outfit] of this.classBtns) b.classList.toggle('on', outfit === this.look.outfit);
    for (const [b, id] of this.hairBtns) b.classList.toggle('on', id === this.look.hair);
    for (const [b, id] of this.weaponBtns) b.classList.toggle('on', id === (this.look.weapon ?? null));
    for (const [b, id] of this.shieldBtns) b.classList.toggle('on', id === (this.look.shield ?? null));
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.cam.aspect = window.innerWidth / window.innerHeight;
    this.cam.updateProjectionMatrix();
  }

  // ---------- loop ----------
  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const h = this.hero;
    this.#keyboardWalk();
    if (this.turntable && !h.path.length) h.facing += dt * 0.8;

    if (this.pendingHit) {
      this.pendingHit.t -= dt * this.speed;
      if (this.pendingHit.t <= 0) { const p = this.pendingHit; this.pendingHit = null; this.impact(p); }
    }
    for (const b of this.bolts) {
      const d = b.to.clone().sub(b.mesh.position);
      const step = 9 * dt * this.speed;
      if (d.length() <= step) {
        b.done = true;
        if (b.target) this.#damage(b.target, 'cast');
      } else b.mesh.position.addScaledVector(d.normalize(), step);
    }
    for (const b of this.bolts.filter((x) => x.done)) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mesh.material.dispose();
    }
    this.bolts = this.bolts.filter((b) => !b.done);

    this.camera.target.copy(h.root.position);
    this.camera.update(dt);
    this.world.update(this.clock.elapsedTime, true);
    const tmp = new THREE.Vector3();
    for (const a of [h, ...this.dummies]) {
      tmp.copy(a.root.position).y += 0.8;
      a.update(dt, this.camera.yaw, this.world.lightAt(tmp), this.speed);
    }

    const pick = this.#pick();
    const tile = pick?.tile ?? pick?.dummy?.tile;
    this.hover.visible = !!tile;
    if (tile) {
      this.hover.position.set(tile.x, this.world.topY(tile) + 0.04, tile.z);
      this.hover.material.color.set(pick.dummy ? 0xff5050 : 0xffffff);
    }

    const { drawn, mirror } = spriteDirection(h.facing, this.camera.yaw);
    const anim = h.sheet.states[h.state];
    const fi = Math.floor(h.stateTime * anim.fps);
    const n = anim.dirs[drawn].length;
    this.readout.textContent =
      `state   ${h.state}  frame ${(anim.loop ? fi % n : Math.min(fi, n - 1)) + 1}/${n}\n` +
      `dir     ${DIR_NAMES[drawn]}${mirror ? ' (mirrored)' : ''}  facing ${Math.round(((h.facing * 180 / Math.PI) % 360 + 360) % 360)}°\n` +
      `${this.body ? `body    ${this.body}  speed ${h.moveSpeed} t/s` : `attack  ${h.sheet.attackStyle}`}  tile ${h.tx},${h.tz}`;

    this.renderer.render(this.scene, this.cam);
  }
}

loadSet(SET_URL).then((set) => (window.lab = new Lab(set)));
