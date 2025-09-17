/* submit-flow.js — Clean path with UPSERT + server-side PDF (print.js)
 * - Single submit handler (capture phase) prevents other handlers from firing
 * - Builds the SAME canonical payload your API expects: { payload: ... }
 * - Upserts: PUT /api/inspections/:id when we already have an id, else POST /api/inspections
 * - Server-side PDF: POST /api/print with { filename, path: '/output.html?id=...', data: payload }
 * - Opens /pdf_viewer.html with a blob URL
 *
 * In new_inspection.html:
 *   <form id="inspectionForm" action="#" data-inspection-form>
 *   ...
 *   <script defer src="/assets/submit-flow.js"></script>
 *
 * Optional:
 *   <input type="hidden" id="inspection-id" name="inspectionId" />
 * If present, we read/write the inspection id here. We also mirror it in sessionStorage.__inspectionId
 */

(function () {
  // ---------- CONFIG ----------
  const CONFIG = {
    saveBase: "/api/inspections",
    printEndpoint: "/api/print",
    reportPath: (id) => `/output.html?id=${encodeURIComponent(id)}`,
    filenameFrom: (payload) => {
      const unit = (payload.unitNumber || "Unit").toString().replace(/[^\w\-]+/g, "_");
      const d = payload.inspectionDate || new Date().toISOString().slice(0,10);
      return `Schedule-4_Inspection_${unit}_${d}.pdf`;
    }
  };

  // ---------- Tiny progress overlay ----------
  const Progress = (() => {
    let el, textEl;
    function ensure() {
      if (el) return;
      el = document.createElement("div");
      el.id = "submit-progress-overlay";
      Object.assign(el.style, {
        position: "fixed", inset: "0", display: "none",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,.6)", backdropFilter: "blur(2px)", zIndex: "9999"
      });

      const box = document.createElement("div");
      Object.assign(box.style, {
        minWidth: "260px", maxWidth: "90vw", padding: "18px 20px",
        borderRadius: "14px", border: "1px solid rgba(255,255,255,.12)",
        background: "rgba(13,13,17,.95)", color: "white",
        font: "500 14px/1.3 Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        boxShadow: "0 10px 30px rgba(0,0,0,.35)", textAlign: "center"
      });

      const spinner = document.createElement("div");
      Object.assign(spinner.style, {
        width: "24px", height: "24px",
        border: "3px solid rgba(255,255,255,.15)",
        borderTopColor: "white", borderRadius: "50%",
        margin: "0 auto 10px", animation: "spin 1s linear infinite"
      });
      const style = document.createElement("style");
      style.textContent = "@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }";
      document.head.appendChild(style);

      textEl = document.createElement("div");
      textEl.textContent = "Working...";

      box.appendChild(spinner);
      box.appendChild(textEl);
      el.appendChild(box);
      document.body.appendChild(el);
    }
    function show(msg) { ensure(); textEl.textContent = msg || "Working..."; el.style.display = "flex"; document.documentElement.style.overflow="hidden"; }
    function update(msg) { ensure(); textEl.textContent = msg || textEl.textContent; }
    function hide() { if (!el) return; el.style.display="none"; document.documentElement.style.overflow=""; }
    function error(msg) { ensure(); textEl.textContent = msg || "An error occurred."; }
    return { show, update, hide, error };
  })();

  // ---------- Helpers ----------
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));
  const byId = (id) => document.getElementById(id);
  const valById = (id, def="") => { const el = byId(id); return el && "value" in el ? (el.value ?? def) : def; };
  const cleanNumberString = (v) => (v || "").toString().replace(/,/g, "");

  function getUnitSelect() {
    return byId("unit-select") || byId("unit") || byId("unitId") ||
           $('select[name="unit"]') || $('select[name="unitId"]');
  }
  function getUnitOtherInput() {
    return byId("unit-other") || $('input[name="unitOther"]') || $('input[name="unit-other"]') || $('input[data-unit-other]');
  }
  function getSignatureDataURL() {
    try { if (window.canvas && typeof window.canvas.toDataURL === "function") return window.canvas.toDataURL("image/png"); } catch(_){}
    const cand = byId("signature-canvas") || byId("signature") || $("#signature canvas") ||
                 $("canvas#signature") || $("canvas.signature") || $('[data-signature-canvas]');
    if (cand && typeof cand.toDataURL === "function") return cand.toDataURL("image/png");
    const hidden = byId("signature-data-url") || $('input[name="signatureDataURL"]');
    if (hidden && hidden.value) return hidden.value;
    return "";
  }
  function buildChecklist() {
    const out = {};
    $$(".option-boxes").forEach(group => {
      const label = group.getAttribute("data-name");
      const sel = group.querySelector(".option-box.selected");
      if (!label || !sel) return;
      const v = sel.dataset.value || "";
      if (v === "ok") out[label] = "pass";
      else if (v === "repaired") out[label] = "repair";
      else if (v === "na") out[label] = "na";
    });
    return out;
  }

  function getExistingInspectionId() {
    const fromHidden = byId("inspection-id")?.value?.trim();
    if (fromHidden) return fromHidden;
    try {
      const fromSession = sessionStorage.getItem("__inspectionId");
      if (fromSession) return fromSession;
    } catch(_) {}
    const fromQuery = new URLSearchParams(location.search).get("id");
    if (fromQuery) return fromQuery;
    return null;
  }

  function rememberInspectionId(id) {
    try { sessionStorage.setItem("__inspectionId", id); } catch(_) {}
    const hidden = byId("inspection-id");
    if (hidden) hidden.value = id;
  }

  async function saveInspection(payload) {
    // UPSERT: if we already have an id, try PUT first; else POST.
    const existingId = getExistingInspectionId();
    if (existingId) {
      const res = await fetch(`${CONFIG.saveBase}/${encodeURIComponent(existingId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ payload })
      });
      if (res.ok) {
        // Accept any common id shapes
        const j = await res.json().catch(() => ({}));
        const id = j.id || j.inspection_id || j.data?.id || existingId;
        return id;
      }
      // Fallback for APIs that don’t support PUT: try POST with id in body (server should upsert)
      if (res.status === 404 || res.status === 405 || res.status === 501) {
        const postRes = await fetch(CONFIG.saveBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ id: existingId, payload })
        });
        if (!postRes.ok) {
          const txt = await postRes.text().catch(() => "");
          throw new Error(`Save failed (${postRes.status}) ${txt}`);
        }
        const pj = await postRes.json().catch(() => ({}));
        const pid = pj.id || pj.inspection_id || pj.data?.id || existingId;
        return pid;
      }
      const txt = await res.text().catch(() => "");
      throw new Error(`Update failed (${res.status}) ${txt}`);
    }

    // No existing id → POST (create)
    const createRes = await fetch(CONFIG.saveBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ payload })
    });
    if (!createRes.ok) {
      const txt = await createRes.text().catch(() => "");
      throw new Error(`Save failed (${createRes.status}) ${txt}`);
    }
    const cj = await createRes.json().catch(() => ({}));
    const id = cj.id || cj.inspection_id || cj.data?.id || cj.upsertedId || cj.result?.id;
    if (!id) throw new Error("Save succeeded but no inspection id was returned.");
    return id;
  }

  async function requestServerPdf({ filename, path, data }) {
    const res = await fetch(CONFIG.printEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ filename, path, data })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`PDF generation failed (${res.status}) ${txt}`);
    }
    return await res.blob();
  }

  function install() {
    const form = document.querySelector("form[data-inspection-form]") || document.querySelector("form");
    if (!form || form.dataset.submitFlowInstalled === "1") return;
    form.dataset.submitFlowInstalled = "1";

    // Attach in CAPTURE phase; prevent any other submit handlers
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      try {
        Progress.show("Saving...");

        // Build canonical payload (mirrors your previous inline code)
        const unitSelect = getUnitSelect();
        const unitOtherInput = getUnitOtherInput();
        const selectedVehicleId =
          (unitSelect && unitSelect.value && unitSelect.value !== "other")
            ? String(unitSelect.value)
            : null;

        let signatureSource = "drawn";
        try { const ss = sessionStorage.getItem("__signatureSource"); if (ss) signatureSource = ss; } catch(_){}

        const unitNumber =
          (unitSelect && unitSelect.value && unitSelect.value !== "other")
            ? (unitSelect.options[unitSelect.selectedIndex]?.textContent || "")
            : (unitOtherInput ? unitOtherInput.value || "" : "");

        const payload = {
          samsaraVehicleId: selectedVehicleId,
          signatureSource,
          carrierName: valById("carrier"),
          locationAddress: valById("address"),
          unitNumber,
          licensePlate: valById("license-plate"),
          odometer: cleanNumberString(valById("odometer")),
          inspectionDate: valById("inspection-date"),
          dateExpires: valById("expiry-date"),
          odometerExpires: cleanNumberString(valById("expiry-odometer")),

          rSteerBrake: valById("r-steer"),
          rDriveBrake: valById("r-drive"),
          rTagBrake:   valById("r-tag"),
          lSteerBrake: valById("l-steer"),
          lDriveBrake: valById("l-drive"),
          lTagBrake:   valById("l-tag"),

          tireSize: valById("tire-size"),
          repairs: valById("repairs-notes"),
          inspectorName: valById("inspector-name"),

          odometerSource: (window._odometerSource ?? valById("odometer-source") ?? ""),
          samsaraOdometerKm: (window._samsaraOdometerKm ?? (function(){ const v = valById("samsara-odometer-km"); return v ? Number(v) : null; })()),

          signature: getSignatureDataURL(),
          checklist: buildChecklist()
        };

        // Save (create or update)
        const inspectionId = await saveInspection(payload);
        rememberInspectionId(inspectionId);

        // Server-side PDF via /api/print (your puppeteer function)
        Progress.update("Generating PDF...");
        const filename = CONFIG.filenameFrom(payload);
        const path = CONFIG.reportPath(inspectionId); // e.g., /output.html?id=...
        const pdfBlob = await requestServerPdf({ filename, path, data: payload });

        // Open viewer with blob URL
        Progress.update("Opening PDF...");
        const objectUrl = URL.createObjectURL(pdfBlob);
        const viewerUrl = `/pdf_viewer.html?src=${encodeURIComponent(objectUrl)}&filename=${encodeURIComponent(filename)}&id=${encodeURIComponent(inspectionId)}`;
        window.open(viewerUrl, "_blank", "noopener");
        setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch {} }, 10 * 60 * 1000);

        Progress.hide();
      } catch (err) {
        console.error(err);
        Progress.error("Error: " + (err && err.message ? err.message : "Unexpected error."));
        setTimeout(() => Progress.hide(), 6000);
      }
    }, true); // capture=true
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
