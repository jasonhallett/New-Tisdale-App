/* submit-flow.js — Upsert + DB-only render + correct print route
 * - Single submit handler (capture phase) prevents other handlers
 * - Sends { payload, ...columnMap } to your API so column mappings fill (no more NULLs)
 * - Upserts to /api/inspections or /api/inspections/:id (PUT) if we have an id
 * - Generates PDF via your server function at /api/pdf/print (uses /output.html?id=...)
 */

(function () {
  // ---------- CONFIG ----------
  const CONFIG = {
    saveBase: "/api/inspections",
    // Use the route where your puppeteer file is deployed. Your error shows 404 on /api/print,
    // but your setup typically uses /api/pdf/print
    printEndpoint: "/api/pdf/print",
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
  function existingInspectionId() {
    const hid = byId("inspection-id")?.value?.trim();
    if (hid) return hid;
    try { const ss = sessionStorage.getItem("__inspectionId"); if (ss) return ss; } catch(_){}
    const q = new URLSearchParams(location.search).get("id");
    return q || null;
  }
  function rememberInspectionId(id) {
    try { sessionStorage.setItem("__inspectionId", id); } catch(_){}
    const hidden = byId("inspection-id"); if (hidden) hidden.value = id;
  }

  // Build canonical payload + flat column map (snake_case) for the API
  function makePayloadAndColumns() {
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

    // Flat map for SQL columns (adjust names to match your schema)
    const columns = {
      carrier_name: payload.carrierName || null,
      location_address: payload.locationAddress || null,
      unit_number: payload.unitNumber || null,
      license_plate: payload.licensePlate || null,
      odometer_km: payload.odometer ? Number(payload.odometer) : null,
      inspection_date: payload.inspectionDate || null,
      expiry_date: payload.dateExpires || null,
      odometer_expires_km: payload.odometerExpires ? Number(payload.odometerExpires) : null,

      r_steer_brake: payload.rSteerBrake || null,
      r_drive_brake: payload.rDriveBrake || null,
      r_tag_brake:   payload.rTagBrake || null,
      l_steer_brake: payload.lSteerBrake || null,
      l_drive_brake: payload.lDriveBrake || null,
      l_tag_brake:   payload.lTagBrake || null,

      tire_size: payload.tireSize || null,
      repairs_notes: payload.repairs || null,
      inspector_name: payload.inspectorName || null,

      odometer_source: payload.odometerSource || null,
      samsara_odometer_km: payload.samsaraOdometerKm ?? null,

      signature_png_dataurl: payload.signature || null,
      checklist_json: payload.checklist || {}
    };

    return { payload, columns };
  }

  async function saveInspection(payload, columns) {
    const id = existingInspectionId();
    const body = JSON.stringify({ payload, ...columns, id: id || undefined });

    if (id) {
      // Try PUT first
      const res = await fetch(`${CONFIG.saveBase}/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body
      });
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        return j.id || j.inspection_id || j.data?.id || id;
      }
      // Fallback: POST upsert
      if ([404,405,501].includes(res.status)) {
        const postRes = await fetch(CONFIG.saveBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body
        });
        if (!postRes.ok) throw new Error(`Save failed (${postRes.status}) ${await postRes.text().catch(()=> "")}`);
        const pj = await postRes.json().catch(() => ({}));
        return pj.id || pj.inspection_id || pj.data?.id || id;
      }
      throw new Error(`Update failed (${res.status}) ${await res.text().catch(()=> "")}`);
    }

    // Create
    const createRes = await fetch(CONFIG.saveBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body
    });
    if (!createRes.ok) throw new Error(`Save failed (${createRes.status}) ${await createRes.text().catch(()=> "")}`);
    const cj = await createRes.json().catch(() => ({}));
    const newId = cj.id || cj.inspection_id || cj.data?.id || cj.upsertedId || cj.result?.id;
    if (!newId) throw new Error("Save succeeded but no inspection id was returned.");
    return newId;
  }

  async function requestServerPdf({ filename, path }) {
    const res = await fetch(CONFIG.printEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ filename, path })
    });
    if (!res.ok) {
      throw new Error(`PDF generation failed (${res.status}) ${await res.text().catch(()=> "")}`);
    }
    return await res.blob();
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
        const id = await saveInspection(payload, columns);
        rememberInspectionId(id);

        Progress.update("Generating PDF...");
        const filename = CONFIG.filenameFrom(payload);
        const path = CONFIG.reportPath(id); // /output.html?id=...
        const pdfBlob = await requestServerPdf({ filename, path });

        Progress.update("Opening PDF...");
        const objectUrl = URL.createObjectURL(pdfBlob);
        const viewerUrl = `/pdf_viewer.html?src=${encodeURIComponent(objectUrl)}&filename=${encodeURIComponent(filename)}&id=${encodeURIComponent(id)}`;
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
