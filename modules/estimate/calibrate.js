// modules/estimate/calibrate.js — grams -> minutes, per profile family and
// colour mode, as a trimmed log-log fit minutes = a * grams^b; and the scalar
// k that brings geometry grams in line with sliced grams. Pure. Defaults are
// the fits measured on this library's gcode on 2026-10-06 (spec §7a: a linear
// fit missed by a median 43 %; adding height did not help).
// Fork module estimate (ryvin/u1hub).
"use strict";
const MIN_N = 20;
const DEFAULT_FITS = Object.freeze({
  "standard-single": { a: 4.810, b: 0.836, n: 110, err: 0.33 },
  "standard-multi":  { a: 6.403, b: 0.840, n: 231, err: 0.29 },
  "hueforge-multi":  { a: 14.619, b: 0.742, n: 45, err: 0.24 },
  "flexi-multi":     { a: 18.683, b: 0.736, n: 10, err: 0.06 }
});
const median = xs => { const s = xs.slice().sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
function familyOf(ps) { const s = String(ps || "").toLowerCase(); return /hueforge/.test(s) ? "hueforge" : /flexi/.test(s) ? "flexi" : /display|box/.test(s) ? "display" : "standard"; }
function fitPower(points) {
  const P = (points || []).filter(([g, m]) => g > 0 && m > 0 && m / g > 0.3 && m / g < 30);
  const n = P.length; if (n < 2) return null;
  const X = P.map(p => Math.log(p[0])), Y = P.map(p => Math.log(p[1]));
  const mx = X.reduce((a, b) => a + b, 0) / n, my = Y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx, a = Math.exp(my - b * mx);
  return { a, b, n, err: median(P.map(([g, m]) => Math.abs(a * Math.pow(g, b) - m) / m)) };
}
function fitFor(fits, family, mode) {
  const key = family + "-" + mode, live = (fits || {})[key];
  if (live && live.n >= MIN_N) return { ...live, key, source: "fit" };
  if (DEFAULT_FITS[key]) return { ...DEFAULT_FITS[key], key, source: "default" };
  const fb = "standard-" + mode, lf = (fits || {})[fb];
  return { ...(lf && lf.n >= MIN_N ? lf : DEFAULT_FITS[fb]), key: fb, source: "fallback" };
}
const minutesFrom = (grams, fit) => grams > 0 && fit ? Math.round(fit.a * Math.pow(grams, fit.b)) : null;
function fitK(pairs) {
  const P = (pairs || []).filter(([p, a]) => p > 0 && a > 0);
  if (!P.length) return null;
  const k = Math.round(median(P.map(([p, a]) => a / p)) * 1000) / 1000;
  return { k, n: P.length, err: Math.round(median(P.map(([p, a]) => Math.abs(p * k - a) / a)) * 1000) / 1000 };
}
module.exports = { DEFAULT_FITS, MIN_N, fitPower, familyOf, fitFor, minutesFrom, fitK, median };
