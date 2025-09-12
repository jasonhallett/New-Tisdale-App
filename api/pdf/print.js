import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

// Function files must use "nodejs" (NOT "nodejs20.x")
export const config = { runtime: 'nodejs' };

async function launchBrowser() {
  const executablePath = await chromium.executablePath();
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    // Use the modern headless shell that @sparticuz/chromium provides
    headless: 'shell',
    ignoreHTTPSErrors: true,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Use POST');
  }

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (_) {}

  const filename = body.filename || 'Schedule-4-Inspection.pdf';
  const baseUrl = process.env.APP_BASE_URL || `https://${req.headers.host}`;

  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    // Inject the data BEFORE navigation so output.html can read sessionStorage
    await page.evaluateOnNewDocument((data) => {
      sessionStorage.setItem('schedule4Data', JSON.stringify(data || {}));
    }, body.data || {});

    await page.goto(`${baseUrl}${body.path || '/output.html'}`, {
      waitUntil: 'networkidle0',
    });

    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  } finally {
    await browser.close();
  }
}
