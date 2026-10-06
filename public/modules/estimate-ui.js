// public/modules/estimate-ui.js — the Estimate tab. Fork module (ryvin/u1hub),
// injected only when features.estimate is on. Server half: modules/estimate.js.
"use strict";
(function () {
  if (window.HUB_FEATURES && window.HUB_FEATURES.estimate === false) return;
  function mount(el) { el.innerHTML = '<div class="estwrap"><h2 class="esth">Estimate</h2></div>'; }
  function onShow() {}
  window.HubModules.register("estimate", { tab: "Estimate", mount, onShow });
})();
