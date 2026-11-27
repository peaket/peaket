// F-08-15 동결 로컬 트랙: 보내기 비교·Sentry vs GlitchTip 판정·M4 블로그 2편 초안 도구.
//
// 정본: docs/observability.md §1·§11, docs/perf-ledger.md §11, docs/verification.md §3.10,
//       docs/blog/README.md, ADR-0067·0068·0356.
// 계획: docs/review/plans/F-08-15.md §6~§8.
// 이 파일은 실제 전송·계정 생성·Sentry/GlitchTip 설치·Docker·kind·k6·브라우저를 쓰지 않는다.
// 판정은 미측정/판정 못 함, 비용은 [추정]/미계산만 낸다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

export class UsageError extends Error {
  name = 'UsageError';
}

export const F0815_WINDOWS = Object.freeze(['3h']);
export const F0815_STEPS = Object.freeze([
  Object.freeze({ id: '3h-1', name: '보내기 비교', hours: 1.5 }),
  Object.freeze({ id: '3h-2', name: 'Sentry vs GlitchTip', hours: 1.5 }),
  Object.freeze({ id: '3h-3', name: 'M4 목차·보고', hours: 1 }),
]);
export const F0815_VERDICTS = Object.freeze(['통과', '미달', '판정 못 함', '무효', '미측정']);

export const F0815_REASONS = Object.freeze({
  NO_SEND: '전송하지 않았다',
  NO_RUN: '전송 실행 산출물이 없다',
  R1_UNMEASURED: 'R1(콘솔 갱신·조회 한도)을 재지 않았다',
  R1_FAIL: 'R1에서 직접 운영을 고른다',
  R2_INPUT_MISSING: 'R2 비용 입력이 없다',
  R2_SENSITIVITY_MISSING: 'R2 1.5배 민감도 입력이 없다',
  R3_NOT_READY: 'R3 개인정보 국외 이전 요건이 준비되지 않았다',
  WITHIN_10PCT: '1.5배 값 기준 10% 안이다',
  OVER_10PCT: '1.5배 값 기준 10%를 넘는다',
  DIRECT_CHEAPER: '직접 운영이 더 싸다',
  SENSITIVE_TO_OPS_HOURS: '1.5배 운영 시간에서 순위가 뒤집힌다',
  OWNER_NOT_APPROVED: '소유자 승인이 없다',
  PEAK_UNMEASURED: '온세일 오류 피크를 재지 않았다',
  API_UNCONFIRMED: '콘솔 요약 API 지원을 확인하지 못했다',
  AVAILABILITY_RISK: '단일 서버 가용성 위험이 확인되지 않았다',
  COST_MISSING: '연간 비용이 미계산이다',
  STORAGE_MISSING: '저장 GB 입력이 없다',
  TIER2_NOT_MODELED: '20억 샘플 초과 가격 구간은 계산하지 않는다',
});

export const F0815_SEND = Object.freeze({
  freeSamples: 40_000_000,
  blockSamples: 10_000_000,
  ingestUsdPerBlock: 0.90,
  storageFreeGb: 10,
  storageUsdPerGbMonth: 0.03,
  queryFreeSamples: 200_000_000_000,
  queryUsdPer1B: 0.10,
  maxSamplesPerMonth: 2_000_000_000,
  priceDate: '2026-10-14',
  display: '[추정]',
});

export const F0815_AMP_PRICES = Object.freeze({
  source: 'docs/perf-ledger.md §11.3',
  priceDate: '2026-10-14',
  ingestion: '4천만 무료, 20억까지 1천만 샘플당 0.90달러',
  storage: '10GB 무료, GB·월 0.03달러',
  query: '2천억 무료, 10억 샘플당 0.10달러',
});

export const F0815_SENTRY_CANDIDATES = Object.freeze([
  Object.freeze({
    id: 'sentry-cloud',
    name: 'Sentry 클라우드',
    overseas: true,
    singlePoint: false,
    freeTier: Object.freeze({ users: 1, errorsPerMonth: 5_000, replays: 50, alerts: 'email' }),
    paidUsdPerMonthAnnual: 26,
    paidErrorsPerMonth: 50_000,
    apiFree: '미확인',
    apiPaid: 'Team',
  }),
  Object.freeze({
    id: 'sentry-self-hosted',
    name: 'Sentry 직접 설치',
    overseas: false,
    singlePoint: true,
    composeMemoryGb: 16,
    swapGb: 16,
    scalingGuide: false,
  }),
  Object.freeze({
    id: 'glitchtip-self-hosted',
    name: 'GlitchTip 직접 설치',
    overseas: false,
    singlePoint: true,
    license: 'MIT',
    postgresMin: 14,
    memoryMb: 512,
    valkey: '선택',
    helm: true,
    api: '미확인',
  }),
]);

export const F0815_SENTRY_CRITERIA = Object.freeze([
  Object.freeze({ id: 'overseas', label: '① 국외 이전 요건', question: '국외 이전 요건을 갖췄는가? 직접 설치는 국내 보관이라 해당 없다' }),
  Object.freeze({ id: 'error-peak', label: '② 온세일 오류 피크', question: '클라이언트 표본 뒤 오류 피크를 받는가?' }),
  Object.freeze({ id: 'availability', label: '③ 가용성', question: '단일 서버가 멈출 때 무엇을 잃는가?' }),
  Object.freeze({ id: 'console-api', label: '④ 콘솔 요약 API', question: '새 오류 종류 수·상위 5개 질의를 지원하는가?' }),
  Object.freeze({ id: 'annual-cost', label: '⑤ 연간 총비용', question: '연간 총비용이 가장 낮은가?' }),
]);

export const F0815_SENTRY_LOCK = Object.freeze({
  sendDefaultPii: false,
  dataCollection: Object.freeze({
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: Object.freeze([]),
    urlQueryParams: false,
    graphQL: Object.freeze({ document: false, variables: false }),
    genAI: Object.freeze({ inputs: false, outputs: false }),
  }),
  traceLifecycle: 'static',
  sendClientReports: false,
  maxBreadcrumbs: 0,
  attachStacktrace: false,
  beforeSend: 'lockEvent',
  userRef: 'accountRef',
  replay: false,
  tracing: false,
  piiPatterns: 'packages/platform/src/pii-patterns.json',
  dsnEnv: 'PEAKET_SENTRY_DSN',
});

export const F0815_M4_DRAFTS = Object.freeze([
  Object.freeze({
    id: 'm4-control-gameday',
    title: '관제 명령과 Game Day',
    kpis: Object.freeze(['K8']),
    measuredKpis: Object.freeze([]),
    designOnlyKpis: Object.freeze([]),
    pendingKpis: Object.freeze(['K8']),
    evidence: Object.freeze(['F-08-14', 'F-08-13']),
    status: 'draft',
    publish: 'owner',
    claims: Object.freeze([]),
  }),
  Object.freeze({
    id: 'm4-scaling-cost',
    title: '확장 시간과 비용',
    kpis: Object.freeze(['K9']),
    measuredKpis: Object.freeze([]),
    designOnlyKpis: Object.freeze([]),
    pendingKpis: Object.freeze(['K9']),
    evidence: Object.freeze(['F-08-14']),
    status: 'draft',
    publish: 'owner',
    claims: Object.freeze([]),
  }),
]);

export const F0815_PRIOR_MEASUREMENTS = Object.freeze({
  'F-08-5': '무효·미측정',
  'F-08-9': '판정 못 함(무효·부분)',
  'F-08-10': '미측정',
  'F-08-12': '미측정',
  'F-08-13': '설계만·판정 못 함',
  'F-08-14': '미측정',
});

export const F0815_DEPENDENCY = Object.freeze({
  feature: 'F-08-14',
  status: '미측정',
  inputs: Object.freeze(['K8', 'K9', 'series', 'samplesPerSecond', 'logGbPerDay', 'traceGbPerDay', 'nodes', 'consoleUsers', 'backendR2']),
});

export const F0815_BOUNDARIES = Object.freeze([
  Object.freeze({ feature: 'F-08-14', owns: 'K8·K9·관측 백엔드 비교 계산' }),
  Object.freeze({ feature: 'F-08-6', owns: 'Game Day 33종·gameday.mjs·SLO/KPI ADR' }),
  Object.freeze({ feature: 'F-08-13', owns: '모의 진행·복원 연습' }),
  Object.freeze({ feature: 'F-08-12', owns: '14종 로컬 실행' }),
  Object.freeze({ feature: 'F-08-10', owns: 'V-T18·M2' }),
]);

export const F0815_STOP_RULES = Object.freeze([
  Object.freeze({ id: 'STOP-01', rule: '외부 계정을 만들거나 자료를 보내려 한다(Datadog·AMP·AMG·Sentry·GlitchTip)' }),
  Object.freeze({ id: 'STOP-02', rule: 'PEAKET_SENTRY_DSN을 채우거나 Sentry SDK를 켜려 한다' }),
  Object.freeze({ id: 'STOP-03', rule: '보내지 않았는데 전송·실행 ID를 적는다' }),
  Object.freeze({ id: 'STOP-04', rule: '계산값을 실측·청구서로 적는다' }),
  Object.freeze({ id: 'STOP-05', rule: '오류 피크·API 범위를 확인 없이 통과로 적는다' }),
  Object.freeze({ id: 'STOP-06', rule: '2차 마스킹 원천을 옮겨 적거나 새 정규식을 만든다' }),
  Object.freeze({ id: 'STOP-07', rule: 'M4 초안에 측정값·달성·게시를 적는다' }),
  Object.freeze({ id: 'STOP-08', rule: '개인 식별자·연락처·내부 주소가 기록에 들어간다' }),
  Object.freeze({ id: 'STOP-09', rule: 'Docker·kind·k6·브라우저를 쓰려 한다' }),
  Object.freeze({ id: 'STOP-10', rule: '감독이 중단을 지시했거나 실제 외부 피해·개인정보 노출이 의심된다' }),
]);

export const F0815_OUTSIDE = Object.freeze(['K8', 'K9', 'V-T18', 'V-T27', 'V-T28', 'P-T1', 'SR-T13', 'NFR-028', 'Q-T2', 'S-T1', 'V-T10', 'NFR-027', 'V-T4', 'V-T5', 'V-T17']);

export const F0815_ARTIFACTS = Object.freeze(['send-budget.json', 'sentry-criteria.json', 'manifest.json']);

export const F0815_DEFAULTS = Object.freeze({
  hours: 4,
  freeSamples: 40_000_000,
  keepWithinRatio: 0.10,
  errorPeakSev3Min: 5,
  collectionZeroSev3Min: 5,
});

export const F0815_EXTERNAL_SEND = false;
export const F0815_CLOUD_COST = false;
export const F0815_DOCKER_USED = false;

const FORBIDDEN = Object.freeze(['30k/s', '30,000건/초', '100만', 'K1', 'K2', 'K7']);
const STRONG_NEG = Object.freeze(['주장하지 않', '금지', '범위 밖', '위반', '쓰지 않', '하지 않는다', '아니다', '없다', '닫지 않', '바꾸지 않']);

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function requireInteger(value, name, { min = 1 } = {}) {
  if (!isInteger(value) || value < min) throw new UsageError(`${name}은 ${min} 이상의 정수여야 한다: ${value}`);
  return value;
}

function requireFinite(value, name, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new UsageError(`${name}은 ${min} 이상의 유한한 수여야 한다: ${value}`);
  return value;
}

function sentences(line) {
  return line.split(/(?<=다\.)\s+|(?<=[.!?])\s+/).filter(Boolean);
}

/** 금지 수치는 같은 문장의 명시적 부정 안에서만 인용할 수 있다. '미측정' 한 단어는 면제하지 않는다. */
export function forbiddenOutsideNegation(text) {
  const hits = [];
  for (const line of String(text ?? '').split('\n')) {
    for (const sentence of sentences(line)) {
      if (STRONG_NEG.some((neg) => sentence.includes(neg))) continue;
      for (const token of FORBIDDEN) if (sentence.includes(token)) hits.push(`${token}: ${sentence}`);
    }
  }
  return hits;
}

const PII_SOURCE = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages', 'platform', 'src', 'pii-patterns.json'), 'utf8'));
const PII_PATTERNS = PII_SOURCE.patterns.map((p) => new RegExp(p.pattern, 'g'));

/** 2차 마스킹 원천(pii-patterns.json)의 꼴만 본다. 사설 IP는 이 함수가 보지 않는다. */
export function containsPii(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return PII_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/** 보고서 위생용 내부 주소 검사. PII(pii-patterns.json)와 분리한다. */
export function containsInternalAddress(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const checks = [
    /(?<![\d.])10\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/,
    /(?<![\d.])172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}(?![\d.])/,
    /(?<![\d.])192\.168\.\d{1,3}\.\d{1,3}(?![\d.])/,
    /(?<![\d.])127\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.])/,
    /(?<![\d.])169\.254\.\d{1,3}\.\d{1,3}(?![\d.])/,
    /(^|[^\w:])::1($|[^\w:])/,
    /\bfe80:/i,
    /\blocalhost\b/i,
    /\b[a-z0-9-]+\.(?:internal|local)\b/i,
  ];
  return checks.some((re) => re.test(text));
}

/** 보낼 샘플 = 시계열 × (86,400 ÷ 긁기 간격) × 날수. 정수만 받는다. */
export function samplesFor({ series, days, scrapeSec } = {}) {
  requireInteger(series, 'series');
  requireInteger(days, 'days');
  requireInteger(scrapeSec, 'scrapeSec');
  if (86_400 % scrapeSec !== 0) throw new UsageError(`scrapeSec은 86,400을 나누어야 한다: ${scrapeSec}`);
  return series * (86_400 / scrapeSec) * days;
}

/** AMP 무료 등급 40,000,000 샘플 경계. */
export function judgeSampleBudget({ samples } = {}) {
  requireInteger(samples, 'samples', { min: 0 });
  const withinFree = samples <= F0815_SEND.freeSamples;
  return {
    samples,
    withinFree,
    overBy: Math.max(0, samples - F0815_SEND.freeSamples),
    needRelabel: !withinFree,
    display: F0815_SEND.display,
  };
}

/**
 * AMP 연간 비용. 가격표의 1천만 샘플·10GB·10억 샘플 단가를 비례 환산하고 올림하지 않는다.
 * 입력이 없으면 `{ok:false, display:'미계산', reason}`을 돌려준다. 음수·NaN은 UsageError다.
 */
export function ampAnnualCost({ samplesPerMonth, storageGb, querySamplesPerMonth } = {}) {
  requireFinite(samplesPerMonth, 'samplesPerMonth');
  requireFinite(querySamplesPerMonth, 'querySamplesPerMonth');
  if (storageGb === undefined || storageGb === null) {
    return { ok: false, display: '미계산', reason: 'STORAGE_MISSING' };
  }
  requireFinite(storageGb, 'storageGb');
  if (samplesPerMonth > F0815_SEND.maxSamplesPerMonth) {
    return { ok: false, display: '미계산', reason: 'TIER2_NOT_MODELED' };
  }
  const ingestionMonthly = (Math.max(0, samplesPerMonth - F0815_SEND.freeSamples) / F0815_SEND.blockSamples) * F0815_SEND.ingestUsdPerBlock;
  const storageMonthly = Math.max(0, storageGb - F0815_SEND.storageFreeGb) * F0815_SEND.storageUsdPerGbMonth;
  const queryMonthly = (Math.max(0, querySamplesPerMonth - F0815_SEND.queryFreeSamples) / 1_000_000_000) * F0815_SEND.queryUsdPer1B;
  const ingestionUsd = ingestionMonthly * 12;
  const storageUsd = storageMonthly * 12;
  const queryUsd = queryMonthly * 12;
  return {
    ok: true,
    ingestionUsd,
    storageUsd,
    queryUsd,
    totalUsd: ingestionUsd + storageUsd + queryUsd,
    display: F0815_SEND.display,
    priceDate: F0815_SEND.priceDate,
  };
}

function ratioCheaper(directUsd, otherUsd) {
  if (!(directUsd > 0)) throw new UsageError(`directUsd는 0보다 커야 한다: ${directUsd}`);
  return (directUsd - otherUsd) / directUsd;
}

function decideChoice({ directAnnualUsd, datadogAnnualUsd, directAnnualUsd15, datadogAnnualUsd15 }) {
  const ratio15 = ratioCheaper(directAnnualUsd15, datadogAnnualUsd15);
  const ratio1 = ratioCheaper(directAnnualUsd, datadogAnnualUsd);
  if (ratio15 <= 0) return { choice: 'keep-direct', reasons: ['DIRECT_CHEAPER'] };
  if (ratio15 <= F0815_DEFAULTS.keepWithinRatio) return { choice: 'keep-direct', reasons: ['WITHIN_10PCT'] };
  const reasons = ['OVER_10PCT'];
  // 1배에서는 10% 안이거나 직접 운영이 쌌는데 1.5배에서 뒤집힌 경우다.
  if (ratio1 <= F0815_DEFAULTS.keepWithinRatio) reasons.push('SENSITIVE_TO_OPS_HOURS');
  return { choice: 'review-datadog', reasons };
}

/** 보내기 비교 판정. 실제 전송 산출물이 없으면 미측정/무효이고, 증거가 모자라면 판정 못 함이다. */
export function judgeSendComparison(input = {}) {
  if (input.sent !== true) return { verdict: '미측정', reasons: ['NO_SEND'], choice: null };
  if (!input.runId || input.runExists !== true || input.manifest !== true) return { verdict: '무효', reasons: ['NO_RUN'], choice: null };
  if (input.r1Measured !== true) return { verdict: '판정 못 함', reasons: ['R1_UNMEASURED'], choice: null };
  if (input.queryLimitFits === false) return { verdict: '판정 못 함', reasons: ['R1_FAIL'], choice: 'keep-direct' };
  if (input.personalData === true && input.transferReady !== true) return { verdict: '판정 못 함', reasons: ['R3_NOT_READY'], choice: 'keep-direct' };
  if (!Number.isFinite(input.directAnnualUsd) || !Number.isFinite(input.datadogAnnualUsd)) {
    return { verdict: '판정 못 함', reasons: ['R2_INPUT_MISSING'], choice: null };
  }
  if (!Number.isFinite(input.directAnnualUsd15) || !Number.isFinite(input.datadogAnnualUsd15)) {
    return { verdict: '판정 못 함', reasons: ['R2_SENSITIVITY_MISSING'], choice: null };
  }
  const decided = decideChoice(input);
  if (input.ownerApproved !== true) {
    return { verdict: '판정 못 함', reasons: [...decided.reasons, 'OWNER_NOT_APPROVED'], choice: decided.choice };
  }
  return { verdict: '통과', reasons: decided.reasons, choice: decided.choice };
}

/** R1·R3·R2와 1.5배 기준 10% 유지 규칙만 보는 선택 판정. */
export function judgeBackendChoice(input = {}) {
  if (input.r1Fits === false) return { verdict: '판정 못 함', choice: 'keep-direct', reasons: ['R1_FAIL'] };
  if (input.personalData === true && input.transferReady !== true) return { verdict: '판정 못 함', choice: 'keep-direct', reasons: ['R3_NOT_READY'] };
  if (!Number.isFinite(input.directAnnualUsd) || !Number.isFinite(input.datadogAnnualUsd)) {
    return { verdict: '판정 못 함', choice: null, reasons: ['R2_INPUT_MISSING'] };
  }
  if (!Number.isFinite(input.directAnnualUsd15) || !Number.isFinite(input.datadogAnnualUsd15)) {
    return { verdict: '판정 못 함', choice: null, reasons: ['R2_SENSITIVITY_MISSING'] };
  }
  const decided = decideChoice(input);
  if (input.ownerApproved !== true) {
    return { verdict: '판정 못 함', choice: decided.choice, reasons: [...decided.reasons, 'OWNER_NOT_APPROVED'] };
  }
  return { verdict: '통과', choice: decided.choice, reasons: decided.reasons };
}

function candidateOf(id) {
  const candidate = F0815_SENTRY_CANDIDATES.find((c) => c.id === id);
  if (!candidate) throw new UsageError(`Sentry 후보가 아니다: ${id}`);
  return candidate;
}

function criteriaMap(updates = {}) {
  const map = {};
  for (const c of F0815_SENTRY_CRITERIA) map[c.id] = { status: '미측정', reason: '확인하지 않았다' };
  return Object.assign(map, updates);
}

/** Sentry vs GlitchTip 판정. 직접 설치의 ①(국외 이전)은 false여도 통과한다. */
export function judgeSentryBackend(input = {}) {
  const candidate = candidateOf(input.candidate);
  const criteria = criteriaMap();

  if (input.peakMeasured !== true) {
    criteria['error-peak'] = { status: '미측정', reason: '오류 피크를 재지 않았다' };
    return { verdict: '미측정', candidate: candidate.id, reasons: ['PEAK_UNMEASURED'], criteria };
  }
  if (!input.runId || input.runExists !== true) {
    return { verdict: '무효', candidate: candidate.id, reasons: ['NO_RUN'], criteria };
  }
  criteria['error-peak'] = { status: '통과', reason: '피크 입력과 실행 산출물이 있다' };
  if (input.apiConfirmed !== true) {
    criteria['console-api'] = { status: '판정 못 함', reason: 'API 지원을 확인하지 못했다' };
    return { verdict: '판정 못 함', candidate: candidate.id, reasons: ['API_UNCONFIRMED'], criteria };
  }
  criteria['console-api'] = { status: '통과', reason: 'API 확인' };
  if (candidate.overseas === true && input.overseasTransferReady !== true) {
    criteria.overseas = { status: '판정 못 함', reason: '국외 이전 요건 미비' };
    return { verdict: '판정 못 함', candidate: candidate.id, reasons: ['R3_NOT_READY'], criteria };
  }
  criteria.overseas = { status: '통과', reason: candidate.overseas === true ? '국외 이전 요건 확인' : '국내 보관' };
  if (candidate.singlePoint === true && input.availabilityOk !== true) {
    criteria.availability = { status: '판정 못 함', reason: '단일 서버 가용성 위험' };
    return { verdict: '판정 못 함', candidate: candidate.id, reasons: ['AVAILABILITY_RISK'], criteria };
  }
  criteria.availability = { status: '통과', reason: '가용성 확인' };
  if (!Number.isFinite(input.annualCostUsd)) {
    criteria['annual-cost'] = { status: '미계산', reason: '연간 비용 입력 없음' };
    return { verdict: '판정 못 함', candidate: candidate.id, reasons: ['COST_MISSING'], criteria };
  }
  criteria['annual-cost'] = { status: '통과', reason: '비용 입력' };
  return { verdict: '통과', candidate: candidate.id, reasons: [], criteria };
}

/** 실제 error-reporting.ts 잠금과 같은 값을 가리키는지 검사한다. */
export function validateSentryConfig(config) {
  const problems = [];
  const c = config ?? {};
  const d = c.dataCollection ?? {};
  if (c.sendDefaultPii !== false) problems.push('sendDefaultPii는 false여야 한다');
  if (d.userInfo !== false) problems.push('dataCollection.userInfo는 false여야 한다');
  if (d.cookies !== false) problems.push('dataCollection.cookies는 false여야 한다');
  if (d.httpHeaders !== false) problems.push('dataCollection.httpHeaders는 false여야 한다');
  if (!Array.isArray(d.httpBodies) || d.httpBodies.length !== 0) problems.push('dataCollection.httpBodies는 빈 배열이어야 한다');
  if (d.urlQueryParams !== false) problems.push('dataCollection.urlQueryParams는 false여야 한다');
  if (d.graphQL?.document !== false) problems.push('dataCollection.graphQL.document는 false여야 한다');
  if (d.graphQL?.variables !== false) problems.push('dataCollection.graphQL.variables는 false여야 한다');
  if (d.genAI?.inputs !== false) problems.push('dataCollection.genAI.inputs는 false여야 한다');
  if (d.genAI?.outputs !== false) problems.push('dataCollection.genAI.outputs는 false여야 한다');
  if (c.traceLifecycle !== 'static') problems.push('traceLifecycle은 static이어야 한다');
  if (c.sendClientReports !== false) problems.push('sendClientReports는 false여야 한다');
  if (c.maxBreadcrumbs !== 0) problems.push('maxBreadcrumbs는 0이어야 한다');
  if (c.attachStacktrace !== false) problems.push('attachStacktrace는 false여야 한다');
  if (c.beforeSend !== 'lockEvent') problems.push('beforeSend는 lockEvent여야 한다(redactDeep은 그 안의 단계다)');
  if (c.userRef !== 'accountRef') problems.push('userRef는 accountRef여야 한다');
  if (c.replay !== false) problems.push('replay는 false여야 한다');
  if (c.tracing !== false) problems.push('tracing은 false여야 한다');
  if (c.piiPatterns !== 'packages/platform/src/pii-patterns.json') problems.push('piiPatterns는 pii-patterns.json이어야 한다');
  if (c.dsnEnv !== 'PEAKET_SENTRY_DSN') problems.push('dsnEnv는 PEAKET_SENTRY_DSN이어야 한다');
  return { ok: problems.length === 0, problems };
}

const M4_SECTIONS = ['## 1. 무엇을 설명하나', '## 2. 설계', '## 3. 측정 근거', '## 4. 한계', '## 5. 게시 전 확인'];

/** M4 초안 계약. 두 글의 근거는 정확히 F-08-14(+F-08-13)이고, claims는 비어 있어야 한다. */
export function validateM4Drafts(drafts) {
  const problems = [];
  if (!Array.isArray(drafts) || drafts.length !== 2) return { ok: false, problems: ['초안은 정확히 2편이다'] };
  const ids = new Set();
  for (const draft of drafts) {
    if (!draft || typeof draft.id !== 'string' || !draft.id) problems.push('초안 ID가 없다');
    else if (ids.has(draft.id)) problems.push(`초안 ID가 겹친다: ${draft.id}`);
    else ids.add(draft.id);
    if (draft?.status !== 'draft') problems.push(`${draft?.id}: status는 draft여야 한다`);
    if (draft?.publish !== 'owner') problems.push(`${draft?.id}: publish는 owner여야 한다`);
    if (!Array.isArray(draft?.claims) || draft.claims.length !== 0) problems.push(`${draft?.id}: claims는 비어 있어야 한다`);
    if (!Array.isArray(draft?.measuredKpis) || draft.measuredKpis.length !== 0) problems.push(`${draft?.id}: measuredKpis는 비어 있어야 한다`);
    if (!Array.isArray(draft?.designOnlyKpis) || draft.designOnlyKpis.length !== 0) problems.push(`${draft?.id}: designOnlyKpis는 비어 있어야 한다`);
    const kpis = Array.isArray(draft?.kpis) ? draft.kpis : [];
    const pending = Array.isArray(draft?.pendingKpis) ? draft.pendingKpis : [];
    if (JSON.stringify(kpis) !== JSON.stringify(pending)) problems.push(`${draft?.id}: pendingKpis는 kpis와 같아야 한다`);
    if (draft?.id === 'm4-control-gameday') {
      if (JSON.stringify(kpis) !== JSON.stringify(['K8'])) problems.push(`${draft.id}: kpis는 K8이어야 한다`);
      if (JSON.stringify(draft?.evidence) !== JSON.stringify(['F-08-14', 'F-08-13'])) problems.push(`${draft.id}: evidence는 F-08-14·F-08-13이어야 한다`);
    } else if (draft?.id === 'm4-scaling-cost') {
      if (JSON.stringify(kpis) !== JSON.stringify(['K9'])) problems.push(`${draft.id}: kpis는 K9이어야 한다`);
      if (JSON.stringify(draft?.evidence) !== JSON.stringify(['F-08-14'])) problems.push(`${draft.id}: evidence는 F-08-14여야 한다`);
    } else {
      problems.push(`모르는 초안 ID: ${draft?.id}`);
    }
  }
  if (ids.size !== 2 || !ids.has('m4-control-gameday') || !ids.has('m4-scaling-cost')) problems.push('초안 ID는 m4-control-gameday·m4-scaling-cost 둘이어야 한다');
  return { ok: problems.length === 0, problems };
}

/** M4 초안 파일의 머리 네 줄·다섯 절·미측정·근거·금지 수치·PII·내부 주소·게시 문구를 본다. */
export function validateM4Outline(markdown, options = {}) {
  const text = String(markdown ?? '');
  const id = options.id;
  const reasons = [];
  if (!text.startsWith('# M4')) reasons.push('M4 제목이 없다');
  if (!text.includes('- **상태**: 초안(')) reasons.push('머리에 상태 초안이 없다');
  if (!text.includes('게시 전')) reasons.push('머리에 게시 전이 없다');
  if (!text.includes('- **근거**:')) reasons.push('머리에 근거가 없다');
  if (!text.includes('- **숫자 표시**:')) reasons.push('머리에 숫자 표시가 없다');
  if (!text.includes('- **게시**:') || !text.includes('publish: owner') || !text.includes('draft')) reasons.push('머리에 게시자·draft 표시가 없다');
  for (const section of M4_SECTIONS) if (!text.includes(section)) reasons.push(`절이 없다: ${section}`);
  if (!text.includes('미측정')) reasons.push('미측정 표시가 없다');
  if (!text.includes('F-08-14')) reasons.push('F-08-14 근거가 없다');
  if (id === 'm4-control-gameday' && !text.includes('F-08-13')) reasons.push('K8 글에 F-08-13 근거가 없다');
  if (id === 'm4-scaling-cost' && !text.includes('[추정]')) reasons.push('K9 글에 [추정] 표시가 없다');
  if (/게시\s*(?:했다|함|완료|됨)/.test(text)) reasons.push('게시했다는 문구가 있다');
  if (containsPii(text)) reasons.push('PII가 있다');
  if (containsInternalAddress(text)) reasons.push('내부 주소가 있다');
  const forbidden = forbiddenOutsideNegation(text);
  if (forbidden.length > 0) reasons.push(...forbidden);
  return { ok: reasons.length === 0, reasons };
}

const REPORT_PRIOR = ['F-08-5', 'F-08-9', 'F-08-10', 'F-08-12', 'F-08-13', 'F-08-14'];
const REPORT_SECTIONS = ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.'];

/** 보고서 뼈대를 만든다. 모든 판정은 미측정/판정 못 함이고 비용은 [추정]/미계산이다. */
export function renderF0815Report() {
  return `# F-08-15 보내기 비교·Sentry 판정·M4 2편 보고서 뼈대

- **상태**: 미실행. 측정 창 3h-1~3h-3에서 문서 대조·계산만 한다. 아래 판정은 모두 미측정 또는 판정 못 함이다.
- **계획**: docs/review/plans/F-08-15.md §6~§10.
- **정본**: docs/observability.md §1·§11, docs/perf-ledger.md §11, docs/verification.md §3.10, docs/blog/README.md.

## 1. 보내기 비교

| 항목 | 창 | 판정 | 증거 |
| --- | --- | --- | --- |
| Datadog Watchdog·이상 탐지 힌트 | 3h-1 | 미측정 | 미실행 |
| AMP·AMG 장기 조회 한도 | 3h-1 | 미측정 | 미실행 |
| AMP 연간 비용 | 3h-1 | 미측정 | 미계산([추정] 없음) |
| R1 콘솔 갱신·조회 한도 | 3h-1 | 미측정 | 계정 없음 |
| R2 연간 비용 순위 | 3h-1 | 판정 못 함 | 입력 없음 |

## 2. Sentry vs GlitchTip

| 후보 | ① 국외 이전 | ② 오류 피크 | ③ 가용성 | ④ 콘솔 API | ⑤ 연간 비용 | 판정 |
| --- | --- | --- | --- | --- | --- | --- |
| Sentry 클라우드 | 미확인 | 미측정 | 미확인 | 미확인 | 미계산 | 판정 못 함 |
| Sentry 직접 설치 | 국내 보관 | 미측정 | 미확인 | 미확인 | 미계산 | 판정 못 함 |
| GlitchTip 직접 설치 | 국내 보관 | 미측정 | 미확인 | 미확인 | 미계산 | 판정 못 함 |

## 3. M4 초안 2편

| 편 | 파일 | 상태 |
| --- | --- | --- |
| m4-control-gameday | m4-control-gameday.md | 초안(2026-11-28, 게시 전) |
| m4-scaling-cost | m4-scaling-cost.md | 초안(2026-11-28, 게시 전) |

## 4. 선행 측정 인용

- F-08-5: 무효·미측정
- F-08-9: 판정 못 함(무효·부분)
- F-08-10: 미측정
- F-08-12: 미측정
- F-08-13: 설계만·판정 못 함
- F-08-14: 미측정

## 5. 한계

- 실제 전송·계정·Sentry/GlitchTip 설치를 하지 않아 R1·R2·R3와 오류 피크를 판정하지 못한다.
- 비용은 가격표 계산([추정])과 미계산뿐이고, 청구서나 실측이 아니다.
- 로컬 M4 초안은 목차 뼈대이며 게시하지 않았다.

## 6. 장부·게이트

- 장부: F-08-15 항목 0.
- 게이트: f0815 20, f0812 16, f0813 18(F-08-13 가지), f086 8, f0811 10, lint 0, doc-check 오류 0·경고 12, release-scope 33/5/67.
- Docker·kind·k6·브라우저는 쓰지 않았다.

## 7. 주장하지 않는 것

- 30k/s·30,000건/초·100만·K1·K2·K7 0을 주장하지 않는다.
- F-08-5·F-08-9·F-08-10·F-08-12·F-08-14의 무효·부분·미측정을 통과로 바꾸지 않는다.
- 비용을 실측·청구서로 적지 않는다.
`;
}

function passRows(markdown) {
  return String(markdown ?? '').split('\n').filter((line) => /\|\s*통과\s*\|/.test(line));
}

/** 보고서 뼈대 검증. 통과 행 0개·금지 수치 여섯·PII·내부 주소·선행 인용을 본다. */
export function validateF0815Report(markdown) {
  const text = String(markdown ?? '');
  const reasons = [];
  for (const section of REPORT_SECTIONS) if (!text.includes(section)) reasons.push(`절이 없다: ${section}`);
  for (const id of REPORT_PRIOR) if (!text.includes(id)) reasons.push(`선행 인용이 없다: ${id}`);
  for (const id of ['m4-control-gameday', 'm4-scaling-cost']) if (!text.includes(id)) reasons.push(`M4 행이 없다: ${id}`);
  if (passRows(text).length > 0) reasons.push(`통과 행이 있다: ${passRows(text).join(' / ')}`);
  if (text.includes('실측(PC)')) reasons.push('실측(PC) 표시가 있다');
  if (!text.includes('미측정')) reasons.push('미측정 표시가 없다');
  if (!text.includes('판정 못 함')) reasons.push('판정 못 함 표시가 없다');
  if (containsPii(text)) reasons.push('PII가 있다');
  if (containsInternalAddress(text)) reasons.push('내부 주소가 있다');
  reasons.push(...forbiddenOutsideNegation(text));
  return { ok: reasons.length === 0, reasons, passed: reasons.length === 0 };
}

/** 계획 JSON 검증. */
export function validateF0815Plan(plan) {
  const reasons = [];
  const p = plan ?? {};
  if (p.batch !== 'F-08-15') reasons.push('batch는 F-08-15여야 한다');
  if (p.feature !== 'F-08-15') reasons.push('feature는 F-08-15여야 한다');
  const window = p.windows?.['3h'];
  if (!window || window.hours !== 4) reasons.push('windows.3h.hours는 4여야 한다');
  if (JSON.stringify(window?.steps) !== JSON.stringify(['3h-1', '3h-2', '3h-3'])) reasons.push('windows.3h.steps가 다르다');
  if (p.dependency?.feature !== 'F-08-14') reasons.push('dependency.feature는 F-08-14여야 한다');
  if (p.dependency?.status !== '미측정') reasons.push('dependency.status는 미측정이어야 한다');
  if (JSON.stringify(p.dependency?.inputs) !== JSON.stringify(['K8', 'K9', 'series', 'samplesPerSecond', 'logGbPerDay', 'traceGbPerDay', 'nodes', 'consoleUsers', 'backendR2'])) reasons.push('dependency.inputs가 다르다');
  if (p.send?.external !== false) reasons.push('send.external은 false여야 한다');
  if (p.send?.freeSamples !== 40_000_000) reasons.push('send.freeSamples가 다르다');
  if (p.send?.priceDate !== '2026-10-14') reasons.push('send.priceDate가 다르다');
  if (p.sentry?.install !== false) reasons.push('sentry.install은 false여야 한다');
  if (p.sentry?.dsn !== '') reasons.push('sentry.dsn은 비어야 한다');
  if (p.sentry?.candidates !== 3) reasons.push('sentry.candidates는 3이어야 한다');
  if (p.sentry?.verdict !== '판정 못 함') reasons.push('sentry.verdict는 판정 못 함이어야 한다');
  if (JSON.stringify(p.m4) !== JSON.stringify(['m4-control-gameday', 'm4-scaling-cost'])) reasons.push('m4 목록이 다르다');
  if (!Array.isArray(p.stopRules) || p.stopRules.length !== 10) reasons.push('stopRules는 10개여야 한다');
  else {
    const ids = ['STOP-01', 'STOP-02', 'STOP-03', 'STOP-04', 'STOP-05', 'STOP-06', 'STOP-07', 'STOP-08', 'STOP-09', 'STOP-10'];
    if (JSON.stringify(p.stopRules.map((r) => r.id)) !== JSON.stringify(ids)) reasons.push('stopRules ID가 다르다');
    for (const rule of p.stopRules) if (typeof rule.rule !== 'string' || rule.rule.length === 0) reasons.push(`${rule.id} 내용이 비었다`);
  }
  if (p.lock?.take !== 'docker lane4-F-08-15') reasons.push('lock.take가 다르다');
  if (p.lock?.drop !== 'docker lane4-F-08-15') reasons.push('lock.drop이 다르다');
  if (p.lock?.dockerAll !== false) reasons.push('lock.dockerAll은 false여야 한다');
  if (p.lock?.used !== false) reasons.push('lock.used는 false여야 한다');
  for (const feature of ['F-08-14', 'F-08-6', 'F-08-13']) {
    if (!Array.isArray(p.boundaries) || !p.boundaries.some((b) => b.feature === feature)) reasons.push(`경계가 없다: ${feature}`);
  }
  for (const id of F0815_OUTSIDE) if (!Array.isArray(p.notIncluded) || !p.notIncluded.includes(id)) reasons.push(`notIncluded에 없다: ${id}`);
  return { ok: reasons.length === 0, reasons };
}

/** `v1 backend-send` 인자. 실제 전송·설치·Docker·kind·k6·브라우저 인자는 거부한다. */
export function parseF0815Args(argv) {
  if (!Array.isArray(argv)) throw new UsageError('인자 목록이 없다');
  const out = { plan: null, out: null, check: false, report: null, window: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--check') {
      out.check = true;
      continue;
    }
    if (['--plan', '--out', '--report', '--window'].includes(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag}에 값이 없다`);
      out[flag.slice(2)] = value;
      i++;
      continue;
    }
    throw new UsageError(`backend-send에 없는 인자다: ${flag}`);
  }
  if (out.window !== null && out.window !== '3h') throw new UsageError(`창은 3h다: ${out.window}`);
  return out;
}

export const F0815_MODULE = Object.freeze({
  externalSend: F0815_EXTERNAL_SEND,
  cloudCost: F0815_CLOUD_COST,
  dockerUsed: F0815_DOCKER_USED,
  windows: F0815_WINDOWS,
  steps: F0815_STEPS,
  verdicts: F0815_VERDICTS,
});
