import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const unitDir = path.resolve(__dirname, '../../docs/server-config');

// Reads the ExecStartPre lines of a reference unit, as systemd would run them on this layout.
const guardOf = (unit: string, checkout: string) => readFileSync(path.join(unitDir, unit), 'utf8').split(/\r?\n/)
  .filter((line) => line.startsWith('ExecStartPre='))
  .map((line) => line.slice('ExecStartPre='.length)
    .replaceAll('/opt/deftrack', checkout)
    .replaceAll('${USER}', '"$USER"')
    .replaceAll('%%', '%')
    .replaceAll('( ', '\\( ')
    .replaceAll(' )', ' \\)'))
  .join(' && ');

// File modes mean little in Git Bash on Windows.
describe.runIf(process.platform === 'linux')('the guard of the backup units', () => {
  let root: string;
  let checkout: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ops-units-'));
    checkout = path.join(root, 'checkout');
    mkdirSync(path.join(checkout, 'scripts', 'ops'), { recursive: true });
    mkdirSync(path.join(checkout, 'backups', 'mongodb'), { recursive: true });
    writeFileSync(path.join(checkout, 'scripts', 'ops', 'backup.sh'), '');
    writeFileSync(path.join(checkout, '.env'), '');
    for (const folder of ['', 'scripts', 'scripts/ops', 'backups', 'backups/mongodb']) chmodSync(path.join(checkout, folder), 0o755);
    chmodSync(path.join(checkout, 'scripts', 'ops', 'backup.sh'), 0o644);
    chmodSync(path.join(checkout, '.env'), 0o600);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (unit: string, target = checkout, user = process.env.USER ?? spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim()) =>
    spawnSync('bash', ['-c', guardOf(unit, target)], { env: { ...process.env, USER: user }, encoding: 'utf8' });

  for (const unit of ['deftrack-backup.service', 'deftrack-restore-check.service']) {
    describe(unit, () => {
      it('lets a closed checkout through, also behind a symlink', () => {
        expect(guardOf(unit, checkout)).not.toBe('');
        const direct = run(unit);
        expect(direct.status, direct.stderr).toBe(0);

        const link = path.join(root, 'link');
        symlinkSync(checkout, link);
        const linked = run(unit, link);
        expect(linked.status, linked.stderr).toBe(0);
      });

      for (const open of ['', 'scripts', 'scripts/ops', 'scripts/ops/backup.sh', 'backups', 'backups/mongodb']) {
        it(`stops when "${open || 'the checkout'}" is writable by everybody`, () => {
          chmodSync(path.join(checkout, open), 0o777);
          const result = run(unit);
          expect(result.status).not.toBe(0);
          expect(result.stdout).toContain('Another account could change:');
          expect(result.stdout).toContain(path.join(checkout, open).replace(/\/$/, ''));
        });
      }

      for (const [open, mode] of [['', 0o775], ['scripts', 0o775], ['scripts/ops', 0o775], ['scripts/ops/backup.sh', 0o664]] as const) {
        it(`stops when "${open || 'the checkout'}" is writable by its group`, () => {
          chmodSync(path.join(checkout, open), mode);
          const result = run(unit);
          expect(result.status).not.toBe(0);
          expect(result.stdout).toContain('Another account could change:');
          expect(result.stdout).toContain(path.join(checkout, open).replace(/\/$/, ''));
        });
      }

      it('stops when a script is a link, whose target it would not see', () => {
        const script = path.join(checkout, 'scripts', 'ops', 'backup.sh');
        const target = path.join(root, 'elsewhere.sh');
        writeFileSync(target, '');
        chmodSync(target, 0o644);
        rmSync(script);
        symlinkSync(target, script);
        const result = run(unit);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(script);
      });

      it('accepts group write in the backups, which belong to the copy account\'s group', () => {
        chmodSync(path.join(checkout, 'backups', 'mongodb'), 0o770);
        const result = run(unit);
        expect(result.status, result.stderr).toBe(0);
      });

      it('stops when the paths belong to another account', () => {
        const result = run(unit, checkout, 'root');
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain('Another account could change:');
      });

      it('stops when a path cannot be read', () => {
        rmSync(path.join(checkout, 'scripts'), { recursive: true });
        const result = run(unit);
        expect(result.status).not.toBe(0);
      });
    });
  }

  it('looks at .env for the backup, which reads it', () => {
    chmodSync(path.join(checkout, '.env'), 0o660);
    const result = run('deftrack-backup.service');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('.env');
  });

  it('stops the backup when .env is a link, whose target could be replaced', () => {
    const env = path.join(checkout, '.env');
    const target = path.join(root, 'elsewhere.env');
    writeFileSync(target, '');
    chmodSync(target, 0o600);
    rmSync(env);
    symlinkSync(target, env);
    const result = run('deftrack-backup.service');
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(env);
  });
});
