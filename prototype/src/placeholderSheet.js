// Procedural stand-in for real sprite sheets until the paper-doll pipeline
// delivers art. Produces the same shape the Actor expects:
//   { image, frameW, frameH, states: { [state]: { fps, loop, dirs: Rect[][5] } } }
// Directions drawn: 0=S 1=SW 2=W 3=NW 4=N (the other 3 are mirrored at runtime).

const FW = 32, FH = 40;
const STATES = {
  idle: { frames: 2, fps: 3, loop: true },
  walk: { frames: 4, fps: 8, loop: true },
  attack: { frames: 4, fps: 10, loop: false },
  sit: { frames: 1, fps: 1, loop: true },
  hit: { frames: 2, fps: 8, loop: false },
  dead: { frames: 2, fps: 4, loop: false },
};

export const PALETTES = {
  knight: { skin: '#ffd9b8', hair: '#f2c14e', cloth: '#3f6fd8', accent: '#e8e8f0', eye: '#2b5bb8', hat: '#d8443a', weapon: 'sword', body: 'chibi' },
  goblin: { skin: '#8fcf5a', hair: '#3d5a2a', cloth: '#8a5a33', accent: '#c9a26a', eye: '#ffde3a', weapon: 'club', body: 'chibi' },
  skeleton: { skin: '#ecebdc', hair: '#ecebdc', cloth: '#4a4458', accent: '#9a96a8', eye: '#ff4a4a', weapon: 'sword', body: 'chibi' },
  slime: { skin: '#6fd0ff', eye: '#1b2a4a', body: 'slime' },
};

export function createPlaceholderSheet(palette) {
  const names = Object.keys(STATES);
  const cols = Math.max(...names.map((n) => STATES[n].frames));
  const canvas = document.createElement('canvas');
  canvas.width = cols * FW;
  canvas.height = names.length * 5 * FH;
  const ctx = canvas.getContext('2d');
  const states = {};
  names.forEach((name, si) => {
    const s = STATES[name];
    const dirs = [];
    for (let d = 0; d < 5; d++) {
      const rects = [];
      for (let f = 0; f < s.frames; f++) {
        const x = f * FW, y = (si * 5 + d) * FH;
        if (palette.body === 'slime') drawSlime(ctx, x, y, d, name, f, palette);
        else drawChibi(ctx, x, y, d, name, f, palette);
        rects.push({ x, y, w: FW, h: FH });
      }
      dirs.push(rects);
    }
    states[name] = { fps: s.fps, loop: s.loop, dirs };
  });
  return { image: canvas, frameW: FW, frameH: FH, states };
}

const OUTLINE = '#2a1e2e';

// Pixel rounded rect with a 1px outline.
function blob(ctx, x, y, w, h, color) {
  ctx.fillStyle = OUTLINE;
  ctx.fillRect(x - 1, y, w + 2, h);
  ctx.fillRect(x, y - 1, w, h + 2);
  ctx.fillStyle = color;
  ctx.fillRect(x + 1, y, w - 2, h);
  ctx.fillRect(x, y + 1, w, h - 2);
}

function px(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function drawChibi(ctx, ox, oy, dir, state, f, p) {
  if (state === 'dead') return drawChibiDead(ctx, ox, oy, f, p);
  const facingSide = dir >= 1 && dir <= 3; // faces viewer's left
  let bob = 0, legA = 0, lean = 0;
  if (state === 'idle') bob = f;
  if (state === 'walk') { bob = f % 2 ? -1 : 0; legA = [-1, 0, 1, 0][f]; }
  if (state === 'attack') lean = [1, 0, -2, -1][f];
  if (state === 'hit') lean = f === 0 ? 2 : 1;
  const sit = state === 'sit';
  const cx = ox + 16 + (facingSide ? lean : 0);
  const base = oy + 39;
  const torsoTop = base - 13 + (sit ? 4 : 0) + (state === 'attack' && !facingSide ? Math.max(0, -lean) : 0);

  // legs
  if (sit) {
    blob(ctx, cx - 5, base - 3, 4, 3, p.cloth);
    blob(ctx, cx + 1, base - 3, 4, 3, p.cloth);
  } else {
    blob(ctx, cx - 4 + legA, base - 4, 3, 4, p.accent);
    blob(ctx, cx + 1 - legA, base - 4, 3, 4, p.accent);
  }
  // torso + belt
  blob(ctx, cx - 5, torsoTop, 10, 9, p.cloth);
  px(ctx, cx - 5, torsoTop + 6, 10, 1, p.accent);
  // arms
  if (!facingSide) {
    blob(ctx, cx - 7, torsoTop + 1, 2, 6, p.skin);
    blob(ctx, cx + 5, torsoTop + 1, 2, 6, p.skin);
  } else {
    blob(ctx, cx - 2 - (state === 'attack' ? 2 : 0), torsoTop + 2, 3, 5, p.skin);
  }

  // head: hair shape first, then the face window per direction
  const hx = cx - 9, hy = torsoTop - 15 + (sit ? 0 : bob);
  blob(ctx, hx, hy, 18, 16, p.hair);
  const face = [
    [3, 6, 12, 9], [2, 6, 11, 9], [1, 6, 8, 9], [1, 8, 3, 6], null,
  ][dir];
  if (face) px(ctx, hx + face[0], hy + face[1], face[2], face[3], p.skin);
  const eyes = [[5, 11], [4, 9], [3], [], []][dir];
  for (const ex of eyes) {
    px(ctx, hx + ex, hy + 9, 2, 3, p.eye);
    px(ctx, hx + ex, hy + 9, 1, 1, '#ffffff');
  }
  if (dir === 0) px(ctx, hx + 8, hy + 13, 2, 1, '#c0604a');
  if (dir === 1) px(ctx, hx + 6, hy + 13, 2, 1, '#c0604a');
  // headgear (placeholder for the paper-doll headgear layer)
  if (p.hat) {
    blob(ctx, hx + 2, hy - 3, 14, 4, p.hat);
    px(ctx, hx + 7, hy - 5, 4, 2, p.hat);
  }

  drawWeapon(ctx, cx, torsoTop, dir, state, f, p);
}

function drawWeapon(ctx, cx, torsoTop, dir, state, f, p) {
  if (!p.weapon) return;
  const blade = p.weapon === 'club' ? '#8a5a33' : '#d8dde8';
  const w = p.weapon === 'club' ? 2 : 1;
  const side = dir >= 1 && dir <= 3 ? -1 : 1; // forward is viewer's left for side views
  const hx = dir >= 1 && dir <= 3 ? cx - 3 : cx + 6, hy = torsoTop + 6;
  const pose = state === 'attack' ? f : -1;
  if (pose === 0) { // wind-up: blade raised behind
    px(ctx, hx - side * 2, hy - 12, w, 10, blade);
  } else if (pose === 1) { // overhead
    px(ctx, hx - side * 4, hy - 13, 9, w, blade);
  } else if (pose === 2) { // strike forward/down
    for (let i = 0; i < 9; i++) px(ctx, hx + side * i, hy - 4 + Math.floor(i / 2), w, w, blade);
  } else {
    px(ctx, hx, hy - 9, w, 9, blade);
    px(ctx, hx - 1, hy - 1, w + 2, 1, '#6a4a2a');
  }
}

function drawChibiDead(ctx, ox, oy, f, p) {
  const base = oy + 39;
  if (f === 0) { // kneel
    blob(ctx, ox + 11, base - 6, 10, 6, p.cloth);
    blob(ctx, ox + 7, base - 20, 18, 15, p.hair);
    px(ctx, ox + 10, base - 13, 12, 6, p.skin);
    px(ctx, ox + 12, base - 10, 2, 1, OUTLINE);
    px(ctx, ox + 18, base - 10, 2, 1, OUTLINE);
  } else { // lying down
    blob(ctx, ox + 14, base - 6, 14, 6, p.cloth);
    blob(ctx, ox + 2, base - 11, 13, 11, p.hair);
    px(ctx, ox + 4, base - 7, 8, 5, p.skin);
    px(ctx, ox + 5, base - 5, 2, 1, OUTLINE);
    px(ctx, ox + 9, base - 5, 2, 1, OUTLINE);
  }
}

function drawSlime(ctx, ox, oy, dir, state, f, p) {
  const base = oy + 39;
  let w = 22, h = 15;
  if (state === 'idle') { w += f; h -= f; }
  if (state === 'walk') { const k = [0, 2, 0, -2][f]; w += k; h -= k; }
  if (state === 'attack') { const k = [-3, -4, 4, 1][f]; w -= k; h += k; }
  if (state === 'hit') { w += 3; h -= 3; }
  if (state === 'dead') { w = f ? 26 : 24; h = f ? 4 : 8; }
  const x = ox + 16 - Math.floor(w / 2), y = base - h;
  blob(ctx, x, y, w, h, p.skin);
  px(ctx, x + 3, y + 2, 4, 2, '#ffffff');
  if (state === 'dead') return;
  const eyes = [[6, 14], [4, 11], [3], [], []][dir];
  for (const ex of eyes) px(ctx, x + ex, y + Math.floor(h / 2) - 1, 2, 3, p.eye);
}
