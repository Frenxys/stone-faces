"use strict";
const $ = id => document.getElementById(id);
const TILE = 16;
const MAX_CHROMA = 0.046;   // above this, a block is too colourful and is dropped
const MAX_NOISE = 0.1;      // above this, a texture is too busy (dropped when "clean textures" is on)
const SRC = 8;              // native head size, 8x8

const state =  { palette: [], sheet: null, json: null };

const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255;
const clamp = v => Math.min(1, Math.max(0, v));

function loadImage(url) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("load failed: " + url));
    img.src = url;
  });
}

// ---------- palette ----------
const textureCache = new Map();

async function loadBlock([tex, id, group]) {
  try {
    const img = await loadImage(TEXTURE_BASE + tex + ".png");
    const c = document.createElement("canvas");
    c.width = c.height = TILE;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, img.width, img.width, 0, 0, TILE, TILE); // first frame if animated
    const d = g.getImageData(0, 0, TILE, TILE).data;
    const n = d.length / 4;
    let s = 0, s2 = 0, ch = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = lum(d[i], d[i + 1], d[i + 2]);
      s += l; s2 += l * l;
      ch += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    }
    const mean = s / n;
    return { tex, id: "minecraft:" + (id || tex), group, canvas: c, lum: mean,
      chroma: ch / n / 255, noise: Math.sqrt(Math.max(0, s2 / n - mean * mean)) };
  } catch { return null; }
}

async function getPalette(mode) {
  if (!textureCache.size) {
    const all = await Promise.all(BLOCKS.map(loadBlock));
    all.filter(b => b && b.chroma <= MAX_CHROMA).forEach(b => textureCache.set(b.tex, b));
  }
  const on = { stone: $("gStone").checked, dark: $("gDark").checked, extra: $("gExtra").checked };
  const clean = $("clean").checked;
  const pal = [...textureCache.values()]
    .filter(b => on[b.group] && (!clean || b.noise <= MAX_NOISE))
    .sort((a, b) => a.lum - b.lum);
  if (pal.length < 2) throw new Error("Palette too small: enable more block groups.");
  const lo = pal[0].lum, hi = pal[pal.length - 1].lum;
  pal.forEach((b, i) => (b.n = mode === "rank" ? i / (pal.length - 1) : (b.lum - lo) / (hi - lo || 1)));
  return pal;
}

function drawRamp(pal) {
  const r = $("ramp");
  r.innerHTML = "";
  pal.forEach(b => {
    const c = document.createElement("canvas");
    c.width = c.height = TILE;
    c.getContext("2d").drawImage(b.canvas, 0, 0);
    c.title = `${b.id} (${b.n.toFixed(2)})`;
    r.appendChild(c);
  });
}

// ---------- utils ----------
function hash(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------- head fetch ----------
class HeadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function fetchHead(name, refresh) {
  let r;
  try { r = await fetch(`/api/head?name=${encodeURIComponent(name)}${refresh ? "&refresh=1" : ""}`); }
  catch { throw new HeadError("server", "server unreachable"); }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new HeadError(j.error || "download", j.message || "skin could not be downloaded");
  }
  const url = URL.createObjectURL(await r.blob());
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  c.width = c.height = SRC;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, SRC, SRC);
  return { img, data: g.getImageData(0, 0, SRC, SRC).data };
}

// N×N luminance grid, nearest-neighbour upscale so skin pixels stay sharp. null = transparent.
function headLuma(skin, N) {
  const d = skin.data;
  return Array.from({ length: N * N }, (_, i) => {
    const sx = Math.floor((i % N) * SRC / N), sy = Math.floor(Math.floor(i / N) * SRC / N);
    const p = (sy * SRC + sx) * 4;
    return d[p + 3] < 128 ? null : lum(d[p], d[p + 1], d[p + 2]);
  });
}

// Zones: k-means (deterministic farthest-first init) over the 64 skin pixel colours.
// Returns a zone index per source pixel, zones sorted by brightness (0 = darkest).
function segmentSkin(skin, k) {
  const pts = [];
  for (let i = 0; i < SRC * SRC; i++) {
    const d = skin.data, p = i * 4;
    if (d[p + 3] >= 128) pts.push({ i, c: [d[p], d[p + 1], d[p + 2]], l: lum(d[p], d[p + 1], d[p + 2]) });
  }
  const labels = new Array(SRC * SRC).fill(-1);
  if (pts.length < 2) return { labels, zones: 1 };
  const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  k = Math.min(k, pts.length);
  const cent = [pts.reduce((m, p) => (p.l < m.l ? p : m)).c.slice()];
  while (cent.length < k) {
    let best = null, bd = -1;
    for (const p of pts) { const dd = Math.min(...cent.map(c => dist(c, p.c))); if (dd > bd) { bd = dd; best = p; } }
    if (bd < 300) break; // colours are nearly identical, use fewer zones
    cent.push(best.c.slice());
  }
  for (let it = 0; it < 12; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    for (const p of pts) {
      let bi = 0, bd = Infinity;
      cent.forEach((c, ci) => { const dd = dist(c, p.c); if (dd < bd) { bd = dd; bi = ci; } });
      p.z = bi; const s = sum[bi]; s[0] += p.c[0]; s[1] += p.c[1]; s[2] += p.c[2]; s[3]++;
    }
    sum.forEach((s, ci) => { if (s[3]) cent[ci] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
  }
  const meanL = cent.map((_, ci) => { const m = pts.filter(p => p.z === ci); return m.length ? m.reduce((a, p) => a + p.l, 0) / m.length : -1; });
  const order = meanL.map((l, ci) => [l, ci]).filter(a => a[0] >= 0).sort((a, b) => a[0] - b[0]).map(a => a[1]);
  for (const p of pts) labels[p.i] = order.indexOf(p.z);
  return { labels, zones: order.length };
}

// Per-pixel tone: each zone gets its own band of tones and its internal variation stays
// inside that band, so different zones end up with clearly different blocks.
function segmentedTones(skin, L8, k) {
  const { labels, zones } = segmentSkin(skin, k);
  const stats = Array.from({ length: zones }, () => ({ min: 1, max: 0 }));
  labels.forEach((z, i) => { if (z >= 0) { stats[z].min = Math.min(stats[z].min, L8[i]); stats[z].max = Math.max(stats[z].max, L8[i]); } });
  return labels.map((z, i) => {
    if (z < 0) return null;
    const { min, max } = stats[z], range = max - min;
    const rel = range > 0.005 ? (L8[i] - min) / range - 0.5 : 0;
    return (z + 0.5 + rel * 0.7 * Math.min(1, range / 0.3)) / zones;
  });
}

function blur3(v, N) {
  const o = new Array(v.length);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let s = 0, w = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
      const k = (dx === 0 && dy === 0) ? 2 : 1;
      s += v[yy * N + xx] * k; w += k;
    }
    o[y * N + x] = s / w;
  }
  return o;
}

// ---------- core algorithm ----------
// luminance -> per-head stretch -> equalize -> zone blend -> unsharp (edges/eyes) -> tone curve
// -> block choice (nearest + seeded variation, optional error diffusion)
function buildHead(name, skin, pal, opt) {
  const N = opt.size;
  const L = headLuma(skin, N);
  const vals = L.filter(v => v !== null).sort((a, b) => a - b);
  const pct = p => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 0;
  const lo = pct(0.02), hi = pct(0.98), span = hi - lo || 1, med = pct(0.5);

  let t = L.map(v => {
    v = v ?? med;
    const s = clamp((v - lo) / span);
    return clamp(s * opt.contrast + v * (1 - opt.contrast));
  });

  // equalize: spread the head's tones across the whole palette
  if (opt.equalize > 0) {
    const sorted = [...t].sort((a, b) => a - b);
    t = t.map(v => {
      const rank = (sorted.indexOf(v) + sorted.lastIndexOf(v)) / 2 / (sorted.length - 1);
      return v + opt.equalize * (rank - v);
    });
  }

  // segmentation: blend global tones with per-zone tones (skin, hair, eyes...)
  if (opt.segment > 0) {
    const L8 = headLuma(skin, SRC);
    const seg = segmentedTones(skin, L8, opt.zones);
    t = t.map((v, i) => {
      const sx = Math.floor((i % N) * SRC / N), sy = Math.floor(Math.floor(i / N) * SRC / N);
      const s = seg[sy * SRC + sx];
      return s === null ? v : v + opt.segment * (s - v);
    });
  }

  if (opt.edge > 0) {
    const b = blur3(t, N);
    const k = opt.edge * 2.2;
    t = t.map((v, i) => clamp(v + k * (v - b[i])));
  }
  if (opt.invert) t = t.map(v => 1 - v);
  if (opt.tones === "rushmore") t = t.map(v => 0.1 + 0.9 * Math.pow(v, 0.9));

  const rand = rng(hash(opt.seed + "|" + name));
  const tol = opt.variation * 0.1;
  const err = new Float32Array(N * N);
  const grid = Array.from({ length: N }, () => new Array(N));

  for (let y = 0; y < N; y++) {
    const ltr = !opt.dither || y % 2 === 0;
    for (let k = 0; k < N; k++) {
      const x = ltr ? k : N - 1 - k;
      const v = t[y * N + x] + (opt.dither ? err[y * N + x] : 0);
      let bd = Infinity;
      for (const b of pal) bd = Math.min(bd, Math.abs(b.n - v));
      const cand = [];
      pal.forEach((b, i) => { if (Math.abs(b.n - v) <= bd + tol) cand.push(i); });
      const pick = cand[Math.floor(rand() * cand.length)];
      grid[y][x] = pick;

      if (opt.dither) {
        const e = Math.max(-0.5, Math.min(0.5, v - pal[pick].n)), dir = ltr ? 1 : -1;
        const add = (xx, yy, w) => { if (xx >= 0 && xx < N && yy < N) err[yy * N + xx] += e * w; };
        add(x + dir, y, 7 / 16); add(x - dir, y + 1, 3 / 16); add(x, y + 1, 5 / 16); add(x + dir, y + 1, 1 / 16);
      }
    }
  }
  return grid;
}

function renderGrid(grid, pal, ctx, ox, oy) {
  ctx.imageSmoothingEnabled = false;
  grid.forEach((row, y) => row.forEach((i, x) => ctx.drawImage(pal[i].canvas, ox + x * TILE, oy + y * TILE)));
}

// ---------- UI ----------
function parseNames(txt) {
  const seen = new Set(), out = [];
  for (const raw of txt.split(/[\r\n,;]+/)) {
    const n = raw.replace(/#.*/, "").trim();
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  return out;
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function loadList() {
  try {
    const r = await fetch("/api/list");
    const { names } = await r.json();
    $("names").value = names.join("\n");
    $("status").textContent =     `list.txt: ${names.length} nicknames.`;
  } catch {
        $("status").textContent = "Server not reachable: run `node server.js` (list.txt and .litematic saving won't work without it).";
  }
}

async function saveLitematic(name, grid, pal, key) {
  const r = await fetch("/api/save", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, grid, blocks: pal.map(b => b.id), key }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
}

// Cache key: changes whenever the options, palette, skin or algorithm version change.
const ALGO_VERSION = 3;
function cacheKey(opt, pal, skin) {
  const s = ALGO_VERSION + JSON.stringify(opt) + pal.map(b => b.id).join(",") + skin.data.join(",");
  return hash(s).toString(36) + hash(s + "#").toString(36);
}

const ERR_LABEL = {
  not_found: "Nickname not found",
  download: "Skin could not be downloaded",
  invalid: "Invalid nickname",
  server: "Server unreachable",
};

function showSummary(s) {
  const el = $("summary");
  el.innerHTML = "";
  const line = (txt, cls) => { const p = document.createElement("p"); p.textContent = txt; if (cls) p.className = cls; el.appendChild(p); };
  line(`Generated ${s.ok} of ${s.total} · saved ${s.saved} · unchanged ${s.skipped} · errors ${s.errors.length}`);
  const groups = {};
  s.errors.forEach(e => (groups[e.code] ??= []).push(e));
  for (const [code, list] of Object.entries(groups))
    line(`${ERR_LABEL[code] || "Error"} (${list.length}): ${list.map(e => e.name).join(", ")}`, "bad");
  if (s.saveErr) line("Saving .litematic failed: " + s.saveErr, "bad");
  el.hidden = false;
}

async function generate() {
  const btn = $("go");
  btn.disabled = true; $("dlPng").disabled = $("dlJson").disabled = true;
  const out = $("out"); out.innerHTML = "";
  $("summary").hidden = true;
  const status = $("status");
  try {
    const names = parseNames($("names").value);
    if (!names.length) throw new Error("The list is empty.");
    const opt = {
      size: +$("size").value, tones: $("tones").value, edge: +$("edge").value,
      contrast: +$("contrast").value, variation: +$("variation").value, equalize: +$("equalize").value,
      segment: +$("segment").value, zones: +$("zones").value,
      dither: $("dither").checked, invert: $("inv").checked, seed: $("seed").value,
    };
    status.textContent = "Loading block textures…";
    const pal = await getPalette(opt.tones);
    drawRamp(pal);
    state.palette = pal;

    const autosave = $("autosave").checked, onlyChanged = $("onlyChanged").checked, refresh = $("refresh").checked;
    let manifest = {};
    if (autosave && onlyChanged) { try { manifest = await (await fetch("/api/manifest")).json(); } catch { /* no server, regenerate everything */ } }

    const results = new Array(names.length);
    const errors = [];
    let done = 0, saved = 0, skipped = 0, saveErr = null;
    await pool(names, 6, async (name, k) => {
      const card = document.createElement("div");
      card.className = "card";
      card.dataset.k = k;
      out.appendChild(card);
      try {
        if (!/^\w{1,16}$/.test(name)) throw new HeadError("invalid", "invalid nickname");
        const skin = await fetchHead(name, refresh);
        const grid = buildHead(name, skin, pal, opt);
        const c = document.createElement("canvas");
        c.width = c.height = opt.size * TILE;
        renderGrid(grid, pal, c.getContext("2d"), 0, 0);
        card.innerHTML = `<div class="row"><b></b><span></span></div>`;
        card.querySelector("b").textContent = name;
        card.querySelector("span").append(skin.img.cloneNode());
        card.insertBefore(c, card.firstChild);
        const dl = document.createElement("button");
        dl.textContent = "PNG";
        dl.onclick = () => c.toBlob(b => download(name + ".png", b));
        card.querySelector(".row").appendChild(dl);
        results[k] = { name, grid, canvas: c };
        if (autosave) {
          const key = cacheKey(opt, pal, skin);
          if (onlyChanged && manifest[name] === key) { skipped++; card.classList.add("same"); card.title = "unchanged: .litematic is already up to date"; }
          else {
            try { await saveLitematic(name, grid, pal, key); saved++; }
            catch (e) { saveErr = e.message; }
          }
        }
      } catch (e) {
        const code = e.code || "download";
        errors.push({ name, code, message: e.message });
        card.classList.add("err");
        card.textContent = `${name}: ${e.message}`;
      }
      status.textContent = `Heads: ${++done}/${names.length}`;
    });
    [...out.children].sort((a, b) => a.dataset.k - b.dataset.k).forEach(c => out.appendChild(c));

    const ok = results.filter(Boolean);
    showSummary({ total: names.length, ok: ok.length, saved, skipped, errors, saveErr });
    if (!ok.length) throw new Error("No heads were generated.");
    buildOutputs(ok, pal, opt);
    status.textContent =     `Done: ${ok.length}/${names.length} heads, ${pal.length} block types.`;
  } catch (e) {
        status.textContent = "Error: " + e.message;
  } finally { btn.disabled = false; }
}

function buildOutputs(ok, pal, opt) {
  const N = opt.size, PX = N * TILE;
  const cols = Math.max(1, Math.min(+$("cols").value || 4, ok.length));
  const rows = Math.ceil(ok.length / cols);
  const sheet = document.createElement("canvas");
  sheet.width = cols * PX; sheet.height = rows * PX;
  const g = sheet.getContext("2d");
  const heads = ok.map((r, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    g.drawImage(r.canvas, col * PX, row * PX);
    return { name: r.name, col, row, offsetBlocks: [col * N, row * N], grid: r.grid };
  });
  state.sheet = sheet;
  state.json = {
    version: 2, headSize: N, tileSize: TILE, columns: cols, rows,
    sizeBlocks: [cols * N, rows * N], options: opt,
    palette: pal.map((b, i) => ({ index: i, block: b.id, texture: b.tex, tone: +b.n.toFixed(4) })),
    heads,
  };
  $("dlPng").disabled = $("dlJson").disabled = false;
}

$("go").onclick = generate;
$("reload").onclick = loadList;
$("dlPng").onclick = () => state.sheet.toBlob(b => download("stone-faces.png", b));
$("dlJson").onclick = () => download("stone-faces.json", new Blob([JSON.stringify(state.json)], { type: "application/json" }));
for (const [id, out] of [["variation", "varOut"], ["contrast", "conOut"], ["edge", "edgeOut"], ["equalize", "eqOut"], ["segment", "segOut"]])
  $(id).oninput = e => ($(out).textContent = e.target.value);
loadList();
