import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const opsDir = path.resolve(__dirname, '../../scripts/ops');
// As in opsDeploy.test.ts: a local run on Windows names Git Bash's usr/bin/bash.exe.
const bash = process.env.OPS_TEST_BASH ?? 'bash';
const canRun = process.platform === 'linux' || Boolean(process.env.OPS_TEST_BASH);
// Git Bash has no flock. There it becomes a stub, and the tests that need the real one are skipped.
const hasFlock = canRun && spawnSync(bash, ['-c', 'command -v flock']).status === 0;

// mongorestore behaves as the real tool was measured to: a URI that names a database makes it read
// the path as that database's folder, so given a whole backup it skips everything and exits 0.
// It reports system collections to nobody. A collection file holds its document count.
// It prints each name in backticks as 100.18 does, or bare as 100.15 does (STUB_BARE_NAMES).
const MONGORESTORE_STUB = `#!/usr/bin/env bash
echo "mongorestore $*" >> "$STUB_LOG"
if [[ -n "\${STUB_CHECK_LOCK:-}" ]] && ! flock -n "$STUB_CHECK_LOCK" true; then echo "lock held during the restore" >> "$STUB_LOG"; fi
target="\${!#}"
uri=""
for arg in "$@"; do
  case "$arg" in
    --config=*) uri="$(sed -E 's/^uri: "(.*)"$/\\1/' "\${arg#--config=}")" ;;
    --uri=*) uri="\${arg#--uri=}" ;;
  esac
done
echo "connected to the database" >&2
if [[ "$uri" =~ ^[a-z+]+://[^/]*/[^?]+ && -z "$(find "$target" -maxdepth 1 -name '*.bson.gz' -print -quit)" ]]; then
  echo "don't know what to do with subdirectory, skipping..." >&2
  echo "0 document(s) restored successfully. 0 document(s) failed to restore." >&2
  exit 0
fi
[[ "\${STUB_FAIL:-}" != exit ]] || { echo "Failed: reading bson input: unexpected EOF" >&2; exit 1; }
[[ "\${STUB_FAIL:-}" != no-summary ]] || exit 0
total=0
while IFS= read -r file; do
  relative="\${file#"$target"/}"
  name="\${relative%.bson.gz}"
  [[ "$name" == */* ]] || name="$(basename "$target")/$name"
  count="$(gzip -dc "$file")"
  [[ "\${STUB_FAIL:-}" != short || "$name" != */blocks ]] || count=$((count - 1))
  [[ "\${STUB_FAIL:-}" != unfinished || "$name" != */blocks ]] || continue
  label="\${name/\\//.}"
  [[ -n "\${STUB_BARE_NAMES:-}" ]] || label="\\\`$label\\\`"
  echo "finished restoring $label ($count documents, 0 failures)" >&2
  total=$((total + count))
done < <(find "$target" -type f -name '*.bson.gz' ! -name 'system.*' | sort)
failed=0
[[ "\${STUB_FAIL:-}" != failed-documents ]] || failed=2
echo "$total document(s) restored successfully. $failed document(s) failed to restore." >&2
`;

const STUBS: Record<string, string> = {
  mongorestore: MONGORESTORE_STUB,
  // The safety backup: a whole dump with one collection.
  mongodump: `#!/usr/bin/env bash
echo "mongodump $*" >> "$STUB_LOG"
for arg in "$@"; do
  case "$arg" in --out=*) out="\${arg#--out=}" ;; esac
done
mkdir -p "$out/testdb"
echo dumped > "$out/testdb/blocks.bson.gz"
`,
  bsondump: `#!/usr/bin/env bash
echo "2026-01-01T00:00:00.000+0000 $(cat) objects found" >&2
`,
  // Creates its socket in the requested folder, as a started database would.
  mongod: `#!/usr/bin/env bash
echo "mongod $*" >> "$STUB_LOG"
[[ "\${STUB_FAIL:-}" != mongod ]] || exit 1
echo "$$" > "$STUB_PID"
while [[ $# -gt 0 ]]; do
  [[ "$1" != --bind_ip ]] || bind="$2"
  shift
done
[[ "$bind" != */* ]] || : > "$bind"
exec node -e "setInterval(() => {}, 1000)" > /dev/null 2>&1
`,
  systemctl: `#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
`,
  sudo: `#!/usr/bin/env bash
if [[ "\${1:-}" == "--" ]]; then shift; fi
exec "$@"
`,
  curl: `#!/usr/bin/env bash
echo '{"status":"ok"}'
`,
};

const posix = (file: string) => file.split(path.sep).join('/');

describe.skipIf(!canRun)('MongoDB restore scripts', { timeout: 60_000 }, () => {
  let root: string;
  let backups: string;
  let logFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ops-restore-'));
    const stubDir = path.join(root, 'stubs');
    backups = path.join(root, 'backups');
    logFile = path.join(root, 'calls.log');
    mkdirSync(stubDir);
    mkdirSync(backups);
    writeFileSync(logFile, '');
    for (const [name, body] of Object.entries(STUBS)) {
      writeFileSync(path.join(stubDir, name), body);
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, name))]);
    }
    if (!hasFlock) {
      writeFileSync(path.join(stubDir, 'flock'), '#!/usr/bin/env bash\n');
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'flock'))]);
    }

    env = { ...process.env };
    for (const key of ['APP_DIR', 'ENV_FILE', 'BACKUP_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'STUB_FAIL', 'STUB_BARE_NAMES', 'BACKUP_LOCK_WAIT_SECONDS', 'STUB_CHECK_LOCK']) {
      delete env[key];
    }
    env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;
    env.MONGODB_URI = 'mongodb://127.0.0.1:27017/testdb';
    env.STUB_LOG = posix(logFile);
    env.STUB_PID = posix(path.join(root, 'mongod.pid'));
    env.TMPDIR = posix(path.join(root, 'tmp'));
    mkdirSync(path.join(root, 'tmp'));
  });

  afterEach(() => {
    // Only a script that failed to stop its throwaway database leaves one to stop here.
    const pidFile = path.join(root, 'mongod.pid');
    if (existsSync(pidFile)) spawnSync(bash, ['-c', 'kill "$1" 2>/dev/null', '_', readFileSync(pidFile, 'utf8').trim()]);
    rmSync(root, { recursive: true, force: true });
  });

  // A completed backup in the form backup.sh writes; each collection file holds its document count.
  function makeBackup(name: string, collections: Record<string, number> = { 'testdb/blocks': 3, 'testdb/txs': 2, 'admin/system.version': 1 }, complete = true) {
    const folder = path.join(backups, name);
    const files: Record<string, Buffer | string> = { 'backup.meta': `created_at=x\ngit_commit=x\ncollections=${Object.keys(collections).length}\n` };
    for (const [collection, count] of Object.entries(collections)) {
      files[`${collection}.bson.gz`] = gzipSync(String(count));
      files[`${collection}.metadata.json.gz`] = gzipSync('{"indexes":[]}');
    }
    const checksums = Object.entries(files).map(([file, content]) => {
      mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
      writeFileSync(path.join(folder, file), content);
      return `${createHash('sha256').update(content).digest('hex')}  ./${file}\n`;
    });
    writeFileSync(path.join(folder, 'backup.sha256'), checksums.join(''));
    if (complete) writeFileSync(path.join(folder, '.complete'), '');
    return folder;
  }
  // Every way a finished backup can stop being what was written.
  const damages: [string, (folder: string) => void][] = [
    ['lost a collection', (folder) => rmSync(path.join(folder, 'testdb', 'txs.bson.gz'))],
    ['lost only the indexes of a collection', (folder) => rmSync(path.join(folder, 'testdb', 'blocks.metadata.json.gz'))],
    ['a changed collection', (folder) => writeFileSync(path.join(folder, 'testdb', 'blocks.bson.gz'), gzipSync('3 '))],
    ['a changed record of its contents', (folder) => writeFileSync(path.join(folder, 'backup.meta'), 'collections=9\n')],
    ['an added collection', (folder) => writeFileSync(path.join(folder, 'testdb', 'extra.bson.gz'), gzipSync('1'))],
  ];
  const run = (script: string, ...args: string[]) => spawnSync(bash, [posix(path.join(opsDir, script)), '--backup-dir', posix(backups), ...args],
    { env, encoding: 'utf8' });
  const calls = () => readFileSync(logFile, 'utf8');

  describe('ops:restore', () => {
    const restore = (...args: string[]) => run('restore.sh', '--backup', 'defcon_explorer_old', '--health-url', 'http://127.0.0.1:1/ready', ...args);

    it('restores from the database folder when the URI names a database, between stopping and starting the service', () => {
      makeBackup('defcon_explorer_old');
      const result = restore('--yes');

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Restore completed successfully');
      const log = calls();
      expect(log).toMatch(/mongorestore .*--drop .*defcon_explorer_old\/testdb\n/);
      expect(log.indexOf('mongodump')).toBeLessThan(log.indexOf('systemctl stop'));
      expect(log.indexOf('systemctl stop')).toBeLessThan(log.indexOf('mongorestore'));
      expect(log.indexOf('mongorestore')).toBeLessThan(log.indexOf('systemctl start'));
      expect(result.stdout).toMatch(/Safety backup: .*defcon_explorer_\d/);
      expect(readdirSync(path.join(root, 'tmp'))).toEqual([]);
    });

    it('restores the whole backup when the URI names no database', () => {
      makeBackup('defcon_explorer_old');
      env.MONGODB_URI = 'mongodb://127.0.0.1:27017/?retryWrites=true';
      const result = restore('--yes');

      expect(result.status, result.stderr).toBe(0);
      expect(calls()).toMatch(/mongorestore .*--drop .*defcon_explorer_old\n/);
    });

    it.each([
      ['mongorestore exits with an error', 'exit', 'mongorestore failed'],
      ['no summary is reported', 'no-summary', 'did not report how many'],
      ['documents failed', 'failed-documents', 'failed to restore 2 documents'],
      ['a collection did not finish', 'unfinished', 'finished 1 collections of 2'],
    ])('fails and starts the service again when %s', (_case, mode, message) => {
      makeBackup('defcon_explorer_old');
      env.STUB_FAIL = mode;
      const result = restore('--yes');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain('Restore completed successfully');
      expect(result.stderr).toMatch(/Safety backup: .*defcon_explorer_\d/);
      expect(calls()).toContain('systemctl start');
    });

    it('fails when the backup restores no documents', () => {
      makeBackup('defcon_explorer_old', { 'testdb/blocks': 0 });
      const result = restore('--yes');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('restored no documents');
      expect(calls()).toContain('systemctl start');
    });

    it.each([[['--yes']], [['--dry-run']]])('stops before changing anything when the backup has no folder for the database in the URI, with %j', (args) => {
      makeBackup('defcon_explorer_old');
      env.MONGODB_URI = 'mongodb://127.0.0.1:27017/another';
      const result = restore(...args);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('no folder for the database in MONGODB_URI: another');
      expect(calls()).toBe('');
    });

    it.each(damages)('stops before changing anything when a backup has %s', (_damage, apply) => {
      apply(makeBackup('defcon_explorer_old'));
      for (const args of [['--yes'], ['--dry-run']]) {
        const result = restore(...args);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/lost or changed|do not list/);
        expect(calls()).toBe('');
      }
    });

    it('takes a backup from before checksums only when told to', () => {
      rmSync(path.join(makeBackup('defcon_explorer_old'), 'backup.sha256'));
      const refused = restore('--yes');
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('--allow-unverified');
      expect(calls()).toBe('');

      const allowed = restore('--yes', '--allow-unverified');
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stderr).toContain('Backup has no checksums');
      expect(allowed.stdout).toContain('Restore completed successfully');
    });

    it('keeps the credentials out of what it prints and of the arguments', () => {
      makeBackup('defcon_explorer_old');
      const credentials = ['explorer', 's3cret-value'].join(':');
      env.MONGODB_URI = `mongodb://${credentials}@127.0.0.1:27017/testdb?authSource=admin`;
      const result = restore('--yes');

      expect(result.status, result.stderr).toBe(0);
      expect(calls()).toMatch(/defcon_explorer_old\/testdb\n/);
      expect(`${result.stdout}${result.stderr}${calls()}`).not.toContain('s3cret-value');
    });
  });

  describe('the lock of the backup root', () => {
    it.runIf(hasFlock)('is held while a restore check restores', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      env.STUB_CHECK_LOCK = posix(backups);
      const result = run('restore-check.sh');
      expect(result.status, result.stderr).toBe(0);
      expect(calls()).toContain('lock held during the restore');
    });

    it.runIf(hasFlock)('is held while a restore restores', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      env.STUB_CHECK_LOCK = posix(backups);
      const result = run('restore.sh', '--backup', 'defcon_explorer_20260101T000000Z', '--yes');
      expect(result.status, result.stderr).toBe(0);
      expect(calls()).toContain('lock held during the restore');
    });

    it.runIf(hasFlock)('makes a restore check give up before it starts anything', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      env.BACKUP_LOCK_WAIT_SECONDS = '0';
      const result = spawnSync(bash, ['-c', 'flock "$1" bash "$2" --backup-dir "$1"', '_', posix(backups), posix(path.join(opsDir, 'restore-check.sh'))], { env, encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('is still running');
      expect(calls()).toBe('');
    });

    it.runIf(hasFlock)('makes a restore check take the backup that was being written', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      // Hidden, so nothing takes it for a backup until the holder of the lock moves it into place.
      makeBackup('.being-written');
      const result = spawnSync(bash, ['-c', `flock "$1" bash -c 'sleep 1; mv "$0/.being-written" "$0/defcon_explorer_20260102T000000Z"' "$1" &
sleep 0.3
bash "$2" --backup-dir "$1"; status=$?
wait
exit $status`, '_', posix(backups), posix(path.join(opsDir, 'restore-check.sh'))], { env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Checking backup: defcon_explorer_20260102T000000Z');
    });

    it.runIf(hasFlock)('stops a restore that lost its backup to a retention pass, with the service still up', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      // The safety backup is the last step before the lock: the selected backup goes away right after it.
      writeFileSync(path.join(root, 'stubs', 'mongodump'), `${STUBS.mongodump}rm -rf -- "$STUB_REMOVE"\n`);
      env.STUB_REMOVE = posix(path.join(backups, 'defcon_explorer_20260101T000000Z'));
      const result = run('restore.sh', '--backup', 'defcon_explorer_20260101T000000Z', '--yes');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Backup directory not found');
      expect(calls()).not.toContain('systemctl stop');
      expect(calls()).not.toContain('mongorestore');
    });
  });

  describe('ops:restore-check', () => {
    const workFolders = () => readdirSync(backups).filter((name) => name.startsWith('.restore-check'));
    const mongodStillRuns = () => {
      const pidFile = path.join(root, 'mongod.pid');
      if (!existsSync(pidFile)) return false;
      return spawnSync(bash, ['-c', 'kill -0 "$1" 2>/dev/null', '_', readFileSync(pidFile, 'utf8').trim()]).status === 0;
    };

    it('restores into its own database, compares every collection and removes what it started', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      const result = run('restore-check.sh');

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('testdb.blocks: 3 documents');
      expect(result.stdout).toContain('testdb.txs: 2 documents');
      expect(result.stdout).toContain('restored 5 documents');
      expect(result.stdout).not.toContain('system.version');
      const log = calls();
      // A socket in its private folder: no other local account can reach the database,
      // and no other server can receive the data.
      expect(log).toMatch(/mongod .*--bind_ip \S*\/\.restore-check\.[^ /]*\/mongod\.sock /);
      expect(log).toMatch(/mongod .*--unixSocketPrefix \S*\/\.restore-check\.\S* /);
      expect(log).toMatch(/mongorestore --uri=mongodb:\/\/[^ /]*%2F\.restore-check\.[^ /]*%2Fmongod\.sock\/ --gzip /);
      expect(log).not.toContain('127.0.0.1');
      expect(log).not.toContain('--drop');
      expect(log).not.toContain('27017');
      expect(log).not.toContain('systemctl');
      expect(workFolders()).toEqual([]);
      expect(mongodStillRuns()).toBe(false);
    });

    it('reads the report of tools that print collection names bare', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      env.STUB_BARE_NAMES = '1';
      const result = run('restore-check.sh');

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('testdb.blocks: 3 documents');
      expect(result.stdout).toContain('testdb.txs: 2 documents');
      expect(result.stdout).toContain('restored 5 documents');
    });

    it('still finds a short collection in such a report', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      env.STUB_BARE_NAMES = '1';
      env.STUB_FAIL = 'short';
      const result = run('restore-check.sh');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('testdb.blocks: 3 in the backup, 2 restored');
      expect(result.stdout).not.toContain('Restore check passed');
    });

    it('does not read the live database settings', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      delete env.MONGODB_URI;
      env.ENV_FILE = posix(path.join(root, 'missing.env'));
      const result = run('restore-check.sh');

      expect(result.status, result.stderr).toBe(0);
    });

    it('takes the newest complete backup and passes over an incomplete one', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      makeBackup('defcon_explorer_20260102T000000Z');
      makeBackup('defcon_explorer_20260103T000000Z', undefined, false);
      const result = run('restore-check.sh');

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Checking backup: defcon_explorer_20260102T000000Z');
      expect(calls()).toContain('defcon_explorer_20260102T000000Z');
    });

    it('checks the backup it is told to', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      makeBackup('defcon_explorer_20260102T000000Z');
      const result = run('restore-check.sh', '--backup', 'defcon_explorer_20260101T000000Z');

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Checking backup: defcon_explorer_20260101T000000Z');
    });

    it.each([
      ['a collection has fewer documents than the backup', 'short', 'testdb.blocks: 3 in the backup, 2 restored'],
      ['mongorestore exits with an error', 'exit', 'mongorestore failed'],
      ['a collection did not finish', 'unfinished', 'finished 1 collections of 2'],
      ['documents failed', 'failed-documents', 'failed to restore 2 documents'],
      ['the throwaway database does not start', 'mongod', 'did not start'],
    ])('fails and leaves nothing behind when %s', (_case, mode, message) => {
      makeBackup('defcon_explorer_20260101T000000Z');
      env.STUB_FAIL = mode;
      const result = run('restore-check.sh');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain('Restore check passed');
      expect(workFolders()).toEqual([]);
      expect(mongodStillRuns()).toBe(false);
    });

    it.each(damages)('refuses a backup with %s before starting anything', (_damage, apply) => {
      apply(makeBackup('defcon_explorer_20260101T000000Z'));
      const result = run('restore-check.sh');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/lost or changed|do not list/);
      expect(calls()).toBe('');
      expect(workFolders()).toEqual([]);
    });

    it('takes a backup from before checksums only when told to', () => {
      rmSync(path.join(makeBackup('defcon_explorer_20260101T000000Z'), 'backup.sha256'));
      const refused = run('restore-check.sh');
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('--allow-unverified');
      expect(calls()).toBe('');

      const allowed = run('restore-check.sh', '--allow-unverified');
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(allowed.stderr).toContain('Backup has no checksums');
      expect(allowed.stdout).toContain('restored 5 documents');
    });

    it('starts nothing on a dry run', () => {
      makeBackup('defcon_explorer_20260101T000000Z');
      const result = run('restore-check.sh', '--dry-run');

      expect(result.status, result.stderr).toBe(0);
      expect(calls()).toBe('');
      expect(workFolders()).toEqual([]);
    });

    it('refuses when there is nothing to check or the path leaves the backup root', () => {
      const none = run('restore-check.sh');
      expect(none.status).not.toBe(0);
      expect(none.stderr).toContain('No complete backup found');

      const outside = run('restore-check.sh', '--backup', '../stubs');
      expect(outside.status).not.toBe(0);
      expect(outside.stderr).toContain('Path escapes the allowed directory');

      makeBackup('defcon_explorer_20260101T000000Z', undefined, false);
      const incomplete = run('restore-check.sh', '--backup', 'defcon_explorer_20260101T000000Z');
      expect(incomplete.status).not.toBe(0);
      expect(incomplete.stderr).toContain('incomplete');
      expect(existsSync(path.join(backups, 'defcon_explorer_20260101T000000Z'))).toBe(true);
      expect(calls()).toBe('');
    });
  });
});
