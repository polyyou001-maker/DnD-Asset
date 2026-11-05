import { loadSet, compose, still } from '../src/paperdoll2/composer.js';
import {
  SPECIES, CLASSES, BACKGROUNDS, ABILITIES, ABILITY_NAMES, ABILITY_TH, STANDARD_ARRAY, POINT_COST, POINT_BUDGET,
  SKIN_TONES, HAIR_COLORS, EYE_COLORS, CLOTH_COLORS, TRIM_COLORS,
  derived, finalScores, pointBuyCost, validBonus, defaultBonus, randomName, mod, SRD_CREDIT,
} from '../src/character/rules.js';
import { Stage } from './stage.js';

const SET_URL = `../art/paperdoll2/${new URLSearchParams(location.search).get('set') ?? 'A'}/`;
const STORAGE_KEY = 'dnd.character';
const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
};

const STEPS = [
  { id: 'species', title: 'Species', th: 'เผ่าพันธุ์' },
  { id: 'class', title: 'Class', th: 'อาชีพและบทบาท' },
  { id: 'background', title: 'Background', th: 'ภูมิหลัง' },
  { id: 'abilities', title: 'Abilities', th: 'ค่าสถานะ' },
  { id: 'look', title: 'Appearance', th: 'รูปลักษณ์' },
  { id: 'review', title: 'Name & Review', th: 'ตั้งชื่อและสรุป' },
];
const QUICK = {
  Tank: { class: 'fighter', background: 'soldier', species: 'dwarf', th: 'ยืนแนวหน้า' },
  Healer: { class: 'cleric', background: 'acolyte', species: 'human', th: 'ดูแลทีม' },
  Striker: { class: 'rogue', background: 'criminal', species: 'halfling', th: 'ลอบโจมตี' },
  Caster: { class: 'wizard', background: 'sage', species: 'elf', th: 'เวทวงกว้าง' },
};
const ANIMS = [['idle', 'ยืน'], ['walk', 'เดิน'], ['attack', 'โจมตี'], ['sit', 'นั่ง'], ['hit', 'โดนตี']];
const EMOTES = ['♥', '!', '?', '♪', '💧', '…'];

// ---------------- state ----------------
const c = load() ?? {
  species: 'human', class: 'fighter', background: 'soldier', method: 'standard',
  base: { ...CLASSES.fighter.recommended }, bonus: defaultBonus('soldier', 'fighter'),
  look: { hair: 'hair_bob', hairColor: HAIR_COLORS.chestnut, skin: SKIN_TONES.light, eyes: EYE_COLORS.blue, cloth1: null, cloth2: null, headgear: null },
  name: randomName('human'), bio: '',
};
let step = 0;
const visited = new Set([0]);
let set = null;
const stage = new Stage($('stage'));

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY))?.creator ?? null; } catch { return null; }
}

function lookFor(state = c) {
  const cls = CLASSES[state.class], sp = SPECIES[state.species];
  return {
    ...state.look,
    outfit: cls.kit.outfit, weapon: cls.kit.weapon, shield: cls.kit.shield,
    ears: sp.look.ears, scale: sp.look.scale,
  };
}

function stepValid(i) {
  if (STEPS[i].id === 'background') return validBonus(c);
  if (STEPS[i].id === 'abilities') {
    if (c.method === 'pointbuy') return pointBuyCost(c.base) <= POINT_BUDGET;
    return [...Object.values(c.base)].sort((a, b) => b - a).join() === STANDARD_ARRAY.join();
  }
  if (STEPS[i].id === 'review') return c.name.trim().length > 0;
  return true;
}

// ---------------- rendering ----------------
let recomposeQueued = false;
function update({ recompose = true } = {}) {
  if (recompose && set && !recomposeQueued) {
    recomposeQueued = true;
    requestAnimationFrame(() => { recomposeQueued = false; stage.setSheet(compose(set, lookFor())); });
  }
  renderSteps();
  renderPanel();
  renderSummary();
}

function renderSteps() {
  $('steps').replaceChildren(...STEPS.map((s, i) => h('li', {
    class: [i === step && 'active', visited.has(i) && i !== step && stepValid(i) && 'done', visited.has(i) && !stepValid(i) && 'invalid'].filter(Boolean).join(' '),
  }, h('button', { onclick: () => go(i) }, h('span', { class: 'gem' }, i + 1), h('span', { class: 'lbl' }, s.th)))));
  $('step-title').textContent = STEPS[step].title;
  $('step-sub').textContent = STEPS[step].th;
  $('back').disabled = step === 0;
  $('next').textContent = step === STEPS.length - 1 ? 'เริ่มผจญภัย ⚔' : 'ถัดไป';
  $('next').disabled = step === STEPS.length - 1 && !STEPS.every((_, i) => stepValid(i));
}

function renderSummary() {
  const d = derived(c);
  const cls = CLASSES[c.class], sp = SPECIES[c.species];
  $('hero-name').textContent = c.name || '—';
  $('hero-line').textContent = `${sp.th} · ${cls.th} · ${BACKGROUNDS[c.background].th}`;
  $('sum-badges').replaceChildren(
    `${sp.name} ${cls.name}`,
    ...cls.roles.map((r) => h('span', { class: `badge ${r}` }, r)),
  );
  const stat = (k, v) => h('div', {}, h('dt', {}, k), h('dd', {}, v));
  $('sum-stats').replaceChildren(stat('HP', d.hp), stat('AC', d.ac), stat('SPD', `${d.speed}ft`), stat('INIT', fmt(d.initiative)), stat('ATK', fmt(d.toHit)));
}

const fmt = (n) => (n >= 0 ? `+${n}` : `${n}`);
const stars = (n) => h('span', { class: 'stars' }, '★'.repeat(n) + '☆'.repeat(3 - n));

function thumb(look, { head = false, dir = 'S' } = {}) {
  const wrap = h('div', { class: 'thumb' + (head ? ' head' : '') });
  if (!set) return wrap;
  const cell = still(set, look, dir);
  if (head) { // crop to the head for hair / headgear choices
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    const hy = set.manifest.geometry[dir].anchors.head[1];
    g.drawImage(cell, 32, Math.max(0, hy - 58), 64, 64, 0, 0, 64, 64);
    wrap.append(cv);
  } else wrap.append(cell);
  return wrap;
}

function card({ on, onclick, look, head, title, sub, body }) {
  return h('button', { class: 'card' + (on ? ' on' : ''), onclick },
    look && thumb(look, { head }), h('div', { class: 'name' }, title, sub && h('small', {}, sub)), body);
}

function renderPanel() {
  const p = $('panel');
  p.replaceChildren(...PANELS[STEPS[step].id]().filter(Boolean));
  p.scrollTop = 0;
}

const PANELS = {
  species() {
    const sp = SPECIES[c.species];
    return [
      h('h3', {}, 'Quick start'),
      h('p', { class: 'hint' }, 'ไม่แน่ใจ? เลือกบทบาทที่อยากเล่น ระบบจะจัดตัวละครที่เหมาะให้ครบทุกขั้น'),
      h('div', { class: 'quick' }, Object.entries(QUICK).map(([role, q]) => h('button', {
        onclick: () => {
          Object.assign(c, { class: q.class, background: q.background, species: q.species, method: 'standard' });
          c.base = { ...CLASSES[q.class].recommended };
          c.bonus = defaultBonus(q.background, q.class);
          c.name = randomName(q.species);
          STEPS.forEach((_, i) => visited.add(i));
          go(4);
        },
      }, h('span', { class: `badge ${role}` }, role), h('b', {}, CLASSES[q.class].name), q.th))),
      h('h3', {}, 'เลือกเผ่าพันธุ์'),
      h('div', { class: 'cards' }, Object.entries(SPECIES).map(([id, s]) => card({
        on: c.species === id, onclick: () => { c.species = id; update(); },
        look: lookFor({ ...c, species: id }), title: s.name, sub: s.th,
        body: h('div', { class: 'blurb' }, s.blurb),
      }))),
      h('div', { class: 'detail' }, h('h4', {}, `${sp.name} · ${sp.th}`),
        h('div', { class: 'row' }, h('span', {}, h('b', {}, 'Size '), sp.size), h('span', {}, h('b', {}, 'Speed '), `${sp.speed} ft`),
          h('span', {}, h('b', {}, 'Darkvision '), sp.darkvision ? `${sp.darkvision} ft` : '—')),
        h('ul', {}, sp.traits.map((t) => h('li', {}, t)))),
    ];
  },

  class() {
    const cls = CLASSES[c.class];
    return [
      h('p', { class: 'hint' }, 'อาชีพกำหนดบทบาทในปาร์ตี้ ชุดเกราะ และอาวุธเริ่มต้น'),
      h('div', { class: 'cards' }, Object.entries(CLASSES).map(([id, k]) => card({
        on: c.class === id,
        onclick: () => {
          if (c.class === id) return;
          c.class = id;
          c.base = { ...k.recommended };
          c.bonus = defaultBonus(c.background, id);
          update();
        },
        look: lookFor({ ...c, class: id }), title: k.name, sub: k.th,
        body: [h('div', { class: 'badges' }, k.roles.map((r) => h('span', { class: `badge ${r}` }, r))), stars(k.difficulty), h('div', { class: 'blurb' }, k.blurb)],
      }))),
      h('div', { class: 'detail' }, h('h4', {}, `${cls.name} · ${cls.th}`),
        h('div', { class: 'row' },
          h('span', {}, h('b', {}, 'Hit die '), `d${cls.hitDie}`),
          h('span', {}, h('b', {}, 'Primary '), cls.primary.map((a) => ABILITY_NAMES[a]).join(' / ')),
          h('span', {}, h('b', {}, 'Saves '), cls.saves.map((a) => ABILITY_NAMES[a]).join(', ')),
          h('span', {}, h('b', {}, 'Armor '), cls.armor), h('span', {}, h('b', {}, 'Weapons '), cls.weapons)),
        h('ul', {}, cls.features.map((f) => h('li', {}, f)))),
    ];
  },

  background() {
    const bg = BACKGROUNDS[c.background];
    const vals = Object.values(c.bonus).filter((v) => v > 0);
    const spread = vals.length === 3;
    const toggle = (a) => {
      const b = { ...c.bonus };
      if (spread) return;
      // cycle: none -> +2 -> +1 -> none, keeping one +2 and one +1
      const cur = b[a] ?? 0;
      const next = cur === 0 ? 2 : cur === 2 ? 1 : 0;
      for (const k of Object.keys(b)) if (b[k] === next && next) delete b[k];
      if (next) b[a] = next; else delete b[a];
      c.bonus = b;
      update({ recompose: false });
    };
    return [
      h('p', { class: 'hint' }, 'ภูมิหลังให้โบนัสค่าสถานะ ทักษะ 2 อย่าง และ Origin Feat'),
      h('div', { class: 'cards wide' }, Object.entries(BACKGROUNDS).map(([id, b]) => card({
        on: c.background === id, onclick: () => { c.background = id; c.bonus = defaultBonus(id, c.class); update({ recompose: false }); },
        title: b.name, sub: b.th,
        body: [h('div', { class: 'blurb' }, b.blurb), h('div', { class: 'meta' }, `${b.skills.join(', ')} · ${b.feat}`)],
      }))),
      h('div', { class: 'detail' }, h('h4', {}, 'Ability bonus'),
        h('div', { class: 'seg' },
          h('button', { class: spread ? '' : 'on', onclick: () => { c.bonus = defaultBonus(c.background, c.class); update({ recompose: false }); } }, '+2 / +1'),
          h('button', { class: spread ? 'on' : '', onclick: () => { c.bonus = Object.fromEntries(bg.abilities.map((a) => [a, 1])); update({ recompose: false }); } }, '+1 / +1 / +1')),
        h('div', { class: 'bonus' }, bg.abilities.map((a) => h('button', {
          class: `abtn ${c.bonus[a] === 2 ? 'p2' : c.bonus[a] === 1 ? 'p1' : ''}`, onclick: () => toggle(a),
        }, `${ABILITY_NAMES[a]} ${c.bonus[a] ? '+' + c.bonus[a] : ''}`))),
        !validBonus(c) && h('p', { class: 'hint', style: 'color:#b03030' }, 'เลือก +2 หนึ่งค่า และ +1 อีกหนึ่งค่า'),
        h('ul', {}, h('li', {}, `Skills: ${bg.skills.join(', ')}`), h('li', {}, `Origin feat: ${bg.feat}`))),
    ];
  },

  abilities() {
    const cls = CLASSES[c.class];
    const final = finalScores(c);
    const cost = pointBuyCost(c.base);
    const setMethod = (m) => { c.method = m; c.base = m === 'standard' ? { ...cls.recommended } : Object.fromEntries(ABILITIES.map((a) => [a, 8])); update({ recompose: false }); };
    const rows = ABILITIES.map((a) => {
      const control = c.method === 'standard'
        ? h('select', { onchange: (e) => swapStandard(a, +e.target.value) }, STANDARD_ARRAY.map((v) => h('option', { value: v, selected: c.base[a] === v }, v)))
        : h('div', { class: 'pm' },
          h('button', { onclick: () => { if (c.base[a] > 8) { c.base[a]--; update({ recompose: false }); } } }, '−'),
          h('button', { onclick: () => { if (c.base[a] < 15) { c.base[a]++; update({ recompose: false }); } } }, '+'));
      const bonus = final[a] - c.base[a];
      return [
        h('div', { class: 'lbl' + (cls.primary.includes(a) ? ' primary' : '') }, h('b', {}, ABILITY_NAMES[a]), h('small', {}, ABILITY_TH[a])),
        control,
        h('div', { class: 'val' }, final[a], bonus ? h('sup', {}, `+${bonus}`) : null),
        h('div', { class: 'mod' }, fmt(mod(final[a]))),
      ];
    });
    return [
      h('div', { class: 'seg' },
        h('button', { class: c.method === 'standard' ? 'on' : '', onclick: () => setMethod('standard') }, 'Standard Array'),
        h('button', { class: c.method === 'pointbuy' ? 'on' : '', onclick: () => setMethod('pointbuy') }, 'Point Buy')),
      h('p', { class: 'hint' }, c.method === 'standard' ? 'จัดค่า 15, 14, 13, 12, 10, 8 ให้แต่ละสถานะ (เลือกซ้ำจะสลับกันให้อัตโนมัติ)' : `มี ${POINT_BUDGET} แต้ม ค่า 8–15`),
      h('button', { class: 'chip', onclick: () => { c.method = 'standard'; c.base = { ...cls.recommended }; update({ recompose: false }); } }, `★ ค่าแนะนำสำหรับ ${cls.name}`),
      h('h3', {}, 'Scores'),
      h('div', { class: 'abil' }, rows.flat()),
      c.method === 'pointbuy' && h('p', { class: 'budget' + (cost > POINT_BUDGET ? ' bad' : '') }, `ใช้ไป ${cost} / ${POINT_BUDGET} แต้ม`),
    ];
  },

  look() {
    const L = c.look;
    const parts = set?.manifest.parts ?? {};
    const hairs = Object.values(parts).filter((p) => p.slot === 'hair');
    const hats = Object.values(parts).filter((p) => p.slot === 'head_top');
    const swatches = (map, key, extra) => h('div', { class: 'swatches' },
      Object.entries(map).map(([name, hex]) => h('button', {
        class: 'swatch' + (L[key] === hex ? ' on' : ''), title: name, style: `background:${hex}`,
        onclick: () => { L[key] = hex; update(); },
      })), extra);
    const custom = (key) => h('input', { type: 'color', value: L[key] ?? '#888888', title: 'กำหนดเอง', oninput: (e) => { L[key] = e.target.value; update(); } });
    return [
      h('h3', {}, 'Body type'),
      h('div', { class: 'chips' }, h('button', { class: 'chip on' }, 'Type A'), h('button', { class: 'chip', disabled: true, title: 'กำลังผลิต asset' }, 'Type B (เร็วๆ นี้)')),
      h('h3', {}, 'Hair style · ทรงผม'),
      h('div', { class: 'cards' }, hairs.map((p) => card({ on: L.hair === p.id, onclick: () => { L.hair = p.id; update(); }, look: { ...lookFor(), hair: p.id, headgear: null }, head: true, title: p.label }))),
      h('h3', {}, 'Hair color · สีผม'), swatches(HAIR_COLORS, 'hairColor', custom('hairColor')),
      h('h3', {}, 'Skin · สีผิว'), swatches(SKIN_TONES, 'skin'),
      h('h3', {}, 'Eyes · สีตา'), swatches(EYE_COLORS, 'eyes'),
      h('h3', {}, 'Outfit color · สีชุดหลัก'), swatches(CLOTH_COLORS, 'cloth1', h('button', { class: 'chip', onclick: () => { L.cloth1 = null; update(); } }, 'สีเดิม')),
      h('h3', {}, 'Trim · สีขลิบ'), swatches(TRIM_COLORS, 'cloth2', h('button', { class: 'chip', onclick: () => { L.cloth2 = null; update(); } }, 'สีเดิม')),
      h('h3', {}, 'Headgear · หมวก'),
      h('div', { class: 'cards' },
        card({ on: !L.headgear, onclick: () => { L.headgear = null; update(); }, look: { ...lookFor(), headgear: null }, head: true, title: 'None' }),
        hats.map((p) => card({ on: L.headgear === p.id, onclick: () => { L.headgear = p.id; update(); }, look: { ...lookFor(), headgear: p.id }, head: true, title: p.label }))),
    ];
  },

  review() {
    const d = derived(c);
    const cls = CLASSES[c.class], sp = SPECIES[c.species], bg = BACKGROUNDS[c.background];
    return [
      h('h3', {}, 'Name · ชื่อ'),
      h('div', { class: 'field' },
        h('input', { value: c.name, maxlength: 24, oninput: (e) => { c.name = e.target.value; renderSummary(); renderSteps(); } }),
        h('button', { class: 'btn ghost', onclick: () => { c.name = randomName(c.species); update({ recompose: false }); } }, '🎲 สุ่ม')),
      h('textarea', { placeholder: 'ประวัติสั้นๆ (ไม่บังคับ)', oninput: (e) => (c.bio = e.target.value) }, c.bio),
      h('div', { class: 'detail' }, h('h4', {}, `${c.name || '—'} — Level 1 ${sp.name} ${cls.name}`),
        h('dl', { class: 'sheet' },
          ...[['Background', `${bg.name} (${bg.feat})`], ['Roles', cls.roles.join(', ')], ['HP / AC', `${d.hp} / ${d.ac}`],
            ['Attack', `${fmt(d.toHit)} · ${d.damage}`], ['Skills', d.skills.join(', ')],
            ['Scores', ABILITIES.map((a) => `${ABILITY_NAMES[a]} ${d.scores[a]}`).join('  ')]].flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
      h('p', { class: 'hint', style: 'margin-top:12px;font-size:11px' }, SRD_CREDIT),
    ];
  },
};

function swapStandard(a, v) {
  const other = ABILITIES.find((b) => b !== a && c.base[b] === v);
  if (other) c.base[other] = c.base[a];
  c.base[a] = v;
  update({ recompose: false });
}

function go(i) {
  step = Math.max(0, Math.min(STEPS.length - 1, i));
  visited.add(step);
  update({ recompose: false });
}

function finish() {
  const d = derived(c);
  const cls = CLASSES[c.class];
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    creator: c, look: lookFor(), setUrl: SET_URL,
    stats: { maxHp: d.hp, ac: d.ac, toHit: d.toHit, dmg: d.damage, speed: Math.floor(d.speed / 5), dex: d.scores.dex, xp: 0 },
    name: c.name, className: cls.name,
  }));
  location.href = '../prototype/';
}

// ---------------- stage controls ----------------
$('rot-l').onclick = () => stage.turn(-1);
$('rot-r').onclick = () => stage.turn(1);
$('anim-chips').replaceChildren(...ANIMS.map(([id, th]) => h('button', {
  class: 'chip' + (id === 'idle' ? ' on' : ''),
  onclick: (e) => { stage.play(id); for (const b of $('anim-chips').children) b.classList.toggle('on', b === e.currentTarget); },
}, th)), h('button', { class: 'chip', onclick: (e) => { stage.turntable = !stage.turntable; e.currentTarget.classList.toggle('on', stage.turntable); } }, '⟳ หมุนโชว์'));
$('emote-chips').replaceChildren(...EMOTES.map((s) => h('button', { class: 'chip', onclick: () => stage.emote(s) }, s)));
stage.onFrame = () => { $('compass').textContent = `▲ ${stage.direction}`; };
$('back').onclick = () => go(step - 1);
$('next').onclick = () => (step === STEPS.length - 1 ? finish() : go(step + 1));

update({ recompose: false });
loadSet(SET_URL).then((s) => {
  set = s;
  $('loading').classList.add('hide');
  update();
}).catch((e) => {
  $('loading').textContent = 'โหลดชุดตัวละครไม่สำเร็จ — ยังไม่ได้สร้าง asset (pipeline/sheet.py extract)';
  console.error(e);
});
