import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const opsDir = path.resolve(__dirname, '../../scripts/ops');
// The scripts rely on GNU tools. On Windows a bare `bash` may be the WSL launcher, so a local run
// names Git Bash explicitly: its usr/bin/bash.exe, because the bin/bash.exe wrapper puts Git's own
// tools ahead of the stubs.
const bash = process.env.OPS_TEST_BASH ?? 'bash';
const canRun = process.platform === 'linux' || Boolean(process.env.OPS_TEST_BASH);
// Git Bash has no flock. There it becomes a stub, and the test that needs the real one is skipped.
const hasFlock = canRun && spawnSync(bash, ['-c', 'command -v flock']).status === 0;

const OLD_DIST = {
  'index.html': '<script src="/assets/old-entry.js"></script>',
  'assets/old-entry.js': 'old entry',
  'assets/old-route.js': 'old route, loaded only when a tab opens that page',
  'robots.txt': 'old robots',
  'retired.txt': 'no longer part of the build',
};

// npm stands in for the real build: without --outDir it empties client/dist the way Vite does.
const NPM_STUB = `#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
[[ "\${1:-}" != "--version" ]] || { echo 10.0.0; exit 0; }
case " $* " in
  *" ci "*)
    if [[ -n "\${STUB_DURING_CI:-}" ]]; then
      bash -c "$STUB_DURING_CI" >> "$STUB_LOG" 2>&1
      echo "second deploy exit $?" >> "$STUB_LOG"
    fi
    ;;
  *" run lint "*) [[ "\${STUB_FAIL:-}" != lint ]] || exit 1 ;;
  *" run build -w @defcon/shared "*|*" run build -w @defcon/server "*) ;;
  *" run build"*)
    out="$STUB_APP/client/dist"
    while [[ $# -gt 0 ]]; do
      [[ "$1" != "--outDir" ]] || out="$2"
      shift
    done
    rm -rf "$out"
    [[ ! -f "$STUB_APP/client/dist/assets/old-route.js" ]] || echo "old build whole during client build" >> "$STUB_LOG"
    mkdir -p "$out/assets"
    echo partial > "$out/assets/partial.js"
    [[ "\${STUB_FAIL:-}" != client-build ]] || exit 1
    rm "$out/assets/partial.js"
    tag="\${STUB_TAG:-new}"
    echo "<script src=\\"/assets/$tag-entry.js\\"></script>" > "$out/index.html"
    echo "$tag entry" > "$out/assets/$tag-entry.js"
    echo "$tag route" > "$out/assets/$tag-route.js"
    echo "$tag robots" > "$out/robots.txt"
    ;;
esac
`;

// The deploy script of a release from before the lock: all it has is a preflight, then it builds in place.
const SCRIPT_WITHOUT_LOCK = `#!/usr/bin/env bash
dir="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd)"
source "$dir/lib.sh"
bash "$dir/preflight.sh" --app-dir "$APP_DIR" --service x --health-url y --require-clean
echo "script without a lock built in place" >> "$STUB_LOG"
`;

const STUBS: Record<string, string> = {
  npm: NPM_STUB,
  sudo: `#!/usr/bin/env bash
if [[ "\${1:-}" == "-u" ]]; then shift 2; fi
if [[ "\${1:-}" == "--" ]]; then shift; fi
exec "$@"
`,
  systemctl: `#!/usr/bin/env bash
case "\${1:-}" in
  is-active) echo active ;;
  restart)
    echo "restart with $(cat "$STUB_APP/client/dist/index.html")" >> "$STUB_LOG"
    [[ "\${STUB_FAIL:-}" != restart ]] || exit 1
    if [[ "\${STUB_FAIL:-}" == readiness ]]; then rm -f "$STUB_DIR/healthy"; else touch "$STUB_DIR/healthy"; fi
    ;;
esac
`,
  curl: `#!/usr/bin/env bash
[[ -f "$STUB_DIR/healthy" ]] || exit 22
echo '{"status":"ok"}'
`,
  journalctl: '#!/usr/bin/env bash\n',
  sleep: '#!/usr/bin/env bash\n',
};

function posix(value: string): string {
  return value.replace(/\\/g, '/');
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

function snapshot(dir: string, base = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      Object.assign(files, snapshot(full, base));
    } else {
      files[posix(path.relative(base, full))] = readFileSync(full, 'utf8');
    }
  }
  return files;
}

describe.skipIf(!canRun)('production client publish and deploy', { timeout: 120_000 }, () => {
  let root: string;
  let stubDir: string;
  let app: string;
  let dist: string;
  let records: string;
  let logFile: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ops-deploy-'));
    stubDir = path.join(root, 'stubs');
    app = path.join(root, 'app');
    dist = path.join(app, 'client', 'dist');
    records = path.join(app, 'client', '.release-records', 'dist');
    logFile = path.join(root, 'calls.log');
    mkdirSync(app);
    writeFileSync(logFile, '');
    for (const [name, body] of Object.entries(STUBS)) {
      writeFiles(stubDir, { [name]: body });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, name))]);
    }
    if (!hasFlock) {
      writeFiles(stubDir, { flock: '#!/usr/bin/env bash\n' });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'flock'))]);
    }

    env = { ...process.env };
    for (const key of ['APP_DIR', 'APP_OWNER', 'SERVICE_NAME', 'HEALTH_URL', 'ENV_FILE', 'MONGODB_URI',
      'DEPLOY_BRANCH', 'CLIENT_KEEP_RELEASES', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
      delete env[key];
    }
    env.PATH = `${stubDir}${path.delimiter}${process.env.PATH}`;
    env.STUB_LOG = posix(logFile);
    env.STUB_APP = posix(app);
    env.STUB_DIR = posix(stubDir);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const calls = () => readFileSync(logFile, 'utf8');

  function publish(staging: string, target: string) {
    return spawnSync(
      bash,
      ['-c', 'source "$1"; shift; publish_client_build "$@"', '_',
        posix(path.join(opsDir, 'lib.sh')), posix(staging), posix(target), posix(records)],
      { env, encoding: 'utf8' },
    );
  }

  function confirm(keep = '3') {
    return spawnSync(
      bash,
      ['-c', 'source "$1"; shift; confirm_client_release "$@"', '_',
        posix(path.join(opsDir, 'lib.sh')), posix(dist), posix(records), keep],
      { env, encoding: 'utf8' },
    );
  }

  function git(...args: string[]): string {
    return execFileSync(
      'git',
      ['-c', 'user.name=ops-test', '-c', 'user.email=ops-test@example.invalid', '-c', 'commit.gpgsign=false', ...args],
      { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  }

  function commit(message: string): string {
    git('add', '-A');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  }

  // Commits: first (no scripts at all) <- withoutLock (older deploy script) <- installed (running
  // checkout) <- next (on origin only).
  function createCheckout() {
    execFileSync('git', ['init', '--bare', '-b', 'main', posix(path.join(root, 'origin.git'))], { env, stdio: 'ignore' });
    git('init', '-b', 'main');
    git('config', 'core.autocrlf', 'false');
    git('remote', 'add', 'origin', posix(path.join(root, 'origin.git')));
    writeFiles(app, {
      '.gitignore': 'dist/\nnode_modules/\n.env\n',
      'package.json': '{"name":"fixture"}\n',
      'release.txt': 'first\n',
    });
    const first = commit('first');
    cpSync(opsDir, path.join(app, 'scripts', 'ops'), { recursive: true });
    writeFiles(app, { 'scripts/ops/deploy.sh': SCRIPT_WITHOUT_LOCK, 'release.txt': 'without a lock\n' });
    const withoutLock = commit('without a lock');
    cpSync(opsDir, path.join(app, 'scripts', 'ops'), { recursive: true });
    writeFiles(app, { 'release.txt': 'installed\n' });
    const installed = commit('installed');
    writeFiles(app, { 'release.txt': 'next\n' });
    const next = commit('next');
    git('push', 'origin', 'main');
    git('reset', '--hard', installed);
    writeFiles(app, {
      '.env': 'MONGODB_URI=mongodb://fixture.invalid/x\nRPC_HOST=x\nRPC_PORT=1\nRPC_USER=x\nRPC_PASS=x\n',
    });
    writeFiles(dist, OLD_DIST);
    writeFiles(stubDir, { healthy: '' });
    return { first, withoutLock, installed, next };
  }

  function deploy(...args: string[]) {
    return spawnSync(
      bash,
      [posix(path.join(app, 'scripts', 'ops', 'deploy.sh')), '--app-dir', posix(app),
        '--service', 'fixture.service', '--health-url', 'http://fixture.invalid/ready', ...args],
      { env, encoding: 'utf8' },
    );
  }

  describe('publish_client_build', () => {
    let staging: string;
    const newBuild = (tag: string) => ({
      'index.html': `<script src="/assets/${tag}-entry.js"></script>`,
      [`assets/${tag}-entry.js`]: `${tag} entry`,
      [`assets/${tag}-route.js`]: `${tag} route`,
      'robots.txt': `${tag} robots`,
      '.well-known/security.txt': `${tag} contact`,
    });

    const assets = () => Object.keys(snapshot(dist)).filter((name) => name.startsWith('assets/')).sort();

    // A build that reached the restart and readiness.
    function release(files: Record<string, string>, keep = '3') {
      writeFiles(staging, files);
      const published = publish(staging, dist);
      expect(published.status, published.stderr).toBe(0);
      rmSync(staging, { recursive: true, force: true });
      const confirmed = confirm(keep);
      expect(confirmed.status, confirmed.stderr).toBe(0);
    }

    beforeEach(() => {
      staging = path.join(root, 'staging');
      writeFiles(dist, OLD_DIST);
    });

    it('adds the new build and leaves every hashed file of the old one in place', () => {
      writeFiles(staging, newBuild('new'));

      const result = publish(staging, dist);

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const after = snapshot(dist);
      expect(after['index.html']).toContain('new-entry.js');
      expect(after['assets/new-entry.js']).toBe('new entry');
      expect(after['assets/new-route.js']).toBe('new route');
      expect(after['assets/old-entry.js']).toBe(OLD_DIST['assets/old-entry.js']);
      expect(after['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
      expect(after['robots.txt']).toBe('new robots');
      expect(after['.well-known/security.txt']).toBe('new contact');
    });

    it('removes public files that left the build', () => {
      writeFiles(staging, newBuild('new'));

      expect(publish(staging, dist).status).toBe(0);

      expect(existsSync(path.join(dist, 'retired.txt'))).toBe(false);
    });

    it('replaces index.html only after everything else has arrived', () => {
      writeFiles(staging, newBuild('new'));
      writeFiles(stubDir, {
        mv: '#!/usr/bin/env bash\n[[ "${!#}" != */assets/new-route.js ]] || exit 1\nPATH="${PATH#*:}" exec mv "$@"\n',
      });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'mv'))]);

      const result = publish(staging, dist);

      expect(result.status).not.toBe(0);
      const after = snapshot(dist);
      expect(after['index.html']).toBe(OLD_DIST['index.html']);
      expect(after['assets/old-entry.js']).toBe(OLD_DIST['assets/old-entry.js']);
      expect(after['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
    });

    it.each([
      ['no index.html', () => writeFiles(staging, { 'assets/new-entry.js': 'x' })],
      ['no assets', () => writeFiles(staging, { 'index.html': 'x' })],
      ['an empty assets folder', () => {
        writeFiles(staging, { 'index.html': 'x' });
        mkdirSync(path.join(staging, 'assets'));
      }],
    ])('refuses a build with %s and changes nothing', (_label, prepare) => {
      prepare();
      const before = snapshot(dist);

      const result = publish(staging, dist);

      expect(result.status).not.toBe(0);
      expect(snapshot(dist)).toEqual(before);
    });

    it('drops hashed assets only once they are older than the kept releases', () => {
      release(newBuild('a'));
      release(newBuild('b'));
      // Files built in place, then two releases: all three generations still fit.
      expect(assets()).toEqual(expect.arrayContaining(['assets/old-route.js', 'assets/a-route.js', 'assets/b-route.js']));

      release(newBuild('c'));

      expect(assets()).toEqual([
        'assets/a-entry.js', 'assets/a-route.js',
        'assets/b-entry.js', 'assets/b-route.js',
        'assets/c-entry.js', 'assets/c-route.js',
      ]);
    });

    it('removes no hashed file while publishing, however often a publish is retried', () => {
      const tags = ['a', 'b', 'c', 'd', 'e'];
      for (const tag of tags) {
        writeFiles(staging, newBuild(tag));
        expect(publish(staging, dist).status).toBe(0);
        rmSync(staging, { recursive: true, force: true });
      }

      expect(assets()).toEqual(expect.arrayContaining([
        'assets/old-entry.js', 'assets/old-route.js',
        ...tags.flatMap((tag) => [`assets/${tag}-entry.js`, `assets/${tag}-route.js`]),
      ]));
    });

    it('keeps the running release through retried publishes, because a build no server ran does not count', () => {
      for (const tag of ['tried', 'tried-again', 'retried']) {
        writeFiles(staging, newBuild(tag));
        expect(publish(staging, dist).status).toBe(0);
        rmSync(staging, { recursive: true, force: true });
      }

      expect(confirm('2').status).toBe(0);

      // The build that was running stays for open tabs, and the attempts stay with it: a service
      // that restarted on its own may have served them.
      expect(assets()).toEqual([
        'assets/old-entry.js', 'assets/old-route.js',
        'assets/retried-entry.js', 'assets/retried-route.js',
        'assets/tried-again-entry.js', 'assets/tried-again-route.js',
        'assets/tried-entry.js', 'assets/tried-route.js',
      ]);

      // Negative control: a real release does push the oldest one out, and the attempts with it.
      release(newBuild('next'), '2');
      expect(assets()).toEqual([
        'assets/next-entry.js', 'assets/next-route.js',
        'assets/retried-entry.js', 'assets/retried-route.js',
      ]);
    });

    it('does not count a forgotten attempt as a release later on either', () => {
      for (const tag of ['tried', 'retried']) {
        writeFiles(staging, newBuild(tag));
        expect(publish(staging, dist).status).toBe(0);
        rmSync(staging, { recursive: true, force: true });
      }
      expect(confirm('3').status).toBe(0);

      release(newBuild('next'), '3');

      expect(assets()).toEqual([
        'assets/next-entry.js', 'assets/next-route.js',
        'assets/old-entry.js', 'assets/old-route.js',
        'assets/retried-entry.js', 'assets/retried-route.js',
        'assets/tried-entry.js', 'assets/tried-route.js',
      ]);
    });

    it('keeps the newest releases when the clock steps back between them', () => {
      writeFiles(stubDir, {
        date: '#!/usr/bin/env bash\nn="$(cat "$STUB_DIR/clock" 2>/dev/null || echo 900000)"\necho "$((n - 1))" > "$STUB_DIR/clock"\necho "$n"\n',
      });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'date'))]);

      for (const tag of ['a', 'b', 'c', 'd']) {
        release(newBuild(tag));
      }

      expect(assets()).toEqual([
        'assets/b-entry.js', 'assets/b-route.js',
        'assets/c-entry.js', 'assets/c-route.js',
        'assets/d-entry.js', 'assets/d-route.js',
      ]);
    });

    // Stops confirm_client_release at the first hashed file it tries to remove.
    function interruptAssetRemoval() {
      writeFiles(stubDir, {
        rm: '#!/usr/bin/env bash\n[[ "$*" != *assets/* ]] || exit 1\nPATH="${PATH#*:}" exec rm "$@"\n',
      });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'rm'))]);
    }

    it('still knows an attempt nobody ran when the cleanup was interrupted', () => {
      release(newBuild('a'), '2');
      for (const tag of ['tried', 'ran']) {
        writeFiles(staging, newBuild(tag));
        expect(publish(staging, dist).status).toBe(0);
        rmSync(staging, { recursive: true, force: true });
      }
      interruptAssetRemoval();
      expect(confirm('2').status).not.toBe(0);
      rmSync(path.join(stubDir, 'rm'));

      release(newBuild('next'), '2');

      // Taken for a build made in place, the attempt would count as a release and push out "ran".
      expect(assets()).toEqual([
        'assets/next-entry.js', 'assets/next-route.js',
        'assets/ran-entry.js', 'assets/ran-route.js',
      ]);
    });

    it('still knows an expired release when the cleanup was interrupted', () => {
      release(newBuild('a'), '2');
      writeFiles(staging, newBuild('b'));
      expect(publish(staging, dist).status).toBe(0);
      rmSync(staging, { recursive: true, force: true });
      interruptAssetRemoval();
      expect(confirm('2').status).not.toBe(0);
      rmSync(path.join(stubDir, 'rm'));

      release(newBuild('next'), '2');

      expect(assets()).toEqual([
        'assets/b-entry.js', 'assets/b-route.js',
        'assets/next-entry.js', 'assets/next-route.js',
      ]);
    });

    // Stands in for any failure while the lists of files are being made.
    function breakListing() {
      writeFiles(stubDir, { comm: '#!/usr/bin/env bash\nexit 1\n' });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'comm'))]);
    }

    it('stops and forgets nothing when it cannot work out which files to remove', () => {
      release(newBuild('a'), '2');
      writeFiles(staging, newBuild('b'));
      expect(publish(staging, dist).status).toBe(0);
      rmSync(staging, { recursive: true, force: true });
      breakListing();
      const before = readdirSync(records);

      expect(confirm('2').status).not.toBe(0);

      rmSync(path.join(stubDir, 'comm'));
      // The promoted build is the only change: the record of the release that expired is still there.
      expect(readdirSync(records).filter((name) => !name.startsWith('.')).sort()).toEqual(
        before.map((name) => name.replace('.attempt', '.list')).sort(),
      );
      release(newBuild('next'), '2');
      // A forgotten record would have made "old" look like a build made in place, pushing out "b".
      expect(assets()).toEqual([
        'assets/b-entry.js', 'assets/b-route.js',
        'assets/next-entry.js', 'assets/next-route.js',
      ]);
    });

    it('refuses to publish when it cannot work out which files have no record', () => {
      writeFiles(staging, newBuild('new'));
      breakListing();
      const before = snapshot(dist);

      expect(publish(staging, dist).status).not.toBe(0);

      expect(snapshot(dist)).toEqual(before);
      expect(readdirSync(records).some((name) => name.endsWith('.attempt'))).toBe(false);
    });

    it('accounts for the files of an interrupted publish', () => {
      writeFiles(staging, newBuild('cut'));
      writeFiles(stubDir, {
        mv: '#!/usr/bin/env bash\n[[ "${!#}" != */assets/cut-route.js ]] || exit 1\nPATH="${PATH#*:}" exec mv "$@"\n',
      });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'mv'))]);
      expect(publish(staging, dist).status).not.toBe(0);
      expect(assets()).toContain('assets/cut-entry.js');
      rmSync(path.join(stubDir, 'mv'));
      rmSync(staging, { recursive: true, force: true });

      release(newBuild('next'), '2');

      // Not taken for a build made in place, which would count as a release and push out "old".
      expect(assets()).toEqual([
        'assets/cut-entry.js',
        'assets/next-entry.js', 'assets/next-route.js',
        'assets/old-entry.js', 'assets/old-route.js',
      ]);
    });

    it('refuses to confirm when nothing has been published and changes nothing', () => {
      mkdirSync(records, { recursive: true });
      const before = snapshot(dist);

      const result = confirm();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('No published client build');
      expect(snapshot(dist)).toEqual(before);
    });

    it('keeps an asset that stays part of the current build, however old it is', () => {
      for (const tag of ['a', 'b', 'c', 'd']) {
        release({ ...newBuild(tag), 'assets/shared-vendor.js': 'same hash in every build' });
      }

      expect(snapshot(dist)['assets/shared-vendor.js']).toBe('same hash in every build');
    });

    it('keeps the right assets on a host with a language locale, where upper and lower case sort together', () => {
      // Not every machine has this locale installed, so the stub also proves the comparison ignores it.
      env.LC_ALL = 'en_US.UTF-8';
      writeFiles(stubDir, {
        comm: '#!/usr/bin/env bash\n[[ "${LC_ALL:-}" == C ]] || exit 1\nPATH="${PATH#*:}" exec comm "$@"\n',
      });
      execFileSync(bash, ['-c', 'chmod +x "$1"', '_', posix(path.join(stubDir, 'comm'))]);

      for (const tag of ['a', 'b', 'c', 'd']) {
        release({
          'index.html': tag,
          [`assets/Zeta-${tag}.js`]: tag,
          [`assets/about-${tag}.js`]: tag,
        });
      }

      expect(assets()).toEqual([
        'assets/Zeta-b.js', 'assets/Zeta-c.js', 'assets/Zeta-d.js',
        'assets/about-b.js', 'assets/about-c.js', 'assets/about-d.js',
      ]);
    });

    it('leaves no working files behind', () => {
      release(newBuild('new'));

      const names = readdirSync(records);
      expect(names.every((name) => name.endsWith('.list'))).toBe(true);
      expect(names).toHaveLength(2);
    });

    it('puts only the build in the target, where the web server can hand out every file', () => {
      writeFiles(staging, newBuild('new'));

      expect(publish(staging, dist).status).toBe(0);

      expect(Object.keys(snapshot(dist)).sort()).toEqual([
        '.well-known/security.txt',
        'assets/new-entry.js', 'assets/new-route.js',
        'assets/old-entry.js', 'assets/old-route.js',
        'index.html', 'robots.txt',
      ]);
    });

    it('counts files built in place after a release as one more release', () => {
      release(newBuild('a'));

      // A plain build empties the folder, and a server started from it asks for these files.
      rmSync(dist, { recursive: true, force: true });
      writeFiles(dist, { 'index.html': 'plain', 'assets/plain-route.js': 'plain route' });
      release(newBuild('b'));

      expect(snapshot(dist)['assets/plain-route.js']).toBe('plain route');
    });
  });

  describe('deploy.sh', () => {
    it('builds beside the live client and restarts only once the new build is published', () => {
      const { next } = createCheckout();

      const result = deploy();

      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(next);
      const log = calls();
      expect(log).toContain('old build whole during client build');
      expect(log).toContain('run build -w @defcon/client -- --outDir');
      expect(log).toContain('client/.release-staging/dist --emptyOutDir');
      expect(log.match(/^restart with .*$/gm)).toEqual(['restart with <script src="/assets/new-entry.js"></script>']);
      expect(log.indexOf('run test:ci')).toBeLessThan(log.indexOf('run build -w @defcon/client'));
      expect(log.indexOf('run build -w @defcon/client')).toBeLessThan(log.indexOf('restart with'));
      const after = snapshot(dist);
      expect(after['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
      expect(after['assets/new-route.js']).toBe('new route\n');
      expect(existsSync(path.join(app, 'client', '.release-staging'))).toBe(false);
      expect(existsSync(path.join(dist, '.releases'))).toBe(false);
      expect(readdirSync(records)).toHaveLength(2);
      expect(readdirSync(records).every((name) => name.endsWith('.list'))).toBe(true);
      expect(git('status', '--porcelain')).toBe('');
    });

    it('keeps the running release when the restart fails and the deploy is run again', () => {
      createCheckout();
      env.CLIENT_KEEP_RELEASES = '2';
      env.STUB_FAIL = 'restart';

      const first = deploy();

      expect(first.status).not.toBe(0);
      expect(snapshot(dist)['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
      expect(snapshot(dist)['assets/new-route.js']).toBe('new route\n');

      delete env.STUB_FAIL;
      env.STUB_TAG = 'retry';
      const retry = deploy();

      expect(retry.status, retry.stderr).toBe(0);
      const after = snapshot(dist);
      expect(after['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
      expect(after['assets/retry-route.js']).toBe('retry route\n');
      // The service may have restarted on its own with the first attempt, so that stays for now.
      expect(after['assets/new-route.js']).toBe('new route\n');
      expect(git('status', '--porcelain')).toBe('');

      // Negative control: the next real release takes the oldest one away, and the attempt with it.
      env.STUB_TAG = 'third';
      const third = deploy();

      expect(third.status, third.stderr).toBe(0);
      const final = snapshot(dist);
      expect(final['assets/third-route.js']).toBe('third route\n');
      expect(final['assets/retry-route.js']).toBe('retry route\n');
      expect(final['assets/old-route.js']).toBeUndefined();
      expect(final['assets/new-route.js']).toBeUndefined();
    });

    it('removes no hashed file when readiness does not recover', () => {
      createCheckout();
      env.CLIENT_KEEP_RELEASES = '2';
      const forward = deploy();
      expect(forward.status, forward.stderr).toBe(0);
      env.STUB_FAIL = 'readiness';
      env.STUB_TAG = 'second';

      const result = deploy();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('readiness did not recover');
      const after = snapshot(dist);
      // Three releases now, one more than is kept, and still nothing has gone.
      expect(after['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
      expect(after['assets/new-route.js']).toBe('new route\n');
      expect(after['assets/second-route.js']).toBe('second route\n');
    });

    it('keeps a release that came up only after the readiness check gave up', () => {
      createCheckout();
      env.CLIENT_KEEP_RELEASES = '2';
      env.STUB_FAIL = 'readiness';
      expect(deploy().status).not.toBe(0);

      // The service recovers on its own and serves this build to visitors.
      writeFiles(stubDir, { healthy: '' });
      delete env.STUB_FAIL;
      env.STUB_TAG = 'next';
      const result = deploy();

      expect(result.status, result.stderr).toBe(0);
      const after = snapshot(dist);
      expect(after['assets/new-route.js']).toBe('new route\n');
      expect(after['assets/next-route.js']).toBe('next route\n');
      expect(after['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
    });

    it('leaves the live client and the service alone when the client build fails', () => {
      const { next } = createCheckout();
      const before = snapshot(dist);
      env.STUB_FAIL = 'client-build';

      const result = deploy();

      expect(result.status).not.toBe(0);
      expect(snapshot(dist)).toEqual(before);
      expect(calls()).not.toContain('restart with');
      expect(existsSync(path.join(app, 'client', '.release-staging'))).toBe(false);
      expect(git('rev-parse', 'HEAD')).toBe(next);
      expect(git('status', '--porcelain')).toBe('');
    });

    it('deploys when the remote branch is at the expected commit', () => {
      const { next } = createCheckout();

      const result = deploy('--expect-commit', next);

      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(next);
      expect(calls()).toContain('restart with <script src="/assets/new-entry.js">');
    });

    it('stops before changing anything when the remote branch is not at the expected commit', () => {
      const { installed } = createCheckout();
      const before = snapshot(dist);

      const result = deploy('--expect-commit', installed);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('not the expected');
      expect(git('rev-parse', 'HEAD')).toBe(installed);
      expect(calls()).not.toContain('npm --prefix');
      expect(calls()).not.toContain('restart with');
      expect(snapshot(dist)).toEqual(before);
    });

    it('stops when the checkout holds commits the expected one does not contain', () => {
      const { next } = createCheckout();
      git('merge', '--ff-only', next);
      writeFiles(app, { 'release.txt': 'made on the host\n' });
      const local = commit('a commit made on the host');
      const before = snapshot(dist);

      const result = deploy('--expect-commit', next);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('does not contain');
      expect(git('rev-parse', 'HEAD')).toBe(local);
      expect(calls()).not.toContain('npm --prefix');
      expect(calls()).not.toContain('restart with');
      expect(snapshot(dist)).toEqual(before);
    });

    it.each(['1', '0', '-1', 'three'])('refuses to keep "%s" client releases and does not deploy', (keep) => {
      const { installed } = createCheckout();
      const before = snapshot(dist);
      env.CLIENT_KEEP_RELEASES = keep;

      const result = deploy();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('CLIENT_KEEP_RELEASES');
      expect(git('rev-parse', 'HEAD')).toBe(installed);
      expect(calls()).not.toContain('npm --prefix');
      expect(snapshot(dist)).toEqual(before);
    });

    it('has a client build that ends in vite build, the only step that can take --outDir', () => {
      const pkg = JSON.parse(readFileSync(path.resolve(opsDir, '../../client/package.json'), 'utf8'));

      expect(pkg.scripts.build).toMatch(/(^|&& )vite build$/);
    });

    it.each([
      ['an abbreviated expected commit', ['--expect-commit', 'abc1234']],
      ['an abbreviated expected commit on a dry run', ['--dry-run', '--expect-commit', 'abc1234']],
      ['an empty expected commit', ['--expect-commit', '']],
      ['an empty rollback target', ['--rollback-to', '']],
      ['an expected commit on a rollback', ['--expect-commit', 'a'.repeat(40), '--rollback-to', 'HEAD']],
    ])('refuses %s and does not deploy', (_label, args) => {
      const { installed } = createCheckout();
      const before = snapshot(dist);

      const result = deploy(...args);

      expect(result.status).not.toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(installed);
      expect(calls()).not.toContain('npm --prefix');
      expect(calls()).not.toContain('restart with');
      expect(snapshot(dist)).toEqual(before);
    });

    it.runIf(hasFlock)('refuses to run beside another deploy, and runs once that one is gone, however it ended', async () => {
      const { installed, next } = createCheckout();
      const before = snapshot(dist);
      const holder = spawn(bash, ['-c', 'exec 9<"$1"; flock -n 9; echo held; exec sleep 300', '_', posix(app)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const ended = new Promise((resolve) => holder.once('exit', resolve));
      await new Promise((resolve) => holder.stdout.once('data', resolve));

      const result = deploy();

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Another deploy or rollback is running');
      expect(git('rev-parse', 'HEAD')).toBe(installed);
      expect(calls()).not.toContain('npm --prefix');
      expect(snapshot(dist)).toEqual(before);
      // A dry run changes nothing, so it does not have to wait for anybody.
      expect(deploy('--dry-run').status).toBe(0);

      holder.kill('SIGKILL');
      await ended;

      const afterwards = deploy();
      expect(afterwards.status, afterwards.stderr).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(next);
    });

    it('builds nothing when lint fails', () => {
      createCheckout();
      const before = snapshot(dist);
      env.STUB_FAIL = 'lint';

      const result = deploy();

      expect(result.status).not.toBe(0);
      expect(calls()).not.toContain('run build');
      expect(calls()).not.toContain('restart with');
      expect(snapshot(dist)).toEqual(before);
    });

    it('still refuses a normal deploy while the service is unhealthy', () => {
      const { installed } = createCheckout();
      rmSync(path.join(stubDir, 'healthy'));

      const result = deploy();

      expect(result.status).not.toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(installed);
      expect(calls()).not.toContain('npm --prefix');
    });

    it.each([[[]], [['--rollback-to', 'FIRST']]])('changes nothing on a dry run with %j', (args) => {
      const { first, installed } = createCheckout();
      const before = snapshot(dist);

      const result = deploy('--dry-run', ...args.map((arg) => (arg === 'FIRST' ? first : arg)));

      expect(result.status).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(installed);
      expect(calls()).not.toContain('npm --prefix');
      expect(calls()).not.toContain('restart with');
      expect(snapshot(dist)).toEqual(before);
    });

    it('rolls back an unhealthy service the same way, even when the target has no deploy scripts', () => {
      const { first, next } = createCheckout();
      const forward = deploy();
      expect(forward.status, forward.stderr).toBe(0);
      rmSync(path.join(stubDir, 'healthy'));
      writeFileSync(logFile, '');
      env.STUB_TAG = 'rollback';

      const result = deploy('--rollback-to', first);

      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(first);
      expect(existsSync(path.join(app, 'scripts'))).toBe(false);
      const log = calls();
      expect(log).toContain('old build whole during client build');
      expect(log).toContain('restart with <script src="/assets/rollback-entry.js">');
      const after = snapshot(dist);
      expect(after['assets/rollback-route.js']).toBe('rollback route\n');
      // Tabs opened on either earlier build keep working.
      expect(after['assets/new-route.js']).toBe('new route\n');
      expect(after['assets/old-route.js']).toBe(OLD_DIST['assets/old-route.js']);
      expect(git('status', '--porcelain')).toBe('');

      // The checkout can fast-forward to the same release again afterwards.
      git('merge', '--ff-only', 'origin/main');
      expect(git('rev-parse', 'HEAD')).toBe(next);
    });

    it('stops the target script from running beside a rollback that has put it in the checkout', () => {
      const { withoutLock } = createCheckout();
      env.STUB_DURING_CI = 'bash "$STUB_APP/scripts/ops/deploy.sh"';

      const result = deploy('--rollback-to', withoutLock);

      expect(result.status, result.stderr).toBe(0);
      const log = calls();
      expect(log).toContain('Production worktree is dirty');
      expect(log).toMatch(/second deploy exit [1-9]/);
      expect(log).not.toContain('script without a lock built in place');
      expect(existsSync(path.join(app, 'ROLLBACK-IN-PROGRESS'))).toBe(false);
      expect(git('status', '--porcelain')).toBe('');

      // Negative control: with the rollback over, nothing stands in that script's way.
      execFileSync(bash, ['-c', 'bash "$STUB_APP/scripts/ops/deploy.sh"'], { env, stdio: 'ignore' });
      expect(calls()).toContain('script without a lock built in place');
    });

    it('refuses a rollback where Git would hide the marker from the target script', () => {
      const { first, installed } = createCheckout();
      git('config', 'status.showUntrackedFiles', 'no');
      const before = snapshot(dist);

      const result = deploy('--rollback-to', first);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('status.showUntrackedFiles');
      expect(git('rev-parse', 'HEAD')).toBe(installed);
      expect(calls()).not.toContain('npm --prefix');
      expect(snapshot(dist)).toEqual(before);
      expect(existsSync(path.join(app, 'ROLLBACK-IN-PROGRESS'))).toBe(false);

      // Negative control: the same rollback runs once Git shows untracked files again.
      git('config', '--unset', 'status.showUntrackedFiles');
      const again = deploy('--rollback-to', first);
      expect(again.status, again.stderr).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(first);
    });

    it('removes the rollback marker when the rollback fails', () => {
      const { first } = createCheckout();
      env.STUB_FAIL = 'client-build';

      const result = deploy('--rollback-to', first);

      expect(result.status).not.toBe(0);
      expect(existsSync(path.join(app, 'ROLLBACK-IN-PROGRESS'))).toBe(false);
      expect(git('status', '--porcelain')).toBe('');
    });

    it('clears a rollback marker left by a killed run and deploys', () => {
      const { next } = createCheckout();
      writeFiles(app, { 'ROLLBACK-IN-PROGRESS': '' });

      const result = deploy();

      expect(result.status, result.stderr).toBe(0);
      expect(git('rev-parse', 'HEAD')).toBe(next);
      expect(existsSync(path.join(app, 'ROLLBACK-IN-PROGRESS'))).toBe(false);
    });

    it('refuses a rollback target that is unknown or not an earlier commit', () => {
      const { installed } = createCheckout();
      git('checkout', '-q', '-b', 'elsewhere');
      writeFiles(app, { 'release.txt': 'elsewhere\n' });
      const elsewhere = commit('elsewhere');
      git('checkout', '-q', 'main');
      const before = snapshot(dist);

      for (const target of ['0000000000000000000000000000000000000000', 'no-such-ref', elsewhere]) {
        const result = deploy('--rollback-to', target);

        expect(result.status).not.toBe(0);
        expect(git('rev-parse', 'HEAD')).toBe(installed);
      }
      expect(calls()).not.toContain('npm --prefix');
      expect(calls()).not.toContain('restart with');
      expect(snapshot(dist)).toEqual(before);
    });
  });
});
