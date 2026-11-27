// F-08-13 Game Day 모의 진행·복원 연습 카탈로그·판정·보고서 도구.
//
// 정본: docs/observability.md §12, docs/verification.md §5.2·§5.3,
//       docs/perf-ledger.md §8(T0~T4), docs/runbooks/incident-criteria.md,
//       docs/planning/03-policies-glossary.md §4(원인 유형 9).
// 계획: docs/review/plans/F-08-13.md §6~§10.
// 이 파일은 Docker·kind·k6·브라우저를 쓰지 않는다. 실제 주입·모의 진행은 측정 창 몫이고 지금은 미실행이다.
import { UsageError } from './args.mjs';

export const F0813_MODES = Object.freeze(['로컬 실행', '대체 장애', '모의 진행', '리허설']);
export const F0813_EVIDENCE = Object.freeze(['측정함', '설계만']);
export const F0813_VERDICTS = Object.freeze(['통과', '미달', '판정 못 함', '무효', '미측정']);
export const F0813_ARTIFACTS = Object.freeze(['tabletop.md', 'steps.csv', 'manifest.json', 'timeline.csv']);
export const F0813_G18_STEPS = Object.freeze(['T0', 'T1p', 'T1', 'T2', 'T3', 'T4']);
export const F0813_HANDOFF = Object.freeze({
  id: 'G-18',
  from: 'F-08-12',
  fromOrder: 14,
  to: 'F-08-13',
  note: 'F-08-12 보고서의 미측정 G-18 가운데 단계 측정만 이어받는다',
});
export const F0813_DEFAULTS = Object.freeze({
  rollbackTargetSec: 300,
  postmortemDueHours: 48,
  p0BudgetRatio: 0.2,
  tabletopMinutes: 90,
});
export const F0813_LOCK = Object.freeze({
  take: 'docker lane4-F-08-13',
  drop: 'docker lane4-F-08-13',
  dockerAll: false,
  used: false,
});
export const F0813_PRIOR_MEASUREMENTS = Object.freeze({
  'F-08-5': '무효·미측정',
  'F-08-9': '판정 못 함(무효·부분)',
  'F-08-10': '미측정',
  'F-08-12': '미측정',
});

const TABLETOP_STEPS = Object.freeze([
  '① 시나리오·정본·런북을 소리 내어 읽는다',
  '② T0에 무엇이 일어나는지 말한다(실제 주입 없음)',
  '③ 기대 경보와 심각도를 말한다',
  '④ 기대 대응을 런북 순서대로 말한다',
  '⑤ 복원 확인 항목을 하나씩 말한다',
  '⑥ 무대에 없는 부품과 판정할 수 없는 부분을 적는다',
  '⑦ 후속 조치(런북·도구·문서 공백)를 적는다',
]);

export const F0813_STOP_RULES = Object.freeze([
  { id: 'STOP-01', rule: '무대가 없다고 새로 만들려 한다(Mimir·KMS·NLB·Argo Rollouts 설치 등).' },
  { id: 'STOP-02', rule: '모의 진행 기록에 실제 주입·측정값을 지어 넣는다.' },
  { id: 'STOP-03', rule: '`설계만`을 `통과`·`측정함`으로 적는다.' },
  { id: 'STOP-04', rule: '런북·정본에 없는 기대 대응을 만든다.' },
  { id: 'STOP-05', rule: '개인 식별자·연락처·내부 주소가 기록에 들어간다.' },
  { id: 'STOP-06', rule: 'Docker·kind·k6·브라우저를 쓰려 한다(이 기능은 쓰지 않는다. 필요하면 감독에게 묻는다).' },
  { id: 'STOP-07', rule: '기록 양식의 필수 칸이 빈다.' },
  { id: 'STOP-08', rule: '같은 시나리오가 두 번 연속 `무효`다.' },
  { id: 'STOP-09', rule: 'G-18 단계 시간선이 뒤집히거나 T2·T4가 없다.' },
  { id: 'STOP-10', rule: '감독이 중단을 지시했거나 실제 외부 피해·개인정보 노출이 의심된다.' },
].map(Object.freeze));

export const F0813_WINDOWS = Object.freeze([
  { id: '3d', scenarioIds: Object.freeze(['G-26', 'G-27']), purpose: '관측 AZ·KMS 정지, 로컬 PostgreSQL 장애 조치 대조' },
  { id: '3e', scenarioIds: Object.freeze(['G-28', 'G-32']), purpose: '신원 제공자 정지·AZ 전체 정지, PITR·교차 리전 복원 대조' },
  { id: '3f', scenarioIds: Object.freeze(['G-33', 'G-18']), purpose: '엣지 설정 되돌리기·나쁜 배포 단계 양식, 보고' },
].map(Object.freeze));

const RAW_SCENARIOS = [
  {
    id: 'G-26', order: 1, window: '3d', name: '관측 스택 AZ 하나 장애',
    mode: '대체 장애', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['Mimir', 'Loki', 'Tempo', '관측 Kafka', 'AZ'], runbook: 'RB-09·RB-34',
    expectedAlert: ['관측 저장소 SEV3(Tempo 소비 지연)'],
    expectedAction: ['지표·로그 쓰기는 정족수로 계속, 조회 결과에 빈칸 없음, 추적 쓰기는 관측 Kafka가 받음, 소비 지연 SEV3 해제, 다시 뜬 소비 부품이 밀린 분량을 따라잡음, SLO 경보·자동 제어 입력 영향 없음'],
    recovery: ['소비 지연 SEV3 해제, 조회 빈칸 0'],
    invariant: ['SLO 경보', '자동 제어'],
    steps: TABLETOP_STEPS,
  },
  {
    id: 'G-27', order: 2, window: '3d', name: 'KMS 정지 중 명령 2',
    mode: '대체 장애', runMode: '모의 진행', normEvidence: '측정함', runEvidence: '설계만',
    missing: ['KMS', '도쿄 복제 키'], runbook: 'RB-08',
    expectedAlert: ['감사 체인 mac 빈 행 1분 초과 SEV2, KMS 호출 오류'],
    expectedAction: ['명령이 KMS 없이 커밋·전파(접수 p95 500ms), 재인증은 도쿄 복제 키로, KMS 복구 뒤 체인 따라잡기·1시간 검증 잡 통과'],
    recovery: ['체인 따라잡기, 1시간 검증 잡 통과'],
    invariant: ['접수 p95 500ms', '커밋·전파'],
    steps: TABLETOP_STEPS,
  },
  {
    id: 'G-28', order: 3, window: '3e', name: '신원 제공자 정지 중 명령 2',
    mode: '모의 진행', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['IAM Identity Center', '비상 접근 계정', 'ops-svc 정지'], runbook: 'RB-37·RB-08',
    expectedAlert: ['평소 로그인·긴급 접근 역할 실패, ops-svc 함께 멈춘 실행은 ops-svc 가용성 SEV1·비상 접근 계정 로그인 SEV1'],
    expectedAction: ['콘솔 로그인은 identity-svc 관리 계정이라 영향 없이 명령 2, ops-svc도 함께 멈춘 실행은 RB-08과 RB-37 비상 접근 계정으로 `ops-breakglass` Job 생성·서명, 명령 전파 p99 10초'],
    recovery: ['평소 경로 복귀, 비상 계정 세션·키 교체·봉인, 감사 로그'],
    invariant: ['관리 계정', '명령 전파 p99 10초'],
    steps: TABLETOP_STEPS,
  },
  {
    id: 'G-32', order: 4, window: '3e', name: 'AZ 하나 전체 정지와 영역 빼기',
    mode: '모의 진행', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['NLB', 'zonal shift', 'AZ', 'CloudFront VPC 원본'], runbook: 'RB-13',
    expectedAlert: ['게이트웨이·서비스 준비 파드 급감, 그 AZ 쪽 의존성 원인 SEV2, MSK 브로커 신호'],
    expectedAction: ['프리워밍 1.5배 여유로 남은 두 AZ가 피크를 받음, HPA·Karpenter 회복, MSK는 AZ마다 브로커 2대로 쓰기 지속, 영역 빼기 판단→새 연결 차단 시간 기록, CloudFront VPC 원본이 뺀 AZ로 보내는지 확인'],
    recovery: ['세 AZ 정상 대상, 영역 빼기 만료 전 원상 복구, 게이트웨이 5xx 기준 아래'],
    invariant: ['오버셀 0', '이중 결제 0'],
    steps: TABLETOP_STEPS,
  },
  {
    id: 'G-33', order: 5, window: '3f', name: '엣지 설정 실수 되돌리기',
    mode: '모의 진행', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['CloudFront 지속적 배포', 'NLB 대상 그룹'], runbook: 'RB-40·RB-23',
    expectedAlert: ['① 스테이징 쪽 요청 오류·합성 점검 실패 ② 엣지 502·504 비율이 그 여정의 SLO 오류로 28일 다중 창 경보에 듦(온세일 빠른 경보에는 넣지 않음), 외부 합성 점검 실패'],
    expectedAction: ['① 승격하지 않고 스테이징 배포를 버려 주 배포 유지 ② 되돌리는 커밋으로 대상 그룹 복구, 탐지→복구 시간 기록, 관제 원본 NLB는 따로라 관제 입구는 막히지 않음'],
    recovery: ['주 배포 유지, 대상 그룹 복구, 탐지→복구 시간 기록, 관제 입구 유지'],
    invariant: ['주 배포', '관제 입구'],
    steps: TABLETOP_STEPS,
  },
  {
    id: 'G-18', order: 6, window: '3f', name: '나쁜 배포 되돌리기 단계별 측정',
    mode: '로컬 실행', runMode: '단계 양식', normEvidence: '측정함', runEvidence: '설계만',
    missing: ['Argo Rollouts', '카나리 분석'], runbook: 'RB-23',
    expectedAlert: ['카나리 분석 실패 SEV2(RB-23 링크)'],
    expectedAction: ['분석 두 구간 안에 자동 중단, 안정판 100% 복귀, 되돌리기 결정부터 이전 버전 100%까지 시간 기록(목표 5분 [가정])'],
    recovery: ['안정판 100%, SLO·카나리·오류율 기준 아래, 되돌리기 시간·원인 기록'],
    invariant: ['오류 예산'],
    steps: F0813_G18_STEPS,
  },
];

export const F0813_SCENARIOS = Object.freeze(RAW_SCENARIOS.map((s) => Object.freeze({
  ...s,
  stageReady: false,
  missing: Object.freeze([...s.missing]),
  expectedAlert: Object.freeze([...s.expectedAlert]),
  expectedAction: Object.freeze([...s.expectedAction]),
  recovery: Object.freeze([...s.recovery]),
  invariant: Object.freeze([...s.invariant]),
  steps: Object.freeze([...s.steps]),
})));

const RAW_DRILLS = [
  {
    id: 'R-PG-FAILOVER', window: '3d', name: '로컬 PostgreSQL 장애 조치',
    mode: '대체 장애', runMode: '모의 진행', normEvidence: '측정함', runEvidence: '설계만',
    missing: ['복제본', '승격'], runbook: 'RB-10',
    checks: ['주 서버 종료 뒤 재시도·멱등·Outbox가 이어지는지', '복제본 승격 시간은 문서 인용인지', '관리형 Aurora 장애 조치 시간과 섞지 않았는지'],
  },
  {
    id: 'R-PITR', window: '3e', name: 'PITR 시점 복원',
    mode: '리허설', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['백업', 'WAL 아카이브'], runbook: 'RB-10',
    checks: ['복원 시점', '복원 뒤 파기 감사 로그 재적용', '재적용 건수와 기록 대조, 서비스에 붙이기 전 검증'],
  },
  {
    id: 'R-CROSS-REGION', window: '3e', name: '교차 리전 복원',
    mode: '모의 진행', runMode: '모의 진행', normEvidence: '설계만', runEvidence: '설계만',
    missing: ['도쿄 스택', '교차 리전 백업'], runbook: 'RB-18',
    checks: ['복구 Terraform 계획과 런북 대조', '걸릴 시간 계산', '실제 복원을 측정으로 주장하지 않았는지'],
  },
];

export const F0813_RESTORE_DRILLS = Object.freeze(RAW_DRILLS.map((d) => Object.freeze({
  ...d,
  stageReady: false,
  missing: Object.freeze([...d.missing]),
  checks: Object.freeze([...d.checks]),
})));

export const F0813_OUTSIDE = Object.freeze([
  ...['G-01', 'G-03', 'G-04', 'G-05', 'G-06', 'G-07', 'G-08', 'G-09', 'G-11', 'G-12', 'G-13', 'G-14', 'G-15', 'G-16'].map((id) => Object.freeze({ id, owner: 'F-08-6' })),
  ...['G-02', 'G-10', 'G-17', 'G-19', 'G-20', 'G-21', 'G-22', 'G-23', 'G-24', 'G-25', 'G-29', 'G-30', 'G-31'].map((id) => Object.freeze({ id, owner: 'F-08-12' })),
]);

const SCENARIO_BY_ID = new Map(F0813_SCENARIOS.map((s) => [s.id, s]));
const DRILL_BY_ID = new Map(F0813_RESTORE_DRILLS.map((d) => [d.id, d]));
const WINDOW_BY_ID = new Map(F0813_WINDOWS.map((w) => [w.id, w]));
const RUN_ID_SUFFIX = /-f0813$/;
const CAUSES = Object.freeze(['변경', '외부 의존', '내부 저장소·메시징', '용량·포화', '코드 결함', '데이터', '보안', '운영 조작', '기반']);
const FORBIDDEN = Object.freeze(['30k/s', '30,000건/초', '100만', 'K1', 'K2', 'K7']);
const NEGATIONS = Object.freeze(['주장하지 않', '금지', '범위 밖', '위반', '쓰지 않', '하지 않는다', '바꾸지 않', '닫지 않', '미실행', '미측정']);
const PII_PHONE = /\b01[016789]-?\d{3,4}-?\d{4}\b|\b\d{2,3}-\d{3,4}-\d{4}\b/;
const PII_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PII_PRIVATE_IP = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;

export function scenarioOf(id) {
  return SCENARIO_BY_ID.get(id) ?? null;
}

export function drillOf(id) {
  return DRILL_BY_ID.get(id) ?? null;
}

export function containsPii(text) {
  const value = String(text ?? '');
  return PII_PHONE.test(value) || PII_EMAIL.test(value) || PII_PRIVATE_IP.test(value);
}

function forbiddenClaim(line) {
  const text = String(line ?? '');
  if (!FORBIDDEN.some((token) => text.includes(token))) return false;
  return !NEGATIONS.some((word) => text.includes(word));
}

function result(verdict, reasons = [], details = {}) {
  return { verdict, reasons: reasons.filter(Boolean), ...details };
}

function recordIntegrity(spec, record, stageReady) {
  const reasons = [];
  if (record?.complete !== true) reasons.push('기록이 완주 표시가 아니다');
  if (record?.runMode !== spec.runMode) reasons.push(`이번 연습 방식이 ${spec.runMode}가 아니다`);
  if (!F0813_EVIDENCE.includes(record?.runEvidence)) reasons.push('이번 연습 증거 수준이 모르는 값이다');
  if (record?.runEvidence === '측정함' && record?.measured !== true) reasons.push('측정함을 주장하지만 measured가 아니다');
  if (record?.measured === true && stageReady !== true) reasons.push('무대 없이 측정을 주장한다');
  if (record?.measured !== true && /실측\(PC\)/.test(String(record?.evidenceText ?? ''))) reasons.push('무대 없이 실측(PC)을 주장한다');
  for (const key of ['expectedAlert', 'expectedAction', 'recovery']) {
    const check = record?.checks?.[key];
    if (!check || typeof check.ok !== 'boolean' || typeof check.evidence !== 'string') reasons.push(`기대 대응 ${key} 기록이 없다`);
  }
  return reasons;
}

/**
 * 시나리오 하나의 판정. `stageReady`를 주지 않으면 카탈로그 값(모두 false)을 쓴다.
 * `통과`는 전체 무대·측정·실행 ID(-f0813)·runExists·manifest·timeline·기대 대응 증거가 모두 있을 때만이다.
 */
export function judgeRecoveryScenario(input = {}) {
  const id = input.scenario;
  const spec = scenarioOf(id);
  if (!spec) return result('판정 못 함', [`모르는 시나리오: ${id ?? '(없음)'}`], { missing: [], measured: false });
  const record = input.record ?? null;
  if (!record) return result('미측정', ['기록이 없다'], { missing: [...spec.missing], measured: false });
  const stageReady = input.stageReady ?? spec.stageReady;
  const integrity = recordIntegrity(spec, record, stageReady);
  if (integrity.length) return result('무효', integrity, { missing: [...spec.missing], measured: record.measured === true });
  if (stageReady !== true) return result('판정 못 함', [`무대가 없다: ${spec.missing.join(', ')}`], { missing: [...spec.missing], measured: record.measured === true });
  if (record.measured !== true) return result('판정 못 함', ['측정 기록이 아니다'], { missing: [], measured: false });
  if (typeof record.runId !== 'string' || !RUN_ID_SUFFIX.test(record.runId)) return result('판정 못 함', ['실행 ID가 -f0813으로 끝나지 않는다'], { missing: [], measured: true });
  if (record.runExists !== true) return result('판정 못 함', ['실행 ID가 장부 폴더에 없다'], { missing: [], measured: true });
  if (record.manifest !== true) return result('판정 못 함', ['manifest.json이 없다'], { missing: [], measured: true });
  if (record.timeline !== true) return result('판정 못 함', ['timeline.csv가 없다'], { missing: [], measured: true });
  for (const key of ['expectedAlert', 'expectedAction', 'recovery']) {
    if (!record.checks[key].evidence.trim()) return result('판정 못 함', [`기대 대응 ${key} 증거가 비었다`], { missing: [], measured: true });
  }
  if (['expectedAlert', 'expectedAction', 'recovery'].some((key) => record.checks[key].ok !== true)) {
    return result('미달', ['측정된 기대 대응이 실패했다'], { missing: [], measured: true });
  }
  return result('통과', [], { missing: [], measured: true });
}

function stepTimeMap(steps) {
  const map = new Map();
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step && typeof step.id === 'string') map.set(step.id, step.at);
  }
  return map;
}

/**
 * G-18 단계 판정. 필수는 T0·T1p·T2·T3·T4이고 T1(Alertmanager)은 null일 수 있다.
 * T1이 T1p보다 이르면 `미달`, 필수 단계가 없거나 필수 순서가 뒤집히면 `무효`다.
 */
export function judgeG18Steps(input = {}) {
  const steps = stepTimeMap(input.steps);
  const missingSteps = ['T0', 'T1p', 'T2', 'T3', 'T4'].filter((id) => !steps.has(id));
  if (missingSteps.length) return result('무효', [`단계가 없다: ${missingSteps.join(', ')}`], { rollbackSec: null, withinTarget: null, missingSteps });
  const times = {};
  for (const id of F0813_G18_STEPS) {
    if (!steps.has(id)) continue;
    const at = Date.parse(steps.get(id));
    if (!Number.isFinite(at)) return result('무효', [`${id} 시각을 읽지 못했다`], { rollbackSec: null, withinTarget: null, missingSteps: [id] });
    times[id] = at;
  }
  if (times.T0 > times.T1p) return result('무효', ['T0가 T1p보다 늦다'], { rollbackSec: null, withinTarget: null, missingSteps: [] });
  if (times.T1p > times.T2) return result('무효', ['T1p가 T2보다 늦다'], { rollbackSec: null, withinTarget: null, missingSteps: [] });
  if (times.T2 > times.T3) return result('무효', ['T2가 T3보다 늦다'], { rollbackSec: null, withinTarget: null, missingSteps: [] });
  if (times.T3 > times.T4) return result('무효', ['T3가 T4보다 늦다'], { rollbackSec: null, withinTarget: null, missingSteps: [] });
  if (times.T1 !== undefined && times.T1 < times.T1p) return result('미달', ['T1이 T1p보다 이르다'], { rollbackSec: null, withinTarget: null, missingSteps: [] });
  if (times.T1 !== undefined && times.T1 > times.T2) return result('미달', ['T1이 T2보다 늦다'], { rollbackSec: null, withinTarget: null, missingSteps: [] });
  const rollbackSec = (times.T4 - times.T2) / 1000;
  const withinTarget = rollbackSec <= F0813_DEFAULTS.rollbackTargetSec;
  if (input.stageReady !== true) return result('판정 못 함', ['무대가 없다'], { rollbackSec, withinTarget, missingSteps: [] });
  if (input.measured !== true) return result('판정 못 함', ['측정 기록이 아니다'], { rollbackSec, withinTarget, missingSteps: [] });
  if (typeof input.runId !== 'string' || !RUN_ID_SUFFIX.test(input.runId)) return result('판정 못 함', ['실행 ID가 -f0813으로 끝나지 않는다'], { rollbackSec, withinTarget, missingSteps: [] });
  if (input.runExists !== true) return result('판정 못 함', ['실행 ID가 장부 폴더에 없다'], { rollbackSec, withinTarget, missingSteps: [] });
  if (input.manifest !== true) return result('판정 못 함', ['manifest.json이 없다'], { rollbackSec, withinTarget, missingSteps: [] });
  if (input.timeline !== true) return result('판정 못 함', ['timeline.csv가 없다'], { rollbackSec, withinTarget, missingSteps: [] });
  if (!withinTarget) return result('미달', [`되돌리기 ${rollbackSec}초가 목표 300초를 넘었다`], { rollbackSec, withinTarget, missingSteps: [] });
  return result('통과', [], { rollbackSec, withinTarget, missingSteps: [] });
}

export function judgeRecoveryGroup(windowId, results = []) {
  const window = WINDOW_BY_ID.get(windowId);
  if (!window) return result('판정 못 함', [`모르는 창: ${windowId}`]);
  const byId = new Map((Array.isArray(results) ? results : [])
    .filter((r) => r && (typeof r.id === 'string' || typeof r.scenario === 'string'))
    .map((r) => [r.id ?? r.scenario, r]));
  const missing = window.scenarioIds.filter((id) => !byId.has(id));
  if (missing.length) return result('판정 못 함', [`묶음 결과가 모자라다: ${missing.join(', ')}`]);
  const verdicts = window.scenarioIds.map((id) => byId.get(id).verdict);
  if (verdicts.some((v) => !F0813_VERDICTS.includes(v))) return result('판정 못 함', ['모르는 판정값이 있다']);
  if (verdicts.some((v) => v === '무효' || v === '판정 못 함' || v === '미측정')) return result('판정 못 함', ['무효·판정 못 함·미측정 결과가 있다']);
  if (verdicts.some((v) => v === '미달')) return result('미달', ['미달 결과가 있다']);
  return result('통과', []);
}

/** @param {string[]} argv */
export function parseRecoveryArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const out = {
    window: null,
    scenario: null,
    drill: null,
    tabletop: false,
    steps: false,
    record: false,
    runId: null,
    out: null,
    judge: null,
  };
  const take = (i, flag) => {
    const value = args[i + 1];
    if (typeof value !== 'string' || value.startsWith('--')) throw new UsageError(`${flag}에는 값이 필요하다`);
    return value;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--window') { out.window = take(i, arg); i += 1; continue; }
    if (arg === '--scenario') { out.scenario = take(i, arg); i += 1; continue; }
    if (arg === '--drill') { out.drill = take(i, arg); i += 1; continue; }
    if (arg === '--tabletop') { out.tabletop = true; continue; }
    if (arg === '--steps') { out.steps = true; continue; }
    if (arg === '--record') { out.record = true; continue; }
    if (arg === '--run-id') { out.runId = take(i, arg); i += 1; continue; }
    if (arg === '--out') { out.out = take(i, arg); i += 1; continue; }
    if (arg === '--judge') { out.judge = take(i, arg); i += 1; continue; }
    if (['--docker-all', '--browser', '--inject', '--k6', '--leak', '--chaos', '--docker'].includes(arg)) {
      throw new UsageError(`${arg}는 이 기능에서 허용하지 않는다`);
    }
    throw new UsageError(`모르는 인자: ${arg}`);
  }
  if (!out.window) throw new UsageError('--window가 필요하다(3d|3e|3f)');
  const window = WINDOW_BY_ID.get(out.window);
  if (!window) throw new UsageError(`모르는 창: ${out.window}`);
  if (out.scenario && out.drill) throw new UsageError('--scenario와 --drill은 함께 쓸 수 없다');
  if (out.scenario) {
    if (!window.scenarioIds.includes(out.scenario)) throw new UsageError(`창 ${out.window}에 없는 시나리오: ${out.scenario}`);
    if (out.scenario === 'G-18') {
      if (!out.steps) throw new UsageError('G-18은 --steps를 쓴다');
      if (out.tabletop) throw new UsageError('G-18은 --tabletop을 쓸 수 없다');
    } else {
      if (!out.tabletop) throw new UsageError(`${out.scenario}는 --tabletop을 쓴다`);
      if (out.steps) throw new UsageError(`${out.scenario}는 --steps를 쓸 수 없다`);
    }
  }
  if (out.drill) {
    const drill = drillOf(out.drill);
    if (!drill) throw new UsageError(`모르는 복원 연습: ${out.drill}`);
    if (drill.window !== out.window) throw new UsageError(`창 ${out.window}에 없는 복원 연습: ${out.drill}`);
    if (!out.tabletop) throw new UsageError('복원 연습은 --tabletop을 쓴다');
    if (out.steps) throw new UsageError('복원 연습은 --steps를 쓸 수 없다');
  }
  if (out.tabletop && out.steps) throw new UsageError('--tabletop과 --steps는 함께 쓸 수 없다');
  if (out.record && !out.runId) throw new UsageError('--record에는 --run-id가 필요하다');
  if (out.runId !== null) {
    if (!out.record) throw new UsageError('--run-id는 --record와 함께 쓴다');
    if (!RUN_ID_SUFFIX.test(out.runId)) throw new UsageError('--run-id는 -f0813으로 끝나야 한다');
  }
  return out;
}

const PRIOR_LINES = Object.freeze([
  `- F-08-5: ${F0813_PRIOR_MEASUREMENTS['F-08-5']}`,
  `- F-08-9: ${F0813_PRIOR_MEASUREMENTS['F-08-9']}`,
  `- F-08-10: ${F0813_PRIOR_MEASUREMENTS['F-08-10']}`,
  `- F-08-12: ${F0813_PRIOR_MEASUREMENTS['F-08-12']}`,
]);

/** 미측정 보고서 뼈대. results를 주면 그 판정을 싣는다. */
export function renderRecoveryReport(input = {}) {
  const results = new Map((Array.isArray(input.results) ? input.results : [])
    .filter((r) => r && (typeof r.id === 'string' || typeof r.scenario === 'string'))
    .map((r) => [r.id ?? r.scenario, r]));
  const rows = F0813_SCENARIOS.map((s) => {
    const r = results.get(s.id);
    const verdict = r?.verdict ?? '미측정';
    const why = r?.reasons?.[0] ?? '무대 없음';
    return `| ${s.id} | ${s.window} | ${s.mode} | ${s.normEvidence} | ${s.runMode} | ${s.runEvidence} | — | ${verdict} | ${why} |`;
  }).join('\n');
  const drillRows = F0813_RESTORE_DRILLS.map((d) => {
    const r = results.get(d.id);
    const verdict = r?.verdict ?? '미측정';
    const why = r?.reasons?.[0] ?? '무대 없음';
    return `| ${d.id} | ${d.window} | ${d.mode} | ${d.normEvidence} | ${d.runMode} | ${d.runEvidence} | ${verdict} | ${why} |`;
  }).join('\n');
  const stepRows = F0813_G18_STEPS.map((step) => `| ${step} | — | — | — |`).join('\n');
  return [
    '# F-08-13 Game Day 모의 진행·복원 연습 보고서',
    '',
    '- **상태**: 미실행. 6종과 복원 3종은 측정 창 3d~3f에서 모의 진행한다. 아래 판정은 모두 `미측정`이다.',
    '- **정본**: `docs/observability.md` §12, `docs/verification.md` §5.2·§5.3, `docs/perf-ledger.md` §8.',
    '- **계획**: `docs/review/plans/F-08-13.md` §6~§10.',
    '',
    '## 1. Game Day 실행 표',
    '',
    '| 시나리오 | 창 | 정본 방식 | 정본 증거 | 이번 연습 방식 | 이번 연습 증거 | 주입 | 판정 | 까닭 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    '## 2. 복원 연습 표',
    '',
    '| 연습 | 창 | 정본 방식 | 정본 증거 | 이번 연습 방식 | 이번 연습 증거 | 판정 | 까닭 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    drillRows,
    '',
    '## 3. G-18 되돌리기 단계 표',
    '',
    '| 단계 | 시각 | 걸린 시간 | 증거 |',
    '| --- | --- | --- | --- |',
    stepRows,
    '',
    '## 4. 인시던트와 포스트모템',
    '',
    '| 인시던트 | 시나리오 | 선언 시각 | 끝 시각 | 완료 시각 | 예산 비율 | P0 | 포스트모템 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '',
    '## 5. 선행 측정 인용',
    '',
    ...PRIOR_LINES,
    '',
    '## 6. 한계',
    '',
    '- Mimir·Loki·Tempo·관측 Kafka·KMS·IAM Identity Center·CloudFront·NLB·Argo Rollouts·PostgreSQL 복제본·WAL 아카이브·도쿄 스택이 없다.',
    '- 이 무대에서 통과할 수 있는 시나리오는 0이다. 모의 진행·설계만은 판정 못 함이다.',
    '',
    '## 7. 장부·게이트',
    '',
    '- `node tools/ci/ledger.mjs --batch F-08-13 --require`: 항목 0.',
    '- f0813 18, f0812 16, f086 8, f0811 10, lint 0, doc-check 오류 0·경고 12, release-scope 33/5/67.',
    '',
    '## 8. 주장하지 않는 것',
    '',
    '- 30,000건/초·100만·K1/K2/K7 0을 주장하지 않는다.',
    '- F-08-5의 무효·미측정, F-08-9의 판정 못 함(무효·부분), F-08-10의 미측정, F-08-12의 미측정을 통과로 바꾸지 않는다.',
  ].join('\n');
}

function tableCells(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

function isSeparator(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function fieldMap(markdown) {
  const map = new Map();
  for (const line of String(markdown ?? '').split('\n')) {
    const m = /^- \*\*(.+?)\*\*:\s?(.*)$/.exec(line);
    if (m) map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

function requiredFields(map, fields) {
  return fields.filter((field) => !map.get(field));
}

/** 보고서 검증. 한 행의 실패 이유를 모두 모아 reasons에 남긴다. */
export function validateRecoveryReport(markdown, options = {}) {
  const text = String(markdown ?? '');
  const lines = text.split('\n');
  const reasons = [];
  let passed = 0;
  const seen = new Set();
  for (const line of lines) {
    const scenario = /^\| (G-\d\d) \|/.exec(line);
    if (scenario) {
      const cells = tableCells(line);
      const spec = scenarioOf(scenario[1]);
      seen.add(scenario[1]);
      if (!spec) { reasons.push(`모르는 시나리오 행: ${scenario[1]}`); continue; }
      const verdict = cells[7] ?? '';
      if (verdict === '통과') {
        passed += 1;
        if (!options.measured) reasons.push(`${scenario[1]}: 측정하지 않은 실행을 통과로 적었다`);
        if (!spec.stageReady) reasons.push(`${scenario[1]}: 무대가 없는데 통과로 적었다`);
        if (cells[5] !== '측정함') reasons.push(`${scenario[1]}: 이번 연습 증거가 측정함이 아니다`);
        const runId = cells[8] ?? '';
        if (!RUN_ID_SUFFIX.test(runId)) reasons.push(`${scenario[1]}: 실행 ID가 -f0813으로 끝나지 않는다`);
        if (typeof options.runExists !== 'function' || !options.runExists(runId)) reasons.push(`${scenario[1]}: 실행 ID가 장부 폴더에 없다`);
        if (typeof options.runResponseOk !== 'function' || !options.runResponseOk(runId)) reasons.push(`${scenario[1]}: 기대 대응 증거가 없다`);
      } else if (!F0813_VERDICTS.includes(verdict)) {
        reasons.push(`${scenario[1]}: 모르는 판정값 ${verdict || '(빈칸)'}`);
      }
      continue;
    }
    const drill = /^\| (R-[A-Z-]+) \|/.exec(line);
    if (drill) {
      const cells = tableCells(line);
      const spec = drillOf(drill[1]);
      seen.add(drill[1]);
      if (!spec) { reasons.push(`모르는 복원 연습 행: ${drill[1]}`); continue; }
      const verdict = cells[6] ?? '';
      if (verdict === '통과') {
        passed += 1;
        if (!options.measured) reasons.push(`${drill[1]}: 측정하지 않은 실행을 통과로 적었다`);
        if (!spec.stageReady) reasons.push(`${drill[1]}: 무대가 없는데 통과로 적었다`);
        if (cells[5] !== '측정함') reasons.push(`${drill[1]}: 이번 연습 증거가 측정함이 아니다`);
      } else if (!F0813_VERDICTS.includes(verdict)) {
        reasons.push(`${drill[1]}: 모르는 판정값 ${verdict || '(빈칸)'}`);
      }
    }
  }
  for (const spec of F0813_SCENARIOS) if (!seen.has(spec.id)) reasons.push(`${spec.id} 행이 없다`);
  for (const spec of F0813_RESTORE_DRILLS) if (!seen.has(spec.id)) reasons.push(`${spec.id} 행이 없다`);

  for (const line of PRIOR_LINES) if (!lines.includes(line)) reasons.push(`선행 인용이 없다: ${line}`);
  if (lines.some((line) => /F-08-12:\s*(통과|판정 못 함)/.test(line))) reasons.push('F-08-12에 없는 판정을 인용한다');

  const incidentHeader = lines.findIndex((line) => line.startsWith('| 인시던트 | 시나리오 |'));
  if (incidentHeader < 0) {
    reasons.push('인시던트 표 머리가 없다');
  } else {
    for (let i = incidentHeader + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.startsWith('|')) break;
      const cells = tableCells(line);
      if (!cells.length || isSeparator(cells)) continue;
      const id = cells[0];
      if (!id || id === '인시던트') continue;
      if (typeof options.postmortemExists !== 'function' || !options.postmortemExists(id)) reasons.push(`인시던트 ${id}: 포스트모템 파일이 없다`);
      else if (typeof options.postmortemOk !== 'function' || !options.postmortemOk(id)) reasons.push(`인시던트 ${id}: 포스트모템 내용이 틀렸다`);
    }
  }

  const stepIds = lines
    .map((line) => /^\| (T0|T1p|T1|T2|T3|T4) \|/.exec(line)?.[1])
    .filter(Boolean);
  if (JSON.stringify(stepIds) !== JSON.stringify(F0813_G18_STEPS)) reasons.push(`G-18 단계 표가 ${F0813_G18_STEPS.join('·')} 순서가 아니다`);

  for (const line of lines) if (forbiddenClaim(line)) reasons.push(`금지 수치를 주장한다: ${line}`);
  if (containsPii(text)) reasons.push('개인 식별자·연락처·내부 주소가 있다');
  if (text.includes('docs/perf-ledger/runs/') && !options.measured) reasons.push('측정하지 않았는데 장부 실행 폴더를 가리킨다');
  return { ok: reasons.length === 0, reasons, passed };
}

/** RB-17 포스트모템 검증. 48.0시간은 통과, +1ms는 미달. 20.0%는 P0 없이 통과, 20.1%는 P0가 필요하다. */
export function validateRecoveryPostmortem(markdown) {
  const text = String(markdown ?? '');
  const map = fieldMap(text);
  const reasons = [];
  const fields = ['선언 시각', '끝 시각', '완료 시각', '첫 증상 시각', '첫 경보 시각', '사람이 안 시각', '탐지 경로', '주 원인 유형', '구성 요소', '기여 원인 유형', '계기', '영향', '예산 사용 비율', '쓴 손잡이', '후속 조치', 'P0'];
  for (const field of requiredFields(map, fields)) reasons.push(`필수 칸이 없다: ${field}`);
  const end = Date.parse(map.get('끝 시각') ?? '');
  const done = Date.parse(map.get('완료 시각') ?? '');
  if (!Number.isFinite(end) || !Number.isFinite(done)) {
    reasons.push('끝·완료 시각을 읽지 못했다');
  } else if (done - end > F0813_DEFAULTS.postmortemDueHours * 3600 * 1000) {
    reasons.push('포스트모템이 48시간을 넘었다');
  }
  if (!['경보', '사람', '외부'].includes(map.get('탐지 경로'))) reasons.push('탐지 경로가 경보·사람·외부가 아니다');
  if (!CAUSES.includes(map.get('주 원인 유형'))) reasons.push('주 원인 유형이 9가지 밖이다');
  if (!map.get('구성 요소')) reasons.push('구성 요소가 비었다');
  if (!/#\d+|https?:\/\//.test(map.get('후속 조치') ?? '')) reasons.push('후속 조치에 이슈 번호나 URL이 없다');
  const budgetText = map.get('예산 사용 비율') ?? '';
  const budget = Number.parseFloat(budgetText.replace('%', ''));
  if (!Number.isFinite(budget)) {
    reasons.push('예산 사용 비율을 읽지 못했다');
  } else if (budget > F0813_DEFAULTS.p0BudgetRatio * 100) {
    const p0 = map.get('P0') ?? '';
    if (!p0 || ['—', '-', '없음', 'N/A'].includes(p0)) reasons.push('20%를 넘었는데 P0가 없다');
  }
  if (containsPii(text)) reasons.push('개인 식별자·연락처·내부 주소가 있다');
  for (const line of text.split('\n')) if (forbiddenClaim(line)) reasons.push(`금지 수치를 주장한다: ${line}`);
  return { ok: reasons.length === 0, reasons };
}

/** 모의 진행 기록 검증. IC·OL·CL·SO 세션이 서로 달라야 한다. */
export function validateTabletopRecord(markdown) {
  const text = String(markdown ?? '');
  const map = fieldMap(text);
  const reasons = [];
  const fields = ['시나리오', '창', '역할', '연습 시각', '정본 방식·증거', '이번 연습 방식', '이번 연습 증거', '주입 의도(실제 주입 아님)', '기대 경보', '기대 대응', '복원 확인', '런북', '판정', '증거', '후속 조치'];
  for (const field of requiredFields(map, fields)) reasons.push(`필수 칸이 없다: ${field}`);
  const scenario = map.get('시나리오');
  const spec = scenarioOf(scenario ?? '');
  if (!spec) reasons.push(`모르는 시나리오: ${scenario ?? '(빈칸)'}`);
  if (spec) {
    if (map.get('창') !== spec.window) reasons.push(`창이 ${spec.window}가 아니다`);
    if (map.get('이번 연습 방식') !== spec.runMode) reasons.push(`이번 연습 방식이 ${spec.runMode}가 아니다`);
    const norm = map.get('정본 방식·증거') ?? '';
    if (!norm.includes(spec.mode) || !norm.includes(spec.normEvidence)) reasons.push('정본 방식·증거가 카탈로그와 다르다');
  }
  if (map.get('이번 연습 증거') !== '설계만') reasons.push('이번 연습 증거가 설계만이 아니다');
  if (map.get('판정') !== '판정 못 함') reasons.push('모의 진행 판정이 판정 못 함이 아니다');
  const roles = {};
  for (const m of String(map.get('역할') ?? '').matchAll(/\b(IC|OL|CL|SO)\s+([^,\s]+)/g)) roles[m[1]] = m[2];
  for (const role of ['IC', 'OL', 'CL', 'SO']) if (!roles[role]) reasons.push(`역할 ${role}이 없다`);
  const ids = ['IC', 'OL', 'CL', 'SO'].map((role) => roles[role]).filter(Boolean);
  if (new Set(ids).size !== ids.length) reasons.push('IC·OL·CL·SO가 같은 세션을 겸한다');
  if (containsPii(text)) reasons.push('개인 식별자·연락처·내부 주소가 있다');
  for (const line of text.split('\n')) if (forbiddenClaim(line)) reasons.push(`금지 수치를 주장한다: ${line}`);
  return { ok: reasons.length === 0, reasons };
}

export function validateRecoveryPlan(plan) {
  const reasons = [];
  if (plan?.batch !== 'F-08-13') reasons.push('batch가 F-08-13이 아니다');
  if (typeof plan?.feature !== 'string' || !plan.feature.trim()) reasons.push('feature가 비었다');
  if (!Array.isArray(plan?.windows) || plan.windows.map((w) => w.id).join('·') !== '3d·3e·3f') reasons.push('창이 3d·3e·3f가 아니다');
  if (!Array.isArray(plan?.scenarios) || plan.scenarios.length !== 6) reasons.push('시나리오가 6종이 아니다');
  if (!Array.isArray(plan?.drills) || plan.drills.length !== 3) reasons.push('복원 연습이 3종이 아니다');
  if (plan?.lock?.take !== F0813_LOCK.take || plan?.lock?.drop !== F0813_LOCK.drop || plan?.lock?.dockerAll !== false) reasons.push('잠금 계약이 다르다');
  if (!Array.isArray(plan?.stopRules) || plan.stopRules.length !== 10) reasons.push('중단 규칙이 10개가 아니다');
  const prior = JSON.stringify(plan?.priorMeasurements ?? '');
  for (const token of ['F-08-5', '무효·미측정', 'F-08-9', '판정 못 함(무효·부분)', 'F-08-10', '미측정', 'F-08-12', '미측정']) {
    if (!prior.includes(token)) reasons.push(`선행 인용에 ${token}이 없다`);
  }
  const notIncluded = (plan?.notIncluded ?? []).join(' ');
  for (const token of ['K8', 'K9', 'V-T18', 'V-T27', 'V-T28', 'NFR-027', 'K1', 'K2', 'K7', 'Q-T2', 'S-T1', 'P-T1', 'V-T4', 'V-T5', 'V-T17']) {
    if (!notIncluded.includes(token)) reasons.push(`notIncluded에 ${token}이 없다`);
  }
  if (!Array.isArray(plan?.boundaries)) {
    reasons.push('경계가 배열이 아니다');
  } else {
    for (const b of plan.boundaries) if (!b.feature || !b.owns || !b.doesNot) reasons.push('경계에 feature·owns·doesNot이 비었다');
  }
  return { ok: reasons.length === 0, reasons };
}
