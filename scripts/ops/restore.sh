#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups/mongodb}"
SELECTED_BACKUP=""
DRY_RUN=0
CONFIRMED=0
ALLOW_UNVERIFIED=0
SERVICE_STOPPED=0
MONGO_CONFIG=""
RESTORE_LOG=""

usage() {
  cat <<'EOF'
Usage: restore.sh --backup PATH [options]

Restore a verified MongoDB dump. A safety backup is created first.

Options:
  --backup PATH      Backup directory below the configured backup root
  --dry-run          Validate only; do not stop services or modify MongoDB
  --yes              Required confirmation for a real restore
  --allow-unverified Accept a backup from before checksums
  --app-dir PATH     Application checkout (default: this checkout)
  --backup-dir PATH  Backup root (default: APP_DIR/backups/mongodb)
  --service NAME     systemd service (default: deftrack.service)
  --health-url URL   Readiness endpoint
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) SELECTED_BACKUP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) CONFIRMED=1; shift ;;
    --allow-unverified) ALLOW_UNVERIFIED=1; shift ;;
    --app-dir) APP_DIR="$2"; ENV_FILE="$APP_DIR/.env"; BACKUP_DIR="$APP_DIR/backups/mongodb"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --health-url) HEALTH_URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$SELECTED_BACKUP" ]] || die "--backup is required"
require_command mongorestore
require_command mongodump
require_command realpath
require_command curl

APP_DIR="$(canonical_path "$APP_DIR")"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="$(canonical_path "$BACKUP_DIR")"

if [[ "$SELECTED_BACKUP" != /* ]]; then
  SELECTED_BACKUP="$BACKUP_DIR/$SELECTED_BACKUP"
fi
SELECTED_BACKUP="$(assert_path_within "$SELECTED_BACKUP" "$BACKUP_DIR")"

collection_count="$(assert_restorable_backup "$SELECTED_BACKUP" "$ALLOW_UNVERIFIED")"
mongo_uri="$(resolve_mongo_uri)"
# A URI that names a database makes mongorestore read the path as that database's folder.
# Given the backup itself, it would skip everything and still exit 0.
restore_source="$SELECTED_BACKUP"
database="$(mongo_uri_database "$mongo_uri")"
if [[ -n "$database" ]]; then
  restore_source="$SELECTED_BACKUP/$database"
  [[ -d "$restore_source" ]] || die "Backup holds no folder for the database in MONGODB_URI: $database"
fi

log "Validated backup: $(basename "$SELECTED_BACKUP") ($collection_count collections)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry run complete; service and database state were not changed"
  exit 0
fi

[[ "$CONFIRMED" -eq 1 ]] || die "A real restore requires --yes"

cleanup() {
  [[ -z "$MONGO_CONFIG" ]] || rm -f -- "$MONGO_CONFIG"
  [[ -z "$RESTORE_LOG" ]] || rm -f -- "$RESTORE_LOG"
  if [[ "$SERVICE_STOPPED" -eq 1 ]]; then
    run_privileged systemctl start "$SERVICE_NAME" || true
  fi
}
trap cleanup EXIT

log "Creating a safety backup before restore"
# Pass APP_DIR and ENV_FILE through the environment: backup.sh --app-dir would
# reset ENV_FILE to $APP_DIR/.env and ignore a custom ENV_FILE. --no-prune keeps
# the retention pass from deleting existing backups, including the selected one.
safety_backup="$(APP_DIR="$APP_DIR" ENV_FILE="$ENV_FILE" \
  bash "$SCRIPT_DIR/backup.sh" --backup-dir "$BACKUP_DIR" --no-prune | tail -n 1)"
log "Safety backup: $safety_backup"
# Only now: the safety backup takes the lock itself. A scheduled backup may have run in between.
lock_backup_root
assert_restorable_backup "$SELECTED_BACKUP" "$ALLOW_UNVERIFIED" >/dev/null

RESTORE_LOG="$(mktemp)"
MONGO_CONFIG="$(create_mongo_tool_config "$mongo_uri")"
log "Stopping $SERVICE_NAME"
run_privileged systemctl stop "$SERVICE_NAME"
SERVICE_STOPPED=1

log "Restoring MongoDB with --drop"
if ! mongorestore --config="$MONGO_CONFIG" --gzip --drop "$restore_source" 2>&1 | tee "$RESTORE_LOG"; then
  die "mongorestore failed; the database may be partly restored. Safety backup: $safety_backup"
fi
check_restore_log "$RESTORE_LOG" "$restore_source" \
  || die "The restore did not complete; the database may be partly restored. Safety backup: $safety_backup"

log "Starting $SERVICE_NAME"
run_privileged systemctl start "$SERVICE_NAME"
SERVICE_STOPPED=0
rm -f -- "$MONGO_CONFIG" "$RESTORE_LOG"
MONGO_CONFIG=""
RESTORE_LOG=""

if ! wait_for_health 30 2; then
  run_privileged systemctl status "$SERVICE_NAME" --no-pager || true
  die "Restore completed, but application readiness did not recover"
fi

trap - EXIT
log "Restore completed successfully"
