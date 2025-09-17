/* submit-flow.js — Path A (cleanest, single handler)
 * - Intercepts form submit (capture phase), prevents any other submit handlers
 * - Validates (lightly), constructs the SAME payload shape as your previous inline code
 * - POSTs to /api/inspections with body: { payload: ... }, credentials: 'include'
 * - Renders /output.html?id=... in a hidden iframe, converts to PDF, opens /pdf_viewer.html
 *
 * Usage in new_inspection.html (keep your existing id/action; just add the attribute):
 *   <form id="inspectionForm" action="#" data-inspection-form>
 *   ...
 *   <script defer src="/assets/submit-flow.js"></script>
 */

(function () {
  // ---------- CONFIG ----------
  const CONFIG = {
    saveEndpoint: "/api/inspections",
    reportUrl: (inspectionId) => `/output.html?id=${encodeURIComponent(inspectionId)}&mode=pdf`,
    filenameFrom: (payload) => {
      const unit = (payload.unitNumber || "Unit").toString().replace(/[^\w\-]+/g, "_");
      // prefer the explicit inspectionDate (already formatted on the page)
      const d = payload.inspectionDate || new Date().toISOString().slice(0,10);
      return `Schedule-4_Inspection_${unit}_${d}.pdf`;
    },
    pickPdfElement: (doc) => doc.querySelector("#page") || doc.body,
  };

  // ---------- Tiny progress overlay ----------
  const Progress = (() => {
    let el, textEl;
    function ensure() {
      if (el) return;
      el = document.createElement("div");
      el.id = "submit-progress-overlay";
      el.style.position = "fixed";
      el.style.inset = "0";
      el.style.display = "none";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.style.background = "rgba(0,0,0,.6)";
      el.style.backdropFilter = "blur(2px)";
      el.style.zIndex = "9999";

      const box = document.createElement("div");
      box.style.minWidth = "260px";
      box.style.maxWidth = "90vw";
      box.style.padding = "18px 20px";
      box.style.borderRadius = "14px";
      box.style.border = "1px solid rgba(255,255,255,.12)";
      box.style.background = "rgba(13,13,17,.95)";
      box.style.color = "white";
      box.style.font = "500 14px/1.3 Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      box.style.boxShadow = "0 10px 30px rgba(0,0,0,.35)";
      box.style.textAlign = "center";

      const spinner = document.createElement("div");
      spinner.style.width = "24px";
      spinner.style.height = "24px";
      spinner.style.border = "3px solid rgba(255,255,255,.15)";
      spinner.style.borderTopColor = "white";
      spinner.style.borderRadius = "50%";
      spinner.style.margin = "0 auto 10px";
      spinner.style.animation = "spin 1s linear infinite";
      box.appendChild(spinner);

      const style = document.createElement("style");
      style.textContent = "@keyframes spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }";
      document.head.appendChild(style);

      textEl = document.createElement("div");
      textEl.textContent = "Working...";
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

  function valById(id, def = "") { const el = byId(id); return el && "value" in el ? (el.value ?? def) : def; }
  function cleanNumberString(v) { return (v || "").toString().replace(/,/g, ""); }

  function getUnitSelect() {
    return byId("unit-select") || byId("unit") || byId("unitId") ||
           $('select[name="unit"]') || $('select[name="unitId"]');
  }
  function getUnitOtherInput() {
    return byId("unit-other") || $('input[name="unitOther"]') || $('input[name="unit-other"]') || $('input[data-unit-other]');
  }

  function getSignatureDataURL() {
    // Try known globals first (if your page already created them)
    try {
      if (window.canvas && typeof window.canvas.toDataURL === "function") {
        return window.canvas.toDataURL("image/png");
      }
    } catch(_) {}
    // Try common selectors
    const cand = byId("signature-canvas") || byId("signature") || $("#signature canvas") ||
                 $("canvas#signature") || $("canvas.signature") || $('[data-signature-canvas]');
    if (cand && typeof cand.toDataURL === "function") {
      return cand.toDataURL("image/png");
    }
    // Hidden input fallback (if you store it there)
    const hidden = byId("signature-data-url") || $('input[name="signatureDataURL"]');
    if (hidden && hidden.value) return hidden.value;

    // As a last resort return empty string; your server should reject if required
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

  async function dynamicLoadHtml2Pdf() {
    if (window.html2pdf) return;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js";
      s.crossOrigin = "anonymous";
      s.referrerPolicy = "no-referrer";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load html2pdf.js"));
      document.head.appendChild(s);
    });
  }

  function openHiddenIframe(src) {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement("iframe");
      iframe.style.position = "fixed";
      iframe.style.width = "0"; iframe.style.height = "0";
      iframe.style.border = "0"; iframe.style.opacity = "0";
      iframe.src = src;
      iframe.onload = () => resolve(iframe);
      iframe.onerror = () => reject(new Error("Failed to load report iframe."));
      document.body.appendChild(iframe);
    });
  }

  async function generatePdfBlobFromIframe(iframe, filename) {
    await dynamicLoadHtml2Pdf();
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("No access to iframe document.");
    const el = CONFIG.pickPdfElement(doc);
    if (!el) throw new Error("Report root element not found.");
    const options = {
      filename,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        logging: false,
        windowWidth: 816,   // Letter @ 96dpi
        windowHeight: 1056,
      },
      jsPDF: { unit: "pt", format: "letter", orientation: "portrait" }
    };
    const blob = await window.html2pdf().set(options).from(el).outputPdf("blob");
    return blob;
  }

  function install() {
    const form = document.querySelector("form[data-inspection-form]") || document.querySelector("form");
    if (!form || form.dataset.submitFlowInstalled === "1") return;
    form.dataset.submitFlowInstalled = "1";

    // Attach in CAPTURE phase; stop other handlers from running
    form.addEventListener("submit", async (e) => {
      // Stop any other listeners (including the old inline one)
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      try {
        Progress.show("Saving...");

        // --- Build canonical payload (same keys as your previous inline code) ---
        const unitSelect = getUnitSelect();
        const unitOtherInput = getUnitOtherInput();

        const selectedVehicleId =
          (unitSelect && unitSelect.value && unitSelect.value !== "other")
            ? String(unitSelect.value)
            : null;

        let signatureSource = "drawn";
        try {
          const ss = sessionStorage.getItem("__signatureSource");
          if (ss) signatureSource = ss;
        } catch(_) {}

        const unitNumber =
          (unitSelect && unitSelect.value && unitSelect.value !== "other")
            ? (unitSelect.options[unitSelect.selectedIndex]?.textContent || "")
            : (unitOtherInput ? unitOtherInput.value || "" : "");

        const odometerClean = cleanNumberString(valById("odometer"));

        const payload = {
          samsaraVehicleId: selectedVehicleId,
          signatureSource: signatureSource,
          carrierName: valById("carrier"),
          locationAddress: valById("address"),
          unitNumber: unitNumber,
          licensePlate: valById("license-plate"),
          odometer: odometerClean,
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

          // Pull from globals if present, fall back to hidden inputs or empty
          odometerSource: (window._odometerSource ?? valById("odometer-source") ?? ""),
          samsaraOdometerKm: (window._samsaraOdometerKm ?? (function(){ const v = valById("samsara-odometer-km"); return v ? Number(v) : null; })()),

          signature: getSignatureDataURL(),
          checklist: buildChecklist()
        };

        // --- POST { payload } to your API (exact shape expected) ---
        const res = await fetch(CONFIG.saveEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ payload })
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(`Save failed (${res.status}) ${txt}`);
        }
        const saved = await res.json().catch(() => ({}));
        const inspectionId = saved.id || saved.inspection_id || saved.data?.id;
        if (!inspectionId) throw new Error("Save succeeded but no inspection id was returned.");

        // --- Generate PDF from output.html ---
        Progress.update("Generating report...");
        const reportUrl = CONFIG.reportUrl(inspectionId);
        const iframe = await openHiddenIframe(reportUrl);

        Progress.update("Converting to PDF...");
        const filename = CONFIG.filenameFrom(payload);
        const pdfBlob = await generatePdfBlobFromIframe(iframe, filename);
        const objectUrl = URL.createObjectURL(pdfBlob);

        // --- Open viewer ---
        Progress.update("Opening PDF viewer...");
        const viewerUrl = `/pdf_viewer.html?src=${encodeURIComponent(objectUrl)}&filename=${encodeURIComponent(filename)}&id=${encodeURIComponent(inspectionId)}`;
        window.open(viewerUrl, "_blank", "noopener");

        // Keep URL alive for 10 min; then revoke
        setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch {} }, 10 * 60 * 1000);

        Progress.hide();
      } catch (err) {
        console.error(err);
        Progress.error("Error: " + (err && err.message ? err.message : "Unexpected error."));
        setTimeout(() => Progress.hide(), 6000);
      }
    }, true); // <-- capture=true
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
