import * as THREE from 'three';

// Isometric-ish orbit camera: follows a target, rotates around Y (snapped to
// 45° or free), zooms in/out, pitch clamped so sprites never look paper-flat.
export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera;
    this.target = new THREE.Vector3();
    this.focus = new THREE.Vector3();
    this.yaw = Math.PI / 4;
    this.yawGoal = this.yaw;
    this.pitch = THREE.MathUtils.degToRad(50);
    this.dist = 14;
    this.distGoal = 14;
    this.minDist = 6;
    this.maxDist = 28;
    this.snap = true;
    this.shake = 0;

    let dragging = false, lastX = 0;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => {
      if (e.button === 2) { dragging = true; lastX = e.clientX; }
    });
    window.addEventListener('pointerup', (e) => {
      if (e.button === 2 && dragging) {
        dragging = false;
        if (this.snap) this.yawGoal = Math.round(this.yawGoal / (Math.PI / 4)) * (Math.PI / 4);
      }
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.yawGoal -= (e.clientX - lastX) * 0.008;
      lastX = e.clientX;
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distGoal = THREE.MathUtils.clamp(this.distGoal * (e.deltaY > 0 ? 1.12 : 0.89), this.minDist, this.maxDist);
    }, { passive: false });
  }

  rotateStep(sign) { this.yawGoal += sign * (Math.PI / 4); }

  punch(amount = 0.75, shake = 0.25) {
    this.dist *= amount;
    this.shake = shake;
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * 8);
    this.yaw += (this.yawGoal - this.yaw) * k;
    this.dist += (this.distGoal - this.dist) * (1 - Math.exp(-dt * 4));
    this.focus.lerp(this.target, 1 - Math.exp(-dt * 6));
    this.shake = Math.max(0, this.shake - dt);
    const s = this.shake * 0.6;
    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.focus.x + Math.sin(this.yaw) * cp * this.dist + (Math.random() - 0.5) * s,
      this.focus.y + Math.sin(this.pitch) * this.dist + (Math.random() - 0.5) * s,
      this.focus.z + Math.cos(this.yaw) * cp * this.dist
    );
    this.camera.lookAt(this.focus);
  }
}
