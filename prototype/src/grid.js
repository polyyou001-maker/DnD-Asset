// Tile pathfinding. Moves are 8-way, no corner cutting, and a step may climb
// or drop at most one height level.

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const key = (x, z) => `${x},${z}`;

export function canStep(world, from, to) {
  if (!to || !to.walk) return false;
  return Math.abs(to.h - from.h) <= 1;
}

function neighbors(world, t, occupied) {
  const out = [];
  for (const [dx, dz] of DIRS) {
    const n = world.tileAt(t.x + dx, t.z + dz);
    if (!canStep(world, t, n) || occupied.has(key(n.x, n.z))) continue;
    if (dx && dz) {
      const a = world.tileAt(t.x + dx, t.z), b = world.tileAt(t.x, t.z + dz);
      if (!canStep(world, t, a) || !canStep(world, t, b)) continue;
    }
    out.push({ tile: n, diag: !!(dx && dz) });
  }
  return out;
}

// A* for free exploration. Returns [{x,z}...] without the start, or null.
export function findPath(world, sx, sz, tx, tz, occupied = new Set()) {
  const start = world.tileAt(sx, sz), goal = world.tileAt(tx, tz);
  if (!start || !goal || !goal.walk) return null;
  const h = (t) => Math.max(Math.abs(t.x - tx), Math.abs(t.z - tz));
  const open = new Map([[key(sx, sz), { tile: start, g: 0, f: h(start), prev: null }]]);
  const closed = new Map();
  while (open.size) {
    let best = null;
    for (const n of open.values()) if (!best || n.f < best.f) best = n;
    const k = key(best.tile.x, best.tile.z);
    open.delete(k);
    closed.set(k, best);
    if (best.tile === goal) {
      const path = [];
      for (let n = best; n.prev; n = n.prev) path.unshift({ x: n.tile.x, z: n.tile.z });
      return path;
    }
    for (const { tile, diag } of neighbors(world, best.tile, occupied)) {
      const nk = key(tile.x, tile.z);
      if (closed.has(nk)) continue;
      const g = best.g + (diag ? 1.414 : 1);
      const cur = open.get(nk);
      if (!cur || g < cur.g) open.set(nk, { tile, g, f: g + h(tile), prev: best });
    }
  }
  return null;
}

// Combat movement range (5e-style: every step, diagonal included, costs 1).
// Returns Map key -> { tile, dist, prev }.
export function reachable(world, sx, sz, maxSteps, occupied = new Set()) {
  const start = world.tileAt(sx, sz);
  const seen = new Map([[key(sx, sz), { tile: start, dist: 0, prev: null }]]);
  const queue = [seen.get(key(sx, sz))];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.dist >= maxSteps) continue;
    for (const { tile } of neighbors(world, cur.tile, occupied)) {
      const k = key(tile.x, tile.z);
      if (seen.has(k)) continue;
      const node = { tile, dist: cur.dist + 1, prev: cur };
      seen.set(k, node);
      queue.push(node);
    }
  }
  return seen;
}

export function pathTo(node) {
  const path = [];
  for (let n = node; n?.prev; n = n.prev) path.unshift({ x: n.tile.x, z: n.tile.z });
  return path;
}

export const tileKey = key;
export const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
