// /api/pdf/print
// Server-side PDF render using chrome-aws-lambda (bundled Chromium) + puppeteer-core on Vercel Node functions.

import chromium from 'chrome-aws-lambda';
import puppeteer from 'puppeteer-core';

export const config = {
  runtime: 'nodejs',
  memory: 1024,
  maxDuration: 60
};

function json(res, status, obj) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'Use POST' });
  }

  // Parse body
  let body = {};
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); } catch {}

  const filename = body.filename || 'Schedule-4_Inspection.pdf';

  // Build absolute URL for output.html
  const baseUrl =
    (process.env.APP_BASE_URL && process.env.APP_BASE_URL.trim()) ||
    `https://${(req.headers.host || 'app.tisdale.coach').replace(/\/+$/, '')}`;

  const targetPath = body.path || (body.id ? `/output.html?id=${encodeURIComponent(body.id)}` : '/output.html');
  let targetUrl;
  try { targetUrl = new URL(targetPath, baseUrl).toString(); }
  catch { targetUrl = `${baseUrl}${targetPath.startsWith('/') ? '' : '/'}${targetPath}`; }

  // Launch Chromium from chrome-aws-lambda (includes libnss3)
  let browser;
  try {
    const executablePath = await chromium.executablePath; // async property on v10
    if (!executablePath || typeof executablePath !== 'string') {
      throw new Error('chrome-aws-lambda returned invalid executablePath');
    }
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: true,
      ignoreHTTPSErrors: true
    });
  } catch (err) {
    console.error('[print] LAUNCH FAILED:', err);
    return json(res, 500, { step: 'launch', error: 'Chromium failed to start', details: err?.message });
  }

  try {
    const page = await browser.newPage();
    await page.emulateMediaType('print');

    // Inject session data for the renderer if provided
    try {
      await page.evaluateOnNewDocument((data) => {
        try { sessionStorage.setItem('schedule4Data', JSON.stringify(data || {})); } catch {}
      }, body.data || {});
    } catch {}

    // Navigate
    try {
      await page.goto(targetUrl, { waitUntil: ['load', 'domcontentloaded', 'networkidle0'], timeout: 60000 });
    } catch (err) {
      console.error('[print] GOTO FAILED:', targetUrl, err);
      return json(res, 500, { step: 'goto', targetUrl, error: 'Navigation failed', details: err?.message });
    }

    // Minimal readiness
    try { await page.waitForSelector('#page, #root, body', { timeout: 8000 }); } catch {}

    // Fonts settle
    try { await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : null); } catch {}

    // Signature load
    try {
      await page.waitForFunction(() => {
        const img = document.getElementById('signatureImg');
        return !img || img.complete;
      }, { timeout: 5000 });
    } catch {}

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', String(pdfBuffer.length));
    return res.end(pdfBuffer);
  } catch (err) {
    console.error('[print] RENDER FAILED:', { targetUrl, msg: err?.message });
    return json(res, 500, { step: 'render', targetUrl, error: 'PDF render failed', details: err?.message });
  } finally {
    try { await browser?.close(); } catch {}
  }
}
