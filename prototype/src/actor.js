import * as THREE from 'three';

export const PIXEL_WORLD = 1 / 26; // world units per sprite pixel
const DIR_STEP = Math.PI / 4;

// 8 directions relative to the camera: 0=S (toward camera) 1=SW 2=W 3=NW 4=N 5=NE 6=E 7=SE.
// Only 0..4 are drawn; 5..7 reuse 3..1 mirrored.
export function spriteDirection(facing, cameraYaw) {
  const idx = (((Math.round(-(facing - cameraYaw) / DIR_STEP)) % 8) + 8) % 8;
  return idx <= 4 ? { drawn: idx, mirror: false } : { drawn: 8 - idx, mirror: true };
}

const shadowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 2, 16, 16, 16);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
})();

export class Actor {
  constructor({ name, sheet, stats, team, world }) {
    this.name = name;
    this.sheet = sheet;
    this.stats = { ...stats };
    this.hp = stats.maxHp;
    this.team = team;
    this.world = world;
    this.facing = 0;
    this.state = 'idle';
    this.stateTime = 0;
    this.onceResolve = null;
    this.path = [];
    this.moveResolve = null;
    this.moveSpeed = 3.2; // tiles per second
    this.flash = 0;

    if (!sheet.texture) {
      sheet.texture = new THREE.CanvasTexture(sheet.image);
      sheet.texture.magFilter = sheet.texture.minFilter = THREE.NearestFilter;
      sheet.texture.generateMipmaps = false;
      sheet.texture.colorSpace = THREE.SRGBColorSpace;
    }
    // Clones share the GPU image but keep their own UV offset/repeat.
    this.texture = sheet.texture.clone();
    this.texture.repeat.set(sheet.frameW / sheet.image.width, sheet.frameH / sheet.image.height);

    const ppw = sheet.ppu ? 1 / sheet.ppu : PIXEL_WORLD;
    const w = sheet.frameW * ppw, h = sheet.frameH * ppw;
    const geo = new THREE.PlaneGeometry(w, h);
    const feetY = sheet.feetY ?? sheet.frameH - 1;
    geo.translate(0, h / 2 - (sheet.frameH - 1 - feetY) * ppw, 0); // pivot at the feet
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.userData.actor = this;
    this.height = h;
    // Silhouette drawn only where a wall hides the sprite, so actors stay readable behind geometry.
    this.xray = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: this.texture, color: 0x8a7aff, transparent: true, opacity: 0.45, alphaTest: 0.5,
      side: THREE.DoubleSide, depthWrite: false, depthFunc: THREE.GreaterDepth,
    }));
    this.xray.renderOrder = 5;

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.5),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
    );
    this.shadow.rotation.x = -Math.PI / 2;

    this.root = new THREE.Group();
    this.root.add(this.mesh, this.xray, this.shadow);
    this.labels = [];
  }

  get alive() { return this.hp > 0 || this.downed; }
  get tile() { return this.world.tileAt(this.tx, this.tz); }

  placeAt(tx, tz) {
    this.tx = tx; this.tz = tz;
    const t = this.world.tileAt(tx, tz);
    this.root.position.set(tx, this.world.topY(t), tz);
  }

  faceToward(x, z) {
    const dx = x - this.root.position.x, dz = z - this.root.position.z;
    if (dx || dz) this.facing = Math.atan2(dx, dz);
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.stateTime = 0;
  }

  // Play a non-looping animation and resolve when it ends.
  playOnce(state) {
    this.onceResolve?.();
    this.setState(state);
    this.stateTime = 0;
    return new Promise((r) => (this.onceResolve = r));
  }

  // Walk a tile path ([{x,z}, ...], excluding the start). Resolves on arrival.
  walkPath(path) {
    this.moveResolve?.();
    this.path = path.slice();
    if (!this.path.length) return Promise.resolve();
    return new Promise((r) => (this.moveResolve = r));
  }

  stop() {
    this.path = [];
    this.moveResolve?.();
    this.moveResolve = null;
  }

  update(dt, cameraYaw, light, animSpeed = 1) {
    // movement along path, following tile heights
    if (this.path.length) {
      const next = this.path[0];
      const t = this.world.tileAt(next.x, next.z);
      const target = new THREE.Vector3(next.x, this.world.topY(t), next.z);
      const pos = this.root.position;
      const flat = new THREE.Vector2(target.x - pos.x, target.z - pos.z);
      const dist = flat.length();
      const step = this.moveSpeed * dt;
      this.faceToward(target.x, target.z);
      if (this.state !== 'walk') this.setState('walk');
      if (dist <= step) {
        pos.copy(target);
        this.tx = next.x; this.tz = next.z;
        this.path.shift();
        this.onTileEnter?.(this);
        if (!this.path.length) {
          this.setState('idle');
          const r = this.moveResolve; this.moveResolve = null; r?.();
        }
      } else {
        pos.x += (flat.x / dist) * step;
        pos.z += (flat.y / dist) * step;
        // ease height over the last part of the step so ramps read as climbing
        pos.y += (target.y - pos.y) * Math.min(1, dt * 10);
      }
    }

    // animation frame
    this.stateTime += dt * animSpeed;
    const anim = this.sheet.states[this.state];
    const { drawn, mirror } = spriteDirection(this.facing, cameraYaw);
    const frames = anim.dirs[drawn];
    let fi = Math.floor(this.stateTime * anim.fps);
    if (anim.loop) fi %= frames.length;
    else if (fi >= frames.length) {
      fi = frames.length - 1;
      if (this.onceResolve) {
        const r = this.onceResolve; this.onceResolve = null;
        if (this.state !== 'dead') this.setState('idle');
        r();
      }
    }
    const rect = frames[fi];
    const iw = this.sheet.image.width, ih = this.sheet.image.height;
    this.texture.offset.set(rect.x / iw, 1 - (rect.y + rect.h) / ih);

    // cylindrical billboard: rotate around Y only so feet stay planted
    this.mesh.rotation.y = cameraYaw;
    this.mesh.scale.x = mirror ? -1 : 1;
    this.xray.rotation.y = cameraYaw;
    this.xray.scale.x = this.mesh.scale.x;

    // light tint (+ red flash when hit)
    this.flash = Math.max(0, this.flash - dt * 4);
    const [r, g, b] = light;
    this.material.color.setRGB(r + this.flash, g * (1 - this.flash * 0.6), b * (1 - this.flash * 0.6));

    for (const l of this.labels) l.update(dt);
    this.labels = this.labels.filter((l) => !l.done);
  }

  addLabel(label) {
    this.labels.push(label);
    this.root.add(label.sprite);
  }
}
