"use strict";
// Dependency-free local server: serves the web app, reads list.txt and writes .litematic files.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildLitematic } = require("./litematic");

const ROOT = __dirname;
const OUT = path.join(ROOT, "schematics");
const PORT = +process.env.PORT || 3000;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const STATIC = new Set(["index.html", "app.js", "blocks.js", "style.css"]);

function readList() {
  let f = path.join(ROOT, "list.txt");
  if (!fs.existsSync(f)) f = path.join(ROOT, "list.example.txt");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split(/\r?\n/)
    .map(l => l.replace(/#.*/, "").trim()).filter(Boolean);
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// manifest: nickname -> key of the settings used for its last .litematic
const MANIFEST = path.join(OUT, "manifest.json");
function readManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return {}; }
}
function liveManifest() {
  const m = readManifest(), out = {};
  for (const [n, k] of Object.entries(m)) if (fs.existsSync(path.join(OUT, n + ".litematic"))) out[n] = k;
  return out;
}

// skins: check the nickname against Mojang, cache the result on disk
const HEADS = path.join(ROOT, "cache", "heads");
const HEAD_TTL = 24 * 3600 * 1000;
const isPng = b => b.length > 8 && b.readUInt32BE(0) === 0x89504e47;

async function fetchBuf(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function getHead(name, refresh) {
  const file = path.join(HEADS, name.toLowerCase() + ".png");
  if (!refresh && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < HEAD_TTL) return fs.readFileSync(file);

  let uuid;
  try {
    const r = await fetch("https://api.mojang.com/users/profiles/minecraft/" + name, { signal: AbortSignal.timeout(10000) });
    if (r.status === 404 || r.status === 204) { const e = new Error("nickname not found"); e.code = "not_found"; throw e; }
    if (!r.ok) throw new Error("Mojang HTTP " + r.status);
    uuid = (await r.json()).id;
  } catch (e) {
    if (e.code) throw e;
    if (fs.existsSync(file)) return fs.readFileSync(file); // fall back to an expired cache entry
    const err = new Error("could not verify nickname (" + e.message + ")"); err.code = "download"; throw err;
  }

  const sources = [`https://minotar.net/helm/${uuid}/8.png`, `https://mc-heads.net/avatar/${uuid}/8`];
  let last;
  for (const s of sources) {
    try {
      const b = await fetchBuf(s);
      if (!isPng(b)) throw new Error("response is not a PNG");
      fs.mkdirSync(HEADS, { recursive: true });
      fs.writeFileSync(file, b);
      return b;
    } catch (e) { last = e; }
  }
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const err = new Error("skin could not be downloaded (" + last.message + ")"); err.code = "download"; throw err;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/api/list") return send(res, 200, { names: readList() });
  if (req.method === "GET" && url.pathname === "/api/manifest") return send(res, 200, liveManifest());

  if (req.method === "GET" && url.pathname === "/api/head") {
    const name = url.searchParams.get("name") || "";
    if (!/^\w{1,16}$/.test(name)) return send(res, 400, { error: "invalid", message: "invalid nickname" });
    try {
      return send(res, 200, await getHead(name, url.searchParams.has("refresh")), "image/png");
    } catch (e) {
      return send(res, e.code === "not_found" ? 404 : 502, { error: e.code || "download", message: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/save") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const { name, grid, blocks, key } = JSON.parse(Buffer.concat(chunks));
        if (!/^\w{1,16}$/.test(name)) throw new Error("invalid name");
        if (!Array.isArray(grid) || !grid.length || !Array.isArray(blocks)) throw new Error("invalid data");
        if (!blocks.every(b => /^minecraft:[a-z_]+$/.test(b))) throw new Error("invalid block");
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, name + ".litematic"), buildLitematic({ name, grid, blocks }));
        if (typeof key === "string") fs.writeFileSync(MANIFEST, JSON.stringify({ ...readManifest(), [name]: key }, null, 1));
        send(res, 200, { ok: true, file: `schematics/${name}.litematic` });
      } catch (e) { send(res, 400, { ok: false, error: e.message }); }
    });
    return;
  }

  if (req.method === "GET") {
    const f = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (STATIC.has(f)) {
      try { return send(res, 200, fs.readFileSync(path.join(ROOT, f)), MIME[path.extname(f)]); }
      catch { return send(res, 404, { error: f + " not found" }); }
    }
  }
  send(res, 404, { error: "not found" });
}).listen(PORT, "127.0.0.1", () => console.log(`Stone Faces: http://localhost:${PORT}`));
