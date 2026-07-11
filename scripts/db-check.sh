#!/usr/bin/env bash
# Read-only smoke test: proves an agent can execute a DB script non-interactively.
set -euo pipefail
cd "$(dirname "$0")/.."
DATABASE_URL="$(grep -E '^\s*DATABASE_URL\s*=' .env.local | head -1 | sed -E 's/^[^=]+=//; s/^["'\'']//; s/["'\'']\s*$//')"
PSQL="$(command -v psql || true)"; [ -z "$PSQL" ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
"$PSQL" "$DATABASE_URL" -tAc "select 'OK agent can execute — '||current_database()||' @ '||now()::timestamp(0)"
