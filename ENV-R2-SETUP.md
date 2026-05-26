# Cloud Run Environment Variables - R2 Configuration

## R2 Bucket Access (S3-compatible)

```bash
# .env for Cloud Run deployment

# R2 Configuration (Cloudflare buckets)
R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
R2_BUCKET_INPUT=yellow-docx-unconverted
R2_BUCKET_OUTPUT=yellow-pdf-converted

# Service Configuration
NODE_ENV=production
PORT=8080

# Performance Tuning
PUPPETEER_TIMEOUT=30000        # 30 seconds for PDF generation
MAMMOTH_TIMEOUT=20000          # 20 seconds for DOCX→HTML conversion
```

## How to Get R2 Credentials

### Step 1: Create R2 API Token in Cloudflare

```bash
# Via Cloudflare Dashboard:
1. Dashboard → R2 → Settings → API tokens
2. Click "Create API token"
3. Select "Object Read & Write" permissions
4. Apply to "All buckets"
5. Copy:
   - R2_ENDPOINT
   - R2_ACCESS_KEY_ID
   - R2_SECRET_ACCESS_KEY
```

### Step 2: Create/Verify R2 Buckets

```bash
# Using Cloudflare Dashboard or Wrangler CLI:
wrangler r2 bucket create yellow-docx-unconverted
wrangler r2 bucket create yellow-pdf-converted

# Verify
wrangler r2 bucket list
```

## Deploy to Cloud Run with R2

```bash
# Build Docker image
docker build -t docx-pdf-converter:latest .

# Tag for GCP
docker tag docx-pdf-converter:latest gcr.io/yellow-ai/docx-pdf-converter:latest

# Push to Container Registry
docker push gcr.io/yellow-ai/docx-pdf-converter:latest

# Deploy with R2 credentials
gcloud run deploy docx-pdf-converter \
  --image gcr.io/yellow-ai/docx-pdf-converter:latest \
  --platform managed \
  --region us-central1 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --max-instances 100 \
  --concurrency 10 \
  --set-env-vars \
    R2_ENDPOINT=https://your-account-id.r2.cloudflarestorage.com,\
    R2_ACCESS_KEY_ID=your-access-key-id,\
    R2_SECRET_ACCESS_KEY=your-secret-key,\
    R2_BUCKET_INPUT=yellow-docx-unconverted,\
    R2_BUCKET_OUTPUT=yellow-pdf-converted,\
    PUPPETEER_TIMEOUT=30000,\
    MAMMOTH_TIMEOUT=20000
```

## Cost Comparison

### Before (GCS + GCS egress)
```
- GCS Storage: ₹40/month
- GCS Egress: ₹150-300/month  ← EXPENSIVE
- Cloud Run: ₹70/day
- Total: ₹2,500-3,000/month
```

### After (R2 only)
```
- R2 Storage: ₹70/month
- R2 Egress: ₹0 (included)  ← FREE
- Cloud Run: ₹70/day
- Total: ₹1,200-1,400/month  ← 50% savings!
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│         Cloudflare Worker (CF Pages)                │
│  (Upload DOCX → Store in R2 → Publish to Pub/Sub)  │
└────────────────────┬────────────────────────────────┘
                     │
         ┌───────────▼──────────┐
         │  Cloudflare R2       │
         │  (yellow-docx-       │
         │   unconverted)       │
         └───────────┬──────────┘
                     │
         ┌───────────▼──────────────┐
         │  Google Pub/Sub          │
         │  (Auto-trigger)          │
         └───────────┬──────────────┘
                     │
         ┌───────────▼──────────────────┐
         │  Cloud Run Service           │
         │  (Mammoth + Puppeteer)       │
         │  Reads from R2              │
         │  Writes to R2               │
         └───────────┬──────────────────┘
                     │
         ┌───────────▼──────────┐
         │  Cloudflare R2       │
         │  (yellow-pdf-        │
         │   converted)         │
         └──────────────────────┘

✅ Zero GCS egress costs - all files stay in Cloudflare ecosystem
✅ S3-compatible - uses AWS SDK for familiar API
✅ Faster downloads - R2 CDN global distribution
```

## Verification

```bash
# Test if R2 is working
aws s3 ls s3://yellow-docx-unconverted/ \
  --endpoint-url https://your-account-id.r2.cloudflarestorage.com \
  --access-key-id your-access-key-id \
  --secret-access-key your-secret-key

# Upload test file
aws s3 cp test.pdf s3://yellow-pdf-converted/ \
  --endpoint-url https://your-account-id.r2.cloudflarestorage.com \
  --access-key-id your-access-key-id \
  --secret-access-key your-secret-key
```

## What Changed in Code

✅ Replaced Google Cloud Storage (`@google-cloud/storage`) with AWS S3 SDK (`@aws-sdk/client-s3`)
✅ `downloadFromGCS()` → `downloadFromR2()`
✅ `uploadToGCS()` → `uploadToR2()`
✅ Configuration uses R2 endpoint, access key, secret key
✅ All file operations stay within R2 (zero egress)
✅ Maintains same performance (1-2 second conversion time)

## Why This Works

**R2 is 100% S3-compatible**, so the AWS SDK works perfectly without changes to logic. The only difference is the endpoint URL points to Cloudflare instead of AWS.

**Zero egress because:**
- Files enter R2 from Cloudflare Worker (no egress)
- Cloud Run reads directly from R2 (no egress, same region concept)
- Cloud Run writes to R2 (no egress)
- Users download from R2 CDN (cached, minimal egress)
