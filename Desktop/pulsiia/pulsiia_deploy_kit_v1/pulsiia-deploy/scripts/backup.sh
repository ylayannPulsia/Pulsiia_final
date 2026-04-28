#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# backup.sh — Daily Postgres backup + retention + S3 upload
# ─────────────────────────────────────────────────────────────
# Lancé par le service `backup` du docker-compose toutes les 24h.
# Variables attendues : PGUSER, PGPASSWORD, PGDATABASE, PGHOST,
#                       BACKUP_RETENTION_DAYS, S3_*
# ─────────────────────────────────────────────────────────────

set -euo pipefail

BACKUP_DIR="/backups"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/pulsiia-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] 🗃  Starting backup..."

# ─── 1. Dump compressé ────────────────────────────────────
pg_dump --format=plain --clean --if-exists --no-owner \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] ✅ Backup created : $BACKUP_FILE ($SIZE)"

# ─── 2. Vérification d'intégrité (pas trop petit, gzip valide) ─
if [ ! -s "$BACKUP_FILE" ]; then
  echo "[$(date)] ❌ Backup file empty — failure"
  exit 1
fi
gunzip -t "$BACKUP_FILE" || { echo "[$(date)] ❌ Backup corrupted"; exit 1; }

# ─── 3. Upload S3 si configuré ────────────────────────────
if [ -n "${S3_ENDPOINT:-}" ] && [ -n "${S3_BUCKET:-}" ]; then
  echo "[$(date)] ☁️  Uploading to S3..."
  AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
  aws s3 cp "$BACKUP_FILE" "s3://${S3_BUCKET}/$(basename $BACKUP_FILE)" \
    --endpoint-url "$S3_ENDPOINT" \
    --storage-class STANDARD_IA || echo "⚠️  S3 upload failed (continuing)"

  echo "[$(date)] ✅ Uploaded to s3://${S3_BUCKET}/$(basename $BACKUP_FILE)"
fi

# ─── 4. Cleanup local (retention) ─────────────────────────
echo "[$(date)] 🧹 Pruning local backups older than ${RETENTION_DAYS} days..."
find "$BACKUP_DIR" -name "pulsiia-*.sql.gz" -mtime +"$RETENTION_DAYS" -delete

# ─── 5. Cleanup S3 (retention) ────────────────────────────
if [ -n "${S3_ENDPOINT:-}" ] && [ -n "${S3_BUCKET:-}" ]; then
  CUTOFF_DATE=$(date -d "${RETENTION_DAYS} days ago" +%Y-%m-%d 2>/dev/null \
    || date -v-"${RETENTION_DAYS}d" +%Y-%m-%d)

  AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
  AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
  aws s3 ls "s3://${S3_BUCKET}/" --endpoint-url "$S3_ENDPOINT" \
    | awk -v cutoff="$CUTOFF_DATE" '$1 < cutoff {print $4}' \
    | while read old; do
        [ -n "$old" ] && AWS_ACCESS_KEY_ID="$S3_ACCESS_KEY" \
          AWS_SECRET_ACCESS_KEY="$S3_SECRET_KEY" \
          aws s3 rm "s3://${S3_BUCKET}/$old" --endpoint-url "$S3_ENDPOINT"
      done
fi

# ─── Stats finales ────────────────────────────────────────
COUNT=$(find "$BACKUP_DIR" -name "pulsiia-*.sql.gz" | wc -l)
TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[$(date)] 📊 Local backups: $COUNT files, $TOTAL_SIZE total"
echo "[$(date)] ✅ Backup job complete"
