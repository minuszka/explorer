# Operations

This document describes the supported workflows for running the explorer in production: preflight, deployment, MongoDB backup and restore. It also covers the reference host layout, baseline hardening and troubleshooting.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Reference Deployment

The operations scripts target a single Linux host:

- Cloudflare proxies public traffic to nginx on ports 80 and 443.
- nginx is a pure reverse proxy. It forwards everything to the Node app on `127.0.0.1:3001`, and Express serves the API, the `/ws` WebSocket endpoint and the built client.
- systemd runs the app (`server/dist/index.js`, `NODE_ENV=production`) as `deftrack.service`. systemd lets values from `EnvironmentFile` override `Environment=`, so the production `.env` must not set `NODE_ENV`, or must set it to `production`.
- MongoDB and the DeFCoN Core daemon (`defcond`) run on the same host. MongoDB and the daemon's RPC interface listen on `127.0.0.1` only; the daemon's P2P port (`8192`) may accept inbound connections (see [Production Hardening](#production-hardening)). The app reads the chain over the daemon's JSON-RPC interface.
- Readiness endpoint: `http://127.0.0.1:3001/api/health/ready`. It returns `{"status":"ok"}` only when both MongoDB and the daemon RPC are reachable, and `degraded` or `down` otherwise.

The scripts require bash, systemd, GNU coreutils and findutils, `git`, `node`/`npm`, `curl`, and the MongoDB Database Tools (`mongodump`, `mongorestore`). `npm run ops:restore-check` also needs `bsondump`, from the same tools, and `mongod`. The deploy, backup and restore scripts use `flock` from util-linux.

### Reference configuration files

`docs/server-config/` contains sanitized reference examples, not copies of a live host. Adjust the domain, paths and accounts before you use them.

| File | Installs as | Purpose |
| --- | --- | --- |
| `deftrack.service` | `/etc/systemd/system/deftrack.service` | App unit with a dedicated service account and systemd sandboxing |
| `defcond.service` | `/etc/systemd/system/defcond.service` | DeFCoN Core daemon unit, plus the `defcon.conf` settings the explorer needs |
| `nginx-deftrack.conf` | `/etc/nginx/sites-available/deftrack` | TLS termination, HTTP-to-HTTPS redirect, catch-all for unknown hosts, `/ws` upgrade, client-IP forwarding |
| `cloudflare-allowlist.conf` | `/etc/nginx/snippets/cloudflare-allowlist.conf` | Accept connections from Cloudflare edge ranges only |
| `deftrack-backup.service`, `.timer` | `/etc/systemd/system/` | Nightly MongoDB backup, sandboxed (see [Scheduled Backups](#scheduled-backups)) |
| `deftrack-restore-check.service`, `.timer` | `/etc/systemd/system/` | Weekly restore check of the newest backup |
| `deftrack-backup-pull.service`, `.timer` | `/etc/systemd/system/` on a second host | Nightly copy of the backups to that host |

### Script defaults and overrides

Run the scripts from the checkout, as the account that owns it. `systemctl` and `journalctl` run through `sudo` unless the script already runs as root. Each setting can be overridden with an environment variable, and most also have a command-line flag:

| Variable | Flag | Default | Used by |
| --- | --- | --- | --- |
| `APP_DIR` | `--app-dir` | the checkout that contains the scripts | all scripts |
| `SERVICE_NAME` | `--service` | `deftrack.service` | preflight, deploy, restore |
| `HEALTH_URL` | `--health-url` | `http://127.0.0.1:3001/api/health/ready` | preflight, deploy, restore |
| `ENV_FILE` | none | `$APP_DIR/.env` | preflight, backup, restore |
| `MONGODB_URI` | none | read from `ENV_FILE` | preflight, backup, restore |
| `DEPLOY_BRANCH` | `--branch` | `main` | deploy |
| `CLIENT_KEEP_RELEASES` | none | `3` | deploy |
| `BACKUP_DIR` | `--backup-dir` | `$APP_DIR/backups/mongodb` | backup, restore |
| `BACKUP_KEEP_DAYS` | `--keep-days` | `14` | backup |
| `BACKUP_LOCK_WAIT_SECONDS` | none | `3600` | backup, restore, restore check |
| `APP_OWNER` | none | owner of `APP_DIR` | deploy, when run as root |

Notes:

- `--app-dir` also resets the environment file to `<dir>/.env` and, for backup and restore, the backup root to `<dir>/backups/mongodb`. Pass `--backup-dir` after `--app-dir`. `ops:deploy` always passes `--app-dir` to preflight, so a deploy checks `$APP_DIR/.env`.
- `APP_OWNER` matters only when a script runs as root. The deploy then runs `git`, `npm ci`, lint, tests and the build as that account through `sudo -u`. When `APP_OWNER` is unset, the scripts use the owner of the checkout directory.
- The restore passes its `APP_DIR` and `ENV_FILE` on to the safety backup.

Example, to operate a checkout other than the one you run the scripts from:

```bash
APP_DIR=/opt/deftrack npm run ops:preflight -- --require-clean
```

## Inventory Validation

Every `.sh`, `.py`, `.mjs` or `.ts` file under `scripts/` (and under `server/src/scripts/`, if that directory exists) must have an entry in `scripts/operations.manifest.json`. Each entry records the path, status, owner, purpose, invocation and safety behaviour.

```bash
npm run ops:validate
```

The validator fails on unclassified scripts, on entries that point to missing files, and on missing fields. CI runs it on pushes to `main` and on pull requests. The allowed states are:

- `supported`: maintained and documented entry point
- `compatibility`: thin forwarding wrapper to a supported entry point. `scripts/deploy.sh`, `scripts/backup.sh` and `scripts/restore.sh` forward to `scripts/ops/`.

## Preflight

Run a read-only validation before maintenance:

```bash
npm run ops:preflight -- --require-clean
```

Preflight fails if any of these checks fails:

- The checkout is a Git repository with a root `package.json`.
- The environment file exists.
- The worktree is clean. This check applies only with `--require-clean`.
- `MONGODB_URI` can be resolved.
- `RPC_HOST`, `RPC_PORT`, `RPC_USER` and `RPC_PASS` are all present in the environment file. Preflight requires all four keys, although the server itself has defaults for the first three.
- The readiness endpoint returns `status=ok`. Use `--skip-health` to skip this check.

Preflight also reports the branch, commit, Node and npm versions, the systemd state, and whether the optional node feeds (`DNS_SEEDER_API_URL`, `PRE_RELEASE_NODES_API_URL`) are set in the environment file. It warns if the environment file is group-writable or accessible to other users (`600` or `640` is recommended). Secret values are never printed.

Useful options:

```bash
npm run ops:preflight -- --skip-health
npm run ops:preflight -- --app-dir /opt/deftrack --service deftrack.service
```

## Deployment

Preview the deploy without changing the repository, dependencies, build output or service state:

```bash
npm run ops:deploy -- --dry-run
```

Run the supported deployment:

```bash
npm run ops:deploy
```

The workflow runs these steps in order:

1. Runs preflight with `--require-clean`, which includes the readiness check.
2. Requires the checkout to be on the deploy branch (`main` by default).
3. Fetches `origin/<branch>` and applies it with `git merge --ff-only`.
4. Installs the lockfile with `npm ci`.
5. Runs lint and the CI tests.
6. Builds the shared and server workspaces, and builds the client into `client/.release-staging/dist`, beside the published `client/dist`.
7. Publishes the client: every new file moves into `client/dist` by rename, `index.html` last. Earlier hashed assets stay in place.
8. Restarts the service and polls readiness for about a minute (30 attempts, 2 seconds apart).
9. Once the service is ready, counts this build as a release and removes hashed assets older than the last `CLIENT_KEEP_RELEASES` releases.

If readiness does not recover, the deploy prints the service status and the last 50 journal lines, then exits with an error.

Only one deploy or rollback can run in a checkout at a time. Another one stops at once with an error, before it changes anything. The lock ends with the process, however it ends, so there is nothing to clean up after an interruption. A dry run does not take it.

Because preflight includes the readiness check, a deploy refuses to start while the running service is unhealthy. Restore the service first (see [Troubleshooting](#troubleshooting)), or roll back (see [Rollback](#rollback)).

`--skip-tests` skips lint and the CI tests. Use it only in an approved emergency. It never skips the build or the readiness check after the restart.

`--expect-commit <full hash>` stops after the fetch, before the checkout moves, unless the remote branch is exactly at that commit and the checkout holds no commits beyond it. Use it to deploy the release that was reviewed rather than whatever the branch holds by then. A dry run does not fetch, so it checks only the form of the hash.

### The client during a deploy

The running server reads `index.html` into memory when it starts and serves everything else from `client/dist`, so emptying that folder would break it. A deploy therefore never builds into `client/dist`:

- If the client build fails, `client/dist` and the running service are untouched. The checkout has already moved forward, and the shared and server builds may have run; the running service does not reload them, but it would start from them if it restarted. Fix the cause and deploy again, or roll back.
- Until the restart, the old server keeps working: its page and all of its hashed files are still there. Files with fixed names, such as `robots.txt`, change at the publish step.
- If the deploy stops after publishing, before the service is ready, no hashed asset has been removed and the running service keeps its files. Deploying again is safe. Only a build that reached readiness counts as a release, so retries cannot push out the release that was running. A build that did not get that far still stays for as long as it is newer than the oldest kept release, because the service may have restarted on its own and served it.
- After the restart, browser tabs opened earlier can still load the pages they have not visited yet. Hashed assets stay for the last `CLIENT_KEEP_RELEASES` releases (at least 2), counted in `client/.release-records/dist/`. A tab older than that gets a 404 for a page it has not loaded. It then reloads itself to pick up the current release, at most once a minute per tab. Until it can, for example while offline, it shows a reload button, and it does not interrupt a page that is still working.
- The restart itself still interrupts requests for a few seconds.

A plain `npm run build` in production empties `client/dist` and breaks the running server's pages until the next restart. Use `ops:deploy` there.

### A release that changes the deploy itself

A deploy runs the script that was in the checkout when it started; fast-forwarding does not swap it mid-run. For a release that changes `scripts/ops/`, or after a rollback past such a release, move the checkout first so the new script does the work:

```bash
git fetch origin main && git merge --ff-only origin/main
npm run ops:deploy
```

## Rollback

Move the checkout back to an earlier commit of the deploy branch and rebuild it:

```bash
npm run ops:deploy -- --rollback-to <commit> --dry-run
npm run ops:deploy -- --rollback-to <commit> --skip-tests
```

A rollback follows the deployment steps from `npm ci` onward, including the separate client build, the publish step and the readiness check, with `git reset --hard` in place of the fetch. Preflight skips the readiness check, because the service may be the reason for the rollback. The target must be an ancestor of the current commit, and the worktree must be clean. The next deploy fast-forwards again.

While a rollback runs, an untracked `ROLLBACK-IN-PROGRESS` file keeps the worktree dirty. The checkout already holds the target's scripts by then, and those may not know the lock, but their preflight refuses a dirty worktree, so `ops:deploy` cannot start beside the rollback. The file goes when the rollback ends. If Git is set to hide untracked files (`status.showUntrackedFiles=no`), this cannot work, so the rollback stops before changing anything; remove that setting and run it again.

A rollback does not touch MongoDB. Restore a backup only if data was damaged (see [MongoDB Restore](#mongodb-restore)). A rollback to a release from before network noise receipt retention needs one extra database step with the service stopped; see [Network Noise Monitor](network-noise-monitor.md).

## MongoDB Backup

Validate the backup configuration:

```bash
npm run ops:backup -- --dry-run
```

Create a compressed backup:

```bash
npm run ops:backup
```

Backups are written to `$APP_DIR/backups/mongodb/defcon_explorer_<UTC timestamp>`, for example `defcon_explorer_20260923T101500Z`. The `backups/` directory is git-ignored, so backups inside the checkout do not make the worktree dirty.

A dump holds the whole database, so only the account that made it and the group of the backup root can read it. A dump counts as restorable only when it contains gzipped BSON data and a `.complete` marker. It also contains a `backup.meta` file with the creation time, Git commit and collection count, and a `backup.sha256` file with a checksum of every file. Incomplete dumps are removed automatically. After a successful dump, the script deletes completed backups in the backup root that are older than the retention period, which defaults to 14 days. `--no-prune` skips this retention pass.

MongoDB credentials reach `mongodump` and `mongorestore` only through a temporary config file with mode `0600`. They are never printed or placed in command arguments.

A backup never writes into an existing backup: a second one in the same second stops with an error. The script reads the network noise baselines again after everything else, because a batch receipt is deleted only once the baseline records its sequence. A dump made by hand with `mongodump` does not have this order; see [Network Noise Monitor](network-noise-monitor.md).

## MongoDB Restore

Always validate the selected backup first:

```bash
npm run ops:restore -- --backup defcon_explorer_TIMESTAMP --dry-run
```

A real restore requires explicit confirmation:

```bash
npm run ops:restore -- --backup defcon_explorer_TIMESTAMP --yes
```

The restore accepts only completed backups inside the configured backup root whose files still match their checksums, so a lost or changed file stops it before anything changes, also on a dry run. A backup from before checksums needs `--allow-unverified`. It runs these steps:

1. Creates a fresh safety backup.
2. Stops the service.
3. Restores MongoDB with `mongorestore --drop`, and fails unless `mongorestore` reports that every collection finished, documents were restored and none failed. It replaces the collections in the backup; a collection that exists only in the live database stays.
4. Starts the service and verifies readiness.

If the restore fails after the service was stopped, an exit trap tries to start the service again. The database may then be partly restored; the error names the safety backup.

The safety backup runs with `--no-prune`, so a restore never deletes existing backups.

If `MONGODB_URI` names a database, the backup must hold a folder for it; the script checks this before it changes anything, also on a dry run.

## MongoDB Restore Check

Prove that a backup can be restored, without touching the live database or the service:

```bash
npm run ops:restore-check
npm run ops:restore-check -- --backup defcon_explorer_TIMESTAMP
```

The check takes the newest complete backup unless you name one, and refuses it if its files no longer match their checksums; `--allow-unverified` accepts a backup from before checksums. It starts its own MongoDB, which listens only on a socket in a private temporary folder, so no other local account can reach it. It restores the backup there, and compares the documents restored in each collection with the documents in the backup. It stops with an error on any difference, and removes the temporary database when it ends. It does not read `MONGODB_URI`. The temporary database uses a hidden folder beside the backups and needs about the uncompressed size of the data on that disk.

Run it before a real restore, and after any upgrade of the MongoDB Database Tools: the restore relies on what `mongorestore` reports, and the check shows on the safe side whether it still reports it.

## Scheduled Backups

Backups on the explorer's own disk do not survive the loss of that disk, so a second host keeps copies. The explorer host makes a backup every night and checks the newest one every week; the second host fetches the finished backups an hour later. A backup or a copy missed while a host was down runs when it comes back; a missed check waits for the next week. A backup, a restore and a restore check wait for each other, for up to an hour, so a retention pass cannot remove what another one is reading.

The second host fetches, rather than the explorer host sending, so that the explorer host holds no key to the second host: taking over the explorer host gives no way to reach or delete the copies. The explorer host gives the second host one key, which can only read the backup root.

**On the explorer host**, with `/opt/deftrack` as the checkout and `admin` as the account that owns it:

```bash
sudo chmod -R go-w /opt/deftrack/
sudo find /opt/deftrack/ ! -user admin -print -exec false {} +
sudo -u admin git -C /opt/deftrack/ diff --quiet HEAD -- scripts
sudo useradd --system --create-home --home-dir /var/lib/deftrack-backup --shell /bin/sh deftrack-backup
sudo -u admin mkdir -p /opt/deftrack/backups/mongodb
sudo chgrp -R deftrack-backup /opt/deftrack/backups/mongodb
sudo chmod -R u=rwX,g=rX,o= /opt/deftrack/backups/mongodb
sudo find /opt/deftrack/backups/mongodb -type d -exec chmod g+s {} +
```

The units run scripts from the checkout as its owner, so the first command closes the checkout to other accounts, members of its group included. The next two must then exit with 0, in this order: an account that could write there before may have left files of its own, which it can still change, or changed a script. If one of them fails, find out why before you go on. The units refuse to start, and name the path, if the checkout, the scripts or `.env` become writable by the group or by everybody or belong to another account, or if the scripts or `.env` are symbolic links. `npm run ops:deploy` keeps them closed; a `git pull` by hand under a umask of `002` does not. The folders above the checkout must belong to root and be closed to others; `namei -l /opt/deftrack/scripts/ops/backup.sh` shows them. The copy account can then read the backup root and nothing else can reach it; new backups inherit its group. Install `deftrack-backup.service`, `deftrack-backup.timer`, `deftrack-restore-check.service` and `deftrack-restore-check.timer`, with the paths and the account adjusted, then:

```bash
sudo systemctl daemon-reload
sudo systemctl start deftrack-backup.service
sudo systemctl start deftrack-restore-check.service
sudo systemctl enable --now deftrack-backup.timer deftrack-restore-check.timer
```

**On the second host**, which needs `rsync`:

```bash
sudo useradd --system --create-home --home-dir /var/lib/deftrack-backup --shell /usr/sbin/nologin deftrack-backup
sudo -u deftrack-backup mkdir -m 700 /var/lib/deftrack-backup/.ssh
sudo -u deftrack-backup ssh-keygen -t ed25519 -N '' -C deftrack-backup -f /var/lib/deftrack-backup/.ssh/id_ed25519
sudo install -d /usr/local/lib/deftrack-backup
sudo install -m 644 scripts/ops/backup-pull.sh scripts/ops/lib.sh /usr/local/lib/deftrack-backup/
```

Copy the explorer host's SSH host key into `/var/lib/deftrack-backup/.ssh/known_hosts` after you compare its fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on that host. The script refuses a host it does not know.

**Back on the explorer host**, allow the key, from the second host's address only, in `/var/lib/deftrack-backup/.ssh/authorized_keys` (mode 600, owned by `deftrack-backup`, in a folder with mode 700), on one line:

```text
restrict,from="SECOND_HOST_IP",command="/usr/bin/rrsync -ro /opt/deftrack/backups/mongodb" ssh-ed25519 AAAA... deftrack-backup
```

`rrsync` comes with `rsync`. It limits the key to reading from that one folder, and `restrict` turns off everything else an SSH key could do.

**Then, on the second host**, install `deftrack-backup-pull.service` and `deftrack-backup-pull.timer`, with `explorer.example` replaced, and start them:

```bash
sudo systemctl daemon-reload
sudo systemctl start deftrack-backup-pull.service
sudo systemctl enable --now deftrack-backup-pull.timer
```

The copy step only counts a backup that has its `.complete` marker and whose files match their checksums. It keeps the newest 30 copies, and because it counts rather than looks at age, the copies stay when the explorer host stops making backups. It fetches at most 3 backups in one run, so a broken source cannot push out every good copy in one night. A new backup also has to carry a believable time in its name. It fetches nothing while less than 20 GB is free on that disk, so a database that outgrows the second host does not fill it. A newest copy older than 36 hours makes the run fail, so a backup that stopped on the explorer host shows up on the second host too.

To restore from a copy, bring it back to the backup root of the explorer host and run `npm run ops:restore` as usual; the checksums come along.

**Nothing sends an alert.** A failed backup, check or copy leaves a failed unit and a journal entry, and nothing more. Look at them on a schedule, or connect `OnFailure=` to your own alerting:

```bash
systemctl --failed
systemctl list-timers 'deftrack-*'
journalctl -u deftrack-backup.service -n 20
```

## Production Hardening

Baseline guidance for an explorer host. The reference files in `docs/server-config/` already follow it where it applies.

**Accounts and SSH**

- Allow key-only SSH: set `PermitRootLogin no` and `PasswordAuthentication no`. Cloud images often ship drop-ins in `/etc/ssh/sshd_config.d/` (for example `50-cloud-init.conf`) that turn password logins back on. Check the effective settings with `sudo sshd -T | grep -Ei 'permitrootlogin|passwordauthentication'`.
- Log in with a non-root admin account. That account owns the checkout and runs the `npm run ops:*` scripts. Run the app under a separate unprivileged service account (`deftrack` in the reference unit) with no sudo rights and no login shell. The service account only needs read access to the checkout. Run the daemon under its own account (`defcon`).
- Enable fail2ban for `sshd`, and unattended upgrades for security updates.

**Network**

- Set the firewall to deny incoming traffic by default. Allow only `22/tcp` (SSH), `80/tcp` and `443/tcp` (nginx), and optionally the DeFCoN P2P port `8192/tcp`. The daemon syncs over outbound connections, so inbound P2P is optional. You can also restrict SSH to known source addresses.
- Keep the app (`3001`), MongoDB (`27017`) and the daemon RPC (`8193`) on `127.0.0.1`. The app always binds to `127.0.0.1`. For MongoDB, set `net.bindIp: 127.0.0.1`. For the daemon, set `rpcbind=127.0.0.1` and `rpcallowip=127.0.0.1`.
- Let nginx accept only Cloudflare ranges by including `cloudflare-allowlist.conf` in every server block that proxies to the app. The catch-all block closes connections for unknown hosts. To verify from a machine outside Cloudflare, run `curl -skI --resolve <your-domain>:443:<origin-ip> https://<your-domain>/`. It should return `403`.
- nginx must overwrite `X-Forwarded-For` and `X-Real-IP` with `CF-Connecting-IP`, not append to them, as the reference config does. Set `TRUST_PROXY` to the exact number of proxy hops and never to `true`. Otherwise clients can spoof their IP and bypass the per-IP rate limits.

**Service**

- Sandbox the app with systemd: `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=full` and `ProtectHome=read-only`.
- The app sets `Content-Security-Policy`, `Strict-Transport-Security` (in production) and `Permissions-Policy` itself. The proxy must not hide, override or duplicate these headers.
- Set `CORS_ORIGINS` explicitly, and include the site's own public origin (for example `https://example.com`). The same list decides which `Origin` values may open the `/ws` WebSocket, so realtime updates fail with `403` if the site's origin is missing. If you enable the admin API, set `ADMIN_API_KEY` to at least 32 characters. Leave it empty to disable the admin API.

**Secrets**

- Keep `.env` at mode `600`, owned by the checkout owner. systemd reads `EnvironmentFile` before it drops privileges, so the service account needs no read access of its own. Never commit `.env`: `.gitignore` excludes `.env` and `.env.*` except `.env.example`.
- If a credential leaks, rotate it: the RPC password, MongoDB users, API keys, bot tokens or SSH keys. Replace it at the source, update `.env` and restart the service. Removing the value from a file or from Git history is not enough.

## Cloudflare

- Proxy the site's DNS records through Cloudflare, and use SSL/TLS mode **Full (strict)**. The reference nginx config serves a certificate on 443 and redirects port 80 to HTTPS, so **Flexible** mode would cause a redirect loop.
- **Browser Cache TTL must be "Respect Existing Headers".** Cacheable API responses send a `private` browser `max-age` of at most 15 minutes, plus `CDN-Cache-Control` and `Cloudflare-CDN-Cache-Control` for the edge (`server/src/middleware/cachePolicy.ts`). A Browser Cache TTL override replaces that `max-age` on every cacheable response. Only `no-store` and `no-cache` responses keep their headers. Browsers then serve stale API data for the length of the override, and the block height in the header stops updating. After you fix the setting, a hard reload clears responses that browsers already cached.
- Keep `cloudflare-allowlist.conf` in sync with <https://www.cloudflare.com/ips/>.

## Node Feeds

`DNS_SEEDER_API_URL` and `PRE_RELEASE_NODES_API_URL` have no default. An empty or unset value disables that feed: `/api/network/dns-seeder-nodes` and `/api/network/pre-release-nodes` return an empty list, and the node inventory skips the source. Preflight reports whether each URL is set. `PRE_RELEASE_NODES_API_KEY` is required in production only when `PRE_RELEASE_NODES_API_URL` is set.

## Benchmarks

```bash
npm run perf:api -- --baseUrl http://127.0.0.1:3001 --durationSec 30 --concurrency 25
npm run perf:ws -- --url ws://127.0.0.1:3001/ws --connections 8 --holdSec 20 --connectSpreadMs 4000
```

Only benchmark deployments you operate. The server's limits apply to benchmarks: the API limiter allows `RATE_LIMIT_MAX_PER_MINUTE` requests per minute per client IP (default 1200), and the WebSocket endpoint accepts at most 8 connections per IP. Requests over a limit are rejected with `429` and count as failures, so raise `RATE_LIMIT_MAX_PER_MINUTE` on the benchmark instance and keep `--connections` at 8 or less per source IP. Results are written to `artifacts/perf/`.

## Troubleshooting

After a reboot, the daemon can take several minutes to load its chainstate and reach its peers. Until the RPC answers, readiness reports `degraded` and the latest block may appear stuck. The first few minutes of this are normal. Investigate if the host has not recovered after about 10 minutes.

```bash
curl -s http://127.0.0.1:3001/api/health/ready   # {"status":"ok"}
curl -s http://127.0.0.1:3001/api/sync           # lastSyncedHeight == daemonHeight, blocksRemaining 0, rpcConnected true
systemctl status deftrack.service defcond.service
journalctl -u deftrack.service -n 100 --no-pager
sudo -u defcon defcon-cli -conf=/etc/defcon/defcon.conf -datadir=/var/lib/defcon getconnectioncount   # > 0
```

**The daemon reports a corrupted block database** (`Corrupted block database detected ... restart with -reindex`). This usually follows an unclean shutdown. Rebuild the indexes once with `-reindex`, which takes a long time:

```bash
sudo systemctl stop defcond.service
sudo -u defcon /usr/local/bin/defcond -daemon -reindex -conf=/etc/defcon/defcon.conf -datadir=/var/lib/defcon
# wait until the reindex has finished and the daemon has caught up with the network, then:
sudo -u defcon /usr/local/bin/defcon-cli -conf=/etc/defcon/defcon.conf -datadir=/var/lib/defcon stop
sudo systemctl start defcond.service
```

To prevent this, give the daemon unit a long `TimeoutStopSec`, as the reference unit does, so a shutdown or reboot does not kill the daemon mid-write.

**The site header shows an old block height or "Delayed", but `/api/sync` on the host is current.** Check the Cloudflare Browser Cache TTL (see [Cloudflare](#cloudflare)).

**The deploy refuses to start.** Preflight has failed, or the checkout is not on the deploy branch. The log line names the failing check: a dirty worktree, a missing environment key, the wrong branch or failed readiness. A dirty worktree may be a `ROLLBACK-IN-PROGRESS` file: a rollback is running, or one was killed and the checkout now holds a script that cannot clear it. Once no deploy is running, delete the file.

**A page stays blank after a deploy.** The tab is older than the kept releases and asks for a file that is gone. A reload fixes it.
