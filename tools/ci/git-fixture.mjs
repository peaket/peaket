// 시험용 임시 폴더와 git 저장소. 시험 파일들이 함께 쓴다(시험 대상이 아니다)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// 시험이 만든 임시 폴더는 시험 프로세스가 끝날 때 지운다
const temps = [];
process.on('exit', () => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function git(cwd, ...args) {
  return gitEnv(cwd, {}, ...args);
}

function gitEnv(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function repo(prefix = 'ci-fixture-') {
  const dir = tempDir(prefix);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'ci@example.invalid');
  git(dir, 'config', 'user.name', 'ci');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

// date를 주면 작성 시각을 그 시각으로 둔다(가지 나이 시험)
export function commit(dir, files, message = 'change', date) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  git(dir, 'add', '-A');
  gitEnv(dir, date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
