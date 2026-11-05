// Character rules data (SRD 5.2, CC-BY-4.0) and derived stats. Pure data + functions,
// shared by the creator UI and the game. See docs/specs/character-creation.md.

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_NAMES = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };
export const ABILITY_TH = { str: 'พลังกาย', dex: 'ความว่องไว', con: 'ความอึด', int: 'สติปัญญา', wis: 'ญาณ', cha: 'เสน่ห์' };

export const SPECIES = {
  human: {
    name: 'Human', th: 'มนุษย์', size: 'Medium', speed: 30, darkvision: 0,
    blurb: 'ปรับตัวเก่ง ได้ทักษะและ feat เพิ่ม เหมาะกับทุกคลาส',
    traits: ['Resourceful — ได้ Heroic Inspiration ทุก Long Rest', 'Skillful — ได้ทักษะเพิ่ม 1', 'Versatile — ได้ Origin Feat เพิ่ม 1'],
    look: { scale: [1, 1], ears: null },
  },
  elf: {
    name: 'Elf', th: 'เอลฟ์', size: 'Medium', speed: 30, darkvision: 60,
    blurb: 'ประสาทไว มองในที่มืดได้ ต้านทานเวทสะกด',
    traits: ['Darkvision 60 ft', 'Fey Ancestry — ได้เปรียบเมื่อต้าน Charmed', 'Keen Senses — ชำนาญ Perception', 'Trance — พักแค่ 4 ชม.'],
    look: { scale: [1, 1], ears: 'ears_elf' },
  },
  dwarf: {
    name: 'Dwarf', th: 'คนแคระ', size: 'Medium', speed: 30, darkvision: 120,
    blurb: 'ทนทานสุดๆ HP เพิ่มทุกเลเวล ต้านพิษ',
    traits: ['Darkvision 120 ft', 'Dwarven Resilience — ต้านพิษ', 'Dwarven Toughness — HP +1 ทุกเลเวล', 'Stonecunning — สัมผัสหินได้'],
    look: { scale: [1.06, 0.9], ears: null },
  },
  halfling: {
    name: 'Halfling', th: 'ฮาล์ฟลิง', size: 'Small', speed: 30, darkvision: 0,
    blurb: 'ตัวเล็ก โชคดี กล้าหาญ ซ่อนตัวเก่ง',
    traits: ['Brave — ได้เปรียบเมื่อต้าน Frightened', 'Halfling Nimbleness — เดินผ่านช่องศัตรูได้', 'Luck — ทอยได้ 1 ทอยใหม่', 'Naturally Stealthy'],
    look: { scale: [0.9, 0.84], ears: null },
  },
};

export const CLASSES = {
  fighter: {
    name: 'Fighter', th: 'นักรบ', roles: ['Tank', 'Striker'], difficulty: 1, hitDie: 10, primary: ['str', 'dex'],
    saves: ['str', 'con'], armor: 'ทุกชนิด + โล่', weapons: 'Simple, Martial',
    blurb: 'แนวหน้าที่แข็งแกร่ง ป้องกันเพื่อน เล่นง่าย',
    features: ['Fighting Style', 'Second Wind — ฟื้น HP ด้วยตัวเอง', 'Weapon Mastery ×3'],
    recommended: { str: 15, con: 14, dex: 13, wis: 12, cha: 10, int: 8 },
    kit: { outfit: 'outfit_fighter', weapon: 'longsword', shield: 'shield_kite' },
    ac: () => 18, attack: 'str', damage: '1d8',
    color: '#e0574a',
  },
  cleric: {
    name: 'Cleric', th: 'นักบวช', roles: ['Healer', 'Support'], difficulty: 2, hitDie: 8, primary: ['wis'],
    saves: ['wis', 'cha'], armor: 'เบา, กลาง + โล่', weapons: 'Simple',
    blurb: 'รักษาและเสริมพลังเพื่อน ใส่เกราะได้',
    features: ['Spellcasting (WIS)', 'Divine Order — Protector หรือ Thaumaturge'],
    recommended: { wis: 15, con: 14, str: 13, dex: 12, cha: 10, int: 8 },
    kit: { outfit: 'outfit_cleric', weapon: 'mace', shield: 'shield_round' },
    ac: (m) => 13 + Math.min(2, m.dex) + 2, attack: 'str', damage: '1d6',
    color: '#f2c94c',
  },
  rogue: {
    name: 'Rogue', th: 'โจร', roles: ['Striker', 'Scout'], difficulty: 2, hitDie: 8, primary: ['dex'],
    saves: ['dex', 'int'], armor: 'เบา', weapons: 'Simple, Martial (Finesse/Light)',
    blurb: 'ลอบโจมตีแรง ซ่อนตัว ปลดกับดัก เก่งทักษะ',
    features: ['Sneak Attack 1d6', 'Expertise ×2', "Thieves' Cant", 'Weapon Mastery ×2'],
    recommended: { dex: 15, con: 14, int: 13, wis: 12, cha: 10, str: 8 },
    kit: { outfit: 'outfit_rogue', weapon: 'dagger', shield: null },
    ac: (m) => 11 + m.dex, attack: 'dex', damage: '1d4',
    color: '#6fcf97',
  },
  wizard: {
    name: 'Wizard', th: 'จอมเวท', roles: ['Caster', 'Control'], difficulty: 3, hitDie: 6, primary: ['int'],
    saves: ['int', 'wis'], armor: '—', weapons: 'Simple',
    blurb: 'เวทวงกว้าง ควบคุมสนามรบ ต้องวางแผน',
    features: ['Spellcasting (INT)', 'Ritual Adept', 'Arcane Recovery'],
    recommended: { int: 15, con: 14, dex: 13, wis: 12, cha: 10, str: 8 },
    kit: { outfit: 'outfit_wizard', weapon: 'staff', shield: null },
    ac: (m) => 10 + m.dex, attack: 'str', damage: '1d6',
    color: '#7aa2ff',
  },
};

export const BACKGROUNDS = {
  acolyte: { name: 'Acolyte', th: 'ผู้รับใช้วิหาร', abilities: ['int', 'wis', 'cha'], skills: ['Insight', 'Religion'], feat: 'Magic Initiate (Cleric)', blurb: 'เติบโตในวิหาร รู้เรื่องศาสนาและจิตใจคน' },
  criminal: { name: 'Criminal', th: 'อาชญากร', abilities: ['dex', 'con', 'int'], skills: ['Sleight of Hand', 'Stealth'], feat: 'Alert', blurb: 'เคยอยู่ใต้ดิน ไวต่ออันตราย มือไว' },
  sage: { name: 'Sage', th: 'ปราชญ์', abilities: ['con', 'int', 'wis'], skills: ['Arcana', 'History'], feat: 'Magic Initiate (Wizard)', blurb: 'นักค้นคว้า รู้เวทและประวัติศาสตร์' },
  soldier: { name: 'Soldier', th: 'ทหาร', abilities: ['str', 'dex', 'con'], skills: ['Athletics', 'Intimidation'], feat: 'Savage Attacker', blurb: 'ผ่านสงครามมา แข็งแกร่งและน่าเกรงขาม' },
};

export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
export const POINT_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
export const POINT_BUDGET = 27;

export const SKIN_TONES = { porcelain: '#ffe6d8', light: '#f6d2b8', tan: '#dca47c', brown: '#a8714f', deep: '#6e4632' };
export const HAIR_COLORS = {
  ash: '#d9d6e8', blonde: '#f2cf6b', copper: '#e07a3f', crimson: '#c8364a', rose: '#f29bbf',
  violet: '#8a64d6', azure: '#4d8de0', mint: '#59c9a5', chestnut: '#8a5236', raven: '#2e2a3a',
};
export const EYE_COLORS = { blue: '#3f7fe0', green: '#3fae6a', amber: '#e0a030', red: '#d0404a', violet: '#9a5ad0', grey: '#8a8fa0' };
export const CLOTH_COLORS = {
  royal: '#3a5fd0', crimson: '#c0343c', forest: '#2f8a4a', violet: '#7a48c0', teal: '#2a9aa0',
  black: '#2c2a36', white: '#e8e6f0', amber: '#d08a2a', rose: '#d0628a', brown: '#7a5030',
};
export const TRIM_COLORS = { gold: '#e0b040', silver: '#c8ccd8', copper: '#c07040', jade: '#50b080' };

export const mod = (score) => Math.floor((score - 10) / 2);

export function pointBuyCost(scores) {
  return ABILITIES.reduce((sum, a) => sum + (POINT_COST[scores[a]] ?? 99), 0);
}

// Final scores = base + background bonus (+2/+1 or +1/+1/+1), capped at 20.
export function finalScores(c) {
  const out = { ...c.base };
  for (const [a, v] of Object.entries(c.bonus ?? {})) out[a] = Math.min(20, out[a] + v);
  return out;
}

export function derived(c) {
  const cls = CLASSES[c.class];
  const sp = SPECIES[c.species];
  const scores = finalScores(c);
  const m = Object.fromEntries(ABILITIES.map((a) => [a, mod(scores[a])]));
  const prof = 2;
  const atkAbility = cls.attack === 'dex' || (c.class === 'fighter' && scores.dex > scores.str) ? 'dex' : 'str';
  return {
    scores, mods: m, prof,
    hp: cls.hitDie + m.con + (c.species === 'dwarf' ? 1 : 0),
    ac: cls.ac(m),
    initiative: m.dex,
    speed: sp.speed,
    toHit: prof + m[atkAbility],
    damage: `${cls.damage}${m[atkAbility] >= 0 ? '+' : ''}${m[atkAbility]}`,
    skills: [...BACKGROUNDS[c.background].skills],
  };
}

// Validate a bonus choice: either {a:2,b:1} or {a:1,b:1,c:1} within the background's abilities.
export function validBonus(c) {
  const allowed = BACKGROUNDS[c.background].abilities;
  const vals = Object.entries(c.bonus ?? {}).filter(([, v]) => v > 0);
  if (vals.some(([a]) => !allowed.includes(a))) return false;
  const sorted = vals.map(([, v]) => v).sort().join(',');
  return sorted === '1,2' || sorted === '1,1,1';
}

export function defaultBonus(bgId, classId) {
  const allowed = BACKGROUNDS[bgId].abilities;
  const prio = Object.entries(CLASSES[classId].recommended).sort((a, b) => b[1] - a[1]).map(([a]) => a);
  const ranked = prio.filter((a) => allowed.includes(a));
  return { [ranked[0]]: 2, [ranked[1]]: 1 };
}

const NAMES = {
  human: ['Aria', 'Bram', 'Celia', 'Doran', 'Elena', 'Fenn', 'Garen', 'Hana', 'Ivo', 'Lysa'],
  elf: ['Aelar', 'Lirael', 'Sylwen', 'Thalion', 'Naivara', 'Erevan', 'Ilyana', 'Faelyn'],
  dwarf: ['Bruna', 'Thorin', 'Helga', 'Dain', 'Vistra', 'Rurik', 'Eldeth', 'Barend'],
  halfling: ['Pip', 'Rosie', 'Milo', 'Lavinia', 'Cade', 'Merry', 'Seraphina', 'Wendel'],
};
export const randomName = (species) => NAMES[species][Math.floor(Math.random() * NAMES[species].length)];

export const SRD_CREDIT = 'This work includes material from the System Reference Document 5.2 by Wizards of the Coast LLC, licensed under CC-BY-4.0.';
