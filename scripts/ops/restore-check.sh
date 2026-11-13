#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP_DIR="${BACKUP_DIR:-${APP_DIR}/backups/mongodb}"
SELECTED_BACKUP=""
DRY_RUN=0
ALLOW_UNVERIFIED=0
WORK_DIR=""
MONGOD_PID=""

usage() {
  cat <<'EOF'
Usage: restore-check.sh [options]

Prove that a backup can be restored: load it into a throwaway MongoDB and compare
the documents restored with the documents in the backup. The live database and the
service are not touched.

Options:
  --backup PATH      Backup directory below the backup root (default: the newest complete one)
  --dry-run          Validate only; do not start a throwaway MongoDB
  --allow-unverified Accept a backup from before checksums
  --app-dir PATH     Application checkout (default: this checkout)
  --backup-dir PATH  Backup root (default: APP_DIR/backups/mongodb)
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup) SELECTED_BACKUP="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --allow-unverified) ALLOW_UNVERIFIED=1; shift ;;
    --app-dir) APP_DIR="$2"; BACKUP_DIR="$APP_DIR/backups/mongodb"; shift 2 ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

for tool in mongod mongorestore bsondump gzip nice mktemp realpath sha256sum; do
  require_command "$tool"
done

BACKUP_DIR="$(canonical_path "$BACKUP_DIR")"
[[ -d "$BACKUP_DIR" ]] || die "No complete backup found in $BACKUP_DIR"
# Before choosing: a backup being written comes to be the choice, and no retention pass removes the choice.
[[ "$DRY_RUN" -eq 1 ]] || lock_backup_root

if [[ -z "$SELECTED_BACKUP" ]]; then
  # The timestamp in the name sorts by age.
  while IFS= read -r candidate; do
    if [[ -f "$candidate/.complete" ]]; then
      SELECTED_BACKUP="$candidate"
      break
    fi
  done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name "${BACKUP_LABEL}_*" | LC_ALL=C sort -r)
  [[ -n "$SELECTED_BACKUP" ]] || die "No complete backup found in $BACKUP_DIR"
elif [[ "$SELECTED_BACKUP" != /* ]]; then
  SELECTED_BACKUP="$BACKUP_DIR/$SELECTED_BACKUP"
fi
SELECTED_BACKUP="$(assert_path_within "$SELECTED_BACKUP" "$BACKUP_DIR")"
collection_count="$(assert_restorable_backup "$SELECTED_BACKUP" "$ALLOW_UNVERIFIED")"

log "Checking backup: $(basename "$SELECTED_BACKUP") ($collection_count collections)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry run complete; no MongoDB was started"
  exit 0
fi

cleanup() {
  if [[ -n "$MONGOD_PID" ]] && kill -0 "$MONGOD_PID" 2>/dev/null; then
    kill "$MONGOD_PID" 2>/dev/null || true
    wait "$MONGOD_PID" 2>/dev/null || true
  fi
  [[ -z "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# A hidden, private folder beside the backups: same disk, and no backup pattern matches it.
WORK_DIR="$(mktemp -d "$BACKUP_DIR/.restore-check.XXXXXX")"
mkdir "$WORK_DIR/db"
restore_log="$WORK_DIR/restore.log"

# This MongoDB has no password, so it listens only on a socket in the private folder and on no
# TCP port. No other local account can reach the copy of the data, and the restore cannot reach
# any other server: only this MongoDB can create that socket.
socket="$WORK_DIR/mongod.sock"
log "Starting a throwaway MongoDB"
nice -n 10 mongod --dbpath "$WORK_DIR/db" --bind_ip "$socket" --unixSocketPrefix "$WORK_DIR" \
  --wiredTigerCacheSizeGB 0.25 --logpath "$WORK_DIR/mongod.log" --quiet 8<&- &
MONGOD_PID=$!

ready=0
for ((attempt = 1; attempt <= 120; attempt++)); do
  kill -0 "$MONGOD_PID" 2>/dev/null || break
  if [[ -e "$socket" ]]; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ "$ready" -ne 1 ]]; then
  tail -n 5 "$WORK_DIR/mongod.log" >&2 2>/dev/null || true
  die "The throwaway MongoDB did not start"
fi

log "Restoring into the throwaway MongoDB"
if ! nice -n 10 mongorestore --uri="mongodb://${socket//\//%2F}/" --gzip "$SELECTED_BACKUP" > "$restore_log" 2>&1; then
  tail -n 5 "$restore_log" >&2
  die "mongorestore failed on $(basename "$SELECTED_BACKUP")"
fi
check_restore_log "$restore_log" "$SELECTED_BACKUP" || die "The backup did not restore completely: $(basename "$SELECTED_BACKUP")"

log "Comparing documents in the backup with documents restored"
collection_files="$(find "$SELECTED_BACKUP" -type f -name '*.bson.gz' ! -name 'system.*' | LC_ALL=C sort)"
total=0
mismatches=0
while IFS= read -r file; do
  relative="${file#"$SELECTED_BACKUP"/}"
  namespace="${relative%.bson.gz}"
  namespace="${namespace/\//.}"
  in_backup="$({ gzip -dc -- "$file" | bsondump --outFile=/dev/null; } 2>&1 | sed -n -E 's/.*[^0-9]([0-9]+) objects? found.*/\1/p' | tail -n 1)" \
    || die "Could not read $relative"
  # mongorestore 100.15 prints the name bare, 100.18 in backticks.
  restored="$( (grep -F -e "finished restoring $namespace (" -e "finished restoring \`$namespace\` (" "$restore_log" || true) | sed -n -E 's/.*\(([0-9]+) documents?,.*/\1/p' | tail -n 1)"
  if [[ -z "$in_backup" || "$in_backup" != "$restored" ]]; then
    warn "$namespace: ${in_backup:-unknown} in the backup, ${restored:-none} restored"
    mismatches=$((mismatches + 1))
  else
    log "$namespace: $restored documents"
    total=$((total + restored))
  fi
done <<< "$collection_files"
[[ "$mismatches" -eq 0 ]] || die "$mismatches collections differ in $(basename "$SELECTED_BACKUP")"

log "Restore check passed: $(basename "$SELECTED_BACKUP") restored $total documents"
