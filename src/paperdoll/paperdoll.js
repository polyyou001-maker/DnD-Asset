// Paper-doll core: load a manifest + sheets, equip items, dye, bake a character atlas,
// pick directions and frame UVs. Engine-agnostic (DOM canvas only). Spec:
// docs/specs/character-dressing.md

export const DIRS = ["S", "SW", "W", "NW", "N", "NE", "E", "SE"];
export const SLOTS = ["body", "hair", "face", "head_top", "head_mid", "head_low", "weapon", "shield", "effect"];

/** Load manifest.json and every part sheet. Returns { manifest, sheets: {partId: HTMLImageElement} }. */
export async function loadSet(manifestUrl) {
  const base = new URL(manifestUrl, location.href);
  const manifest = await (await fetch(base)).json();
  const entries = await Promise.all(Object.entries(manifest.parts).map(async ([id, part]) => {
    const img = new Image();
    img.src = new URL(part.sheet, base).href;
    await img.decode();
    return [id, img];
  }));
  return { manifest, sheets: Object.fromEntries(entries) };
}

/** 8-direction index from yaws (radians, Three.js rotation.y convention). 0 = S (facing camera). */
export function dirIndex(facingYaw, cameraYaw) {
  const step = Math.PI / 4;
  return (((Math.round(-(facingYaw - cameraYaw) / step)) % 8) + 8) % 8;
}

/** Map any direction to the drawn direction it uses and whether it is mirrored. */
export function sourceDir(manifest, dir) {
  const name = typeof dir === "number" ? DIRS[dir] : dir;
  const src = manifest.mirror[name];
  return src ? { dir: src, mirrored: true } : { dir: name, mirrored: false };
}

/** Frame index for an animation at time t (seconds). */
export function frameAt(manifest, anim, t) {
  const a = manifest.anims[anim];
  return Math.floor(t * a.fps) % a.frames;
}

/** Slots a part takes: `occupies` for headgear, otherwise its own slot. */
function occupied(part) {
  return part.occupies ?? [part.slot];
}

/** Return a new loadout with partId equipped (null clears `slot`). Overlapping items are removed. */
export function equip(manifest, loadout, slot, partId) {
  const next = { ...loadout, dye: { ...loadout.dye } };
  if (!partId) {
    // clearing a slot held by a multi-slot item clears the item everywhere
    const held = next[slot];
    for (const s of SLOTS) if (held && next[s] === held) next[s] = null;
    next[slot] = null;
    return next;
  }
  const part = manifest.parts[partId];
  const taken = occupied(part);
  for (const s of SLOTS) {
    const other = next[s] && manifest.parts[next[s]];
    if (other && occupied(other).some((o) => taken.includes(o))) next[s] = null;
  }
  for (const s of taken) next[s] = partId;
  return next;
}

/** Unique equipped part ids (a multi-slot item appears once). */
export function equippedParts(loadout) {
  return [...new Set(SLOTS.map((s) => loadout[s]).filter(Boolean))];
}

const dyeCache = new WeakMap(); // source image -> Map(dye key -> canvas); per image so two sets never collide

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The part's sheet with its dyeable ramps swapped (one pass, exact RGB match). Cached. */
export function dyedSheet(manifest, sheets, partId, dye) {
  const part = manifest.parts[partId];
  const img = sheets[partId];
  const ramps = (part.dye ?? []).filter((r) => dye?.[r] && manifest.dyes[r]?.[dye[r]]);
  if (!ramps.length) return img;
  const key = ramps.map((r) => r + ":" + dye[r]).join(",");
  if (!dyeCache.has(img)) dyeCache.set(img, new Map());
  const cache = dyeCache.get(img);
  if (cache.has(key)) return cache.get(key);

  const map = new Map(); // source rgb int -> target rgb
  for (const r of ramps) {
    manifest.ramps[r].forEach((src, i) => {
      const s = hexToRgb(src);
      map.set((s[0] << 16) | (s[1] << 8) | s[2], hexToRgb(manifest.dyes[r][dye[r]][i]));
    });
  }
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    const t = map.get((px[i] << 16) | (px[i + 1] << 8) | px[i + 2]);
    if (t) [px[i], px[i + 1], px[i + 2]] = t;
  }
  ctx.putImageData(data, 0, 0);
  cache.set(key, c);
  return c;
}

/** Atlas layout shared by animated sheets and baked atlases. */
export function atlasLayout(manifest) {
  const [cw, ch] = manifest.cell;
  const animNames = Object.keys(manifest.anims);
  const cols = Math.max(...animNames.map((a) => manifest.anims[a].frames));
  const rows = animNames.length * manifest.drawn.length;
  return { cw, ch, cols, rows, width: cols * cw, height: rows * ch, animNames };
}

/** Cell (col,row) of anim/drawn-direction/frame in an animated sheet or baked atlas. */
export function cellOf(manifest, anim, drawnDir, frame) {
  const L = atlasLayout(manifest);
  return { col: frame, row: L.animNames.indexOf(anim) * manifest.drawn.length + manifest.drawn.indexOf(drawnDir) };
}

/** Compose one cell (anim, drawn direction, frame) of a loadout into ctx at (x, y). */
export function drawCell(ctx, x, y, manifest, sheets, loadout, anim, drawnDir, frame) {
  const [cw, ch] = manifest.cell;
  const body = loadout.body && manifest.parts[loadout.body];
  if (!body) return;
  const anchors = body.anchors?.[anim]?.[drawnDir]?.[frame];
  const di = manifest.drawn.indexOf(drawnDir);
  const ids = equippedParts(loadout).filter((id) => manifest.parts[id].kind !== "effect");
  const hidden = new Set(ids.flatMap((id) => manifest.parts[id].hides ?? []));

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, cw, ch);
  ctx.clip();
  for (const layer of manifest.layerOrder[drawnDir]) {
    if (hidden.has(layer)) continue;
    for (const id of ids) {
      const part = manifest.parts[id];
      const src = dyedSheet(manifest, sheets, id, loadout.dye);
      if (part.kind === "animated") {
        if (layer !== "body") continue;
        const { col, row } = cellOf(manifest, anim, drawnDir, frame);
        ctx.drawImage(src, col * cw, row * ch, cw, ch, x, y, cw, ch);
        continue;
      }
      for (const piece of part.pieces) {
        if (piece.layer !== layer) continue;
        const a = anchors?.[part.attach];
        const p = part.pivot[drawnDir];
        if (!a || !p) {
          console.warn(`paperdoll: no anchor '${part.attach}' for ${anim}/${drawnDir}/${frame}, ${id} skipped`);
          continue;
        }
        ctx.drawImage(src, di * cw, piece.row * ch, cw, ch, x + a[0] - p[0], y + a[1] - p[1], cw, ch);
      }
    }
  }
  ctx.restore();
}

/** Bake every anim x drawn direction x frame of a loadout into one canvas (same layout as an animated sheet). */
export function bake(manifest, sheets, loadout, canvas = document.createElement("canvas")) {
  const L = atlasLayout(manifest);
  canvas.width = L.width;
  canvas.height = L.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, L.width, L.height);
  for (const anim of L.animNames) {
    for (const d of manifest.drawn) {
      for (let f = 0; f < manifest.anims[anim].frames; f++) {
        const { col, row } = cellOf(manifest, anim, d, f);
        drawCell(ctx, col * L.cw, row * L.ch, manifest, sheets, loadout, anim, d, f);
      }
    }
  }
  return { canvas, layout: L };
}

/**
 * UV rect of a frame in a baked atlas, for any of the 8 directions (v up, as in WebGL with flipY).
 * Mirrored directions swap u0/u1 (= negative UV x-scale).
 */
export function frameUV(manifest, layout, anim, dir, frame) {
  const { dir: d, mirrored } = sourceDir(manifest, dir);
  const { col, row } = cellOf(manifest, anim, d, frame);
  let u0 = (col * layout.cw) / layout.width;
  let u1 = ((col + 1) * layout.cw) / layout.width;
  const v0 = 1 - ((row + 1) * layout.ch) / layout.height;
  const v1 = 1 - (row * layout.ch) / layout.height;
  if (mirrored) [u0, u1] = [u1, u0];
  return { u0, v0, u1, v1 };
}

/** UV rect of an effect frame (effect sheets: one row, one column per frame). */
export function effectUV(part, frame) {
  return { u0: frame / part.frames, v0: 0, u1: (frame + 1) / part.frames, v1: 1 };
}
