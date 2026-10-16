#!/usr/bin/env bash
# Starts a throwaway PostgreSQL for the row-level security suite.
#
# Those tests apply supabase/schema.sql to a real server and exercise the
# policies as the `authenticated` role, so they need a live PostgreSQL 16 with
# pgcrypto and btree_gist. Any instance will do -- point PGHOST/PGPORT at one
# you already have. This script is for when you do not.
#
#   source supabase/test/start-postgres.sh && npm test
set -euo pipefail

PGDIR="${TABIB_PGDIR:-/var/tmp/tabibpg}"
PGPORT="${TABIB_PGPORT:-55432}"
PGBIN="${TABIB_PGBIN:-/usr/lib/postgresql/16/bin}"

if [ ! -x "$PGBIN/initdb" ]; then
  echo "PostgreSQL 16 not found at $PGBIN. Set TABIB_PGBIN." >&2
  return 1 2>/dev/null || exit 1
fi

# initdb refuses to run as root, so the data directory belongs to the postgres
# system user and the server is started as them.
RUN_AS=""
if [ "$(id -u)" = "0" ] && id postgres >/dev/null 2>&1; then
  RUN_AS="postgres"
fi

run() {
  if [ -n "$RUN_AS" ]; then su "$RUN_AS" -s /bin/bash -c "$1"; else bash -c "$1"; fi
}

if [ ! -d "$PGDIR/data" ]; then
  mkdir -p "$PGDIR"
  [ -n "$RUN_AS" ] && chown "$RUN_AS:$RUN_AS" "$PGDIR"
  chmod 700 "$PGDIR"
  run "$PGBIN/initdb -D $PGDIR/data -U postgres --auth=trust" >/dev/null
fi

if ! "$PGBIN/pg_isready" -h "$PGDIR" -p "$PGPORT" >/dev/null 2>&1; then
  run "$PGBIN/pg_ctl -D $PGDIR/data -o '-p $PGPORT -k $PGDIR' -l $PGDIR/log start" >/dev/null
  sleep 2
fi

export PGHOST="$PGDIR"
export PGPORT="$PGPORT"
export PGUSER=postgres
"$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT"
