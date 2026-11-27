// F-08-12 Game Day 로컬 ①·② 카탈로그·판정·보고서 도구.
//
// 정본: docs/observability.md §12, docs/verification.md §5.2,
//       docs/perf-ledger.md §8(T0~T4), docs/runbooks/incident-criteria.md,
//       docs/planning/03-policies-glossary.md §4(원인 유형 9).
// 계획: docs/review/plans/F-08-12.md §6~§8.
// 이 파일은 Docker·kind·k6·브라우저를 쓰지 않는다. 14종 실제 실행은 측정 창 몫이고 지금은 미실행이다.
import { UsageError } from './args.mjs';

export const F0812_MODES = Object.freeze(['로컬 실행', '대체 장애', '모의 진행']);
export const F0812_EVIDENCE = Object.freeze(['측정함', '설계만']);
export const F0812_VERDICTS = Object.freeze(['통과', '미달', '판정 못 함', '무효', '미측정']);
export const F0812_ARTIFACTS = Object.freeze([
  'timeline.csv',
  'manifest.json',
  'alerts.ndjson',
  'faults.ndjson',
  'invariants.csv',
  'host.json',
  'run.json',
  'generator.json',
]);

export const F0812_DEFAULTS = Object.freeze({
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
});

export const F0812_LOCK = Object.freeze({
  take: 'docker lane4-F-08-12',
  drop: 'docker lane4-F-08-12',
  dockerAll: false,
});

export const F0812_STOP_RULES = Object.freeze([
  { id: 'STOP-01', rule: '무대가 준비되지 않았다(부품·주소·ALERTS·기록 경로)' },
  { id: 'STOP-02', rule: 'Docker 잠금이 없거나 docker-all을 썼다' },
  { id: 'STOP-03', rule: '호스트가 포화됐다(CPU 85% 이상, procs_running > 논리 프로세서)' },
  { id: 'STOP-04', rule: '장애 주입 적용 증거가 없다(빈 PID·신호 실패·정책 미적용)' },
  { id: 'STOP-05', rule: '불변식 위반이 1건 이상 나왔다(오버셀·이중 결제·차례 전 입장)' },
  { id: 'STOP-06', rule: '이전 시나리오의 롤백에 실패했다' },
  { id: 'STOP-07', rule: '디스크가 15GB 미만이거나 메모리 압박이 있다' },
  { id: 'STOP-08', rule: 'ALERTS·기록 파이프라인이 끊겼다' },
  { id: 'STOP-09', rule: '같은 시나리오가 두 번 연속 무효다' },
  { id: 'STOP-10', rule: '감독이 중단을 지시했거나 실제 외부 피해·개인정보 노출이 의심된다' },
]);

export const F0812_PRIOR_MEASUREMENTS = Object.freeze({
  'F-08-5': '무효·미측정',
  'F-08-9': '판정 못 함(무효·부분)',
  'F-08-10': '미측정',
});

export const F0812_POSTMORTEM = Object.freeze({
  causeTypes: Object.freeze(['변경', '외부 의존', '내부 저장소·메시징', '용량·포화', '코드 결함', '데이터', '보안', '운영 조작', '기반']),
  dueHours: 48,
  p0BudgetRatio: 0.2,
});

const GROUP_A = ['G-02', 'G-10', 'G-29', 'G-30', 'G-31'];
const GROUP_B = ['G-17', 'G-18', 'G-19', 'G-20', 'G-21', 'G-22', 'G-23', 'G-24', 'G-25'];

export const F0812_GROUPS = Object.freeze([
  { id: 'A', name: '저장소·메시징', scenarioIds: Object.freeze(GROUP_A) },
  { id: 'B', name: '보안·변경·자동·대응', scenarioIds: Object.freeze(GROUP_B) },
]);

export const F0812_WINDOWS = Object.freeze([
  { id: '3a', scenarioIds: Object.freeze(GROUP_A), purpose: '무대·기준선·① 저장소·메시징 5종' },
  { id: '3b', scenarioIds: Object.freeze(['G-17', 'G-18', 'G-19', 'G-20', 'G-21']), purpose: '② 앞 5종' },
  { id: '3c', scenarioIds: Object.freeze(['G-22', 'G-23', 'G-24', 'G-25']), purpose: '② 뒤 4종·보고' },
]);

export const F0812_OUTSIDE = Object.freeze([
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
]);

const RAW_SCENARIOS = [
  {
    id: 'G-02', order: 1, group: 'A', window: '3a', name: '좌석 Redis 주 노드 페일오버',
    mode: '대체 장애', evidence: '측정함', stageReady: false,
    missing: ['좌석 Redis 복제본', '승격'],
    partialParts: ['좌석 Valkey 전체 정지', '503 관측', '오버셀 0 확인'],
    runbook: 'RB-06', runbookNote: '',
    fault: '좌석 Valkey 전체 정지(승격 없음)',
    expectedAlert: '좌석 홀드 503(`seat-store-unavailable`, `seat_store_unavailable`) 급증',
    expectedAction: '503으로 미루고 동시 진입 목표를 줄인다',
    invariant: '오버셀 0·이중 홀드 0',
    load: true, commandExpected: false,
  },
  {
    id: 'G-10', order: 2, group: 'A', window: '3a', name: 'Kafka 브로커 1대 오프라인',
    mode: '대체 장애', evidence: '측정함', stageReady: false,
    missing: ['1브로커·RF 3 없음'], partialParts: [],
    runbook: 'RB-11', runbookNote: '',
    fault: 'Kafka 브로커 1대 오프라인(무대 없음)',
    expectedAlert: '브로커 오프라인·소비 지연',
    expectedAction: '거래가 멈추지 않고 Outbox가 회복한다',
    invariant: '결제·주문 유실 0',
    load: true, commandExpected: false,
  },
  {
    id: 'G-29', order: 3, group: 'A', window: '3a', name: '세션·캐시 Redis 장애 조치·메모리 가득',
    mode: '대체 장애', evidence: '측정함', stageReady: false,
    missing: ['세션·캐시 Redis 복제본', '승격'],
    partialParts: ['Valkey 메모리 90%', '85% 경보'],
    runbook: 'RB-05', runbookNote: '세션·캐시 Redis 전용 런북이 없다. RB-05(대기열 Redis 페일오버)와 RB-17(포스트모템)을 가리킨다.',
    fault: 'Valkey 메모리 90% 채우기',
    expectedAlert: 'Redis 메모리 85% SEV2',
    expectedAction: '원본 읽기로 넘어가고 알림 작업 유실 0',
    invariant: '알림 유실 0·축출 0',
    load: true, commandExpected: false,
  },
  {
    id: 'G-30', order: 4, group: 'A', window: '3a', name: 'Schema Registry 장애',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['Schema Registry(레지스트리) 없음'], partialParts: [],
    runbook: 'RB-34', runbookNote: 'Schema Registry 전용 런북이 없다. RB-34(스트림 작업자 복구)를 가리킨다.',
    fault: '레지스트리 정지(무대 없음)',
    expectedAlert: '레지스트리 가용성 상실·생산자 시작 실패',
    expectedAction: '고정 스키마 ID로 주문, 작업자는 기다린다',
    invariant: '주문 실패 0',
    load: false, commandExpected: false,
  },
  {
    id: 'G-31', order: 5, group: 'A', window: '3a', name: '거래·제어 MSK 전체 정지 5분',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['경보 규칙 없음'], partialParts: ['Kafka 전체 정지·Outbox 따라잡기', '당기기 반영'],
    runbook: 'RB-11·RB-39', runbookNote: '',
    fault: 'Kafka 전체 정지 5분(경보 규칙 없음, 부분)',
    expectedAlert: 'OfflinePartitionsCount SEV1·Outbox 밀림 SEV2',
    expectedAction: '결제 당기기·명령 6 ack·Outbox 따라잡기',
    invariant: '60초 불변식 SEV1 0·이중 반영 0',
    load: true, commandExpected: true,
  },
  {
    id: 'G-17', order: 6, group: 'B', window: '3b', name: '보안 사고 모의훈련',
    mode: '모의 진행', evidence: '설계만', stageReady: true,
    missing: [], partialParts: [],
    runbook: 'RB-20·RB-17', runbookNote: '',
    fault: '탁상(유출 의심·DDoS)',
    expectedAlert: '보안 사고 SEV1·기한 임박 SEV2',
    expectedAction: '24·2·72시간 할 일과 기한',
    invariant: '실제 신고·개인정보 사용 0',
    load: false, commandExpected: false,
  },
  {
    id: 'G-18', order: 7, group: 'B', window: '3b', name: '나쁜 배포(카나리)',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['Argo Rollouts 없음'], partialParts: [],
    runbook: 'RB-23', runbookNote: '',
    fault: '나쁜 배포(무대 없음)',
    expectedAlert: '카나리 분석 실패 SEV2',
    expectedAction: '자동 중단·안정판 100% 복귀',
    invariant: '오류 예산 초과 없음',
    load: false, commandExpected: false,
  },
  {
    id: 'G-19', order: 8, group: 'B', window: '3b', name: '변경 동결 창 위반·달력 장애',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['Argo CD·동결 달력 없음'], partialParts: [],
    runbook: 'RB-28', runbookNote: '',
    fault: '동결 창 위반(무대 없음)',
    expectedAlert: '달력 신선도 SEV2',
    expectedAction: '승격 게이트가 막고 T-30 점검 통과',
    invariant: '동결 창 유지',
    load: false, commandExpected: false,
  },
  {
    id: 'G-20', order: 9, group: 'B', window: '3b', name: 'Kyverno 장애 중 확장',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['투명성 로그 접근 차단 없음'], partialParts: ['Kyverno 파드 제거', '60초 복구'],
    runbook: 'RB-27', runbookNote: '',
    fault: 'Kyverno 파드 1개 제거(부분)',
    expectedAlert: '이미지 검증 오류 경보',
    expectedAction: '새 파드 60초 안 기동',
    invariant: '서명·다이제스트 검증 유지',
    load: true, commandExpected: false,
  },
  {
    id: 'G-21', order: 10, group: 'B', window: '3b', name: '제어 입력 끊김·낡음',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['경보 규칙 없음', '콘솔 경보'], partialParts: [],
    runbook: 'RB-09', runbookNote: '',
    fault: '스크레이프 대상 차단(경보 규칙 없음)',
    expectedAlert: "콘솔 SEV2 '입력 없음' 30초",
    expectedAction: '입력 없음 30초 판정·AIMD 증감 0',
    invariant: '예산 자동 감축 0',
    load: true, commandExpected: false,
  },
  {
    id: 'G-22', order: 11, group: 'B', window: '3c', name: 'KEDA·AIMD 상호작용',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['KEDA 없음'], partialParts: [],
    runbook: 'RB-30', runbookNote: '',
    fault: 'KEDA 확장 중 p99 상승(무대 없음)',
    expectedAlert: 'AIMD 감축 기록',
    expectedAction: 'RB-30으로 5분 안 고정',
    invariant: '추가 감축 0',
    load: true, commandExpected: false,
  },
  {
    id: 'G-23', order: 12, group: 'B', window: '3c', name: '공유 의존성 장애·프로브',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['경보 규칙 없음'], partialParts: ['좌석 Valkey 정지', '503 관측', '오버셀 0 확인'],
    runbook: 'RB-06·RB-32', runbookNote: '',
    fault: '좌석 Valkey 정지·DB 연결 끊기(경보 규칙 없음, 부분)',
    expectedAlert: 'seat-store-unavailable·의존성 SEV2',
    expectedAction: '준비 파드 변화 0·503 미룸·재연결 회복',
    invariant: '오버셀 0·재시작 0',
    load: true, commandExpected: false,
  },
  {
    id: 'G-24', order: 13, group: 'B', window: '3c', name: '재시작 전 증거·느린 쿼리',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['힙 누수 주입 없음'], partialParts: ['pg_sleep 느린 쿼리', 'RB-32 취소'],
    runbook: 'RB-31·RB-32', runbookNote: '',
    fault: 'pg_sleep 느린 쿼리(힙 주입 없음)',
    expectedAlert: '잠금 대기 p99 상승',
    expectedAction: 'RB-32로 취소·종료',
    invariant: '데이터 손실 0',
    load: true, commandExpected: false,
  },
  {
    id: 'G-25', order: 14, group: 'B', window: '3c', name: '조용한 실패(처리량 급감)',
    mode: '로컬 실행', evidence: '측정함', stageReady: false,
    missing: ['브라우저·Playwright·SDK 차단 없음'], partialParts: [],
    runbook: 'RB-33', runbookNote: '',
    fault: 'SDK 로드 차단(무대 없음)',
    expectedAlert: '처리량 급감 SEV2',
    expectedAction: 'RB-33으로 SDK 막힌 단계 확인·되돌리기',
    invariant: '실패 요청 0·이중 결제 0',
    load: true, commandExpected: false,
  },
];

export const F0812_SCENARIOS = Object.freeze(RAW_SCENARIOS.map((s) => Object.freeze({
  ...s,
  missing: Object.freeze([...s.missing]),
  partialParts: Object.freeze([...s.partialParts]),
  artifacts: F0812_ARTIFACTS,
})));

const BY_ID = new Map(F0812_SCENARIOS.map((s) => [s.id, s]));

/** @param {string} id */
export function scenarioOf(id) {
  return BY_ID.get(id) ?? null;
}

function ms(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round3(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function result(verdict, reasons, details = {}) {
  return { verdict, reasons: Array.isArray(reasons) ? reasons : [reasons], ...details };
}

/**
 * 로컬 Game Day 시간선 판정.
 * T0 주입·T1 알림(로컬 생략 가능)·T1p ALERTS firing·T2 명령 접수·T3 파드 반영·T4 복구.
 * 탐지 = T1p - T0, 전파 = T3 - T2.
 */
export function judgeLocalTimeline(timeline = {}, options = {}) {
  const commandExpected = options.commandExpected === true;
  const requireAlertmanager = options.requireAlertmanager === true;
  const t0 = ms(timeline.T0);
  const t1 = ms(timeline.T1);
  const t1p = ms(timeline.T1p);
  const t2 = ms(timeline.T2);
  const t3 = ms(timeline.T3);
  const t4 = ms(timeline.T4);
  if (t0 === null || t1p === null || t4 === null) {
    return result('판정 못 함', 'T0·T1p·T4가 필요하다', { detectionSec: null, propagationSec: null });
  }
  const detectionSec = round3((t1p - t0) / 1000);
  if (requireAlertmanager && t1 === null) {
    return result('판정 못 함', 'K8은 T1(Alertmanager 알림)이 필요하다', { detectionSec, propagationSec: null });
  }
  if (t1 !== null && t1 < t1p) {
    return result('미달', 'T1이 T1p보다 이르다', { detectionSec, propagationSec: null });
  }
  if (detectionSec > F0812_DEFAULTS.detectLimitSec) {
    return result('미달', `탐지 ${detectionSec}초가 ${F0812_DEFAULTS.detectLimitSec}초를 넘었다`, { detectionSec, propagationSec: null });
  }
  if (!commandExpected) {
    if (t4 < t1p) return result('판정 못 함', 'T4가 T1p보다 이르다', { detectionSec, propagationSec: null });
    return result('통과', [], { detectionSec, propagationSec: null });
  }
  if (t2 === null || t3 === null) {
    return result('판정 못 함', 'T2·T3가 필요하다', { detectionSec, propagationSec: null });
  }
  if (t3 < t2) return result('판정 못 함', 'T3가 T2보다 이르다', { detectionSec, propagationSec: null });
  if (t1 !== null && t2 < t1) return result('판정 못 함', 'T2가 T1보다 이르다', { detectionSec, propagationSec: null });
  if (t1 === null && t2 < t1p) return result('판정 못 함', 'T2가 T1p보다 이르다', { detectionSec, propagationSec: null });
  if (t4 < t3) return result('판정 못 함', 'T4가 T3보다 이르다', { detectionSec, propagationSec: null });
  const propagationSec = round3((t3 - t2) / 1000);
  if (propagationSec > F0812_DEFAULTS.propagationLimitSec) {
    return result('미달', `전파 ${propagationSec}초가 ${F0812_DEFAULTS.propagationLimitSec}초를 넘었다`, { detectionSec, propagationSec });
  }
  return result('통과', [], { detectionSec, propagationSec });
}

function responseOk(checks) {
  if (!checks || typeof checks !== 'object') return { ok: false, verdict: '판정 못 함', reason: 'responseChecks가 없다' };
  for (const key of ['expectedAlert', 'expectedAction', 'invariantHeld']) {
    const check = checks[key];
    if (!check || typeof check.ok !== 'boolean' || typeof check.evidence !== 'string' || check.evidence.trim() === '') {
      return { ok: false, verdict: '판정 못 함', reason: `기대 대응 확인 ${key}의 증거가 없다` };
    }
    if (check.ok === false) return { ok: false, verdict: '미달', reason: `기대 대응 확인 ${key}가 실패했다` };
  }
  return { ok: true };
}

/**
 * 실행 하나를 판정한다(무대 판정 전의 순수 실행 판정).
 */
export function judgeLocalRun(input = {}) {
  const run = input.run ?? {};
  const observation = input.observation ?? {};
  const load = input.load === true;
  const commandExpected = input.commandExpected === true;
  if (run.complete !== true) return result('무효', '실행을 끝까지 채우지 못했다', { incidentRequired: false });
  const injection = run.injection;
  if (!injection || injection.applied !== true) return result('무효', '장애 주입 적용 증거가 없다', { incidentRequired: false });
  if (typeof injection.evidence !== 'string' || injection.evidence.trim() === '') return result('무효', '장애 주입 적용 증거가 비었다', { incidentRequired: false });
  if (injection.rollbackOk !== true) return result('무효', '롤백을 확인하지 못했다', { incidentRequired: false });
  const host = run.host;
  if (!host || typeof host !== 'object') return result('판정 못 함', 'host 증거가 없다', { incidentRequired: false });
  if (host.cpuPct >= F0812_DEFAULTS.maxHostCpuPct) return result('무효', `호스트 CPU ${host.cpuPct}%`, { incidentRequired: false });
  if (host.procsRunning > host.logicalCpus) return result('무효', `procs_running ${host.procsRunning} > 논리 프로세서 ${host.logicalCpus}`, { incidentRequired: false });
  if (load) {
    const generator = run.generator;
    if (!generator || typeof generator !== 'object') return result('판정 못 함', 'generator 증거가 없다', { incidentRequired: false });
    if (generator.droppedIterations > 0) return result('무효', `발생기 dropped_iterations ${generator.droppedIterations}`, { incidentRequired: false });
    if (generator.cpuPct > F0812_DEFAULTS.maxGeneratorCpuPct) return result('무효', `발생기 CPU ${generator.cpuPct}%`, { incidentRequired: false });
    if (generator.memPct > F0812_DEFAULTS.maxGeneratorMemPct) return result('무효', `발생기 메모리 ${generator.memPct}%`, { incidentRequired: false });
    if (!(run.httpReqs > 0)) return result('무효', '본구간 http_reqs가 0이다', { incidentRequired: false });
  }
  const invariants = run.invariants;
  if (!invariants || typeof invariants !== 'object') return result('판정 못 함', 'invariants 증거가 없다', { incidentRequired: false });
  if ((invariants.oversell ?? 0) > 0 || (invariants.doublePayment ?? 0) > 0 || (invariants.admitBeforeTurn ?? 0) > 0) {
    return result('미달', '불변식 위반이 있다', { incidentRequired: true });
  }
  const response = responseOk(run.responseChecks);
  if (!response.ok) return result(response.verdict, response.reason, { incidentRequired: false });
  const timeline = run.timeline ?? {};
  const t1p = ms(timeline.T1p);
  const human = ms(observation.humanNoticedAt);
  const humanFirst = human !== null && t1p !== null && human < t1p;
  const path = observation.detectionPath;
  if (path !== '경보' || humanFirst) {
    return result('미달', '사람·외부가 먼저 알았거나 탐지 경로가 경보가 아니다(POL-022 선언 기준 7)', { incidentRequired: true });
  }
  const judged = judgeLocalTimeline(timeline, { commandExpected });
  return result(judged.verdict, judged.reasons, {
    detectionSec: judged.detectionSec ?? null,
    propagationSec: judged.propagationSec ?? null,
    incidentRequired: false,
  });
}

/**
 * 카탈로그의 시나리오 하나를 판정한다. 무대 없음·모의 진행·설계만은 통과가 아니다.
 */
export function judgeLocalScenario(input = {}) {
  const spec = scenarioOf(input.scenario);
  if (!spec) return result('판정 못 함', '카탈로그에 없는 시나리오다', { detectionSec: null, propagationSec: null, alertDetected: false, details: {} });
  if (!spec.stageReady) {
    const reasons = [...spec.missing, ...spec.partialParts];
    return result('판정 못 함', reasons.length ? reasons : '이 계획 무대에 없다', { detectionSec: null, propagationSec: null, alertDetected: false, details: { scenario: spec.id } });
  }
  if (spec.mode === '모의 진행' || spec.evidence === '설계만') {
    return result('판정 못 함', '모의 진행·설계만은 통과가 아니다', { detectionSec: null, propagationSec: null, alertDetected: false, details: { scenario: spec.id } });
  }
  if (input.mode !== spec.mode) return result('판정 못 함', `실행 방식이 정본과 다르다(정본 ${spec.mode}, 입력 ${input.mode})`, { detectionSec: null, propagationSec: null, alertDetected: false, details: { scenario: spec.id } });
  if (input.evidence !== spec.evidence) return result('판정 못 함', `증거 수준이 정본과 다르다(정본 ${spec.evidence}, 입력 ${input.evidence})`, { detectionSec: null, propagationSec: null, alertDetected: false, details: { scenario: spec.id } });
  const judged = judgeLocalRun({
    run: input.run,
    observation: input.observation,
    load: spec.load,
    commandExpected: spec.commandExpected,
  });
  const t1p = ms(input.run?.timeline?.T1p);
  return result(judged.verdict, judged.reasons, {
    detectionSec: judged.detectionSec ?? null,
    propagationSec: judged.propagationSec ?? null,
    alertDetected: input.observation?.detectionPath === '경보' && t1p !== null,
    incidentRequired: judged.incidentRequired === true,
    details: { scenario: spec.id },
  });
}

/** 묶음 종합. 묶음의 14종 결과가 모두 있어야 한다. */
export function judgeLocalGroup(groupId, results = []) {
  const group = F0812_GROUPS.find((g) => g.id === groupId);
  if (!group) return result('판정 못 함', '모르는 묶음이다', { groupId });
  const byId = new Map((Array.isArray(results) ? results : []).filter((r) => r && r.scenario).map((r) => [r.scenario, r]));
  const missing = group.scenarioIds.filter((id) => !byId.has(id));
  if (missing.length) return result('판정 못 함', `묶음 결과가 모자라다: ${missing.join(', ')}`, { groupId });
  const verdicts = group.scenarioIds.map((id) => byId.get(id).verdict);
  if (verdicts.some((v) => !F0812_VERDICTS.includes(v))) return result('판정 못 함', '모르는 판정값이 있다', { groupId });
  if (verdicts.some((v) => v === '무효' || v === '판정 못 함' || v === '미측정')) return result('판정 못 함', '무효·판정 못 함·미측정 결과가 있다', { groupId });
  if (verdicts.some((v) => v === '미달')) return result('미달', '미달 결과가 있다', { groupId });
  return result('통과', [], { groupId });
}

const RUN_ID_SUFFIX = /-f0812$/;

/** @param {string[]} argv */
export function parseGamedayLocalArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const out = {
    window: null,
    scenario: null,
    group: null,
    record: false,
    rehearsal: false,
    partial: false,
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
    if (arg === '--group') { out.group = take(i, arg); i += 1; continue; }
    if (arg === '--record') { out.record = true; continue; }
    if (arg === '--rehearsal') { out.rehearsal = true; continue; }
    if (arg === '--partial') { out.partial = true; continue; }
    if (arg === '--run-id') { out.runId = take(i, arg); i += 1; continue; }
    if (arg === '--out') { out.out = take(i, arg); i += 1; continue; }
    if (arg === '--judge') { out.judge = take(i, arg); i += 1; continue; }
    if (arg === '--docker-all' || arg === '--browser' || arg === '--leak') throw new UsageError(`${arg}는 이 기능에서 허용하지 않는다`);
    throw new UsageError(`모르는 인자: ${arg}`);
  }
  if (!out.window) throw new UsageError('--window가 필요하다(3a|3b|3c)');
  const window = F0812_WINDOWS.find((w) => w.id === out.window);
  if (!window) throw new UsageError(`모르는 창: ${out.window}`);
  if (out.scenario !== null && !window.scenarioIds.includes(out.scenario)) throw new UsageError(`창 ${out.window}에 없는 시나리오: ${out.scenario}`);
  if (out.group !== null) {
    const group = F0812_GROUPS.find((g) => g.id === out.group);
    if (!group) throw new UsageError(`모르는 묶음: ${out.group}`);
    if (!window.scenarioIds.every((id) => group.scenarioIds.includes(id))) throw new UsageError(`창 ${out.window}은 묶음 ${out.group}이 아니다`);
  }
  if (out.record && !out.runId) throw new UsageError('--record에는 --run-id가 필요하다');
  if (out.runId !== null && !RUN_ID_SUFFIX.test(out.runId)) throw new UsageError('--run-id는 -f0812로 끝나야 한다');
  if (out.rehearsal && out.record) throw new UsageError('--rehearsal과 --record는 함께 쓸 수 없다');
  if (out.partial) {
    if (!out.scenario) throw new UsageError('--partial에는 --scenario가 필요하다');
    const spec = scenarioOf(out.scenario);
    if (!spec || spec.partialParts.length === 0) throw new UsageError(`${out.scenario}는 부분 실행이 없다`);
    if (!out.record) throw new UsageError('--partial은 --record와 함께 쓴다');
  }
  return out;
}

/** 미측정 보고서 뼈대. results를 주면 그 판정을 싣는다. */
export function renderLocalReport(input = {}) {
  const results = new Map((Array.isArray(input.results) ? input.results : []).filter((r) => r && r.scenario).map((r) => [r.scenario, r]));
  const rows = F0812_SCENARIOS.map((s) => {
    const r = results.get(s.id);
    const verdict = r?.verdict ?? '미측정';
    const evidence = r?.evidence ?? (r?.runId ?? '—');
    return `| ${s.id} | ${s.window} | ${s.mode} | ${s.evidence} | — | ${verdict} | ${evidence} |`;
  }).join('\n');
  return [
    '# F-08-12 Game Day 로컬 ①·② 보고서',
    '',
    '- **상태**: 미실행. 14종은 측정 창 3a~3c에서 시도한다. 아래 판정은 모두 `미측정`이다.',
    '- **정본**: `docs/observability.md` §12, `docs/verification.md` §5.2, `docs/perf-ledger.md` §8.',
    '- **계획**: `docs/review/plans/F-08-12.md` §6~§10.',
    '',
    '## 1. 실행 표',
    '',
    '| 시나리오 | 창 | 실행 방식 | 증거 수준 | 주입 | 판정 | 증거 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    '## 2. 탐지·전파',
    '',
    '- 탐지는 T0(주입)→T1p(`ALERTS` firing)이고, 전파는 T2(명령 접수)→T3(파드 반영)이다. 로컬은 T1(Alertmanager)이 없어 null이다.',
    '- 60.000초·3.000초는 통과, 60.001초·3.001초는 미달이다. K8 10종 종합 판정은 F-08-6·F-08-14 몫이다.',
    '',
    '## 3. 인시던트와 포스트모템',
    '',
    '| 인시던트 | 시나리오 | 선언 시각 | 끝 시각 | 완료 시각 | 예산 비율 | P0 | 포스트모템 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '',
    '## 4. 선행 측정 인용',
    '',
    '- F-08-5: 무효·미측정',
    '- F-08-9: 판정 못 함(무효·부분)',
    '- F-08-10: 미측정',
    '',
    '## 5. 한계',
    '',
    '- 로컬 Prometheus에 경보 규칙이 없어 G-21·G-23·G-31은 경보를 잴 수 없고 `판정 못 함`이다. 이 무대에서 통과 가능한 시나리오는 0이다.',
    '- G-10·G-30·G-18·G-19·G-22·G-25는 무대가 없고, G-02·G-20·G-23·G-24·G-29·G-31은 일부만 할 수 있다. G-17은 설계만이다.',
    '',
    '## 6. 장부·게이트',
    '',
    '- `node tools/ci/ledger.mjs --batch F-08-12 --require`: 항목 0.',
    '- f0812 16, f0811 10, F-08-6 8, lint 0, doc-check 오류 0·경고 12, release-scope 33/5/67.',
    '',
    '## 7. 주장하지 않는 것',
    '',
    '- 30,000건/초·100만·K1/K2/K7 0을 주장하지 않는다.',
    '- F-08-5의 무효·미측정, F-08-9의 판정 못 함(무효·부분), F-08-10의 미측정을 통과로 바꾸지 않는다.',
  ].join('\n');
}

function splitCells(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isPlaceholder(value) {
  return value === '' || value === '—' || value === '-';
}

const ALLOWED_CLAIM = /주장하지 않는다|쓰지 않는다|하지 않는다|않는다|없고|없다|아니다|못 한다|인용|범위 밖|위반|미측정|판정 못 함|무효|동결|닫지 않는다|닫지 않는|미실행|설계만|외삽은 하지 않는다/;

/** 전화번호·이메일·사설 IP. */
export function containsPii(text) {
  const value = String(text ?? '');
  return [
    /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/,
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
    /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/,
  ].some((re) => re.test(value));
}

function forbiddenClaim(line) {
  const tokens = ['30k/s', '30,000건/초', '100만'];
  const hasLongK = /(?:^|[^A-Za-z0-9])K[127](?![0-9])/.test(line);
  return tokens.some((t) => line.includes(t)) || hasLongK;
}

/** 보고서 검증. 통과 행의 실패 이유를 모두 모아 reasons에 남긴다. */
export function validateLocalReport(markdown, options = {}) {
  const text = String(markdown ?? '');
  const o = {
    measured: options.measured === true,
    runExists: typeof options.runExists === 'function' ? options.runExists : () => false,
    runResponseOk: typeof options.runResponseOk === 'function' ? options.runResponseOk : () => false,
    postmortemExists: typeof options.postmortemExists === 'function' ? options.postmortemExists : () => false,
    postmortemOk: typeof options.postmortemOk === 'function' ? options.postmortemOk : () => false,
  };
  const reasons = [];
  const add = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  const lines = text.split('\n');
  const rows = lines
    .filter((line) => /^\|\s*G-\d\d\s*\|/.test(line))
    .map((line) => ({ line, cells: splitCells(line) }));
  const seen = new Set();
  let passed = 0;
  for (const { cells } of rows) {
    const [id, , , , , verdict, evidence] = cells;
    if (!F0812_SCENARIOS.some((s) => s.id === id)) continue;
    if (seen.has(id)) add(`중복 시나리오 행: ${id}`);
    seen.add(id);
    if (!F0812_VERDICTS.includes(verdict)) { add(`모르는 판정: ${id} ${verdict}`); continue; }
    if (verdict !== '통과') continue;
    passed += 1;
    if (!o.measured) add('측정 전 통과가 있다');
    if (!RUN_ID_SUFFIX.test(evidence)) add(`실행 ID가 -f0812로 끝나지 않는다: ${id}`);
    if (!o.runExists(evidence)) add(`실행 ID가 장부에 없다: ${evidence}`);
    if (!o.runResponseOk(evidence)) add(`기대 대응 증거가 없다: ${evidence}`);
    const spec = scenarioOf(id);
    if (!spec) add(`카탈로그에 없는 시나리오: ${id}`);
    else {
      if (!spec.stageReady) add(`무대가 없는데 통과했다: ${id}`);
      if (spec.mode === '모의 진행' || spec.evidence === '설계만') add(`설계만·모의 진행인데 통과했다: ${id}`);
    }
  }
  for (const spec of F0812_SCENARIOS) if (!seen.has(spec.id)) add(`시나리오 행이 없다: ${spec.id}`);

  const prior = (id) => lines.find((line) => line.includes(id)) ?? '';
  if (!prior('F-08-5').includes('무효·미측정')) add('F-08-5 선행 인용이 다르다');
  if (!prior('F-08-9').includes('판정 못 함(무효·부분)')) add('F-08-9 선행 인용이 다르다');
  const f10 = prior('F-08-10');
  if (!f10.includes('미측정') || f10.includes('통과')) add('F-08-10 선행 인용이 다르다');

  const incidentRows = lines
    .filter((line) => /^\|\s*INC-[^|]*\|/.test(line))
    .map((line) => splitCells(line));
  for (const cells of incidentRows) {
    const [, , , end, complete, budget, p0, path] = cells;
    if (isPlaceholder(path) || !o.postmortemExists(path)) add(`포스트모템이 없다: ${path || '—'}`);
    const endMs = ms(end);
    const completeMs = ms(complete);
    if (endMs === null || completeMs === null) add('인시던트 끝·완료 시각이 잘못됐다');
    else if (completeMs - endMs > F0812_DEFAULTS.postmortemDueHours * 3600 * 1000) add('포스트모템 48시간을 넘겼다');
    const ratio = Number.parseFloat(String(budget).replace('%', ''));
    if (Number.isFinite(ratio) && ratio > F0812_DEFAULTS.budgetP0Ratio * 100 && isPlaceholder(p0)) add('20% 초과 인시던트에 P0가 없다');
    if (!o.postmortemOk(path)) add(`포스트모템 내용이 잘못됐다: ${path}`);
  }

  if (containsPii(text)) add('개인정보·연락처·내부 주소가 있다');
  for (const line of lines) {
    if (forbiddenClaim(line) && !ALLOWED_CLAIM.test(line)) add(`금지 수치 주장이 있다: ${line.trim()}`);
  }
  return { ok: reasons.length === 0, reasons, passed };
}

/** 포스트모템 검증. 48.0/48.1시간·20.0/20.1% P0·원인 9·이슈 링크·PII. */
export function validateLocalPostmortem(markdown) {
  const text = String(markdown ?? '');
  const fields = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^- \*\*(.+?)\*\*: (.*)$/);
    if (match) fields.set(match[1].trim(), match[2].trim());
  }
  const required = [
    '선언 시각', '끝 시각', '완료 시각', '첫 증상 시각', '첫 경보 시각', '사람이 안 시각',
    '탐지 경로', '주 원인 유형', '구성 요소', '기여 원인 유형', '계기', '영향',
    '예산 사용 비율', '쓴 손잡이', '후속 조치', 'P0',
  ];
  const reasons = [];
  for (const key of required) if (!fields.has(key) || fields.get(key) === '') reasons.push(`필수 칸이 없다: ${key}`);
  const cause = fields.get('주 원인 유형');
  if (cause && !F0812_POSTMORTEM.causeTypes.includes(cause)) reasons.push(`원인 유형 9 밖이다: ${cause}`);
  const followUp = fields.get('후속 조치') ?? '';
  if (!/#\d+/.test(followUp) && !/https?:\/\//.test(followUp)) reasons.push('후속 조치에 이슈 링크가 없다');
  const endMs = ms(fields.get('끝 시각'));
  const completeMs = ms(fields.get('완료 시각'));
  if (endMs === null || completeMs === null) reasons.push('끝·완료 시각이 잘못됐다');
  else if (completeMs - endMs > F0812_POSTMORTEM.dueHours * 3600 * 1000) reasons.push('48시간을 넘겼다');
  const ratio = Number.parseFloat(String(fields.get('예산 사용 비율') ?? '').replace('%', ''));
  if (Number.isFinite(ratio) && ratio > F0812_POSTMORTEM.p0BudgetRatio * 100 && isPlaceholder(fields.get('P0') ?? '')) reasons.push('20% 초과에 P0가 없다');
  if (containsPii(text)) reasons.push('개인정보·연락처·내부 주소가 있다');
  return { ok: reasons.length === 0, reasons };
}

function commandHas(command, flag) {
  return Array.isArray(command?.argv) && command.argv.includes(flag);
}

/** 계획 JSON 검증. */
export function validateLocalPlan(plan) {
  const reasons = [];
  const add = (reason) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (!plan || typeof plan !== 'object') return { ok: false, reasons: ['계획이 객체가 아니다'] };
  if (plan.batch !== 'F-08-12') add('batch가 F-08-12가 아니다');
  if (plan.feature !== 'F-08-12') add('feature가 F-08-12가 아니다');
  if (!Array.isArray(plan.windows) || plan.windows.length !== 3) add('창이 3개가 아니다');
  else {
    const expected = new Map(F0812_WINDOWS.map((w) => [w.id, w.scenarioIds]));
    for (const w of plan.windows) {
      if (!expected.has(w.id)) { add(`모르는 창: ${w.id}`); continue; }
      const ids = JSON.stringify(w.scenarioIds);
      if (ids !== JSON.stringify([...expected.get(w.id)])) add(`창 ${w.id} 시나리오가 다르다`);
    }
  }
  if (!Array.isArray(plan.scenarios) || plan.scenarios.length !== 14) add('시나리오가 14종이 아니다');
  else {
    for (const s of plan.scenarios) {
      const spec = scenarioOf(s.id);
      if (!spec) { add(`모르는 시나리오: ${s.id}`); continue; }
      if (s.window !== spec.window) add(`${s.id} 창이 다르다`);
      if (s.stageReady !== spec.stageReady) add(`${s.id} stageReady가 다르다`);
      if (!Array.isArray(s.missing) || !Array.isArray(s.partialParts)) add(`${s.id} missing·partialParts가 배열이 아니다`);
      if (!Array.isArray(s.commands)) add(`${s.id} commands가 배열이 아니다`);
      else {
        const record = s.commands.find((c) => commandHas(c, '--record'));
        if (!spec.stageReady && spec.partialParts.length === 0) {
          if (record) add(`${s.id} 무대 없음인데 기록 명령이 있다`);
        } else {
          if (!record) add(`${s.id} 기록 명령이 없다`);
          else {
            if (!commandHas(record, '--window')) add(`${s.id} 기록 명령에 --window가 없다`);
            const wi = record.argv.indexOf('--window');
            if (wi >= 0 && record.argv[wi + 1] !== spec.window) add(`${s.id} 기록 명령의 창이 다르다`);
            const ri = record.argv.indexOf('--run-id');
            if (ri < 0 || !RUN_ID_SUFFIX.test(record.argv[ri + 1] ?? '')) add(`${s.id} 실행 ID가 -f0812로 끝나지 않는다`);
            if (!commandHas(record, '--out')) add(`${s.id} 기록 명령에 --out이 없다`);
            if (commandHas(record, '--partial') !== (spec.partialParts.length > 0)) add(`${s.id} --partial 표시가 다르다`);
          }
        }
      }
    }
  }
  if (!plan.lock || plan.lock.take !== F0812_LOCK.take || plan.lock.drop !== F0812_LOCK.drop || plan.lock.dockerAll !== false) add('잠금이 다르다');
  if (!Array.isArray(plan.stopRules) || plan.stopRules.length !== 10) add('중단 규칙이 10개가 아니다');
  else if (plan.stopRules.map((r) => r.id).join(',') !== F0812_STOP_RULES.map((r) => r.id).join(',')) add('중단 규칙 ID가 다르다');
  if (JSON.stringify(plan.priorMeasurements) !== JSON.stringify(F0812_PRIOR_MEASUREMENTS)) add('선행 측정 인용이 다르다');
  const notIncluded = JSON.stringify(plan.notIncluded ?? []);
  for (const token of ['F-08-6', 'F-08-9', 'F-08-10', 'F-08-11', 'F-08-13', 'F-08-8', 'F-08-5', 'F-08-2', 'K1', 'K2', 'K7', '30,000', '100만']) {
    if (!notIncluded.includes(token)) add(`notIncluded에 ${token}이 없다`);
  }
  for (const key of ['F-08-6', 'F-08-9', 'F-08-10', 'F-08-11', 'F-08-13', 'F-08-8', 'F-08-5', 'F-08-2']) {
    if (!plan.boundaries?.[key]) add(`boundaries에 ${key}가 없다`);
  }
  return { ok: reasons.length === 0, reasons };
}
