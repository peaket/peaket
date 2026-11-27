// F-08-10 성능 장부 실험 묶음 시험(F0810-7): collect.py --experiment.
// 정본: docs/perf-ledger.md §2.2 experiment(65행), docs/verification.md V-T18(644행), 계획 docs/review/plans/F-08-10.md 7.2.
// 파이썬 도구를 명령줄로 부르고 OS 임시 폴더를 저장소 루트로 준다. 단언 값은 정본의 manifest 칸 이름이다.
// 실행: node --test tools/perf-ledger/f0810.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const COLLECT = join(here, 'collect.py');

function py(args) {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', COLLECT, ...args], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'f0810-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const k6Summary = () => ({
  metrics: {
    http_req_duration: { avg: 50, med: 30, 'p(95)': 90, 'p(99)': 100 },
    http_req_failed: { value: 0 },
    http_reqs: { count: 1000, rate: 10 },
    dropped_iterations: { count: 0 },
  },
});

function runDir(root, id) {
  return join(root, 'docs', 'perf-ledger', 'runs', id);
}

function args(root, id, extra = []) {
  const summary = join(root, `${id}.json`);
  writeFileSync(summary, JSON.stringify(k6Summary()));
  return [
    '--root', root,
    '--run-id', id,
    '--kpi', 'V-T18',
    '--version', 'v1',
    '--profile', 'local-10k',
    '--commit', 'f0810-test',
    '--k6-summary', summary,
    ...extra,
  ];
}

test('F0810-7 ① collect.py --experiment split-3way:by-role이 manifest.experiment에 묶음 ID와 구성을 쓰고 유효하다', () =>
  withTmp((root) => {
    mkdirSync(join(root, 'docs', 'perf-ledger', 'runs'), { recursive: true });
    const id = '2026-11-27-split-by-role-none-r1-f0810';
    const r = py(args(root, id, ['--experiment', 'split-3way:by-role']));
    assert.equal(r.code, 0, r.out);
    const manifest = JSON.parse(readFileSync(join(runDir(root, id), 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.experiment, { id: 'split-3way', config: 'by-role' });
    assert.equal(manifest.commit.code, 'f0810-test');
    assert.equal(manifest.valid, true);
  }));

test('F0810-7 ② --experiment가 없으면 experiment:null이고, 콜론 없음·빈 값·콜론 둘은 실행 전에 거부해 폴더를 만들지 않는다', () =>
  withTmp((root) => {
    mkdirSync(join(root, 'docs', 'perf-ledger', 'runs'), { recursive: true });
    const plain = '2026-11-27-split-bundle-none-r1-f0810';
    const ok = py(args(root, plain));
    assert.equal(ok.code, 0, ok.out);
    assert.equal(JSON.parse(readFileSync(join(runDir(root, plain), 'manifest.json'), 'utf8')).experiment, null);

    for (const [i, bad] of ['split-3way', ':by-role', 'split-3way:', 'split-3way:by-role:extra', 'Split-3way:by-role'].entries()) {
      const id = `2026-11-27-bad-experiment-${i}-f0810`;
      const r = py(args(root, id, ['--experiment', bad]));
      assert.notEqual(r.code, 0, `${bad}: 거부해야 한다: ${r.out}`);
      assert.equal(existsSync(runDir(root, id)), false, `${bad}: 측정 폴더를 만들면 안 된다`);
    }
  }));
