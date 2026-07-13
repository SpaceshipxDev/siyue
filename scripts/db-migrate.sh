#!/usr/bin/env bash
# Apply pending supabase/migrations/*.sql to the database in DATABASE_URL.
# Idempotent: tracks applied files in a _migrations ledger table and skips them.
# Each file + its ledger insert run in ONE transaction (ON_ERROR_STOP), so a
# failing migration rolls back cleanly and is retried next run.
#
# Usage:
#   ./scripts/db-migrate.sh            # apply all pending
#   ./scripts/db-migrate.sh --dry-run  # list pending without applying
set -euo pipefail
cd "$(dirname "$0")/.."

# --- load DATABASE_URL from .env.local (same parser style as the .mjs scripts) ---
if [ -f .env.local ]; then
  DATABASE_URL="$(grep -E '^\s*DATABASE_URL\s*=' .env.local | head -1 | sed -E 's/^[^=]+=//; s/^["'\'']//; s/["'\'']\s*$//')"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set. Add it to .env.local (Supabase → Settings → Database → Connection string)." >&2
  exit 1
fi

# --- locate psql (PATH, or homebrew keg-only libpq) ---
PSQL="$(command -v psql || true)"
[ -z "$PSQL" ] && [ -x /opt/homebrew/opt/libpq/bin/psql ] && PSQL=/opt/homebrew/opt/libpq/bin/psql
[ -z "$PSQL" ] && [ -x /usr/local/opt/libpq/bin/psql ] && PSQL=/usr/local/opt/libpq/bin/psql
if [ -z "$PSQL" ]; then
  echo "ERROR: psql not found. Install with: brew install libpq" >&2
  exit 1
fi

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

# ledger table
"$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "create table if not exists _migrations (name text primary key, applied_at timestamptz default now());"

applied_any=0
for f in supabase/migrations/*.sql; do
  name="$(basename "$f")"
  done="$("$PSQL" "$DATABASE_URL" -tAq -c "select 1 from _migrations where name='$name'")"
  if [ "$done" = "1" ]; then
    continue
  fi
  if [ "$DRY" = "1" ]; then
    echo "PENDING  $name"
    continue
  fi
  echo "applying $name ..."
  # file + ledger insert in a single transaction; aborts on first error
  "$PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q --single-transaction \
    -f "$f" \
    -c "insert into _migrations(name) values ('$name');"
  echo "  ok"
  applied_any=1
done

[ "$DRY" = "1" ] && exit 0
[ "$applied_any" = "0" ] && echo "Up to date — nothing to apply."
echo "Done."
