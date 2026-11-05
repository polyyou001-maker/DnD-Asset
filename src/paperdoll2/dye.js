// Dyes for AI-painted layers. AI art has free shading, so instead of exact palette swaps:
//  - hair:   gradient map — the layer is generated white/silver, luminance -> target ramp
//  - cloth1: hue band swap — outfits are generated with blue as the dyeable cloth
//  - cloth2: hue band swap on the secondary band (gold/yellow trims)
//  - skin:   shift pixels near the base skin color toward the chosen tone
//  - eyes:   hue band swap of the (blue) eyes, base_head only
// Results are cached per (image, dye settings).

const cache = new WeakMap();

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hsl2rgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

export function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  return rgb2hsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

const hueIn = (h, [a, b]) => (a <= b ? h >= a && h <= b : h >= a || h <= b);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Hair gradient map: dark outline stays dark, the rest follows the target color's ramp.
function gradientMap(l, target) {
  const [h, s, tl] = target;
  // map source lightness (0.15..0.95 for white hair) around the target lightness
  const t = clamp01((l - 0.15) / 0.8);
  const nl = clamp01(tl * 0.35 + t * (Math.min(0.95, tl * 1.45) - tl * 0.35));
  const ns = clamp01(s * (1.05 - 0.4 * t));
  return hsl2rgb(h + (1 - t) * -8, ns, nl);
}

export function dyeLayer(img, part, look, manifest) {
  const key = JSON.stringify([part.slot, look.hairColor, look.cloth1, look.cloth2, look.skin, look.eyes]);
  let per = cache.get(img);
  if (!per) cache.set(img, (per = new Map()));
  if (per.has(key)) return per.get(key);

  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const dye = manifest.dye;
  const hair = part.slot === 'hair' && look.hairColor ? hexToHsl(look.hairColor) : null;
  const c1 = (part.slot === 'body' || part.slot === 'head_top') && look.cloth1 ? hexToHsl(look.cloth1) : null;
  const c2 = (part.slot === 'body' || part.slot === 'head_top') && look.cloth2 ? hexToHsl(look.cloth2) : null;
  const skin = look.skin && part.skinnable ? hexToHsl(look.skin) : null;
  const eyes = part.id === 'base_head' && look.eyes ? hexToHsl(look.eyes) : null;
  const ref = dye.skinRef; // [h, s, l] measured from the base head by the pipeline

  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const [h, s, l] = rgb2hsl(px[i], px[i + 1], px[i + 2]);
    let out = null;
    if (hair) {
      out = gradientMap(l, hair);
    } else if (skin && Math.abs(h - ref[0]) < 12 && Math.abs(s - ref[1]) < 0.25 && l > ref[2] - 0.25) {
      out = hsl2rgb(skin[0] + (h - ref[0]), clamp01(s * (skin[1] / ref[1])), clamp01(l * (skin[2] / ref[2])));
    } else if (eyes && s > 0.3 && hueIn(h, dye.eyeBand)) {
      out = hsl2rgb(eyes[0], clamp01(Math.max(s, eyes[1])), clamp01(l * (0.5 + eyes[2])));
    } else if (c1 && s > 0.22 && hueIn(h, dye.cloth1Band)) {
      out = hsl2rgb(c1[0], clamp01(s * (0.4 + c1[1])), clamp01(l * (c1[2] / dye.cloth1L)));
    } else if (c2 && s > 0.45 && l > 0.42 && hueIn(h, dye.cloth2Band)) {
      out = hsl2rgb(c2[0], clamp01(s * (0.4 + c2[1])), clamp01(l * (c2[2] / dye.cloth2L)));
    }
    if (out) { px[i] = out[0]; px[i + 1] = out[1]; px[i + 2] = out[2]; }
  }
  ctx.putImageData(data, 0, 0);
  per.set(key, c);
  return c;
}
