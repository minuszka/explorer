#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

SOURCE=""
TARGET=""
SSH_KEY=""
KEEP=30
MAX_NEW=3
MAX_AGE_HOURS=36
MIN_FREE_GB=20
WORK_DIR=""

usage() {
  cat <<'EOF'
Usage: backup-pull.sh --from SOURCE --to PATH [options]

Copy finished MongoDB backups from the explorer host to this host, and check each copy
against its checksums before it counts. It only reads from the source.

Options:
  --from SOURCE      Backup root to read: account@host: or a local directory
  --to PATH          Local folder for the copies
  --ssh-key FILE     SSH key for account@host:; the host must already be in known_hosts
  --keep N           Copies to keep, newest first (default: 30)
  --max-new N        Backups to fetch in one run, newest first (default: 3)
  --max-age-hours N  Fail if the newest copy is older than this (default: 36)
  --min-free-gb N    Fetch nothing while less than this is free on the disk (default: 20)
  -h, --help         Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) SOURCE="$2"; shift 2 ;;
    --to) TARGET="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --max-new) MAX_NEW="$2"; shift 2 ;;
    --max-age-hours) MAX_AGE_HOURS="$2"; shift 2 ;;
    --min-free-gb) MIN_FREE_GB="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ -n "$SOURCE" ]] || die "--from is required"
[[ -n "$TARGET" ]] || die "--to is required"
[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive integer"
[[ "$MAX_NEW" =~ ^[1-9][0-9]*$ ]] || die "--max-new must be a positive integer"
[[ "$MAX_AGE_HOURS" =~ ^[1-9][0-9]*$ ]] || die "--max-age-hours must be a positive integer"
[[ "$MIN_FREE_GB" =~ ^[0-9]+$ ]] || die "--min-free-gb must be a non-negative integer"
[[ "$SSH_KEY" != *[[:space:]]* ]] || die "--ssh-key must not contain spaces"
for tool in rsync sha256sum realpath mktemp df flock; do
  require_command "$tool"
done

umask 077
TARGET="$(canonical_path "$TARGET")"
mkdir -p "$TARGET"

case "$SOURCE" in
  *:) source_prefix="$SOURCE" ;;
  *) source_prefix="${SOURCE%/}/" ;;
esac

rsync_command=(rsync --timeout=300)
if [[ -n "$SSH_KEY" ]]; then
  rsync_command+=(-e "ssh -i $SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=30")
fi

cleanup() {
  [[ -z "$WORK_DIR" ]] || rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# One run at a time: the next line would remove the work folder of another run.
exec 9<"$TARGET"
flock -n 9 || die "Another copy is running in $TARGET"

# A run that was killed cannot clean up after itself.
find "$TARGET" -mindepth 1 -maxdepth 1 -type d -name '.incoming.*' -exec rm -rf -- {} +
# Beside the copies, so that a finished copy arrives by rename, in one step.
WORK_DIR="$(mktemp -d "$TARGET/.incoming.XXXXXX")"

# Prints the time in a backup's name as seconds since the epoch; fails if it is not a real time.
backup_time() {
  local stamp="${1##*_}"

  date -u -d "${stamp:0:4}-${stamp:4:2}-${stamp:6:2} ${stamp:9:2}:${stamp:11:2}:${stamp:13:2}" '+%s' 2>/dev/null
}

# backup.sh writes .complete last, so a backup still being written is not listed. The names come
# from another host and are used in paths, so only the exact form passes: mode, size, date, time, name.
"${rsync_command[@]}" --list-only --recursive --include="/${BACKUP_LABEL}_*/" --include="/${BACKUP_LABEL}_*/.complete" --exclude='*' \
  "$source_prefix" > "$WORK_DIR/listing" || die "Could not list the backups in $SOURCE"
sed -n -E "s#^-[^ ]+ +[0-9,.]+ [0-9/]+ [0-9:]+ (${BACKUP_LABEL}_[0-9]{8}T[0-9]{6}Z)/\.complete\$#\1#p" "$WORK_DIR/listing" | LC_ALL=C sort -ru > "$WORK_DIR/finished"

now="$(date -u '+%s')"
attempts=0
copied=0
failed=0
while IFS= read -r name; do
  [[ ! -e "$TARGET/$name" ]] || continue
  # A bound on each run: a broken source cannot push every good copy out in one night.
  [[ "$attempts" -lt "$MAX_NEW" ]] || break
  attempts=$((attempts + 1))

  # A backup dated in the future would pass as fresh for as long as that date lasts.
  if ! created="$(backup_time "$name")" || [[ "$created" -gt "$((now + 3600))" ]]; then
    warn "A backup has an impossible time in its name: $name"
    failed=$((failed + 1))
    continue
  fi

  # This host has other work to do, and a full disk would stop that too.
  available_kb="$(df --output=avail -k -- "$TARGET" | tail -n 1)"
  if [[ "$((available_kb / 1048576))" -lt "$MIN_FREE_GB" ]]; then
    warn "Less than $MIN_FREE_GB GB is free on the disk of $TARGET, so $name was not copied"
    failed=$((failed + 1))
    break
  fi

  log "Copying $name"
  # No --links, no --perms: a link is not copied, and the copy gets this script's private modes.
  if ! "${rsync_command[@]}" --recursive --times "$source_prefix$name/" "$WORK_DIR/$name/"; then
    warn "Copying failed: $name"
    failed=$((failed + 1))
    continue
  fi
  if ! (assert_restorable_backup "$WORK_DIR/$name" >/dev/null); then
    warn "The copy did not pass its checks: $name"
    rm -rf -- "${WORK_DIR:?}/$name"
    failed=$((failed + 1))
    continue
  fi
  mv -T -- "$WORK_DIR/$name" "$TARGET/$name"
  copied=$((copied + 1))
done < "$WORK_DIR/finished"

# By count, not by age: when the source stops making backups, the copies stay.
find "$TARGET" -mindepth 1 -maxdepth 1 -type d -name "${BACKUP_LABEL}_*" -printf '%f\n' | LC_ALL=C sort -r > "$WORK_DIR/copies"
position=0
newest=""
while IFS= read -r name; do
  [[ -f "$TARGET/$name/.complete" ]] || continue
  [[ -n "$newest" ]] || newest="$name"
  position=$((position + 1))
  [[ "$position" -gt "$KEEP" ]] || continue
  log "Removing old copy: $name"
  rm -rf -- "$(assert_path_within "$TARGET/$name" "$TARGET")"
done < "$WORK_DIR/copies"

[[ -n "$newest" ]] || die "No copy of a backup exists in $TARGET"
newest_time="$(backup_time "$newest")" || die "The newest copy has an impossible time in its name: $newest"
[[ "$((now - newest_time))" -le "$((MAX_AGE_HOURS * 3600))" ]] || die "The newest copy is $(((now - newest_time) / 3600)) hours old: $newest"
[[ "$failed" -eq 0 ]] || die "$failed backups could not be copied"

log "Backup copy finished: $copied new, newest $newest"
