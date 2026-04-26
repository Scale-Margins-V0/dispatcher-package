#!/usr/bin/env bash
set -euo pipefail

if [ -f ".env" ]; then
  # shellcheck disable=SC1091
  source ".env"
fi

export PORT="${PORT:-3100}"
export USER_LOOKUP_CONFIG_PATH="${USER_LOOKUP_CONFIG_PATH:-./config/dispatch.scalemargin-local.yaml}"
export EMAIL_PROVIDER="${EMAIL_PROVIDER:-sendgrid}"
export FROM_EMAIL="${FROM_EMAIL:-campaigns@your-domain.com}"

: "${SCALEMARGIN_DISPATCH_SECRET:?SCALEMARGIN_DISPATCH_SECRET is required}"
: "${SCALEMARGIN_ANALYTICS_SECRET:?SCALEMARGIN_ANALYTICS_SECRET is required}"

# Keep this empty so dispatch uses sqlite user_lookup email resolution.
export DEV_RECIPIENT_EMAIL="${DEV_RECIPIENT_EMAIL:-}"

pnpm dev
