"use strict";
// Which peer may tell us the visitor's address. CF-Connecting-IP is a header
// anyone can send; it is the visitor's address only when the connection comes
// from the Cloudflare tunnel itself. The service shares a Docker network with
// other containers, so "TRUST_CF=1" alone would let any of them pick its own
// rate-limit bucket. TRUSTED_PROXY lists the peers allowed to set it: IPs,
// CIDRs, or hostnames (a container name on the Docker network), the hostnames
// re-resolved every minute because a container's address changes when it is
// recreated. An empty list trusts nobody.
const net = require("net"), dns = require("dns");
const REFRESH_MS = 60000;

// "::ffff:10.1.2.3" -> ["10.1.2.3", "ipv4"]; anything that is not an IP -> null
function norm(addr) {
  let a = String(addr || "").trim();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (m) a = m[1];
  const v = net.isIP(a);
  return v ? [a, v === 4 ? "ipv4" : "ipv6"] : null;
}

function createProxyCheck(list, o) {
  const lookup = (o && o.lookup) || (name => dns.promises.lookup(name, { all: true }));
  const fixed = new net.BlockList(), hosts = [];
  let any = false;
  for (const raw of list || []) {
    const e = String(raw || "").trim();
    if (!e) continue;
    any = true;
    const slash = e.indexOf("/");
    if (slash >= 0) {
      const ip = norm(e.slice(0, slash)), bits = Number(e.slice(slash + 1));
      const max = ip && ip[1] === "ipv4" ? 32 : 128;
      if (!ip || !Number.isInteger(bits) || bits < 0 || bits > max) throw new Error("TRUSTED_PROXY: bad CIDR " + e);
      fixed.addSubnet(ip[0], bits, ip[1]);
    } else if (norm(e)) { const ip = norm(e); fixed.addAddress(ip[0], ip[1]); }
    else if (/^[a-z0-9][a-z0-9_.-]*$/i.test(e)) hosts.push(e);
    else throw new Error("TRUSTED_PROXY: not an IP, CIDR or hostname: " + e);
  }
  let resolved = new Set();
  async function refresh() {
    const next = new Set();
    for (const h of hosts) {
      try { for (const r of await lookup(h)) { const ip = norm(r.address); if (ip) next.add(ip[0]); } }
      catch {}   // not resolvable right now: that host is simply not trusted until it is
    }
    resolved = next;
  }
  const ready = hosts.length ? refresh() : Promise.resolve();
  let timer = null;
  if (hosts.length && !(o && o.noTimer)) { timer = setInterval(() => { refresh(); }, REFRESH_MS); if (timer.unref) timer.unref(); }
  function trusted(addr) {
    const ip = norm(addr);
    if (!ip) return false;
    return fixed.check(ip[0], ip[1]) || resolved.has(ip[0]);
  }
  return { trusted, ready, refresh, any, hosts: hosts.slice() };
}
module.exports = { createProxyCheck, norm };
