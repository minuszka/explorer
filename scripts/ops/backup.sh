#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups/mongodb}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
DRY_RUN=0
PRUNE=1

usage() {
  cat <<'EOF'
Usage: backup.sh [options]

Create a compressed MongoDB backup without exposing credentials.

Options:
  --dry-run          Validate configuration without writing a backup
  --app-dir PATH     Application checkout (default: this checkout)
  --backup-dir PATH  Backup root (default: APP_DIR/backups/mongodb)
  --keep-days N      Retention period (default: 14)
  --no-prune         Keep all existing backups (skip the retention pass)
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --app-dir) APP_DIR="$2"; ENV_FILE="$APP_DIR/.env"; BACKUP_DIR="$APP_DIR/backups/mongodb"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --keep-days) KEEP_DAYS="$2"; shift 2 ;;
    --no-prune) PRUNE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$KEEP_DAYS" =~ ^[0-9]+$ ]] || die "--keep-days must be a non-negative integer"
require_command mongodump
require_command realpath

APP_DIR="$(canonical_path "$APP_DIR")"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="$(canonical_path "$BACKUP_DIR")"
mongo_uri="$(resolve_mongo_uri)"
# A dump holds the whole database: the owner and the group of the backup root, nobody else.
umask 027
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
backup_path="${BACKUP_DIR}/${BACKUP_LABEL}_${timestamp}"
mongo_config=""

log "Backup target: $backup_path"
if [[ "$PRUNE" -eq 1 ]]; then
  log "Retention: $KEEP_DAYS days"
else
  log "Retention: disabled (--no-prune)"
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry run complete; MongoDB credentials were resolved but no data was read or written"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
lock_backup_root
# Named after the wait for the lock: the name must not date the backup before its data.
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
backup_path="${BACKUP_DIR}/${BACKUP_LABEL}_${timestamp}"
assert_path_within "$backup_path" "$BACKUP_DIR" >/dev/null
# The name has one-second resolution, and mongodump would write into an existing folder. A
# safety backup could overwrite the very backup that is about to be restored.
mkdir -- "$backup_path" 2>/dev/null || die "Backup already exists, try again in a second: $backup_path"

cleanup() {
  [[ -z "$mongo_config" ]] || rm -f -- "$mongo_config"
  if [[ -d "$backup_path" && ! -f "$backup_path/.complete" ]]; then
    rm -rf -- "$backup_path"
  fi
}
trap cleanup EXIT

log "Creating compressed MongoDB dump"
mongo_config="$(create_mongo_tool_config "$mongo_uri")"
mongodump --config="$mongo_config" --out="$backup_path" --gzip --quiet

# Network noise receipt retention records a sequence on the node's baseline before it
# deletes the receipt. Baselines read after the receipts therefore cover every receipt
# missing from the dump, however long it took, so they are read again last.
baseline_files="$(find "$backup_path" -type f -name 'networknoisebaselines.bson.gz')"
while IFS= read -r baseline_file; do
  [[ -n "$baseline_file" ]] || continue
  mongodump --config="$mongo_config" --out="$backup_path" --gzip --quiet \
    --db="$(basename "$(dirname "$baseline_file")")" --collection=networknoisebaselines
done <<< "$baseline_files"

collection_count="$(find "$backup_path" -type f -name '*.bson.gz' | wc -l | tr -d ' ')"
[[ "$collection_count" -gt 0 ]] || die "Backup contains no BSON collections"

commit="$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
{
  printf 'created_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  printf 'git_commit=%s\n' "$commit"
  printf 'collections=%s\n' "$collection_count"
} > "$backup_path/backup.meta"
write_backup_checksums "$backup_path"
touch "$backup_path/.complete"
rm -f -- "$mongo_config"
mongo_config=""

if [[ "$PRUNE" -eq 1 ]]; then
  while IFS= read -r -d '' old_backup; do
    validated_old="$(assert_path_within "$old_backup" "$BACKUP_DIR")"
    [[ -f "$validated_old/.complete" ]] || continue
    log "Removing expired backup: $(basename "$validated_old")"
    rm -rf -- "$validated_old"
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name "${BACKUP_LABEL}_*" -mtime "+$KEEP_DAYS" -print0)
fi

size="$(du -sh "$backup_path" | cut -f1)"
log "Backup completed: $collection_count collections, $size"
printf '%s\n' "$backup_path"
trap - EXIT
