// F-08-13 Game Day 모의 진행·복원 연습 시험. Docker·kind·k6·브라우저 없이
// 카탈로그·판정 계약·G-18 단계·모의 진행 기록·보고서·계획만 본다.
// 정본 값은 시험 안에 적고, 구현 상수를 가져오지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'loadtest', 'runner', 'gameday-recovery.mjs');
const PLAN_JSON = path.join(ROOT, 'loadtest', 'plan', 'f0813-plan.json');
const REPORT = path.join(ROOT, 'docs', 'review', 'measurements', 'F-08-13-recovery.md');
const PLAN_DOC = path.join(ROOT, 'docs', 'review', 'plans', 'F-08-13.md');

// docs/observability.md §12·docs/verification.md §5.2에서 온 6종.
// mode/evidence는 정본이고, runEvidence는 이번 연습의 증거 수준이다.
// stageReady는 '전체 시나리오 무대가 준비됐는가'다. 6종 모두 false다.
const EXPECTED = [
  {
    id: 'G-26', order: 1, window: '3d', mode: '대체 장애', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['Mimir', 'Loki', 'Tempo', '관측 Kafka', 'AZ'], runbook: 'RB-09·RB-34',
    alert: ['관측 저장소', 'SEV3', 'Tempo 소비 지연'],
    action: ['정족수', '빈칸', '관측 Kafka', '따라잡', 'SLO 경보', '자동 제어', '입력'],
    recovery: ['소비 지연', 'SEV3', '빈칸'], invariant: ['SLO 경보', '자동 제어'], name: /관측 스택 AZ/,
  },
  {
    id: 'G-27', order: 2, window: '3d', mode: '대체 장애', runMode: '모의 진행', normEvidence: '측정함', runEvidence: '설계만',
    missing: ['KMS', '도쿄 복제 키'], runbook: 'RB-08',
    alert: ['감사 체인', 'mac', 'SEV2', 'KMS'],
    action: ['KMS 없이', '커밋', '전파', '도쿄', '따라잡', '1시간 검증 잡'],
    recovery: ['체인', '따라잡', '검증 잡', '통과'], invariant: ['접수 p95 500ms', '커밋·전파'], name: /KMS 정지/,
  },
  {
    id: 'G-28', order: 3, window: '3e', mode: '모의 진행', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['IAM Identity Center', '비상 접근 계정', 'ops-svc 정지'], runbook: 'RB-37·RB-08',
    alert: ['로그인', 'ops-svc 가용성 SEV1', '비상 접근 계정', 'SEV1'],
    action: ['identity-svc', '관리 계정', '영향 없이', '명령 2', 'ops-svc', '함께 멈춘', 'RB-08', 'RB-37', 'ops-breakglass', '10초'],
    recovery: ['평소 경로', '비상 계정', '세션', '감사 로그'], invariant: ['관리 계정', '명령 전파 p99 10초'], name: /신원 제공자/,
  },
  {
    id: 'G-32', order: 4, window: '3e', mode: '모의 진행', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['NLB', 'zonal shift', 'AZ', 'CloudFront VPC 원본'], runbook: 'RB-13',
    alert: ['준비 파드', '의존성 원인 SEV2', 'MSK 브로커'],
    action: ['1.5', '두 AZ', 'HPA', 'Karpenter', '영역 빼기 판단', '새 연결', '시간', 'MSK'],
    recovery: ['세 AZ', '영역 빼기', '만료', '5xx'], invariant: ['오버셀 0', '이중 결제 0'], name: /AZ 하나 전체/,
  },
  {
    id: 'G-33', order: 5, window: '3f', mode: '모의 진행', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['CloudFront 지속적 배포', 'NLB 대상 그룹'], runbook: 'RB-40·RB-23',
    alert: ['스테이징', '502', '504', '합성 점검', '28일', '다중 창', '온세일 빠른 경보'],
    action: ['승격하지 않', '스테이징 배포를 버', '되돌리는 커밋', '대상 그룹', '관제 원본 NLB'],
    recovery: ['주 배포', '대상 그룹', '탐지', '관제 입구'], invariant: ['주 배포', '관제 입구'], name: /엣지 설정/,
  },
  {
    id: 'G-18', order: 6, window: '3f', mode: '로컬 실행', runMode: '단계 양식', normEvidence: '측정함', runEvidence: '설계만',
    missing: ['Argo Rollouts', '카나리 분석'], runbook: 'RB-23',
    alert: ['카나리 분석 실패', 'SEV2'],
    action: ['분석 두 구간', '자동 중단', '안정판 100%'],
    recovery: ['안정판 100%', 'SLO', '오류율'], invariant: ['오류 예산'], name: /나쁜 배포/,
  },
];
const IDS = EXPECTED.map((s) => s.id);
const WINDOWS = [
  { id: '3d', scenarioIds: ['G-26', 'G-27'] },
  { id: '3e', scenarioIds: ['G-28', 'G-32'] },
  { id: '3f', scenarioIds: ['G-33', 'G-18'] },
];
const DRILLS = [
  {
    id: 'R-PG-FAILOVER', window: '3d', name: /로컬 PostgreSQL 장애 조치/, mode: '대체 장애', runMode: '모의 진행',
    normEvidence: '측정함', runEvidence: '설계만', missing: ['복제본', '승격'], runbook: 'RB-10',
    checks: ['재시도', '멱등', 'Outbox', '승격'],
  },
  {
    id: 'R-PITR', window: '3e', name: /PITR/, mode: '리허설', runMode: '모의 진행',
    normEvidence: '설계만', runEvidence: '설계만', missing: ['백업', 'WAL 아카이브'], runbook: 'RB-10',
    checks: ['복원 시점', '파기 감사 로그', '재적용'],
  },
  {
    id: 'R-CROSS-REGION', window: '3e', name: /교차 리전 복원/, mode: '모의 진행', runMode: '모의 진행',
    normEvidence: '설계만', runEvidence: '설계만', missing: ['도쿄 스택', '교차 리전 백업'], runbook: 'RB-18',
    checks: ['Terraform', '런북 대조', '걸릴 시간'],
  },
];
const OUTSIDE = [
  { id: 'G-01', owner: 'F-08-6' }, { id: 'G-03', owner: 'F-08-6' }, { id: 'G-04', owner: 'F-08-6' },
  { id: 'G-05', owner: 'F-08-6' }, { id: 'G-06', owner: 'F-08-6' }, { id: 'G-07', owner: 'F-08-6' },
  { id: 'G-08', owner: 'F-08-6' }, { id: 'G-09', owner: 'F-08-6' }, { id: 'G-11', owner: 'F-08-6' },
  { id: 'G-12', owner: 'F-08-6' }, { id: 'G-13', owner: 'F-08-6' }, { id: 'G-14', owner: 'F-08-6' },
  { id: 'G-15', owner: 'F-08-6' }, { id: 'G-16', owner: 'F-08-6' },
  { id: 'G-02', owner: 'F-08-12' }, { id: 'G-10', owner: 'F-08-12' }, { id: 'G-17', owner: 'F-08-12' },
  { id: 'G-19', owner: 'F-08-12' }, { id: 'G-20', owner: 'F-08-12' }, { id: 'G-21', owner: 'F-08-12' },
  { id: 'G-22', owner: 'F-08-12' }, { id: 'G-23', owner: 'F-08-12' }, { id: 'G-24', owner: 'F-08-12' },
  { id: 'G-25', owner: 'F-08-12' }, { id: 'G-29', owner: 'F-08-12' }, { id: 'G-30', owner: 'F-08-12' },
  { id: 'G-31', owner: 'F-08-12' },
];
const ARTIFACTS = ['tabletop.md', 'steps.csv', 'manifest.json', 'timeline.csv'];
const G18_STEPS = ['T0', 'T1p', 'T1', 'T2', 'T3', 'T4'];
const HANDOFF = { id: 'G-18', from: 'F-08-12', fromOrder: 14, to: 'F-08-13' };
const CAUSES = ['변경', '외부 의존', '내부 저장소·메시징', '용량·포화', '코드 결함', '데이터', '보안', '운영 조작', '기반'];
const RUNBOOK_TITLES = {
  'RB-08': 'ops-svc 장애 시 비상 런북 가동',
  'RB-09': '관측 스택 장애와 제어 입력 없음 대응',
  'RB-10': 'Aurora PostgreSQL 장애 조치 검증 및 PITR 시점 복원 집행',
  'RB-13': 'Envoy 게이트웨이 파드 대량 손실 및 NLB 가용 영역 마비 대응',
  'RB-17': '포스트모템',
  'RB-18': '리전 전면 장애 대응',
  'RB-23': '배포 되돌리기',
  'RB-34': '스트림 작업자 복구',
  'RB-37': '비상 접근 계정 사용',
  'RB-40': 'CloudFront·DNS 전체 장애',
};
const FORBIDDEN = ['30k/s', '30,000건/초', '100만', 'K1', 'K2', 'K7'];
const NEGATIONS = ['주장하지 않', '금지', '범위 밖', '위반', '쓰지 않', '하지 않는다', '바꾸지 않', '닫지 않', '미실행', '미측정'];

async function load() {
  if (!fs.existsSync(RUNNER)) return { missing: 'loadtest/runner/gameday-recovery.mjs' };
  try {
    return await import(pathToFileURL(RUNNER).href);
  } catch (error) {
    return { error };
  }
}

function need(mod) {
  if (mod.missing) assert.fail(`${mod.missing}가 없다`);
  if (mod.error) assert.fail(`loadtest/runner/gameday-recovery.mjs를 읽지 못했다: ${mod.error.message}`);
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

function drillOf(mod, id) {
  assert.equal(typeof mod.drillOf, 'function', 'drillOf 함수가 없다');
  const d = mod.drillOf(id);
  assert.ok(d, `복원 연습 ${id}가 없다`);
  return d;
}

function usage(fn) {
  assert.throws(fn, (error) => error?.name === 'UsageError');
}

const T = {
  t0: '2026-11-29T10:00:00.000+09:00',
  t1: '2026-11-29T10:00:15.000+09:00',
  t1p: '2026-11-29T10:00:10.000+09:00',
  t2: '2026-11-29T10:00:20.000+09:00',
  t3: '2026-11-29T10:02:20.000+09:00',
  t4: '2026-11-29T10:05:20.000+09:00',
};

function recordFor(spec, overrides = {}) {
  return {
    complete: true,
    runMode: spec.runMode,
    runEvidence: '설계만',
    measured: false,
    runId: null,
    runExists: false,
    manifest: false,
    timeline: false,
    checks: {
      expectedAlert: { ok: true, evidence: '정본 문구 대조' },
      expectedAction: { ok: true, evidence: '런북 순서 대조' },
      recovery: { ok: true, evidence: '복구 확인 항목 대조' },
    },
    evidenceText: '문서 대조, 실제 주입 없음',
    ...overrides,
  };
}

function scenarioInput(id, overrides = {}) {
  const spec = EXPECTED.find((s) => s.id === id);
  return { scenario: id, record: recordFor(spec), ...overrides };
}

function g18Input(overrides = {}) {
  return {
    steps: [
      { id: 'T0', at: T.t0 },
      { id: 'T1p', at: T.t1p },
      { id: 'T1', at: T.t1 },
      { id: 'T2', at: T.t2 },
      { id: 'T3', at: T.t3 },
      { id: 'T4', at: T.t4 },
    ],
    stageReady: false,
    measured: false,
    runId: null,
    runExists: false,
    manifest: false,
    timeline: false,
    ...overrides,
  };
}

function runProof(overrides = {}) {
  return {
    runId: '2026-11-29-g18-f0813',
    runExists: true,
    manifest: true,
    timeline: true,
    ...overrides,
  };
}

function tabletopFixture(overrides = {}) {
  const lines = {
    '시나리오': 'G-26',
    '창': '3d',
    '역할': 'IC lane4-freeze-ic-opencode, OL lane4-freeze-ol-opencode, CL lane4-freeze-cl-opencode, SO lane4-freeze-so-opencode',
    '연습 시각': '2026-11-29T10:00+09:00',
    '정본 방식·증거': '대체 장애 / 설계만',
    '이번 연습 방식': '모의 진행',
    '이번 연습 증거': '설계만',
    '주입 의도(실제 주입 아님)': '한 AZ의 Mimir·Loki 인제스터와 Tempo 소비 부품, 관측 Kafka 브로커 1대를 멈춘다고 가정한다',
    '기대 경보': '관측 저장소 SEV3(Tempo 소비 지연), SLO 경보는 울리지 않는다',
    '기대 대응': '지표·로그 쓰기는 정족수로 계속되고 조회 결과에 빈칸이 없다',
    '복원 확인': '소비 지연 SEV3이 풀리고 조회 빈칸이 0이다',
    '런북': 'RB-09·RB-34',
    '판정': '판정 못 함',
    '증거': '문서 대조',
    '후속 조치': '#123',
    ...overrides,
  };
  return `# F-08-13 모의 진행 기록 G-26\n\n${Object.entries(lines).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}\n`;
}

function postmortemFixture(overrides = {}) {
  const lines = {
    '선언 시각': '2026-11-29T10:00:00+09:00',
    '끝 시각': '2026-11-29T10:30:00+09:00',
    '완료 시각': '2026-12-01T10:30:00+09:00',
    '첫 증상 시각': '2026-11-29T10:00:02+09:00',
    '첫 경보 시각': '2026-11-29T10:00:10+09:00',
    '사람이 안 시각': '2026-11-29T10:00:15+09:00',
    '탐지 경로': '경보',
    '주 원인 유형': '기반',
    '구성 요소': 'nlb',
    '기여 원인 유형': '용량·포화',
    '계기': 'G-32',
    '영향': '회차 1·28일 예산 20.0%',
    '예산 사용 비율': '20.0%',
    '쓴 손잡이': 'RB-13',
    '후속 조치': '#123',
    'P0': '—',
    ...overrides,
  };
  return `# F-08-13 포스트모템 INC-1\n\n${Object.entries(lines).map(([k, v]) => `- **${k}**: ${v}`).join('\n')}\n`;
}

function reportRow(md, id) {
  return md.split('\n').find((line) => line.startsWith(`| ${id} |`));
}

function replaceRow(md, id, row) {
  const lines = md.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`| ${id} |`));
  assert.ok(index >= 0, `${id} 행이 보고서에 없다`);
  lines[index] = row;
  return lines.join('\n');
}

test('F0813-1 ① 6종의 ID·차례·창이 3d/3e/3f 2/2/2와 같다', async () => {
  const mod = need(await load());
  assert.equal(mod.F0813_SCENARIOS.length, 6, '시나리오가 6종이 아니다');
  assert.deepEqual(mod.F0813_SCENARIOS.map((s) => s.id), IDS, '6종 ID·차례가 다르다');
  assert.deepEqual(mod.F0813_SCENARIOS.map((s) => s.order), [1, 2, 3, 4, 5, 6], 'order가 1~6이 아니다');
  assert.deepEqual(mod.F0813_WINDOWS.map((w) => w.id), ['3d', '3e', '3f'], '창이 3d~3f가 아니다');
  for (const w of WINDOWS) {
    const got = mod.F0813_WINDOWS.find((x) => x.id === w.id);
    assert.ok(got, `${w.id} 창이 없다`);
    assert.deepEqual(got.scenarioIds, w.scenarioIds, `${w.id} 시나리오가 다르다`);
    assert.equal(got.scenarioIds.length, 2, `${w.id}가 2종이 아니다`);
    for (const id of w.scenarioIds) assert.equal(scenarioOf(mod, id).window, w.id, `${id} 창이 다르다`);
  }
});

test('F0813-1 ② 6종의 정본 방식·증거·무대·런북·기대 대응·이번 연습 증거가 정본과 같다', async () => {
  const mod = need(await load());
  assert.deepEqual(mod.F0813_MODES, ['로컬 실행', '대체 장애', '모의 진행', '리허설'], '실행 방식 목록이 다르다');
  assert.deepEqual(mod.F0813_EVIDENCE, ['측정함', '설계만'], '증거 수준 목록이 다르다');
  assert.deepEqual(mod.F0813_VERDICTS, ['통과', '미달', '판정 못 함', '무효', '미측정'], '판정값 목록이 다르다');
  assert.deepEqual([...mod.F0813_ARTIFACTS].sort(), [...ARTIFACTS].sort(), '산출물 목록이 다르다');
  assert.deepEqual(mod.F0813_G18_STEPS, G18_STEPS, 'G-18 단계 순서가 다르다');
  for (const s of EXPECTED) {
    const got = scenarioOf(mod, s.id);
    assert.equal(got.order, s.order, `${s.id} order가 다르다`);
    assert.equal(got.window, s.window, `${s.id} 창이 다르다`);
    assert.equal(got.mode, s.mode, `${s.id} 정본 방식이 다르다`);
    assert.equal(got.runMode, s.runMode, `${s.id} 이번 연습 방식이 다르다`);
    assert.equal(got.normEvidence, s.normEvidence, `${s.id} 정본 증거 수준이 다르다`);
    assert.equal(got.runEvidence, '설계만', `${s.id} 이번 연습 증거가 설계만이 아니다`);
    assert.equal(got.stageReady, false, `${s.id} 무대가 준비됐다고 적었다`);
    assert.deepEqual([...got.runbook.split('·')], [...s.runbook.split('·')], `${s.id} 런북이 다르다`);
    assert.match(got.name, s.name, `${s.id} 이름이 정본과 다르다`);
    assert.ok(Array.isArray(got.missing) && got.missing.length > 0, `${s.id} missing이 비었다`);
    assert.ok(Array.isArray(got.steps) && got.steps.length > 0, `${s.id} 단계가 비었다`);
    const missingText = got.missing.join(' ');
    for (const key of s.missing) assert.ok(missingText.includes(key), `${s.id} missing에 '${key}'가 없다`);
    for (const [field, keys] of [['expectedAlert', s.alert], ['expectedAction', s.action], ['recovery', s.recovery], ['invariant', s.invariant]]) {
      assert.ok(Array.isArray(got[field]), `${s.id} ${field}가 배열이 아니다`);
      const text = got[field].join(' ');
      for (const key of keys) assert.ok(text.includes(key), `${s.id} ${field}에 '${key}'가 없다`);
    }
    if (s.id === 'G-18') assert.deepEqual(got.steps, G18_STEPS, 'G-18 steps가 T0·T1p·T1·T2·T3·T4 순서가 아니다');
  }
});

test('F0813-1 ③ 시나리오 ID·런북 제목·인시던트 기준·원인 9·41종이 정본과 맞는다', async () => {
  const mod = need(await load());
  const observability = read('docs/observability.md');
  for (const id of IDS) assert.ok(new RegExp(`\\| ${id} \\|`).test(observability), `${id}가 관측 §12에 없다`);
  for (const s of EXPECTED) {
    for (const rb of s.runbook.split('·')) {
      const file = read(`docs/runbooks/${rb}.md`);
      const title = file.split('\n')[0];
      assert.ok(title.startsWith(`# ${rb}:`), `${rb} 파일 제목이 다르다`);
      assert.match(title, new RegExp(RUNBOOK_TITLES[rb].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${rb} 제목이 정본과 다르다`);
    }
  }
  const criteria = read('docs/runbooks/incident-criteria.md');
  assert.match(criteria, /인시던트로 선언한다/);
  const numbered = criteria.split('\n').filter((line) => /^\d+\. /.test(line));
  assert.ok(numbered.length >= 7, '인시던트 선언 기준 7개가 없다');
  for (const token of ['SEV1', '불변식 위반', '명령 2·3·6', 'SEV2', '15분', '50%', '20%', '사람', '외부', '먼저']) {
    assert.ok(criteria.includes(token), `인시던트 7기준의 '${token}'가 없다`);
  }
  for (const cause of CAUSES) assert.ok(criteria.includes(cause), `원인 유형 '${cause}'가 없다`);
  const index = read('docs/runbooks/index.md');
  const rows = index.split('\n').filter((line) => /^\| \[RB-\d\d\]/.test(line));
  assert.equal(rows.length, 41, '런북 41종이 아니다');
});

test('F0813-1 ④ 33종 분할이 6+13+14이고 G-18 이관이 드러난다', async () => {
  const mod = need(await load());
  assert.equal(mod.F0813_OUTSIDE.length, 27, '바깥 시나리오가 27종이 아니다');
  const outsideIds = mod.F0813_OUTSIDE.map((s) => s.id);
  assert.equal(new Set(outsideIds).size, 27, '바깥 시나리오 ID가 겹친다');
  for (const s of OUTSIDE) {
    const got = mod.F0813_OUTSIDE.find((x) => x.id === s.id);
    assert.ok(got, `${s.id}가 바깥 목록에 없다`);
    assert.equal(got.owner, s.owner, `${s.id} 소유 기능이 다르다`);
  }
  for (const id of IDS) assert.ok(!outsideIds.includes(id), `${id}가 우리 몫과 바깥 목록에 함께 있다`);
  assert.equal(new Set([...IDS, ...outsideIds]).size, 33, '33종이 되지 않는다');
  assert.equal(mod.F0813_OUTSIDE.filter((s) => s.owner === 'F-08-6').length, 14, 'F-08-6 몫이 14종이 아니다');
  assert.equal(mod.F0813_OUTSIDE.filter((s) => s.owner === 'F-08-12').length, 13, 'F-08-12 잔여 몫이 13종이 아니다');
  assert.deepEqual(mod.F0813_HANDOFF.id, HANDOFF.id, '이관 시나리오가 G-18이 아니다');
  assert.equal(mod.F0813_HANDOFF.from, HANDOFF.from, '이관 전 소유 기능이 F-08-12가 아니다');
  assert.equal(mod.F0813_HANDOFF.fromOrder, HANDOFF.fromOrder, 'F-08-12 14번째가 아니다');
  assert.equal(mod.F0813_HANDOFF.to, HANDOFF.to, '이관 후 소유 기능이 F-08-13이 아니다');
});

test('F0813-2 ① 창·잠금·중단 규칙·복원 연습 3종이 정해져 있다', async () => {
  const mod = need(await load());
  assert.deepEqual(mod.F0813_LOCK, { take: 'docker lane4-F-08-13', drop: 'docker lane4-F-08-13', dockerAll: false, used: false }, '잠금 계약이 다르다');
  assert.equal(mod.F0813_STOP_RULES.length, 10, '중단 규칙이 10개가 아니다');
  assert.deepEqual(mod.F0813_STOP_RULES.map((r) => r.id), ['STOP-01', 'STOP-02', 'STOP-03', 'STOP-04', 'STOP-05', 'STOP-06', 'STOP-07', 'STOP-08', 'STOP-09', 'STOP-10'], '중단 규칙 ID가 다르다');
  const text = mod.F0813_STOP_RULES.map((r) => r.rule).join(' ');
  for (const key of ['무대', '지어', '통과', '런북', '개인', 'Docker', '필수', '두 번', 'G-18', '감독']) {
    assert.ok(text.includes(key), `중단 규칙에 '${key}'가 없다`);
  }
  assert.equal(mod.F0813_RESTORE_DRILLS.length, 3, '복원 연습이 3종이 아니다');
  for (const d of DRILLS) {
    const got = drillOf(mod, d.id);
    assert.equal(got.window, d.window, `${d.id} 창이 다르다`);
    assert.equal(got.mode, d.mode, `${d.id} 방식이 다르다`);
    assert.equal(got.runMode, d.runMode, `${d.id} 이번 연습 방식이 다르다`);
    assert.equal(got.normEvidence, d.normEvidence, `${d.id} 정본 증거가 다르다`);
    assert.equal(got.runEvidence, '설계만', `${d.id} 이번 연습 증거가 설계만이 아니다`);
    assert.equal(got.stageReady, false, `${d.id} 무대가 준비됐다고 적었다`);
    assert.equal(got.runbook, d.runbook, `${d.id} 런북이 다르다`);
    assert.match(got.name, d.name, `${d.id} 이름이 다르다`);
    const missingText = got.missing.join(' ');
    for (const key of d.missing) assert.ok(missingText.includes(key), `${d.id} missing에 '${key}'가 없다`);
    const checksText = got.checks.join(' ');
    for (const key of d.checks) assert.ok(checksText.includes(key), `${d.id} checks에 '${key}'가 없다`);
  }
});

test('F0813-2 ② 인자 검사가 창·시나리오·탁상/단계·기록·금지 인자를 지킨다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.parseRecoveryArgs, 'function', 'parseRecoveryArgs 함수가 없다');
  const ok = mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--tabletop']);
  assert.equal(ok.window, '3d');
  assert.equal(ok.scenario, 'G-26');
  assert.equal(ok.tabletop, true);
  const okSteps = mod.parseRecoveryArgs(['--window', '3f', '--scenario', 'G-18', '--steps']);
  assert.equal(okSteps.steps, true);
  const okRecord = mod.parseRecoveryArgs(['--window', '3e', '--scenario', 'G-28', '--tabletop', '--record', '--run-id', '2026-11-29-g28-f0813', '--out', 'docs/review/measurements/F-08-13-tabletop-G-28.md']);
  assert.equal(okRecord.runId, '2026-11-29-g28-f0813');
  const okDrill = mod.parseRecoveryArgs(['--window', '3d', '--drill', 'R-PG-FAILOVER', '--tabletop']);
  assert.equal(okDrill.drill, 'R-PG-FAILOVER');
  usage(() => mod.parseRecoveryArgs([]));
  usage(() => mod.parseRecoveryArgs(['--window', '3g', '--scenario', 'G-26']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-28']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--tabletop', '--steps']));
  usage(() => mod.parseRecoveryArgs(['--window', '3f', '--scenario', 'G-18', '--tabletop']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--steps']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--record']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--run-id', '2026-11-29-g26-f0813']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--record', '--run-id', '2026-11-29-g26']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--record', '--run-id', '2026-11-29-g26-f0813-extra']));
  usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', '--record', '--run-id', '2026-11-29-g26-f0813x']));
  assert.throws(() => usage(() => { throw new TypeError("Cannot read properties of undefined (reading 'window')"); }), '구현 크래시를 인자 거부로 세면 안 된다');
  for (const flag of ['--docker-all', '--browser', '--inject', '--k6', '--leak']) {
    usage(() => mod.parseRecoveryArgs(['--window', '3d', '--scenario', 'G-26', flag]));
  }
});

test('F0813-3 ① 기록이 없으면 미측정, 무대가 없으면 판정 못 함이다', async () => {
  const mod = need(await load());
  for (const id of IDS) {
    const none = mod.judgeRecoveryScenario({ scenario: id, record: null });
    assert.equal(none.verdict, '미측정', `${id} 기록 없음이 미측정이 아니다`);
    const got = mod.judgeRecoveryScenario(scenarioInput(id));
    assert.equal(got.verdict, '판정 못 함', `${id} 무대 없음이 판정 못 함이 아니다`);
    assert.equal(got.measured, false, `${id} measured가 false가 아니다`);
    const spec = EXPECTED.find((s) => s.id === id);
    assert.ok(got.missing.join(' ').includes(spec.missing[0]), `${id} 판정 이유에 missing이 없다`);
  }
});

test('F0813-3 ② 설계만인데 통과·측정함을 주장하거나 기록이 불완전하면 무효다', async () => {
  const mod = need(await load());
  const id = 'G-26';
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: recordFor(EXPECTED[0], { runEvidence: '측정함' }) })).verdict, '무효', '측정함 주장이 무효가 아니다');
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: recordFor(EXPECTED[0], { measured: true }) })).verdict, '무효', 'measured true가 무효가 아니다');
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: recordFor(EXPECTED[0], { evidenceText: '실측(PC)' }) })).verdict, '무효', '실측(PC) 주장이 무효가 아니다');
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: recordFor(EXPECTED[0], { runMode: '대체 장애' }) })).verdict, '무효', '이번 연습 방식 불일치가 무효가 아니다');
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: { complete: true, runMode: '모의 진행', runEvidence: '설계만', measured: false } })).verdict, '무효', 'checks 없는 기록이 무효가 아니다');
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: recordFor(EXPECTED[0], { complete: false }) })).verdict, '무효', '미완주 기록이 무효가 아니다');
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id)).verdict, '판정 못 함', '정상 설계만 기록이 판정 못 함이 아니다');
});

test('F0813-3 ③ G-18 단계가 T0·T1p·T1·T2·T3·T4 순서이고 300.000/300.001초 경계가 맞다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.judgeG18Steps, 'function', 'judgeG18Steps 함수가 없다');
  assert.deepEqual(mod.F0813_G18_STEPS, G18_STEPS, 'G-18 단계 상수가 T0·T1p·T1·T2·T3·T4가 아니다');
  const clean = mod.judgeG18Steps(g18Input());
  assert.equal(clean.rollbackSec, 300, 'T4−T2가 300초가 아니다');
  assert.equal(clean.withinTarget, true, '300초가 목표 안이 아니다');
  assert.equal(clean.verdict, '판정 못 함', '무대 없음이 판정 못 함이 아니다');
  const over = mod.judgeG18Steps(g18Input({ steps: [{ id: 'T0', at: T.t0 }, { id: 'T1p', at: T.t1p }, { id: 'T1', at: T.t1 }, { id: 'T2', at: T.t2 }, { id: 'T3', at: T.t3 }, { id: 'T4', at: '2026-11-29T10:05:20.001+09:00' }] }));
  assert.equal(over.rollbackSec, 300.001, 'T4−T2가 300.001초가 아니다');
  assert.equal(over.withinTarget, false, '300.001초가 목표 안으로 샜다');
  const missing = mod.judgeG18Steps(g18Input({ ...runProof(), steps: [{ id: 'T0', at: T.t0 }, { id: 'T2', at: T.t2 }] }));
  assert.equal(missing.verdict, '무효', '단계 누락이 무효가 아니다');
  const reversed = mod.judgeG18Steps(g18Input({ ...runProof(), steps: [{ id: 'T0', at: T.t0 }, { id: 'T2', at: T.t3 }, { id: 'T4', at: T.t2 }] }));
  assert.equal(reversed.verdict, '무효', '시간선 뒤집힘이 무효가 아니다');
  const noProof = mod.judgeG18Steps(g18Input({ stageReady: true, measured: true }));
  assert.equal(noProof.verdict, '판정 못 함', '실행 ID·산출물 없이 통과했다');
  const future = mod.judgeG18Steps(g18Input({ stageReady: true, measured: true, ...runProof() }));
  assert.equal(future.verdict, '통과', '300초·전체 무대·실행 증거가 통과가 아니다');
  const t1Null = mod.judgeG18Steps(g18Input({ stageReady: true, measured: true, ...runProof(), steps: [{ id: 'T0', at: T.t0 }, { id: 'T1p', at: T.t1p }, { id: 'T2', at: T.t2 }, { id: 'T3', at: T.t3 }, { id: 'T4', at: T.t4 }] }));
  assert.equal(t1Null.verdict, '통과', 'T1 null 정상 case가 통과가 아니다');
  const t1Before = mod.judgeG18Steps(g18Input({ stageReady: true, measured: true, ...runProof(), steps: [{ id: 'T0', at: T.t0 }, { id: 'T1', at: '2026-11-29T10:00:05.000+09:00' }, { id: 'T1p', at: T.t1p }, { id: 'T2', at: T.t2 }, { id: 'T3', at: T.t3 }, { id: 'T4', at: T.t4 }] }));
  assert.equal(t1Before.verdict, '미달', 'T1이 T1p보다 이른 시간선이 미달이 아니다');
  const futureOver = mod.judgeG18Steps(g18Input({ stageReady: true, measured: true, ...runProof(), steps: [{ id: 'T0', at: T.t0 }, { id: 'T1p', at: T.t1p }, { id: 'T2', at: T.t2 }, { id: 'T3', at: T.t3 }, { id: 'T4', at: '2026-11-29T10:05:21.000+09:00' }] }));
  assert.equal(futureOver.verdict, '미달', '301초가 미달이 아니다');
});

test('F0813-3 ④ 실행 증거·기대 대응이 없으면 통과가 아니고, 측정 주장과 무대 없음은 무효다', async () => {
  const mod = need(await load());
  const id = 'G-26';
  const failedAlert = recordFor(EXPECTED[0], { checks: { expectedAlert: { ok: false, evidence: '대조 실패' }, expectedAction: { ok: true, evidence: 'ok' }, recovery: { ok: true, evidence: 'ok' } } });
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: failedAlert })).verdict, '판정 못 함', '기대 경보 실패가 판정 못 함이 아니다');
  const failedRecovery = recordFor(EXPECTED[0], { checks: { expectedAlert: { ok: true, evidence: 'ok' }, expectedAction: { ok: true, evidence: 'ok' }, recovery: { ok: false, evidence: '대조 실패' } } });
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { record: failedRecovery })).verdict, '판정 못 함', '복원 확인 실패가 판정 못 함이 아니다');
  const measuredNoStage = mod.judgeRecoveryScenario(scenarioInput(id, { record: recordFor(EXPECTED[0], { measured: true, ...runProof() }), stageReady: false }));
  assert.equal(measuredNoStage.verdict, '무효', '무대 없이 측정 주장이 무효가 아니다');
  const futureRecord = recordFor(EXPECTED[0], { measured: true, runEvidence: '측정함', runId: runProof().runId, runExists: true, manifest: true, timeline: true, evidenceText: '실측(PC) · timeline.csv' });
  const future = mod.judgeRecoveryScenario(scenarioInput(id, { stageReady: true, record: futureRecord }));
  assert.equal(future.verdict, '통과', '전체 무대·측정·실행 증거·기대 대응이 통과가 아니다');
  for (const [field, overrides] of [['runId', { runId: null }], ['runExists', { runExists: false }], ['manifest', { manifest: false }], ['timeline', { timeline: false }]]) {
    const noArtifact = mod.judgeRecoveryScenario(scenarioInput(id, { stageReady: true, record: recordFor(EXPECTED[0], { measured: true, runEvidence: '측정함', runId: futureRecord.runId, runExists: true, manifest: true, timeline: true, ...overrides }) }));
    assert.equal(noArtifact.verdict, '판정 못 함', `${field}가 없는데 통과했다`);
  }
  const noEvidence = recordFor(EXPECTED[0], { measured: true, runEvidence: '측정함', runId: futureRecord.runId, runExists: true, manifest: true, timeline: true, checks: { expectedAlert: { ok: true, evidence: '' }, expectedAction: { ok: true, evidence: 'ok' }, recovery: { ok: true, evidence: 'ok' } } });
  assert.equal(mod.judgeRecoveryScenario(scenarioInput(id, { stageReady: true, record: noEvidence })).verdict, '판정 못 함', '기대 경보 증거가 비었는데 통과했다');
  const futureFail = mod.judgeRecoveryScenario(scenarioInput(id, { stageReady: true, record: recordFor(EXPECTED[0], { measured: true, runEvidence: '측정함', runId: futureRecord.runId, runExists: true, manifest: true, timeline: true, checks: { expectedAlert: { ok: true, evidence: 'ok' }, expectedAction: { ok: false, evidence: '실패' }, recovery: { ok: true, evidence: 'ok' } } }) }));
  assert.equal(futureFail.verdict, '미달', '측정된 기대 대응 실패가 미달이 아니다');
});

test('F0813-4 ① 묶음 종합이 통과·미달·판정 못 함을 구분한다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.judgeRecoveryGroup, 'function', 'judgeRecoveryGroup 함수가 없다');
  assert.equal(mod.judgeRecoveryGroup('3d', []).verdict, '판정 못 함', '빈 결과가 판정 못 함이 아니다');
  assert.equal(mod.judgeRecoveryGroup('3d', [{ id: 'G-26', verdict: '통과' }]).verdict, '판정 못 함', '일부만 있는 결과가 판정 못 함이 아니다');
  const allPass = ['G-26', 'G-27'].map((id) => ({ id, verdict: '통과' }));
  assert.equal(mod.judgeRecoveryGroup('3d', allPass).verdict, '통과', '모두 통과가 통과가 아니다');
  assert.equal(mod.judgeRecoveryGroup('3d', [{ id: 'G-26', verdict: '통과' }, { id: 'G-27', verdict: '미달' }]).verdict, '미달', '하나 미달이 미달이 아니다');
  assert.equal(mod.judgeRecoveryGroup('3d', [{ id: 'G-26', verdict: '통과' }, { id: 'G-27', verdict: '무효' }]).verdict, '판정 못 함', '하나 무효가 판정 못 함이 아니다');
  assert.equal(mod.judgeRecoveryGroup('3d', [{ id: 'G-26', verdict: '통과' }, { id: 'G-27', verdict: '판정 못 함' }]).verdict, '판정 못 함', '하나 판정 못 함이 판정 못 함이 아니다');
});

test('F0813-4 ② 보고서 뼈대가 6행+복원 3행·0통과·선행 인용 4개·G-18 단계 표를 둔다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.renderRecoveryReport, 'function', 'renderRecoveryReport 함수가 없다');
  const md = mod.renderRecoveryReport();
  for (const id of IDS) {
    const row = reportRow(md, id);
    assert.ok(row, `${id} 실행 행이 없다`);
    assert.ok(row.includes('미측정'), `${id} 행이 미측정이 아니다`);
    assert.ok(!row.includes('통과'), `${id} 행이 통과를 주장한다`);
    assert.ok(row.includes(EXPECTED.find((s) => s.id === id).runMode), `${id} 행에 이번 연습 방식이 없다`);
  }
  for (const d of DRILLS) {
    const row = reportRow(md, d.id);
    assert.ok(row, `${d.id} 복원 행이 없다`);
    assert.ok(row.includes('미측정'), `${d.id} 행이 미측정이 아니다`);
    assert.ok(!row.includes('통과'), `${d.id} 행이 통과를 주장한다`);
    assert.ok(row.includes(d.runMode), `${d.id} 행에 이번 연습 방식이 없다`);
  }
  assert.ok(md.includes('F-08-5: 무효·미측정'), 'F-08-5 선행 인용이 없다');
  assert.ok(md.includes('F-08-9: 판정 못 함(무효·부분)'), 'F-08-9 선행 인용이 없다');
  assert.ok(md.includes('F-08-10: 미측정'), 'F-08-10 선행 인용이 없다');
  assert.ok(md.includes('F-08-12: 미측정'), 'F-08-12 미측정 선행 인용이 없다');
  assert.match(md, /\| 인시던트 \| 시나리오 \|/, '인시던트 표 머리가 없다');
  const stepRows = md.split('\n').filter((line) => G18_STEPS.some((step) => line.startsWith(`| ${step} |`)));
  assert.deepEqual(stepRows.map((line) => line.split('|')[1].trim()), G18_STEPS, 'G-18 단계 표가 T0·T1p·T1·T2·T3·T4 순서가 아니다');
  assert.ok(!md.includes('docs/perf-ledger/runs/'), '실제 측정 폴더를 가리킨다');
  const check = mod.validateRecoveryReport(md, { measured: false });
  assert.equal(check.ok, true, `보고서 뼈대 검증이 실패했다: ${check.reasons.join('; ')}`);
  const skeleton = read(REPORT);
  const fileCheck = mod.validateRecoveryReport(skeleton, { measured: false });
  assert.equal(fileCheck.ok, true, `보고서 파일 검증이 실패했다: ${fileCheck.reasons.join('; ')}`);
});

function withIncident(md, row) {
  const lines = md.split('\n');
  const index = lines.findIndex((line) => line.startsWith('| 인시던트 | 시나리오 |'));
  assert.ok(index >= 0, '인시던트 표 머리가 없다');
  lines.splice(index + 2, 0, row);
  return lines.join('\n');
}

const INCIDENT_ROW = '| INC-1 | G-32 | 2026-11-29T10:00:00+09:00 | 2026-11-29T10:30:00+09:00 | 2026-12-01T10:30:00+09:00 | 20.0% | — | docs/review/measurements/F-08-13-postmortem-1.md |';

test('F0813-4 ③ 보고서·포스트모템 검증이 통과·선행 인용·금지 수치·PII·48시간·20% 경계를 거부한다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.validateRecoveryReport, 'function', 'validateRecoveryReport 함수가 없다');
  assert.equal(typeof mod.validateRecoveryPostmortem, 'function', 'validateRecoveryPostmortem 함수가 없다');
  const md = mod.renderRecoveryReport();
  const passRow = '| G-26 | 3d | 대체 장애 | 설계만 | 모의 진행 | 측정함 | 적용 | 통과 | 2026-11-29-g26-f0813 |';
  const badPass = replaceRow(md, 'G-26', passRow);
  const options = { measured: true, runExists: () => true, runResponseOk: () => true, postmortemExists: () => true, postmortemOk: () => true };
  assert.equal(mod.validateRecoveryReport(badPass, options).ok, false, '설계만 통과가 통과했다');
  const noPrior = md.replace('- F-08-12: 미측정\n', '');
  assert.equal(mod.validateRecoveryReport(noPrior, { measured: false }).ok, false, '선행 인용 누락이 통과했다');
  const wrongPrior = md.replace('F-08-12: 미측정', 'F-08-12: 판정 못 함(무대 없음)');
  assert.equal(mod.validateRecoveryReport(wrongPrior, { measured: false }).ok, false, 'F-08-12 오표기가 통과했다');
  const badId = replaceRow(md, 'G-26', passRow.replace('-f0813 |', '-f0813-extra |'));
  const badIdCheck = mod.validateRecoveryReport(badId, options);
  assert.equal(badIdCheck.ok, false, '잘못된 실행 ID가 통과했다');
  assert.match(badIdCheck.reasons.join(' '), /실행 ID|-f0813/, '잘못된 실행 ID 이유가 없다');
  for (const token of FORBIDDEN) {
    const forbidden = md.replace('## 8. 주장하지 않는 것', `## 8. 주장하지 않는 것\n\n- ${token} 달성`);
    assert.equal(mod.validateRecoveryReport(forbidden, { measured: false }).ok, false, `금지 수치 '${token}'가 통과했다`);
  }
  const broadNegation = md.replace('## 8. 주장하지 않는 것', '## 8. 주장하지 않는 것\n\n- 30,000건/초를 달성했고 실패하지 않았다.');
  assert.equal(mod.validateRecoveryReport(broadNegation, { measured: false }).ok, false, '넓은 부정어 휴리스틱이 통과했다');
  for (const pii of ['010-1234-5678', 'ops@example.com', '10.0.0.5', '192.168.1.10', '172.16.0.1']) {
    const text = md.replace('## 8. 주장하지 않는 것', `## 8. 주장하지 않는 것\n\n- 연락처 ${pii}`);
    assert.equal(mod.validateRecoveryReport(text, { measured: false }).ok, false, `PII '${pii}'가 통과했다`);
  }
  const noIncident = md.replace(/\| 인시던트 \| 시나리오 \|[^\n]*\n\|[^\n]*\n/, '');
  assert.equal(mod.validateRecoveryReport(noIncident, { measured: false }).ok, false, '인시던트 표 누락이 통과했다');
  const noStep = md.replace(/^\| T4 \|.*$/m, '');
  assert.equal(mod.validateRecoveryReport(noStep, { measured: false }).ok, false, 'G-18 T4 누락이 통과했다');
  assert.equal(mod.validateRecoveryReport(md, { measured: false }).ok, true, '정상 뼈대가 실패했다');

  assert.equal(mod.containsPii('010-1234-5678'), true, '전화번호를 찾지 못했다');
  assert.equal(mod.containsPii('ops@example.com'), true, '이메일을 찾지 못했다');
  assert.equal(mod.containsPii('10.0.0.5'), true, '사설 IP를 찾지 못했다');
  assert.equal(mod.containsPii('192.168.1.10'), true, '사설 IP를 찾지 못했다');
  assert.equal(mod.containsPii('172.16.0.1'), true, '사설 IP를 찾지 못했다');
  assert.equal(mod.containsPii('문서 대조, 실제 주입 없음'), false, '정상 문장을 PII로 잡았다');

  const incidentReport = withIncident(md, INCIDENT_ROW);
  const postmortem = postmortemFixture();
  const reportWithOk = { measured: false, postmortemExists: () => true, postmortemOk: () => mod.validateRecoveryPostmortem(postmortem).ok };
  assert.equal(mod.validateRecoveryReport(incidentReport, reportWithOk).ok, true, '정상 인시던트·포스트모템이 실패했다');
  assert.equal(mod.validateRecoveryReport(incidentReport, { measured: false, postmortemExists: () => false, postmortemOk: () => true }).ok, false, '포스트모템 파일 없음이 통과했다');
  assert.equal(mod.validateRecoveryReport(incidentReport, { measured: false, postmortemExists: () => true, postmortemOk: () => false }).ok, false, '잘못된 포스트모템이 통과했다');
  assert.equal(mod.validateRecoveryPostmortem(postmortem).ok, true, '48.0시간·20.0% 포스트모템이 실패했다');

  const at48 = mod.validateRecoveryPostmortem(postmortemFixture({ '완료 시각': '2026-12-01T10:30:00.000+09:00' }));
  assert.equal(at48.ok, true, '48시간 정각이 실패했다');
  const over48 = mod.validateRecoveryPostmortem(postmortemFixture({ '완료 시각': '2026-12-01T10:30:00.001+09:00' }));
  assert.equal(over48.ok, false, '48시간+1ms가 통과했다');
  const at20 = mod.validateRecoveryPostmortem(postmortemFixture({ '예산 사용 비율': '20.0%', '영향': '회차 1·28일 예산 20.0%', 'P0': '—' }));
  assert.equal(at20.ok, true, '20.0% P0 없음이 실패했다');
  const over20 = mod.validateRecoveryPostmortem(postmortemFixture({ '예산 사용 비율': '20.1%', '영향': '회차 1·28일 예산 20.1%', 'P0': '—' }));
  assert.equal(over20.ok, false, '20.1% P0 없음이 통과했다');
  const over20P0 = mod.validateRecoveryPostmortem(postmortemFixture({ '예산 사용 비율': '20.1%', '영향': '회차 1·28일 예산 20.1%', 'P0': 'P0-1' }));
  assert.equal(over20P0.ok, true, '20.1% P0 있음이 실패했다');
  assert.equal(mod.validateRecoveryPostmortem(postmortemFixture({ '주 원인 유형': '기타' })).ok, false, '원인 유형 9 밖이 통과했다');
  assert.equal(mod.validateRecoveryPostmortem(postmortemFixture({ '구성 요소': '' })).ok, false, '구성 요소 빈칸이 통과했다');
  assert.equal(mod.validateRecoveryPostmortem(postmortemFixture({ '후속 조치': '' })).ok, false, '이슈 링크 없는 후속 조치가 통과했다');
});

test('F0813-4 ④ 모의 진행 기록 검증이 필수 칸·역할 분리·설계만·판정 못 함을 지킨다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.validateTabletopRecord, 'function', 'validateTabletopRecord 함수가 없다');
  const ok = mod.validateTabletopRecord(tabletopFixture());
  assert.equal(ok.ok, true, `정상 탁상 기록이 실패했다: ${ok.reasons.join('; ')}`);
  for (const key of ['시나리오', '창', '역할', '연습 시각', '정본 방식·증거', '이번 연습 방식', '이번 연습 증거', '주입 의도(실제 주입 아님)', '기대 경보', '기대 대응', '복원 확인', '런북', '판정', '증거', '후속 조치']) {
    const missing = tabletopFixture({ [key]: '' });
    assert.equal(mod.validateTabletopRecord(missing).ok, false, `${key} 빈칸이 통과했다`);
  }
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '역할': 'IC same-session, OL same-session, CL lane4-freeze-cl-opencode, SO lane4-freeze-so-opencode' })).ok, false, 'IC·OL 같은 세션이 통과했다');
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '판정': '통과' })).ok, false, '탁상 통과가 통과했다');
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '이번 연습 방식': '대체 장애' })).ok, false, '탁상이 아닌 방식을 주장했다');
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '이번 연습 증거': '측정함' })).ok, false, '탁상 측정함이 통과했다');
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '복원 확인': '' })).ok, false, '복원 확인 누락이 통과했다');
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '기대 대응': '' })).ok, false, '기대 대응 누락이 통과했다');
  for (const pii of ['010-1234-5678', 'ops@example.com', '10.0.0.5', '192.168.1.10', '172.16.0.1']) {
    assert.equal(mod.validateTabletopRecord(tabletopFixture({ '증거': `연락처 ${pii}` })).ok, false, `PII '${pii}'가 통과했다`);
  }
  for (const token of FORBIDDEN) {
    assert.equal(mod.validateTabletopRecord(tabletopFixture({ '증거': `${token} 달성` })).ok, false, `금지 수치 '${token}'가 통과했다`);
  }
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '증거': '30,000건/초를 달성했고 실패하지 않았다.' })).ok, false, '넓은 부정어 휴리스틱이 통과했다');
  assert.equal(mod.validateTabletopRecord(tabletopFixture({ '후속 조치': '' })).ok, false, '후속 조치 누락이 통과했다');
});

test('F0813-5 ① 계획 JSON이 batch·창·6종·복원 3종·잠금·선행 인용·경계를 담는다', async () => {
  const mod = need(await load());
  const plan = readJson(PLAN_JSON);
  assert.equal(plan.batch, 'F-08-13', 'batch가 다르다');
  assert.ok(typeof plan.feature === 'string' && plan.feature.length > 0, 'feature가 비었다');
  assert.deepEqual(plan.windows.map((w) => w.id), ['3d', '3e', '3f'], '계획 JSON 창이 다르다');
  for (const w of WINDOWS) assert.deepEqual(plan.windows.find((x) => x.id === w.id).scenarioIds, w.scenarioIds, `${w.id} 계획 JSON 시나리오가 다르다`);
  assert.equal(plan.scenarios.length, 6, '계획 JSON 시나리오가 6종이 아니다');
  assert.deepEqual(plan.scenarios.map((s) => s.id), IDS, '계획 JSON 시나리오 ID·차례가 다르다');
  for (const s of EXPECTED) {
    const got = plan.scenarios.find((x) => x.id === s.id);
    assert.equal(got.window, s.window, `${s.id} 계획 JSON 창이 다르다`);
    assert.equal(got.mode, s.mode, `${s.id} 계획 JSON 방식이 다르다`);
    assert.equal(got.runMode, s.runMode, `${s.id} 계획 JSON 이번 연습 방식이 다르다`);
    assert.equal(got.normEvidence, s.normEvidence, `${s.id} 계획 JSON 정본 증거가 다르다`);
    assert.equal(got.runEvidence, '설계만', `${s.id} 계획 JSON 이번 연습 증거가 다르다`);
    assert.equal(got.stageReady, false, `${s.id} 계획 JSON 무대가 준비됐다`);
    assert.equal(got.runbook, s.runbook, `${s.id} 계획 JSON 런북이 다르다`);
    for (const key of s.missing) assert.ok(got.missing.join(' ').includes(key), `${s.id} 계획 JSON missing에 '${key}'가 없다`);
    for (const [field, keys] of [['expectedAlert', s.alert], ['expectedAction', s.action], ['recovery', s.recovery], ['invariant', s.invariant]]) {
      assert.ok(Array.isArray(got[field]), `${s.id} 계획 JSON ${field}가 배열이 아니다`);
      for (const key of keys) assert.ok(got[field].join(' ').includes(key), `${s.id} 계획 JSON ${field}에 '${key}'가 없다`);
    }
  }
  assert.equal(plan.drills.length, 3, '계획 JSON 복원 연습이 3종이 아니다');
  assert.deepEqual(plan.drills.map((d) => d.id), DRILLS.map((d) => d.id), '계획 JSON 복원 연습 ID가 다르다');
  for (const d of DRILLS) {
    const got = plan.drills.find((x) => x.id === d.id);
    assert.equal(got.window, d.window, `${d.id} 계획 JSON 창이 다르다`);
    assert.equal(got.mode, d.mode, `${d.id} 계획 JSON 방식이 다르다`);
    assert.equal(got.runMode, d.runMode, `${d.id} 계획 JSON 이번 연습 방식이 다르다`);
    assert.equal(got.normEvidence, d.normEvidence, `${d.id} 계획 JSON 정본 증거가 다르다`);
    assert.equal(got.runEvidence, '설계만', `${d.id} 계획 JSON 이번 연습 증거가 다르다`);
    assert.equal(got.stageReady, false, `${d.id} 계획 JSON 무대가 준비됐다`);
    assert.equal(got.runbook, d.runbook, `${d.id} 계획 JSON 런북이 다르다`);
    for (const key of d.missing) assert.ok(got.missing.join(' ').includes(key), `${d.id} 계획 JSON missing에 '${key}'가 없다`);
    for (const key of d.checks) assert.ok(got.checks.join(' ').includes(key), `${d.id} 계획 JSON checks에 '${key}'가 없다`);
  }
  assert.deepEqual(plan.lock, { take: 'docker lane4-F-08-13', drop: 'docker lane4-F-08-13', dockerAll: false, used: false }, '계획 JSON 잠금이 다르다');
  assert.equal(plan.stopRules.length, 10, '계획 JSON 중단 규칙이 10개가 아니다');
  assert.deepEqual(plan.stopRules.map((r) => r.id), ['STOP-01', 'STOP-02', 'STOP-03', 'STOP-04', 'STOP-05', 'STOP-06', 'STOP-07', 'STOP-08', 'STOP-09', 'STOP-10'], '계획 JSON 중단 규칙 ID가 다르다');
  const stopText = plan.stopRules.map((r) => r.rule).join(' ');
  for (const key of ['무대', '지어', '통과', '런북', '개인', 'Docker', '필수', '두 번', 'G-18', '감독']) {
    assert.ok(stopText.includes(key), `계획 JSON 중단 규칙에 '${key}'가 없다`);
  }
  const prior = JSON.stringify(plan.priorMeasurements);
  for (const token of ['F-08-5', '무효·미측정', 'F-08-9', '판정 못 함(무효·부분)', 'F-08-10', '미측정', 'F-08-12', '미측정']) {
    assert.ok(prior.includes(token), `계획 JSON 선행 인용에 '${token}'가 없다`);
  }
  assert.ok(!prior.includes('F-08-12: 판정 못 함(무대 없음)'), '계획 JSON이 F-08-12에 없는 판정을 인용한다');
  const notIncluded = plan.notIncluded.join(' ');
  for (const token of ['K8', 'K9', 'V-T18', 'V-T27', 'V-T28', 'NFR-027', 'K1', 'K2', 'K7', 'Q-T2', 'S-T1', 'P-T1', 'V-T4', 'V-T5', 'V-T17']) {
    assert.ok(notIncluded.includes(token), `계획 JSON notIncluded에 '${token}'가 없다`);
  }
  for (const b of plan.boundaries) {
    assert.ok(b.feature && b.owns && b.doesNot, '계획 JSON 경계에 feature·owns·doesNot이 비었다');
  }
  const boundaries = plan.boundaries.map((b) => b.feature).join(' ');
  for (const token of ['F-08-6', 'F-08-9', 'F-08-10', 'F-08-11', 'F-08-12', 'F-08-14']) {
    assert.ok(boundaries.includes(token), `계획 JSON 경계에 '${token}'가 없다`);
  }
  const check = mod.validateRecoveryPlan(plan);
  assert.equal(check.ok, true, `계획 JSON 검증이 실패했다: ${check.reasons.join('; ')}`);
});

test('F0813-5 ② 계획 JSON 명령이 탁상 기록·G-18 단계 양식이고 주입 명령이 없다', async () => {
  const mod = need(await load());
  const plan = readJson(PLAN_JSON);
  for (const s of plan.scenarios) {
    assert.ok(Array.isArray(s.commands) && s.commands.length > 0, `${s.id} 명령이 없다`);
    for (const command of s.commands) {
      assert.match(command, /^node loadtest\/run\.mjs v1 gameday-recovery /, `${s.id} 명령이 gameday-recovery가 아니다`);
      assert.ok(command.includes(`--window ${s.window}`), `${s.id} 명령에 --window가 없다`);
      assert.ok(command.includes(`--scenario ${s.id}`), `${s.id} 명령에 --scenario가 없다`);
      assert.match(command, /--record --run-id \S+-f0813(?:\s|$)/, `${s.id} 명령에 값이 -f0813으로 끝나는 실행 ID가 없다`);
      assert.match(command, /--out \S+/, `${s.id} 명령에 --out이 없다`);
      for (const flag of ['--inject', '--chaos', '--docker', '--k6', '--browser']) {
        assert.ok(!command.includes(flag), `${s.id} 명령에 ${flag}가 있다`);
      }
      if (s.id === 'G-18') assert.ok(!command.includes('--tabletop'), 'G-18 명령에 --tabletop이 함께 있다');
      else assert.ok(!command.includes('--steps'), `${s.id} 명령에 --steps가 있다`);
    }
    if (s.id === 'G-18') assert.ok(s.commands.some((c) => c.includes('--steps')), 'G-18 명령에 --steps가 없다');
    else assert.ok(s.commands.some((c) => c.includes('--tabletop')), `${s.id} 명령에 --tabletop이 없다`);
  }
  for (const d of plan.drills) {
    assert.ok(Array.isArray(d.commands) && d.commands.length > 0, `${d.id} 명령이 없다`);
    for (const command of d.commands) {
      assert.ok(command.includes(`--window ${d.window}`), `${d.id} 명령에 --window가 없다`);
      assert.ok(command.includes(`--drill ${d.id}`), `${d.id} 명령에 --drill이 없다`);
      assert.ok(command.includes('--tabletop'), `${d.id} 명령에 --tabletop이 없다`);
      assert.ok(!command.includes('--steps'), `${d.id} 명령에 --steps가 있다`);
      assert.match(command, /--record --run-id \S+-f0813(?:\s|$)/, `${d.id} 명령에 값이 -f0813으로 끝나는 실행 ID가 없다`);
      assert.match(command, /--out \S+/, `${d.id} 명령에 --out이 없다`);
      for (const flag of ['--inject', '--chaos', '--docker', '--k6', '--browser']) {
        assert.ok(!command.includes(flag), `${d.id} 명령에 ${flag}가 있다`);
      }
    }
  }
});

test('F0813-6 ① 계획 문서에 정본 자리·범위·측정 설계·경계·검증이 있고 금지 수치가 부정문 밖에 없다', async () => {
  const md = read(PLAN_DOC);
  for (const heading of ['## 1. 정본 자리', '## 3. 범위', '## 6. 측정 설계', '## 7. 경계 표', '## 8. 시험', '## 9. 실패 확인', '## 10. 리뷰', '## 검증']) {
    assert.ok(md.includes(heading), `${heading} 절이 없다`);
  }
  for (const id of IDS) assert.ok(md.includes(id), `${id}가 계획에 없다`);
  for (const w of ['3d', '3e', '3f']) assert.ok(md.includes(w), `창 ${w}가 계획에 없다`);
  for (const line of md.split('\n')) {
    if (line.startsWith('| RV0813-')) continue;
    for (const token of FORBIDDEN) {
      if (!line.includes(token)) continue;
      assert.ok(NEGATIONS.some((word) => line.includes(word)), `금지 수치 '${token}'가 부정문 밖에 있다: ${line}`);
    }
  }
});

test('F0813-6 ② 계획이 6종·복원 3종을 설계만/판정 못 함으로 두고 실제 주입 미실행을 밝힌다', async () => {
  const md = read(PLAN_DOC);
  assert.ok(md.includes('실제 주입은 하지 않는다'), '실제 주입 미실행 문장이 없다');
  assert.ok(md.includes('미실행'), '미실행 표시가 없다');
  assert.ok(md.includes('Docker·kind·k6·브라우저를 쓰지 않는다'), '동결 도구 금지 문장이 없다');
  assert.ok(md.includes('F-08-12 `미측정`'), 'F-08-12 미측정 인용이 없다');
  assert.ok(!md.includes('F-08-12 `판정 못 함(무대 없음)`'), 'F-08-12에 없는 판정을 인용한다');
  assert.ok(/복사·수정·재사용하지 않/.test(md), 'F-08-6 복사 금지가 없다');
  for (const id of IDS) {
    const row = md.split('\n').find((line) => line.startsWith(`| `) && line.includes(`| ${id} |`));
    assert.ok(row, `${id} 계획 표 행이 없다`);
    assert.ok(row.includes('설계만'), `${id} 행에 설계만이 없다`);
    assert.ok(row.includes(EXPECTED.find((s) => s.id === id).runMode), `${id} 행에 이번 연습 방식이 없다`);
    assert.ok(!row.includes('| 통과 |'), `${id} 행이 통과를 주장한다`);
  }
  for (const d of DRILLS) {
    const row = md.split('\n').find((line) => line.startsWith('| ') && line.includes(`| ${d.id} |`));
    assert.ok(row, `${d.id} 계획 표 행이 없다`);
    assert.ok(row.includes('설계만'), `${d.id} 행에 설계만이 없다`);
    assert.ok(row.includes(d.runMode), `${d.id} 행에 이번 연습 방식이 없다`);
  }
  assert.ok(md.includes('T0 카나리 배포 시작 → T1p'), 'G-18 시간선이 T0→T1p 순서가 아니다');
  assert.ok(md.includes('T1p Prometheus `ALERTS` firing 첫 표본 → T1'), 'G-18 시간선이 T1p→T1 순서가 아니다');
  for (const step of G18_STEPS) assert.ok(md.includes(step), `G-18 ${step} 단계가 계획에 없다`);
  assert.match(md, /통과[^.\n]{0,30}0/);
});
