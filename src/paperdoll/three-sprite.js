// Three.js binding for a baked paper-doll: a Y-axis billboard quad with its feet at the
// mesh origin, a ground shadow and an optional effect quad. Import map must provide "three".
import * as THREE from "three";
import { bake, dirIndex, frameAt, frameUV, effectUV, sourceDir } from "./paperdoll.js";

function setQuadUV(geometry, { u0, v0, u1, v1 }) {
  // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right
  const uv = geometry.attributes.uv;
  uv.setXY(0, u0, v1);
  uv.setXY(1, u1, v1);
  uv.setXY(2, u0, v0);
  uv.setXY(3, u1, v0);
  uv.needsUpdate = true;
}

function pixelTexture(image) {
  const tex = new THREE.CanvasTexture(image);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Quad of one cell, translated so `origin` pixel sits at local (0,0,0). */
function cellQuad(manifest, ppu, map) {
  const [cw, ch] = manifest.cell;
  const [ox, oy] = manifest.origin;
  const geo = new THREE.PlaneGeometry(cw / ppu, ch / ppu);
  // origin pixel's bottom edge (oy + 1) on the ground, origin pixel column center on x = 0
  geo.translate((cw / 2 - (ox + 0.5)) / ppu, (oy + 1 - ch / 2) / ppu, 0);
  const mat = new THREE.MeshBasicMaterial({ map, transparent: true, alphaTest: 0.5 });
  return new THREE.Mesh(geo, mat);
}

export class PaperDollSprite {
  /** ppu = pixels per world unit. */
  constructor(manifest, sheets, loadout, { ppu = 32 } = {}) {
    this.manifest = manifest;
    this.sheets = sheets;
    this.ppu = ppu;
    this.anim = "idle";
    this.facingYaw = 0;
    this.time = 0;
    this.group = new THREE.Group();

    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(12 / ppu, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.y = 0.5;
    shadow.position.y = 0.01;
    this.group.add(shadow);

    this.setLoadout(loadout);
  }

  setLoadout(loadout) {
    this.loadout = loadout;
    const { canvas, layout } = bake(this.manifest, this.sheets, loadout, this.atlas);
    this.atlas = canvas;
    this.layout = layout;
    if (!this.body) {
      this.texture = pixelTexture(canvas);
      this.body = cellQuad(this.manifest, this.ppu, this.texture);
      this.group.add(this.body);
    } else {
      this.texture.needsUpdate = true;
    }

    const fxId = loadout.effect;
    if (this.effect) {
      this.group.remove(this.effect);
      this.effect.geometry.dispose();
      this.effect.material.map.dispose();
      this.effect.material.dispose();
      this.effect = null;
    }
    if (fxId) {
      this.effectPart = this.manifest.parts[fxId];
      this.effect = cellQuad(this.manifest, this.ppu, pixelTexture(this.sheets[fxId]));
      this.effect.renderOrder = 1;
      this.group.add(this.effect);
    }
  }

  /** Advance animation by dt seconds and face the camera. Returns the 8-direction index shown. */
  update(dt, camera, target = new THREE.Vector3()) {
    this.time += dt;
    const camYaw = Math.atan2(camera.position.x - target.x, camera.position.z - target.z);
    const dir = dirIndex(this.facingYaw, camYaw);
    const frame = frameAt(this.manifest, this.anim, this.time);
    setQuadUV(this.body.geometry, frameUV(this.manifest, this.layout, this.anim, dir, frame));
    this.body.rotation.y = camYaw;
    if (this.effect) {
      const p = this.effectPart;
      setQuadUV(this.effect.geometry, effectUV(p, Math.floor(this.time * p.fps) % p.frames));
      this.effect.rotation.y = camYaw;
      this.effect.position.set(Math.sin(camYaw) * 0.01, 0, Math.cos(camYaw) * 0.01);
    }
    this.dir = dir;
    this.frame = frame;
    this.drawnDir = sourceDir(this.manifest, dir);
    return dir;
  }
}
