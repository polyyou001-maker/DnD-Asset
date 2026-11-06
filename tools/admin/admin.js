// Asset admin page (server: tools/admin.py, spec: docs/specs/asset-admin.md).
import { composeBody } from '/prototype/src/bodySheet.js';
import { EYE_COLORS } from '/src/character/rules.js';

const DIRS = ['S', 'SW', 'W', 'NW', 'N']; // order of dirs in sheet.json
const ACTIONS = { replace: 'แทนไฟล์', restore: 'ย้อนกลับ', use_pipeline: 'ใช้เฟรม pipeline' };
const GROUP_LABEL = { body: 'ทุกเผ่า', face: 'ทุกเผ่า', legacy: 'ทุกชุด' };
const MAX_UPLOAD = 32 * 1024 * 1024; // the server's limit: above it the connection drops before any message
const FACE_STATE = { open: 'idle', closed: 'blink' }; // what a face frame looks like in the game

const $ = (id) => document.getElementById(id);
const view = { category: 'body', categories: [], assets: [], asset: null, sel: null, source: null, version: Date.now() };
let players = [];

function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((c) => c !== null));
  return el;
}

function toast(text, error = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = error ? 'toast error' : 'toast';
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 3500);
}

async function api(path, options) {
  const res = await fetch(`/api/${path}`, options);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error);
  return body;
}

const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const query = (params) => new URLSearchParams(params).toString();

// Surface a failed action as a message instead of an unhandled rejection.
const guard = (fn) => (...args) => fn(...args).catch((e) => toast(e.message, true));

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`โหลดภาพไม่ได้: ${url}`));
    img.src = url;
  });
}

// ---------------------------------------------------------------- preview

// The image a player shows: as in the game (eyes drawn in), with an uploaded file in place of the current one.
async function loadSource(asset, pendingUrl) {
  const [image, metaFile] = asset.files;
  if (asset.category !== 'body' && asset.category !== 'face') {
    const meta = await (await fetch(metaFile.url)).json();
    return { ...meta, image: await loadImage(pendingUrl ?? `${image.url}?v=${view.version}`) };
  }
  const base = `/art/bodies/${asset.name}`;
  const meta = await (await fetch(`${base}/sheet.json`)).json();
  const [body, eyes] = await Promise.all([
    loadImage(asset.category === 'body' && pendingUrl || `${base}/sheet.png?v=${view.version}`),
    loadImage(asset.category === 'face' && pendingUrl || `${base}/eyes.png?v=${view.version}`),
  ]);
  return composeBody(meta, body, eyes, EYE_COLORS.blue);
}

function animate(canvas, get) {
  const player = { canvas, get };
  players.push(player);
  return player;
}

function tick(now) {
  for (const { canvas, get } of players) {
    const { source, state, dir } = get();
    const anim = source?.states[state];
    const frames = anim?.dirs[DIRS.indexOf(dir)];
    if (!frames) continue;
    const r = frames[Math.floor(now / 1000 * anim.fps) % frames.length];
    canvas.width = r.w;
    canvas.height = r.h;
    canvas.getContext('2d').drawImage(source.image, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  }
  requestAnimationFrame(tick);
}

const playedState = (sel, category) => (category === 'face' ? FACE_STATE[sel.state] : sel.state);

// ---------------------------------------------------------------- left + middle

function renderCategories() {
  $('categories').replaceChildren(...view.categories.filter((c) => c.id !== 'unsorted' || c.count).map((c) => h('li', {},
    h('button', { className: c.id === view.category ? 'on' : '', onclick: guard(() => selectCategory(c.id)) },
      h('span', { textContent: c.label }), h('span', { className: 'count', textContent: c.count })))));
}

function fillFilter(select, label, values) {
  const keep = select.value;
  select.replaceChildren(h('option', { value: '', textContent: label }), ...values.map((v) => h('option', { value: v, textContent: v })));
  select.value = values.includes(keep) ? keep : '';
  select.hidden = !values.length;
}

function renderFilters() {
  const unique = (fn) => [...new Set(view.assets.flatMap(fn))];
  fillFilter($('filter-group'), GROUP_LABEL[view.category] ?? 'ทุกกลุ่ม', view.assets.length > 1 ? unique((a) => [a.group]) : []);
  fillFilter($('filter-state'), 'ทุก state', unique((a) => a.states));
  fillFilter($('filter-dir'), 'ทุกทิศ', DIRS.filter((d) => view.assets.some((a) => a.dirs.includes(d))));
}

function renderGrid() {
  const text = $('search').value.trim().toLowerCase();
  const group = $('filter-group').value, state = $('filter-state').value, dir = $('filter-dir').value;
  const shown = view.assets.filter((a) => a.name.toLowerCase().includes(text) && (!group || a.group === group)
    && (!state || a.states.includes(state)) && (!dir || a.dirs.includes(dir)));
  const zip = $('zip');
  zip.href = `/api/download-category?${query({ category: view.category })}`;
  zip.setAttribute('aria-disabled', String(!view.assets.length));
  $('grid').replaceChildren(...shown.map((a) => {
    const params = { id: a.id, v: view.version, ...(state && { state }), ...(dir && { dir }) };
    const pic = a.hasThumb
      ? h('img', { className: 'pic', loading: 'lazy', alt: '', src: `/api/thumb?${query(params)}` })
      : h('span', { className: 'nothumb', textContent: 'ไม่มีภาพ' });
    return h('button', { className: `card${view.asset?.id === a.id ? ' on' : ''}`, onclick: guard(() => openAsset(a.id)) },
      pic, h('span', { className: 'name', textContent: a.name }),
      a.edited ? h('span', { className: 'badge', title: 'จำนวนเฟรมที่แก้มือ', textContent: a.edited }) : null);
  }));
  if (!shown.length) {
    $('grid').append(h('p', { className: 'empty', textContent: view.assets.length ? 'ไม่พบ Asset ตามตัวกรองนี้' : 'ยังไม่มี Asset ในหมวดนี้' }));
  }
}

async function selectCategory(id) {
  view.category = id;
  view.assets = await api(`assets?${query({ category: id })}`);
  renderCategories();
  renderFilters();
  renderGrid();
}

async function refreshLists() {
  view.version = Date.now();
  view.categories = await api('categories');
  await selectCategory(view.category);
}

// ---------------------------------------------------------------- right

const selectedKey = () => `${view.sel.state}_${view.sel.dir}_${view.sel.index}`;
const selectedFrame = () => view.asset.frames.find((f) => f.key === selectedKey());

function chips(values, current, pick) {
  return h('div', { className: 'chips' }, ...values.map((v) => h('button', { className: v === current ? 'on' : '', textContent: v, onclick: () => pick(v) })));
}

function drawStripFrame(canvas, f) {
  const { asset, source, sel } = view;
  if (asset.category === 'face') {
    const img = new Image();
    img.onload = () => {
      canvas.width = f.w; canvas.height = f.h;
      canvas.getContext('2d').drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    };
    img.src = `${asset.files[0].url}?v=${view.version}`;
    return;
  }
  const r = source.states[sel.state].dirs[DIRS.indexOf(f.dir)][f.index];
  canvas.width = r.w; canvas.height = r.h;
  canvas.getContext('2d').drawImage(source.image, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
}

function pickSel(change) {
  const sel = { ...view.sel, ...change };
  const dirs = view.asset.frames.filter((f) => f.state === sel.state).map((f) => f.dir);
  if (!dirs.includes(sel.dir)) sel.dir = dirs[0];
  if (!view.asset.frames.some((f) => f.state === sel.state && f.dir === sel.dir && f.index === sel.index)) sel.index = 0;
  view.sel = sel;
  renderDetails();
}

function historyList(asset) {
  if (!asset.versions.length) return h('p', { className: 'hint', textContent: 'ยังไม่มีการแทนไฟล์' });
  return h('ul', { className: 'rows' }, ...asset.versions.map((v) => h('li', {},
    h('span', { className: 'meta' },
      h('span', { textContent: `${ACTIONS[v.action]} ${v.frames.length} เฟรม` }),
      h('span', { className: 'sub', textContent: `${new Date(v.time).toLocaleString('th-TH')}${v.note ? ` · ${v.note}` : ''}` })),
    h('button', { className: 'action', textContent: 'กู้รุ่นนี้', title: 'กลับไปเป็นสถานะก่อนรายการนี้',
      onclick: guard(async () => {
        await post('restore', { id: asset.id, version: v.id });
        await afterChange(asset.id, 'กู้รุ่นแล้ว');
      }) }))));
}

function fileList(asset) {
  return h('ul', { className: 'rows' }, ...asset.files.map((f) => h('li', {},
    f.name.endsWith('.png') ? h('img', { className: 'pic', alt: '', src: `${f.url}?v=${view.version}` }) : null,
    h('span', { className: 'meta' }, h('span', { textContent: f.name }), h('span', { className: 'sub', textContent: `${Math.ceil(f.size / 1024)} KB` })),
    h('a', { className: 'button', href: `/api/download?${query({ id: asset.id, file: f.name })}`, textContent: 'ดาวน์โหลด' }))));
}

function orphanList(asset) {
  if (!asset.orphans.length) return null;
  return h('div', {}, h('h3', { textContent: 'งานแก้มือที่ไม่มีเฟรมแล้ว' }), h('ul', { className: 'rows' }, ...asset.orphans.map((key) => h('li', {},
    h('span', { className: 'meta', textContent: key }),
    h('a', { className: 'button', href: `/api/download?${query({ id: asset.id, override: key })}`, textContent: 'ดาวน์โหลด' }),
    h('button', { className: 'action', textContent: 'ลบ', onclick: guard(async () => {
      await post('use-pipeline', { id: asset.id, key });
      await afterChange(asset.id, 'ลบแล้ว');
    }) })))));
}

function renderFrames(asset) {
  const { sel } = view;
  const states = asset.states, frames = asset.frames.filter((f) => f.state === sel.state && f.dir === sel.dir);
  const dirs = DIRS.filter((d) => asset.frames.some((f) => f.state === sel.state && f.dir === d));
  const frame = selectedFrame();
  const canvas = h('canvas', { role: 'img', ariaLabel: `ตัวอย่าง ${asset.name}` });
  players = [animate(canvas, () => ({ source: view.source, state: playedState(view.sel, asset.category), dir: view.sel.dir }))];
  const strip = h('div', { className: 'strip' }, ...frames.map((f) => {
    const c = h('canvas', {});
    drawStripFrame(c, f);
    return h('button', { className: f.index === sel.index ? 'on' : '', title: f.key, onclick: () => pickSel({ index: f.index }) },
      c, f.edited ? h('span', { className: 'dot', title: 'แก้มือ' }) : null);
  }));
  return [
    h('div', { className: 'player' }, canvas),
    chips(states, sel.state, (state) => pickSel({ state })),
    chips(dirs, sel.dir, (dir) => pickSel({ dir })),
    strip,
    h('p', { className: 'hint', textContent: `${frame.key} · ${frame.w}×${frame.h} px${frame.edited ? ' · แก้มือ' : ''}` }),
    asset.category === 'body' ? h('p', { className: 'hint', textContent: 'ไฟล์ Body ไม่มีตา ตาอยู่ในหมวด Face' }) : null,
    h('div', { className: 'actions' },
      h('a', { className: 'button', href: `/api/download?${query({ id: asset.id, key: frame.key })}`, textContent: 'ดาวน์โหลดเฟรมนี้' }),
      h('a', { className: 'button', href: `/api/download?${query({ id: asset.id })}`, textContent: 'ดาวน์โหลดทั้งชีต' }),
      h('button', { className: 'action primary', textContent: 'อัปโหลดแทน', onclick: () => $('file').click() }),
      frame.edited ? h('button', { className: 'action', textContent: 'ใช้เฟรม pipeline', onclick: guard(async () => {
        await post('use-pipeline', { id: asset.id, key: frame.key });
        await afterChange(asset.id, 'กลับไปใช้เฟรมจาก pipeline แล้ว');
      }) }) : null),
    h('p', { className: 'hint', textContent: 'อัปโหลดได้ทั้งเฟรมเดียวหรือทั้งชีต ระบบจะแสดงภาพก่อน/หลังให้ยืนยันก่อน' }),
  ].filter(Boolean);
}

function renderDetails() {
  const { asset } = view;
  const head = [h('h2', { textContent: asset.name }), h('span', { className: 'chip', textContent: asset.category })];
  if (!asset.editable) {
    $('details').replaceChildren(...head, h('p', { className: 'hint', textContent: 'หมวดนี้ดูและดาวน์โหลดได้อย่างเดียว' }), h('h3', { textContent: 'ไฟล์' }), fileList(asset));
    return;
  }
  $('details').replaceChildren(...head, ...renderFrames(asset), orphanList(asset) ?? '',
    h('h3', { textContent: 'ประวัติรุ่น' }), historyList(asset), h('h3', { textContent: 'ไฟล์' }), fileList(asset));
}

async function openAsset(id) {
  const opening = (view.opening = Symbol());
  const asset = await api(`asset?${query({ id })}`);
  let { sel } = view, source = null;
  if (asset.editable) {
    const state = $('filter-state').value, dir = $('filter-dir').value;
    const fits = (f) => (!state || f.state === state) && (!dir || f.dir === dir);
    if (!asset.frames.some((f) => fits(f) && f.state === sel?.state && f.dir === sel?.dir && f.index === sel?.index)) {
      const first = asset.frames.find(fits) ?? asset.frames[0];
      sel = { state: first.state, dir: first.dir, index: first.index };
    }
    source = await loadSource(asset);
  }
  if (view.opening !== opening) return; // another asset was opened meanwhile
  Object.assign(view, { asset, sel, source });
  players = [];
  renderDetails();
  renderGrid();
}

async function afterChange(id, message) {
  await refreshLists();
  await openAsset(id);
  toast(message);
}

// ---------------------------------------------------------------- replace

async function showReview(preview) {
  const asset = preview.id === view.asset?.id ? view.asset : await api(`asset?${query({ id: preview.id })}`);
  const url = `/api/pending?${query({ token: preview.token })}`;
  const first = preview.frames[0];
  const reviewed = { source: null, state: playedState(first, asset.category), dir: first.dir };
  const canvas = h('canvas', { role: 'img', ariaLabel: 'ตัวอย่างหลังแทนไฟล์' });
  const player = animate(canvas, () => reviewed);
  const dialog = $('review');
  const close = () => {
    players = players.filter((p) => p !== player);
    dialog.close();
  };
  dialog.onclose = close;
  dialog.replaceChildren(
    h('h2', { textContent: `ตรวจก่อนแทน ${asset.name}: ${preview.frames.length} เฟรม` }),
    preview.warnings.length ? h('div', { className: 'warnings' }, ...preview.warnings.map((w) => h('div', { textContent: `⚠ ${w}` }))) : '',
    h('div', { className: 'review-body' },
      h('div', { className: 'pairs' }, ...preview.frames.map((f) => h('div', { className: 'pair' },
        h('span', { className: 'label', textContent: `${f.key}: ก่อน / หลัง` }),
        h('img', { src: f.before, alt: `${f.key} ก่อนแก้` }), h('img', { src: f.after, alt: `${f.key} หลังแก้` })))),
      h('div', { className: 'player' }, canvas)),
    h('div', { className: 'actions' },
      h('button', { className: 'action primary', textContent: 'ยืนยันแทนไฟล์', onclick: guard(async () => {
        close(); // first: an error message cannot show over an open dialog
        await post('apply', { token: preview.token });
        await afterChange(preview.id, 'แทนไฟล์แล้ว');
      }) }),
      h('button', { className: 'action', textContent: 'ยกเลิก', onclick: close })));
  dialog.showModal();
  reviewed.source = await loadSource(asset, url);
}

async function upload(file) {
  if (file.size > MAX_UPLOAD) throw new Error('ไฟล์ใหญ่เกิน 32 MB');
  const params = { name: file.name, ...(view.asset?.editable && { id: view.asset.id, key: selectedKey() }) };
  const preview = await api(`upload-preview?${query(params)}`, { method: 'POST', body: file });
  if (preview.noChange) toast('ไฟล์นี้เหมือนของเดิม ไม่มีอะไรเปลี่ยน');
  else await showReview(preview);
}

$('file').onchange = guard(async (e) => {
  const [file] = e.target.files;
  e.target.value = ''; // the same file can be picked again
  if (file) await upload(file);
});

let dragDepth = 0;
const dropzone = (show) => { $('dropzone').hidden = !show; };
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files') || $('review').open) return;
  dragDepth += 1;
  dropzone(true);
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone(false);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone(false);
  const [file] = e.dataTransfer.files;
  if (file && !$('review').open) guard(upload)(file);
});

for (const id of ['search', 'filter-group', 'filter-state', 'filter-dir']) $(id).oninput = renderGrid;

guard(refreshLists)();
requestAnimationFrame(tick);
