const express = require('express');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

// ─── Configuration ───────────────────────────────────────────────────────────

const config = {
  bucket:            process.env.R2_BUCKET            || 'yellow-ai',
  inputPrefix:       process.env.R2_INPUT_PREFIX       || 'yellow-ai-unconverted',
  outputPrefix:      process.env.R2_OUTPUT_PREFIX      || 'yellow-ai-converted',
  r2Endpoint:        process.env.R2_ENDPOINT           || '',
  r2AccessKeyId:     process.env.R2_ACCESS_KEY_ID      || '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY  || '',
  port:              parseInt(process.env.PORT         || '8080'),
  testMode:          process.env.NODE_ENV === 'test',
  cloudflareWorkerUrl:
    process.env.CLOUDFLARE_WORKER_URL ||
    'https://docx-pdf-service-production.devversioncv.workers.dev',
  docxPdfConverterSecret: process.env.DOCX_PDF_CONVERTER_SECRET || '',
  chromiumPath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
};

// ─── Express ─────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' })); // body is tiny now — just uuid + metadata

// ─── S3 / R2 client ──────────────────────────────────────────────────────────

const s3Client = new S3Client({
  region: 'auto',
  endpoint: config.r2Endpoint,
  credentials: {
    accessKeyId:     config.r2AccessKeyId,
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
  info:    (msg, data) => console.log(`[${uuid}] ℹ ${msg}`, data ? JSON.stringify(data) : ''),
  error:   (msg, err)  => console.error(`[${uuid}] ✖ ${msg}`, err ? err.message : ''),
  success: (msg)       => console.log(`[${uuid}] ✔ ${msg}`)
});

// ─── Browser singleton ───────────────────────────────────────────────────────

let browser     = null;
let browserReady = null;

const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-zygote',
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
  if (browserReady) return browserReady;

  console.log('[browser] Launching Chromium...');
  browserReady = puppeteer
    .launch({ executablePath: config.chromiumPath, headless: true, args: CHROMIUM_ARGS, pipe: true })
    .then((b) => {
      browser      = b;
      browserReady = null;
      b.on('disconnected', () => {
        console.error('[browser] Chromium disconnected — will relaunch on next request');
        browser = null; browserReady = null;
      });
      console.log('[browser] Chromium ready');
      return b;
    })
    .catch((err) => {
      console.error('[browser] Failed to launch:', err.message);
      browser = null; browserReady = null;
      throw err;
    });

  return browserReady;
}

async function getBrowser() {
  if (browser) return browser;
  return launchBrowser();
}

// ─── R2: fetch HTML ──────────────────────────────────────────────────────────

/**
 * Download the HTML file from the unconverted bucket.
 * Key pattern: <inputPrefix>/<uuid>.html
 */
async function fetchHtmlFromR2(uuid, logger) {
  const key = `${config.inputPrefix}/${uuid}.html`;
  logger.info(`Fetching HTML from R2`, { key });

  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: config.bucket, Key: key })
  );

  // Stream → string
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const html = Buffer.concat(chunks).toString('utf-8');

  if (!html || html.trim().length === 0) {
    throw new Error(`HTML fetched from R2 is empty — key: ${key}`);
  }

  logger.info(`HTML fetched`, { bytes: html.length });
  return html;
}

// ─── PDF conversion ──────────────────────────────────────────────────────────

async function convertHtmlToPdf(html, uuid, logger) {
  const startTime = Date.now();
  logger.info('Converting HTML → PDF');

  const b    = await getBrowser();
  const page = await b.newPage();

  try {
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    const pdfBuffer = await page.pdf({
      format:               'A4',
      printBackground:      true,
      preferCSSPageSize:    true,
      displayHeaderFooter:  false,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });

    logger.success(`Converted in ${Date.now() - startTime}ms — ${pdfBuffer.length} bytes`);
    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── R2: upload PDF ──────────────────────────────────────────────────────────

/**
 * Upload the PDF buffer to the converted bucket.
 * Key pattern: <outputPrefix>/<uuid>.pdf
 */
async function uploadPdfToR2(uuid, pdfBuffer, logger) {
  const key = `${config.outputPrefix}/${uuid}.pdf`;
  logger.info('Uploading PDF to R2', { key, bytes: pdfBuffer.length });

  await s3Client.send(
    new PutObjectCommand({
      Bucket:      config.bucket,
      Key:         key,
      Body:        pdfBuffer,
      ContentType: 'application/pdf',
      Metadata:    { source: 'html-pdf-converter' }
    })
  );

  logger.success('PDF uploaded to R2');
  return key;
}

// ─── Status update ───────────────────────────────────────────────────────────

async function updateConversionStatus(uuid, status, error) {
  try {
    const response = await fetch(`${config.cloudflareWorkerUrl}/update`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${config.docxPdfConverterSecret}`
      },
      body: JSON.stringify({ uuid, status, ...(error && { error }) })
    });

    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
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

// ─── Main orchestrator ───────────────────────────────────────────────────────

async function processConversion(payload) {
  const { uuid } = payload;
  const logger    = createLogger(uuid);
  const startTime = Date.now();

  try {
    logger.info('Starting conversion', { uuid });

    if (config.testMode) {
      logger.info('TEST MODE: skipping R2 and Chromium');
      logger.success(`Test complete in ${Date.now() - startTime}ms`);
      return;
    }

    // 1. Fetch HTML from R2 unconverted bucket
    const html = await fetchHtmlFromR2(uuid, logger);

    // 2. Render HTML → PDF via Chromium
    const pdfBuffer = await convertHtmlToPdf(html, uuid, logger);

    // 3. Upload PDF to R2 converted bucket
    await uploadPdfToR2(uuid, pdfBuffer, logger);

    // 4. Notify Cloudflare D1 — status: completed
    await updateConversionStatus(uuid, 'completed');

    logger.success(`All done in ${Date.now() - startTime}ms`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed after ${Date.now() - startTime}ms: ${errorMsg}`, error);
    await updateConversionStatus(uuid, 'failed', errorMsg);
    throw error;
  } finally {
    cleanupTempFiles(logger); // nothing on disk to clean in normal flow
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * POST /process-file
 * Body: { uuid: string, ...any extra metadata }
 * HTML is fetched from R2 — not accepted in the request body.
 */
app.post('/process-file', async (req, res) => {
  const { uuid } = req.body || {};

  if (!uuid) {
    return res.status(400).json({ error: 'Missing required field: uuid' });
  }

  try {
    await processConversion({ uuid });
    res.status(200).json({ success: true, uuid });
  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({
      error:   'Processing failed',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/**
 * POST /convert  — LOCAL / DEV ONLY
 * Accepts { uuid } and returns the raw PDF bytes directly.
 * Fetches HTML from R2 just like /process-file but skips the upload + status steps.
 */
app.post('/convert', async (req, res) => {
  const { uuid } = req.body || {};

  if (!uuid) {
    return res.status(400).json({ error: 'Missing required field: uuid' });
  }

  const logger    = createLogger(uuid);
  const startTime = Date.now();

  try {
    const html      = await fetchHtmlFromR2(uuid, logger);
    const pdfBuffer = await convertHtmlToPdf(html, uuid, logger);
    const ms        = Date.now() - startTime;

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${uuid}.pdf"`,
      'Content-Length':      pdfBuffer.length,
      'X-Conversion-Ms':     ms
    });

    logger.success(`/convert done in ${ms}ms — ${pdfBuffer.length} bytes`);
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('Conversion failed', error);
    res.status(500).json({
      error:   'Conversion failed',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/** GET /health */
app.get('/health', (_req, res) => {
  res.json({
    status:       'ok',
    service:      'html-pdf-converter',
    browserReady: browser !== null,
    timestamp:    new Date().toISOString()
  });
});

/** GET /readiness — Cloud Run startup probe */
app.get('/readiness', (_req, res) => {
  if (!browser) {
    return res.status(503).json({ ready: false, reason: 'browser not ready' });
  }
  res.json({ ready: true, timestamp: new Date().toISOString() });
});

// ─── Startup ─────────────────────────────────────────────────────────────────

app.listen(config.port, async () => {
  console.log(`HTML→PDF converter listening on port ${config.port}`);
  console.log(`R2 bucket  : ${config.bucket}`);
  console.log(`  input    : ${config.inputPrefix}/<uuid>.html`);
  console.log(`  output   : ${config.outputPrefix}/<uuid>.pdf`);
  console.log(`CF Worker  : ${config.cloudflareWorkerUrl}`);

  if (config.testMode) {
    console.log('⚠  TEST MODE active');
    return;
  }

  try {
    await launchBrowser();
  } catch (err) {
    console.error('Chromium pre-launch failed (will retry on first request):', err.message);
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────

process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down');
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});