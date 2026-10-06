// modules/estimate/stl.js — binary and ASCII STL -> the same facts shape
// modules/mesh3mf.js facts3mf() returns, through the same measure(). Pure.
// Fork module estimate (ryvin/u1hub).
//
// parseStlAsync yields to the event loop every YIELD_TRIS triangles (a 200 MB
// STL is four million triangles; the Hub keeps polling nine printers while it
// is read). A mesh wound inside-out is re-wound before measuring, so its top
// is not counted as an unsupported underside; a mesh with no volume (flat,
// open) is refused - it is not a model and must never be priced at 0 g.
"use strict";
const { measure } = require("../mesh3mf.js");
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const YIELD_TRIS = 50000;
const MIN_VOLUME_MM3 = 1e-3;
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const pct = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : 0;
const tick = () => new Promise(r => setImmediate(r));

// -> { kind: "binary", n } | { kind: "ascii" }; throws for neither.
function shapeOf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 15) throw new Error("not an STL (too short)");
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : -1;
  if (n >= 0 && 84 + n * 50 === buf.length) { if (!n) throw new Error("no triangles in the STL"); return { kind: "binary", n }; }
  const head = buf.toString("latin1", 0, Math.min(buf.length, 512)).trimStart();
  if (!/^solid/i.test(head)) {
    if (n > 0) throw new Error("binary STL truncated (header says " + n + " triangles, the file holds " + Math.max(0, Math.floor((buf.length - 84) / 50)) + ")");
    throw new Error("not an STL");
  }
  return { kind: "ascii" };
}
function finish(verts, nt) {
  if (!nt) throw new Error("no triangles in the STL");
  const tris = new Uint32Array(nt * 3);
  for (let i = 0; i < nt * 3; i++) tris[i] = i;
  return { verts, tris };
}
async function parseStlAsync(buf) {
  const sh = shapeOf(buf);
  if (sh.kind === "binary") {
    const n = sh.n, verts = new Float64Array(n * 9);
    for (let i = 0; i < n; i++) {
      let o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++, o += 4) verts[i * 9 + k] = buf.readFloatLE(o);
      if (i % YIELD_TRIS === YIELD_TRIS - 1) await tick();
    }
    return finish(verts, n);
  }
  const text = buf.toString("latin1");
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const v = [];
  let c = 0;
  for (let m; (m = re.exec(text));) { v.push(+m[1], +m[2], +m[3]); if (++c % (YIELD_TRIS * 3) === 0) await tick(); }
  const nt = Math.floor(v.length / 9);
  return finish(Float64Array.from(v.slice(0, nt * 9)), nt);
}
// The synchronous form, for small inputs and the tests of refusals.
function parseStl(buf) {
  const sh = shapeOf(buf);
  if (sh.kind === "binary") {
    const verts = new Float64Array(sh.n * 9);
    for (let i = 0; i < sh.n; i++) { let o = 84 + i * 50 + 12; for (let k = 0; k < 9; k++, o += 4) verts[i * 9 + k] = buf.readFloatLE(o); }
    return finish(verts, sh.n);
  }
  const text = buf.toString("latin1"), re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g, v = [];
  for (let m; (m = re.exec(text));) v.push(+m[1], +m[2], +m[3]);
  const nt = Math.floor(v.length / 9);
  return finish(Float64Array.from(v.slice(0, nt * 9)), nt);
}
// Signed volume (mm3) of the mesh as wound; negative = normals point inward.
function signedVolume(mesh) {
  const { verts: V, tris: T } = mesh;
  let vol = 0;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    vol += (V[a] * (V[b + 1] * V[c + 2] - V[b + 2] * V[c + 1]) - V[a + 1] * (V[b] * V[c + 2] - V[b + 2] * V[c]) + V[a + 2] * (V[b] * V[c + 1] - V[b + 1] * V[c])) / 6;
  }
  return vol;
}

async function factsStl(buf, name) {
  const t0 = Date.now();
  const mesh = await parseStlAsync(buf);
  const sv = signedVolume(mesh);
  if (!(Math.abs(sv) >= MIN_VOLUME_MM3)) throw new Error("not a closed solid (the mesh has no volume) - check the STL is watertight");
  if (sv < 0) for (let t = 0; t < mesh.tris.length; t += 3) { const x = mesh.tris[t + 1]; mesh.tris[t + 1] = mesh.tris[t + 2]; mesh.tris[t + 2] = x; }
  await tick();
  const s = await measure(mesh, IDENTITY);
  const w = s.maxx - s.minx, d = s.maxy - s.miny, h = s.maxz - s.minz;
  const footprint = Math.max(w * d, 1e-9);
  return {
    ok: true, truncated: false, bytes: buf.length, ms: Date.now() - t0, rewound: sv < 0,
    instances: 1, meshes: 1, triangles: s.tris,
    size_mm: [r1(w), r1(d), r1(h)], height_mm: r1(h), footprint_cm2: r1(footprint / 100),
    volume_cm3: r2(s.volume / 1000), area_cm2: r1(s.area / 100), solid_g_pla: r1(s.volume / 1000 * 1.24),
    overhang: { steep_pct: pct(s.steep, s.area), flat_unsupported_pct: pct(s.flat, s.area), mild_pct: pct(s.mild, s.area),
                bed_contact_cm2: r1(s.flatBed / 100), bed_contact_pct_of_footprint: pct(s.flatBed, footprint), floating_instances: 0 },
    tallest: { height_mm: r1(h), base_mm: [r1(w), r1(d)], aspect: r1(h / Math.max(Math.min(w, d), 0.01)) },
    paint: { colors: 0, painted_tris: 0, painted_pct: 0 },
    parts: [{ name: name || null, copies: 1, size_mm: [r1(w), r1(d), r1(h)], volume_cm3: r2(s.volume / 1000) }],
    metadata: {}
  };
}
module.exports = { parseStl, parseStlAsync, factsStl, signedVolume, MIN_VOLUME_MM3 };
