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
    headless: 'shell', // recommended with recent puppeteer-core + @sparticuz/chromium
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

    // Inject form data BEFORE navigation so output.html reads sessionStorage
    await page.evaluateOnNewDocument((data) => {
      try { sessionStorage.setItem('schedule4Data', JSON.stringify(data || {})); } catch {}
    }, body.data || {});

    // Ensure print CSS applies like the screen you preview
    await page.emulateMediaType('screen');

    // Navigate and wait for render to stabilize
    await page.goto(targetUrl, { waitUntil: ['load', 'networkidle0'] }).catch(() => {});
    await page.waitForSelector('#page', { timeout: 15000 }).catch(() => {});

    // Wait for web fonts (prevents layout shifts in the PDF)
    try {
      await page.evaluate(() => (document.fonts && document.fonts.ready) ? document.fonts.ready : null);
    } catch (_) {}

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    // Return pure binary; avoid any implicit string encoding
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
