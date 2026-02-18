import express from 'express';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 5500;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.post('/api/fetch', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid url.' });
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1366, height: 768 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'
    });
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9'
    });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (!response || !response.ok()) {
      throw new Error(`HTTP ${response ? response.status() : 'NO_RESPONSE'}`);
    }
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.waitForSelector('body', { timeout: 10000 }).catch(() => {});
    const html = await page.content();
    res.type('text/html').send(html);
  } catch (err) {
    res.status(500).json({ error: `Playwright fetch failed: ${err.message}` });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`XPathFinder server running on http://127.0.0.1:${PORT}`);
});
