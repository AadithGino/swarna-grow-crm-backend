#!/usr/bin/env bash
# Run after: render login  &&  render services list -o text
# Usage: SERVICE_ID=srv-xxx ./scripts/render-env.sh
# Or set SERVICE_ID from: render services list -o json
set -euo pipefail
: "${SERVICE_ID:?Set SERVICE_ID (render services list)}"
: "${MONGODB_URI:?Set MONGODB_URI}"
: "${JWT_SECRET:?Set JWT_SECRET}"
: "${PUBLIC_URL:?Set PUBLIC_URL e.g. https://swarna-grow-crm-api.onrender.com}"
: "${AWS_ACCESS_KEY_ID:?required}"
: "${AWS_SECRET_ACCESS_KEY:?required}"
: "${GROQ_API_KEY:?required}"
: "${SARVAM_API_KEY:?required}"

render env set --service-id "$SERVICE_ID" --confirm \
  MONGODB_URI="$MONGODB_URI" \
  JWT_SECRET="$JWT_SECRET" \
  PUBLIC_URL="$PUBLIC_URL" \
  CORS_ORIGIN="$PUBLIC_URL" \
  AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  GROQ_API_KEY="$GROQ_API_KEY" \
  SARVAM_API_KEY="$SARVAM_API_KEY"

echo "Env updated. Trigger deploy from dashboard or: render deploys create \$SERVICE_ID"
