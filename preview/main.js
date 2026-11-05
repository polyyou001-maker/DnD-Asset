import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { loadSet, equip, drawCell, sourceDir, DIRS, SLOTS } from "../src/paperdoll/paperdoll.js";
import { PaperDollSprite } from "../src/paperdoll/three-sprite.js";

const { manifest, sheets } = await loadSet("../assets/paperdoll/manifest.json");
let loadout = structuredClone(manifest.defaultLoadout);
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ scene
const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(window.devicePixelRatio);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2533);
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(8, 7, 8);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1, 0);
controls.minPolarAngle = controls.maxPolarAngle = Math.PI / 3.2; // fixed isometric-ish tilt
controls.enablePan = false;
controls.minZoom = 0.5;
controls.maxZoom = 4;

scene.add(new THREE.HemisphereLight(0xfff4e0, 0x404060, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(5, 10, 3);
scene.add(sun);

// low-poly ground: tiles with slight height jitter, flat shaded
const tileColors = [0x5f8f4e, 0x6a9a55, 0x557f46];
for (let x = -5; x <= 5; x++) {
  for (let z = -5; z <= 5; z++) {
    const h = 0.2 + (((x * 7 + z * 13) % 3) + 3) % 3 * 0.04;
    const tile = new THREE.Mesh(new THREE.BoxGeometry(1, h, 1),
      new THREE.MeshLambertMaterial({ color: tileColors[((x + z) % 3 + 3) % 3], flatShading: true }));
    tile.position.set(x, -h / 2, z);
    scene.add(tile);
  }
}
for (const [x, z] of [[-3, -2], [3, -3], [-2, 3]]) { // reference props to read the camera rotation
  const tree = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 6),
    new THREE.MeshLambertMaterial({ color: 0x2f6a3a, flatShading: true }));
  tree.position.set(x, 0.8, z);
  scene.add(tree);
}

const doll = new PaperDollSprite(manifest, sheets, loadout, { ppu: 32 });
scene.add(doll.group);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  const half = 3.5;
  camera.left = -half * w / h; camera.right = half * w / h;
  camera.top = half; camera.bottom = -half;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ------------------------------------------------------------------ UI: equipment + dyes
const occupies = (p) => p.occupies ?? [p.slot];
const label = (id) => manifest.parts[id].label ?? id;

function buildSlots() {
  const box = $("slots");
  box.innerHTML = "";
  for (const slot of SLOTS) {
    const ids = Object.keys(manifest.parts).filter((id) => occupies(manifest.parts[id]).includes(slot));
    const sel = document.createElement("select");
    if (slot !== "body") sel.add(new Option("(none)", ""));
    for (const id of ids) sel.add(new Option(label(id), id));
    sel.value = loadout[slot] ?? "";
    sel.onchange = () => { loadout = equip(manifest, loadout, slot, sel.value || null); applyLoadout(); };
    const l = document.createElement("label");
    l.append(slot, sel);
    box.append(l);
  }
}

function buildDyes() {
  const box = $("dyes");
  box.innerHTML = "";
  for (const ramp of Object.keys(manifest.ramps)) {
    const sel = document.createElement("select");
    for (const name of Object.keys(manifest.dyes[ramp])) sel.add(new Option(name, name));
    sel.value = loadout.dye[ramp];
    sel.onchange = () => { loadout = { ...loadout, dye: { ...loadout.dye, [ramp]: sel.value } }; applyLoadout(); };
    const l = document.createElement("label");
    l.append(ramp, sel);
    box.append(l);
  }
}

function applyLoadout() {
  doll.setLoadout(loadout);
  buildSlots(); // conflicts may have cleared other slots
  drawStrip();
  drawEditor();
}

// ------------------------------------------------------------------ UI: animation + facing
for (const a of Object.keys(manifest.anims)) $("anim").add(new Option(a, a));
$("anim").onchange = () => { doll.anim = $("anim").value; drawStrip(); drawEditor(); };
$("turnL").onclick = () => { doll.facingYaw += Math.PI / 4; };
$("turnR").onclick = () => { doll.facingYaw -= Math.PI / 4; };
$("circle").onchange = () => {
  $("anim").value = doll.anim = $("circle").checked ? "walk" : "idle";
  if (!$("circle").checked) doll.group.position.set(0, 0, 0);
  drawStrip();
};

// 8-direction strip: every direction of the current frame, composed by the core module
const strip = [];
for (const d of DIRS) {
  const fig = document.createElement("figure");
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  c.className = "px";
  c.style.width = c.style.height = "96px";
  const cap = document.createElement("figcaption");
  fig.append(c, cap);
  $("strip").append(fig);
  strip.push({ d, c, cap });
}
function drawStrip(frame = doll.frame ?? 0) {
  for (const { d, c, cap } of strip) {
    const src = sourceDir(manifest, d);
    const ctx = c.getContext("2d");
    ctx.setTransform(src.mirrored ? -1 : 1, 0, 0, 1, src.mirrored ? 64 : 0, 0);
    ctx.clearRect(0, 0, 64, 64);
    drawCell(ctx, 0, 0, manifest, sheets, loadout, doll.anim, src.dir, frame);
    cap.textContent = src.mirrored ? `${d} (=${src.dir}⇋)` : d;
    c.style.outline = DIRS[doll.dir] === d ? "2px solid var(--accent)" : "none";
  }
}

// ------------------------------------------------------------------ anchor editor
const ed = { dir: "S", frame: 0 };
for (const d of manifest.drawn) $("eDir").add(new Option(d, d));
$("editToggle").onchange = () => { $("editor").classList.toggle("on", $("editToggle").checked); drawEditor(); };
$("eDir").onchange = () => { ed.dir = $("eDir").value; drawEditor(); };
$("ePrev").onclick = () => { ed.frame = (ed.frame + manifest.anims[doll.anim].frames - 1) % manifest.anims[doll.anim].frames; drawEditor(); };
$("eNext").onclick = () => { ed.frame = (ed.frame + 1) % manifest.anims[doll.anim].frames; drawEditor(); };

const editCanvas = $("editCanvas");
const EDIT_SCALE = 6;
editCanvas.width = editCanvas.height = 64 * EDIT_SCALE;
const markerColor = { head: "#f8c840", hand_main: "#f0605a", hand_off: "#4a90d8" };

function bodyAnchors() {
  const body = manifest.parts[loadout.body];
  return body.anchors[doll.anim][ed.dir];
}
function drawEditor() {
  if (!$("editToggle").checked) return;
  ed.frame %= manifest.anims[doll.anim].frames;
  $("eFrame").textContent = ed.frame;
  const tmp = document.createElement("canvas");
  tmp.width = tmp.height = 64;
  drawCell(tmp.getContext("2d"), 0, 0, manifest, sheets, loadout, doll.anim, ed.dir, ed.frame);
  const ctx = editCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, editCanvas.width, editCanvas.height);
  ctx.drawImage(tmp, 0, 0, editCanvas.width, editCanvas.height);
  const a = bodyAnchors()[ed.frame] ?? {};
  for (const [name, p] of Object.entries(a)) {
    ctx.strokeStyle = markerColor[name] ?? "#fff";
    ctx.lineWidth = 2;
    ctx.strokeRect(p[0] * EDIT_SCALE, p[1] * EDIT_SCALE, EDIT_SCALE, EDIT_SCALE);
  }
}
editCanvas.onclick = (e) => {
  const r = editCanvas.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * 64);
  const y = Math.floor((e.clientY - r.top) / r.height * 64);
  const frames = bodyAnchors();
  frames[ed.frame] = { ...frames[ed.frame], [$("eAnchor").value]: [x, y] };
  applyLoadout(); // re-bake so the 3D view shows the new anchor
};
$("eExport").onclick = () => {
  const body = manifest.parts[loadout.body];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(body.anchors, null, 1)], { type: "application/json" }));
  a.download = "anchors.json"; // save as art/paperdoll/<body id>/anchors.json, then run pack.py
  a.click();
};

// ------------------------------------------------------------------ loop
buildSlots();
buildDyes();
const clock = new THREE.Clock();
let lastFrame = -1, lastDir = -1;
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if ($("circle").checked) {
    const t = clock.elapsedTime * 0.5;
    doll.group.position.set(Math.cos(t) * 3, 0, Math.sin(t) * 3);
    doll.facingYaw = Math.atan2(-Math.sin(t), Math.cos(t)); // tangent of the circle
  }
  controls.update();
  doll.update(dt, camera, doll.group.position);
  if (doll.frame !== lastFrame || doll.dir !== lastDir) {
    lastFrame = doll.frame; lastDir = doll.dir;
    drawStrip();
    const src = doll.drawnDir;
    $("hud").textContent = `dir ${DIRS[doll.dir]}${src.mirrored ? ` (mirror of ${src.dir})` : ""} · ${doll.anim} frame ${doll.frame}`;
  }
  renderer.render(scene, camera);
});
