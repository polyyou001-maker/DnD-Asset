// d20 rolls with an on-screen animated die. All randomness lives here.

export const roll = (sides) => 1 + Math.floor(Math.random() * sides);

// "1d8+3" -> total, doubling dice on a critical hit.
export function rollDamage(expr, crit = false) {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(expr);
  const [count, sides, mod] = [+m[1], +m[2], +(m[3] ?? 0)];
  const dice = [];
  for (let i = 0; i < count * (crit ? 2 : 1); i++) dice.push(roll(sides));
  return { total: Math.max(1, dice.reduce((a, b) => a + b, 0) + mod), dice, mod };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DiceTray {
  constructor(el) {
    this.el = el;
    this.speed = 1;
  }

  // Roll a d20 check. adv/dis follow 5e: roll two, keep higher/lower.
  // target: AC or DC shown next to the roll. Returns { nat, total, rolls, success }.
  async d20({ label, mod = 0, adv = false, dis = false, target = null, show = true }) {
    const both = adv !== dis;
    const rolls = both ? [roll(20), roll(20)] : [roll(20)];
    const nat = adv && !dis ? Math.max(...rolls) : dis && !adv ? Math.min(...rolls) : rolls[0];
    const total = nat + mod;
    const success = target == null ? null : nat === 20 || (nat !== 1 && total >= target);
    if (show) await this.#animate({ label, mod, rolls, nat, total, target, success, tag: both ? (adv ? 'ADV' : 'DIS') : '' });
    return { nat, total, rolls, success };
  }

  async #animate({ label, mod, rolls, nat, total, target, success, tag }) {
    const el = this.el;
    const faces = el.querySelectorAll('.die');
    el.querySelector('.dice-label').textContent = label;
    el.querySelector('.dice-result').textContent = '';
    faces.forEach((f, i) => {
      f.hidden = i >= rolls.length;
      f.className = 'die rolling';
    });
    el.classList.add('show');
    const spin = 650 / this.speed;
    const t0 = performance.now();
    while (performance.now() - t0 < spin) {
      faces.forEach((f) => (f.textContent = 1 + Math.floor(Math.random() * 20)));
      await sleep(45);
    }
    rolls.forEach((r, i) => {
      faces[i].textContent = r;
      faces[i].className = 'die' + (r === 20 ? ' nat20' : r === 1 ? ' nat1' : '') + (rolls.length > 1 && r !== nat ? ' dropped' : '');
      if (rolls.length > 1 && rolls[0] === rolls[1] && i === 1) faces[i].classList.add('dropped');
    });
    const sign = mod >= 0 ? '+' : '−';
    let text = `${tag ? tag + ' · ' : ''}${nat} ${sign} ${Math.abs(mod)} = ${total}`;
    if (target != null) text += `  vs ${target}  →  ${nat === 20 ? 'CRITICAL!' : success ? 'SUCCESS' : 'FAIL'}`;
    const res = el.querySelector('.dice-result');
    res.textContent = text;
    res.className = 'dice-result ' + (success === true ? 'ok' : success === false ? 'bad' : '');
    await sleep(900 / this.speed);
    el.classList.remove('show');
  }
}
