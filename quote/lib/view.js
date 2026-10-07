"use strict";
// The second allow-list (defence in depth): must equal modules/estimate/quote.js VIEW_FIELDS (the suite checks).
const FIELDS = Object.freeze(["status", "phase", "error", "confidence", "price", "price_low", "price_high", "each", "qty", "material", "colour", "colour_changed", "quality", "rush",
  "ready_by", "valid_until", "multicolour", "fits", "notes_from_owner", "final_price", "limits", "files_deleted"]);
function clean(b) { const out = {}; if (b && typeof b === "object") for (const k of FIELDS) if (b[k] !== undefined) out[k] = b[k]; return out; }
module.exports = { FIELDS, clean };
