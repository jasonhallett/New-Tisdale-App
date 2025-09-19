/* submit-flow.js — POST-only + auto-retry create on 404 + DB-only render + server PDF (with fallback)
 * - Always POST /api/inspections (server handles create or update if id is present)
 * - If POST returns 404 "Inspection not found" while updating, clear the stale id and POST again to create
 * - Builds canonical payload + flat column map (aligned to DB) to reduce NULLs
 * - Explicitly sets odometer_source (manual/gps) so DB won't show 'unknown' when user typed it
 * - Tries PDF via /api/pdf/print (server puppeteer); if it fails, still opens viewer with all context (no src)
 */
(function () {
  const CONFIG = {
    saveBase: "/api/inspections",
    printEndpoint: "/api/pdf/print",
    // CHANGE: /api/pdf/print needs an ABSOLUTE URL, not a relative path
    reportUrl: (id) => `https://app.tisdale.coach/output.html?id=${encodeURIComponent(id)}`,
    filenameFrom: (payload) => {
      const unit = (payload.unitNumber || "Unit").toString().replace(/[^\w\-]+/g, "_");
      const d = payload.inspectionDate || new Date().toISOString().slice(0,10);
      return `Schedule-4_Inspection_${unit}_${d}.pdf`;
    }
  };

  // ---- Progress modal ----
  const Progress = (() => {
    let el, textEl;
    function ensure() {
      if (el) return;
      el = document.createElement("div");
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
      box.appendChild(spinner); box.appendChild(textEl);
      el.appendChild(box); document.body.appendChild(el);
    }
    const show = (m) => { ensure(); textEl.textContent = m || "Working..."; el.style.display = "flex"; document.documentElement.style.overflow="hidden"; };
    const update = (m) => { ensure(); textEl.textContent = m || textEl.textContent; };
    const hide = () => { if (!el) return; el.style.display="none"; document.documentElement.style.overflow=""; };
    const error = (m) => { ensure(); textEl.textContent = m || "An error occurred."; };
    return { show, update, hide, error };
  })();

  // ---- Helpers ----
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));
  const byId = (id) => document.getElementById(id);
  const valById = (id, def="") => { const el = byId(id); return el && "value" in el ? (el.value ?? def) : def; };
  const cleanNumberString = (v) => (v || "").toString().replace(/,/g, "");

  function findUnitElements() {
    const select = byId("unit-select") || byId("unit") || byId("unitId") || byId("unit-number-select")
                || $('select[name="unit"]') || $('select[name="unitId"]') || $('select[name="unit-number"]');
    const other = byId("unit-other") || $('input[name="unitOther"]') || $('input[name="unit-other"]') || $('input[data-unit-other]')
               || byId("unit-number") || $('input[name="unit"]') || $('input[name="unit_number"]') || $('input[name="unitNumber"]');
    return { select, other };
  }
  function getUnitNumber() {
    const { select, other } = findUnitElements();
    if (select && select.value && select.value !== "other") {
      const label = (select.options[select.selectedIndex]?.textContent || "").trim();
      return label || String(select.value);
    }
    if (other && other.value) return other.value.trim();
    const guess = $('input[id*="unit"]') || $('input[name*="unit"]');
    if (guess && guess.value) return guess.value.trim();
    return "";
  }
  function getSamsaraVehicleId() {
    const { select } = findUnitElements();
    if (select && select.value && select.value !== "other") return String(select.value);
    const hidden = byId("samsara-vehicle-id") || $('input[name="samsaraVehicleId"]');
    if (hidden && hidden.value) return String(hidden.value);
    return null;
  }
  function getSignatureDataURL() {
    const hidden = byId("signature-data-url") || $('input[name="signatureDataURL"]') || $('input[name="signature"]');
    if (hidden && hidden.value && hidden.value.startsWith("data:image/")) return hidden.value;
    const candidates = [
      byId("signature-canvas"),
      byId("signature"),
      $("#signature canvas"),
      $("canvas#signature"),
      $("canvas.signature"),
      $("#signature-pad canvas"),
      $('[data-signature-canvas]')
    ].filter(Boolean);
    $$("#signature canvas, canvas").forEach(c => candidates.push(c));
    let best = null, bestArea = 0;
    candidates.forEach(c => {
      try {
        const rect = c.getBoundingClientRect();
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);
        if (area > bestArea && typeof c.toDataURL === "function") { best = c; bestArea = area; }
      } catch(_) {}
    });
    if (best) {
      try { return best.toDataURL("image/png"); } catch(_) {}
    }
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

  function existingInspectionId() {
    const hid = byId("inspection-id")?.value?.trim();
    if (hid) return hid;
    try { const ss = sessionStorage.getItem("__inspectionId"); if (ss) return ss; } catch(_){}
    const q = new URLSearchParams(location.search).get("id");
    return q || null;
  }
  function clearExistingInspectionId() {
    try { sessionStorage.removeItem("__inspectionId"); } catch(_) {}
    const hidden = byId("inspection-id"); if (hidden) hidden.value = "";
  }
  function rememberInspectionId(id) {
    try { sessionStorage.setItem("__inspectionId", id); } catch(_){}
    const hidden = byId("inspection-id"); if (hidden) hidden.value = id;
    // also expose for viewer/fleetio
    window.__lastInspectionDbId = id;
  }

  // Build canonical payload + flat column map (aligned to DB)
  function makePayloadAndColumns() {
    const samsaraVehicleId = getSamsaraVehicleId();
    const unitNumber = getUnitNumber();
    let signatureSource = "drawn";
    try { const ss = sessionStorage.getItem("__signatureSource"); if (ss) signatureSource = ss; } catch(_){}

    const payload = {
      samsaraVehicleId,
      signatureSource,
      carrierName: valById("carrier"),
      locationAddress: valById("address"),
      unitNumber,
      licensePlate: valById("license-plate"),
      odometer: cleanNumberString(valById("odometer")),
      inspectionDate: valById("inspection-date"),
      dateExpires: valById("expiry-date"),
      odometerExpires: cleanNumberString(valById("expiry-odometer")),
      rSteerBrake: valById("r-steer"), rDriveBrake: valById("r-drive"), rTagBrake: valById("r-tag"),
      lSteerBrake: valById("l-steer"), lDriveBrake: valById("l-drive"), lTagBrake: valById("l-tag"),
      tireSize: valById("tire-size"),
      repairs: valById("repairs-notes"),
      inspectorName: valById("inspector-name"),
      odometerSource: (window._odometerSource ?? valById("odometer-source") ?? ""),
      samsaraOdometerKm: (window._samsaraOdometerKm ?? (function(){ const v = valById("samsara-odometer-km"); return v ? Number(v) : null; })()),
      signature: getSignatureDataURL(),
      checklist: buildChecklist()
    };

    // --- Ensure odometer source is explicit so server doesn't infer 'unknown' ---
    // If user typed an odometer and we do NOT have a Samsara reading, call it user_entered (maps to manual)
    if (payload.odometer && !payload.samsaraOdometerKm) {
      payload.odometerSource = 'user_entered';
    }
    // If Samsara reading is present and equals the odometer, mark as samsara/gps
    if (payload.samsaraOdometerKm && Number(payload.samsaraOdometerKm) === Number(payload.odometer || NaN)) {
      payload.odometerSource = 'samsara';
    }

    const cols = {
      carrier_name: payload.carrierName || null,
      location: payload.locationAddress || null,          // DB uses 'location'
      vehicle_name: payload.unitNumber || null,           // DB uses 'vehicle_name' for Unit #
      license_plate: payload.licensePlate || null,
      odometer_km: payload.odometer ? Number(payload.odometer) : null,
      inspection_date: payload.inspectionDate || null,
      expiry_date: payload.dateExpires || null,
      next_service_odometer_km: payload.odometerExpires ? Number(payload.odometerExpires) : null,
      notes: payload.repairs || null,
      // Populate DB enum directly for consistency with server mapping
      odometer_source: (payload.odometerSource === 'samsara' ? 'gps' :
                        payload.odometerSource === 'user_entered' ? 'manual' : null)
    };

    return { payload, columns: cols };
  }

  // ---- POST only; handle update-or-create via body.id; if 404 => create ----
  async function postInspection(bodyJson) {
    const res = await fetch(CONFIG.saveBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: bodyJson
    });
    const text = await res.text().catch(() => "");
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    return { ok: res.ok, status: res.status, data, text };
  }

  async function saveInspection(payload, columns) {
    const maybeId = existingInspectionId();
    const makeBody = (idOpt) => JSON.stringify({ payload, ...columns, id: idOpt || undefined });

    if (maybeId) {
      const first = await postInspection(makeBody(maybeId));
      if (first.ok) return first.data.id || maybeId;
      if (first.status === 404 && (first.data?.error || "").toLowerCase().includes("not found")) {
        Progress.update("Previous record not found. Creating a new one…");
        clearExistingInspectionId();
        const second = await postInspection(makeBody(undefined));
        if (!second.ok) throw new Error(`Save failed (${second.status}) ${second.text || ""}`);
        return second.data.id || second.data?.inspection_id;
      }
      throw new Error(`Save failed (${first.status}) ${first.text || ""}`);
    }

    const created = await postInspection(makeBody(undefined));
    if (!created.ok) throw new Error(`Save failed (${created.status}) ${created.text || ""}`);
    const newId = created.data.id || created.data?.inspection_id || created.data?.result?.id;
    if (!newId) throw new Error("Save succeeded but no inspection id was returned.");
    return newId;
  }

  // ---- Print via server (Puppeteer) ----
  // CHANGE: accept { url } and send { url } to the API
  async function requestServerPdf({ filename, url }) {
    const res = await fetch(CONFIG.printEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ filename, url })
    });
    if (!res.ok) throw new Error(`PDF generation failed (${res.status}) ${await res.text().catch(()=> "")}`);
    return await res.blob();
  }

  function buildViewerUrl({ id, filename, objectUrl, payload }) {
    // Carry all the context the viewer & Fleetio need
    const qs = new URLSearchParams({
      id: id || '',
      recordId: id || '',                           // so API updates by primary key
      filename: filename || '',
      src: objectUrl || '',                         // may be empty on fallback
      unit: payload.unitNumber || '',
      date: payload.inspectionDate || '',
      odometer: payload.odometer || ''
    });
    return `/pdf_viewer.html?${qs.toString()}`;
  }

  function install() {
    const form = document.querySelector("form[data-inspection-form]") || document.querySelector("form");
    if (!form || form.dataset.submitFlowInstalled === "1") return;
    form.dataset.submitFlowInstalled = "1";

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      try {
        Progress.show("Saving...");
        const { payload, columns } = makePayloadAndColumns();

        // 1) Save/Update DB
        const id = await saveInspection(payload, columns);
        rememberInspectionId(id);

        // 2) Try server-side PDF
        const filename = CONFIG.filenameFrom(payload);
        const url = CONFIG.reportUrl(id);   // CHANGE: absolute URL for the print route
        let objectUrl = null;

        Progress.update("Generating PDF...");
        try {
          const pdfBlob = await requestServerPdf({ filename, url }); // CHANGE: send url
          objectUrl = URL.createObjectURL(pdfBlob);
        } catch (err) {
          console.warn("Server PDF failed, continuing with viewer fallback:", err);
          // no objectUrl — viewer will still open and Fleetio attach will work via its own logic
        }

        // 3) Always open the viewer, even if server PDF failed
        Progress.update("Opening PDF...");
        const viewerUrl = buildViewerUrl({ id, filename, objectUrl, payload });
        window.open(viewerUrl, "_blank", "noopener");

        // release object URL later if we created one
        if (objectUrl) setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch {} }, 10 * 60 * 1000);

        Progress.hide();
      } catch (err) {
        console.error(err);
        Progress.error("Error: " + (err && err.message ? err.message : "Unexpected error."));
        setTimeout(() => Progress.hide(), 7000);
      }
    }, true); // capture=true
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
