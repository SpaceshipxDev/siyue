#!/usr/bin/env bash
# Deploy current HEAD of origin/main to the production VM.
# See AGENTS.md ("Architecture & Deployment") for the full picture.
set -euo pipefail

REMOTE="root@47.238.237.229"
APP_DIR="/srv/siyue"
PM2_NAME="siyue"

echo "→ pushing local main to origin"
git push origin main

echo "→ deploying to $REMOTE:$APP_DIR"
ssh "$REMOTE" "cd $APP_DIR && git pull --ff-only && npm ci && npm run build && pm2 restart $PM2_NAME --update-env && pm2 list"

echo "✓ deploy complete"
