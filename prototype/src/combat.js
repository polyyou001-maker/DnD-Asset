import { rollDamage } from './dice.js';
import { reachable, pathTo, tileKey, chebyshev } from './grid.js';
import { floatingText } from './labels.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mod = (score) => Math.floor((score - 10) / 2);

// Turn-based encounter on the tile grid. Exploration pauses while it runs.
export class Combat {
  constructor(game, enemies) {
    this.game = game;
    this.player = game.player;
    this.enemies = enemies;
    this.turn = null; // { actor, moves, action, reach }
    this.busy = false;
  }

  get alive() { return this.enemies.filter((e) => e.hp > 0); }

  occupiedExcept(actor) {
    const set = new Set();
    for (const a of [this.player, ...this.alive]) if (a !== actor) set.add(tileKey(a.tx, a.tz));
    return set;
  }

  // Melee reach: adjacent tile and no more than one height level apart.
  canMelee(a, t) {
    return chebyshev({ x: a.tx, z: a.tz }, { x: t.tx, z: t.tz }) === 1 && Math.abs(a.tile.h - t.tile.h) <= 1;
  }

  async run() {
    const { game } = this;
    game.log('⚔️ Combat! Roll for initiative.', 'sys');
    const order = [];
    const p = await game.dice.d20({ label: `${this.player.name} — Initiative`, mod: mod(this.player.stats.dex) });
    order.push({ actor: this.player, init: p.total });
    for (const e of this.enemies) {
      const r = await game.dice.d20({ label: '', mod: mod(e.stats.dex), show: false });
      order.push({ actor: e, init: r.total });
    }
    order.sort((a, b) => b.init - a.init);
    this.order = order.map((o) => o.actor);
    game.log('Initiative: ' + order.map((o) => `${o.actor.name} ${o.init}`).join(', '), 'sys');

    let round = 1;
    while (this.alive.length && !this.player.dead) {
      game.ui.setRound(round);
      for (const actor of this.order) {
        if (!this.alive.length || this.player.dead) break;
        if (actor !== this.player && actor.hp <= 0) continue;
        game.ui.setTurnOrder(this.order, actor);
        if (actor === this.player) await this.playerTurn();
        else await this.enemyTurn(actor);
      }
      round++;
    }
    game.ui.setTurnOrder(null);
    game.clearHighlights();
    if (this.player.dead) return 'defeat';
    const xp = this.enemies.reduce((s, e) => s + e.stats.xp, 0);
    game.log(`🏆 Victory! +${xp} XP`, 'good');
    return 'victory';
  }

  // ---- player ----
  async playerTurn() {
    const p = this.player;
    if (p.hp <= 0) return this.deathSave();
    this.turn = { actor: p, moves: p.stats.speed, action: true };
    this.refreshReach();
    this.game.ui.setTurnInfo(this.turn);
    await new Promise((r) => (this.turn.end = r));
    this.turn = null;
    this.game.clearHighlights();
    this.game.ui.setTurnInfo(null);
  }

  refreshReach() {
    const t = this.turn;
    t.reach = reachable(this.game.world, this.player.tx, this.player.tz, t.moves, this.occupiedExcept(this.player));
    const targets = t.action ? this.alive.filter((e) => this.canMelee(this.player, e)) : [];
    this.game.showHighlights(t.reach, targets);
    this.game.ui.setTurnInfo(t);
  }

  async playerMove(tx, tz) {
    const t = this.turn;
    const node = t?.reach.get(tileKey(tx, tz));
    if (!node || node.dist === 0 || this.busy) return;
    this.busy = true;
    this.game.clearHighlights();
    t.moves -= node.dist;
    await this.player.walkPath(pathTo(node));
    this.busy = false;
    this.refreshReach();
  }

  async playerAttack(target) {
    const t = this.turn;
    if (!t?.action || this.busy || !target || !this.canMelee(this.player, target)) return;
    this.busy = true;
    t.action = false;
    await this.attack(this.player, target);
    this.busy = false;
    if (!this.alive.length) return this.endPlayerTurn();
    this.refreshReach();
  }

  endPlayerTurn() {
    if (this.busy || !this.turn) return;
    this.turn.end();
  }

  async deathSave() {
    const p = this.player;
    const r = await this.game.dice.d20({ label: `${p.name} — Death Save`, target: 10 });
    if (r.nat === 20) {
      p.hp = 1; p.downed = false; p.saves = { ok: 0, fail: 0 };
      p.setState('idle');
      this.game.log('✨ Natural 20! You rise with 1 HP.', 'good');
      return;
    }
    if (r.nat === 1) p.saves.fail += 2;
    else if (r.success) p.saves.ok++;
    else p.saves.fail++;
    this.game.log(`Death save: ${p.saves.ok} success / ${p.saves.fail} fail`, 'sys');
    this.checkDeathSaves();
  }

  checkDeathSaves() {
    const p = this.player;
    if (p.saves.fail >= 3) {
      p.dead = true;
      this.game.log('💀 You have died.', 'bad');
    } else if (p.saves.ok >= 3) {
      p.hp = 1; p.downed = false; p.saves = { ok: 0, fail: 0 };
      p.setState('idle');
      this.game.log('You stabilise and stand up with 1 HP.', 'good');
    }
  }

  // ---- enemies ----
  async enemyTurn(e) {
    const p = this.player;
    this.game.camera.target.copy(e.root.position);
    await sleep(250);
    if (!this.canMelee(e, p)) {
      const reach = reachable(this.game.world, e.tx, e.tz, e.stats.speed, this.occupiedExcept(e));
      let best = null;
      for (const node of reach.values()) {
        const d = chebyshev(node.tile, { x: p.tx, z: p.tz });
        const adjacentOk = d === 1 && Math.abs(node.tile.h - p.tile.h) <= 1;
        const score = (adjacentOk ? 0 : 100 + d * 10) + node.dist;
        if (!best || score < best.score) best = { node, score };
      }
      if (best && best.node.dist > 0) await e.walkPath(pathTo(best.node));
    }
    if (this.canMelee(e, p)) await this.attack(e, p);
    this.game.camera.target.copy(p.root.position);
    await sleep(150);
  }

  // ---- shared attack resolution ----
  async attack(a, target) {
    const { game } = this;
    a.faceToward(target.root.position.x, target.root.position.z);
    target.faceToward(a.root.position.x, a.root.position.z);
    const anim = a.playOnce('attack');

    if (target === this.player && target.hp <= 0) {
      // 5e: a melee hit on a downed creature is a critical: two failed death saves.
      await anim;
      target.saves.fail += 2;
      target.flash = 1;
      game.log(`${a.name} strikes you while you're down! (2 failed saves)`, 'bad');
      this.checkDeathSaves();
      return;
    }

    // House rule from the design: higher ground grants advantage.
    const adv = a.tile.h > target.tile.h;
    const r = await game.dice.d20({ label: `${a.name} attacks ${target.name}${adv ? ' (high ground)' : ''}`, mod: a.stats.toHit, adv, target: target.stats.ac });
    await anim;
    if (!r.success) {
      target.addLabel(floatingText('MISS', '#cfd6e6', target.height));
      game.log(`${a.name} misses ${target.name}.`);
      return;
    }
    const crit = r.nat === 20;
    const dmg = rollDamage(a.stats.dmg, crit);
    target.hp = Math.max(0, target.hp - dmg.total);
    target.flash = 1;
    target.addLabel(floatingText(String(dmg.total), crit ? '#ffd23a' : target === this.player ? '#ff6a6a' : '#ffffff', target.height, crit));
    if (crit) {
      game.camera.punch();
      target.addLabel(floatingText('CRITICAL!', '#ffd23a', target.height + 0.35, true));
    }
    game.log(`${a.name} hits ${target.name} for ${dmg.total} (${dmg.dice.join('+')}${dmg.mod ? (dmg.mod > 0 ? '+' : '') + dmg.mod : ''})${crit ? ' — CRIT!' : ''}`, target === this.player ? 'bad' : 'good');
    if (target.hp > 0) {
      await target.playOnce('hit');
      return;
    }
    if (target === this.player) {
      target.downed = true;
      target.saves = { ok: 0, fail: 0 };
      game.log('You fall unconscious! Death saves begin.', 'bad');
    } else {
      game.log(`${target.name} is defeated.`, 'good');
    }
    target.stop();
    await target.playOnce('dead');
  }
}
