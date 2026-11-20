// DAST 기준선 kind 시험(BUILD_ORDER BOT-161, docs/devops.md §3, ADR-0323).
// Docker 잠금 안에서 kind의 공개 입구 www·api(gw-fan)·partner(gw-partner)에 ZAP 기준선 점검을 돌리고,
// 미끼 점검이 High를 찾는지(도구가 실제로 보는지) → 결과 JSON → SARIF(dast-gate) → High 7.0 판정(scan-gate --tool zap)을 본다.
// ops-api·scanner-api는 허용 IP·기기 인증 뒤라 점검하지 않는다. 출시 후보 데모·운영 점검은 이 시험이 아니다.
// 실행(저장소 뿌리, Docker 차례 잠금): node tools/local/cluster.mjs up && node tools/local/cluster.mjs v0 && node tools/local/cluster.mjs gateways
//   && node --test --test-timeout=900000 tools/local/e2e/dast.e2e.mjs
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadContract } from './gateway-client.mjs';
import { runDast } from '../../ci/scan-tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TARGETS = [
  { name: 'www', host: 'www.peaket.example', gw: 'gw-fan' },
  { name: 'api', host: 'api.peaket.example', gw: 'gw-fan' },
  { name: 'partner', host: 'partner.peaket.example', gw: 'gw-partner' },
];
let c;
let out;
const hasDocker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();

before(() => {
  c = loadContract();
  out = mkdtempSync(join(tmpdir(), 'peaket-dast-e2e-'));
});

test('BOT-161 Docker가 있으면 kind 공개 입구 셋을 ZAP 기준선으로 점검해 High 0이고 SARIF·판정이 통과한다', { skip: hasDocker ? false : 'docker를 쓸 수 없다(차례 잠금·Docker 엔진 확인)' }, async () => {
  for (const t of TARGETS) {
    const dir = join(out, t.name);
    const target = `https://127.0.0.1:${c.ports[t.gw]}/`;
    // runDast는 미끼(High가 나와야 하는 경로)를 먼저 돌려 도구가 보는지 확인한 뒤에만 대상을 본다
    const report = await runDast({ target, out: dir, host: t.host });
    assert.ok(report.endsWith('zap.json'), `${t.name}: 결과 파일 ${report}`);
    const gate = execFileSync(process.execPath, [join(REPO, 'tools', 'ci', 'dast-gate.mjs'), '--report', report, '--out', join(dir, 'zap.sarif'), '--event', 'schedule'], { encoding: 'utf8', timeout: 300_000 });
    assert.match(gate, /ZAP 기준선/, `${t.name}: dast-gate 출력 ${gate}`);
    const judgment = execFileSync(process.execPath, [join(REPO, 'tools', 'ci', 'scan-gate.mjs'), '--tool', 'zap', '--sarif', join(dir, 'zap.sarif'), '--report', join(dir, 'gate.json'), '--event', 'schedule'], { encoding: 'utf8', timeout: 300_000 });
    assert.match(judgment, /통과|zap/i, `${t.name}: scan-gate 출력 ${judgment}`);
  const sarif = JSON.parse(readFileSync(join(dir, 'zap.sarif'), 'utf8'));
    const high = (sarif.runs ?? []).flatMap((r) => r.results ?? []).filter((x) => Number(x.properties?.['security-severity'] ?? 0) >= 7);
    assert.deepEqual(high, [], `${t.name}: High(7.0 이상) ${high.length}건`);
  }
});
