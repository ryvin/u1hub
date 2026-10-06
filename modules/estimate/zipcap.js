// modules/estimate/zipcap.js — a 3MF (zip) opened with limits, for files a
// person uploaded. The Hub's own readers (models.js zipOpen, slicing.js
// zipEntryContent) trust the archive: inflateRawSync, no output cap. An upload
// is not trusted: a 900 KB 3MF can declare small entries that inflate to
// gigabytes and freeze the Hub for seconds (final review, 2026-10-06).
//   content(e)  async inflate (thread pool) with maxOutputLength = cap
//   tail(e, n)  streams the entry and keeps only its last n bytes (an embedded
//               plate gcode's totals live at its end; a 300 MB plate never sits
//               in memory)
// Same { entries, content, close } shape as zipOpen, so facts3mf / slicedFrom
// take it unchanged. Fork module estimate (ryvin/u1hub).
"use strict";
const fs = require("fs"), zlib = require("zlib"), { promisify } = require("util");
const { zipOpen } = require("../models.js");
const inflateRaw = promisify(zlib.inflateRaw);
const LOCAL_SIG = 0x04034b50;

async function openCapped(fp, opts) {
  const cap = Math.max(1, Number((opts || {}).cap) || 200 * 1048576);
  const mb = Math.round(cap / 1048576 * 10) / 10;
  const z = await zipOpen(fp);
  let fh;
  try { fh = await fs.promises.open(fp, "r"); } catch (e) { await z.close().catch(() => {}); throw e; }
  const over = e => new Error(e.name + " is over the " + mb + " MB limit for one entry");
  async function dataOffset(e) {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, e.lho);
    if (lh.readUInt32LE(0) !== LOCAL_SIG) throw new Error("local header corrupt for " + e.name);
    return e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  }
  async function content(e) {
    if (e.usize > cap) throw over(e);
    const off = await dataOffset(e);
    const raw = Buffer.alloc(e.csize);
    await fh.read(raw, 0, e.csize, off);
    if (e.method === 0) { if (raw.length > cap) throw over(e); return raw; }
    if (e.method !== 8) throw new Error("unsupported zip method " + e.method + " on " + e.name);
    try { return await inflateRaw(raw, { maxOutputLength: cap }); }
    catch (err) { if (err && (err.code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError)) throw over(e); throw err; }
  }
  async function tail(e, n) {
    const keep = Math.max(1, n | 0);
    const off = await dataOffset(e);
    if (e.method === 0) {
      const len = Math.min(keep, e.csize), b = Buffer.alloc(len);
      await fh.read(b, 0, len, off + e.csize - len);
      return b;
    }
    if (e.method !== 8) throw new Error("unsupported zip method " + e.method + " on " + e.name);
    if (!e.csize) return Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const src = fs.createReadStream(fp, { start: off, end: off + e.csize - 1 });
      const inf = zlib.createInflateRaw();
      inf.on("data", d => { buf = buf.length + d.length <= keep ? Buffer.concat([buf, d]) : Buffer.concat([buf, d]).subarray(-keep); });
      inf.on("end", () => resolve(Buffer.from(buf)));
      inf.on("error", reject); src.on("error", reject);
      src.pipe(inf);
    });
  }
  return { entries: z.entries, size: z.size, content, tail, close: async () => { await z.close().catch(() => {}); await fh.close().catch(() => {}); } };
}
module.exports = { openCapped };
