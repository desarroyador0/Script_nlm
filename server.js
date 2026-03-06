/**
 * NotebookLM Playwright API
 * Deploy en Railway — llamada desde n8n en Render
 * Autenticación via cookies (sin login)
 */

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/tmp/notebooklm';
const API_SECRET   = process.env.API_SECRET || 'cambiar-esto';
const PORT         = process.env.PORT || 3000;

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// ── Auth middleware ──────────────────────────────────────────
app.use((req, res, next) => {
  const token = req.headers['x-api-secret'];
  if (token !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── Health check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Main endpoint ─────────────────────────────────────────────
app.post('/generate-video', async (req, res) => {
  const { type, source, notebookTitle } = req.body;

  if (!type || !source) {
    return res.status(400).json({ error: 'Se requieren type y source' });
  }

  const GOOGLE_COOKIES = process.env.GOOGLE_COOKIES;

  if (!GOOGLE_COOKIES) {
    return res.status(500).json({ error: 'Falta variable GOOGLE_COOKIES' });
  }

  let cookies;
  try {
    cookies = JSON.parse(GOOGLE_COOKIES);
  } catch (e) {
    return res.status(500).json({ error: 'GOOGLE_COOKIES no es un JSON válido: ' + e.message });
  }

  let browser;
  try {
    console.log(`[${new Date().toISOString()}] Iniciando: type=${type} source=${source.substring(0, 50)}...`);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 }
    });

    // ── Cargar cookies ───────────────────────────────────────
    console.log(`Cargando ${cookies.length} cookies...`);
    const cleanCookies = cookies.map(cookie => {
  const validSameSite = ['Strict', 'Lax', 'None'];
  if (!validSameSite.includes(cookie.sameSite)) {
    cookie.sameSite = 'Lax';
  }
  return cookie;
});
await context.addCookies(cleanCookies);
    console.log('Cookies cargadas OK');

    const page = await context.newPage();

    // ── Abrir NotebookLM ─────────────────────────────────────
    console.log('Abriendo NotebookLM...');
    await page.goto('https://notebooklm.google.com', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

   // Verificar que estamos logueados
const currentUrl = page.url();
console.log('URL actual después de cargar cookies:', currentUrl);
if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
  throw new Error(`Las cookies expiaron o son inválidas. URL actual: ${currentUrl}`);
}
console.log('Sesión activa OK');

    // ── Nuevo notebook ───────────────────────────────────────
    await page.locator([
      'button:has-text("New notebook")',
      'button:has-text("Nuevo notebook")',
      '[data-testid="new-notebook-button"]'
    ].join(', ')).first().click();
    await page.waitForTimeout(2000);

    // ── Agregar fuente ───────────────────────────────────────
    if (type === 'text') {
      const tmpFile = `/tmp/guion_${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, source);
      const uploadBtn = page.locator(['button:has-text("Upload")', 'button:has-text("Subir")'].join(', ')).first();
      const uploadVisible = await uploadBtn.isVisible().catch(() => false);
      if (uploadVisible) await uploadBtn.click();
      await page.waitForTimeout(1000);
      await page.locator('input[type="file"]').first().setInputFiles(tmpFile);
      fs.unlinkSync(tmpFile);

    } else if (type === 'pdf') {
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(source);

    } else if (type === 'url') {
      await page.locator([
        'button:has-text("Website")',
        'button:has-text("URL")',
        '[data-testid="add-url-source"]'
      ].join(', ')).first().click();
      await page.waitForTimeout(1000);
      await page.locator('input[placeholder*="http"], input[type="url"]').first().fill(source);
      await page.keyboard.press('Enter');

    } else if (type === 'gdoc') {
      await page.locator([
        'button:has-text("Google Drive")',
        'button:has-text("Drive")',
        '[data-testid="add-drive-source"]'
      ].join(', ')).first().click();
      await page.waitForTimeout(1000);
      await page.locator('input[placeholder*="drive"], input[placeholder*="doc"], input[type="url"]').first().fill(source);
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(5000);
    console.log('Fuente agregada');

    // ── Video Overview ───────────────────────────────────────
    await page.locator([
      'button:has-text("Video")',
      '[data-testid="video-overview-tab"]',
      'a:has-text("Video")'
    ].join(', ')).first().click();
    await page.waitForTimeout(2000);

    await page.locator([
      'button:has-text("Generate")',
      'button:has-text("Generar")',
      'button:has-text("Create video")',
      '[data-testid="generate-video-btn"]'
    ].join(', ')).first().click();
    await page.waitForTimeout(3000);
    console.log('Generación iniciada...');

    // ── Polling ──────────────────────────────────────────────
    const MAX_WAIT = 10 * 60 * 1000;
    const INTERVAL = 15_000;
    let elapsed = 0;
    let ready = false;

    while (elapsed < MAX_WAIT) {
      await page.waitForTimeout(INTERVAL);
      elapsed += INTERVAL;
      console.log(`Esperando video... ${Math.floor(elapsed / 1000)}s`);

      const dlVisible = await page.locator([
        'button:has-text("Download")',
        'button:has-text("Descargar")',
        'a[download]'
      ].join(', ')).first().isVisible().catch(() => false);

      if (dlVisible) { ready = true; break; }

      const noSpinner = !(await page.locator('[role="progressbar"], .loading-spinner').first().isVisible().catch(() => false));
      const hasPlay   = await page.locator('button[aria-label*="play"], video').first().isVisible().catch(() => false);
      if (noSpinner && hasPlay) { ready = true; break; }
    }

    if (!ready) throw new Error('Video no generado en 10 minutos');
    console.log('Video listo, descargando...');

    // ── Descargar ────────────────────────────────────────────
    const fileName = `notebooklm_${Date.now()}.mp4`;
    const filePath = path.join(DOWNLOAD_DIR, fileName);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator([
        'button:has-text("Download")',
        'button:has-text("Descargar")',
        'a[download]'
      ].join(', ')).first().click()
    ]);

    await download.saveAs(filePath);
    console.log(`Descargado: ${filePath}`);

    // Leer archivo y devolver como base64
    const fileBuffer = fs.readFileSync(filePath);
    const base64     = fileBuffer.toString('base64');

    // Limpiar archivo temporal
    fs.unlinkSync(filePath);

    res.json({
      success: true,
      fileName,
      mimeType: 'video/mp4',
      base64,
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 NotebookLM API corriendo en puerto ${PORT}`);
});
