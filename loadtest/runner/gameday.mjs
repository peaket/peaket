// F-08-6(MSR-060·MSR-070) Game Day 33종 카탈로그·판정·보고서·포스트모템·SLO/KPI ADR 초안 도구.
//
// 정본: docs/observability.md §4(긁기·평가·알림 간격)·§5(포스트모템·인시던트)·§12(Game Day 33종·K8),
//       docs/verification.md §5.2(실행 방식), docs/planning/01 §3.1~3.2(K8·비즈니스 KPI),
//       docs/planning/03 §4(원인 유형 9), docs/perf-ledger.md §2.1·§7·§8.
// 계획: docs/review/plans/F-08-6.md §6·§8.
// 이 파일은 Docker·kind·k6·브라우저를 쓰지 않는다. 실제 33종 실행은 측정 창에서 한다.
import { UsageError } from './args.mjs';

export const GAMEDAY_WINDOWS = Object.freeze(['4d', '4e', '4f', '4g']);
export const GAMEDAY_MODES = Object.freeze(['로컬 실행', '대체 장애', '모의 진행']);
export const VERDICTS = Object.freeze(['통과', '미달', '판정 못 함', '무효', '미측정']);
export const DETECTION_PATHS = Object.freeze(['경보', '사람', '외부']);
export const RESPONSE_CHECKS = Object.freeze(['expectedAlert', 'expectedAction', 'invariantHeld']);
export const CAUSE_TYPES = Object.freeze([
  '변경',
  '외부 의존',
  '내부 저장소·메시징',
  '용량·포화',
  '코드 결함',
  '데이터',
  '보안',
  '운영 조작',
  '기반',
  '기타',
]);
export const POSTMORTEM_FIELDS = Object.freeze([
  '선언 시각',
  '끝 시각',
  '완료 시각',
  '첫 증상 시각',
  '첫 경보 시각',
  '사람이 안 시각',
  '탐지 경로',
  '주 원인 유형',
  '구성 요소',
  '기여 원인 유형',
  '계기',
  '영향',
  '예산 사용 비율',
  '쓴 손잡이',
  '후속 조치',
  '기타 사유',
]);

export const GAMEDAY_DEFAULTS = Object.freeze({
  detectLimitSec: 60,
  propagationLimitSec: 3,
  scrapeFastSec: 5,
  scrapeOtherSec: 15,
  evalSec: 5,
  groupWaitSec: 5,
  k8CauseForSec: 30,
  k8BurnMultipleMin: 27,
  postmortemDueHours: 48,
  budgetP0Ratio: 0.2,
});

export const GAMEDAY_PRIOR_MEASUREMENTS = Object.freeze({
  'F-08-5': '무효·미측정',
  'F-08-9': '판정 못 함(무효·부분)',
  'F-08-10': '미측정',
});

export const GAMEDAY_STOP_RULES = Object.freeze([
  { id: 'STOP-01', rule: '무대가 준비되지 않았다' },
  { id: 'STOP-02', rule: 'Docker 잠금이 없거나 docker-all을 썼다' },
  { id: 'STOP-03', rule: '호스트가 포화됐다(CPU 85% 이상, procs_running > 논리 프로세서)' },
  { id: 'STOP-04', rule: '장애 주입 적용 증거가 없다' },
  { id: 'STOP-05', rule: '불변식 위반이 1건 이상 나왔다' },
  { id: 'STOP-06', rule: '이전 시나리오의 롤백에 실패했다' },
  { id: 'STOP-07', rule: '디스크가 15GB 미만이거나 메모리 압박이 있다' },
  { id: 'STOP-08', rule: '경보·기록 파이프라인이 끊겼다' },
  { id: 'STOP-09', rule: '같은 시나리오가 두 번 연속 무효다' },
  { id: 'STOP-10', rule: '감독이 중단을 지시했다' },
]);

const FAST_INTERVAL = Object.freeze({ scrapeSec: 5, evalSec: 5, groupWaitSec: 5, forSec: 0 });
const OPS_RT_INTERVAL = Object.freeze({ scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 0 });
const CAUSE_INTERVAL = Object.freeze({ scrapeSec: 15, evalSec: 5, groupWaitSec: 5, forSec: 30 });
const ALL_IDS = Object.freeze(Array.from({ length: 33 }, (_, i) => `G-${String(i + 1).padStart(2, '0')}`));

const SIMULATED = Object.freeze(['G-17', 'G-28', 'G-32', 'G-33']);
const ALTERNATE = Object.freeze(['G-02', 'G-03', 'G-04', 'G-10', 'G-16', 'G-26', 'G-27', 'G-29']);

/** 이 계획의 무대로 낼 수 없는 시나리오(RV086-01). 나머지는 stageReady=true다 */
const STAGE_GAPS = Object.freeze({
  'G-02': { requires: ['seats-redis-replica', 'redis-failover'], missing: ['좌석 Redis 복제본·승격 없음(Valkey 단일)'] },
  'G-07': { requires: ['ops-rt', 'clickhouse'], missing: ['ops-rt·ClickHouse 없음'] },
  'G-09': { requires: ['admission-ctrl-leader', 'separate-pod'], missing: ['admission-ctrl 리더·개별 파드 없음(bundle 한 파드)'] },
  'G-14': { requires: ['purchase-pod', 'separate-service'], missing: ['purchase 개별 파드 없음(bundle 한 파드)'] },
  'G-18': { requires: ['argo-rollouts'], missing: ['Argo Rollouts 없음'] },
  'G-19': { requires: ['argocd', 'freeze-calendar'], missing: ['Argo CD·동결 달력 없음'] },
  'G-22': { requires: ['keda'], missing: ['KEDA 없음'] },
  'G-25': { requires: ['playwright', 'payment-sdk-block'], missing: ['브라우저·Playwright 금지'] },
  'G-26': { requires: ['observability-az'], missing: ['관측 AZ 장애 재현 불가(설계만)'] },
  'G-29': { requires: ['session-redis-replica', 'redis-failover'], missing: ['세션·캐시 Redis 복제본 없음'] },
  'G-30': { requires: ['schema-registry'], missing: ['Schema Registry 없음'] },
  'G-32': { requires: ['zonal-shift'], missing: ['NLB 영역 빼기 재현 불가(모의)'] },
  'G-33': { requires: ['cloudfront', 'nlb'], missing: ['CloudFront·NLB 재현 불가(모의)'] },
});

const ARTIFACTS = Object.freeze([
  'timeline.csv',
  'manifest.json',
  'alerts.ndjson',
  'commands.ndjson',
  'faults.ndjson',
  'invariants.csv',
  'host.json',
  'run.json',
  'generator.json',
]);

/** 33종의 정본 내용(observability §12, verification §5.2). mode는 ALTERNATE·SIMULATED로 가른다 */
const CATALOG = [
  ['G-01', '대기열 Redis CPU 75% 초과', 'queue-redis', 'CPU 75% 초과 부하', '대기열 진입 번 레이트 가속', '진입 Degraded 자동 전환·진입 p99 1초 이내'],
  ['G-02', '좌석 Redis 주 노드 페일오버', 'seats-redis', '주 노드 강제 종료·복제 승격', '좌석 홀드 503 급증', '503으로 미루고 오버셀·이중 홀드 0'],
  ['G-03', 'CDN 대기 상태 파일 오류', 'cdn-cache', '대기 상태 파일 오류율 1% 초과', '대기 순번 조회 가용성 저하', '폴링 2배·S3 우회'],
  ['G-04', '공연 상세 원본 오류', 'event-detail-origin', '원본 오류율 1% 초과', '공연 정보 페이지 예산 소진', 'stale-if-error·캐시 10분'],
  ['G-05', '결제 승인 지연', 'pg-simulator', '승인 API p99 5초 지연', '결제 확정 임박 SEV2', '비동기 재시도·홀드 TTL 연장'],
  ['G-06', 'realtime-gw 송신 큐 포화', 'realtime-gw', '송신 버퍼 큐 포화', '버퍼 1초 연결 비율 경보', '1초 묶음·화면 밖 폴링'],
  ['G-07', '스트림 작업자 밀림', 'ops-rt', 'ClickHouse 삽입 지연', '실시간 표 신선도 경고', 'Prometheus 대체 표시'],
  ['G-08', 'ops-svc 전면 종료', 'ops-svc', '관제 백엔드 파드 전면 종료', 'ops-svc 가용성 상실 SEV1', '런북 CLI로 제어 gRPC'],
  ['G-09', 'admission-ctrl 리더 종료', 'admission-ctrl', '리더 SIGKILL', '리더 부재 SEV2', 'Lease 대기 파드 승격·중복 0'],
  ['G-10', 'Kafka 브로커 1대 오프라인', 'kafka', '브로커 1대 오프라인', '브로커 오프라인 SEV2', 'RF3·minISR2로 거래 지속'],
  ['G-11', '관측 스택 전체 정지', 'observability', '관측 스택 전체 정지', '데드맨 스위치·온콜', 'Prometheus 밖 숫자·런북 CLI'],
  ['G-12', '자동 제어·수동 명령 충돌', 'admission-ctrl', '자동 AIMD·수동 명령 충돌', '자동화 제어 충돌 기록', '15분 수동 우선·복귀'],
  ['G-13', '잘못된 명령 되돌리기', 'ops-svc', '잘못된 매개변수 명령·즉시 롤백', '롤백 이벤트', '직전 상태 복원 ack·감사 로그'],
  ['G-14', 'purchase-svc 전면 장애', 'purchase-svc', '전면 장애', '구매 여정 전면 중단 SEV1', '대기열·관제 정상'],
  ['G-15', 'payment-svc 5초 지연', 'payment-svc', '승인 5초 지연', '결제 확정 지연', '서킷·gRPC 데드라인'],
  ['G-16', '게이트웨이 파드 절반 종료', 'gateway', '파드 절반 동시 종료', '가용 파드 급감', '503 Retry-After·60초 복제 회복'],
  ['G-17', '보안 사고 모의훈련', 'security', '관리 계정 탈취·명단 유출 의심·DDoS', '보안 사고 SEV1·기한 임박', '신고·통지 기한·감사 로그'],
  ['G-18', '나쁜 배포(카나리)', 'argo-rollouts', '오류 2%·p99 2배 배포', '카나리 분석 실패 SEV2', '자동 중단·5분 내 되돌리기'],
  ['G-19', '동결 창 위반·달력 장애', 'freeze-calendar', '동결 창 위반·달력 장애', '달력 신선도 SEV2', '승격 게이트·ArgoCD deny'],
  ['G-20', 'Kyverno 확장', 'kyverno', 'Kyverno 파드 제거·투명성 로그 차단·확장', '이미지 검증 오류', '60초 내 새 파드·다이제스트 허용'],
  ['G-21', '제어 입력 끊김·낡음', 'prometheus', '제어 입력 끊김·낡음', '입력 없음 SEV2', '30초 판정·목표 유지'],
  ['G-22', 'KEDA 상호작용', 'keda', '확장 중 p99 상승·과부하 503', 'AIMD 감축·감축 확인', '추가 감축 0·퇴출 상한'],
  ['G-23', '공유 의존성 장애', 'seats-redis', '좌석 Redis 전체 정지·DB 연결 끊기', '의존성 원인 SEV2', '503·오버셀 0·재연결'],
  ['G-24', '재시작 전 증거·느린 쿼리', 'purchase-svc', '힙 누수·pg_sleep 잠금', '자원 누수 SEV3·p99 상승', '진단 증거·statement_timeout'],
  ['G-25', '조용한 실패(결제 SDK)', 'payment-sdk', '결제 SDK 로드 차단', '처리량 급감 SEV2', 'RB-33·배포 되돌리기'],
  ['G-26', '관측 스택 AZ 하나 장애', 'observability', 'AZ 하나 장애', '관측 저장소 SEV3', '정족수·빈칸 없음(설계만)'],
  ['G-27', 'KMS 정지 중 명령', 'kms', 'KMS 정지 중 명령 2·3', 'mac 빈 행 SEV2', 'KMS 없이 커밋·도쿄 키'],
  ['G-28', '신원 제공자 정지 중 명령', 'identity', 'IAM Identity Center 정지 중 명령 2', '로그인 실패·ops-svc SEV1', '비상 계정·런북 Job'],
  ['G-29', '세션 Redis 페일오버', 'session-redis', '세션 Redis 페일오버·메모리 90%', '페일오버 이벤트·메모리 SEV2', '원장 유실 0·세션 갱신'],
  ['G-30', 'Schema Registry 장애', 'schema-registry', '레지스트리 전체 정지', '레지스트리 가용성 상실', '새 파드·작업자 대기·복구 후 이어 읽기'],
  ['G-31', '거래·제어 MSK 5분 정지', 'kafka', '거래·제어 MSK 5분 정지', '오프라인 파티션 SEV1', '당기기·60초 불변식 0·따라잡기'],
  ['G-32', 'AZ 하나 전체 정지', 'az', 'AZ 하나 전체 정지·영역 빼기', '파드 급감·의존성 SEV2', '1.5배 여유·zonal shift(모의)'],
  ['G-33', '엣지 설정 실수 되돌리기', 'cloudfront-nlb', '엣지 설정 실수 되돌리기', '스테이징 오류·502/504', '승격 안 함·커밋 되돌리기(모의)'],
];

function modeOf(id) {
  if (SIMULATED.includes(id)) return '모의 진행';
  if (ALTERNATE.includes(id)) return '대체 장애';
  return '로컬 실행';
}

function k8IntervalOf(id) {
  if (!ALL_IDS.slice(0, 10).includes(id)) return null;
  if (id === 'G-07') return { ...OPS_RT_INTERVAL };
  if (['G-08', 'G-09', 'G-10'].includes(id)) return { ...CAUSE_INTERVAL };
  return { ...FAST_INTERVAL };
}

export const GAMEDAY_SCENARIOS = Object.freeze(CATALOG.map(([id, name, target, inject, expectedAlert, expectedResponse]) => {
  const gap = STAGE_GAPS[id];
  const simulated = SIMULATED.includes(id);
  return Object.freeze({
    id,
    name,
    mode: modeOf(id),
    evidence: simulated || id === 'G-26' ? '설계만' : '측정함',
    partial: id === 'G-16',
    stageReady: !gap && !simulated,
    stageMissing: gap ? [...gap.missing] : simulated ? ['모의 진행(실행하지 않음)'] : [],
    requires: gap ? [...gap.requires] : simulated ? ['tabletop'] : ['demo-stack'],
    k8Interval: k8IntervalOf(id),
    load: !simulated,
    target,
    inject,
    expectedAlert,
    expectedResponse,
    responseChecks: [...RESPONSE_CHECKS],
    artifacts: [...ARTIFACTS],
  });
}));

export const GAMEDAY_WINDOW_SCENARIOS = Object.freeze({
  '4d': Object.freeze(ALL_IDS.slice(0, 10)),
  '4e': Object.freeze(ALL_IDS.slice(10, 20)),
  '4f': Object.freeze(ALL_IDS.slice(20, 30)),
  '4g': Object.freeze(ALL_IDS.slice(30, 33)),
});

const SCENARIO_BY_ID = new Map(GAMEDAY_SCENARIOS.map((s) => [s.id, s]));
const WINDOW_BY_ID = Object.freeze(Object.fromEntries(GAMEDAY_WINDOWS.flatMap((w) => GAMEDAY_WINDOW_SCENARIOS[w].map((id) => [id, w]))));

function usage(message) {
  throw new UsageError(message);
}

export function parseGamedayArgs(argv) {
  const out = { command: 'run', window: null, scenario: null, scenarios: [], record: false, rehearsal: false, runId: null, out: null, judge: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) usage(`${a} 값이 필요하다`);
      i += 1;
      return v;
    };
    if (a === '--window') out.window = next();
    else if (a === '--scenario') out.scenario = next();
    else if (a === '--record') out.record = true;
    else if (a === '--rehearsal') out.rehearsal = true;
    else if (a === '--run-id') out.runId = next();
    else if (a === '--out') out.out = next();
    else if (a === '--judge') out.judge = next();
    else if (a === '--docker-all') usage('Game Day는 --docker-all을 쓰지 않는다. docker 한 자리만 쓴다');
    else if (a === '--browser') usage('Game Day는 브라우저를 쓰지 않는다');
    else if (a === '--leak') usage('Game Day에는 --leak(누수 주입)이 없다. F-08-5 몫이다');
    else usage(`모르는 인자: ${a}`);
  }
  if (!out.window && !out.judge) usage('--window가 필요하다(4d·4e·4f·4g 가운데 하나)');
  if (out.window && !GAMEDAY_WINDOWS.includes(out.window)) usage(`모르는 창: ${out.window}(4d·4e·4f·4g 가운데 하나)`);
  if (out.scenario && !SCENARIO_BY_ID.has(out.scenario)) usage(`모르는 시나리오: ${out.scenario}`);
  if (out.scenario && out.window && !GAMEDAY_WINDOW_SCENARIOS[out.window].includes(out.scenario)) usage(`${out.scenario}는 창 ${out.window}에 없다`);
  if (out.record && !out.runId) usage('--record에는 --run-id 실행 ID가 필요하다');
  if (out.record && out.rehearsal) usage('--record와 --rehearsal은 함께 쓸 수 없다(연습은 장부에 남기지 않는다)');
  out.scenarios = out.scenario ? [out.scenario] : out.window ? [...GAMEDAY_WINDOW_SCENARIOS[out.window]] : [];
  return out;
}

function ms(value) {
  return typeof value === 'string' && value.length > 0 ? Date.parse(value) : null;
}

function round3(value) {
  return value === null ? null : Math.round(value * 1000) / 1000;
}

function fail(verdict, reason, details = {}) {
  return { verdict, reasons: Array.isArray(reason) ? reason : [reason], detectionSec: null, propagationSec: null, alertDetected: false, details };
}

export function judgeScenario(input) {
  const spec = SCENARIO_BY_ID.get(input?.scenario);
  if (!spec) return fail('판정 못 함', '카탈로그에 없는 시나리오다');
  if (spec.evidence === '설계만' || spec.mode === '모의 진행') return fail('판정 못 함', '모의 진행·설계만은 통과가 아니다', { scenario: spec.id });
  if (!spec.stageReady) return fail('판정 못 함', spec.stageMissing.length ? spec.stageMissing : '이 계획 무대에 없다', { scenario: spec.id });
  if (input.mode !== spec.mode) return fail('판정 못 함', `실행 방식이 정본과 다르다(정본 ${spec.mode}, 입력 ${input.mode})`, { scenario: spec.id });
  if (input.evidence !== spec.evidence) return fail('판정 못 함', `증거 수준이 정본과 다르다(정본 ${spec.evidence}, 입력 ${input.evidence})`, { scenario: spec.id });

  const run = input.run ?? {};
  const obs = input.observation ?? {};
  const injectAt = ms(run.injection?.at);
  const alertAt = ms(obs.firstAlertAt);
  const humanAt = ms(obs.humanNoticedAt);
  const commandAt = ms(obs.commandAt);
  const ackAt = ms(obs.ackAt);
  const detectionSec = round3(injectAt !== null && alertAt !== null ? (alertAt - injectAt) / 1000 : null);
  const propagationSec = round3(commandAt !== null && ackAt !== null ? (ackAt - commandAt) / 1000 : null);
  const alertDetected = obs.detectionPath === '경보' && alertAt !== null;

  if (run.complete !== true) return { ...fail('무효', '실행을 끝까지 채우지 못했다', { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
  if (run.injection?.applied !== true) return { ...fail('무효', '장애 주입 적용 증거가 없다', { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
  if (run.host && (run.host.cpuPct >= 85 || run.host.procsRunning > run.host.logicalCpus)) {
    return { ...fail('무효', '호스트가 포화됐다', { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
  }

  if (spec.load) {
    const g = run.generator ?? {};
    if (g.droppedIterations > 0) return { ...fail('무효', `발생기 dropped_iterations ${g.droppedIterations}`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    if (g.cpuPct > 80) return { ...fail('무효', `발생기 CPU ${g.cpuPct}%`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    if (g.memPct > 90) return { ...fail('무효', `발생기 메모리 ${g.memPct}%`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    if (!(run.httpReqs > 0)) return { ...fail('무효', '본구간 http_reqs가 0이다', { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
  }

  if (spec.k8Interval) {
    const iv = run.intervals ?? {};
    for (const key of ['scrapeSec', 'evalSec', 'groupWaitSec', 'forSec']) {
      if (iv[key] !== spec.k8Interval[key]) return { ...fail('무효', `K8 간격 ${key}가 정본과 다르다(${iv[key]} != ${spec.k8Interval[key]})`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    }
    const burn = run.injection?.strength?.burnMultiple;
    if (typeof burn === 'number' && burn < GAMEDAY_DEFAULTS.k8BurnMultipleMin) {
      return { ...fail('판정 못 함', `소진 배수 ${burn}은 60초 탐지를 주장할 수 없다(기준 ${GAMEDAY_DEFAULTS.k8BurnMultipleMin})`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    }
  }

  const inv = run.invariants ?? {};
  if ((inv.oversell ?? 0) > 0 || (inv.doublePayment ?? 0) > 0 || (inv.admitBeforeTurn ?? 0) > 0) {
    return { ...fail('미달', '불변식 위반이 있다', { scenario: spec.id, invariants: inv }), detectionSec, propagationSec, alertDetected };
  }

  if (spec.k8Interval) {
    if (!alertDetected) return { ...fail('미달', '경보가 울리지 않았거나 탐지 경로가 경보가 아니다', { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    if (humanAt !== null && alertAt !== null && humanAt < alertAt) {
      return { ...fail('미달', '사람이 첫 경보보다 먼저 알았는데 탐지 경로를 경보로 적었다', { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    }
    if (detectionSec === null || detectionSec > GAMEDAY_DEFAULTS.detectLimitSec) {
      return { ...fail('미달', `탐지 ${detectionSec}초가 ${GAMEDAY_DEFAULTS.detectLimitSec}초를 넘었다`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    }
    if (obs.commandExpected) {
      if (propagationSec === null) return { ...fail('판정 못 함', '명령·ack 시각이 없다', { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
      if (propagationSec > GAMEDAY_DEFAULTS.propagationLimitSec) {
        return { ...fail('미달', `명령 전파 ${propagationSec}초가 ${GAMEDAY_DEFAULTS.propagationLimitSec}초를 넘었다`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
      }
    }
  }

  const checks = run.responseChecks ?? {};
  for (const key of RESPONSE_CHECKS) {
    const chk = checks[key];
    if (!chk || typeof chk.ok !== 'boolean' || typeof chk.evidence !== 'string' || chk.evidence.trim() === '') {
      return { ...fail('판정 못 함', `기대 대응 확인 ${key}의 증거가 없다`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    }
    if (chk.ok === false) return { ...fail('미달', `기대 대응 확인 ${key}가 실패했다`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
  }

  const timeline = run.timeline ?? {};
  for (const key of ['T0', 'T1', 'T1p', 'T2', 'T3', 'T4']) {
    if (typeof timeline[key] !== 'string' || timeline[key].trim() === '') {
      return { ...fail('판정 못 함', `timeline ${key}가 없다`, { scenario: spec.id }), detectionSec, propagationSec, alertDetected };
    }
  }

  return { verdict: '통과', reasons: [], detectionSec, propagationSec, alertDetected, details: { scenario: spec.id } };
}

export function judgeK8Results(results) {
  const list = Array.isArray(results) ? results : [];
  const ids = list.map((r) => r.scenario);
  const base = {
    detected: list.filter((r) => r.alertDetected === true).length,
    within60: list.filter((r) => typeof r.detectionSec === 'number' && r.detectionSec <= GAMEDAY_DEFAULTS.detectLimitSec).length,
    maxPropagationSec: list.reduce((m, r) => (typeof r.propagationSec === 'number' ? Math.max(m, r.propagationSec) : m), 0),
  };
  if (list.length !== 10 || new Set(ids).size !== 10 || !ALL_IDS.slice(0, 10).every((id) => ids.includes(id))) {
    return { verdict: '판정 못 함', reasons: ['K8 10종 결과가 모두 있지 않다'], ...base };
  }
  if (list.some((r) => r.verdict === '무효' || r.verdict === '판정 못 함')) return { verdict: '판정 못 함', reasons: ['무효·판정 못 함 결과가 있다'], ...base };
  if (list.some((r) => r.verdict === '미달')) return { verdict: '미달', reasons: ['미달 결과가 있다'], ...base };
  if (list.some((r) => r.verdict !== '통과')) return { verdict: '판정 못 함', reasons: ['K8 결과가 통과가 아니다'], ...base };
  return { verdict: '통과', reasons: [], ...base };
}

export function judgeK8(results) {
  return judgeK8Results(results);
}

function tableRow(label, value) {
  return `| ${label} | ${value ?? ''} |`;
}

export function renderPostmortem(input) {
  const pm = input ?? {};
  const followUps = Array.isArray(pm.followUps) ? pm.followUps : [];
  const lines = [
    `## ${pm.id ?? 'PM-??'} ${pm.title ?? ''}`.trim(),
    '',
    tableRow('선언 시각', pm.declaredAt),
    tableRow('끝 시각', pm.endedAt),
    tableRow('완료 시각', pm.completedAt),
    tableRow('첫 증상 시각', pm.firstSymptomAt),
    tableRow('첫 경보 시각', pm.firstAlertAt),
    tableRow('사람이 안 시각', pm.humanNoticedAt),
    tableRow('탐지 경로', pm.detectionPath),
    tableRow('주 원인 유형', pm.primaryCauseType),
    tableRow('구성 요소', pm.component),
    tableRow('기여 원인 유형', Array.isArray(pm.contributingCauseTypes) ? pm.contributingCauseTypes.join('·') : pm.contributingCauseTypes),
    tableRow('계기', pm.trigger),
    tableRow('영향', pm.impact?.summary),
    tableRow('예산 사용 비율', pm.impact?.budgetUsedRatio),
    tableRow('쓴 손잡이', pm.controlsUsed),
    tableRow('후속 조치', `${followUps.length}건`),
    tableRow('기타 사유', pm.otherCauseReason),
    '',
    '### 후속 조치',
    '',
  ];
  if (followUps.length === 0) lines.push('- 없음');
  else for (const f of followUps) lines.push(`- ${f.p0 ? '[P0] ' : ''}${f.title ?? '후속 조치'} — issue ${f.issue ?? ''}`.trim());
  return lines.join('\n');
}

function parseLabelTable(markdown) {
  const map = new Map();
  for (const line of markdown.split('\n')) {
    const m = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|$/.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    if (label === '칸' || /^-+$/.test(label)) continue;
    map.set(label, m[2].trim());
  }
  return map;
}

function parseIso(markdown, label) {
  const value = parseLabelTable(markdown).get(label);
  const t = ms(value);
  return t === null ? null : t;
}

function followUpSection(markdown) {
  const i = markdown.indexOf('### 후속 조치');
  if (i < 0) return [];
  return markdown.slice(i).split('\n').filter((l) => l.startsWith('- '));
}

export function validatePostmortem(markdown) {
  const errors = [];
  const rows = parseLabelTable(markdown);
  for (const field of POSTMORTEM_FIELDS) {
    if (!rows.has(field)) errors.push(`필수 칸이 없다: ${field}`);
    else if (field !== '기타 사유' && rows.get(field) === '') errors.push(`필수 칸이 비었다: ${field}`);
  }
  const cause = rows.get('주 원인 유형') ?? '';
  if (!CAUSE_TYPES.includes(cause)) errors.push(`주 원인 유형이 정본 9+기타가 아니다: ${cause}`);
  const contributing = CAUSE_TYPES.filter((c) => (rows.get('기여 원인 유형') ?? '').includes(c));
  for (const c of contributing) if (!CAUSE_TYPES.includes(c)) errors.push(`기여 원인 유형이 정본 밖이다: ${c}`);
  if (cause === '기타' || contributing.includes('기타')) {
    if (!rows.get('기타 사유')) errors.push("'기타'에는 사유가 필요하다");
  }
  const detectionPath = rows.get('탐지 경로') ?? '';
  if (!DETECTION_PATHS.includes(detectionPath)) errors.push(`탐지 경로가 경보·사람·외부가 아니다: ${detectionPath}`);
  const component = rows.get('구성 요소') ?? '';
  if (!component) errors.push('구성 요소가 비었다');
  if (/[·,/]/.test(component)) errors.push(`구성 요소는 하나여야 한다: ${component}`);

  const firstAlert = ms(rows.get('첫 경보 시각'));
  const human = ms(rows.get('사람이 안 시각'));
  if (detectionPath === '경보' && firstAlert !== null && human !== null && human < firstAlert) {
    errors.push('사람이 첫 경보보다 먼저 알았는데 탐지 경로가 경보다');
  }

  const ended = ms(rows.get('끝 시각'));
  const completed = ms(rows.get('완료 시각'));
  if (ended === null || completed === null) errors.push('끝 시각·완료 시각이 필요하다');
  else if (completed - ended > GAMEDAY_DEFAULTS.postmortemDueHours * 3600_000) errors.push('포스트모템이 48시간을 넘겼다');

  const budget = Number(rows.get('예산 사용 비율'));
  const followUps = followUpSection(markdown);
  if (followUps.length === 0 || followUps.some((l) => l === '- 없음')) errors.push('후속 조치가 하나 이상 필요하다');
  for (const line of followUps) {
    if (line === '- 없음') continue;
    if (!/#\d+|https?:\/\//.test(line)) errors.push(`후속 조치에 GitHub Issues 링크가 없다: ${line}`);
  }
  if (Number.isFinite(budget) && budget > GAMEDAY_DEFAULTS.budgetP0Ratio) {
    if (!followUps.some((l) => l.includes('[P0]'))) errors.push('28일 예산 20% 초과 사고에는 P0 후속 조치가 필요하다');
  }
  return { ok: errors.length === 0, errors };
}

export const SLO_KPI_TARGETS = Object.freeze([
  { id: 'SLO-NFR-001', name: '대기열 진입', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-002', name: '대기 상태 전파', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-003', name: '좌석 홀드', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-004', name: '좌석 상태 전파', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-005', name: '결제 주문 접수', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-006', name: '결제 최종 확정', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-007', name: '공연 정보 페이지', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-008', name: '관제 제어 명령', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-009', name: '관제 실시간 표 반영', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-010', name: '현장 게이트 판정', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-011', name: '기본 인프라 SLO', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SLO-NFR-012', name: '사용자 체감 성능', norm: 'docs/observability.md §4', hasTarget: true },
  { id: 'SESSION-TIME', name: '세션 시간(평균 체류 180초)', norm: 'docs/architecture.md §9.1', hasTarget: true },
  { id: 'KPI-SELLOUT-MINUTES', name: '매진 소요 시간', norm: 'docs/planning/01-overview.md §3.2', hasTarget: true },
  { id: 'KPI-CONVERSION', name: '입장 → 구매 전환율', norm: 'docs/planning/01-overview.md §3.2', hasTarget: true },
  { id: 'KPI-BOT-SHARE', name: '봇 점유율', norm: 'docs/planning/01-overview.md §3.2', hasTarget: true },
  { id: 'KPI-BOT-TRAFFIC-RATIO', name: '봇 트래픽 비율(관측)', norm: 'docs/planning/01-overview.md §3.2', hasTarget: false },
  { id: 'KPI-CS-VOLUME', name: '예상 CS 건수', norm: 'docs/planning/01-overview.md §3.2', hasTarget: true },
  { id: 'KPI-FIRST-IDENTITY', name: '오픈 후 처음 본인확인 비율(관측)', norm: 'docs/planning/01-overview.md §3.2', hasTarget: false },
  { id: 'KPI-ONSALE-COST', name: '온세일 1회·1,000장당 비용', norm: 'docs/planning/01-overview.md §3.2', hasTarget: true },
]);

const SLO_KPI_BY_ID = new Map(SLO_KPI_TARGETS.map((t) => [t.id, t]));

export function renderSloKpiAdr() {
  const lines = [
    '# ADR 초안: SLO·세션 시간·비즈니스 KPI 최종 목표(미측정)',
    '',
    '- **상태**: 초안. 측정 전이라 모든 목표 결정을 `보류`로 둔다. 실제 실행 ID나 `docs/` 인용이 생기면 유지·조정을 정한다.',
    '- **정본**: `docs/observability.md` §4, `docs/architecture.md` §9.1, `docs/planning/01-overview.md` §3.2.',
    '',
    '| ID | 이름 | 정본 위치 | 현재 목표 | 이번 측정 | 결정 | 근거·되돌릴 조건 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const t of SLO_KPI_TARGETS) lines.push(`| ${t.id} | ${t.name} | ${t.norm} | 정본 값(위치 참조) | 미측정 | 보류 | — |`);
  return lines.join('\n');
}

export function validateSloKpiAdr(markdown, options = {}) {
  const errors = [];
  const rows = new Map();
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| SLO-') && !line.startsWith('| SESSION-TIME |') && !line.startsWith('| KPI-')) continue;
    const cells = line.split('|').slice(1, -1).map((s) => s.trim());
    if (cells.length !== 7) {
      errors.push(`ADR 줄이 7칸이 아니다: ${line}`);
      continue;
    }
    const [id, name, norm, , measurement, decision, evidence] = cells;
    if (rows.has(id)) errors.push(`ADR 줄이 중복됐다: ${id}`);
    rows.set(id, { id, name, norm, measurement, decision, evidence });
  }
  if (rows.size !== SLO_KPI_TARGETS.length) errors.push(`ADR 줄이 ${SLO_KPI_TARGETS.length}개가 아니다: ${rows.size}`);
  for (const target of SLO_KPI_TARGETS) {
    const row = rows.get(target.id);
    if (!row) {
      errors.push(`ADR 줄이 없다: ${target.id}`);
      continue;
    }
    if (!['유지', '조정', '보류'].includes(row.decision)) errors.push(`결정이 유지·조정·보류가 아니다: ${target.id} ${row.decision}`);
    if (!options.measured) {
      if (row.measurement !== '미측정') errors.push(`측정 전인데 이번 측정이 미측정이 아니다: ${target.id}`);
      if (row.decision !== '보류') errors.push(`측정 전인데 결정이 보류가 아니다: ${target.id}`);
      if (row.evidence !== '—') errors.push(`측정 전인데 근거가 —가 아니다: ${target.id}`);
      continue;
    }
    if (row.decision === '보류') continue;
    if (row.measurement === '미측정') errors.push(`근거 없이 ${row.decision}할 수 없다: ${target.id}`);
    if (!row.evidence || row.evidence === '—') errors.push(`근거가 비었다: ${target.id}`);
    if (row.decision === '조정' && !target.hasTarget) errors.push(`목표가 없는 관측 지표는 조정할 수 없다: ${target.id}`);
    if (row.decision === '조정' && !row.evidence.includes('되돌릴 조건')) errors.push(`조정에는 되돌릴 조건이 필요하다: ${target.id}`);
    if (!row.evidence.startsWith('docs/')) {
      const runIds = row.evidence.match(/20\d{2}-\d{2}-\d{2}-[A-Za-z0-9._-]+/g) ?? [];
      if (runIds.length === 0) errors.push(`근거가 docs/ 인용도 실행 ID도 아니다: ${target.id}`);
      for (const id of runIds) {
        if (typeof options.runExists === 'function' && !options.runExists(id)) errors.push(`없는 실행 ID다: ${id}`);
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    rows: rows.size,
    decisions: SLO_KPI_TARGETS.map((t) => rows.get(t.id)?.decision ?? ''),
    measurements: SLO_KPI_TARGETS.map((t) => rows.get(t.id)?.measurement ?? ''),
    evidences: SLO_KPI_TARGETS.map((t) => rows.get(t.id)?.evidence ?? ''),
  };
}

function section(markdown, start, end) {
  const i = markdown.indexOf(start);
  if (i < 0) return '';
  const j = markdown.indexOf(end, i + start.length);
  return markdown.slice(i, j < 0 ? markdown.length : j);
}

function parsePipes(line) {
  return line.split('|').slice(1, -1).map((s) => s.trim());
}

const FORBIDDEN_CLAIMS = Object.freeze([
  /30,000건\/초.*(달성|통과)/,
  /100만.*(달성|통과)/,
  /K[127][^\n]*0건/,
]);

export function renderGamedayReport() {
  const lines = [
    '# F-08-6 Game Day 전체 재실행 보고서(측정 창 4d~4g)',
    '',
    '- **상태**: 미측정. Game Day 33종을 아직 실행하지 않았다.',
    '- **정본**: `docs/observability.md` §4·§5·§12, `docs/verification.md` §5.2, `docs/perf-ledger.md` §2.1·§7·§8.',
    '- **한 줄 결론**: 미측정. 아래 표의 판정은 모두 `미측정`이다. 30,000건/초·100만·K1/K2/K7의 새 수치를 주장하지 않는다.',
    '',
    '## 1. 실행 표',
    '',
    '| 시나리오 | 창 | 실행 방식 | 증거 수준 | 주입 | 판정 | 증거 | 비고 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of GAMEDAY_SCENARIOS) {
    lines.push(`| ${s.id} | ${WINDOW_BY_ID[s.id]} | ${s.mode} | ${s.evidence} | 미측정 | 미측정 | — | ${s.stageReady ? '' : s.stageMissing.join('·')} |`);
  }
  lines.push(
    '',
    '## 2. K8 탐지·전파',
    '',
    '| 시나리오 | 탐지(초) | 전파(초) | 판정 | 표시 |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const id of ALL_IDS.slice(0, 10)) lines.push(`| ${id} | 미측정 | 미측정 | 미측정 | 미측정 |`);
  lines.push(
    '',
    '## 3. 포스트모템·인시던트',
    '',
    '- 선언한 인시던트: 0',
    '',
    '| 인시던트 | 시나리오 | 선언 시각 | 끝 시각 | 완료 시각 | 예산 비율 | P0 | 포스트모템 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '',
    '## 4. 선행 측정 인용(다시 재지 않음)',
    '',
    '| 기능 | 항목 | 상태 | 근거 |',
    '| --- | --- | --- | --- |',
    '| F-08-5 | NFR-027·V-T10 | 무효·미측정 | `docs/review/measurements/F-08-5-soak.md` |',
    '| F-08-9 | V-T27·V-T28·P-T1·SR-T13·NFR-028 | 판정 못 함(무효·부분) | F-08-9 계획·측정 보고서(다른 워크트리) |',
    '| F-08-10 | V-T18 | 미측정 | BUILD_ORDER F-08-10 |',
    '',
    '## 5. 한계',
    '',
    '- demo 스택은 `bundle` 한 파드·Valkey 단일이라 G-02·G-07·G-09·G-14·G-25·G-29·G-30을 낼 수 없다.',
    '- G-26과 모의 진행 4종은 `설계만`이다. 33종을 실행하기 전에는 어떤 판정도 통과가 아니다.',
    '',
    '## 6. 장부·게이트',
    '',
    '- `node tools/ci/ledger.mjs --batch F-08-6 --require`: 항목 0.',
    '- `node --test loadtest/test/f086-gameday.test.mjs`: 구현 뒤 8/8.',
    '',
    '## 7. 주장하지 않는 것',
    '',
    '- 30,000건/초·100만·K1/K2/K7 0을 이 기능의 결과로 주장하지 않는다.',
    '- F-08-5 queue 4a `무효`, F-08-9 `판정 못 함(무효·부분)`을 Game Day 통과로 쓰지 않는다.',
    '',
  );
  return lines.join('\n');
}

export function validateGamedayReport(markdown, options = {}) {
  const errors = [];
  const runExists = typeof options.runExists === 'function' ? options.runExists : () => false;
  const runResponseOk = typeof options.runResponseOk === 'function' ? options.runResponseOk : () => false;
  const postmortemExists = typeof options.postmortemExists === 'function' ? options.postmortemExists : () => false;
  const postmortemOk = typeof options.postmortemOk === 'function' ? options.postmortemOk : () => false;

  const exec = section(markdown, '## 1.', '## 2.');
  const rows = exec.split('\n').filter((l) => l.startsWith('| G-'));
  const seen = new Set();
  let passed = 0;
  for (const line of rows) {
    const cells = parsePipes(line);
    if (cells.length !== 8) {
      errors.push(`실행 표 줄이 8칸이 아니다: ${line}`);
      continue;
    }
    const [id, window, mode, evidence, , verdict, runId] = cells;
    if (!ALL_IDS.includes(id)) errors.push(`모르는 시나리오: ${id}`);
    if (seen.has(id)) errors.push(`시나리오가 중복됐다: ${id}`);
    seen.add(id);
    const spec = SCENARIO_BY_ID.get(id);
    if (!VERDICTS.includes(verdict)) errors.push(`판정값이 아니다: ${id} ${verdict}`);
    if (verdict === '통과') {
      passed += 1;
      if (!spec) errors.push(`카탈로그에 없는 시나리오가 통과했다: ${id}`);
      else {
        if (spec.mode === '모의 진행' || spec.evidence === '설계만' || !spec.stageReady) errors.push(`모의·설계만·무대 없음이 통과했다: ${id}`);
        if (mode !== spec.mode) errors.push(`실행 방식이 정본과 다르다: ${id}`);
        if (evidence !== '측정함') errors.push(`증거 수준이 측정함이 아니다: ${id}`);
        if (!runId || runId === '—') errors.push(`실행 ID가 없다: ${id}`);
        else {
          if (!runExists(runId)) errors.push(`없는 실행 ID다: ${id} ${runId}`);
          if (!runResponseOk(runId)) errors.push(`기대 대응 증거가 없는 실행이다: ${id} ${runId}`);
        }
      }
    }
    if (options.measured === false && verdict !== '미측정') errors.push(`측정 전 보고서에 미측정이 아닌 판정이 있다: ${id} ${verdict}`);
    if (!spec && window) errors.push(`창을 찾지 못했다: ${id}`);
  }
  if (seen.size !== ALL_IDS.length) errors.push(`실행 표가 33종이 아니다: ${seen.size}`);
  for (const id of ALL_IDS) if (!seen.has(id)) errors.push(`실행 표에 없다: ${id}`);

  const priorText = section(markdown, '## 4.', '## 5.');
  const prior = {};
  for (const line of priorText.split('\n')) {
    if (!line.startsWith('| F-08-')) continue;
    const cells = parsePipes(line);
    if (cells.length >= 3) prior[cells[0].replace('F-08-', 'f08').replace(/-/g, '')] = cells[2];
  }
  const priorMap = {
    f085: prior.f085 ?? '',
    f089: prior.f089 ?? '',
    f0810: prior.f0810 ?? '',
  };
  if (priorMap.f085 !== GAMEDAY_PRIOR_MEASUREMENTS['F-08-5']) errors.push(`F-08-5 선행 상태가 다르다: ${priorMap.f085}`);
  if (priorMap.f089 !== GAMEDAY_PRIOR_MEASUREMENTS['F-08-9']) errors.push(`F-08-9 선행 상태가 다르다: ${priorMap.f089}`);
  if (priorMap.f0810 !== GAMEDAY_PRIOR_MEASUREMENTS['F-08-10']) errors.push(`F-08-10 선행 상태가 다르다: ${priorMap.f0810}`);
  if (Object.values(priorMap).some((v) => v.includes('통과'))) errors.push('선행 측정을 통과로 적었다');

  for (const re of FORBIDDEN_CLAIMS) if (re.test(markdown)) errors.push(`금지 수치 주장이 있다: ${re}`);

  const incidentText = section(markdown, '## 3.', '## 4.');
  const incidentRows = incidentText.split('\n').filter((l) => l.startsWith('| I-'));
  for (const line of incidentRows) {
    const cells = parsePipes(line);
    if (cells.length !== 8) {
      errors.push(`인시던트 표 줄이 8칸이 아니다: ${line}`);
      continue;
    }
    const [, , , endedAt, completedAt, budgetText, p0, postmortem] = cells;
    if (!postmortem || postmortem === '—') errors.push('인시던트에 포스트모템 경로가 없다');
    else {
      if (!postmortemExists(postmortem)) errors.push(`포스트모템 파일이 없다: ${postmortem}`);
      if (!postmortemOk(postmortem)) errors.push(`포스트모템이 48시간·P0 규칙을 어겼다: ${postmortem}`);
    }
    const ended = ms(endedAt);
    const completed = ms(completedAt);
    if (ended === null || completed === null) errors.push('인시던트 끝·완료 시각이 필요하다');
    else if (completed - ended > GAMEDAY_DEFAULTS.postmortemDueHours * 3600_000) errors.push('인시던트 포스트모템이 48시간을 넘겼다');
    const budget = Number(budgetText);
    if (Number.isFinite(budget) && budget > GAMEDAY_DEFAULTS.budgetP0Ratio && p0 !== '예') errors.push('28일 예산 20% 초과 인시던트에 P0가 없다');
  }

  return { ok: errors.length === 0, errors, scenarios: seen.size, passed, incidents: incidentRows.length, prior: priorMap };
}

/** collect.py에 넘길 인자(실제 실행 증거가 있을 때만 run.mjs가 부른다) */
export function gamedayCollectArgs({ runId, outDir, verdict, reasons = [], notes = '' }) {
  const args = [
    'tools/perf-ledger/collect.py',
    '--run-id', runId,
    '--kpi', 'MSR-060',
    '--version', 'v1',
    '--profile', 'local-gameday',
    '--scenario', 'v1 gameday',
    '--timeline', `${outDir}/timeline.csv`,
    '--invariants', `${outDir}/invariants.csv`,
    '--extra', `gameday=${notes || 'Game Day'}`,
    '--evidence', '측정함',
    '--notes', notes || 'Game Day',
  ];
  if (verdict === '통과') args.push('--verdict', 'pass');
  else if (verdict === '미달') args.push('--verdict', 'fail');
  else args.push('--invalid-reason', reasons.join('; ') || verdict);
  return args;
}
