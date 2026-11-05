// Paper-doll v2: compose AI-generated 128px layers into an animated sprite sheet.
//
//   const set = await loadSet('../art/paperdoll2/A/');
//   const sheet = compose(set, look);   // -> { image, frameW, frameH, states } (prototype Actor format)
//
// Layers are pre-aligned by the pipeline (same base, same cut), so composing is plain
// stacking. Dyes recolor per layer; animation is procedural ("puppet") on 3 groups:
// lower body, upper body (head + hair + headgear) and held items.

import { dyeLayer } from './dye.js';

export const DIRS = ['S', 'SW', 'W', 'NW', 'N'];
const CELL = 128;
const FEET = [64, 122];

// state -> frames as [{ dy, dx, upper, lower, lean, swing, squash, rotate }]
const ANIMS = {
  idle: { fps: 3, loop: true, frames: [{}, { upper: 1 }] },
  walk: { fps: 8, loop: true, frames: [{ dy: 0, dx: 0 }, { dy: -2, dx: 1 }, { dy: 0, dx: 0 }, { dy: -2, dx: -1 }] },
  attack: { fps: 10, loop: false, frames: [{ lean: -1, swing: -60 }, { lean: 0, swing: -110 }, { lean: 3, swing: 40 }, { lean: 1, swing: 10 }] },
  sit: { fps: 1, loop: true, frames: [{ squash: 0.72, upper: 0 }] },
  hit: { fps: 8, loop: false, frames: [{ lean: -3 }, { lean: -1 }] },
  dead: { fps: 4, loop: false, frames: [{ squash: 0.6 }, { rotate: true }] },
};

// screen direction "forward" for each drawn direction (lean/knock-back)
const FORWARD = { S: [0, 1], SW: [-1, 0], W: [-1, 0], NW: [-1, 0], N: [0, -1] };
// which hand holds the weapon on screen, and whether items go behind the body
const HANDS = {
  S: { main: 'hand_left', off: 'hand_right', weaponBehind: false, shieldBehind: false },
  SW: { main: 'hand_left', off: 'hand_right', weaponBehind: false, shieldBehind: false },
  W: { main: 'hand_left', off: 'hand_right', weaponBehind: false, shieldBehind: true },
  NW: { main: 'hand_right', off: 'hand_left', weaponBehind: true, shieldBehind: false },
  N: { main: 'hand_right', off: 'hand_left', weaponBehind: true, shieldBehind: false },
};

const loadImage = (src) => new Promise((resolve) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null); // a missing direction just skips that layer
  img.src = src;
});

// Load a set: manifest.json + every part image per direction (+ item images).
export async function loadSet(baseUrl) {
  const manifest = await (await fetch(baseUrl + 'manifest.json')).json();
  const layers = {};
  const jobs = [];
  for (const id of Object.keys(manifest.parts)) {
    layers[id] = {};
    for (const d of DIRS) jobs.push(loadImage(`${baseUrl}${id}/${d}.png`).then((img) => (layers[id][d] = img)));
  }
  const items = {};
  for (const [id, item] of Object.entries(manifest.items ?? {})) {
    jobs.push(loadImage(baseUrl + item.file).then((img) => (items[id] = { ...item, img })));
  }
  await Promise.all(jobs);
  return { manifest, layers, items, baseUrl };
}

function canvas(w = CELL, h = CELL) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Build the dyed, un-animated layer canvases for one direction.
function layersFor(set, look, d) {
  const { manifest, layers } = set;
  const pick = (id) => (id && layers[id]?.[d] ? { id, img: layers[id][d], part: manifest.parts[id] } : null);
  const out = { lower: [], upper: [] };
  const add = (group, p) => p && out[group].push(dyeLayer(p.img, p.part, look, manifest));
  add('lower', pick('base_body'));
  add('lower', pick(look.outfit));
  add('upper', pick('base_head'));
  if (look.ears) add('upper', pick(look.ears));
  if (look.hair) add('upper', pick(look.hair));
  if (look.headgear) add('upper', pick(look.headgear));
  return out;
}

function drawGroup(ctx, list, dx, dy, squash = 1) {
  for (const c of list) {
    if (squash === 1) ctx.drawImage(c, dx, dy);
    else {
      // squash toward the feet line
      const h = Math.round(CELL * squash);
      ctx.drawImage(c, 0, 0, CELL, CELL, dx, dy + Math.round((FEET[1] + 1) * (1 - squash)), CELL, h);
    }
  }
}

function drawItem(ctx, item, anchor, angleDeg, dx, dy) {
  if (!item?.img || !anchor) return;
  const [ax, ay] = anchor;
  const [gx, gy] = item.grip; // pixel in the item image held by the hand
  ctx.save();
  ctx.translate(ax + dx, ay + dy);
  ctx.rotate(((item.angle ?? 0) + angleDeg) * Math.PI / 180);
  ctx.drawImage(item.img, -gx, -gy);
  ctx.restore();
}

// Compose one frame for direction d into ctx at (ox, oy).
function drawFrame(ctx, ox, oy, set, look, d, groups, f) {
  const geo = set.manifest.geometry[d];
  const hands = HANDS[d];
  const [fx, fy] = FORWARD[d];
  const dx = (f.dx ?? 0) + (f.lean ?? 0) * fx;
  const dy = (f.dy ?? 0) + (f.lean ?? 0) * fy;
  const tmp = canvas();
  const t = tmp.getContext('2d');
  t.imageSmoothingEnabled = false;
  const weapon = set.items[look.weapon];
  const shield = set.items[look.shield];
  const swing = f.swing ?? 0;
  const upperDy = dy + (f.upper ?? 0) + (f.squash ? Math.round((FEET[1] - geo.anchors.head[1]) * (1 - f.squash)) : 0);
  const mainAnchor = geo.anchors[hands.main];
  const offAnchor = geo.anchors[hands.off];

  if (hands.weaponBehind) drawItem(t, weapon, mainAnchor, swing, dx, dy);
  if (hands.shieldBehind) drawItem(t, shield, offAnchor, 0, dx, dy);
  drawGroup(t, groups.lower, dx, dy, f.squash ?? 1);
  drawGroup(t, groups.upper, dx, upperDy);
  if (!hands.weaponBehind) drawItem(t, weapon, mainAnchor, swing, dx, dy);
  if (!hands.shieldBehind) drawItem(t, shield, offAnchor, 0, dx, dy);

  const cell = chibify(tmp, geo.anchors.hand_left[1], look.legScale ?? set.manifest.legScale ?? 0.8);
  ctx.save();
  if (f.rotate) {
    // lying down: rotate 90° so the head points left, feet at the right edge, body on the ground
    ctx.translate(ox + CELL - 9, oy + FEET[1] - 30);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(cell, -FEET[0], -FEET[1]);
  } else {
    ctx.drawImage(cell, ox, oy);
  }
  ctx.restore();
}

// Art-direction knob: the generated bodies have long legs, so everything below the hips
// is squashed by k and the upper body moves down to keep the feet on the ground line.
// Applied to the whole composed cell, so every layer and held item stays aligned.
function chibify(src, hipY, k) {
  if (k >= 1) return src;
  const below = FEET[1] + 1 - hipY;
  const shrunk = Math.round(below * k);
  const shift = below - shrunk;
  const c = canvas();
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, CELL, hipY, 0, shift, CELL, hipY);
  g.drawImage(src, 0, hipY, CELL, below, 0, hipY + shift, CELL, shrunk);
  return c;
}

// Species scale (dwarf/halfling) is applied to the finished cell, anchored at the feet.
function scaleCell(src, sx, sy) {
  if (sx === 1 && sy === 1) return src;
  const c = canvas(src.width, src.height);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  for (let y = 0; y < src.height; y += CELL) {
    for (let x = 0; x < src.width; x += CELL) {
      const w = Math.round(CELL * sx), h = Math.round(CELL * sy);
      g.drawImage(src, x, y, CELL, CELL, x + Math.round(FEET[0] - FEET[0] * sx), y + Math.round(FEET[1] - FEET[1] * sy), w, h);
    }
  }
  return c;
}

// Compose a full animated sheet. Rows = state × 5 directions, columns = frames.
export function compose(set, look) {
  const states = Object.keys(ANIMS);
  const cols = Math.max(...states.map((s) => ANIMS[s].frames.length));
  const sheetCanvas = canvas(cols * CELL, states.length * DIRS.length * CELL);
  const ctx = sheetCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const out = {};
  const groupsByDir = Object.fromEntries(DIRS.map((d) => [d, layersFor(set, look, d)]));
  states.forEach((name, si) => {
    const a = ANIMS[name];
    const dirs = DIRS.map((d, di) => a.frames.map((f, fi) => {
      const x = fi * CELL, y = (si * DIRS.length + di) * CELL;
      drawFrame(ctx, x, y, set, look, d, groupsByDir[d], f);
      return { x, y, w: CELL, h: CELL };
    }));
    out[name] = { fps: a.fps, loop: a.loop, dirs };
  });
  const [sx, sy] = look.scale ?? [1, 1];
  // ppu = sprite pixels per world unit: the ~110 px figure stands ~1.4 tiles tall
  return { image: scaleCell(sheetCanvas, sx, sy), frameW: CELL, frameH: CELL, feetY: FEET[1], ppu: 80, states: out };
}

// Single still cell (for thumbnails / portraits).
export function still(set, look, d = 'S') {
  const c = canvas();
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  drawFrame(ctx, 0, 0, set, look, d, layersFor(set, look, d), {});
  const [sx, sy] = look.scale ?? [1, 1];
  return scaleCell(c, sx, sy);
}
