// DOM HUD: zone, HP, combat turn panel, log, fade, FPS.
const $ = (id) => document.getElementById(id);

export class UI {
  constructor(game) {
    this.game = game;
    this.fading = false;
    this.fpsAcc = 0; this.fpsFrames = 0;
    $('end-turn').addEventListener('click', () => game.combat?.endPlayerTurn());
  }

  setZone(name) { $('zone').textContent = name; }

  setMode(mode) {
    document.body.dataset.mode = mode;
    $('mode').textContent = mode === 'combat' ? 'COMBAT' : 'EXPLORE';
  }

  setRound(n) { $('round').textContent = `Round ${n}`; }

  setTurnOrder(order, current) {
    const el = $('turn-order');
    el.replaceChildren();
    if (!order) return;
    for (const a of order) {
      const li = document.createElement('li');
      li.textContent = `${a.name} ${a.hp}/${a.stats.maxHp}`;
      if (a === current) li.className = 'current';
      if (a.hp <= 0 && a !== this.game.player) li.classList.add('down');
      el.append(li);
    }
  }

  setTurnInfo(turn) {
    $('turn-info').textContent = turn
      ? `Your turn — Move ${turn.moves} tiles · Action ${turn.action ? 'ready' : 'used'}`
      : '';
    $('end-turn').disabled = !turn;
  }

  log(text, cls) {
    const li = document.createElement('li');
    li.textContent = text;
    if (cls) li.className = cls;
    const el = $('log');
    el.append(li);
    while (el.children.length > 60) el.firstChild.remove();
    el.scrollTop = el.scrollHeight;
  }

  fade(mid) {
    if (this.fading) return;
    this.fading = true;
    const el = $('fade');
    el.classList.add('on');
    setTimeout(() => {
      mid();
      el.classList.remove('on');
      setTimeout(() => (this.fading = false), 400);
    }, 400);
  }

  update(dt) {
    const p = this.game.player;
    $('hp-fill').style.width = `${(100 * p.hp) / p.stats.maxHp}%`;
    $('hp-text').textContent = p.downed
      ? `DOWN — saves ✔${p.saves.ok} ✖${p.saves.fail}`
      : `HP ${p.hp}/${p.stats.maxHp}${p.state === 'sit' ? ' (resting)' : ''}`;
    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      $('fps').textContent = `${Math.round(this.fpsFrames / this.fpsAcc)} FPS`;
      this.fpsAcc = 0; this.fpsFrames = 0;
    }
  }
}
