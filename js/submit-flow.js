/* submit-flow.js
 * Drop-in submit workflow for new_inspection.html:
 *  - Shows a no-button status modal (Saving → Generating report → Converting to PDF → Opening Viewer)
 *  - Saves form data to your API
 *  - Loads output.html in a hidden iframe and converts it to PDF (client-side)
 *  - Opens a custom viewer window (pdf_viewer.html) with toolbar: Print, Save to Files, Import to Fleetio, Close
 *
 * Usage:
 *  <script defer src="/assets/submit-flow.js"></script>
 * This script auto-attaches to the first <form> on the page. To be explicit, add data-inspection-form to the form.
 */
(function () {
  // ---- CONFIG ----
  const CONFIG = {
    // Adjust this if your save endpoint differs. It must return JSON { id: "<inspectionId>", ... }
    saveEndpoint: "/api/inspections",
    // How to construct the report URL that output.html will use to render this inspection
    reportUrl: (inspectionId) => `/output.html?id=${encodeURIComponent(inspectionId)}&mode=pdf`,
    // Filename pattern for the PDF
    filename: (meta) => {
      const unit = (meta.unit || "Unit").toString().replace(/[^\w\-]+/g, "_");
      const d = meta.date || new Date().toISOString().slice(0,10);
      return `Schedule-4_Inspection_${unit}_${d}.pdf`;
    },
    // How we pick PDF source element inside output.html
    pickPdfElement: (doc) => doc.querySelector("#page") || doc.body,
  };

  // ---- Utility: tiny modal for progress ----
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
    function show(msg) {
      ensure();
      textEl.textContent = msg || "Working...";
      el.style.display = "flex";
      // prevent scroll behind
      document.documentElement.style.overflow = "hidden";
      document.body.style.overscrollBehavior = "none";
    }
    function update(msg) {
      ensure();
      textEl.textContent = msg || textEl.textContent;
    }
    function hide() {
      if (!el) return;
      el.style.display = "none";
      document.documentElement.style.overflow = "";
      document.body.style.overscrollBehavior = "";
    }
    function error(msg) {
      ensure();
      textEl.textContent = msg || "An error occurred.";
      // keep visible; caller may choose to hide()
    }
    return { show, update, hide, error };
  })();

  // ---- Helpers ----
  function formToJSON(form) {
    const fd = new FormData(form);
    const out = {};
    for (const [k, v] of fd.entries()) {
      if (k in out) {
        if (Array.isArray(out[k])) out[k].push(v);
        else out[k] = [out[k], v];
      } else {
        out[k] = v;
      }
    }
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
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.style.opacity = "0";
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
        windowWidth: 816,   // letter width in px @ 96dpi
        windowHeight: 1056, // letter height in px @ 96dpi
      },
      jsPDF: { unit: "pt", format: "letter", orientation: "portrait" }
    };
    // Output as Blob (no auto-save)
    const blob = await window.html2pdf().set(options).from(el).outputPdf("blob");
    return blob;
  }

  // ---- Main submit flow ----
  function install() {
    const form = document.querySelector("form[data-inspection-form]") || document.querySelector("form");
    if (!form) return;
    if (form.dataset.submitFlowInstalled === "1") return;
    form.dataset.submitFlowInstalled = "1";

    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      try {
        Progress.show("Saving...");
        const payload = formToJSON(form);

        // derive some filename-friendly meta if present
        const meta = {
          unit: payload.unit || payload.unit_number || payload["vehicle[unit]"] || "Unit",
          date: payload.date || payload.inspection_date || new Date().toISOString().slice(0,10),
        };
        const filename = CONFIG.filename(meta);

        // Save to API
        const res = await fetch(CONFIG.saveEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const txt = await res.text().catch(()=>"");
          throw new Error(`Save failed (${res.status}) ${txt}`);
        }
        const saved = await res.json().catch(() => ({}));
        const inspectionId = saved.id || saved.inspection_id || saved.data?.id;
        if (!inspectionId) {
          throw new Error("Save succeeded but no inspection id was returned.");
        }

        Progress.update("Generating report...");
        const reportUrl = CONFIG.reportUrl(inspectionId);
        const iframe = await openHiddenIframe(reportUrl);

        Progress.update("Converting to PDF...");
        const pdfBlob = await generatePdfBlobFromIframe(iframe, filename);
        const objectUrl = URL.createObjectURL(pdfBlob);

        Progress.update("Opening PDF viewer...");
        const viewerUrl = `/pdf_viewer.html?src=${encodeURIComponent(objectUrl)}&filename=${encodeURIComponent(filename)}&id=${encodeURIComponent(inspectionId)}`;
        window.open(viewerUrl, "_blank", "noopener");

        // keep URL alive for a while, then revoke
        setTimeout(() => {
          try { URL.revokeObjectURL(objectUrl); } catch {}
        }, 10 * 60 * 1000); // 10 minutes

        Progress.hide();

        // OPTIONAL: you might want to reset the form or show a toast here
        // form.reset();
      } catch (err) {
        console.error(err);
        Progress.error("Error: " + (err && err.message ? err.message : "Unexpected error."));
        // auto-hide after a short delay so user isn't stuck
        setTimeout(() => Progress.hide(), 5000);
      }
    }, { passive: false });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
