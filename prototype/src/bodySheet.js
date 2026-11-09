// Frame-by-frame body + its eye layer (pipeline/bodies.py) -> Actor sheet with the eyes drawn in.
import { dyeLayer } from '../../src/paperdoll2/dye.js';

const EYE_DYE = { dye: { eyeBand: [185, 255] } }; // the eyes are generated blue
const EYE_PART = { id: 'base_head', slot: 'face' };
const DIRS = ['S', 'SW', 'W', 'NW', 'N']; // order of dirs in sheet.json

export function composeBody(meta, image, eyesImage, color, style = 'slash') {
  const { frameH, eyes } = meta;
  const blinkY = image.height;
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = blinkY + eyes.dirs.length * frameH;
  const g = canvas.getContext('2d');
  const dyed = dyeLayer(eyesImage, EYE_PART, { eyes: color }, EYE_DYE);
  g.drawImage(image, 0, 0);

  const draw = (rect, column, row, [x, y]) => g.drawImage(dyed, column * eyes.w, row * eyes.h, eyes.w, eyes.h,
    rect.x + x, rect.y + y, eyes.w, eyes.h);
  const blinkDirs = meta.states.idle.dirs.map((frames) => [...frames]);
  eyes.dirs.forEach((name, row) => {
    const di = DIRS.indexOf(name);
    blinkDirs[di] = meta.states.idle.dirs[di].map((rect) => {
      const blink = { ...rect, y: blinkY + row * frameH };
      g.drawImage(image, rect.x, rect.y, rect.w, rect.h, blink.x, blink.y, rect.w, rect.h);
      return blink;
    });
  });

  g.globalCompositeOperation = 'source-atop'; // lashes stay inside this frame's outline
  eyes.dirs.forEach((name, row) => {
    const di = DIRS.indexOf(name);
    for (const state of Object.keys(eyes.at)) { // dead has none: those frames are drawn with closed eyes
      const column = state === 'hit' ? 1 : 0; // flinching
      meta.states[state].dirs[di].forEach((rect, i) => draw(rect, column, row, eyes.at[state][name][i]));
    }
    blinkDirs[di].forEach((rect, i) => draw(rect, 1, row, eyes.at.idle[name][i]));
  });
  const states = { ...meta.states, blink: { ...meta.states.idle, dirs: blinkDirs } };
  const attack = meta.states[`attack_${style}`];
  if (attack) Object.assign(states, { attack });
  return { ...meta, image: canvas, states, attackStyle: style, attackHitTime: attack ? attack.hitFrame / attack.fps : 0 };
}
