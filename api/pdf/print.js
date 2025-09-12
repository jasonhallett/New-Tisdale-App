import puppeteer from 'puppeteer';
import puppeteerCore from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  let browser;

  try {
    if (process.env.VERCEL) {
      // Vercel production environment
      browser = await puppeteerCore.launch({
        args: [...chromium.args, '--disable-setuid-sandbox'],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      // Local development
      browser = await puppeteer.launch();
    }
  } catch (error) {
    console.error('Error launching browser:', error);
    return res.status(500).json({ error: 'Failed to launch browser' });
  }

  try {
    let body = {};
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (e) {}

    const filename = body.filename || 'Schedule-4-Inspection.pdf';
    const baseUrl = process.env.APP_BASE_URL || `https://${req.headers.host}`;
    const page = await browser.newPage();
    await page.evaluateOnNewDocument((data) => {
      sessionStorage.setItem('schedule4Data', JSON.stringify(data));
    }, body.data || {});

    await page.goto(`${baseUrl}${body.path || '/output.html'}`, { waitUntil: 'networkidle0' });

    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    res.send(pdf);
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Failed to generate PDF' });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}