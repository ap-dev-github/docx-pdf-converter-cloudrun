const express = require('express');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const config = {
  bucket: process.env.R2_BUCKET || 'yellow-ai',
  inputPrefix: process.env.R2_INPUT_PREFIX || 'yellow-ai-unconverter',
  outputPrefix: process.env.R2_OUTPUT_PREFIX || 'yellow-ai-converter',
  r2Endpoint: process.env.R2_ENDPOINT || 'https://your-account.r2.cloudflarestorage.com',
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  port: parseInt(process.env.PORT || '8080'),
  testMode: process.env.NODE_ENV === 'test',
  cloudflareWorkerUrl: process.env.CLOUDFLARE_WORKER_URL || 'https://docx-pdf-service-production.devversioncv.workers.dev',
  docxPdfConverterSecret: process.env.DOCX_PDF_CONVERTER_SECRET || ''
};

// Initialize
const app = express();

// Initialize S3 client for Cloudflare R2 (S3-compatible)
const s3Client = new S3Client({
  region: 'auto',
  endpoint: config.r2Endpoint,
  credentials: {
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey
  }
});

const TEMP_DIR = '/tmp/docx-pdf-conversion';

// Create temp directory if it doesn't exist
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

app.use(express.json());

// Logger with context
const createLogger = (uuid) => ({
  info: (msg, data) => console.log(`[${uuid}] ℹ ${msg}`, data ? JSON.stringify(data) : ''),
  error: (msg, err) => console.error(`[${uuid}]  ${msg}`, err ? err.message : ''),
  success: (msg) => console.log(`[${uuid}] ${msg}`)
});

/**
 * Decode Base64 Pub/Sub message
 */
function decodeMessage(data) {
  const json = Buffer.from(data, 'base64').toString('utf-8');
  return JSON.parse(json);
}

/**
 * Update conversion status in Cloudflare D1 database
 */
async function updateConversionStatus(uuid, status, error) {
  try {
    const payload = {
      uuid,
      status,
      ...(error && { error })
    };

    const response = await fetch(`${config.cloudflareWorkerUrl}/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.docxPdfConverterSecret}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Update failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log(`[${uuid}] Status updated in D1:`, result);
  } catch (err) {
    console.error(`[${uuid}] Failed to update status in D1:`, err.message);
  }
}

/**
 * Download file from R2 bucket using S3 client
 */
async function downloadFromR2(uuid, logger) {
  try {
    const key = `${config.inputPrefix}/${uuid}.docx`;
    logger.info('Downloading DOCX from R2 bucket');

    const command = new GetObjectCommand({
      Bucket: config.bucket,
      Key: key
    });

    const response = await s3Client.send(command);

    // Convert stream to buffer
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);
    const localPath = path.join(TEMP_DIR, `${uuid}.docx`);
    fs.writeFileSync(localPath, buffer);

    logger.info(`Downloaded DOCX`, { size: buffer.length });
    return localPath;
  } catch (error) {
    throw new Error(`Failed to download from R2: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Convert DOCX to PDF using LibreOffice
 */
function convertWithLibreOffice(inputPath, uuid, logger) {
  return new Promise((resolve, reject) => {
    const outputDir = TEMP_DIR;
    logger.info('Converting DOCX to PDF with LibreOffice');

    exec(`libreoffice --headless --convert-to pdf --outdir ${outputDir} ${inputPath}`, (error) => {
      if (error) {
        logger.error(`LibreOffice conversion error`, error);
        return reject(error);
      }

      const outputFile = path.join(outputDir, `${uuid}.pdf`);
      if (!fs.existsSync(outputFile)) {
        return reject(new Error(`Output PDF not found: ${outputFile}`));
      }

      logger.info('LibreOffice conversion successful');
      resolve(outputFile);
    });
  });
}

/**
 * Upload file to R2 bucket using S3 client
 */
async function uploadToR2(uuid, localPath, logger) {
  try {
    const key = `${config.outputPrefix}/${uuid}.pdf`;
    const fileBuffer = fs.readFileSync(localPath);

    logger.info('Uploading PDF to R2 bucket');

    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: fileBuffer,
      ContentType: 'application/pdf',
      Metadata: {
        'source': 'docx-pdf-converter'
      }
    });

    await s3Client.send(command);
    logger.success('PDF uploaded to R2');
  } catch (error) {
    throw new Error(`Failed to upload to R2: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Clean up temporary files
 */
function cleanupTempFiles(logger, ...filePaths) {
  filePaths.forEach(filePath => {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        logger.info(`Cleaned up: ${filePath}`);
      } catch (err) {
        logger.error(`Failed to clean up ${filePath}`, err);
      }
    }
  });
}

/**
 * Main conversion process
 */
async function processConversion(payload) {
  const uuid = payload.uuid;
  const logger = createLogger(uuid);
  const startTime = Date.now();
  let inputPath = null;
  let outputPath = null;

  try {
    logger.info('Starting conversion', { bucket_path: payload.bucket_path });

    // In test mode, skip R2 operations and just return success
    if (config.testMode) {
      logger.info('TEST MODE: Skipping R2 operations');
      logger.success(`Test conversion complete in ${Date.now() - startTime}ms`);
      return;
    }

    // 1. Download DOCX from R2
    inputPath = await downloadFromR2(uuid, logger);

    // 2. Convert DOCX to PDF with LibreOffice
    outputPath = await convertWithLibreOffice(inputPath, uuid, logger);

    // 3. Upload PDF to R2 output bucket
    await uploadToR2(uuid, outputPath, logger);

    // 4. Update status to completed in Cloudflare D1
    const duration = Date.now() - startTime;
    logger.info('Updating conversion status in D1');
    await updateConversionStatus(uuid, 'completed');
    logger.success(`Conversion complete in ${duration}ms`);

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`Conversion failed after ${duration}ms: ${errorMsg}`, error);

    // Update status to failed in Cloudflare D1
    await updateConversionStatus(uuid, 'failed', errorMsg);

    throw error;
  } finally {
    // Always clean up temporary files
    cleanupTempFiles(logger, inputPath, outputPath);
  }
}

/**
 * Incoming process file request handler
 */
app.post('/process-file', async (req, res) => {
  try {
    try {
      const payload = req.body;
      await processConversion(payload);
      res.status(200).json({ success: true, uuid: payload.uuid });
    } catch (error) {
      // Return 500 for Pub/Sub retry
      console.error('Processing error:', error);
      res.status(500).json({
        error: 'Processing failed',
        message: error instanceof Error ? error.message : String(error)
      });
    }
  } catch (error) {
    console.error('Request error:', error);
    res.status(400).json({ error: 'Invalid request' });
  }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'docx-pdf-converter',
    timestamp: new Date().toISOString()
  });
});

/**
 * Ready check for Cloud Run
 */
app.get('/readiness', (req, res) => {
  res.json({
    ready: true,
    timestamp: new Date().toISOString()
  });
});

/**
 * Start server
 */
app.listen(config.port, () => {
  console.log(`Cloud Run service listening on port ${config.port}`);
  console.log(`R2 Bucket: ${config.bucket}`);
  console.log(`  Input prefix: ${config.inputPrefix}`);
  console.log(`  Output prefix: ${config.outputPrefix}`);
  console.log(`Cloudflare Worker URL: ${config.cloudflareWorkerUrl}`);
  if (config.testMode) {
    console.log(` TEST MODE: R2 operations are mocked`);
  } else {
    console.log(`Connected to R2 bucket`);
    console.log(`Connected to Cloudflare Worker for status updates`);
    console.log(`Using LibreOffice for DOCX to PDF conversion`);
  }
});

/**
 * Graceful shutdown
 */
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});
