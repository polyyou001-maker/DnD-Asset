import * as THREE from 'three';
import { ZONES } from './maps.js';

export const HEIGHT_UNIT = 0.4;
const WALL_TOP = 1.6;

// char -> tile definition. h = height level, walk = can stand on it.
const TILE_DEFS = {
  town: {
    '.': { kind: 'grass', h: 0, walk: true },
    ',': { kind: 'grass', h: 1, walk: true },
    ':': { kind: 'grass', h: 2, walk: true },
    '=': { kind: 'path', h: 0, walk: true },
    '-': { kind: 'path', h: 1, walk: true },
    '@': { kind: 'path', h: 0, walk: true, spawn: true },
    '~': { kind: 'water', h: -1, walk: false },
    'T': { kind: 'grass', h: 0, walk: false, prop: 'tree' },
    't': { kind: 'grass', h: 1, walk: false, prop: 'tree' },
    'H': { kind: 'grass', h: 0, walk: false, prop: 'house' },
    'F': { kind: 'path', h: 0, walk: false, prop: 'fountain' },
    'L': { kind: 'path', h: 0, walk: false, prop: 'lamp' },
    'P': { kind: 'grass', h: 1, walk: true, prop: 'portal' },
  },
  dungeon: {
    '#': { kind: 'wall', h: 99, walk: false },
    't': { kind: 'wall', h: 99, walk: false, prop: 'torch' },
    '.': { kind: 'stone', h: 0, walk: true },
    ',': { kind: 'stone', h: 1, walk: true },
    ':': { kind: 'stone', h: 2, walk: true },
    '@': { kind: 'stone', h: 0, walk: true, spawn: true },
    'm': { kind: 'stone', h: 0, walk: true, monster: true },
    'l': { kind: 'lava', h: -1, walk: false, prop: 'lava' },
    'c': { kind: 'stone', h: 0, walk: false, prop: 'crystal' },
    'P': { kind: 'stone', h: 0, walk: true, prop: 'portal' },
  },
};

const KIND_COLORS = {
  grass: [0x7cc95a, 0x8fd468, 0x6fbf55],
  path: [0xd8c49a, 0xe2cfa6, 0xcfb98c],
  water: [0x4aa8e0, 0x55b2e8],
  wall: [0x3a3646, 0x34303f, 0x403b4d],
  stone: [0x5b5566, 0x544e5f, 0x625b6d],
  lava: [0xff6a1a, 0xff8a2a],
};

export const THEMES = {
  town: {
    background: 0xbfe3ff, fog: { color: 0xcfe9ff, near: 22, far: 60 },
    ambientTint: 1.0, playerTorch: false,
  },
  dungeon: {
    background: 0x05040a, fog: { color: 0x05040a, near: 6, far: 24 },
    ambientTint: 0.16, playerTorch: true,
  },
};

// Small deterministic RNG so maps look the same every load.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export class World {
  constructor(scene, zoneId) {
    this.scene = scene;
    this.zoneId = zoneId;
    this.zone = ZONES[zoneId];
    this.theme = THEMES[this.zone.theme];
    this.group = new THREE.Group();
    this.lights = []; // { light, base, flicker } — also used to tint sprites
    this.animated = [];
    this.monsterSpawns = [];
    scene.add(this.group);
    this.#parse();
    this.#buildTerrain();
    this.#buildProps();
    this.#buildLighting();
  }

  #parse() {
    const defs = TILE_DEFS[this.zone.theme];
    const rows = this.zone.rows;
    this.width = Math.max(...rows.map((r) => r.length));
    this.depth = rows.length;
    this.tiles = [];
    for (let z = 0; z < this.depth; z++) {
      for (let x = 0; x < this.width; x++) {
        const ch = rows[z][x] ?? rows[z][rows[z].length - 1];
        const def = defs[ch] ?? defs['.'];
        const tile = { x, z, ch, ...def };
        this.tiles.push(tile);
        if (def.spawn) this.spawn = tile;
        if (def.monster) this.monsterSpawns.push(tile);
        if (def.prop === 'portal') this.portal = tile;
      }
    }
  }

  tileAt(x, z) {
    if (x < 0 || z < 0 || x >= this.width || z >= this.depth) return null;
    return this.tiles[z * this.width + x];
  }

  topY(tile) {
    if (tile.kind === 'wall') return WALL_TOP;
    if (tile.h < 0) return -0.15;
    return tile.h * HEIGHT_UNIT;
  }

  isWalkable(x, z) {
    const t = this.tileAt(x, z);
    return !!t && t.walk;
  }

  #buildTerrain() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, this.tiles.length);
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const rand = rng(this.zoneId.length * 7919);
    this.tiles.forEach((t, i) => {
      const top = this.topY(t);
      const bottom = -1;
      // Slight per-tile jitter on non-walls keeps the low-poly look from feeling flat.
      const jitter = t.kind === 'wall' ? 0 : (rand() - 0.5) * 0.04;
      m.makeScale(1, top - bottom + jitter, 1);
      m.setPosition(t.x, (top + bottom + jitter) / 2, t.z);
      mesh.setMatrixAt(i, m);
      const palette = KIND_COLORS[t.kind];
      c.setHex(palette[Math.floor(rand() * palette.length)]);
      mesh.setColorAt(i, c);
    });
    mesh.userData.isTerrain = true;
    this.terrain = mesh;
    this.group.add(mesh);
  }

  #buildProps() {
    const rand = rng(this.zoneId.length * 104729);
    const lambert = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
    const add = (obj, t, dy = 0) => {
      obj.position.set(t.x, this.topY(t) + dy, t.z);
      this.group.add(obj);
      return obj;
    };

    for (const t of this.tiles) {
      switch (t.prop) {
        case 'tree': {
          const g = new THREE.Group();
          const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.14, 0.6, 5), lambert(0x8a5a33));
          trunk.position.y = 0.3;
          const s = 0.8 + rand() * 0.4;
          const leaf = lambert([0x4fae4a, 0x5fbf52, 0x3f9e45][Math.floor(rand() * 3)]);
          const c1 = new THREE.Mesh(new THREE.ConeGeometry(0.55 * s, 0.9 * s, 6), leaf);
          c1.position.y = 0.85;
          const c2 = new THREE.Mesh(new THREE.ConeGeometry(0.4 * s, 0.7 * s, 6), leaf);
          c2.position.y = 1.3;
          g.add(trunk, c1, c2);
          g.rotation.y = rand() * Math.PI;
          add(g, t);
          break;
        }
        case 'house': {
          // One house per 2x2 cluster, anchored at its top-left tile.
          const left = this.tileAt(t.x - 1, t.z), up = this.tileAt(t.x, t.z - 1);
          if (left?.prop === 'house' || up?.prop === 'house') break;
          const g = new THREE.Group();
          const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.3, 1.8), lambert(0xf3e6c8));
          body.position.y = 0.65;
          const roof = new THREE.Mesh(new THREE.ConeGeometry(1.55, 1.0, 4), lambert(rand() > 0.5 ? 0xd2553f : 0x4f74c8));
          roof.position.y = 1.8;
          roof.rotation.y = Math.PI / 4;
          const door = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.05), lambert(0x7a4a2a));
          door.position.set(0, 0.3, 0.92);
          const win = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.05), lambert(0xffe9a0, { emissive: 0x554411 }));
          win.position.set(0.5, 0.85, 0.92);
          g.add(body, roof, door, win);
          g.position.set(t.x + 0.5, this.topY(t), t.z + 0.5);
          this.group.add(g);
          break;
        }
        case 'fountain': {
          const g = new THREE.Group();
          const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 0.35, 8), lambert(0xcfcfd8));
          base.position.y = 0.17;
          const water = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.05, 8), lambert(0x6ac4f0, { emissive: 0x113355 }));
          water.position.y = 0.34;
          const col = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 0.8, 6), lambert(0xdedee6));
          col.position.y = 0.7;
          g.add(base, water, col);
          add(g, t);
          break;
        }
        case 'lamp': {
          const g = new THREE.Group();
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.4, 5), lambert(0x333344));
          pole.position.y = 0.7;
          const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial({ color: 0xffe2a0 }));
          bulb.position.y = 1.45;
          g.add(pole, bulb);
          add(g, t);
          this.#addLight(0xffd28a, 3, 5, t.x, this.topY(t) + 1.45, t.z, 0.05);
          break;
        }
        case 'portal': {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.45, 0.07, 6, 16),
            new THREE.MeshBasicMaterial({ color: 0xc58bff })
          );
          ring.position.y = 0.6;
          const g = add(new THREE.Group().add(ring), t);
          this.animated.push((time) => { ring.rotation.y = time * 1.5; ring.position.y = 0.6 + Math.sin(time * 2) * 0.05; });
          this.#addLight(0xb070ff, 4, 4, g.position.x, g.position.y + 0.6, g.position.z, 0.1);
          break;
        }
        case 'torch': {
          // Place the flame on the side of the wall facing an open floor tile.
          const n = [[0, 1], [1, 0], [-1, 0], [0, -1]].find(([dx, dz]) => this.isWalkable(t.x + dx, t.z + dz)) ?? [0, 1];
          const flame = new THREE.Mesh(new THREE.OctahedronGeometry(0.1), new THREE.MeshBasicMaterial({ color: 0xffa040 }));
          const px = t.x + n[0] * 0.55, pz = t.z + n[1] * 0.55, py = 1.4;
          flame.position.set(px, py, pz);
          this.group.add(flame);
          this.animated.push((time) => { flame.scale.setScalar(1 + Math.sin(time * 13 + t.x) * 0.15); });
          this.#addLight(0xff9a40, 9, 7, px + n[0] * 0.3, py, pz + n[1] * 0.3, 0.25);
          break;
        }
        case 'crystal': {
          const cr = new THREE.Mesh(
            new THREE.OctahedronGeometry(0.35),
            new THREE.MeshLambertMaterial({ color: 0x66e6ff, emissive: 0x1aa0c0, flatShading: true })
          );
          cr.scale.y = 1.8;
          cr.position.y = 0.6;
          add(new THREE.Group().add(cr), t);
          this.animated.push((time) => { cr.rotation.y = time * 0.6; });
          this.#addLight(0x55ddff, 5, 5, t.x, 0.9, t.z, 0.05);
          break;
        }
        case 'lava': {
          // A single light per lava pool, at its first tile found in scan order.
          const seen = this.tiles.some((o) => o.prop === 'lava' && (o.z < t.z || (o.z === t.z && o.x < t.x)) && Math.abs(o.x - t.x) < 3 && Math.abs(o.z - t.z) < 3);
          if (!seen) this.#addLight(0xff5a10, 10, 7, t.x, 0.5, t.z + 1, 0.15);
          break;
        }
      }
    }

    // Lava and water glow regardless of scene lighting.
    const glow = new THREE.MeshBasicMaterial({ color: 0xff7a20 });
    for (const t of this.tiles.filter((t) => t.kind === 'lava')) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glow);
      p.rotation.x = -Math.PI / 2;
      p.position.set(t.x, this.topY(t) + 0.01, t.z);
      this.group.add(p);
    }
  }

  #addLight(color, intensity, distance, x, y, z, flicker) {
    const light = new THREE.PointLight(color, intensity, distance, 1.5);
    light.position.set(x, y, z);
    this.group.add(light);
    this.lights.push({ light, base: intensity, flicker, seed: Math.random() * 100 });
  }

  #buildLighting() {
    if (this.zone.theme === 'town') {
      this.group.add(new THREE.HemisphereLight(0xfff4e0, 0x7fa860, 1.6));
      const sun = new THREE.DirectionalLight(0xfff0d0, 2.0);
      sun.position.set(8, 14, 4);
      this.group.add(sun);
    } else {
      this.group.add(new THREE.AmbientLight(0x3a3a70, 0.35));
    }
  }

  update(time, flickerOn) {
    for (const fn of this.animated) fn(time);
    for (const l of this.lights) {
      const f = flickerOn ? 1 + (Math.sin(time * 9 + l.seed) * 0.5 + Math.sin(time * 23 + l.seed * 3) * 0.5) * l.flicker : 1;
      l.light.intensity = l.base * f;
    }
  }

  // Approximate light at a point, used to tint unlit billboard sprites so
  // they darken in dungeons and glow near torches like the 3D scene does.
  lightAt(pos, extraLights = []) {
    let r = this.theme.ambientTint, g = r, b = r;
    const lp = new THREE.Vector3();
    for (const { light } of [...this.lights, ...extraLights.map((light) => ({ light }))]) {
      const d = light.getWorldPosition(lp).distanceTo(pos);
      if (d >= light.distance) continue;
      const k = Math.pow(1 - d / light.distance, 1.5) * light.intensity * 0.12;
      r += light.color.r * k; g += light.color.g * k; b += light.color.b * k;
    }
    return [Math.min(r, 1.25), Math.min(g, 1.25), Math.min(b, 1.25)];
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) [].concat(o.material).forEach((m) => m.dispose());
    });
  }
}
