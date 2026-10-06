// modules/estimate/stl.js — binary and ASCII STL -> the same facts shape
// modules/mesh3mf.js facts3mf() returns, through the same measure(). Pure.
// Fork module estimate (ryvin/u1hub).
"use strict";
const { measure } = require("../mesh3mf.js");
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
const pct = (a, b) => b > 0 ? Math.round(a / b * 1000) / 10 : 0;

// A binary STL is exactly 84 + 50n bytes; an ASCII one starts "solid".
function parseStl(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 15) throw new Error("not an STL (too short)");
  const n = buf.length >= 84 ? buf.readUInt32LE(80) : -1;
  if (n >= 0 && 84 + n * 50 === buf.length) {
    if (!n) throw new Error("no triangles in the STL");
    const verts = new Float64Array(n * 9), tris = new Uint32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++, o += 4) verts[i * 9 + k] = buf.readFloatLE(o);
      tris[i * 3] = i * 3; tris[i * 3 + 1] = i * 3 + 1; tris[i * 3 + 2] = i * 3 + 2;
    }
    return { verts, tris };
  }
  const head = buf.toString("latin1", 0, Math.min(buf.length, 512)).trimStart();
  if (!/^solid/i.test(head)) {
    if (n > 0) throw new Error("binary STL truncated (header says " + n + " triangles, the file holds " + Math.max(0, Math.floor((buf.length - 84) / 50)) + ")");
    throw new Error("not an STL");
  }
  const text = buf.toString("latin1");
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const v = [];
  for (let m; (m = re.exec(text));) v.push(+m[1], +m[2], +m[3]);
  const nt = Math.floor(v.length / 9);
  if (!nt) throw new Error("no triangles in the STL");
  const tris = new Uint32Array(nt * 3); for (let i = 0; i < nt * 3; i++) tris[i] = i;
  return { verts: Float64Array.from(v.slice(0, nt * 9)), tris };
}

async function factsStl(buf, name) {
  const t0 = Date.now();
  const s = await measure(parseStl(buf), IDENTITY);
  const w = s.maxx - s.minx, d = s.maxy - s.miny, h = s.maxz - s.minz;
  const footprint = Math.max(w * d, 1e-9);
  return {
    ok: true, truncated: false, bytes: buf.length, ms: Date.now() - t0,
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
module.exports = { parseStl, factsStl };
