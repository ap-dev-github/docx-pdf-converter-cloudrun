#!/bin/bash

# Deploy Cloud Run service
set -e

PROJECT_ID="${GCP_PROJECT_ID:-yellow-ai}"
SERVICE_NAME="docx-pdf-converter"
REGION="us-central1"
IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo "Building Docker image..."
docker build -t "${IMAGE_NAME}:latest" .

echo "Pushing to Container Registry..."
docker push "${IMAGE_NAME}:latest"

echo "Deploying to Cloud Run..."
gcloud run deploy ${SERVICE_NAME} \
  --image "${IMAGE_NAME}:latest" \
  --platform managed \
  --region ${REGION} \
  --project ${PROJECT_ID} \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --max-instances 100 \
  --concurrency 10 \
  --allow-unauthenticated \
  --set-env-vars "NODE_ENV=production" \
  --service-account "docx-pdf-converter@${PROJECT_ID}.iam.gserviceaccount.com" \
  --ingress internal-and-cloud-load-balancing

echo "✅ Deployment complete!"
echo "Service URL: https://${SERVICE_NAME}-xxxxx.run.app"
