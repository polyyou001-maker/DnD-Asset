# 2.5D Prototype (Three.js)

Playable test bed for the visual direction and core loop: 2D billboard sprites (8 directions) on a low-poly 3D isometric scene, bright town vs dark dungeon lighting, and D&D 5e-style turn-based combat.

## Run

No build step: plain ES modules, Three.js r170 and lil-gui loaded from jsDelivr through an import map. Serve the `Project DND` folder over HTTP and open `/prototype/`:

```
python tools/devserver.py 5180
```

`tools/devserver.py` is `http.server` with `Cache-Control: no-store`, so the browser never runs
stale modules after an edit. Then open http://127.0.0.1:5180/prototype/ (in the desktop app, use
the `prototype` entry in `.claude/launch.json`).

## Animation lab

http://127.0.0.1:5180/prototype/lab.html — a training yard with dummies for checking every
animation of the real paper-doll set (`art/paperdoll2/A`) from all 8 directions.

- Click ground to walk, click a dummy to walk up and attack it; WASD/arrows walk (camera-relative,
  hold two keys for diagonals); Space/F attack, G block, H hit, K die/revive, X sit.
- 1–5 weapon, B shield, Tab class. Each weapon has its own attack style (composer `ATTACKS`):
  sword = slash, mace = smash, dagger = stab, staff = cast (fires a bolt), unarmed = punch.
- The panel has every state, turn buttons, a turntable, repeat, a speed slider and a readout of
  state, frame, drawn direction (and whether it is mirrored).

## Controls

| Input | Action |
|---|---|
| Left click | Move (exploration), move or attack (combat) |
| Right drag / Q, E | Rotate camera (snaps to 45° unless disabled) |
| Wheel | Zoom |
| X | Sit (regenerates 1 HP/s) |
| 1–6 | Emote balloons |
| Space | End turn |

The settings panel (top right) changes pixel scale, camera pitch, animation and dice speed, torch flicker and aggro range, and can jump between zones.

## What it covers

- **Sprites**: `src/actor.js`. Cylindrical billboard pivoted at the feet. `spriteDirection(facing, cameraYaw)` picks 1 of 8 directions; 5 are drawn (S, SW, W, NW, N) and 3 are mirrored. A silhouette shows through walls.
- **Lighting**: sprites are unlit planes tinted by `World.lightAt()` (ambient plus nearby point lights), so they darken in the dungeon and glow near torches the same way the 3D scene does.
- **Combat**: `src/combat.js`. Initiative, 6-tile movement range, melee attack d20 + to-hit vs AC, nat 20 crit (dice doubled, camera punch), high ground gives advantage (house rule), death saves, and respawn in town on death.
- **Maps**: `src/maps.js`. ASCII layouts. Heights `.`/`,`/`:` = levels 0/1/2; a step can climb or drop one level.

## Swapping in real art

Placeholder sprites come from `src/placeholderSheet.js`. Any sheet with this shape works with `Actor`:

```js
{ image, frameW, frameH, states: { idle|walk|attack|sit|hit|dead: { fps, loop, dirs: [S, SW, W, NW, N] /* each: [{x,y,w,h}, ...] */ } } }
```

The paper-doll system (`docs/specs/character-dressing.md`) will provide composed sheets in this shape.
