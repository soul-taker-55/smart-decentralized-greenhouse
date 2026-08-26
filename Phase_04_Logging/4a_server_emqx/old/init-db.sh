#!/bin/bash
# init-db.sh — Auto-initialize SDIGF database schema from GitHub
# This script runs automatically when the Postgres container starts for the first time.
# It downloads the schema from GitHub and applies it idempotently.
# Safe to re-run: uses IF NOT EXISTS everywhere.
set -e
SCHEMA_URL="https://raw.githubusercontent.com/soul-taker-55/smart-decentralized-greenhouse/main/Phase_04_Logging/db/sdigf-db-schema-v2.sql"
SCHEMA_FILE="/tmp/sdigf-db-schema.sql"
echo "[$(date)] =========================================="
echo "[$(date)] SDIGF Schema Initialization"
echo "[$(date)] =========================================="
# Check if schema already exists (safety)
EXISTING_TABLES=$(psql -U postgres -d sdigf_db -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo "0")
if [ "$EXISTING_TABLES" -gt 0 ]; then
  echo "[$(date)] Schema already exists ($EXISTING_TABLES tables). Skipping init."
  exit 0
fi
echo "[$(date)] No schema found. Downloading from GitHub..."
# Download schema (try wget first, then curl as fallback)
if command -v wget &> /dev/null; then
  if wget -q -O "$SCHEMA_FILE" "$SCHEMA_URL" 2>/dev/null; then
    echo "[$(date)] Downloaded schema via wget"
  else
    echo "[$(date)] wget failed, trying curl..."
    if command -v curl &> /dev/null && curl -s -o "$SCHEMA_FILE" "$SCHEMA_URL"; then
      echo "[$(date)] Downloaded schema via curl"
    else
      echo "[$(date)] ERROR: Could not download schema from $SCHEMA_URL"
      exit 1
    fi
  fi
elif command -v curl &> /dev/null; then
  if curl -s -o "$SCHEMA_FILE" "$SCHEMA_URL"; then
    echo "[$(date)] Downloaded schema via curl"
  else
    echo "[$(date)] ERROR: Could not download schema from $SCHEMA_URL"
    exit 1
  fi
else
  echo "[$(date)] ERROR: Neither wget nor curl available in container"
  exit 1
fi
if [ ! -f "$SCHEMA_FILE" ]; then
  echo "[$(date)] ERROR: Schema file not found at $SCHEMA_FILE"
  exit 1
fi
echo "[$(date)] Schema file size: $(wc -c < "$SCHEMA_FILE") bytes"
echo "[$(date)] Applying schema to sdigf_db..."
# Apply schema
if psql -U postgres -d sdigf_db < "$SCHEMA_FILE"; then
  echo "[$(date)] ✓ Schema applied successfully"
else
  echo "[$(date)] ERROR: Schema application failed"
  exit 1
fi

# Apply migrations
echo "[$(date)] Applying migrations..."
MIGRATIONS_BASE="https://raw.githubusercontent.com/soul-taker-55/smart-decentralized-greenhouse/main/Phase_04_Logging/db/migrations"
MIGRATION_FILES=("003_cfg_src_none.sql")

for m in "${MIGRATION_FILES[@]}"; do
  MFILE="/tmp/$m"
  echo "[$(date)] Fetching migration: $m"
  if command -v wget &> /dev/null; then
    wget -q -O "$MFILE" "$MIGRATIONS_BASE/$m"
  else
    curl -s -o "$MFILE" "$MIGRATIONS_BASE/$m"
  fi
  if [ -s "$MFILE" ]; then
    if psql -U postgres -d sdigf_db < "$MFILE"; then
      echo "[$(date)] ✓ Applied $m"
    else
      echo "[$(date)] ERROR: Failed to apply $m"
      exit 1
    fi
    rm -f "$MFILE"
  else
    echo "[$(date)] ERROR: Could not download migration $m"
    exit 1
  fi
done

# Verify
echo "[$(date)] Verifying schema..."
TABLE_COUNT=$(psql -U postgres -d sdigf_db -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public';")
echo "[$(date)] Tables created: $TABLE_COUNT"
TIMESCALEDB_LOADED=$(psql -U postgres -d sdigf_db -t -c "SELECT COUNT(*) FROM pg_extension WHERE extname='timescaledb';" || echo "0")
if [ "$TIMESCALEDB_LOADED" -eq 1 ]; then
  echo "[$(date)] ✓ TimescaleDB extension loaded"
else
  echo "[$(date)] WARNING: TimescaleDB extension not loaded"
fi
echo "[$(date)] =========================================="
echo "[$(date)] Schema initialization complete"
echo "[$(date)] =========================================="
# Cleanup
rm -f "$SCHEMA_FILE"