import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const pullScript = path.resolve(__dirname, '../../scripts/ops/backup-pull.sh');
const libScript = path.resolve(__dirname, '../../scripts/ops/lib.sh');
// As in opsDeploy.test.ts: a local run on Windows names Git Bash's usr/bin/bash.exe.
const bash = process.env.OPS_TEST_BASH ?? 'bash';
const posix = (file: string) => file.split(path.sep).join('/');
// Git Bash has no rsync, so a Windows run skips these. Linux, the platform they target, never does.
const canRun = process.platform === 'linux'
  || (Boolean(process.env.OPS_TEST_BASH) && spawnSync(bash, ['-c', 'command -v rsync'], { stdio: 'ignore' }).status === 0);

const backupName = (hoursAgo: number, second = 0) => {
  const stamp = new Date(Date.now() - hoursAgo * 3_600_000).toISOString().slice(0, 19).replace(/[-:]/g, '');
  return `defcon_explorer_${stamp.slice(0, -2)}${String(second).padStart(2, '0')}Z`;
};

describe.skipIf(!canRun)('backup copy script', { timeout: 60_000 }, () => {
  let root: string;
  let source: string;
  let target: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ops-backup-pull-'));
    source = path.join(root, 'source');
    target = path.join(root, 'copies');
    mkdirSync(source);
    env = { ...process.env };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Written the way backup.sh writes one: checksums through its own helper, .complete last.
  const makeBackup = (name: string, { complete = true } = {}) => {
    const folder = path.join(source, name);
    mkdirSync(path.join(folder, 'testdb'), { recursive: true });
    writeFileSync(path.join(folder, 'testdb', 'blocks.bson.gz'), `blocks of ${name}`);
    writeFileSync(path.join(folder, 'testdb', 'blocks.metadata.json.gz'), 'metadata');
    writeFileSync(path.join(folder, 'backup.meta'), 'collections=1\n');
    execFileSync(bash, ['-c', 'source "$1"; write_backup_checksums "$2"', '_', posix(libScript), posix(folder)], { env });
    if (complete) writeFileSync(path.join(folder, '.complete'), '');
    return folder;
  };
  // A test host may have little free disk; the test of that limit sets its own.
  const pull = (...args: string[]) => spawnSync(bash, [posix(pullScript), '--from', posix(source), '--to', posix(target), '--min-free-gb', '0', ...args],
    { env, encoding: 'utf8' });
  const copies = () => (existsSync(target) ? readdirSync(target).sort() : []);
  const snapshot = (folder: string) => readdirSync(folder, { recursive: true, encoding: 'utf8' }).sort()
    .map((file) => `${file}:${statSync(path.join(folder, file)).mtimeMs}`);

  it('copies a finished backup, whose copy passes its checksums, and leaves the source as it was', () => {
    const name = backupName(1);
    const folder = makeBackup(name);
    const before = snapshot(source);

    const result = pull();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`1 new, newest ${name}`);
    expect(copies()).toEqual([name]);
    const copy = path.join(target, name);
    expect(readFileSync(path.join(copy, 'testdb', 'blocks.bson.gz'), 'utf8')).toBe(`blocks of ${name}`);
    expect(existsSync(path.join(copy, '.complete'))).toBe(true);
    const check = spawnSync(bash, ['-c', 'cd "$1" && sha256sum --check --quiet --strict backup.sha256', '_', posix(copy)], { env, encoding: 'utf8' });
    expect(check.status, check.stdout).toBe(0);
    expect(snapshot(source)).toEqual(before);
    expect(existsSync(folder)).toBe(true);
  });

  it('keeps every copy private, whatever the modes in the source', () => {
    const name = backupName(1);
    const folder = makeBackup(name);
    execFileSync(bash, ['-c', 'chmod -R a+rX "$1"', '_', posix(folder)], { env });

    expect(pull().status).toBe(0);

    const copy = path.join(target, name);
    for (const file of [target, copy, path.join(copy, 'testdb'), path.join(copy, 'backup.meta'), path.join(copy, 'testdb', 'blocks.bson.gz')]) {
      expect(statSync(file).mode & 0o077, file).toBe(0);
    }
  });

  it('leaves out a backup still being written, work folders and anything with another name', () => {
    const finished = backupName(1);
    makeBackup(finished);
    makeBackup(backupName(0), { complete: false });
    mkdirSync(path.join(source, '.restore-check.abc123'));
    writeFileSync(path.join(source, '.restore-check.abc123', '.complete'), '');
    makeBackup('other_20260101T000000Z');
    makeBackup('defcon_explorer_latest');
    makeBackup('defcon_explorer_20260101T000000Z.old');
    // The end of this one reads like an exact name, and no folder has that name.
    makeBackup('defcon_explorer_a defcon_explorer_20260101T000000Z');

    const result = pull();

    expect(result.status, result.stderr).toBe(0);
    expect(copies()).toEqual([finished]);
  });

  it('does not count a damaged copy, and still takes the good ones', () => {
    const damaged = backupName(1);
    const good = backupName(2);
    const damagedFolder = makeBackup(damaged);
    makeBackup(good);
    writeFileSync(path.join(damagedFolder, 'testdb', 'blocks.bson.gz'), 'changed after the backup finished');

    const result = pull();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`The copy did not pass its checks: ${damaged}`);
    expect(result.stderr).toContain('1 backups could not be copied');
    expect(copies()).toEqual([good]);
  });

  it('does not count a copy that lost a file its checksums list', () => {
    const name = backupName(1);
    const folder = makeBackup(name);
    rmSync(path.join(folder, 'testdb', 'blocks.metadata.json.gz'));

    const result = pull();

    expect(result.status).not.toBe(0);
    expect(copies()).toEqual([]);
  });

  it('does not count a copy that the transfer left unfinished', () => {
    const name = backupName(1);
    makeBackup(name);
    const stubDir = path.join(root, 'stubs');
    mkdirSync(stubDir);
    // The real rsync lists, then the copy stops after writing the mark that a backup finished.
    writeFileSync(path.join(stubDir, 'rsync'), `#!/usr/bin/env bash
case "$*" in
  *--list-only*) PATH="\${PATH#*:}" exec rsync "$@" ;;
esac
mkdir -p "\${@: -1}"
touch "\${@: -1}/.complete"
exit 23
`);
    execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'rsync'))], { env });
    env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;

    const result = pull();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Copying failed: ${name}`);
    expect(copies()).toEqual([]);
  });

  it('does not copy a link out of a backup', () => {
    const name = backupName(1);
    const folder = makeBackup(name);
    const secret = path.join(root, 'secret');
    writeFileSync(secret, 'outside the backup');
    symlinkSync(secret, path.join(folder, 'testdb', 'link.bson.gz'));

    const result = pull();

    expect(result.status, result.stderr).toBe(0);
    const copied = path.join(target, name, 'testdb', 'link.bson.gz');
    expect(() => lstatSync(copied)).toThrow();
  });

  it('leaves an existing copy alone', () => {
    const name = backupName(1);
    makeBackup(name);
    expect(pull().status).toBe(0);
    const copy = path.join(target, name);
    writeFileSync(path.join(copy, 'testdb', 'blocks.bson.gz'), 'the copy from the first run');

    const result = pull();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`0 new, newest ${name}`);
    expect(readFileSync(path.join(copy, 'testdb', 'blocks.bson.gz'), 'utf8')).toBe('the copy from the first run');
  });

  it('fetches a bounded number in one run, newest first, and the rest in later runs', () => {
    const names = [1, 2, 3, 4, 5].map((hours) => backupName(hours));
    names.forEach((name) => makeBackup(name));

    const first = pull('--max-new', '2');
    expect(first.status, first.stderr).toBe(0);
    expect(copies()).toEqual([names[1], names[0]]);

    const second = pull('--max-new', '2');
    expect(second.status, second.stderr).toBe(0);
    expect(copies()).toEqual([names[3], names[2], names[1], names[0]]);
  });

  it('keeps the newest copies by count and removes older ones', () => {
    const names = [1, 2, 3, 4].map((hours) => backupName(hours));
    names.forEach((name) => makeBackup(name));

    const result = pull('--keep', '2', '--max-new', '10');

    expect(result.status, result.stderr).toBe(0);
    expect(copies()).toEqual([names[1], names[0]]);
  });

  it('keeps the copies when the source has nothing left', () => {
    const name = backupName(1);
    const folder = makeBackup(name);
    expect(pull('--keep', '1').status).toBe(0);
    rmSync(folder, { recursive: true });

    const result = pull('--keep', '1');

    expect(result.status, result.stderr).toBe(0);
    expect(copies()).toEqual([name]);
  });

  it('removes only finished copies of backups when it trims', () => {
    const names = [1, 2].map((hours) => backupName(hours));
    names.forEach((name) => makeBackup(name));
    mkdirSync(target);
    mkdirSync(path.join(target, 'notes'));
    mkdirSync(path.join(target, backupName(50)));

    const result = pull('--keep', '1', '--max-new', '10');

    expect(result.status, result.stderr).toBe(0);
    expect(copies()).toEqual(expect.arrayContaining(['notes', names[0], backupName(50)]));
    expect(copies()).not.toContain(names[1]);
  });

  it('refuses a backup dated in the future or at an impossible time', () => {
    const good = backupName(1);
    makeBackup(good);
    const future = backupName(-48);
    const impossible = 'defcon_explorer_20261399T000000Z';
    makeBackup(future);
    makeBackup(impossible);

    const result = pull();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`impossible time in its name: ${future}`);
    expect(result.stderr).toContain(`impossible time in its name: ${impossible}`);
    expect(copies()).toEqual([good]);
  });

  it('fails when the newest copy is too old, and keeps it', () => {
    const name = backupName(40);
    makeBackup(name);

    const result = pull('--max-age-hours', '36');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`The newest copy is 4\\d hours old: ${name}`));
    expect(copies()).toEqual([name]);
  });

  it('holds the age limit to the minute, not to the rounded hour', () => {
    const over = backupName(36.5);
    makeBackup(over);
    const tooOld = pull('--max-age-hours', '36');
    expect(tooOld.status).not.toBe(0);
    expect(tooOld.stderr).toContain(`The newest copy is 36 hours old: ${over}`);

    const within = backupName(35.5);
    makeBackup(within);
    const result = pull('--max-age-hours', '36');
    expect(result.status, result.stderr).toBe(0);
  });

  it('leaves another run alone, and its work folder too', () => {
    const name = backupName(1);
    makeBackup(name);
    const otherRun = path.join(target, '.incoming.other-run');
    mkdirSync(otherRun, { recursive: true });

    // The outer flock is the other run: it holds the lock while this one starts.
    const result = spawnSync(bash, ['-c', 'flock "$1" bash "$2" --from "$3" --to "$1" --min-free-gb 0', '_', posix(target), posix(pullScript), posix(source)],
      { env, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Another copy is running');
    expect(existsSync(otherRun)).toBe(true);
    expect(existsSync(path.join(target, name))).toBe(false);
  });

  it('fetches nothing while the disk is nearly full, and keeps what it has', () => {
    const kept = backupName(2);
    makeBackup(kept);
    expect(pull().status).toBe(0);
    const next = backupName(1);
    makeBackup(next);

    const result = pull('--min-free-gb', '100000000');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`so ${next} was not copied`);
    expect(result.stderr).toContain('1 backups could not be copied');
    expect(copies()).toEqual([kept]);
  });

  it('fails when there is no copy at all', () => {
    const result = pull();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('No copy of a backup exists');
  });

  it('fails when the source cannot be read, and keeps the copies', () => {
    const name = backupName(1);
    makeBackup(name);
    expect(pull().status).toBe(0);
    rmSync(source, { recursive: true });

    const result = pull();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Could not list the backups');
    expect(copies()).toEqual([name]);
  });

  it('clears what a killed run left behind', () => {
    const name = backupName(1);
    makeBackup(name);
    mkdirSync(path.join(target, '.incoming.left-behind', name), { recursive: true });

    const result = pull();

    expect(result.status, result.stderr).toBe(0);
    expect(copies()).toEqual([name]);
  });

  it('refuses wrong settings before it reads anything', () => {
    for (const args of [['--keep', '0'], ['--max-new', 'many'], ['--max-age-hours', ''], ['--min-free-gb', '-1'], ['--ssh-key', 'a key']]) {
      const result = pull(...args);
      expect(result.status, args.join(' ')).not.toBe(0);
      expect(result.stderr, args.join(' ')).toMatch(/must /);
      expect(existsSync(target), args.join(' ')).toBe(false);
    }
    const noSource = spawnSync(bash, [posix(pullScript), '--to', posix(target)], { env, encoding: 'utf8' });
    expect(noSource.status).not.toBe(0);
    expect(noSource.stderr).toContain('--from is required');
  });
});
