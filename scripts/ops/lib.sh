#!/usr/bin/env bash

set -Eeuo pipefail

# Default checkout: the repository that contains this script (scripts/ops/..).
APP_DIR="${APP_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
# Account that runs git/npm when a script runs as root. Empty = owner of APP_DIR.
APP_OWNER="${APP_OWNER:-}"
SERVICE_NAME="${SERVICE_NAME:-deftrack.service}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health/ready}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
BACKUP_LABEL="defcon_explorer"
BACKUP_CHECKSUMS="backup.sha256"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

warn() {
  printf '[%s] WARNING: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
}

die() {
  printf '[%s] ERROR: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

read_env_value() {
  local key="$1"
  local file="${2:-$ENV_FILE}"
  local value

  [[ -f "$file" ]] || return 1
  value="$(awk -v key="$key" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$file")"
  value="${value%$'\r'}"

  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

resolve_mongo_uri() {
  if [[ -n "${MONGODB_URI:-}" ]]; then
    printf '%s' "$MONGODB_URI"
    return 0
  fi

  read_env_value MONGODB_URI "$ENV_FILE" || die "MONGODB_URI is not set and was not found in $ENV_FILE"
}

create_mongo_tool_config() {
  local mongo_uri="$1"
  local config_file
  local quoted_uri

  require_command mktemp
  require_command chmod
  require_command node

  config_file="$(mktemp)"
  chmod 600 "$config_file"
  # Pass the URI through the environment, not argv, so it never shows up in ps.
  quoted_uri="$(DEFTRACK_MONGO_URI="$mongo_uri" node -e 'process.stdout.write(JSON.stringify(process.env.DEFTRACK_MONGO_URI))')"
  printf 'uri: %s\n' "$quoted_uri" > "$config_file"
  printf '%s' "$config_file"
}

run_as_app() {
  local owner

  if [[ "$(id -u)" -ne 0 ]]; then
    "$@"
    return
  fi

  owner="$APP_OWNER"
  if [[ -z "$owner" ]]; then
    require_command stat
    owner="$(stat -L -c '%U' -- "$APP_DIR" 2>/dev/null || true)"
  fi
  [[ -n "$owner" && "$owner" != "UNKNOWN" ]] || die "APP_OWNER is not set and the owner of $APP_DIR could not be determined"

  if [[ "$owner" == "root" ]]; then
    "$@"
  else
    require_command sudo
    sudo -u "$owner" -- "$@"
  fi
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    require_command sudo
    sudo -- "$@"
  fi
}

# Prints the database a MongoDB URI names, nothing if it names none. Credentials stay out of it.
mongo_uri_database() {
  local rest="${1#*://}"

  rest="${rest%%\?*}"
  [[ "$rest" == */* ]] && printf '%s' "${rest##*/}"
  return 0
}

# One at a time per backup root: a retention pass must not remove what a restore or a restore check is
# reading, a check must see the newest backup, and a backup must not read a database being restored.
# The kernel drops this lock when the process ends, however it ends.
lock_backup_root() {
  require_command flock
  exec 8<"$BACKUP_DIR"
  flock -w "${BACKUP_LOCK_WAIT_SECONDS:-3600}" 8 || die "Another backup, restore or restore check is still running in $BACKUP_DIR"
}

# Lists a backup's files with their checksums, all but the two that mark it finished.
list_backup_files() {
  find . -type f ! -name "$BACKUP_CHECKSUMS" ! -name .complete -print0 | LC_ALL=C sort -z
}

write_backup_checksums() {
  (cd -- "$1" && list_backup_files | xargs -0 sha256sum) > "$1/$BACKUP_CHECKSUMS"
}

# Prints the number of collections in a backup, or stops if it cannot be restored. A file lost or
# changed after the backup finished would otherwise go unnoticed: what remains can restore fine,
# without its indexes for example. A backup from before checksums passes only if the caller allows it.
assert_restorable_backup() {
  local backup="$1"
  local allow_unverified="${2:-0}"
  local count
  local listed
  local present

  [[ -d "$backup" ]] || die "Backup directory not found: $backup"
  [[ -f "$backup/.complete" ]] || die "Backup is incomplete or was not produced by the supported backup workflow"
  count="$(find "$backup" -type f -name '*.bson.gz' | wc -l | tr -d ' ')"
  [[ "$count" -gt 0 ]] || die "Backup contains no BSON collections"
  if [[ -f "$backup/$BACKUP_CHECKSUMS" ]]; then
    (cd -- "$backup" && sha256sum --check --quiet --strict "$BACKUP_CHECKSUMS") >&2 \
      || die "Files in the backup were lost or changed: $backup"
    listed="$(wc -l < "$backup/$BACKUP_CHECKSUMS" | tr -d ' ')"
    present="$(cd -- "$backup" && list_backup_files | tr -cd '\0' | wc -c | tr -d ' ')"
    [[ "$listed" -eq "$present" ]] || die "The backup holds files its checksums do not list: $backup"
  elif [[ "$allow_unverified" -eq 1 ]]; then
    warn "Backup has no checksums, so lost or changed files cannot be noticed: $backup"
  else
    die "Backup has no checksums: $backup. Make a new backup, or accept the risk with --allow-unverified"
  fi
  printf '%s' "$count"
}

# mongorestore exits 0 even when it skipped every file, so a restore counts only if its
# own log shows that every collection finished, documents were restored and none failed.
# mongorestore handles system collections itself and does not report them.
check_restore_log() {
  local log_file="$1"
  local source_dir="$2"
  local summary
  local restored
  local failed
  local finished
  local expected

  summary="$(sed -n -E 's/^(.*[^0-9])?([0-9]+) document\(s\) restored successfully\. ([0-9]+) document\(s\) failed to restore\..*/\2 \3/p' "$log_file" | tail -n 1)"
  if [[ -z "$summary" ]]; then
    warn "mongorestore did not report how many documents it restored"
    return 1
  fi
  restored="${summary% *}"
  failed="${summary#* }"
  finished="$(grep -c 'finished restoring' "$log_file" || true)"
  expected="$(find "$source_dir" -type f -name '*.bson.gz' ! -name 'system.*' | wc -l | tr -d ' ')"
  if [[ "$failed" -ne 0 ]]; then
    warn "mongorestore failed to restore $failed documents"
    return 1
  fi
  if [[ "$restored" -eq 0 ]]; then
    warn "mongorestore restored no documents"
    return 1
  fi
  if [[ "$finished" -ne "$expected" ]]; then
    warn "mongorestore finished $finished collections of $expected"
    return 1
  fi
}

canonical_path() {
  realpath -m -- "$1"
}

assert_path_within() {
  local candidate
  local base
  candidate="$(canonical_path "$1")"
  base="$(canonical_path "$2")"

  case "$candidate" in
    "$base"/*) printf '%s' "$candidate" ;;
    *) die "Path escapes the allowed directory: $candidate (base: $base)" ;;
  esac
}

wait_for_health() {
  local attempts="${1:-20}"
  local delay_seconds="${2:-2}"
  local response

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    response="$(curl --silent --show-error --fail --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
    if [[ "$response" == *'"status":"ok"'* ]]; then
      log "Health check passed: $HEALTH_URL"
      return 0
    fi
    sleep "$delay_seconds"
  done

  return 1
}

# Publishes a finished client build into the directory the server reads. The running
# server keeps its index.html in memory and asks for that build's hashed files from disk,
# and browser tabs opened before the switch ask for lazy chunks long after it. So files
# arrive by rename with index.html last, and no hashed file goes away here: whichever server
# is running may need any of them until confirm_client_release is told that the new one is ready.
# The records of the releases live elsewhere, because everything in the target is public.
# Lists are written to a file before they are acted on: inside a process substitution a failure of
# find, sort or comm would pass unnoticed, and an incomplete list would be taken for a complete one.
publish_client_build() {
  local staging="$1"
  local target="$2"
  local releases="$3"
  local known="$releases/.known"
  local scan="$releases/.scan"
  local unrecorded="$releases/.unrecorded"
  local attempt number rel

  [[ -f "$staging/index.html" ]] || die "Client build has no index.html: $staging"
  [[ -n "$(find "$staging/assets" -type f -print -quit 2>/dev/null)" ]] || die "Client build has no assets: $staging"

  mkdir -p "$target/assets" "$releases"

  # Numbered, not timed: a clock that steps back must not make the newest record look the oldest.
  number="$(find "$releases" -type f \( -name '*.list' -o -name '*.attempt' \) -printf '%f\n' | sed 's/[^0-9].*//' | LC_ALL=C sort | tail -n 1)"
  number="$((10#${number:-0} + 1))"

  # Files built in place have no record; together they count as one release.
  find "$releases" -type f \( -name '*.list' -o -name '*.attempt' \) -exec cat {} + | LC_ALL=C sort -u > "$known"
  (cd "$target" && find assets -type f | LC_ALL=C sort) | LC_ALL=C comm -23 - "$known" > "$unrecorded"
  rm -f -- "$known"
  if [[ -s "$unrecorded" ]]; then
    mv -f -- "$unrecorded" "$releases/$(printf '%012d' "$number").list"
    number="$((number + 1))"
  else
    rm -f -- "$unrecorded"
  fi

  # Recorded first, so that an interrupted publish still accounts for every file it moved.
  attempt="$releases/$(printf '%012d' "$number").attempt"
  (cd "$staging" && find . -type f | sed 's#^\./##' | LC_ALL=C sort) > "$attempt"

  while IFS= read -r rel; do
    [[ "$rel" != "index.html" ]] || continue
    mkdir -p -- "$target/$(dirname -- "$rel")"
    mv -f -- "$staging/$rel" "$target/$rel"
  done < "$attempt"
  mv -f -- "$staging/index.html" "$target/index.html"

  # Public files that left the build go too; hashed assets wait for confirm_client_release.
  (cd "$target" && find . -type f ! -path './assets/*' | sed 's#^\./##') > "$scan"
  while IFS= read -r rel; do
    grep -Fxq -- "$rel" "$attempt" || rm -f -- "$target/$rel"
  done < "$scan"
  rm -f -- "$scan"

  log "Client build published; no hashed asset was removed"
}

# Call once the service is ready with the newest published build, when nothing running needs an
# older file. Only such a build counts as a release, so retries cannot push out the one that was
# running. A build that never got this far still stays while it is newer than the oldest kept
# release, because a service that restarted on its own may have served it.
confirm_client_release() {
  local target="$1"
  local releases="$2"
  local keep_releases="$3"
  local records="$releases/.records"
  local kept="$releases/.kept"
  local stale="$releases/.stale"
  local latest oldest old rel

  latest="$(find "$releases" -type f -name '*.attempt' | LC_ALL=C sort | tail -n 1)"
  [[ -n "$latest" ]] || die "No published client build to confirm: $releases"
  mv -f -- "$latest" "${latest%.attempt}.list"

  oldest="$(find "$releases" -type f -name '*.list' -printf '%f\n' | LC_ALL=C sort | tail -n "$keep_releases" | sed -n 1p)"
  find "$releases" -type f \( -name '*.list' -o -name '*.attempt' \) -printf '%f\n' | LC_ALL=C sort > "$records"

  # The files go first and their records after them: a stop at any point leaves every file on disk
  # accounted for, so that the next publish cannot take it for a build made in place.
  LC_ALL=C awk -v oldest="$oldest" '$0 >= oldest' "$records" | (cd "$releases" && xargs -d '\n' cat) | LC_ALL=C sort -u > "$kept"
  [[ -s "$kept" ]] || die "Client release records are empty: $releases"
  (cd "$target" && find assets -type f | LC_ALL=C sort | LC_ALL=C comm -23 - "$kept") > "$stale"
  while IFS= read -r rel; do
    rm -f -- "$target/$rel"
  done < "$stale"

  LC_ALL=C awk -v oldest="$oldest" '$0 < oldest' "$records" > "$stale"
  while IFS= read -r old; do
    rm -f -- "$releases/$old"
  done < "$stale"
  rm -f -- "$stale" "$kept" "$records"

  log "Client release confirmed; older hashed assets than the last $keep_releases releases are gone"
}
