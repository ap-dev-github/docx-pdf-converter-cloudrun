# Cloud Run Service: DOCX to PDF Converter

This directory contains the production Cloud Run service that converts DOCX files to PDF using LibreOffice.

## Architecture

This service is triggered by **Google Cloud Pub/Sub** messages containing a file UUID. It:

1. Downloads DOCX file from Cloudflare R2 storage
2. Converts DOCX to PDF using LibreOffice
3. Uploads resulting PDF back to R2
4. Cleans up temporary files

**Storage Paths:**
- Input: `yellow-ai-unconverter/{uuid}.docx`
- Output: `yellow-ai-converter/{uuid}.pdf`

## Files

- **server.js** - Main Fastify application (380 lines)
- **package.json** - Dependencies (Fastify + AWS SDK S3)
- **Dockerfile** - Production image with LibreOffice + fonts

## Environment Variables (Required)

```bash
R2_ENDPOINT_URL=https://account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<your-r2-access-key>
R2_SECRET_ACCESS_KEY=<your-r2-secret>
R2_BUCKET_NAME=yellow-ai
```

## Local Development

```bash
# Install dependencies
npm install

# Set environment variables
export R2_ENDPOINT_URL=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET_NAME=yellow-ai

# Start server
npm start
```

## Docker Build & Run

```bash
# Build image
docker build -t docx-pdf-converter-prod .

# Run locally (with environment variables)
docker run -p 8080:8080 \
  -e R2_ENDPOINT_URL=... \
  -e R2_ACCESS_KEY_ID=... \
  -e R2_SECRET_ACCESS_KEY=... \
  -e R2_BUCKET_NAME=yellow-ai \
  docx-pdf-converter-prod
```

## Cloud Run Deployment

```bash
# Set variables
export PROJECT_ID="your-gcp-project"
export REGION="us-central1"

# Build and push
docker build -t gcr.io/${PROJECT_ID}/docx-pdf-converter-prod .
docker push gcr.io/${PROJECT_ID}/docx-pdf-converter-prod

# Deploy to Cloud Run
gcloud run deploy docx-pdf-converter \
  --image=gcr.io/${PROJECT_ID}/docx-pdf-converter-prod:latest \
  --platform=managed \
  --region=${REGION} \
  --memory=2Gi \
  --cpu=2 \
  --timeout=120 \
  --max-instances=100 \
  --set-env-vars=\
"R2_ENDPOINT_URL=...,\
R2_ACCESS_KEY_ID=...,\
R2_SECRET_ACCESS_KEY=...,\
R2_BUCKET_NAME=yellow-ai" \
  --no-allow-unauthenticated
```

## API Endpoints

### POST /convert
Receives Pub/Sub message with file UUID.

**Request (from Pub/Sub):**
```json
{
  "message": {
    "data": "eyJ1dWlkIjoiMTIzLWQ0Ni03ODktMDEyIn0="
  }
}
```

**Response (Success):**
```json
{
  "success": true,
  "uuid": "123-d46-789-012",
  "outputKey": "yellow-ai-converter/123-d46-789-012.pdf",
  "message": "File converted and uploaded successfully"
}
```

**Response (Error):**
```json
{
  "success": false,
  "uuid": "123-d46-789-012",
  "error": "Error message here"
}
```

### GET /health
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "service": "docx-pdf-converter"
}
```

### GET /ready
Readiness check for Cloud Run.

**Response:**
```json
{
  "ready": true
}
```

## Performance

- Conversion time: 4-7 seconds per file
- Cloud Run cold start: 3-5 seconds
- Auto-scaling: 0-100 instances
- Concurrency: ~10 concurrent conversions per instance

## Logging

All logs go to stdout/stderr and are captured by Cloud Logging:

```bash
gcloud run logs read docx-pdf-converter --limit=50
```

## Error Handling

- **Invalid Pub/Sub message**: Returns 400
- **UUID not found**: Returns 400
- **R2 download error**: Returns 500 (Pub/Sub retries)
- **LibreOffice timeout**: Returns 500 after 120 seconds
- **R2 upload error**: Returns 500 (Pub/Sub retries)

Pub/Sub automatically retries failed messages with exponential backoff for up to 7 days.

## Monitoring

### Cloud Run Metrics
- Visit Google Cloud Console → Cloud Run → docx-pdf-converter
- Check "Metrics" tab for:
  - Request count
  - Error rate
  - Latency
  - CPU/Memory utilization

### Logs
```bash
# Live logs
gcloud run logs read docx-pdf-converter --follow

# Errors only
gcloud run logs read docx-pdf-converter --limit=100 | grep ERROR
```

## Troubleshooting

### Service won't start
- Check Docker image builds locally first: `docker build -t test .`
- Verify all environment variables are set
- Check Cloud Run logs: `gcloud run logs read ...`

### Conversion fails
- Verify R2 bucket exists and is accessible
- Check R2 credentials are correct
- Ensure input file exists at expected path
- Monitor `/tmp/docx-pdf-conversion/` for stuck files

### Pub/Sub not triggering
- Verify subscription is created and enabled
- Check push endpoint URL is correct
- Verify service account has `roles/run.invoker` permission

## Related Documentation

- **PRODUCTION-ARCHITECTURE.md** - Full system architecture
- **DEPLOYMENT-CHECKLIST.md** - Step-by-step deployment
- **QUICK-START.md** - Fast deployment guide
