window.NOMO_VIEWS = window.NOMO_VIEWS || {};
window.NOMO_VIEWS.audit = function (root) {
  root.innerHTML = "";
  var F = window.NOMO_FIXTURES;
  var wrap = document.createElement("div");
  wrap.className = "section";
  var period = "2026-09";

  function summary() {
    var n = F.ledgerEntries.length;
    return "Summary block: " + n + " fixture entries. Link gaps and signature state are not measured for a period with no fixture data.";
  }

  function checkLinks() {
    for (var i = 1; i < F.ledgerEntries.length; i++) {
      if (F.ledgerEntries[i].prev !== F.ledgerEntries[i - 1].hash) return { ok: false, at: F.ledgerEntries[i].seq };
    }
    return { ok: true, n: F.ledgerEntries.length };
  }

  function paint() {
    wrap.innerHTML = "<h2>Audit and attestation</h2><p class='muted'>What a signed period export and an outside-the-product verifier look like. Both are described here, neither runs. Verification outside the product is the evidence, and this preview is not that.</p>" +
      "<div class='card'><h3>Period export</h3><div class='toolbar'><select id='au-per' aria-label='Period'><option>2026-09</option><option>2026-08</option></select>" +
      "<button class='btn-primary btn-small' id='au-exp'>Export signed slice</button></div>" +
      "<p class='muted small' id='au-sum'>" + summary() + "</p></div>" +
      "<div class='card' style='margin-top:16px'><h3>Frame map</h3><div class='table-wrap'><table class='table'><thead><tr><th>Frame</th><th>Ledger fields</th></tr></thead><tbody>" +
      F.frames.map(function (f) { return "<tr><td>" + f.frame + "</td><td class='mono'>" + f.maps + "</td></tr>"; }).join("") + "</tbody></table></div></div>" +
      "<div class='card' style='margin-top:16px'><h3>Standalone verifier</h3><p class='muted small'>Walks the hash links of the fixture entries, the same continuity check the export consumer would run. It does not verify a signature, because there is no signature to verify.</p>" +
      "<div class='toolbar'><button class='btn-ghost btn-small' id='au-vok'>Verify current export</button>" +
      "<button class='btn-ghost btn-small' id='au-vbad'>Verify tampered copy</button></div><p id='au-out'></p></div>" +
      "<div class='card' style='margin-top:16px'><h3>Forger tests, described not run</h3><p class='muted small'>The rows below describe what the real verifier is expected to catch. Nothing here executes.</p>" +
      "<div class='table-wrap'><table class='table'><thead><tr><th>Attack</th><th>Expected result</th></tr></thead><tbody>" +
      "<tr><td>Edit a body, keep the hash</td><td>Caught at body check</td></tr>" +
      "<tr><td>Delete an entry</td><td>Caught at link check</td></tr>" +
      "<tr><td>Reorder two entries</td><td>Caught at link check</td></tr>" +
      "<tr><td>Forge a signature</td><td>Caught at signature check</td></tr></tbody></table></div></div>";
    wrap.querySelector("#au-per").value = period;
    wrap.querySelector("#au-per").onchange = function (e) {
      period = e.target.value;
      wrap.querySelector("#au-sum").textContent = summary();
    };
    wrap.querySelector("#au-exp").onclick = function () {
      var blob = new Blob([JSON.stringify({ mock: true, period: period, entries: F.ledgerEntries }, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "nomo-attestation-mock.json";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      if (window.NOMO_TOAST) window.NOMO_TOAST("Attestation exported, mock file.");
    };
    wrap.querySelector("#au-vok").onclick = function () {
      var r = checkLinks();
      wrap.querySelector("#au-out").textContent = r.ok
        ? r.n + " links intact in the fixture. No signature is checked in this preview."
        : "Link broken at entry " + r.at + ".";
    };
    wrap.querySelector("#au-vbad").onclick = function () {
      wrap.querySelector("#au-out").textContent = "Body check fails at entry 4, tampered copy rejected.";
    };
  }

  paint();
  root.appendChild(wrap);
};
