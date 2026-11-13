import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const backupScript = path.resolve(__dirname, '../../scripts/ops/backup.sh');
// As in opsDeploy.test.ts: a local run on Windows names Git Bash's usr/bin/bash.exe.
const bash = process.env.OPS_TEST_BASH ?? 'bash';
const canRun = process.platform === 'linux' || Boolean(process.env.OPS_TEST_BASH);
// Git Bash has no flock. There it becomes a stub, and the tests that need the real one are skipped.
const hasFlock = canRun && spawnSync(bash, ['-c', 'command -v flock']).status === 0;

// mongodump stands in for the real tool. A dump of one collection writes that collection,
// a whole dump writes the ones in STUB_COLLECTIONS; both append to the log.
const MONGODUMP_STUB = `#!/usr/bin/env bash
echo "mongodump $*" >> "$STUB_LOG"
if [[ -n "\${STUB_CHECK_LOCK:-}" ]] && ! flock -n "$STUB_CHECK_LOCK" true; then echo "lock held during the dump" >> "$STUB_LOG"; fi
out=""; db=testdb; collection=""
for arg in "$@"; do
  case "$arg" in
    --out=*) out="\${arg#--out=}" ;;
    --db=*) db="\${arg#--db=}" ;;
    --collection=*) collection="\${arg#--collection=}" ;;
  esac
done
[[ -z "$collection" || "\${STUB_FAIL:-}" != collection ]] || exit 1
mkdir -p "$out/$db"
for name in \${collection:-$STUB_COLLECTIONS}; do
  echo "dumped\${collection:+ again}" > "$out/$db/$name.bson.gz"
  echo metadata > "$out/$db/$name.metadata.json.gz"
done
`;

const posix = (file: string) => file.split(path.sep).join('/');

describe.skipIf(!canRun)('MongoDB backup script', { timeout: 60_000 }, () => {
  let root: string;
  let backups: string;
  let logFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ops-backup-'));
    const stubDir = path.join(root, 'stubs');
    backups = path.join(root, 'backups');
    logFile = path.join(root, 'calls.log');
    mkdirSync(stubDir);
    mkdirSync(backups);
    writeFileSync(logFile, '');
    writeFileSync(path.join(stubDir, 'mongodump'), MONGODUMP_STUB);
    execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'mongodump'))]);
    if (!hasFlock) {
      writeFileSync(path.join(stubDir, 'flock'), '#!/usr/bin/env bash\n');
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'flock'))]);
    }

    env = { ...process.env };
    for (const key of ['APP_DIR', 'ENV_FILE', 'BACKUP_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'BACKUP_LOCK_WAIT_SECONDS', 'STUB_CHECK_LOCK']) {
      delete env[key];
    }
    env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;
    env.MONGODB_URI = 'mongodb://127.0.0.1:27017/testdb';
    env.STUB_LOG = posix(logFile);
    env.STUB_COLLECTIONS = 'networknoisebatches networknoisebaselines blocks';
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const backup = () => spawnSync(bash, [posix(backupScript), '--backup-dir', posix(backups), '--no-prune'],
    { env, encoding: 'utf8' });
  const dumps = () => readFileSync(logFile, 'utf8').trim().split('\n');
  const made = () => readdirSync(backups);

  it('reads the network noise baselines again after everything else', () => {
    const result = backup();
    expect(result.status, result.stderr).toBe(0);

    const calls = dumps();
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('--collection');
    expect(calls[1]).toContain('--db=testdb');
    expect(calls[1]).toContain('--collection=networknoisebaselines');
    // Credentials stay in the temporary config file, as in the first dump.
    expect(calls.join('\n')).not.toContain('mongodb://');

    expect(made()).toHaveLength(1);
    const folder = path.join(backups, made()[0]);
    expect(existsSync(path.join(folder, '.complete'))).toBe(true);
    expect(readFileSync(path.join(folder, 'backup.meta'), 'utf8')).toContain('collections=3');
  });

  it('records a checksum of every file as the backup ended, without the marks that finish it', () => {
    const result = backup();
    expect(result.status, result.stderr).toBe(0);

    const folder = path.join(backups, made()[0]);
    const listed = readFileSync(path.join(folder, 'backup.sha256'), 'utf8').trim().split('\n').map((line) => line.split(/\s+\*?/)[1]).sort();
    expect(listed).toEqual(['./backup.meta', './testdb/blocks.bson.gz', './testdb/blocks.metadata.json.gz',
      './testdb/networknoisebaselines.bson.gz', './testdb/networknoisebaselines.metadata.json.gz',
      './testdb/networknoisebatches.bson.gz', './testdb/networknoisebatches.metadata.json.gz']);
    // The baselines read again last are what the checksums cover.
    const check = spawnSync(bash, ['-c', 'cd "$1" && sha256sum --check --quiet --strict backup.sha256', '_', posix(folder)], { env, encoding: 'utf8' });
    expect(check.status, check.stdout).toBe(0);
  });

  // File modes mean little in Git Bash on Windows.
  it.runIf(process.platform === 'linux')('keeps a backup from other accounts, and from writes by its group', () => {
    const result = spawnSync(bash, ['-c', 'umask 000; exec bash "$@"', '_', posix(backupScript), '--backup-dir', posix(backups), '--no-prune'],
      { env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);

    const folder = path.join(backups, made()[0]);
    for (const file of [folder, path.join(folder, 'testdb'), path.join(folder, 'testdb', 'blocks.bson.gz'), path.join(folder, 'backup.meta'), path.join(folder, 'backup.sha256'), path.join(folder, '.complete')]) {
      expect(statSync(file).mode & 0o027, file).toBe(0);
    }
  });

  it.runIf(hasFlock)('holds the lock of the backup root while it dumps', () => {
    env.STUB_CHECK_LOCK = posix(backups);
    expect(backup().status).toBe(0);
    expect(readFileSync(logFile, 'utf8')).toContain('lock held during the dump');
  });

  it.runIf(hasFlock)('gives up when another one keeps the lock, and removes nothing', () => {
    const expired = path.join(backups, 'defcon_explorer_20200101T000000Z');
    mkdirSync(expired);
    writeFileSync(path.join(expired, '.complete'), '');
    execFileSync(bash, ['-c', 'touch -d "20 days ago" "$1"', '_', posix(expired)]);
    env.BACKUP_LOCK_WAIT_SECONDS = '0';

    const result = spawnSync(bash, ['-c', 'flock "$1" bash "$2" --backup-dir "$1"', '_', posix(backups), posix(backupScript)], { env, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is still running');
    expect(readFileSync(logFile, 'utf8')).toBe('');
    expect(existsSync(expired)).toBe(true);
  });

  it.runIf(hasFlock)('waits for the lock, and names the backup after the wait', () => {
    const released = path.join(root, 'released');
    const result = spawnSync(bash, ['-c', `flock "$1" bash -c 'sleep 1.5; date -u +%Y%m%dT%H%M%SZ > "$0"' "$3" &
sleep 0.3
bash "$2" --backup-dir "$1" --no-prune; status=$?
wait
exit $status`, '_', posix(backups), posix(backupScript), posix(released)], { env, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(made()).toHaveLength(1);
    expect(made()[0].replace('defcon_explorer_', '') >= readFileSync(released, 'utf8').trim()).toBe(true);
  });

  it('names the database the dump found, whatever the URI says', () => {
    env.MONGODB_URI = 'mongodb://127.0.0.1:27017/';
    const result = backup();
    expect(result.status, result.stderr).toBe(0);
    expect(dumps()[1]).toContain('--db=testdb');
  });

  it('makes one dump when the monitor has never stored a baseline', () => {
    env.STUB_COLLECTIONS = 'blocks';
    const result = backup();
    expect(result.status, result.stderr).toBe(0);
    expect(dumps()).toHaveLength(1);
    expect(existsSync(path.join(backups, made()[0], '.complete'))).toBe(true);
  });

  it('does not write into a backup made in the same second', () => {
    // The timestamp is the only part of a backup's name that varies.
    const stubDir = path.join(root, 'stubs');
    writeFileSync(path.join(stubDir, 'date'), `#!/usr/bin/env bash
case "$*" in
  *%Y%m%dT*) echo 20260101T000000Z ;;
  *) PATH="\${PATH#*:}" exec date "$@" ;;
esac
`);
    execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'date'))]);
    const existing = path.join(backups, 'defcon_explorer_20260101T000000Z');
    for (const complete of [true, false]) {
      mkdirSync(existing, { recursive: true });
      writeFileSync(path.join(existing, 'blocks.bson.gz'), 'the first backup');
      if (complete) writeFileSync(path.join(existing, '.complete'), '');
      else rmSync(path.join(existing, '.complete'));

      const result = backup();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Backup already exists');
      expect(readFileSync(logFile, 'utf8')).toBe('');
      expect(readFileSync(path.join(existing, 'blocks.bson.gz'), 'utf8')).toBe('the first backup');
    }
  });

  it('leaves no backup behind when reading the baselines fails', () => {
    env.STUB_FAIL = 'collection';
    const result = backup();
    expect(result.status).not.toBe(0);
    expect(dumps()).toHaveLength(2);
    expect(made()).toEqual([]);
  });
});
