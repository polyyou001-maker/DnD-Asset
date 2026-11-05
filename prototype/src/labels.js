import * as THREE from 'three';

function canvasSprite(draw, w, h, worldH) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((worldH * w) / h, worldH, 1);
  sprite.renderOrder = 10;
  return sprite;
}

class Label {
  constructor(sprite, life, y, rise) {
    this.sprite = sprite; this.life = life; this.t = 0; this.rise = rise; this.y = y;
    sprite.position.y = y;
  }
  get done() { return this.t >= this.life; }
  update(dt) {
    this.t += dt;
    this.sprite.position.y = this.y + this.rise * this.t;
    this.sprite.material.opacity = Math.min(1, (this.life - this.t) * 3);
    if (this.done) {
      this.sprite.parent?.remove(this.sprite);
      this.sprite.material.map.dispose();
      this.sprite.material.dispose();
    }
  }
}

// Floating combat text (damage, MISS, CRITICAL!).
export function floatingText(text, color, actorHeight, big = false) {
  const sprite = canvasSprite((g, w, h) => {
    g.font = `bold ${big ? 40 : 32}px "Trebuchet MS", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = '#1a1020';
    g.strokeText(text, w / 2, h / 2);
    g.fillStyle = color;
    g.fillText(text, w / 2, h / 2);
  }, 256, 64, big ? 0.6 : 0.45);
  return new Label(sprite, 1.1, actorHeight + 0.1, 0.8);
}

// Emote balloon over the head, 90s MMO style.
export function emoteBubble(symbol, actorHeight) {
  const sprite = canvasSprite((g, w, h) => {
    g.fillStyle = '#ffffff'; g.strokeStyle = '#2a1e2e'; g.lineWidth = 4;
    g.beginPath();
    g.roundRect(6, 6, w - 12, h - 26, 18);
    g.moveTo(w / 2 - 10, h - 21); g.lineTo(w / 2, h - 6); g.lineTo(w / 2 + 10, h - 21);
    g.fill(); g.stroke();
    g.fillRect(w / 2 - 8, h - 24, 16, 6);
    g.font = '52px "Segoe UI Emoji", "Apple Color Emoji", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#d23a5a';
    g.fillText(symbol, w / 2, (h - 20) / 2 + 4);
  }, 112, 104, 0.55);
  return new Label(sprite, 2.2, actorHeight + 0.35, 0.05);
}
