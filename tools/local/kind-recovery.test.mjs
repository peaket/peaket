// F-09-8 kind 재가동·야간 실행 복구·kind 장부 재확인 절차 시험(INF-010·INF-030·INF-040).
// 시험은 클러스터·Docker 없이 돈다. 실제 kind 재가동과 야간 수동 실행은 실행 차례이고, 이 파일은
// ① 워크플로 예약이 정본 시각과 같은지(INF-030은 tools/ci/check-workflows.test.mjs가 본다)
// ② 복구 절차 문서가 ci-kind.yml의 무대·e2e 명령을 빠뜨리지 않았는지
// ③ 장부 재확인 표가 kind 보류·INF-040 항목을 빠뜨리지 않았는지를 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNBOOK = join(REPO, 'docs', 'runbooks', 'F-09-8-kind-nightly-recovery.md');
const RECHECK = join(REPO, 'docs', 'review', 'measurements', 'F-09-8-kind-recheck.md');
const LEDGER_NOTES = join(REPO, 'docs', 'review', 'ledger-notes.md');
const YAML = await import('yaml').catch(() => null);
const read = (p) => readFileSync(p, 'utf8');

/** 문서의 펜스 코드 블록만 이어 붙인다. 산문 속 명령 이름과 실제 실행 명령을 가르려고 쓴다 */
function fencedBlocks(doc) {
  return [...doc.matchAll(/```[a-z]*\r?\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
}

/** ci-kind.yml의 run 줄에서 kind 무대 명령과 e2e 파일을 뽑는다(주석 줄도 글자로는 센다) */
function ciKindCommands() {
  const wf = YAML.parse(read(join(REPO, '.github', 'workflows', 'ci-kind.yml')));
  const runs = Object.values(wf.jobs)
    .flatMap((j) => j.steps ?? [])
    .map((s) => s.run ?? '')
    .join('\n');
  return {
    e2e: [...new Set(runs.match(/tools\/local\/e2e\/[A-Za-z0-9_.-]+\.e2e\.mjs/g) ?? [])],
    cluster: [...new Set([...runs.matchAll(/tools\/local\/cluster\.mjs\s+([a-z][a-z0-9-]*)/g)].map((m) => m[1]))],
  };
}

test('INF-010 ① 복구 절차는 ci-kind.yml의 모든 kind 무대·e2e 명령을 담는다', { skip: !YAML && 'yaml 패키지가 없다(pnpm install 전)' }, () => {
  assert.ok(existsSync(RUNBOOK), `복구 절차 문서가 없다: ${RUNBOOK}`);
  const doc = read(RUNBOOK);
  const { e2e, cluster } = ciKindCommands();
  assert.ok(e2e.length >= 10, `ci-kind.yml에서 e2e를 ${e2e.length}개만 찾았다`);
  assert.ok(cluster.length >= 6, `ci-kind.yml에서 cluster 하위 명령을 ${cluster.length}개만 찾았다`);
  for (const f of e2e) assert.ok(doc.includes(f), `복구 절차에 ${f}가 없다`);
  for (const c of cluster) assert.ok(doc.includes(`cluster.mjs ${c}`), `복구 절차에 cluster.mjs ${c}가 없다`);
});

test('INF-010 ② 복구 절차는 동결 로컬 한계와 다른 갈래 보호를 적고 모든 클러스터 명령에 이름을 붙인다', () => {
  assert.ok(existsSync(RUNBOOK), `복구 절차 문서가 없다: ${RUNBOOK}`);
  const doc = read(RUNBOOK);
  for (const s of [
    'PEAKET_CLUSTER=freeze-f098',
    'PEAKET_GATEWAY_BASE_PORT=18641',
    'PEAKET_KIND_IN_CI',
    'fe21934d',
    '기본 가지',
    'D:/ticketpass-locks/lock.sh take docker lane1-F-09-8',
    'D:/ticketpass-locks/lock.sh drop docker lane1-F-09-8',
  ]) {
    assert.ok(doc.includes(s), `복구 절차에 '${s}'가 없다`);
  }
  assert.match(doc, /cluster\.mjs down/, '복구 절차에 정리(down)가 없다');
  assert.match(doc, /다른 갈래|다른 클러스터/, '다른 갈래 클러스터를 건드리지 않는 주의가 없다');
  // 새 셸에서 export가 빠져도 기본 peaket 클러스터를 만지지 않도록 명령마다 이름을 붙인다
  for (const line of fencedBlocks(doc).split(/\r?\n/)) {
    if (!line.includes('tools/local/cluster.mjs')) continue;
    assert.ok(line.includes('PEAKET_CLUSTER=freeze-f098'), `클러스터 이름이 없는 명령: ${line.trim()}`);
  }
});

test('INF-010 ③ 복구 절차는 ci-kind의 준비·정리 단계를 차례대로 담는다', () => {
  assert.ok(existsSync(RUNBOOK), `복구 절차 문서가 없다: ${RUNBOOK}`);
  const doc = read(RUNBOOK);
  for (const s of [
    'pnpm install --frozen-lockfile',
    'pnpm --dir tools/web-checks install --frozen-lockfile',
    'playwright install --with-deps chromium firefox webkit',
    'delete namespace example kafka',
    'delete namespace v0',
  ]) {
    assert.ok(doc.includes(s), `복구 절차에 준비·정리 단계 '${s}'가 없다`);
  }
  const code = fencedBlocks(doc);
  const at = (s) => {
    const i = code.indexOf(s);
    assert.ok(i >= 0, `복구 절차 코드에 '${s}'가 없다`);
    return i;
  };
  assert.ok(at('pnpm install --frozen-lockfile') < at('cluster.mjs up'), '의존성 설치가 클러스터 생성 뒤에 있다');
  assert.ok(at('playwright install') < at('queue-cors.e2e.mjs'), 'Playwright 설치가 queue-cors 시험 뒤에 있다');
  assert.ok(at('delete namespace example kafka') < at('cluster.mjs v0'), 'example·kafka 정리가 v0 배포 뒤에 있다');
  assert.ok(at('delete namespace v0') < at('cluster.mjs gateways'), 'v0 정리가 게이트웨이 배포 뒤에 있다');
});

/** ledger-notes가 kind 보류로 적은 항목(첫 칸)과 ADR-0332 결정 4·BUILD_ORDER INF-040이 든 재확인 ID */
function recheckIds() {
  const ids = new Set();
  for (const line of read(LEDGER_NOTES).split(/\r?\n/)) {
    if (!line.startsWith('|') || !line.includes('kind 보류')) continue;
    const id = line.split('|')[1]?.trim();
    if (id) ids.add(id);
  }
  // ADR-0332 결정 4 '이미 통과했던 것'과 이 기능이 함께 보는 하위 번호
  for (const id of [
    'Q-T69 ②', 'S-T28 ①', 'D-T50', 'D-T43', 'D-T36', 'D-T11 ②',
    'D-T18 ①', 'D-T18 ②', 'D-T19 ③', 'D-T19 ④', 'D-T33 ①', 'D-T33 ②',
    'V-T43', 'I-T36', 'V-T28 ①',
  ]) ids.add(id);
  // BUILD_ORDER INF-040이 F-01-2·F-01-3·F-01-4·F-01-5에서 넘겨받은 것
  for (const id of [
    'F-01-4 운영 확인 ①', 'F-01-4 운영 확인 ②', 'F-01-4 운영 확인 ③', 'F-01-4 운영 확인 ④',
    'F-01-4 Tempo 마이크로서비스 모드', 'F-01-5 로컬 Prometheus rule_files', 'F-01-5 Grafana 주석 링크',
  ]) ids.add(id);
  return ids;
}

function recheckRows() {
  assert.ok(existsSync(RECHECK), `장부 재확인 표가 없다: ${RECHECK}`);
  const lines = read(RECHECK).split(/\r?\n/);
  const header = lines.find((l) => l.startsWith('| 항목 |'));
  assert.equal(header?.replace(/\s+/g, ' ').trim(), '| 항목 | 무엇을 다시 보나 | 명령 | 판정 근거 | 상태 | 기록 |', '재확인 표 머리 줄이 다르다');
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|') || line.startsWith('| 항목 |')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 6 || cells[0] === '---' || /^-{3,}$/.test(cells[0])) continue;
    rows.push(cells);
  }
  return rows;
}

/** 요구한 ID와 첫 칸이 정확히 같은 행이 있는지(하위 번호를 뭉뚱그리지 않는다) */
const covered = (rows, id) => rows.some((r) => r[0] === id);

test('INF-040 ① 장부 재확인 표는 kind 보류·INF-040 항목과 ADR-0332·F-01-4·F-01-5의 재확인 ID를 모두 담는다', () => {
  const rows = recheckRows();
  const missing = [...recheckIds()].filter((id) => !covered(rows, id));
  assert.deepEqual(missing, [], `재확인 표에 빠진 항목: ${missing.join(', ')}`);
});

test('INF-040 ② 재확인 표의 각 줄은 명령·판정 근거·상태를 가진다', () => {
  const rows = recheckRows();
  assert.ok(rows.length >= 20, `재확인 표가 ${rows.length}줄뿐이다`);
  const allowed = new Set(['대기', '통과', '실패', '해당 없음', '동결']);
  for (const [id, what, command, basis, status] of rows) {
    assert.ok(id, '항목 칸이 비었다');
    assert.ok(what, `${id}: 무엇을 다시 보는지 비었다`);
    assert.ok(command, `${id}: 명령 칸이 비었다`);
    assert.ok(basis, `${id}: 판정 근거 칸이 비었다`);
    assert.ok(allowed.has(status), `${id}: 상태 '${status}'가 정한 다섯 값 밖이다`);
  }
});
