import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// Function files must use "nodejs" (NOT "nodejs20.x")
export const config = { runtime: 'nodejs' };

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

    // Inject data BEFORE navigation so output.html reads sessionStorage
    await page.evaluateOnNewDocument((data) => {
      try { sessionStorage.setItem('schedule4Data', JSON.stringify(data || {})); } catch {}
    }, body.data || {});

    // Navigate and wait for base render
    await page.goto(targetUrl, { waitUntil: ['load', 'networkidle0'] }).catch(() => {});
    await page.waitForSelector('#page', { timeout: 15000 }).catch(() => {});

    // Ensure web fonts are ready (prevents layout shifts)
    try {
      await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : null);
    } catch (_) {}

    // Normalize & force-set checklist badges (✓ / R / N/A) in case page logic missed them
    await page.evaluate((data) => {
      const checklist = (data && data.checklist) || {};
      const norm = (s) => String(s ?? '').trim().toLowerCase();

      const isPass = (v) => {
        const n = norm(v);
        return n === '✓' || n === 'ok' || n === 'yes' || n === 'y' || n === 'true' || n === '1' || n === 'pass' || n === 'p';
      };
      const isRepair = (v) => {
        const n = norm(v);
        return n === 'r' || n === 'repair' || n === 'repaired' || n === 'fail' || n === 'f' || n === 'defect' || n === 'x' || n === '✗' || n === '✘';
      };
      const isNA = (v) => {
        const n = norm(v);
        return n === 'na' || n === 'n/a' || n === 'not applicable' || n === 'n';
      };

      document.querySelectorAll('.checklist-item').forEach((item) => {
        const label = item.querySelector('.checklist-item-text')?.textContent?.trim();
        if (!label) return;
        const raw = checklist[label];
        if (raw == null || norm(raw) === '') return;

        const badge = item.querySelector('.checklist-status');
        if (!badge) return;

        // reset classes
        badge.classList.remove('status-pass', 'status-repair', 'status-na');
        badge.textContent = '';

        if (isPass(raw)) {
          badge.textContent = '✓';
          badge.classList.add('status-pass');
        } else if (isRepair(raw)) {
          badge.textContent = 'R';
          badge.classList.add('status-repair');
        } else if (isNA(raw)) {
          badge.textContent = 'N/A';
          badge.classList.add('status-na');
        } else {
          // If value exists but doesn't match known sets, show raw (debug-friendly)
          badge.textContent = String(raw).toUpperCase();
          badge.classList.add('status-repair'); // neutral-ish highlight if unknown
        }
      });
    }, body.data || {});

    // Wait until at least one ✓ or R is visible (don’t render too early)
    await page.waitForFunction(() => {
      const badges = Array.from(document.querySelectorAll('.checklist-status')).map(b => (b.textContent || '').trim());
      return badges.some(t => t === '✓' || t === 'R' || t === 'N/A');
    }, { timeout: 5000 }).catch(() => {});

    // Ensure signature image (if present) is loaded
    await page.waitForFunction(() => {
      const img = document.getElementById('signatureImg');
      return !img || img.complete;
    }, { timeout: 5000 }).catch(() => {});

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
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
    await browser.close();
  }
}
