import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const backupScript = path.resolve(__dirname, '../../scripts/ops/backup.sh');
// As in opsDeploy.test.ts: a local run on Windows names Git Bash's usr/bin/bash.exe.
const bash = process.env.OPS_TEST_BASH ?? 'bash';
const canRun = process.platform === 'linux' || Boolean(process.env.OPS_TEST_BASH);

// mongodump stands in for the real tool. A dump of one collection writes that collection,
// a whole dump writes the ones in STUB_COLLECTIONS; both append to the log.
const MONGODUMP_STUB = `#!/usr/bin/env bash
echo "mongodump $*" >> "$STUB_LOG"
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
  echo dumped > "$out/$db/$name.bson.gz"
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

    env = { ...process.env };
    for (const key of ['APP_DIR', 'ENV_FILE', 'BACKUP_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
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

  it('leaves no backup behind when reading the baselines fails', () => {
    env.STUB_FAIL = 'collection';
    const result = backup();
    expect(result.status).not.toBe(0);
    expect(dumps()).toHaveLength(2);
    expect(made()).toEqual([]);
  });
});
