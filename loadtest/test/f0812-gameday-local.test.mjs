// F-08-12 Game Day 로컬 ①·② 시험. Docker·kind·k6·브라우저 없이 카탈로그·판정·보고서·계획만 본다.
// 정본 값은 시험 안에 적고, 구현 상수를 가져오지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'loadtest', 'runner', 'gameday-local.mjs');
const PLAN_JSON = path.join(ROOT, 'loadtest', 'plan', 'f0812-plan.json');
const REPORT = path.join(ROOT, 'docs', 'review', 'measurements', 'F-08-12-gameday-local.md');
const PLAN_DOC = path.join(ROOT, 'docs', 'review', 'plans', 'F-08-12.md');

// docs/observability.md §12·docs/verification.md §5.2에서 온 14종.
// stageReady는 '전체 시나리오 무대가 준비됐는가'다. partialParts는 무대가 없어도 할 수 있는 부분이다.
const EXPECTED = [
  { id: 'G-02', order: 1, group: 'A', window: '3a', mode: '대체 장애', evidence: '측정함', stageReady: false, missing: ['좌석 Redis', '복제', '승격'], partial: ['Valkey', '503', '오버셀'], runbook: 'RB-06', alert: ['seat-store-unavailable', 'seat_store_unavailable'], action: ['503'], invariant: ['오버셀 0', '이중 홀드 0'], name: /좌석 Redis/ },
  { id: 'G-10', order: 2, group: 'A', window: '3a', mode: '대체 장애', evidence: '측정함', stageReady: false, missing: ['1브로커', 'RF'], partial: [], runbook: 'RB-11', alert: ['브로커', '소비 지연'], action: ['Outbox'], invariant: ['유실 0'], name: /Kafka/ },
  { id: 'G-29', order: 3, group: 'A', window: '3a', mode: '대체 장애', evidence: '측정함', stageReady: false, missing: ['세션', '캐시', '복제', '승격'], partial: ['메모리', '85'], runbook: 'RB-05', alert: ['85'], action: ['원본 읽기'], invariant: ['유실 0', '축출 0'], name: /세션·캐시 Redis/ },
  { id: 'G-30', order: 4, group: 'A', window: '3a', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['Schema Registry', '레지스트리'], partial: [], runbook: 'RB-34', alert: ['레지스트리', '생산자'], action: ['스키마 ID', '기다린다'], invariant: ['주문 실패 0'], name: /Schema Registry/ },
  { id: 'G-31', order: 5, group: 'A', window: '3a', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['경보', '규칙'], partial: ['Outbox', '당기기'], runbook: 'RB-11·RB-39', alert: ['OfflinePartitionsCount', 'SEV1'], action: ['당기기', '명령 6', 'Outbox'], invariant: ['60초', '이중 반영 0'], name: /MSK/ },
  { id: 'G-17', order: 6, group: 'B', window: '3b', mode: '모의 진행', evidence: '설계만', stageReady: true, missing: [], partial: [], runbook: 'RB-20·RB-17', alert: ['보안 사고', 'SEV1'], action: ['24', '2', '72'], invariant: ['실제 신고', '개인정보'], name: /보안 사고/ },
  { id: 'G-18', order: 7, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['Argo Rollouts'], partial: [], runbook: 'RB-23', alert: ['카나리', 'SEV2'], action: ['자동 중단', '안정판'], invariant: ['오류 예산'], name: /나쁜 배포/ },
  { id: 'G-19', order: 8, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['Argo CD', '동결 달력'], partial: [], runbook: 'RB-28', alert: ['달력', 'SEV2'], action: ['승격', 'T-30'], invariant: ['동결'], name: /변경 동결/ },
  { id: 'G-20', order: 9, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['투명성 로그'], partial: ['Kyverno', '60초'], runbook: 'RB-27', alert: ['이미지 검증'], action: ['60초', '파드'], invariant: ['서명', '다이제스트'], name: /Kyverno/ },
  { id: 'G-21', order: 10, group: 'B', window: '3b', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['경보', '규칙', '콘솔'], partial: [], runbook: 'RB-09', alert: ['입력 없음', '30초'], action: ['AIMD', '0'], invariant: ['감축 0'], name: /제어 입력/ },
  { id: 'G-22', order: 11, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['KEDA'], partial: [], runbook: 'RB-30', alert: ['AIMD', '감축'], action: ['RB-30', '5분'], invariant: ['추가 감축 0'], name: /KEDA/ },
  { id: 'G-23', order: 12, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['경보', '규칙'], partial: ['Valkey', '503', '오버셀'], runbook: 'RB-06·RB-32', alert: ['seat-store-unavailable', 'SEV2'], action: ['503', '준비 파드', '재연결'], invariant: ['오버셀 0', '재시작 0'], name: /공유 의존성/ },
  { id: 'G-24', order: 13, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['힙', '누수'], partial: ['pg_sleep', 'RB-32'], runbook: 'RB-31·RB-32', alert: ['잠금', 'p99'], action: ['RB-32', '취소'], invariant: ['데이터 손실 0'], name: /재시작 전 증거/ },
  { id: 'G-25', order: 14, group: 'B', window: '3c', mode: '로컬 실행', evidence: '측정함', stageReady: false, missing: ['브라우저', 'Playwright', 'SDK'], partial: [], runbook: 'RB-33', alert: ['처리량 급감', 'SEV2'], action: ['RB-33', 'SDK'], invariant: ['이중 결제 0'], name: /조용한 실패/ },
];
const IDS = EXPECTED.map((s) => s.id);
const GROUP_A = ['G-02', 'G-10', 'G-29', 'G-30', 'G-31'];
const GROUP_B = ['G-17', 'G-18', 'G-19', 'G-20', 'G-21', 'G-22', 'G-23', 'G-24', 'G-25'];
const OUTSIDE = [
  { id: 'G-01', owner: 'F-08-6' },
  { id: 'G-03', owner: 'F-08-6' },
  { id: 'G-04', owner: 'F-08-6' },
  { id: 'G-05', owner: 'F-08-6' },
  { id: 'G-06', owner: 'F-08-6' },
  { id: 'G-07', owner: 'F-08-6' },
  { id: 'G-08', owner: 'F-08-6' },
  { id: 'G-09', owner: 'F-08-6' },
  { id: 'G-11', owner: 'F-08-6' },
  { id: 'G-12', owner: 'F-08-6' },
  { id: 'G-13', owner: 'F-08-6' },
  { id: 'G-14', owner: 'F-08-6' },
  { id: 'G-15', owner: 'F-08-6' },
  { id: 'G-16', owner: 'F-08-6' },
  { id: 'G-26', owner: 'F-08-13' },
  { id: 'G-27', owner: 'F-08-13' },
  { id: 'G-28', owner: 'F-08-13' },
  { id: 'G-32', owner: 'F-08-13' },
  { id: 'G-33', owner: 'F-08-13' },
];
const ARTIFACTS = ['timeline.csv', 'manifest.json', 'alerts.ndjson', 'faults.ndjson', 'invariants.csv', 'host.json', 'run.json', 'generator.json'];
const CAUSES = ['변경', '외부 의존', '내부 저장소·메시징', '용량·포화', '코드 결함', '데이터', '보안', '운영 조작', '기반'];
const RUNBOOK_TITLES = {
  'RB-05': '대기열 Redis 마스터 페일오버',
  'RB-06': '좌석 Redis 페일오버 대응',
  'RB-09': '관측 스택 장애와 제어 입력 없음',
  'RB-11': 'Kafka 컨슈머 Lag',
  'RB-17': '포스트모템',
  'RB-20': '보안 사고 신고',
  'RB-23': '배포 되돌리기',
  'RB-27': '입장 정책 검증 실패',
  'RB-28': '변경 동결 달력 장애',
  'RB-30': '오토스케일 정지',
  'RB-31': '진단 증거 보존',
  'RB-32': '느린 쿼리',
  'RB-33': '처리량 급감',
  'RB-34': '스트림 작업자 복구',
  'RB-39': 'Outbox 릴레이 밀림',
};
const FORBIDDEN = ['30k/s', '100만', 'K1', 'K2', 'K7'];
const EXECUTION_CLAIMS = ['실행했다', '검증됐다', '측정했다'];

async function load() {
  if (!fs.existsSync(RUNNER)) return { missing: 'loadtest/runner/gameday-local.mjs' };
  try {
    return await import(pathToFileURL(RUNNER).href);
  } catch (error) {
    return { error };
  }
}

function need(mod) {
  if (mod.missing) assert.fail(`${mod.missing}가 없다`);
  if (mod.error) assert.fail(`loadtest/runner/gameday-local.mjs를 읽지 못했다: ${mod.error.message}`);
  return mod;
}

function read(rel) {
  const file = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  if (!fs.existsSync(file)) assert.fail(`${path.relative(ROOT, file)}가 없다`);
  return fs.readFileSync(file, 'utf8');
}

function readJson(file) {
  if (!fs.existsSync(file)) assert.fail(`${path.relative(ROOT, file)}가 없다`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    assert.fail(`${path.relative(ROOT, file)} JSON을 읽지 못했다: ${error.message}`);
  }
}

function scenarioOf(mod, id) {
  assert.equal(typeof mod.scenarioOf, 'function', 'scenarioOf 함수가 없다');
  const s = mod.scenarioOf(id);
  assert.ok(s, `시나리오 ${id}가 없다`);
  return s;
}

function usage(fn) {
  assert.throws(fn, (error) => {
    if (error?.name === 'UsageError') return true;
    return /window|창|scenario|시나리오|group|묶음|run-id|기록|partial|부분|docker-all|browser|leak|모르는|필수/.test(String(error?.message ?? ''));
  });
}

const T = {
  t0: '2026-11-28T10:00:00.000+09:00',
  t1: '2026-11-28T10:00:15.000+09:00',
  t1p: '2026-11-28T10:00:10.000+09:00',
  t2: '2026-11-28T10:00:30.000+09:00',
  t3: '2026-11-28T10:00:32.000+09:00',
  t4: '2026-11-28T10:00:40.000+09:00',
};
const OBS = { detectionPath: '경보', humanNoticedAt: '2026-11-28T10:00:35.000+09:00' };

function timeline(overrides = {}) {
  return { T0: T.t0, T1: T.t1, T1p: T.t1p, T2: T.t2, T3: T.t3, T4: T.t4, ...overrides };
}

function cleanRun(overrides = {}) {
  return {
    complete: true,
    injection: { at: T.t0, applied: true, evidence: 'Valkey 파드 종료 확인', rollbackOk: true },
    host: { cpuPct: 50, procsRunning: 8, logicalCpus: 8 },
    generator: { droppedIterations: 0, cpuPct: 40, memPct: 50 },
    httpReqs: 100,
    invariants: { oversell: 0, doublePayment: 0, admitBeforeTurn: 0 },
    responseChecks: {
      expectedAlert: { ok: true, evidence: 'ALERTS firing' },
      expectedAction: { ok: true, evidence: '503 관측' },
      invariantHeld: { ok: true, evidence: 'invariants 0' },
    },
    timeline: timeline(),
    ...overrides,
  };
}

function runInput(overrides = {}) {
  return { run: cleanRun(), observation: { ...OBS }, load: true, commandExpected: true, ...overrides };
}

function scenarioInput(id, overrides = {}) {
  const spec = EXPECTED.find((s) => s.id === id);
  return {
    scenario: id,
    mode: spec.mode,
    evidence: spec.evidence,
    run: cleanRun(),
    observation: { ...OBS },
    ...overrides,
  };
}

function verdictOf(mod, id, overrides = {}) {
  const result = mod.judgeLocalScenario(scenarioInput(id, overrides));
  assert.ok(result && typeof result.verdict === 'string', `${id} 판정 결과가 없다`);
  return result;
}

function reportFixture({ pass = null, incident = null, priorOverride = null } = {}) {
  const rows = EXPECTED.map((s) => {
    if (pass && s.id === pass.id) return `| ${s.id} | ${s.window} | ${s.mode} | 측정함 | 적용 | 통과 | ${pass.runId} |`;
    return `| ${s.id} | ${s.window} | ${s.mode} | ${s.evidence} | — | 미측정 | — |`;
  }).join('\n');
  const incidents = [
    '| 인시던트 | 시나리오 | 선언 시각 | 끝 시각 | 완료 시각 | 예산 비율 | P0 | 포스트모템 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    incident ?? '',
  ].join('\n');
  const prior = priorOverride ?? '- F-08-5: 무효·미측정\n- F-08-9: 판정 못 함(무효·부분)\n- F-08-10: 미측정';
  return [
    '# F-08-12 Game Day 로컬 ①·② 보고서',
    '',
    '- **상태**: 미측정.',
    '',
    '## 1. 실행 표',
    '',
    '| 시나리오 | 창 | 실행 방식 | 증거 수준 | 주입 | 판정 | 증거 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    '## 3. 인시던트와 포스트모템',
    '',
    incidents,
    '',
    '## 4. 선행 측정 인용',
    '',
    prior,
    '',
    '## 7. 주장하지 않는 것',
    '',
    '- 30,000건/초·100만·K1/K2/K7 0을 주장하지 않는다.',
  ].join('\n');
}

function postmortemFixture(overrides = {}) {
  const lines = {
    '선언 시각': '2026-11-28T10:00:00+09:00',
    '끝 시각': '2026-11-28T10:30:00+09:00',
    '완료 시각': '2026-11-30T10:30:00+09:00',
    '첫 증상 시각': '2026-11-28T10:00:02+09:00',
    '첫 경보 시각': '2026-11-28T10:00:10+09:00',
    '사람이 안 시각': '2026-11-28T10:00:15+09:00',
    '탐지 경로': '경보',
    '주 원인 유형': '내부 저장소·메시징',
    '구성 요소': 'valkey',
    '기여 원인 유형': '용량·포화',
    '계기': 'G-23',
    '영향': '회차 1·28일 예산 20.0%',
    '예산 사용 비율': '20.0%',
    '쓴 손잡이': 'RB-06·RB-32',
    '후속 조치': '#123',
    'P0': '—',
    ...overrides,
  };
  return `# F-08-12 포스트모템 INC-1\n\n${Object.entries(lines).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}\n`;
}

function reportOptions(overrides = {}) {
  return {
    measured: true,
    runExists: (id) => id === '2026-11-28-g23-f0812',
    runResponseOk: () => true,
    postmortemExists: () => true,
    postmortemOk: () => true,
    ...overrides,
  };
}

test('F0812-1 ① 14종의 묶음·차례·ID가 ① 5종·② 9종과 같다', async () => {
  const mod = need(await load());
  assert.equal(mod.F0812_SCENARIOS.length, 14, '시나리오가 14종이 아니다');
  assert.deepEqual(mod.F0812_SCENARIOS.map((s) => s.id), IDS, '14종 ID·차례가 다르다');
  assert.deepEqual(mod.F0812_SCENARIOS.map((s) => s.order), EXPECTED.map((s) => s.order), 'order가 1~14가 아니다');
  assert.deepEqual(mod.F0812_GROUPS.map((g) => g.id), ['A', 'B'], '묶음이 A·B가 아니다');
  assert.deepEqual(mod.F0812_GROUPS[0].scenarioIds, GROUP_A, '① 5종이 다르다');
  assert.deepEqual(mod.F0812_GROUPS[1].scenarioIds, GROUP_B, '② 9종이 다르다');
  assert.equal(mod.F0812_SCENARIOS.filter((s) => s.group === 'A').length, 5, '①이 5종이 아니다');
  assert.equal(mod.F0812_SCENARIOS.filter((s) => s.group === 'B').length, 9, '②가 9종이 아니다');
});

test('F0812-1 ② 14종의 방식·증거·무대·런북·기대 대응·산출물이 정본과 같다', async () => {
  const mod = need(await load());
  assert.deepEqual(mod.F0812_MODES, ['로컬 실행', '대체 장애', '모의 진행'], '실행 방식 목록이 다르다');
  assert.deepEqual(mod.F0812_EVIDENCE, ['측정함', '설계만'], '증거 수준 목록이 다르다');
  assert.deepEqual(mod.F0812_VERDICTS, ['통과', '미달', '판정 못 함', '무효', '미측정'], '판정값 목록이 다르다');
  assert.deepEqual([...mod.F0812_ARTIFACTS].sort(), [...ARTIFACTS].sort(), '산출물 목록이 다르다');
  for (const s of EXPECTED) {
    const got = scenarioOf(mod, s.id);
    assert.equal(got.order, s.order, `${s.id} order가 다르다`);
    assert.equal(got.group, s.group, `${s.id} 묶음이 다르다`);
    assert.equal(got.window, s.window, `${s.id} 창이 다르다`);
    assert.equal(got.mode, s.mode, `${s.id} 실행 방식이 다르다`);
    assert.equal(got.evidence, s.evidence, `${s.id} 증거 수준이 다르다`);
    assert.equal(got.stageReady, s.stageReady, `${s.id} 무대 온전 여부가 다르다`);
    assert.deepEqual([...got.runbook.split('·')], [...s.runbook.split('·')], `${s.id} 런북이 다르다`);
    assert.match(got.name, s.name, `${s.id} 이름이 정본과 다르다`);
    assert.ok(Array.isArray(got.missing), `${s.id} missing이 배열이 아니다`);
    assert.ok(Array.isArray(got.partialParts), `${s.id} partialParts가 배열이 아니다`);
    assert.equal(got.partialParts.length, s.partial.length, `${s.id} 부분 실행 수가 다르다`);
    const missingText = got.missing.join(' ');
    const partialText = got.partialParts.join(' ');
    for (const key of s.missing) assert.ok(missingText.includes(key), `${s.id} missing에 '${key}'가 없다`);
    for (const key of s.partial) assert.ok(partialText.includes(key), `${s.id} partialParts에 '${key}'가 없다`);
    if (s.stageReady) assert.deepEqual(got.missing, [], `${s.id} 무대가 온전한데 빠진 부품이 있다`);
    else assert.ok(got.missing.length > 0, `${s.id} 무대가 없는데 빠진 부품이 비었다`);
    for (const key of s.alert) assert.ok(got.expectedAlert.includes(key), `${s.id} 기대 경보에 '${key}'가 없다`);
    for (const key of s.action) assert.ok(got.expectedAction.includes(key), `${s.id} 기대 대응에 '${key}'가 없다`);
    for (const key of s.invariant) assert.ok(got.invariant.includes(key), `${s.id} 불변식에 '${key}'가 없다`);
    assert.equal(typeof got.load, 'boolean', `${s.id} load가 불리언이 아니다`);
    assert.equal(typeof got.commandExpected, 'boolean', `${s.id} commandExpected가 불리언이 아니다`);
    assert.deepEqual([...got.artifacts].sort(), [...ARTIFACTS].sort(), `${s.id} 산출물이 다르다`);
    if (s.id === 'G-29' || s.id === 'G-30') {
      assert.equal(typeof got.runbookNote, 'string', `${s.id} 런북 공백 메모가 없다`);
      assert.match(got.runbookNote, /없/, `${s.id} 런북 공백 메모가 공백을 말하지 않는다`);
    }
  }
  assert.equal(scenarioOf(mod, 'G-17').mode, '모의 진행', 'G-17이 모의 진행이 아니다');
  assert.equal(scenarioOf(mod, 'G-17').evidence, '설계만', 'G-17이 설계만이 아니다');
  assert.equal(scenarioOf(mod, 'G-17').load, false, 'G-17에 부하가 있다');
  assert.equal(scenarioOf(mod, 'G-23').load, true, 'G-23에 부하가 없다');
  assert.equal(scenarioOf(mod, 'G-31').commandExpected, true, 'G-31에 명령 전파가 없다');
  assert.equal(scenarioOf(mod, 'G-23').commandExpected, false, 'G-23에 명령 전파가 있다');
  assert.equal(scenarioOf(mod, 'G-02').commandExpected, false, 'G-02에 명령 전파가 있다');
});

test('F0812-1 ③ 시나리오 ID·런북 제목이 정본과 맞고 G-30은 RB-34이며 F-08-11 계약이 있다', async () => {
  const mod = need(await load());
  const canon = read('docs/observability.md');
  const infra = read('docs/infra.md');
  const streaming = read('docs/streaming.md');
  for (const id of IDS) {
    assert.match(canon, new RegExp(`\\|\\s*${id}\\s*\\|`), `docs/observability.md §12에 ${id} 행이 없다`);
    const got = scenarioOf(mod, id);
    for (const rb of got.runbook.split('·')) {
      assert.match(rb, /^RB-\d\d$/, `${id} 런북 ID ${rb}가 RB-NN 꼴이 아니다`);
      const file = path.join(ROOT, 'docs', 'runbooks', `${rb}.md`);
      assert.ok(fs.existsSync(file), `${id} 런북 ${rb}.md가 없다`);
      const title = read(file).match(/^# (.+)$/m)?.[1] ?? '';
      assert.ok(title.includes(RUNBOOK_TITLES[rb]), `${rb} 제목이 '${RUNBOOK_TITLES[rb]}'가 아니다: ${title}`);
      assert.ok(infra.includes(`(runbooks/${rb}.md)`), `docs/infra.md §10이 ${rb} 파일을 가리키지 않는다`);
    }
  }
  assert.equal(scenarioOf(mod, 'G-30').runbook, 'RB-34', 'G-30 런북이 RB-34가 아니다');
  assert.match(read('docs/runbooks/RB-34.md'), /^# RB-34: 스트림 작업자 복구/m, 'RB-34 제목이 스트림 작업자 복구가 아니다');
  assert.match(read('docs/runbooks/RB-18.md'), /^# RB-18: 리전 전면 장애 대응/m, 'RB-18은 리전 장애 런북이어야 한다');
  assert.ok(streaming.includes('RB-34') && streaming.includes('G-30'), 'docs/streaming.md가 G-30을 RB-34로 가리키지 않는다');
  const g29 = scenarioOf(mod, 'G-29');
  const g30 = scenarioOf(mod, 'G-30');
  assert.match(g29.runbookNote, /세션|캐시|Redis/, 'G-29 런북 공백이 세션·캐시 Redis를 말하지 않는다');
  assert.match(g30.runbookNote, /RB-34|스트림/, 'G-30 런북 공백이 RB-34를 말하지 않는다');
  const incident = read('docs/runbooks/incident-criteria.md');
  for (const text of ['SEV1', '불변식 위반', '명령 2·3·6', '15분', '예산 50%', '28일 예산의 20%', '사람이나 외부', '48시간', 'RB-17']) {
    assert.ok(incident.includes(text), `incident-criteria.md에 '${text}'가 없다`);
  }
  for (const cause of CAUSES) assert.ok(incident.includes(cause), `incident-criteria.md에 원인 '${cause}'가 없다`);
  const files = fs.readdirSync(path.join(ROOT, 'docs', 'runbooks')).filter((f) => /^RB-(0[1-9]|[1-3]\d|4[01])\.md$/.test(f));
  assert.equal(files.length, 41, '런북 파일이 41종이 아니다');
  const infraRows = infra.split('\n').filter((l) => /^\| \[RB-\d\d\]\(runbooks\/RB-\d\d\.md\)/.test(l));
  assert.equal(infraRows.length, 41, 'docs/infra.md §10의 런북 행이 41종이 아니다');
});

test('F0812-2 ① 창 3a~3c·5/5/4·잠금·중단 규칙 10·경계 19종이 맞다', async () => {
  const mod = need(await load());
  assert.deepEqual(mod.F0812_WINDOWS.map((w) => w.id), ['3a', '3b', '3c'], '창이 3a~3c가 아니다');
  assert.deepEqual(mod.F0812_WINDOWS.map((w) => w.scenarioIds), [GROUP_A, ['G-17', 'G-18', 'G-19', 'G-20', 'G-21'], ['G-22', 'G-23', 'G-24', 'G-25']], '창별 시나리오가 다르다');
  assert.deepEqual(mod.F0812_WINDOWS.map((w) => w.scenarioIds.length), [5, 5, 4], '창별 5/5/4가 아니다');
  assert.deepEqual(mod.F0812_DEFAULTS, {
    detectLimitSec: 60,
    propagationLimitSec: 3,
    scrapeFastSec: 5,
    scrapeOtherSec: 15,
    evalSec: 5,
    groupWaitSec: 5,
    postmortemDueHours: 48,
    budgetP0Ratio: 0.2,
    maxHostCpuPct: 85,
    maxGeneratorCpuPct: 80,
    maxGeneratorMemPct: 90,
  }, '기본값이 정본과 다르다');
  assert.equal(mod.F0812_LOCK.take, 'docker lane4-F-08-12', '잠금 take가 다르다');
  assert.equal(mod.F0812_LOCK.drop, 'docker lane4-F-08-12', '잠금 drop이 다르다');
  assert.equal(mod.F0812_LOCK.dockerAll, false, 'docker-all을 허용한다');
  assert.equal(mod.F0812_STOP_RULES.length, 10, '중단 규칙이 10개가 아니다');
  assert.deepEqual(mod.F0812_STOP_RULES.map((r) => r.id), Array.from({ length: 10 }, (_, i) => `STOP-${String(i + 1).padStart(2, '0')}`), '중단 규칙 ID가 STOP-01~10이 아니다');
  const stopNeed = {
    'STOP-01': /무대/,
    'STOP-02': /잠금|docker-all/,
    'STOP-03': /85|procs_running/,
    'STOP-04': /주입|증거/,
    'STOP-05': /불변식/,
    'STOP-06': /롤백/,
    'STOP-07': /디스크|15GB/,
    'STOP-08': /ALERTS|기록/,
    'STOP-09': /두 번|무효/,
    'STOP-10': /감독|중단/,
  };
  for (const rule of mod.F0812_STOP_RULES) assert.match(rule.rule, stopNeed[rule.id], `${rule.id} 내용이 다르다`);
  assert.deepEqual(mod.F0812_PRIOR_MEASUREMENTS, { 'F-08-5': '무효·미측정', 'F-08-9': '판정 못 함(무효·부분)', 'F-08-10': '미측정' }, '선행 측정 인용이 다르다');
  assert.equal(mod.F0812_OUTSIDE.length, 19, '경계 19종이 아니다');
  assert.deepEqual([...mod.F0812_OUTSIDE.map((s) => s.id)].sort(), [...OUTSIDE.map((s) => s.id)].sort(), '경계 19종 ID가 다르다');
  for (const s of OUTSIDE) assert.equal(mod.F0812_OUTSIDE.find((x) => x.id === s.id)?.owner, s.owner, `${s.id} 소유 기능이 다르다`);
  assert.equal(mod.F0812_OUTSIDE.filter((s) => s.owner === 'F-08-6').length, 14, 'F-08-6 경계가 14종이 아니다');
  assert.equal(mod.F0812_OUTSIDE.filter((s) => s.owner === 'F-08-13').length, 5, 'F-08-13 경계가 5종이 아니다');
  assert.deepEqual(mod.F0812_POSTMORTEM.causeTypes, CAUSES, '포스트모템 원인 유형 9가지가 다르다');
  assert.equal(mod.F0812_POSTMORTEM.dueHours, 48, '포스트모템 48시간이 아니다');
  assert.equal(mod.F0812_POSTMORTEM.p0BudgetRatio, 0.2, 'P0 예산 20%가 아니다');
});

test('F0812-2 ② 인자 검사가 창·시나리오·기록·부분·재연·금지 인자를 가른다', async () => {
  const mod = need(await load());
  usage(() => mod.parseGamedayLocalArgs([]));
  usage(() => mod.parseGamedayLocalArgs(['--window', '4d']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3b', '--scenario', 'G-02']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--group', 'B']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--record']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--record', '--run-id', '2026-11-28-f0812-g02']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--rehearsal', '--record', '--run-id', '2026-11-28-g02-f0812']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--partial']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3b', '--scenario', 'G-17', '--partial']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--scenario', 'G-30', '--partial']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--docker-all']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--browser']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--leak']));
  usage(() => mod.parseGamedayLocalArgs(['--window', '3a', '--unknown']));

  const plain = mod.parseGamedayLocalArgs(['--window', '3a']);
  assert.equal(plain.window, '3a');
  assert.equal(plain.record, false);
  assert.equal(plain.rehearsal, false);
  const group = mod.parseGamedayLocalArgs(['--window', '3a', '--group', 'A']);
  assert.equal(group.group, 'A');
  const one = mod.parseGamedayLocalArgs(['--window', '3c', '--scenario', 'G-23', '--partial', '--record', '--run-id', '2026-11-28-g23-f0812', '--out', '.cache/peaket-f0812/g23']);
  assert.equal(one.scenario, 'G-23');
  assert.equal(one.partial, true);
  assert.equal(one.record, true);
  assert.equal(one.runId, '2026-11-28-g23-f0812');
  assert.equal(one.out, '.cache/peaket-f0812/g23');
  const rehearsal = mod.parseGamedayLocalArgs(['--window', '3b', '--group', 'B', '--rehearsal']);
  assert.equal(rehearsal.group, 'B');
  assert.equal(rehearsal.rehearsal, true);
  assert.equal(rehearsal.record, false);
  const judge = mod.parseGamedayLocalArgs(['--window', '3a', '--judge', '.cache/peaket-f0812/judge']);
  assert.equal(judge.judge, '.cache/peaket-f0812/judge');
});

test('F0812-3 ① 무대 없음·부분·방식·증거가 다르면 통과가 아니고 이 무대의 통과는 0이다', async () => {
  const mod = need(await load());
  for (const id of ['G-21', 'G-23', 'G-31', 'G-30', 'G-02', 'G-20', 'G-24', 'G-29']) {
    assert.equal(verdictOf(mod, id).verdict, '판정 못 함', `${id}가 판정 못 함이 아니다`);
  }
  assert.equal(verdictOf(mod, 'G-17').verdict, '판정 못 함', '모의 진행 G-17이 통과했다');
  assert.equal(verdictOf(mod, 'G-17', { evidence: '측정함' }).verdict, '판정 못 함', 'G-17 증거가 달라도 통과했다');
  for (const id of IDS) assert.notEqual(verdictOf(mod, id).verdict, '통과', `${id}가 이 로컬 무대에서 통과했다`);
});

test('F0812-3 ② 미완주·주입 증거 없음·롤백 실패·호스트 포화·증거 누락을 가른다', async () => {
  const mod = need(await load());
  const run = (overrides = {}) => mod.judgeLocalRun(runInput({ run: cleanRun(overrides) }));
  assert.equal(run().verdict, '통과', '깨끗한 실행이 통과하지 않았다');
  assert.equal(run({ complete: false }).verdict, '무효');
  assert.equal(run({ injection: { ...cleanRun().injection, applied: false } }).verdict, '무효');
  assert.equal(run({ injection: { ...cleanRun().injection, evidence: '' } }).verdict, '무효');
  assert.equal(run({ injection: { ...cleanRun().injection, rollbackOk: false } }).verdict, '무효');
  assert.equal(run({ host: { cpuPct: 84.9, procsRunning: 8, logicalCpus: 8 } }).verdict, '통과');
  assert.equal(run({ host: { cpuPct: 85, procsRunning: 8, logicalCpus: 8 } }).verdict, '무효');
  assert.equal(run({ host: { cpuPct: 50, procsRunning: 8, logicalCpus: 8 } }).verdict, '통과');
  assert.equal(run({ host: { cpuPct: 50, procsRunning: 9, logicalCpus: 8 } }).verdict, '무효');
  const noHost = mod.judgeLocalRun(runInput({ run: { ...cleanRun(), host: undefined } }));
  const noGen = mod.judgeLocalRun(runInput({ run: { ...cleanRun(), generator: undefined } }));
  const noInv = mod.judgeLocalRun(runInput({ run: { ...cleanRun(), invariants: undefined } }));
  for (const [name, r] of [['host', noHost], ['generator', noGen], ['invariants', noInv]]) {
    assert.notEqual(r.verdict, '통과', `${name} 없는 실행이 통과했다`);
    assert.match(r.reasons.join(' '), new RegExp(name, 'i'), `${name} 없는 까닭이 없다`);
  }
});

test('F0812-3 ③ 발생기·기대 대응 경계를 무효·미달·판정 못 함으로 가른다', async () => {
  const mod = need(await load());
  const run = (overrides = {}) => mod.judgeLocalRun(runInput({ run: cleanRun(overrides) }));
  const withGen = (generator, extra = {}) => cleanRun({ generator: { ...cleanRun().generator, ...generator }, ...extra });
  assert.equal(run({ generator: { ...cleanRun().generator, droppedIterations: 1 } }).verdict, '무효');
  assert.equal(run({ generator: { ...cleanRun().generator, droppedIterations: 0 } }).verdict, '통과');
  assert.equal(run({ generator: { ...cleanRun().generator, cpuPct: 80 } }).verdict, '통과');
  assert.equal(run({ generator: { ...cleanRun().generator, cpuPct: 80.1 } }).verdict, '무효');
  assert.equal(run({ generator: { ...cleanRun().generator, memPct: 90 } }).verdict, '통과');
  assert.equal(run({ generator: { ...cleanRun().generator, memPct: 90.1 } }).verdict, '무효');
  assert.equal(run({ httpReqs: 0 }).verdict, '무효');
  assert.equal(run({ httpReqs: 1 }).verdict, '통과');
  const noResponse = mod.judgeLocalRun(runInput({ run: cleanRun({ responseChecks: undefined }) }));
  assert.equal(noResponse.verdict, '판정 못 함');
  const badAction = mod.judgeLocalRun(runInput({ run: cleanRun({ responseChecks: { ...cleanRun().responseChecks, expectedAction: { ok: false, evidence: '503 없음' } } }) }));
  assert.equal(badAction.verdict, '미달');
  const emptyEvidence = mod.judgeLocalRun(runInput({ run: cleanRun({ responseChecks: { ...cleanRun().responseChecks, invariantHeld: { ok: true, evidence: '' } } }) }));
  assert.equal(emptyEvidence.verdict, '판정 못 함');
  // withGen은 아래 경계를 코드 상수 없이 다시 적기 위한 지역 도우미다.
  assert.equal(withGen({ cpuPct: 80 }).httpReqs, 100);
});

test('F0812-3 ④ 탐지는 T1p−T0, 전파는 T3−T2이며 60/3초 경계를 지킨다', async () => {
  const mod = need(await load());
  const jt = (overrides = {}, options = { commandExpected: true }) => mod.judgeLocalTimeline(timeline(overrides), options);
  const clean = jt();
  assert.equal(clean.verdict, '통과', '깨끗한 시간선이 통과하지 않았다');
  assert.equal(clean.detectionSec, 10);
  assert.equal(clean.propagationSec, 2);
  const after60 = { T1: '2026-11-28T10:01:05.000+09:00', T2: '2026-11-28T10:01:10.000+09:00', T3: '2026-11-28T10:01:12.000+09:00', T4: '2026-11-28T10:01:20.000+09:00' };
  assert.equal(jt({ ...after60, T1p: '2026-11-28T10:01:00.000+09:00' }).verdict, '통과');
  assert.equal(jt({ ...after60, T1p: '2026-11-28T10:01:00.001+09:00' }).verdict, '미달');
  assert.equal(jt({ T3: '2026-11-28T10:00:33.000+09:00' }).verdict, '통과');
  assert.equal(jt({ T3: '2026-11-28T10:00:33.001+09:00' }).verdict, '미달');
  assert.equal(jt({ T1p: undefined }).verdict, '판정 못 함');
  assert.equal(jt({ T4: undefined }).verdict, '판정 못 함');
  assert.equal(jt({ T1: '2026-11-28T10:00:05.000+09:00' }).verdict, '미달');
  assert.equal(jt({ T2: undefined }, { commandExpected: true }).verdict, '판정 못 함');
  assert.equal(jt({ T3: undefined }, { commandExpected: true }).verdict, '판정 못 함');
  const noCommand = jt({}, { commandExpected: false });
  assert.equal(noCommand.verdict, '통과');
  assert.equal(noCommand.propagationSec, null);
});

test('F0812-3 ⑤ 시간선 뜻·순서와 G-17 설계만, 이 무대 통과 0을 지킨다', async () => {
  const mod = need(await load());
  const jt = (overrides = {}) => mod.judgeLocalTimeline(timeline(overrides), { commandExpected: true });
  assert.equal(jt({ T1: '2026-11-28T10:00:15.000+09:00' }).verdict, '통과', 'T1이 T1p 뒤인 정상 시간선이 통과하지 않았다');
  assert.equal(jt({ T1: '2026-11-28T10:00:09.000+09:00' }).verdict, '미달', 'T1이 T1p보다 이른 시간선이 미달이 아니다');
  assert.equal(jt({ T4: '2026-11-28T10:00:31.000+09:00' }).verdict, '판정 못 함', 'T4가 T3보다 이른 시간선이 거부되지 않았다');
  assert.equal(verdictOf(mod, 'G-17').verdict, '판정 못 함');
  assert.equal(mod.F0812_SCENARIOS.filter((s) => s.stageReady).map((s) => s.id).join(','), 'G-17', '무대 온전 시나리오가 G-17 하나가 아니다');
  const humanFirst = mod.judgeLocalRun(runInput({ observation: { detectionPath: '사람', humanNoticedAt: '2026-11-28T10:00:05.000+09:00' } }));
  assert.equal(humanFirst.verdict, '미달', '사람이 먼저 알았는데 미달이 아니다');
  assert.equal(humanFirst.incidentRequired, true, '사람이 먼저 알았는데 POL-022 인시던트 선언이 없다');
});

test('F0812-4 ① 묶음 종합이 무효·판정 못 함·미달·통과를 가른다', async () => {
  const mod = need(await load());
  const result = (verdicts) => Object.entries(verdicts).map(([scenario, v]) => ({ scenario, verdict: v }));
  const passA = result(Object.fromEntries(GROUP_A.map((id) => [id, '통과'])));
  assert.equal(mod.judgeLocalGroup('A', passA).verdict, '통과');
  assert.equal(mod.judgeLocalGroup('A', result({ ...Object.fromEntries(GROUP_A.map((id) => [id, '통과'])), 'G-02': '미달' })).verdict, '미달');
  assert.equal(mod.judgeLocalGroup('A', result({ ...Object.fromEntries(GROUP_A.map((id) => [id, '통과'])), 'G-02': '무효' })).verdict, '판정 못 함');
  assert.equal(mod.judgeLocalGroup('A', result({ ...Object.fromEntries(GROUP_A.map((id) => [id, '통과'])), 'G-02': '판정 못 함' })).verdict, '판정 못 함');
  assert.equal(mod.judgeLocalGroup('A', []).verdict, '판정 못 함');
  assert.equal(mod.judgeLocalGroup('B', result(Object.fromEntries(GROUP_B.slice(0, 8).map((id) => [id, '통과'])))).verdict, '판정 못 함');
});

test('F0812-4 ② 보고서 뼈대가 14행 모두 미측정·0통과·선행 인용·인시던트 표를 둔다', async () => {
  const mod = need(await load());
  const md = mod.renderLocalReport({});
  assert.match(md, /F-08-12/, '보고서 제목에 F-08-12가 없다');
  const exec = md.split(/\n## /).find((part) => part.startsWith('1.')) ?? '';
  const rows = exec.split('\n').filter((line) => /^\|\s*G-\d\d\s*\|/.test(line));
  assert.equal(rows.length, 14, '보고서 실행 표가 14행이 아니다');
  for (const row of rows) assert.match(row, /\| 미측정 \|/, `미측정이 아닌 행이 있다: ${row}`);
  assert.ok(!/\| 통과 \|/.test(md), '미측정 뼈대에 통과 행이 있다');
  assert.ok(!rows.some((row) => row.includes('실측(PC)')), '미측정 뼈대 실행 행에 실측(PC) 표시가 있다');
  assert.match(md, /F-08-5/, 'F-08-5 선행 인용이 없다');
  assert.match(md, /무효·미측정/, 'F-08-5 무효·미측정이 없다');
  assert.match(md, /F-08-9/, 'F-08-9 선행 인용이 없다');
  assert.match(md, /판정 못 함\(무효·부분\)/, 'F-08-9 판정 못 함(무효·부분)이 없다');
  assert.match(md, /F-08-10/, 'F-08-10 선행 인용이 없다');
  assert.match(md, /F-08-10[^\n]*미측정/, 'F-08-10 미측정이 없다');
  assert.match(md, /인시던트 \| 시나리오 \| 선언 시각/, '인시던트 표가 없다');
  const check = mod.validateLocalReport(md, { measured: false, runExists: () => false, runResponseOk: () => false, postmortemExists: () => false, postmortemOk: () => false });
  assert.equal(check.ok, true, `미측정 뼈대를 거부했다: ${(check.reasons ?? []).join('; ')}`);
  assert.equal(check.passed, 0, '미측정 뼈대의 통과 수가 0이 아니다');
});

test('F0812-4 ③ 보고서·포스트모템이 실행 ID·무대·G-17·48h·20%·PII·금지 수치를 가른다', async () => {
  const mod = need(await load());
  const pass = reportFixture({ pass: { id: 'G-23', runId: '2026-11-28-g23-f0812' } });
  const options = reportOptions();
  assert.equal(mod.validateLocalReport(reportFixture(), { ...options, measured: true }).ok, true, '통과 없는 측정 보고서를 거부했다');
  assert.equal(mod.validateLocalReport(reportFixture(), { ...options, measured: true }).passed, 0, '통과 없는 보고서의 통과 수가 0이 아니다');
  assert.equal(mod.validateLocalReport(pass, options).ok, false, '무대 없는 G-23 통과를 허용했다');
  assert.equal(mod.validateLocalReport(pass, { ...options, measured: false }).ok, false, '측정 전 통과를 허용했다');
  assert.equal(mod.validateLocalReport(pass, { ...options, runExists: () => false }).ok, false, '실행 ID 없는 통과를 허용했다');
  const badId = mod.validateLocalReport(reportFixture({ pass: { id: 'G-23', runId: '2026-11-28-f0812-g23' } }), options);
  assert.equal(badId.ok, false, '중간 삽입 실행 ID를 허용했다');
  assert.match(badId.reasons.join(' '), /실행 ID|-f0812/, '중간 삽입 실행 ID의 까닭이 없다');
  assert.equal(mod.validateLocalReport(pass, { ...options, runResponseOk: () => false }).ok, false, '기대 대응 없는 통과를 허용했다');
  assert.equal(mod.validateLocalReport(reportFixture({ pass: { id: 'G-30', runId: '2026-11-28-g30-f0812' } }), { ...options, runExists: () => true }).ok, false, '무대 없는 G-30 통과를 허용했다');
  assert.equal(mod.validateLocalReport(reportFixture({ pass: { id: 'G-17', runId: '2026-11-28-g17-f0812' } }), { ...options, runExists: () => true }).ok, false, '설계만 G-17 통과를 허용했다');
  assert.equal(mod.validateLocalReport(reportFixture({ priorOverride: '- F-08-5: 무효·미측정\n- F-08-9: 판정 못 함(무효·부분)\n- F-08-10: 통과' }), { measured: false }).ok, false, 'F-08-10 통과 인용을 허용했다');

  const incident = (complete, budget, p0 = 'P0') => `| INC-1 | G-23 | 2026-11-28T10:00:00+09:00 | 2026-11-28T10:30:00+09:00 | ${complete} | ${budget}% | ${p0} | docs/review/measurements/F-08-12-postmortem-1.md |`;
  const withIncident = (row) => reportFixture({ incident: row });
  assert.equal(mod.validateLocalReport(withIncident(incident('2026-11-30T10:30:00+09:00', '25')), { ...options, measured: false }).ok, true, '48시간 정각을 거부했다');
  assert.equal(mod.validateLocalReport(withIncident(incident('2026-11-30T10:30:00.001+09:00', '25')), { ...options, measured: false }).ok, false, '48시간+1ms를 허용했다');
  assert.equal(mod.validateLocalReport(withIncident(incident('2026-11-29T10:30:00+09:00', '20.0', '—')), { ...options, measured: false }).ok, true, '20.0% P0 없음을 거부했다');
  assert.equal(mod.validateLocalReport(withIncident(incident('2026-11-29T10:30:00+09:00', '20.1', '—')), { ...options, measured: false }).ok, false, '20.1% P0 없음을 허용했다');
  assert.equal(mod.validateLocalReport(withIncident(incident('2026-11-29T10:30:00+09:00', '25')), { ...options, measured: false, postmortemExists: () => false }).ok, false, '포스트모템 없는 인시던트를 허용했다');
  assert.equal(mod.validateLocalReport(`${reportFixture()}\n- 연락처: 010-1234-5678\n`, { measured: false }).ok, false, '보고서 PII를 허용했다');
  assert.equal(mod.validateLocalReport(`${reportFixture()}\n- 내부 주소: http://10.0.0.5:9090\n`, { measured: false }).ok, false, '내부 주소를 허용했다');
  for (const token of FORBIDDEN) {
    assert.equal(mod.validateLocalReport(`${reportFixture()}\n- ${token} 달성\n`, { measured: false }).ok, false, `${token} 주장을 허용했다`);
    assert.equal(mod.validateLocalReport(`${reportFixture()}\n- ${token}은 주장하지 않는다\n`, { measured: false }).ok, true, `${token} 부정문을 거부했다`);
  }
  assert.equal(mod.validateLocalReport(withIncident(incident('2026-11-29T10:30:00+09:00', '25')), options).ok, true, '정상 인시던트를 거부했다');

  const pm = postmortemFixture();
  assert.equal(mod.validateLocalPostmortem(pm).ok, true, '정상 포스트모템을 거부했다');
  assert.equal(mod.validateLocalPostmortem(postmortemFixture({ '주 원인 유형': '네트워크' })).ok, false, '원인 유형 9 밖을 허용했다');
  assert.equal(mod.validateLocalPostmortem(postmortemFixture({ '후속 조치': '없음' })).ok, false, '이슈 링크 없는 후속 조치를 허용했다');
  assert.equal(mod.validateLocalPostmortem(postmortemFixture({ '완료 시각': '2026-11-30T10:30:00.001+09:00' })).ok, false, '48시간+1ms 포스트모템을 허용했다');
  assert.equal(mod.validateLocalPostmortem(postmortemFixture({ '예산 사용 비율': '20.1%', P0: '—' })).ok, false, '20.1% P0 없음을 허용했다');
  assert.equal(mod.validateLocalPostmortem(`${pm}\n- 연락처: 010-1234-5678\n`).ok, false, '포스트모템 PII를 허용했다');
  assert.equal(mod.containsPii('010-1234-5678'), true, '전화번호 PII를 못 찾았다');
  assert.equal(mod.containsPii('a@b.com'), true, '이메일 PII를 못 찾았다');
  assert.equal(mod.containsPii('http://10.0.0.5:9090'), true, '사설 IP를 못 찾았다');
});

test('F0812-5 ① 계획 JSON이 batch·창 객체·14종·잠금·중단 규칙·선행 인용·경계를 담는다', async () => {
  const mod = need(await load());
  const plan = readJson(PLAN_JSON);
  const check = mod.validateLocalPlan(plan);
  assert.equal(check.ok, true, `계획 JSON이 검증을 지나지 않았다: ${(check.reasons ?? []).join('; ')}`);
  assert.equal(plan.batch, 'F-08-12');
  assert.equal(plan.feature, 'F-08-12');
  assert.deepEqual(plan.windows.map((w) => w.id), ['3a', '3b', '3c']);
  assert.deepEqual(plan.windows.map((w) => w.scenarioIds), [GROUP_A, ['G-17', 'G-18', 'G-19', 'G-20', 'G-21'], ['G-22', 'G-23', 'G-24', 'G-25']]);
  assert.equal(plan.scenarios.length, 14, '계획 JSON 시나리오가 14종이 아니다');
  assert.deepEqual(plan.scenarios.map((s) => s.id), IDS, '계획 JSON 시나리오 ID·차례가 다르다');
  assert.equal(plan.lock.take, 'docker lane4-F-08-12');
  assert.equal(plan.lock.drop, 'docker lane4-F-08-12');
  assert.equal(plan.lock.dockerAll, false);
  assert.equal(plan.stopRules.length, 10, '계획 JSON 중단 규칙이 10개가 아니다');
  assert.deepEqual(plan.stopRules.map((r) => r.id), Array.from({ length: 10 }, (_, i) => `STOP-${String(i + 1).padStart(2, '0')}`));
  assert.match(plan.stopRules.find((r) => r.id === 'STOP-03').rule, /85|procs_running/);
  assert.deepEqual(plan.priorMeasurements, { 'F-08-5': '무효·미측정', 'F-08-9': '판정 못 함(무효·부분)', 'F-08-10': '미측정' });
  const notIncluded = JSON.stringify(plan.notIncluded);
  for (const token of ['F-08-6', 'F-08-9', 'F-08-10', 'F-08-11', 'F-08-13', 'F-08-8', 'F-08-5', 'F-08-2', 'K1', 'K2', 'K7', '30,000', '100만']) {
    assert.ok(notIncluded.includes(token), `계획 JSON notIncluded에 ${token}이 없다`);
  }
  for (const key of ['F-08-6', 'F-08-9', 'F-08-10', 'F-08-11', 'F-08-13', 'F-08-8', 'F-08-5', 'F-08-2']) {
    assert.ok(plan.boundaries[key], `계획 JSON 경계에 ${key}가 없다`);
  }
});

test('F0812-5 ② 계획 JSON의 명령·산출물·런북·경계가 기록·금지 인자·다른 기능 ID를 지킨다', async () => {
  const mod = need(await load());
  const plan = readJson(PLAN_JSON);
  for (const s of plan.scenarios) {
    assert.ok(Array.isArray(s.commands), `${s.id} 명령이 배열이 아니다`);
    const text = JSON.stringify(s.commands);
    assert.ok(!text.includes('--browser'), `${s.id} 명령에 --browser가 있다`);
    assert.ok(!text.includes('--leak'), `${s.id} 명령에 --leak이 있다`);
    assert.ok(!text.includes('--docker-all'), `${s.id} 명령에 --docker-all이 있다`);
    assert.ok(!/V-T18|V-T27|V-T28|SR-T13|P-T1|K1|K2|K7/.test(JSON.stringify(s)), `${s.id}가 다른 기능의 ID를 주장한다`);
    assert.ok(Array.isArray(s.artifacts) && s.artifacts.includes('timeline.csv'), `${s.id} 산출물에 timeline.csv가 없다`);
    for (const rb of String(s.runbook).split('·')) assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'runbooks', `${rb}.md`)), `${s.id} 런북 ${rb} 파일이 없다`);
    if (!s.stageReady && s.partialParts.length === 0) {
      assert.equal(s.commands.filter((c) => JSON.stringify(c).includes('--record')).length, 0, `${s.id} 무대 없음인데 기록 명령이 있다`);
    } else {
      const record = s.commands.find((c) => JSON.stringify(c).includes('--record'));
      assert.ok(record, `${s.id} 기록 명령이 없다`);
      const r = JSON.stringify(record);
      assert.ok(r.includes('--window'), `${s.id} 기록 명령에 --window가 없다`);
      assert.ok(r.includes(s.window), `${s.id} 기록 명령의 창이 다르다`);
      assert.ok(r.includes('--run-id'), `${s.id} 기록 명령에 --run-id가 없다`);
      assert.match(r, /-f0812"/, `${s.id} 실행 ID가 -f0812로 끝나지 않는다`);
      assert.ok(r.includes('--out'), `${s.id} 기록 명령에 --out이 없다`);
      assert.equal(r.includes('--partial'), s.partialParts.length > 0, `${s.id} --partial 표시가 부분 실행과 다르다`);
    }
  }
  assert.ok(!JSON.stringify(plan.scenarios).includes('docker-all'), '계획 시나리오에 docker-all이 있다');
});

test('F0812-6 ① 계획 문서가 감독 결정·T0~T4·RB-34·시간 셈·경계·검증 절과 금지 수치를 지킨다', () => {
  const text = read(PLAN_DOC);
  for (const heading of [
    '## 1. 정본 자리',
    '## 2. 감독에게',
    '## 3. 범위',
    '### 3.3 수용 기준·완료의 정의·실패 시나리오',
    '## 4. 현재 상태',
    '## 5. 장부 범위',
    '## 6. 측정 설계',
    '### 6.3 시나리오 14종',
    '### 6.5 중단 규칙',
    '### 6.7 포스트모템',
    '## 7. 경계 표',
    '## 8. 시험',
    '## 9. 실패 확인',
    '## 10. 리뷰',
    '## 검증',
    '## 담당 표',
    '## 크기와 차례',
  ]) {
    assert.ok(text.includes(heading), `계획에 '${heading}' 절이 없다`);
  }
  for (const id of IDS) assert.ok(text.includes(id), `계획에 ${id}가 없다`);
  for (const boundary of ['F-08-6', 'F-08-11', 'F-08-13']) assert.ok(text.includes(boundary), `계획에 ${boundary} 경계가 없다`);
  assert.match(text, /docker lane4-F-08-12/, '계획에 잠금 이름이 없다');
  assert.match(text, /2026-11-27 감독 확인/g, '감독 확인 표시가 없다');
  assert.ok((text.match(/2026-11-27 감독 확인/g) ?? []).length >= 10, '감독 확인 10항목이 모두 확정되지 않았다');
  assert.match(text, /RB-34/, '계획에 G-30의 RB-34가 없다');
  assert.match(text, /T1p−T0|T1p-T0/, '계획에 T1p 탐지 식이 없다');
  assert.match(text, /T3−T2|T3-T2/, '계획에 T3 전파 식이 없다');
  assert.match(text, /2\.625일/, '계획에 21시간의 2.625일 셈이 없다');
  assert.match(text, /4\.50일/, '계획에 4.50일 합계가 없다');
  const passThreeLines = text.split('\n').filter((l) => l.includes('통과할 수 있는 셋') && !/RV0812-04|성립하지 않는다|지운다/.test(l));
  assert.deepEqual(passThreeLines, [], '계획에 통과할 수 있는 셋 주장이 남아 있다');
  const dockerAllLines = text.split('\n').filter((l) => l.includes('docker-all'));
  assert.ok(dockerAllLines.length > 0, '계획에 docker-all 경계가 없다');
  for (const line of dockerAllLines) assert.match(line, /금지|쓰지|없|않|거부/, 'docker-all을 부정하지 않는 줄이 있다');
  assert.match(text, /미실행|미측정/, '계획에 미실행·미측정 표시가 없다');
  assert.ok(Buffer.byteLength(text) < 90_000, '계획 파일이 90KB를 넘는다');
  assert.ok(!new RegExp(EXECUTION_CLAIMS.join('|')).test(text), '계획에 실행 주장 낱말이 있다');

  const allowed = /주장하지 않는다|쓰지 않는다|하지 않는다|않는다|없고|없다|아니다|못 한다|인용|범위 밖|위반|미측정|판정 못 함|무효|동결|닫지 않는다|닫지 않는|미실행|설계만|외삽은 하지 않는다/;
  for (const line of text.split('\n')) {
    if (!FORBIDDEN.some((token) => line.includes(token))) continue;
    assert.match(line, allowed, `금지 수치가 부정문 밖에 있다: ${line}`);
  }
});
