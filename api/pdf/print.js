import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
export const config = { runtime: 'nodejs20.x' };

function sanitizeHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '');
}

async function launchBrowser() {
  const executablePath = await chromium.executablePath();
  return puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
    defaultViewport: { width: 816, height: 1056, deviceScaleFactor: 2 },
    executablePath,
    headless: chromium.headless,
    ignoreHTTPSErrors: true,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Use POST');
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch { body = {}; }

  const filename = (body.filename && String(body.filename)) || 'Schedule-4-Inspection.pdf';
  const baseUrl = process.env.APP_BASE_URL || `https://${req.headers.host}`;

  const browser = await launchBrowser();
  let page;
  try {
    page = await browser.newPage();
    await page.emulateMediaType('screen');

    if (body.html) {
      const html = sanitizeHtml(String(body.html));
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
        waitUntil: 'load',
        timeout: 60000,
      });
    } else {
      const path = (body.path && String(body.path)) || '/output.html';
      const data = body.data || {};

      await page.evaluateOnNewDocument((payload) => {
        try {
          sessionStorage.setItem('schedule4Data', JSON.stringify(payload || {}));
          const noop = () => {};
          try { window.print = noop; } catch {}
          try { window.jspdf = undefined; } catch {}
          try { window.html2canvas = undefined; } catch {}
          const origAdd = window.addEventListener;
          window.addEventListener = function(type, listener, opts) {
            if (type === 'load') return;
            return origAdd.call(window, type, listener, opts);
          };
        } catch {}
      }, data);

      const url = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}_serverpdf=1`;
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    }

    try { await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : null); } catch {}

    const pdf = await page.pdf({
      printBackground: true,
      displayHeaderFooter: false,
      preferCSSPageSize: true,
      width: '8.5in',
      height: '11in',
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    res.statusCode = 200;
    res.end(pdf);
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end(`PDF generation failed: ${e?.message || String(e)}`);
  } finally {
    try { await page?.close({ runBeforeUnload: false }); } catch {}
    try { await browser.close(); } catch {}
  }
}
