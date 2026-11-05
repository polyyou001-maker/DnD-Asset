# Character creation — spec (v2)

Status: draft 2026-11-05. Decisions confirmed with the user: 128 px sprites, AI-generated
layered paper-doll, AI keyframes + puppet animation, 4 launch classes.
Supersedes the art parts of `character-dressing.md` (64 px, exact-ramp dye).

Rules content follows the **D&D SRD 5.2 (CC-BY-4.0)**. Credit line required in the game:
"This work includes material from the System Reference Document 5.2 by Wizards of the
Coast LLC, licensed under CC-BY-4.0."

## Goal

Players with different motives (fighting, healing, sneaking, casting, role-playing) build a
character in a few minutes whose **role in a party is clear** and whose **look is their own**,
and they see the exact in-game sprite from every direction while choosing.

## Flow (6 steps, any order after the first visit, live preview throughout)

| # | Step | Choice | Shown while choosing |
|---|---|---|---|
| 1 | Species | Human, Elf, Dwarf, Halfling | traits, speed, darkvision, size; sprite shape changes (ears, height) |
| 2 | Class | Fighter, Cleric, Rogue, Wizard | party role, difficulty, hit die, primary ability, armor, level-1 features; outfit + weapon change |
| 3 | Background | Acolyte, Criminal, Sage, Soldier | ability bonuses, 2 skills, origin feat; player picks +2/+1 or +1/+1/+1 |
| 4 | Abilities | Standard array or point buy (27) | "Recommended for <class>" one-click; modifiers and HP/AC/attack update live |
| 5 | Appearance | body type, skin, hair style + color, eyes, cloth dye ×2, headgear | rotate 8 directions, play idle / walk / attack / emote |
| 6 | Name & review | name (random by species), short bio | full sheet card + sprite; "Begin adventure" |

- A summary bar is always visible: species · class · role badges · HP · AC · speed.
- Every option card has a one-line Thai description for newcomers and a details toggle.
- "Quick start" on step 1: pick a role (Tank / Healer / Striker / Caster) and get a full,
  sensible character (class, background, recommended stats, matching look) in one click.
- Nothing is lost when going back: later choices that become invalid (e.g. a point-buy
  over budget) are flagged on their step, not silently reset.

## Party roles (shown as badges)

| Class | Roles | Difficulty | For players who like |
|---|---|---|---|
| Fighter | Tank, Striker | ★☆☆ | front line, simple and sturdy, protecting others |
| Cleric | Healer, Support | ★★☆ | keeping the party alive, buffs, armored caster |
| Rogue | Striker, Scout | ★★☆ | big single hits, stealth, locks/traps, skills |
| Wizard | Caster, Control | ★★★ | area spells, utility magic, planning |

## Rules data

### Species
| Species | Size / speed | Traits (level 1) | Sprite |
|---|---|---|---|
| Human | Medium / 30 ft | Resourceful (Heroic Inspiration after a long rest), Skillful (+1 skill), Versatile (origin feat) | base |
| Elf | Medium / 30 ft | Darkvision 60 ft, Fey Ancestry, Keen Senses (Perception), Trance | base + `ears_elf` layer |
| Dwarf | Medium / 30 ft | Darkvision 120 ft, Dwarven Resilience, Dwarven Toughness (+1 HP per level), Stonecunning | base scaled 0.92 tall × 1.06 wide |
| Halfling | Small / 30 ft | Brave, Halfling Nimbleness, Luck, Naturally Stealthy | base scaled 0.84 |

### Classes (level 1)
| Class | Hit die | Primary | Saves | Armor | Weapons | Features | Start kit (sprite) | Start AC |
|---|---|---|---|---|---|---|---|---|
| Fighter | d10 | STR or DEX | STR, CON | all, shields | simple, martial | Fighting Style, Second Wind, Weapon Mastery | longsword + shield | 18 (chain mail + shield) |
| Cleric | d8 | WIS | WIS, CHA | light, medium, shields | simple | Spellcasting, Divine Order | mace + shield | 15 + DEX (max 2) |
| Rogue | d8 | DEX | DEX, INT | light | simple, martial (Finesse/Light) | Expertise, Sneak Attack 1d6, Thieves' Cant, Weapon Mastery | 2 daggers | 11 + DEX (leather) |
| Wizard | d6 | INT | INT, WIS | — | simple | Spellcasting, Ritual Adept, Arcane Recovery | quarterstaff | 10 + DEX |

### Backgrounds
| Background | Ability options | Skills | Origin feat |
|---|---|---|---|
| Acolyte | INT, WIS, CHA | Insight, Religion | Magic Initiate (Cleric) |
| Criminal | DEX, CON, INT | Sleight of Hand, Stealth | Alert |
| Sage | CON, INT, WIS | Arcana, History | Magic Initiate (Wizard) |
| Soldier | STR, DEX, CON | Athletics, Intimidation | Savage Attacker |

Bonus: +2 to one and +1 to another of the three, or +1 to all three. No score above 20.

### Abilities
- Standard array: 15, 14, 13, 12, 10, 8 (assign each once).
- Point buy: 27 points, scores 8–15, cost 8:0 9:1 10:2 11:3 12:4 13:5 14:7 15:9.
- Recommended arrays: Fighter STR15 CON14 DEX13 WIS12 CHA10 INT8 · Cleric WIS15 CON14
  STR13 DEX12 CHA10 INT8 · Rogue DEX15 CON14 INT13 WIS12 CHA10 STR8 · Wizard INT15 CON14
  DEX13 WIS12 CHA10 STR8.
- Derived: modifier = floor((score − 10) / 2); HP = hit die max + CON mod (+1 Dwarf);
  initiative = DEX mod; proficiency +2; attack = proficiency + STR or DEX mod.

## Appearance options (launch set)

| Option | Values | Asset |
|---|---|---|
| Body type | A, B (neutral names; any species/class) | one base mannequin per body type |
| Skin | 5 tones | recolor of base skin colors |
| Hair style | bob, long, short, twintails (+2 per body type later) | hair layers |
| Hair color | 10 presets + custom hue/brightness | gradient-map dye |
| Eyes | 6 colors | hue shift of eye pixels |
| Outfit | one per class (variant 2 later) | outfit layers |
| Cloth dye | primary (the blue cloth), secondary (accent) | hue band recolor |
| Headgear | none, witch hat, circlet (cosmetic; any class) | headgear layers |
| Weapon | follows class start kit | item sprites on hand anchors |

## Sprite format (runtime)

- Cell 128×128 px, feet at (64, 122), figure ≈110 px tall. Drawn directions S, SW, W, NW, N;
  NE, E, SE mirror NW, W, SW.
- Layers back → front: `hair_back*`, `base_body`, `outfit`, `base_head`, `ears`, `hair`,
  `headgear`, `weapon`, `shield` (`*` later; W/NW/N put the weapon behind the body).
- Animation is procedural (puppet) on the composed layers, so every combination animates
  for free: idle (breathing bob), walk (bob + sway), attack (lean + weapon swing), hit
  (knock-back + flash), sit, dead. Output matches the prototype's sheet shape.

## Edge cases

- A hairstyle under a hat: hair is drawn, hat on top (no hat-hair variants at launch).
- Halfling/Dwarf scale changes anchors with the sprite (scaling happens after compose).
- Missing layer image for a direction → that layer is skipped for that direction only.
- Point buy over budget → step 4 shows the error, "Begin adventure" disabled.

## Out of scope (launch)

Levels above 1, spell selection UI, equipment shop, multiclass, more species/classes,
voice, portraits separate from the sprite.
