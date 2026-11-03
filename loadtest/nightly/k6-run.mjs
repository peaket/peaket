#!/usr/bin/env node
// 야간 비교의 실행 명령(docs/devops.md §3.3, D-T40). nightly.py가 설정의 k6 명령(이 파일과 실행 도구 인자) 뒤에 k6 인자를 붙여 부른다:
//   node loadtest/nightly/k6-run.mjs <실행 도구 인자…> run --quiet --summary-trend-stats … --summary-export <경로> -e BASE_URL=<판 입구> <시나리오>
// - 판 입구 주소로 네임스페이스(v0·v0-base)를 고르고, 같은 시나리오를 실행 도구(node loadtest/run.mjs v0 queue …, kind 안 발생기)로 돌린다.
// - 실행 도구가 쓴 본구간 요약(summary.json, http_req_duration은 본구간 값)을 --summary-export 자리에 옮긴다.
// - 발생기 판정이 무효(놓친 반복·CPU·메모리, docs/verification.md §3.9)면 그 회차는 견줄 수 없어 종료 코드 1로 끝난다(nightly.py가 실패로 다룬다)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namespaceFromUrl, parseK6Args } from './k6-args.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENARIO = 'loadtest/scenarios/v0-queue.js';

function main() {
  const k = parseK6Args(process.argv.slice(2));
  if (k.scenario.replace(/\\/g, '/') !== SCENARIO) throw new Error(`야간 비교 시나리오는 ${SCENARIO}다: ${k.scenario}`);
  const ns = namespaceFromUrl(k.env.BASE_URL);
  const out = mkdtempSync(join(tmpdir(), 'nightly-run-'));
  try {
    // 실행 도구의 진행 글은 표준 오류로(nightly.py는 실패했을 때만 끝부분을 보인다)
    execFileSync(process.execPath, ['loadtest/run.mjs', 'v0', 'queue', ...k.passthrough, '--namespace', ns, '--out', out], { cwd: REPO, stdio: ['ignore', process.stderr, process.stderr] });
    const g = JSON.parse(readFileSync(join(out, 'generator.json'), 'utf8'));
    if (!g.judge?.valid) throw new Error(`발생기 판정이 무효라 견주지 않는다: ${(g.judge?.reasons ?? []).join('; ')}`);
    const dest = resolve(REPO, k.summaryExport);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(out, 'summary.json'), dest);
  } finally {
    rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`loadtest/nightly/k6-run.mjs: ${e.message}\n`);
  process.exit(1);
}
