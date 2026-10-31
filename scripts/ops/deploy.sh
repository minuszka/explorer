#!/usr/bin/env bash

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

BRANCH="${DEPLOY_BRANCH:-main}"
CLIENT_KEEP_RELEASES="${CLIENT_KEEP_RELEASES:-3}"
DRY_RUN=0
SKIP_TESTS=0
ROLLBACK_TO=""
EXPECT_COMMIT=""

usage() {
  cat <<'EOF'
Usage: deploy.sh [options]

Fast-forward deploy of the verified production checkout.

Options:
  --dry-run             Validate and print the plan without changing anything
  --skip-tests          Skip lint and CI tests (build still runs)
  --expect-commit HASH  Stop after the fetch unless the remote branch is exactly at
                        this full commit hash
  --rollback-to COMMIT  Move back to an earlier commit instead of fetching, even
                        if the running service is unhealthy; the rest is the same
  --app-dir PATH        Application checkout (default: this checkout)
  --branch NAME         Remote branch (default: main)
  --service NAME        systemd service (default: deftrack.service)
  --health-url URL      Readiness endpoint
  -h, --help            Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --skip-tests) SKIP_TESTS=1; shift ;;
    # An empty value (an unset shell variable, say) must not turn into a plain deploy.
    --expect-commit) [[ -n "${2:-}" ]] || die "--expect-commit needs a commit hash"; EXPECT_COMMIT="$2"; shift 2 ;;
    --rollback-to) [[ -n "${2:-}" ]] || die "--rollback-to needs a commit"; ROLLBACK_TO="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; ENV_FILE="$APP_DIR/.env"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --service) SERVICE_NAME="$2"; shift 2 ;;
    --health-url) HEALTH_URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# Keeping one release would take the previous one away from every tab that still has it open.
[[ "$CLIENT_KEEP_RELEASES" =~ ^([2-9]|[1-9][0-9]+)$ ]] \
  || die "CLIENT_KEEP_RELEASES must be a whole number of at least 2: $CLIENT_KEEP_RELEASES"

if [[ -n "$EXPECT_COMMIT" ]]; then
  [[ -z "$ROLLBACK_TO" ]] || die "--expect-commit does not apply to a rollback"
  [[ "$EXPECT_COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "--expect-commit needs a full commit hash: $EXPECT_COMMIT"
fi

APP_DIR="$(canonical_path "$APP_DIR")"
CLIENT_DIST_DIR="$APP_DIR/client/dist"
# Staging stays on the filesystem of client/dist so that publishing is a rename. Both folders
# are named dist because Git and lint ignore that name on every commit, including the target of
# a rollback, so neither can make the worktree dirty.
CLIENT_STAGING_ROOT="$APP_DIR/client/.release-staging"
CLIENT_STAGING_DIR="$CLIENT_STAGING_ROOT/dist"
CLIENT_RELEASES_DIR="$APP_DIR/client/.release-records/dist"
# Untracked and not ignored on any commit: it keeps the worktree dirty while a rollback runs.
ROLLBACK_MARKER="$APP_DIR/ROLLBACK-IN-PROGRESS"

# One deploy or rollback at a time: an overlapping one could clear files that the other one's server
# still needs. The kernel drops this lock when the process ends, however it ends.
if [[ "$DRY_RUN" -eq 0 ]]; then
  require_command flock
  exec 9<"$APP_DIR"
  flock -n 9 || die "Another deploy or rollback is running in $APP_DIR"
  # Nobody else holds the lock, so a marker found here is left over from a killed rollback.
  rm -f -- "$ROLLBACK_MARKER"
  trap 'rm -rf -- "$CLIENT_STAGING_ROOT"; rm -f -- "$ROLLBACK_MARKER"' EXIT
fi

preflight_args=(--app-dir "$APP_DIR" --service "$SERVICE_NAME" --health-url "$HEALTH_URL" --require-clean)
# A rollback is how an unhealthy service recovers, so it must not wait for readiness.
[[ -z "$ROLLBACK_TO" ]] || preflight_args+=(--skip-health)
bash "$SCRIPT_DIR/preflight.sh" "${preflight_args[@]}"

current_branch="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)"
[[ "$current_branch" == "$BRANCH" ]] || die "Checkout is on '$current_branch'; expected deployment branch '$BRANCH'"

if [[ -n "$ROLLBACK_TO" ]]; then
  rollback_commit="$(git -C "$APP_DIR" rev-parse --verify --quiet "${ROLLBACK_TO}^{commit}")" \
    || die "Rollback target is not a known commit: $ROLLBACK_TO"
  git -C "$APP_DIR" merge-base --is-ancestor "$rollback_commit" HEAD \
    || die "Rollback target is not an earlier commit of this checkout: $ROLLBACK_TO"
  log "Deploy plan: rollback to $rollback_commit -> $APP_DIR -> $SERVICE_NAME"
else
  log "Deploy plan: origin/$BRANCH${EXPECT_COMMIT:+ at $EXPECT_COMMIT} -> $APP_DIR -> $SERVICE_NAME"
fi
if [[ "$SKIP_TESTS" -eq 1 ]]; then
  warn "Lint and CI tests will be skipped"
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  [[ -z "$EXPECT_COMMIT" ]] || warn "A dry run does not fetch, so the expected commit was not compared"
  log "Dry run complete; no repository, dependency, build, or service state was changed"
  exit 0
fi

if [[ -n "$ROLLBACK_TO" ]]; then
  # The script of an older commit knows no lock, but its preflight refuses a dirty worktree.
  run_as_app touch "$ROLLBACK_MARKER"
  [[ -n "$(git -C "$APP_DIR" status --porcelain)" ]] \
    || die "Git hides untracked files in this checkout (status.showUntrackedFiles), so an older script could start beside the rollback; nothing was changed"
  log "Moving the checkout back to $rollback_commit"
  run_as_app git -C "$APP_DIR" reset --hard "$rollback_commit"
else
  log "Fetching origin/$BRANCH"
  run_as_app git -C "$APP_DIR" fetch --prune origin "$BRANCH"

  if [[ -n "$EXPECT_COMMIT" ]]; then
    fetched_commit="$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
    [[ "$fetched_commit" == "$EXPECT_COMMIT" ]] \
      || die "origin/$BRANCH is at $fetched_commit, not the expected $EXPECT_COMMIT; nothing was deployed"
    git -C "$APP_DIR" merge-base --is-ancestor HEAD "$EXPECT_COMMIT" \
      || die "The checkout holds commits that $EXPECT_COMMIT does not contain; nothing was deployed"
  fi

  log "Applying remote commit with fast-forward only"
  run_as_app git -C "$APP_DIR" merge --ff-only "origin/$BRANCH"
fi

log "Installing locked dependencies"
run_as_app npm --prefix "$APP_DIR" ci

if [[ "$SKIP_TESTS" -eq 0 ]]; then
  log "Running lint"
  run_as_app npm --prefix "$APP_DIR" run lint
  log "Running CI tests"
  run_as_app npm --prefix "$APP_DIR" run test:ci
fi

log "Building shared and server workspaces"
# By name: npm reads a folder here relative to the current directory, not to --prefix.
run_as_app npm --prefix "$APP_DIR" run build -w @defcon/shared
run_as_app npm --prefix "$APP_DIR" run build -w @defcon/server

rm -rf -- "$CLIENT_STAGING_ROOT"

log "Building the client next to the published one"
run_as_app npm --prefix "$APP_DIR" run build -w @defcon/client -- --outDir "$CLIENT_STAGING_DIR" --emptyOutDir

log "Publishing the client build"
# After a rollback this script's files may no longer exist, so the functions travel inline.
run_as_app bash -c "set -Eeuo pipefail; $(declare -f log die publish_client_build); publish_client_build \"\$@\"" \
  publish-client "$CLIENT_STAGING_DIR" "$CLIENT_DIST_DIR" "$CLIENT_RELEASES_DIR"

log "Restarting $SERVICE_NAME"
run_privileged systemctl restart "$SERVICE_NAME"

if ! wait_for_health 30 2; then
  run_privileged systemctl status "$SERVICE_NAME" --no-pager || true
  run_privileged journalctl -u "$SERVICE_NAME" -n 50 --no-pager || true
  die "Deployment completed but readiness did not recover"
fi

log "The new release is ready; clearing client files older than the kept releases"
run_as_app bash -c "set -Eeuo pipefail; $(declare -f log die confirm_client_release); confirm_client_release \"\$@\"" \
  confirm-client "$CLIENT_DIST_DIR" "$CLIENT_RELEASES_DIR" "$CLIENT_KEEP_RELEASES"

deployed_commit="$(git -C "$APP_DIR" rev-parse --short HEAD)"
log "Deploy completed successfully at commit $deployed_commit"
