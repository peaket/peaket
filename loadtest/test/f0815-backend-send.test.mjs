// F-08-15 보내기 비교·Sentry 판정·M4 블로그 2편 시험. Docker·kind·k6·브라우저 없이
// 샘플 예산·비용 계산 계약·판정 규칙 R1~R3·Sentry 후보·가림·M4 목차·보고서·계획만 본다.
// 정본 값은 시험 안에 적고, 구현 상수를 가져오지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RUNNER = path.join(ROOT, 'loadtest', 'runner', 'backend-send.mjs');
const PLAN_JSON = path.join(ROOT, 'loadtest', 'plan', 'f0815-plan.json');
const REPORT = path.join(ROOT, 'docs', 'review', 'measurements', 'F-08-15.md');
const PLAN_DOC = path.join(ROOT, 'docs', 'review', 'plans', 'F-08-15.md');
const PII = path.join(ROOT, 'packages', 'platform', 'src', 'pii-patterns.json');
const ERROR_REPORTING = path.join(ROOT, 'packages', 'platform', 'src', 'error-reporting.ts');
const BLOG_README = path.join(ROOT, 'docs', 'blog', 'README.md');
const M4_FILES = {
  'm4-control-gameday': path.join(ROOT, 'docs', 'blog', 'm4-control-gameday.md'),
  'm4-scaling-cost': path.join(ROOT, 'docs', 'blog', 'm4-scaling-cost.md'),
};

const FORBIDDEN = ['30k/s', '30,000건/초', '100만', 'K1', 'K2', 'K7'];
// 같은 문장 안의 명시적 부정만 인정한다. '미측정'·'미실행' 한 단어는 면제 사유가 아니다.
const STRONG_NEG = ['주장하지 않', '금지', '범위 밖', '위반', '쓰지 않', '하지 않는다', '아니다', '없다', '닫지 않', '바꾸지 않'];
const PRIOR = ['F-08-5', 'F-08-9', 'F-08-10', 'F-08-12', 'F-08-13', 'F-08-14'];

const SENTRY_LOCK = {
  sendDefaultPii: false,
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
  },
  traceLifecycle: 'static',
  sendClientReports: false,
  maxBreadcrumbs: 0,
  attachStacktrace: false,
  beforeSend: 'redactDeep',
  userRef: 'accountRef',
  replay: false,
  tracing: false,
  piiPatterns: 'packages/platform/src/pii-patterns.json',
  dsnEnv: 'PEAKET_SENTRY_DSN',
};

const GOOD_DRAFTS = [
  {
    id: 'm4-control-gameday',
    title: '관제 명령과 Game Day',
    kpis: ['K8'],
    measuredKpis: [],
    designOnlyKpis: [],
    pendingKpis: ['K8'],
    evidence: ['F-08-14', 'F-08-13'],
    status: 'draft',
    publish: 'owner',
    claims: [],
  },
  {
    id: 'm4-scaling-cost',
    title: '확장 시간과 비용',
    kpis: ['K9'],
    measuredKpis: [],
    designOnlyKpis: [],
    pendingKpis: ['K9'],
    evidence: ['F-08-14'],
    status: 'draft',
    publish: 'owner',
    claims: [],
  },
];

const VALID_M4 = `# M4 ① 관제 명령과 Game Day — 초안 뼈대

- **상태**: 초안(2026-11-28, 게시 전)
- **근거**: F-08-14(K8 미측정), F-08-13 계획의 예정 판정(현재 인용은 미측정)
- **숫자 표시**: 측정값은 미측정이다.
- **게시**: 소유자 몫(publish: owner, draft)

## 1. 무엇을 설명하나

관제 명령과 K8을 설명한다.

## 2. 설계

2인 승인과 전파 ack를 설명한다.

## 3. 측정 근거

F-08-14 K8은 미측정이다.

## 4. 한계

로컬 Alertmanager가 없다.

## 5. 게시 전 확인

- [ ] F-08-14 실행 ID와 값 대조
`;

async function load() {
  if (!fs.existsSync(RUNNER)) return { missing: 'loadtest/runner/backend-send.mjs' };
  try {
    return await import(pathToFileURL(RUNNER).href);
  } catch (error) {
    return { error };
  }
}

function need(mod) {
  if (mod.missing) assert.fail(`${mod.missing}가 없다`);
  if (mod.error) assert.fail(`loadtest/runner/backend-send.mjs를 읽지 못했다: ${mod.error.message}`);
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

function usage(fn) {
  assert.throws(fn, (error) => error?.name === 'UsageError');
}

function near(actual, expected, eps = 1e-9) {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected}`);
}

function sentences(line) {
  return line.split(/(?<=다\.)\s+|(?<=[.!?])\s+/).filter(Boolean);
}

function forbiddenOutsideNegation(text) {
  const hits = [];
  for (const line of text.split('\n')) {
    for (const sentence of sentences(line)) {
      if (STRONG_NEG.some((neg) => sentence.includes(neg))) continue;
      for (const token of FORBIDDEN) if (sentence.includes(token)) hits.push(`${token}: ${sentence}`);
    }
  }
  return hits;
}

function passRows(markdown) {
  return markdown.split('\n').filter((line) => /\|\s*통과\s*\|/.test(line));
}

function planFixture(overrides = {}) {
  return {
    batch: 'F-08-15',
    feature: 'F-08-15',
    windows: { '3h': { hours: 4, steps: ['3h-1', '3h-2', '3h-3'] } },
    inputs: ['F-08-14', 'F-08-13'],
    dependency: {
      feature: 'F-08-14',
      status: '미측정',
      inputs: ['K8', 'K9', 'series', 'samplesPerSecond', 'logGbPerDay', 'traceGbPerDay', 'nodes', 'consoleUsers', 'backendR2'],
    },
    send: { external: false, freeSamples: 40_000_000, priceDate: '2026-10-14' },
    sentry: { install: false, dsn: '', candidates: 3, verdict: '판정 못 함' },
    m4: ['m4-control-gameday', 'm4-scaling-cost'],
    stopRules: [
      { id: 'STOP-01', rule: '외부 계정을 만들거나 자료를 보내려 한다' },
      { id: 'STOP-02', rule: 'PEAKET_SENTRY_DSN을 채우거나 SDK를 켜려 한다' },
      { id: 'STOP-03', rule: '보내지 않았는데 전송·실행 ID를 적는다' },
      { id: 'STOP-04', rule: '계산값을 실측·청구서로 적는다' },
      { id: 'STOP-05', rule: '오류 피크·API 범위를 확인 없이 통과로 적는다' },
      { id: 'STOP-06', rule: '2차 마스킹 원천을 옮겨 적거나 새 정규식을 만든다' },
      { id: 'STOP-07', rule: 'M4 초안에 측정값·달성·게시를 적는다' },
      { id: 'STOP-08', rule: '개인 식별자·연락처·내부 주소가 기록에 들어간다' },
      { id: 'STOP-09', rule: 'Docker·kind·k6·브라우저를 쓰려 한다' },
      { id: 'STOP-10', rule: '감독이 중단을 지시했거나 외부 피해가 의심된다' },
    ],
    lock: { take: 'docker lane4-F-08-15', drop: 'docker lane4-F-08-15', dockerAll: false, used: false },
    notIncluded: ['K8', 'K9', 'V-T18', 'V-T27', 'V-T28', 'P-T1', 'SR-T13', 'NFR-028', 'Q-T2', 'S-T1', 'V-T10', 'NFR-027', 'V-T4', 'V-T5', 'V-T17'],
    boundaries: [
      { feature: 'F-08-14', owns: 'K8·K9·비교 계산' },
      { feature: 'F-08-6', owns: '33종·gameday.mjs' },
      { feature: 'F-08-13', owns: '모의 진행·복원 연습' },
    ],
    ...overrides,
  };
}

function sendInput(overrides = {}) {
  return {
    sent: true,
    runId: '2026-11-29-f0815-r1',
    runExists: true,
    manifest: true,
    r1Measured: true,
    queryLimitFits: true,
    directAnnualUsd: 100,
    datadogAnnualUsd: 80,
    directAnnualUsd15: 150,
    datadogAnnualUsd15: 80,
    personalData: false,
    transferReady: false,
    ownerApproved: true,
    ...overrides,
  };
}

test('F0815-1 ① 샘플 예산식이 40,000,000 경계와 needRelabel을 맞춘다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.samplesFor, 'function', 'samplesFor 함수가 없다');
  assert.equal(typeof mod.judgeSampleBudget, 'function', 'judgeSampleBudget 함수가 없다');

  assert.equal(mod.samplesFor({ series: 2_000, days: 3, scrapeSec: 15 }), 34_560_000);
  assert.equal(mod.samplesFor({ series: 10_000, days: 1, scrapeSec: 15 }), 57_600_000);
  assert.equal(mod.samplesFor({ series: 1_000, days: 1, scrapeSec: 5 }), 17_280_000);

  const at = mod.judgeSampleBudget({ samples: 40_000_000 });
  assert.equal(at.withinFree, true);
  assert.equal(at.needRelabel, false);
  assert.equal(at.overBy, 0);

  const over = mod.judgeSampleBudget({ samples: 40_000_001 });
  assert.equal(over.withinFree, false);
  assert.equal(over.needRelabel, true);
  assert.equal(over.overBy, 1);
  assert.equal(over.display, '[추정]');
});

test('F0815-1 ② 샘플 식이 0 이하·정수가 아닌 값·나누어지지 않는 간격을 거부한다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.samplesFor, 'function', 'samplesFor 함수가 없다');
  usage(() => mod.samplesFor({ series: 0, days: 1, scrapeSec: 15 }));
  usage(() => mod.samplesFor({ series: -1, days: 1, scrapeSec: 15 }));
  usage(() => mod.samplesFor({ series: 1, days: 0, scrapeSec: 15 }));
  usage(() => mod.samplesFor({ series: 1, days: -1, scrapeSec: 15 }));
  usage(() => mod.samplesFor({ series: 1, days: 1, scrapeSec: 7 }));
  usage(() => mod.samplesFor({ series: 1, days: 1, scrapeSec: 0 }));
  usage(() => mod.samplesFor({ series: 1.5, days: 1, scrapeSec: 15 }));
  usage(() => mod.samplesFor({ series: 1, days: 1.5, scrapeSec: 15 }));
  usage(() => mod.samplesFor({ series: 1, days: 1, scrapeSec: 2.5 }));
  usage(() => mod.samplesFor({ series: '1', days: 1, scrapeSec: 15 }));
});

test('F0815-2 ① AMP 연간 비용이 가격표 경계와 비배수 비례 환산을 맞춘다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.ampAnnualCost, 'function', 'ampAnnualCost 함수가 없다');

  const free = mod.ampAnnualCost({ samplesPerMonth: 40_000_000, storageGb: 10, querySamplesPerMonth: 200_000_000_000 });
  assert.equal(free.ok, true);
  near(free.ingestionUsd, 0);
  near(free.storageUsd, 0);
  near(free.queryUsd, 0);
  near(free.totalUsd, 0);

  const paid = mod.ampAnnualCost({ samplesPerMonth: 50_000_000, storageGb: 20, querySamplesPerMonth: 201_000_000_000 });
  assert.equal(paid.ok, true);
  near(paid.ingestionUsd, 10.8);
  near(paid.storageUsd, 3.6);
  near(paid.queryUsd, 1.2);
  near(paid.totalUsd, 15.6);
  assert.equal(paid.display, '[추정]');
  assert.equal(paid.priceDate, '2026-10-14');

  const proportional = mod.ampAnnualCost({ samplesPerMonth: 45_000_000, storageGb: 20.5, querySamplesPerMonth: 200_500_000_000 });
  assert.equal(proportional.ok, true);
  near(proportional.ingestionUsd, 5.4);
  near(proportional.storageUsd, 3.78);
  near(proportional.queryUsd, 0.6);
  near(proportional.totalUsd, 9.78);
});

test('F0815-2 ② 비용 입력이 없거나 20억 샘플을 넘으면 미계산으로 두고, 음수·NaN은 거부한다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.ampAnnualCost, 'function', 'ampAnnualCost 함수가 없다');

  const noStorage = mod.ampAnnualCost({ samplesPerMonth: 40_000_000, querySamplesPerMonth: 0 });
  assert.equal(noStorage.ok, false);
  assert.equal(noStorage.display, '미계산');
  assert.equal(noStorage.reason, 'STORAGE_MISSING');

  const tier2 = mod.ampAnnualCost({ samplesPerMonth: 2_000_000_001, storageGb: 10, querySamplesPerMonth: 0 });
  assert.equal(tier2.ok, false);
  assert.equal(tier2.display, '미계산');
  assert.equal(tier2.reason, 'TIER2_NOT_MODELED');

  usage(() => mod.ampAnnualCost({ samplesPerMonth: -1, storageGb: 10, querySamplesPerMonth: 0 }));
  usage(() => mod.ampAnnualCost({ samplesPerMonth: Number.NaN, storageGb: 10, querySamplesPerMonth: 0 }));
  usage(() => mod.ampAnnualCost({ samplesPerMonth: 40_000_000, storageGb: -1, querySamplesPerMonth: 0 }));
  usage(() => mod.ampAnnualCost({ samplesPerMonth: 40_000_000, storageGb: 10, querySamplesPerMonth: -1 }));
});

test('F0815-3 ① 보내기 판정이 R1·R2·R3·choice를 함께 단언한다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.judgeSendComparison, 'function', 'judgeSendComparison 함수가 없다');

  const noSend = mod.judgeSendComparison({ sent: false });
  assert.equal(noSend.verdict, '미측정');
  assert.ok(noSend.reasons.includes('NO_SEND'));

  const noRun = mod.judgeSendComparison({ sent: true, runId: null, runExists: false, manifest: false });
  assert.equal(noRun.verdict, '무효');
  assert.ok(noRun.reasons.includes('NO_RUN'));

  const r1Unmeasured = mod.judgeSendComparison(sendInput({ r1Measured: false }));
  assert.equal(r1Unmeasured.verdict, '판정 못 함');
  assert.ok(r1Unmeasured.reasons.includes('R1_UNMEASURED'));

  const r1Fails = mod.judgeSendComparison(sendInput({ queryLimitFits: false }));
  assert.equal(r1Fails.verdict, '판정 못 함');
  assert.equal(r1Fails.choice, 'keep-direct');
  assert.ok(r1Fails.reasons.includes('R1_FAIL'));

  const r3Fails = mod.judgeSendComparison(sendInput({ personalData: true, transferReady: false }));
  assert.equal(r3Fails.verdict, '판정 못 함');
  assert.equal(r3Fails.choice, 'keep-direct');
  assert.ok(r3Fails.reasons.includes('R3_NOT_READY'));

  const r2Missing = mod.judgeSendComparison(sendInput({ directAnnualUsd: null, datadogAnnualUsd: null }));
  assert.equal(r2Missing.verdict, '판정 못 함');
  assert.ok(r2Missing.reasons.includes('R2_INPUT_MISSING'));

  const passOver = mod.judgeSendComparison(sendInput({ directAnnualUsd: 100, datadogAnnualUsd: 80 }));
  assert.equal(passOver.verdict, '통과');
  assert.equal(passOver.choice, 'review-datadog');

  const passWithin = mod.judgeSendComparison(sendInput({ directAnnualUsd: 100, datadogAnnualUsd: 95 }));
  assert.equal(passWithin.verdict, '통과');
  assert.equal(passWithin.choice, 'keep-direct');

  const reversed = mod.judgeSendComparison(sendInput({ directAnnualUsd: 100, datadogAnnualUsd: 120, directAnnualUsd15: 150, datadogAnnualUsd15: 120 }));
  assert.equal(reversed.verdict, '통과');
  assert.equal(reversed.choice, 'review-datadog');
  assert.ok(reversed.reasons.includes('SENSITIVE_TO_OPS_HOURS'));

  const no15 = mod.judgeSendComparison(sendInput({ directAnnualUsd15: undefined, datadogAnnualUsd15: undefined }));
  assert.notEqual(no15.verdict, '통과');
});

test('F0815-3 ② 백엔드 선택이 R1·R3·비용 없음·10%·1.5배 경계를 지킨다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.judgeBackendChoice, 'function', 'judgeBackendChoice 함수가 없다');

  const r1 = mod.judgeBackendChoice({ r1Fits: false, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 50, directAnnualUsd15: 150, datadogAnnualUsd15: 50, ownerApproved: true });
  assert.equal(r1.choice, 'keep-direct');
  assert.ok(r1.reasons.includes('R1_FAIL'));

  const r3 = mod.judgeBackendChoice({ r1Fits: true, personalData: true, transferReady: false, directAnnualUsd: 100, datadogAnnualUsd: 50, directAnnualUsd15: 150, datadogAnnualUsd15: 50, ownerApproved: true });
  assert.equal(r3.choice, 'keep-direct');
  assert.ok(r3.reasons.includes('R3_NOT_READY'));

  const noCost = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: null, datadogAnnualUsd: null, ownerApproved: true });
  assert.equal(noCost.verdict, '판정 못 함');
  assert.ok(noCost.reasons.includes('R2_INPUT_MISSING'));

  const within = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 90, directAnnualUsd15: 150, datadogAnnualUsd15: 90, ownerApproved: true });
  assert.equal(within.choice, 'keep-direct');
  assert.ok(within.reasons.includes('WITHIN_10PCT'));

  const over = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 89.9, directAnnualUsd15: 150, datadogAnnualUsd15: 89.9, ownerApproved: true });
  assert.equal(over.choice, 'review-datadog');

  const noOwner = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 50, directAnnualUsd15: 150, datadogAnnualUsd15: 50, ownerApproved: false });
  assert.equal(noOwner.verdict, '판정 못 함');

  const reversed = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 120, directAnnualUsd15: 150, datadogAnnualUsd15: 120, ownerApproved: true });
  assert.equal(reversed.choice, 'review-datadog');
  assert.ok(reversed.reasons.includes('SENSITIVE_TO_OPS_HOURS'));

  const no15 = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 80, ownerApproved: true });
  assert.equal(no15.verdict, '판정 못 함');
  assert.ok(no15.reasons.includes('R2_SENSITIVITY_MISSING'));
});

test('F0815-4 ① Sentry 후보 셋·정본 사실·기준 다섯을 확인한다', async () => {
  const mod = need(await load());
  assert.ok(Array.isArray(mod.F0815_SENTRY_CANDIDATES), 'F0815_SENTRY_CANDIDATES가 없다');
  assert.equal(mod.F0815_SENTRY_CANDIDATES.length, 3);
  const byId = new Map(mod.F0815_SENTRY_CANDIDATES.map((c) => [c.id, c]));

  const cloud = byId.get('sentry-cloud');
  assert.ok(cloud, 'sentry-cloud가 없다');
  assert.equal(cloud.overseas, true);
  assert.equal(cloud.freeTier.users, 1);
  assert.equal(cloud.freeTier.errorsPerMonth, 5_000);
  assert.equal(cloud.freeTier.replays, 50);
  assert.equal(cloud.freeTier.alerts, 'email');
  assert.equal(cloud.paidUsdPerMonthAnnual, 26);
  assert.equal(cloud.apiFree, '미확인');
  assert.equal(cloud.apiPaid, 'Team');

  const self = byId.get('sentry-self-hosted');
  assert.ok(self, 'sentry-self-hosted가 없다');
  assert.equal(self.composeMemoryGb, 16);
  assert.equal(self.swapGb, 16);
  assert.equal(self.scalingGuide, false);
  assert.equal(self.singlePoint, true);

  const glitch = byId.get('glitchtip-self-hosted');
  assert.ok(glitch, 'glitchtip-self-hosted가 없다');
  assert.equal(glitch.license, 'MIT');
  assert.equal(glitch.postgresMin, 14);
  assert.equal(glitch.memoryMb, 512);
  assert.equal(glitch.valkey, '선택');
  assert.equal(glitch.helm, true);
  assert.equal(glitch.api, '미확인');

  assert.ok(Array.isArray(mod.F0815_SENTRY_CRITERIA), 'F0815_SENTRY_CRITERIA가 없다');
  assert.deepEqual(mod.F0815_SENTRY_CRITERIA.map((c) => c.id), ['overseas', 'error-peak', 'availability', 'console-api', 'annual-cost']);
  for (const c of mod.F0815_SENTRY_CRITERIA) {
    assert.equal(typeof c.label, 'string');
    assert.ok(c.label.length > 0);
    assert.equal(typeof c.question, 'string');
    assert.ok(c.question.length > 0);
  }
});

test('F0815-4 ② Sentry 판정이 피크·API·국외 이전·가용성 증거 없이는 통과하지 않는다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.judgeSentryBackend, 'function', 'judgeSentryBackend 함수가 없다');

  const noPeak = mod.judgeSentryBackend({ candidate: 'sentry-cloud', peakMeasured: false, apiConfirmed: true, overseasTransferReady: true, availabilityOk: true, annualCostUsd: 312 });
  assert.equal(noPeak.verdict, '미측정');
  assert.ok(noPeak.reasons.includes('PEAK_UNMEASURED'));

  const noApi = mod.judgeSentryBackend({ candidate: 'sentry-cloud', peakMeasured: true, runId: 'r1', runExists: true, apiConfirmed: false, overseasTransferReady: true, availabilityOk: true, annualCostUsd: 312 });
  assert.equal(noApi.verdict, '판정 못 함');
  assert.ok(noApi.reasons.includes('API_UNCONFIRMED'));

  const noTransfer = mod.judgeSentryBackend({ candidate: 'sentry-cloud', peakMeasured: true, runId: 'r1', runExists: true, apiConfirmed: true, overseasTransferReady: false, availabilityOk: true, annualCostUsd: 312 });
  assert.equal(noTransfer.verdict, '판정 못 함');
  assert.ok(noTransfer.reasons.includes('R3_NOT_READY'));

  const noAvailability = mod.judgeSentryBackend({ candidate: 'sentry-self-hosted', peakMeasured: true, runId: 'r1', runExists: true, apiConfirmed: true, overseasTransferReady: true, availabilityOk: false, annualCostUsd: 100 });
  assert.equal(noAvailability.verdict, '판정 못 함');
  assert.ok(noAvailability.reasons.includes('AVAILABILITY_RISK'));

  const noCost = mod.judgeSentryBackend({ candidate: 'glitchtip-self-hosted', peakMeasured: true, runId: 'r1', runExists: true, apiConfirmed: true, overseasTransferReady: true, availabilityOk: true, annualCostUsd: null });
  assert.equal(noCost.verdict, '판정 못 함');
  assert.ok(noCost.reasons.includes('COST_MISSING'));

  const ok = mod.judgeSentryBackend({ candidate: 'glitchtip-self-hosted', peakMeasured: true, runId: 'r1', runExists: true, apiConfirmed: true, overseasTransferReady: true, availabilityOk: true, annualCostUsd: 100 });
  assert.equal(ok.verdict, '통과');
  for (const id of ['overseas', 'error-peak', 'availability', 'console-api', 'annual-cost']) assert.ok(ok.criteria[id], `criteria.${id}가 없다`);
});

test('F0815-5 ① 오류 피크를 실행 증거 없이 측정했다고 하면 무효다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.judgeSentryBackend, 'function', 'judgeSentryBackend 함수가 없다');

  const fake = mod.judgeSentryBackend({ candidate: 'glitchtip-self-hosted', peakMeasured: true, runId: null, runExists: false, apiConfirmed: true, overseasTransferReady: true, availabilityOk: true, annualCostUsd: 100 });
  assert.equal(fake.verdict, '무효');
  assert.ok(fake.reasons.includes('NO_RUN'));

  const claim = mod.judgeSentryBackend({ candidate: 'glitchtip-self-hosted', peakMeasured: false, apiConfirmed: true, overseasTransferReady: true, availabilityOk: true, annualCostUsd: 100, claimPass: true });
  assert.notEqual(claim.verdict, '통과');
});

test('F0815-5 ② 비용 차이 10.0%는 유지, 10.1%는 비교하고 미계산이면 판정 못 함이다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.judgeBackendChoice, 'function', 'judgeBackendChoice 함수가 없다');

  const ten = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 90, directAnnualUsd15: 150, datadogAnnualUsd15: 90, ownerApproved: true });
  assert.equal(ten.choice, 'keep-direct');
  const tenOne = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: 100, datadogAnnualUsd: 89.9, directAnnualUsd15: 150, datadogAnnualUsd15: 89.9, ownerApproved: true });
  assert.equal(tenOne.choice, 'review-datadog');
  const missing = mod.judgeBackendChoice({ r1Fits: true, personalData: false, directAnnualUsd: null, datadogAnnualUsd: 50, ownerApproved: true });
  assert.equal(missing.verdict, '판정 못 함');
  assert.ok(missing.reasons.includes('R2_INPUT_MISSING'));
});

test('F0815-6 ① 가림 계약이 실제 error-reporting.ts 잠금과 F0815_SENTRY_LOCK을 맞춘다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.validateSentryConfig, 'function', 'validateSentryConfig 함수가 없다');
  assert.deepEqual(mod.F0815_SENTRY_LOCK, SENTRY_LOCK);
  assert.equal(mod.validateSentryConfig(SENTRY_LOCK).ok, true);
  assert.equal(mod.validateSentryConfig(mod.F0815_SENTRY_LOCK).ok, true);

  const source = read(ERROR_REPORTING);
  for (const token of [
    'sendDefaultPii: false', 'userInfo: false', 'cookies: false', 'httpHeaders: false', 'httpBodies: []',
    'urlQueryParams: false', 'graphQL: { document: false, variables: false }', 'genAI: { inputs: false, outputs: false }',
    'traceLifecycle: \'static\'', 'sendClientReports: false', 'maxBreadcrumbs: 0', 'attachStacktrace: false',
    'beforeSend: (event) => lockEvent(event)', 'redactDeep', 'accountRef',
  ]) {
    assert.ok(source.includes(token), `error-reporting.ts에 ${token}가 없다`);
  }

  const bad = [
    { ...SENTRY_LOCK, sendDefaultPii: true },
    { ...SENTRY_LOCK, dataCollection: { ...SENTRY_LOCK.dataCollection, userInfo: true } },
    { ...SENTRY_LOCK, dataCollection: { ...SENTRY_LOCK.dataCollection, cookies: true } },
    { ...SENTRY_LOCK, dataCollection: { ...SENTRY_LOCK.dataCollection, httpHeaders: true } },
    { ...SENTRY_LOCK, dataCollection: { ...SENTRY_LOCK.dataCollection, urlQueryParams: true } },
    { ...SENTRY_LOCK, dataCollection: { ...SENTRY_LOCK.dataCollection, httpBodies: ['body'] } },
    { ...SENTRY_LOCK, traceLifecycle: 'dynamic' },
    { ...SENTRY_LOCK, maxBreadcrumbs: 10 },
    { ...SENTRY_LOCK, attachStacktrace: true },
    { ...SENTRY_LOCK, beforeSend: 'none' },
    { ...SENTRY_LOCK, userRef: 'userId' },
    { ...SENTRY_LOCK, replay: true },
    { ...SENTRY_LOCK, tracing: true },
    { ...SENTRY_LOCK, piiPatterns: 'docs/pii.json' },
  ];
  for (const config of bad) {
    const result = mod.validateSentryConfig(config);
    assert.equal(result.ok, false, `가림 계약이 통과했다: ${JSON.stringify(config)}`);
    assert.ok(result.problems.length > 0);
  }
});

test('F0815-6 ② 2차 마스킹 원천이 있고 containsPii가 사설 IP를 PII로 보지 않는다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.containsPii, 'function', 'containsPii 함수가 없다');
  const pii = readJson(PII);
  assert.ok(Array.isArray(pii.patterns) && pii.patterns.length > 0, 'pii-patterns.json에 패턴이 없다');
  const names = pii.patterns.map((p) => p.name);
  for (const name of ['email', 'phone-kr', 'phone-e164', 'card', 'bank-account-path']) assert.ok(names.includes(name), `${name} 패턴이 없다`);

  assert.equal(mod.containsPii('010-1234-5678'), true);
  assert.equal(mod.containsPii('+821012345678'), true);
  assert.equal(mod.containsPii('a@b.co'), true);
  assert.equal(mod.containsPii('1234-5678-9012-3456'), true);
  assert.equal(mod.containsPii('/bank-accounts/abc/secret/holder'), true);
  assert.equal(mod.containsPii('10.1.2.3'), false);
  assert.equal(mod.containsPii('172.20.1.1'), false);
  assert.equal(mod.containsPii('192.168.0.1'), false);
  assert.equal(mod.containsPii('2026-11-28T10:00:00+09:00'), false);
});

test('F0815-7 ① M4 초안 계약이 2편·K8/K9·미측정·draft·owner·정확한 근거를 지킨다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.validateM4Drafts, 'function', 'validateM4Drafts 함수가 없다');
  assert.ok(Array.isArray(mod.F0815_M4_DRAFTS), 'F0815_M4_DRAFTS가 없다');
  assert.deepEqual(mod.F0815_M4_DRAFTS.map((d) => d.id), ['m4-control-gameday', 'm4-scaling-cost']);
  assert.deepEqual(mod.F0815_M4_DRAFTS[0].evidence, ['F-08-14', 'F-08-13']);
  assert.deepEqual(mod.F0815_M4_DRAFTS[1].evidence, ['F-08-14']);
  for (const draft of mod.F0815_M4_DRAFTS) {
    assert.deepEqual(draft.measuredKpis, []);
    assert.equal(draft.designOnlyKpis.length, 0);
    assert.deepEqual(draft.pendingKpis, draft.kpis);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.publish, 'owner');
    assert.deepEqual(draft.claims, []);
  }
  assert.equal(mod.validateM4Drafts(GOOD_DRAFTS).ok, true);

  assert.equal(mod.validateM4Drafts([GOOD_DRAFTS[0]]).ok, false);
  assert.equal(mod.validateM4Drafts([{ ...GOOD_DRAFTS[0], measuredKpis: ['K8'], pendingKpis: [] }, GOOD_DRAFTS[1]]).ok, false);
  assert.equal(mod.validateM4Drafts([{ ...GOOD_DRAFTS[0], evidence: ['F-08-14', 'F-08-6'] }, GOOD_DRAFTS[1]]).ok, false);
  assert.equal(mod.validateM4Drafts([{ ...GOOD_DRAFTS[0], evidence: ['F-08-14', 'F-08-9'] }, GOOD_DRAFTS[1]]).ok, false);
  assert.equal(mod.validateM4Drafts([{ ...GOOD_DRAFTS[0], claims: ['K8 100%'] }, GOOD_DRAFTS[1]]).ok, false);
  assert.equal(mod.validateM4Drafts([{ ...GOOD_DRAFTS[0], status: 'published' }, GOOD_DRAFTS[1]]).ok, false);
  assert.equal(mod.validateM4Drafts([{ ...GOOD_DRAFTS[0] }, { ...GOOD_DRAFTS[0] }]).ok, false);
});

test('F0815-7 ② M4 초안 파일이 머리 네 줄·다섯 절·미측정·근거·PII 없음·README 상태를 지킨다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.validateM4Outline, 'function', 'validateM4Outline 함수가 없다');

  assert.equal(mod.validateM4Outline(VALID_M4, { id: 'm4-control-gameday' }).ok, true);
  assert.equal(mod.validateM4Outline(VALID_M4.replace('- **상태**: 초안(2026-11-28, 게시 전)\n', ''), { id: 'm4-control-gameday' }).ok, false);
  assert.equal(mod.validateM4Outline(`${VALID_M4}\n게시했다.\n`, { id: 'm4-control-gameday' }).ok, false);
  assert.equal(mod.validateM4Outline(`${VALID_M4}\n연락처 a@b.co\n`, { id: 'm4-control-gameday' }).ok, false);
  assert.equal(mod.validateM4Outline(`${VALID_M4}\nK8은 미측정이다. 30k/s를 달성했다.\n`, { id: 'm4-control-gameday' }).ok, false);

  for (const [id, file] of Object.entries(M4_FILES)) {
    const markdown = read(file);
    const result = mod.validateM4Outline(markdown, { id });
    assert.equal(result.ok, true, `${id}: ${result.reasons.join('; ')}`);
    for (const section of ['## 1. 무엇을 설명하나', '## 2. 설계', '## 3. 측정 근거', '## 4. 한계', '## 5. 게시 전 확인']) {
      assert.ok(markdown.includes(section), `${id}: ${section}가 없다`);
    }
    for (const head of ['- **상태**: 초안(', '게시 전', '- **근거**:', '- **숫자 표시**:', 'publish: owner', 'draft']) {
      assert.ok(markdown.includes(head), `${id}: 머리에 ${head}가 없다`);
    }
    assert.ok(markdown.includes('미측정'), `${id}: 미측정이 없다`);
    assert.ok(markdown.includes('F-08-14'), `${id}: F-08-14가 없다`);
    assert.equal(forbiddenOutsideNegation(markdown).length, 0, `${id}: 금지 수치가 부정문 밖에 있다`);
    assert.equal(mod.containsPii(markdown), false, `${id}: PII가 있다`);
  }
  assert.ok(read(M4_FILES['m4-control-gameday']).includes('F-08-13'));
  assert.ok(read(M4_FILES['m4-scaling-cost']).includes('[추정]'));

  const blog = read(BLOG_README);
  assert.match(blog, /\| M4 \|[^\n]*초안\(2026-11-28\)[^\n]*게시 전/);
});

test('F0815-8 ① 보고서 뼈대가 §1~§7·선행 인용 6개·통과 행 0개·실측 없음을 담는다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.validateF0815Report, 'function', 'validateF0815Report 함수가 없다');
  const markdown = read(REPORT);
  const result = mod.validateF0815Report(markdown);
  assert.equal(result.ok, true, result.reasons.join('; '));
  for (const section of ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.']) assert.ok(markdown.includes(section), `${section}가 없다`);
  for (const id of PRIOR) assert.ok(markdown.includes(id), `${id} 인용이 없다`);
  for (const id of ['m4-control-gameday', 'm4-scaling-cost']) assert.ok(markdown.includes(id), `${id} 행이 없다`);
  assert.equal(passRows(markdown).length, 0, `통과 행이 있다: ${passRows(markdown).join(' / ')}`);
  assert.ok(!markdown.includes('실측(PC)'));
  assert.ok(markdown.includes('미측정'));
  assert.ok(markdown.includes('판정 못 함'));
});

test('F0815-8 ② 보고서 검증이 증거 없는 통과·금지 수치 여섯·PII·선행 인용 누락을 거부한다', async () => {
  const mod = need(await load());
  const base = read(REPORT);
  assert.equal(passRows(base).length, 0);

  const passRow = `${base}\n| 보내기 | 3h-1 | 통과 | — |\n`;
  assert.equal(mod.validateF0815Report(passRow).ok, false);

  assert.equal(mod.validateF0815Report(`${base}\n실측(PC)\n`).ok, false);
  for (const token of FORBIDDEN) {
    assert.equal(mod.validateF0815Report(`${base}\n${token}\n`).ok, false, `${token}를 거부하지 않았다`);
  }
  assert.equal(mod.validateF0815Report(`${base}\nK8은 미측정이다. 30k/s를 달성했다.\n`).ok, false, '미측정 한 단어가 다른 금지 수치를 면제했다');
  assert.equal(mod.validateF0815Report(`${base}\n연락처 a@b.co\n`).ok, false);
  assert.equal(mod.validateF0815Report(`${base}\n010-1234-5678\n`).ok, false);
  assert.equal(mod.validateF0815Report(`${base}\n카드 1234-5678-9012-3456\n`).ok, false);
  assert.equal(mod.validateF0815Report(`${base}\n사설 IP 10.1.2.3은 PII가 아니다.\n`).ok, true);

  let missing = base;
  for (const id of PRIOR) missing = missing.replaceAll(id, '');
  assert.equal(mod.validateF0815Report(missing).ok, false);
});

test('F0815-9 ① 계획 JSON이 hours:4·입력·의존·보내기·Sentry·M4·중단 규칙 내용·잠금·경계를 담는다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.validateF0815Plan, 'function', 'validateF0815Plan 함수가 없다');
  const plan = readJson(PLAN_JSON);
  const result = mod.validateF0815Plan(plan);
  assert.equal(result.ok, true, result.reasons.join('; '));
  assert.equal(plan.batch, 'F-08-15');
  assert.equal(plan.feature, 'F-08-15');
  assert.equal(plan.windows['3h'].hours, 4);
  assert.deepEqual(plan.windows['3h'].steps, ['3h-1', '3h-2', '3h-3']);
  assert.equal(plan.dependency.feature, 'F-08-14');
  assert.equal(plan.dependency.status, '미측정');
  assert.deepEqual(plan.dependency.inputs, ['K8', 'K9', 'series', 'samplesPerSecond', 'logGbPerDay', 'traceGbPerDay', 'nodes', 'consoleUsers', 'backendR2']);
  assert.equal(plan.send.external, false);
  assert.equal(plan.send.freeSamples, 40_000_000);
  assert.equal(plan.send.priceDate, '2026-10-14');
  assert.equal(plan.sentry.install, false);
  assert.equal(plan.sentry.dsn, '');
  assert.equal(plan.sentry.candidates, 3);
  assert.equal(plan.sentry.verdict, '판정 못 함');
  assert.deepEqual(plan.m4, ['m4-control-gameday', 'm4-scaling-cost']);
  assert.equal(plan.stopRules.length, 10);
  assert.deepEqual(plan.stopRules.map((r) => r.id), ['STOP-01', 'STOP-02', 'STOP-03', 'STOP-04', 'STOP-05', 'STOP-06', 'STOP-07', 'STOP-08', 'STOP-09', 'STOP-10']);
  for (const rule of plan.stopRules) assert.ok(rule.rule.length > 0, `${rule.id} 내용이 비었다`);
  assert.equal(plan.lock.take, 'docker lane4-F-08-15');
  assert.equal(plan.lock.drop, 'docker lane4-F-08-15');
  assert.equal(plan.lock.dockerAll, false);
  assert.equal(plan.lock.used, false);
  for (const boundary of ['F-08-14', 'F-08-6', 'F-08-13']) {
    assert.ok(plan.boundaries.some((b) => b.feature === boundary), `${boundary} 경계가 없다`);
  }
  for (const id of ['K8', 'K9', 'V-T18', 'V-T27', 'V-T28', 'P-T1', 'SR-T13', 'NFR-028', 'Q-T2', 'S-T1', 'V-T10', 'NFR-027', 'V-T4', 'V-T5', 'V-T17']) {
    assert.ok(plan.notIncluded.includes(id), `notIncluded에 ${id}가 없다`);
  }
});

test('F0815-9 ② 계획 문서가 정본 자리·범위·계산식·경계·## 검증을 담고 금지 수치를 부정문 밖에 두지 않는다', async () => {
  const markdown = read(PLAN_DOC);
  for (const token of ['## 1. 정본 자리', '## 3. 범위', '## 6. 측정 설계', '## 7. 경계 표', '## 8. 시험', '## 10. F-08-14 의존', '## 검증', '## 담당 표']) {
    assert.ok(markdown.includes(token), `${token}가 없다`);
  }
  for (const token of [
    '3h-1', '3h-2', '3h-3', 'hours: 4', '40,000,000', '86,400', 'R1', 'R2', 'R3',
    'GlitchTip', 'm4-control-gameday', 'm4-scaling-cost', 'F-08-14',
    'F0815_SENTRY_LOCK', '사설 IP는 이 기능의 PII가 아니다', 'F-08-13 계획의 예정 판정', '476줄', 'docs/blog/README.md',
  ]) {
    assert.ok(markdown.includes(token), `${token}가 없다`);
  }
  for (const id of PRIOR) assert.ok(markdown.includes(id), `${id} 인용이 없다`);
  // 리뷰 기록(§11.1)은 발견 사례를 그대로 인용하므로 금지 수치 검사에서 뺀다. 계획 본문만 본다.
  const body = markdown.split('### 11.1 리뷰 결과')[0];
  assert.equal(forbiddenOutsideNegation(body).length, 0, `금지 수치가 부정문 밖에 있다: ${forbiddenOutsideNegation(body).join(' / ')}`);
});

test('F0815-10 ① 인자 검사가 전송·계정·Docker·kind·k6·브라우저 인자를 거부한다', async () => {
  const mod = need(await load());
  assert.equal(typeof mod.parseF0815Args, 'function', 'parseF0815Args 함수가 없다');

  const ok = mod.parseF0815Args(['--plan', 'loadtest/plan/f0815-plan.json', '--out', '.cache/peaket-f0815', '--check', '--report', 'docs/review/measurements/F-08-15.md']);
  assert.equal(ok.plan, 'loadtest/plan/f0815-plan.json');
  assert.equal(ok.out, '.cache/peaket-f0815');
  assert.equal(ok.check, true);
  assert.equal(ok.report, 'docs/review/measurements/F-08-15.md');

  usage(() => mod.parseF0815Args(['--send']));
  usage(() => mod.parseF0815Args(['--sentry-dsn', 'https://x']));
  usage(() => mod.parseF0815Args(['--glitchtip-url', 'http://x']));
  usage(() => mod.parseF0815Args(['--datadog-api-key', 'x']));
  usage(() => mod.parseF0815Args(['--docker']));
  usage(() => mod.parseF0815Args(['--docker-all']));
  usage(() => mod.parseF0815Args(['--kind']));
  usage(() => mod.parseF0815Args(['--k6']));
  usage(() => mod.parseF0815Args(['--browser']));
});

test('F0815-10 ② 모듈이 다른 Game Day 모듈·네트워크를 어떤 꼴로도 쓰지 않고 외부 전송·클라우드 비용·Docker를 끈다', async () => {
  const mod = need(await load());
  assert.equal(mod.F0815_EXTERNAL_SEND, false);
  assert.equal(mod.F0815_CLOUD_COST, false);
  assert.equal(mod.F0815_DOCKER_USED, false);

  const source = read(RUNNER);
  assert.ok(!/from\s+['"][^'"]*gameday(?:-local|-recovery)?\.mjs['"]/.test(source), '정적 import로 Game Day 모듈을 쓴다');
  assert.ok(!/import\s*\(\s*['"][^'"]*gameday(?:-local|-recovery)?\.mjs['"]\s*\)/.test(source), '동적 import로 Game Day 모듈을 쓴다');
  assert.ok(!/require\s*\(\s*['"][^'"]*gameday(?:-local|-recovery)?\.mjs['"]\s*\)/.test(source), 'require로 Game Day 모듈을 쓴다');
  assert.ok(!/\bfetch\s*\(/.test(source), 'fetch를 쓴다');
  assert.ok(!/from\s+['"]node:(?:https?|net|tls)['"]/.test(source), '네트워크 모듈을 import한다');
  assert.ok(!/require\s*\(\s*['"]node:(?:https?|net|tls)['"]\s*\)/.test(source), 'require로 네트워크 모듈을 쓴다');
});
