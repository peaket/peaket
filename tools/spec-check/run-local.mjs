#!/usr/bin/env node
// 이 PC에서 규칙 모델 검사를 Linux 컨테이너로 돌린다(wbs 0.9.1, tools/spec-check/README.md).
// 이미지(peaket/spec-check:local)를 만들고(바뀐 것이 없으면 캐시), 저장소를 /repo에 붙여 spec-check.mjs를 같은 인자로 부른다.
// 컨테이너에는 git이 없어 커밋은 여기서 읽어 넘긴다.
// 쓰는 법: node tools/spec-check/run-local.mjs <typecheck|pr|full> [--spec 이름] [--write] [--cpus N]
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const IMAGE = 'peaket/spec-check:local';

const args = process.argv.slice(2);
const at = args.indexOf('--cpus');
const cpus = at >= 0 ? args.splice(at, 2)[1] : '8';

execFileSync('docker', ['build', '-q', '-t', IMAGE, HERE], { stdio: ['ignore', 'ignore', 'inherit'] });
const git = (a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const sha = git(['rev-parse', 'HEAD']);
const dirty = git(['status', '--porcelain', '--', 'specs', 'tools/spec-check', ':(exclude)specs/results']) !== '' ? '1' : '0';
const r = spawnSync('docker', ['run', '--rm', '--cpus', cpus, '-e', `PEAKET_SPEC_COMMIT=${sha}`, '-e', `PEAKET_SPEC_DIRTY=${dirty}`,
  '-v', `${REPO}:/repo`, '-w', '/repo', IMAGE, 'tools/spec-check/spec-check.mjs', ...args], { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
process.exit(r.status ?? 1);
