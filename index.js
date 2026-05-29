const express = require('express');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const config = {
  bucket: process.env.R2_BUCKET || 'yellow-ai',
  outputPrefix: process.env.R2_OUTPUT_PREFIX || 'yellow-ai-converted',
  r2Endpoint: process.env.R2_ENDPOINT || '',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  port: parseInt(process.env.PORT || '8080'),
  testMode: process.env.NODE_ENV === 'test',
  cloudflareWorkerUrl:
    process.env.CLOUDFLARE_WORKER_URL ||
    'https://docx-pdf-service-production.devversioncv.workers.dev',
  docxPdfConverterSecret: process.env.DOCX_PDF_CONVERTER_SECRET || '',
  chromiumPath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
};

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' })); // HTML payloads can be large

// ─── S3 / R2 client ──────────────────────────────────────────────────────────

const s3Client = new S3Client({
  region: 'auto',
  endpoint: config.r2Endpoint,
  credentials: {
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey
  }
});

// ─── Temp directory ──────────────────────────────────────────────────────────

const TEMP_DIR = '/tmp/html-pdf-conversion';
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ─── Logger ──────────────────────────────────────────────────────────────────

const createLogger = (uuid) => ({
  info: (msg, data) =>
    console.log(`[${uuid}] ℹ ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg, err) =>
    console.error(`[${uuid}] ✖ ${msg}`, err ? err.message : ''),
  success: (msg) => console.log(`[${uuid}] ✔ ${msg}`)
});

// ─── Browser singleton ───────────────────────────────────────────────────────
//
// A single Chromium process is launched once when the server starts and reused
// for every request.  Each request opens a fresh Page (tab), converts, then
// closes that page.  This eliminates the ~1-2 s browser-launch overhead per
// request while keeping memory usage bounded (pages are released after use).
//
// If the browser crashes for any reason, `browserReady` is reset to null and
// the next request re-launches it automatically.

let browser = null;
let browserReady = null; // Promise while launching, null when idle-ready

const CHROMIUM_ARGS = [
  '--no-sandbox',               // required inside containers
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',    // /dev/shm is small in Docker; use /tmp instead
  '--disable-gpu',
  '--no-zygote',                // saves ~30 MB RAM in single-process containers
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-component-extensions-with-background-pages',
  '--disable-features=TranslateUI',
  '--disable-ipc-flooding-protection',
  '--disable-renderer-backgrounding',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--safebrowsing-disable-auto-update'
];

async function launchBrowser() {
  if (browserReady) return browserReady; // already launching, share the promise

  console.log('[browser] Launching Chromium...');
  browserReady = puppeteer
    .launch({
      executablePath: config.chromiumPath,
      headless: true,
      args: CHROMIUM_ARGS,
      // Pipe avoids an extra IPC socket in some environments
      pipe: true
    })
    .then((b) => {
      browser = b;
      browserReady = null; // clear the "launching" gate

      // Handle unexpected crashes so the next request can recover
      b.on('disconnected', () => {
        console.error('[browser] Chromium disconnected — will relaunch on next request');
        browser = null;
        browserReady = null;
      });

      console.log('[browser] Chromium ready');
      return b;
    })
    .catch((err) => {
      console.error('[browser] Failed to launch Chromium:', err.message);
      browserReady = null;
      browser = null;
      throw err;
    });

  return browserReady;
}

async function getBrowser() {
  if (browser) return browser;
  return launchBrowser();
}

// ─── PDF conversion ──────────────────────────────────────────────────────────

/**
 * Render `html` to a PDF buffer using the shared Chromium instance.
 *
 * @param {string} html   Full HTML string to render
 * @param {string} uuid   Job ID (for logging)
 * @param {object} logger Logger instance
 * @returns {Promise<Buffer>} PDF bytes
 */
async function convertHtmlToPdf(html, uuid, logger) {
  const startTime = Date.now();
  logger.info('Converting HTML → PDF');

  const b = await getBrowser();
  const page = await b.newPage();

  try {
    // Emulate print media so @media print CSS rules apply
    await page.emulateMediaType('print');

    // setContent is faster than goto(data:…) for large HTML strings.
    // 'networkidle0' waits for all network requests to finish (web fonts, etc.)
    // Switch to 'domcontentloaded' if your HTML is fully self-contained.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,      // render background colours & images
      preferCSSPageSize: true,    // honour @page { size: … } in the HTML
      displayHeaderFooter: false,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });

    logger.success(`Converted in ${Date.now() - startTime}ms — ${pdfBuffer.length} bytes`);
    return Buffer.from(pdfBuffer);
  } finally {
    // Always close the page (tab) to free memory, even on error
    await page.close().catch(() => {});
  }
}

// ─── R2 upload ───────────────────────────────────────────────────────────────

/**
 * Upload a PDF buffer to R2 and return the final object key.
 */
async function uploadToR2(uuid, pdfBuffer, logger) {
  const key = `${config.outputPrefix}/${uuid}.pdf`;
  logger.info('Uploading PDF to R2', { key, bytes: pdfBuffer.length });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
      Metadata: { source: 'html-pdf-converter' }
    })
  );

  logger.success('PDF uploaded to R2');
  return key;
}

// ─── Status update ───────────────────────────────────────────────────────────

async function updateConversionStatus(uuid, status, error) {
  try {
    const payload = { uuid, status, ...(error && { error }) };

    const response = await fetch(`${config.cloudflareWorkerUrl}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.docxPdfConverterSecret}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    console.log(`[${uuid}] Status updated in D1:`, await response.json());
  } catch (err) {
    console.error(`[${uuid}] Failed to update status in D1:`, err.message);
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupTempFiles(logger, ...filePaths) {
  for (const filePath of filePaths) {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.info(`Cleaned up: ${filePath}`);
      } catch (err) {
        logger.error(`Failed to clean up ${filePath}`, err);
      }
    }
  }
}

// ─── Main conversion orchestrator ────────────────────────────────────────────

async function processConversion(payload) {
  const { uuid, html } = payload;
  const logger = createLogger(uuid);
  const startTime = Date.now();
  let tempPdfPath = null;

  try {
    logger.info('Starting conversion');

    if (!html || typeof html !== 'string' || html.trim().length === 0) {
      throw new Error('Payload missing required field: html (non-empty string)');
    }

    // Test mode: skip heavy operations, just validate input
    if (config.testMode) {
      logger.info('TEST MODE: Skipping Chromium and R2 operations');
      logger.success(`Test conversion complete in ${Date.now() - startTime}ms`);
      return;
    }

    // 1. Render HTML → PDF buffer (Chromium via Puppeteer)
    const pdfBuffer = await convertHtmlToPdf(html, uuid, logger);

    // 2. Optionally write to disk (useful for debugging; skipped in prod)
    //    Uncomment if you need a local copy for troubleshooting:
    // tempPdfPath = path.join(TEMP_DIR, `${uuid}.pdf`);
    // fs.writeFileSync(tempPdfPath, pdfBuffer);

    // 3. Upload PDF to R2
    await uploadToR2(uuid, pdfBuffer, logger);

    // 4. Mark completed in Cloudflare D1
    await updateConversionStatus(uuid, 'completed');
    logger.success(`Conversion complete in ${Date.now() - startTime}ms`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Conversion failed after ${Date.now() - startTime}ms: ${errorMsg}`, error);
    await updateConversionStatus(uuid, 'failed', errorMsg);
    throw error;
  } finally {
    cleanupTempFiles(logger, tempPdfPath);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /process-file
 * Body: { uuid: string, html: string }
 */
app.post('/process-file', async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.uuid) {
      return res.status(400).json({ error: 'Missing required field: uuid' });
    }

    await processConversion(payload);
    res.status(200).json({ success: true, uuid: payload.uuid });
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({
      error: 'Processing failed',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

// **
//  * POST /convert
//  * LOCAL / DEV ONLY — returns the PDF as raw bytes in the response.
//  * No R2 upload, no status update. Great for smoke-testing the container.
//  * Body: { html: string }
//  */
app.post('/convert', async (req, res) => {
  const startTime = Date.now();
  const { html } = req.body || {};
 
  if (!html || typeof html !== 'string' || html.trim().length === 0) {
    return res.status(400).json({ error: 'Missing required field: html (non-empty string)' });
  }
 
  const logger = createLogger('local-convert');
 
  try {
    const pdfBuffer = await convertHtmlToPdf(html, 'local-convert', logger);
    const ms = Date.now() - startTime;
 
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="output.pdf"',
      'Content-Length': pdfBuffer.length,
      'X-Conversion-Ms': ms
    });
 
    logger.success(`/convert done in ${ms}ms — ${pdfBuffer.length} bytes`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('Conversion failed', error);
    res.status(500).json({
      error: 'Conversion failed',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/** GET /health */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'html-pdf-converter',
    browserReady: browser !== null,
    timestamp: new Date().toISOString()
  });
});

/** GET /readiness — Cloud Run startup probe */
app.get('/readiness', (_req, res) => {
  // Report not-ready until the browser is up
  if (!browser) {
    return res.status(503).json({ ready: false, reason: 'browser not ready' });
  }
  res.json({ ready: true, timestamp: new Date().toISOString() });
});

// ─── Server startup ──────────────────────────────────────────────────────────

app.listen(config.port, async () => {
  console.log(`HTML→PDF converter listening on port ${config.port}`);
  console.log(`R2 bucket: ${config.bucket}  output prefix: ${config.outputPrefix}`);
  console.log(`Cloudflare Worker: ${config.cloudflareWorkerUrl}`);

  if (config.testMode) {
    console.log('⚠  TEST MODE: Chromium and R2 operations are mocked');
    return;
  }

  // Pre-launch Chromium so the first real request is instant
  try {
    await launchBrowser();
  } catch (err) {
    console.error('Chromium pre-launch failed (will retry on first request):', err.message);
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down');
  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(0);
});