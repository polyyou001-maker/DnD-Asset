import * as THREE from 'three';
import GUI from 'lil-gui';
import { World } from './world.js';
import { Actor } from './actor.js';
import { CameraRig } from './cameraRig.js';
import { DiceTray } from './dice.js';
import { Combat } from './combat.js';
import { findPath, tileKey, chebyshev } from './grid.js';
import { emoteBubble } from './labels.js';
import { createPlaceholderSheet, PALETTES } from './placeholderSheet.js';
import { UI } from './ui.js';

const PLAYER_STATS = { maxHp: 28, ac: 16, toHit: 5, dmg: '1d8+3', speed: 6, dex: 12, xp: 0 };
const MONSTERS = {
  goblin: { name: 'Goblin', palette: 'goblin', stats: { maxHp: 7, ac: 15, toHit: 4, dmg: '1d6+2', speed: 6, dex: 14, xp: 50 } },
  skeleton: { name: 'Skeleton', palette: 'skeleton', stats: { maxHp: 13, ac: 13, toHit: 4, dmg: '1d6+2', speed: 5, dex: 14, xp: 50 } },
  slime: { name: 'Slime', palette: 'slime', stats: { maxHp: 10, ac: 8, toHit: 3, dmg: '1d6+1', speed: 4, dex: 6, xp: 25 } },
};
const EMOTES = { 1: '♥', 2: '!', 3: '?', 4: '♪', 5: '💧', 6: '…' };

// A hero made in ../creator/ is saved here; without one the placeholder knight is used.
async function loadHero() {
  try {
    const saved = JSON.parse(localStorage.getItem('dnd.character'));
    if (!saved?.look) return null;
    const { loadSet, compose } = await import('../../src/paperdoll2/composer.js');
    const set = await loadSet(new URL(saved.setUrl, new URL('../creator/', location.href)).href);
    return { name: saved.name, stats: saved.stats, sheet: compose(set, saved.look) };
  } catch (e) {
    console.warn('No saved hero, using placeholder', e);
    return null;
  }
}

class Game {
  constructor(hero) {
    this.settings = { pixelScale: hero ? 1 : 2, snapRotation: true, pitch: 50, animSpeed: 1, diceSpeed: 1, torchFlicker: true, aggroRange: 4 };

    this.renderer = new THREE.WebGLRenderer({ antialias: false });
    this.renderer.domElement.id = 'view';
    document.body.prepend(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(35, 1, 0.1, 200);
    this.camera = new CameraRig(this.cam, this.renderer.domElement);
    this.dice = new DiceTray(document.getElementById('dice'));
    this.ui = new UI(this);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.clock = new THREE.Clock();
    this.sheets = {};
    this.monsters = [];
    this.highlights = new THREE.Group();
    this.scene.add(this.highlights);
    this.hover = this.#makeHover();
    this.scene.add(this.hover);

    this.player = new Actor({
      name: hero?.name ?? 'Ren', sheet: hero?.sheet ?? this.#sheet('knight'),
      stats: hero?.stats ?? PLAYER_STATS, team: 'player', world: null,
    });
    this.player.onTileEnter = () => this.#onPlayerTile();
    this.torch = new THREE.PointLight(0xffb060, 6, 6, 1.5);
    this.torch.position.set(0, 1.4, 0);

    this.#bindInput();
    this.#buildGui();
    this.applySettings();
    this.enterZone('town');
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  #sheet(paletteId) {
    return (this.sheets[paletteId] ??= createPlaceholderSheet(PALETTES[paletteId]));
  }

  // ---------- zones ----------
  enterZone(zoneId) {
    this.world?.dispose();
    for (const m of this.monsters) this.scene.remove(m.root);
    this.monsters = [];
    this.world = new World(this.scene, zoneId);
    const th = this.world.theme;
    this.scene.background = new THREE.Color(th.background);
    this.scene.fog = new THREE.Fog(th.fog.color, th.fog.near, th.fog.far);

    this.player.world = this.world;
    this.player.stop();
    this.player.placeAt(this.world.spawn.x, this.world.spawn.z);
    this.scene.add(this.player.root);
    if (th.playerTorch) this.player.root.add(this.torch);
    else this.player.root.remove(this.torch);

    const kinds = Object.keys(MONSTERS);
    this.world.monsterSpawns.forEach((t, i) => {
      const def = MONSTERS[kinds[i % kinds.length]];
      const m = new Actor({ name: def.name, sheet: this.#sheet(def.palette), stats: def.stats, team: 'enemy', world: this.world });
      m.placeAt(t.x, t.z);
      m.facing = Math.random() * Math.PI * 2;
      this.monsters.push(m);
      this.scene.add(m.root);
    });

    this.camera.target.copy(this.player.root.position);
    this.camera.focus.copy(this.player.root.position);
    this.ui.setZone(this.world.zone.name);
    this.log(`Entered ${this.world.zone.name}.`, 'sys');
  }

  #onPlayerTile() {
    if (this.combat) return;
    const t = this.player.tile;
    if (t === this.world.portal) {
      this.player.stop();
      this.ui.fade(() => this.enterZone(this.world.zone.portalTo));
    }
  }

  // ---------- combat ----------
  async startCombat() {
    const p = this.player;
    const enemies = this.monsters.filter((m) => m.hp > 0 && chebyshev({ x: m.tx, z: m.tz }, { x: p.tx, z: p.tz }) <= 6);
    p.stop();
    // snap to the tile we're on so the grid is consistent
    p.placeAt(p.tx, p.tz);
    p.setState('idle');
    this.combat = new Combat(this, enemies);
    this.ui.setMode('combat');
    const result = await this.combat.run();
    this.combat = null;
    this.ui.setMode('explore');
    if (result === 'defeat') {
      this.ui.fade(() => {
        Object.assign(p, { hp: p.stats.maxHp, dead: false, downed: false });
        p.setState('idle');
        this.enterZone('town');
        this.log('You wake up at the town shrine.', 'sys');
      });
    }
  }

  showHighlights(reach, targets) {
    this.clearHighlights();
    const moveMat = new THREE.MeshBasicMaterial({ color: 0x5ab0ff, transparent: true, opacity: 0.5, depthWrite: false });
    const geo = new THREE.PlaneGeometry(0.92, 0.92);
    for (const node of reach.values()) {
      if (node.dist === 0) continue;
      const m = new THREE.Mesh(geo, moveMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(node.tile.x, this.world.topY(node.tile) + 0.02, node.tile.z);
      this.highlights.add(m);
    }
    const atkMat = new THREE.MeshBasicMaterial({ color: 0xff4a4a, transparent: true, opacity: 0.5, depthWrite: false });
    for (const t of targets) {
      const m = new THREE.Mesh(geo, atkMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(t.tx, this.world.topY(t.tile) + 0.03, t.tz);
      this.highlights.add(m);
    }
  }

  clearHighlights() {
    for (const c of [...this.highlights.children]) {
      this.highlights.remove(c);
      c.material.dispose();
    }
  }

  // ---------- input ----------
  #bindInput() {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', (e) => this.#setPointer(e));
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.#setPointer(e);
      this.#click();
    });
    window.addEventListener('keydown', (e) => {
      if (e.target.closest?.('.lil-gui')) return;
      const k = e.key.toLowerCase();
      if (k === 'q') this.camera.rotateStep(-1);
      if (k === 'e') this.camera.rotateStep(1);
      if (k === ' ' && this.combat) { e.preventDefault(); this.combat.endPlayerTurn(); }
      if (k === 'x' && !this.combat && !this.player.path.length) {
        this.player.setState(this.player.state === 'sit' ? 'idle' : 'sit');
      }
      if (EMOTES[k] && !this.player.dead) this.emote(EMOTES[k]);
    });
  }

  emote(symbol) {
    this.player.labels.filter((l) => l.isEmote).forEach((l) => (l.t = l.life));
    const b = emoteBubble(symbol, this.player.height);
    b.isEmote = true;
    this.player.addLabel(b);
  }

  #setPointer(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  #pick() {
    this.raycaster.setFromCamera(this.pointer, this.cam);
    const actorHit = this.raycaster.intersectObjects(this.monsters.filter((m) => m.hp > 0).map((m) => m.mesh))[0];
    if (actorHit) return { actor: actorHit.object.userData.actor };
    const hit = this.raycaster.intersectObject(this.world.terrain)[0];
    if (hit) return { tile: this.world.tiles[hit.instanceId] };
    return null;
  }

  #click() {
    const pick = this.#pick();
    if (!pick) return;
    const p = this.player;
    if (this.combat) {
      if (pick.actor) this.combat.playerAttack(pick.actor);
      else if (pick.tile) this.combat.playerMove(pick.tile.x, pick.tile.z);
      return;
    }
    if (p.dead || this.ui.fading) return;
    const tile = pick.tile ?? pick.actor?.tile;
    if (!tile) return;
    // Retarget from the tile we're currently heading into.
    const from = p.path[0] ?? { x: p.tx, z: p.tz };
    const occupied = new Set(this.monsters.filter((m) => m.hp > 0).map((m) => tileKey(m.tx, m.tz)));
    const path = findPath(this.world, from.x, from.z, tile.x, tile.z, occupied);
    if (path) p.walkPath(p.path.length ? [p.path[0], ...path] : path);
  }

  #makeHover() {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.38, 0.46, 4, 1, Math.PI / 4),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  // ---------- settings ----------
  #buildGui() {
    const gui = new GUI({ title: 'Prototype settings' });
    const s = this.settings;
    gui.add(s, 'pixelScale', 1, 4, 1).name('Pixel scale').onChange(() => this.applySettings());
    gui.add(s, 'snapRotation').name('Snap camera 45°').onChange(() => this.applySettings());
    gui.add(s, 'pitch', 35, 65, 1).name('Camera pitch').onChange(() => this.applySettings());
    gui.add(s, 'animSpeed', 0.25, 2, 0.05).name('Animation speed');
    gui.add(s, 'diceSpeed', 0.5, 4, 0.5).name('Dice speed').onChange(() => this.applySettings());
    gui.add(s, 'torchFlicker').name('Torch flicker');
    gui.add(s, 'aggroRange', 2, 8, 1).name('Aggro range');
    const actions = {
      town: () => !this.combat && this.ui.fade(() => this.enterZone('town')),
      dungeon: () => !this.combat && this.ui.fade(() => this.enterZone('dungeon')),
      heal: () => { this.player.hp = this.player.stats.maxHp; },
    };
    gui.add(actions, 'town').name('Go to town');
    gui.add(actions, 'dungeon').name('Go to dungeon');
    gui.add(actions, 'heal').name('Full heal');
  }

  applySettings() {
    const s = this.settings;
    this.renderer.setPixelRatio(1 / s.pixelScale);
    this.camera.snap = s.snapRotation;
    if (s.snapRotation) this.camera.yawGoal = Math.round(this.camera.yawGoal / (Math.PI / 4)) * (Math.PI / 4);
    this.camera.pitch = THREE.MathUtils.degToRad(s.pitch);
    this.dice.speed = s.diceSpeed;
    this.resize();
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.cam.aspect = window.innerWidth / window.innerHeight;
    this.cam.updateProjectionMatrix();
  }

  log(text, cls = '') { this.ui.log(text, cls); }

  // ---------- loop ----------
  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;
    const s = this.settings;
    const p = this.player;

    if (!this.combat) this.camera.target.copy(p.root.position);
    this.camera.update(dt);
    this.world.update(time, s.torchFlicker);

    const extra = this.torch.parent ? [this.torch] : [];
    const tmp = new THREE.Vector3();
    for (const a of [p, ...this.monsters]) {
      tmp.copy(a.root.position).y += 0.8;
      a.update(dt, this.camera.yaw, this.world.lightAt(tmp, extra), s.animSpeed);
    }

    // Sitting regenerates HP out of combat, RO-style.
    if (p.state === 'sit' && p.hp < p.stats.maxHp) {
      p.regen = (p.regen ?? 0) + dt;
      if (p.regen >= 1) { p.regen = 0; p.hp++; }
    }

    // Aggro check while exploring.
    if (!this.combat && !p.dead && !this.ui.fading) {
      const near = this.monsters.find((m) => m.hp > 0 && chebyshev({ x: m.tx, z: m.tz }, { x: p.tx, z: p.tz }) <= s.aggroRange);
      if (near) this.startCombat();
    }

    // Hover marker
    const pick = this.#pick();
    const tile = pick?.tile ?? pick?.actor?.tile;
    this.hover.visible = !!tile;
    if (tile) {
      this.hover.position.set(tile.x, this.world.topY(tile) + 0.04, tile.z);
      const attackable = pick?.actor && this.combat?.turn?.action && this.combat.canMelee(p, pick.actor);
      this.hover.material.color.set(attackable ? 0xff5050 : 0xffffff);
    }

    this.ui.update(dt);
    this.renderer.render(this.scene, this.cam);
  }
}

loadHero().then((hero) => (window.game = new Game(hero)));
