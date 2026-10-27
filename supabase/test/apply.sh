#!/usr/bin/env bash
# Applies the schema, and optionally the seed, to a database.
#
#   ./supabase/test/apply.sh "$DATABASE_URL"          # schema only
#   ./supabase/test/apply.sh "$DATABASE_URL" --seed   # schema + sample data
#
# Both files are written to be re-runnable, so this is also how you apply a
# change to a database that already has the previous version.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
url="${1:-${DATABASE_URL:-}}"

if [[ -z "$url" ]]; then
  echo "usage: $0 <postgres-url> [--seed]" >&2
  echo "   or: DATABASE_URL=... $0 [--seed]" >&2
  exit 64
fi

echo "→ applying schema"
psql "$url" --quiet --set ON_ERROR_STOP=1 -f "$here/schema.sql"

if [[ "${2:-${1:-}}" == "--seed" ]]; then
  echo "→ applying seed data"
  psql "$url" --quiet --set ON_ERROR_STOP=1 -f "$here/seed.sql"
fi

echo "✓ done"
