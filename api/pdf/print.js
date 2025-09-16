import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

export const config = { runtime: 'nodejs' };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function launchBrowser() {
  const executablePath = await chromium.executablePath();
  return puppeteer.launch({
    args: [...chromium.args, '--font-render-hinting=none'],
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: 'shell',
    ignoreHTTPSErrors: true,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Use POST');
  }

  // Parse body safely
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (_) {}

  const filename = body.filename || 'Schedule-4-Inspection.pdf';
  const baseUrl = process.env.APP_BASE_URL || `https://${req.headers.host}`;
  const targetPath = body.path || '/output.html';
  const targetUrl = `${baseUrl}${targetPath}`;

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();

    // Use PRINT CSS so .no-print is hidden and @page rules apply
    await page.emulateMediaType('print');

    // If you pass data, inject before navigation so output.html reads sessionStorage
    if (body.data) {
      await page.evaluateOnNewDocument((data) => {
        try { sessionStorage.setItem('schedule4Data', JSON.stringify(data || {})); } catch {}
      }, body.data);
    }

    // Navigate and wait for base render
    await page.goto(targetUrl, { waitUntil: ['load', 'networkidle0'] }).catch(() => {});
    await page.waitForSelector('#page', { timeout: 15000 }).catch(() => {});

    // Ensure web fonts are ready (prevents layout shifts)
    try {
      await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : null);
    } catch (_) {}

    // Normalize & force-set checklist badges if your output.html relies on it (left intact)
    try {
      await page.evaluate((data) => {
        if (!data || !data.checklist) return;
        const norm = (s) => String(s ?? '').trim().toLowerCase();
        const CHECK_SVG =
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-top:-1px;"><path d="M2 6l2.5 2.5L10 3"/></svg>';

        const isPass = (v) => {
          const n = norm(v);
          return n === '✓' || n === '✔' || n === 'ok' || n === 'okay' || n === 'yes' || n === 'y' ||
                 n === 'true' || n === '1' || n === 'pass' || n === 'p' || n === '✅';
        };
        const isRepair = (v) => {
          const n = norm(v);
          return n === 'r' || n === 'repair' || n === 'repaired' || n === 'fail' || n === 'f' ||
                 n === 'defect' || n === 'x' || n === '✗' || n === '✘';
        };
        const isNA = (v) => {
          const n = norm(v);
          return n === 'na' || n === 'n/a' || n === 'not applicable' || n === 'n';
        };

        document.querySelectorAll('.checklist-item').forEach((item) => {
          const label = item.querySelector('.checklist-item-text')?.textContent?.trim();
          if (!label) return;
          const raw = data.checklist[label];
          if (raw == null || norm(raw) === '') return;

          const badge = item.querySelector('.checklist-status');
          if (!badge) return;

          // reset content & classes
          badge.classList.remove('status-pass', 'status-repair', 'status-na');
          badge.textContent = '';
          badge.innerHTML = '';

          if (isPass(raw)) {
            badge.classList.add('status-pass');
            badge.innerHTML = CHECK_SVG; // SVG checkmark
          } else if (isRepair(raw)) {
            badge.classList.add('status-repair');
            badge.textContent = 'R';
          } else if (isNA(raw)) {
            badge.classList.add('status-na');
            badge.textContent = 'N/A';
          } else {
            badge.classList.add('status-repair');
            badge.textContent = String(raw).toUpperCase();
          }
        });
      }, body.data || {});
    } catch (_) {}

    // Wait until at least one badge is visible (best effort)
    await page.waitForFunction(() => {
      const badges = Array.from(document.querySelectorAll('.checklist-status'));
      return badges.some(b => b.innerHTML.includes('<svg') || ['✓','R','N/A'].includes((b.textContent || '').trim()));
    }, { timeout: 5000 }).catch(() => {});

    // Ensure signature image (if present) is loaded
    await page.waitForFunction(() => {
      const img = document.getElementById('signatureImg');
      return !img || img.complete;
    }, { timeout: 5000 }).catch(() => {});

    // Add PDF-only class for print CSS (e.g., body.pdf-export .no-print {display:none})
    await page.evaluate(() => { document.body.classList.add('pdf-export'); });

    // ✅ 95% scale applied here — PDF only
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      scale: 0.95,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    // Return pure binary
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.end(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    try { await browser.close(); } catch {}
  }
}
