// 나머지 경보 규칙(OPS-100, F-01-10)의 합성 시계열 시험 실행기(시험 V-T52 ①~⑩).
// 정본: docs/verification.md V-T52, docs/observability.md §5 'OPS-100 규칙과 이름이 없던 지표', docs/verification.md §2.7.
// 같은 폴더의 ops-100.test.yaml에서 시험 ID로 시작하는 묶음만 골라 임시 저장소에서 실행기로 돌린다:
//   node tools/ci/prom-rules.mjs test --root <임시 저장소>. promtool은 실행기가 고정 이미지로 부른다(Docker가 없으면 실행기가 2를 내고 이 시험은 실패한다).
// 실행(저장소 뿌리): node --test "deploy/platform/observability/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { tempDir } from '../../../../tools/ci/git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const RUNNER = join(REPO, 'tools', 'ci', 'prom-rules.mjs');
const OBS = 'deploy/platform/observability';
const TEST_DIR = `${OBS}/test`;
const FILE = 'ops-100.test.yaml';
const LOCAL_OBS = 'deploy/local/observability.yaml';

const read = (root, rel) => {
  assert.ok(existsSync(join(root, rel)), `${rel}이 없다`);
  return readFileSync(join(root, rel), 'utf8');
};

/** 실행기를 바깥에서 부른다. 끝 코드와 합친 출력 */
function runner(...args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const blocked = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('막음:'));

/** 임시 저장소: 관측 폴더와 promtool 이미지가 적힌 로컬 관측 설정. 시험 폴더는 비운다 */
function fixture() {
  const root = tempDir('ops-100-rules-');
  cpSync(join(REPO, OBS), join(root, OBS), { recursive: true });
  mkdirSync(join(root, 'deploy/local'), { recursive: true });
  cpSync(join(REPO, LOCAL_OBS), join(root, LOCAL_OBS));
  rmSync(join(root, TEST_DIR), { recursive: true, force: true });
  mkdirSync(join(root, TEST_DIR), { recursive: true });
  return root;
}

/** 시험 파일에서 이름이 prefix로 시작하는 묶음만 남긴 사본을 임시 저장소에 쓴다. 고른 묶음 수를 돌려준다 */
function placeGroups(root, prefix) {
  const spec = parse(read(REPO, `${TEST_DIR}/${FILE}`));
  const tests = (spec.tests ?? []).filter((t) => typeof t.name === 'string' && t.name.startsWith(prefix));
  assert.ok(tests.length >= 1, `${FILE}에 '${prefix}'로 시작하는 시험 묶음이 없다(0개 실행을 통과로 내지 않는다)`);
  writeFileSync(join(root, TEST_DIR, FILE), stringify({ ...spec, tests }, { lineWidth: 0 }));
  return tests;
}

/** 시험 ID 하나의 합성 시계열 시험을 돌려 통과를 단언한다 */
function runGroups(prefix) {
  const spec = parse(read(REPO, `${TEST_DIR}/${FILE}`));
  // 시험 입력 간격 = 운영 간격(docs/verification.md §2.7 '시험 입력의 간격', V-T20 ③)
  assert.equal(spec.evaluation_interval, '30s', `${FILE}의 evaluation_interval`);
  const root = fixture();
  const tests = placeGroups(root, prefix);
  tests.forEach((t) => assert.equal(t.interval, '15s', `${t.name}의 interval`));
  const r = runner('test', '--root', root);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(blocked(r.out), []);
  return tests;
}

test('V-T52 ① 외부 의존 오류 비율 1%·5분과 첫 429·CDN 80%가 경계에서만 울린다', () => {
  runGroups('V-T52 ①');
});

test('V-T52 ② 위생 신호는 시계 20ms·백업 26시간·인증서 수명 절반의 경계에서만 울린다', () => {
  runGroups('V-T52 ②');
});

test('V-T52 ③ 현장 신호는 동기화 2분과 중복 10분 10건의 경계에서만 울린다', () => {
  runGroups('V-T52 ③');
});

test('V-T52 ④ 차례 전 입장은 1건에 SEV1이고 예산 50% 감축 실행만 SEV2다', () => {
  runGroups('V-T52 ④');
});

test('V-T52 ⑤ 보안 사고 법정 기한은 2시간·12시간 남음과 기한 초과에서 울린다', () => {
  runGroups('V-T52 ⑤');
});

test('V-T52 ⑥ 브로커 신호는 오프라인·최소 ISR·복제 부족·디스크 70%·85%를 가른다', () => {
  runGroups('V-T52 ⑥');
});

test('V-T52 ⑦ 당기기·조회 실패·보류 사건은 결제·주문 토픽만 SEV2다', () => {
  runGroups('V-T52 ⑦');
});

test('V-T52 ⑧ 증거 수집 실패는 한 시간 2회, 웹훅 거절은 10분 5회부터 울린다', () => {
  runGroups('V-T52 ⑧');
});

test('V-T52 ⑨ 관제 실시간 표 신호는 Degraded 1과 거래 사건 끊김에서 SEV3이다', () => {
  runGroups('V-T52 ⑨');
});

test('V-T52 ⑩ 수집기 자체 신호는 보내기·받기·큐·수집량·판정 전 버림을 5분 지속으로 본다', () => {
  runGroups('V-T52 ⑩');
});
