// 경보 규칙 검사 alert-check의 명령줄·함수 시험(F-01-7 A1, OPS-130, 시험 V-T16·V-T20 ①②③·V-T54 ①②).
// 정본: docs/observability.md §4 '긁기·평가·알림 간격'(간격 규칙 셋과 '검사 방법')·§5 '경보 묶기와 억제'의 '경보 규칙 검사'·§8 허용 라벨과 표준 칸 목록,
// docs/verification.md §2.7과 시험 표. 계획 docs/review/plans/F-01-7.md §3·§5·§6.
// 검사를 바깥에서 돌린다: node tools/ci/alert-check.mjs --root <임시 저장소>. 임시 저장소에는 계획 §5 '읽는 파일'을 복사하고 사례마다 한 곳을 바꾼다.
// 끝 코드 0 통과, 1 위반('막음: <저장소 기준 경로>: <경보·묶음·시험 묶음 이름>: <까닭>'), 2 인자 오류·읽을 파일 없음·규칙 파일 0개·정본 목록이나 상수를 못 읽음.
// 명령줄을 자식 프로세스로 띄우는 것은 CI가 부르는 꼴(끝 코드·출력)을 보려는 것이다(계획 §9 '부르는 쪽을 본다'). 실제 포트·시계는 쓰지 않는다.
// Alertmanager 설정: F-01-6이 만드는 alertmanager.yaml은 아직 없다. A1 시험은 이 파일의 정본 꼴 대역(아래 ALERTMANAGER)을 언제나 임시 저장소에 쓴다.
// 실제 Alertmanager 설정의 묶음 값·억제 검사는 계획 §6의 묶음 값 시험(F-01-6 합친 뒤, A2)이 본다.
// 단언 값(4배·3배, 5초·15초·30초, 표준 칸, 허용 라벨)은 정본에서 적는다. 도구의 상수를 가져오지 않는다.
// 실행(저장소 뿌리): node --test tools/ci/alert-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'alert-check.mjs');
const REPO = resolve(HERE, '..', '..');

const OBS = 'deploy/platform/observability';
const ONSALE = `${OBS}/rules/slo-onsale.yaml`;
const SLO28D = `${OBS}/rules/slo-28d.yaml`;
const AGG5M = `${OBS}/rules/agg5m.yaml`;
const MIMIR = `${OBS}/mimir/rules/slo-budget28d.yaml`;
const RTGW = `${OBS}/alerts/realtime-gw.yaml`;
const ONSALE_TEST = `${OBS}/test/slo-onsale.test.yaml`;
const SLO28D_TEST = `${OBS}/test/slo-28d.test.yaml`;
const BUDGET_TEST = `${OBS}/test/slo-budget28d.test.yaml`;
const ALERT_CHECK = `${OBS}/alert-check.yaml`;
const AM = `${OBS}/alertmanager/alertmanager.yaml`;
const GATEWAYS = 'deploy/gateways';
const ENVOY = `${GATEWAYS}/envoy-histograms.yaml`;
const DOC = 'docs/observability.md';
const METRICS = 'packages/platform/src/metrics.ts';
const PII = 'packages/platform/src/pii-patterns.json';
const PLAN_TS = 'services/admission-ctrl/src/modules/leader/domain/plan.ts';
const CONTROL_TS = 'services/admission-ctrl/src/modules/leader/adapters/prometheus-control-inputs.ts';

/** 규칙 시험 간격 예외(docs/observability.md §4 '검사 방법' ③: 28일 1배 묶음과 V-T20 ④ 묶음 둘뿐) */
const EXCEPTION_28D = 'V-T51 ⑥ 28일 1배(3일·6시간) 경보는 두 창이 모두 넘을 때만 SEV3이다';
const EXCEPTION_VT20_4 = 'V-T20 ④ 긁기 흔들림과 빠진 표본이 있어도 20초 창이 비지 않고 10배 경계를 지킨다';
const VT51_1 = 'V-T51 ① 온세일 10배 경보는 2분·20초 두 창이 모두 넘을 때만 SEV1이다';

/** 표준 칸 목록(초, docs/observability.md §8 '히스토그램 버킷 구성')을 밀리초로(Envoy histogram_bucket_settings 꼴) */
const STANDARD_BUCKETS_MS = [5, 10, 20, 50, 100, 150, 200, 250, 300, 500, 600, 800, 1000, 1500, 1800, 2000, 2500, 3000, 5000, 10000, 30000, 60000];

/**
 * Alertmanager 설정의 정본 꼴 대역(docs/observability.md §4 간격 표 SEV1·SEV2 group_wait 5초·group_interval 1분, SEV3 기본값,
 * §5 '첫 구현'의 묶기·억제·승인 대기 경로, 계획 §5 'Alertmanager 설정 꼴'). 경보 이름 경로는 Watchdog·OpsApprovalPending 둘이다.
 */
const ALERTMANAGER = {
  route: {
    receiver: 'slack-ops',
    routes: [
      { matchers: ['alertname="Watchdog"'], receiver: 'deadman' },
      { matchers: ['alertname="OpsApprovalPending"'], receiver: 'irm-oncall' },
      { matchers: ['severity="sev1"'], receiver: 'irm-oncall', group_by: ['event_id', 'journey', 'severity'], group_wait: '5s', group_interval: '1m' },
      { matchers: ['severity="sev2"'], receiver: 'slack-ops', group_by: ['event_id', 'journey', 'severity'], group_wait: '5s', group_interval: '1m' },
      { matchers: ['severity="sev3"'], receiver: 'github-tickets', group_by: ['kind', 'severity'] },
    ],
  },
  inhibit_rules: [
    {
      source_matchers: ['severity="sev1"', 'kind="slo"', 'event_id=~".+"', 'journey=~".+"'],
      target_matchers: ['severity="sev2"'],
      equal: ['event_id', 'journey'],
    },
  ],
  receivers: [{ name: 'slack-ops' }, { name: 'irm-oncall' }, { name: 'deadman' }, { name: 'github-tickets' }],
};

function cli(...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
const run = (root) => cli('--root', root);
const blocked = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('막음:'));
const readIn = (root, rel) => readFileSync(join(root, rel), 'utf8');
const writeIn = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
/** 글에서 정확히 한 군데만 바꾼다(바꿀 곳이 없거나 여럿이면 시험 준비가 틀린 것이다) */
function replaceOnce(root, rel, from, to) {
  const text = readIn(root, rel);
  const count = text.split(from).length - 1;
  assert.equal(count, 1, `${rel}에서 '${from}'이 ${count}번 나온다`);
  writeIn(root, rel, text.replace(from, to));
}
/** YAML 파일을 읽어 바꾸고 쓴다(주석은 잃어도 된다) */
function editYaml(root, rel, fn) {
  const doc = parse(readIn(root, rel));
  fn(doc);
  writeIn(root, rel, stringify(doc, { lineWidth: 0 }));
}
const groupsOf = (doc) => doc.spec?.groups ?? doc.groups;
function groupOf(doc, name) {
  const g = groupsOf(doc).filter((x) => x.name === name);
  assert.equal(g.length, 1, `규칙 묶음 ${name}`);
  return g[0];
}
function alertOf(doc, name) {
  const found = groupsOf(doc).flatMap((g) => g.rules.filter((r) => r.alert === name));
  assert.equal(found.length, 1, `경보 ${name}`);
  return found[0];
}
const pushRule = (root, rel, group, rule) => editYaml(root, rel, (d) => groupOf(d, group).rules.push(rule));
/** 주석·라벨이 모두 갖춰진 경보(kind cause라 explore_url은 필요 없다). 사례마다 한 곳만 어긋나게 바꾼다 */
function alert(name, expr, { labels = {}, annotations = {} } = {}) {
  return {
    alert: name,
    expr,
    labels: { severity: 'sev2', kind: 'cause', dependency: 'fixture', ...labels },
    annotations: {
      summary: '시험 경보',
      runbook_url: 'https://github.com/peaket/peaket/blob/develop/docs/infra.md#rb-23-배포-되돌리기와-동결-중-긴급-변경',
      dashboard_url: '/d/fixture',
      ...annotations,
    },
  };
}
const testGroup = (doc, name) => {
  const g = doc.tests.filter((t) => t.name === name);
  assert.equal(g.length, 1, `시험 묶음 ${name}`);
  return g[0];
};

/** 계획 §5 '읽는 파일'만 복사한 임시 저장소. Alertmanager 설정은 정본 꼴 대역을 쓴다. 시험이 끝나면 지운다 */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'alert-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const rel of [OBS, GATEWAYS]) if (existsSync(join(REPO, rel))) cpSync(join(REPO, rel), join(root, rel), { recursive: true });
  for (const rel of [DOC, METRICS, PII, PLAN_TS, CONTROL_TS]) writeIn(root, rel, readIn(REPO, rel));
  writeIn(root, AM, stringify(ALERTMANAGER));
  return root;
}
function assertPass(root, why = '') {
  const r = run(root);
  assert.equal(r.status, 0, `${why}\n${r.out}`);
  assert.deepEqual(blocked(r.out), [], `${why}\n${r.out}`);
  return r;
}
/**
 * 끝 코드 1이고, 막은 줄 가운데 그 파일·이름(과 넣은 글자)을 가진 줄이 있다.
 * only면 막은 줄이 그 하나뿐이다(바꾼 한 곳 밖을 막지 않는다).
 */
function assertBlocked(root, file, { name, has = [], only = false } = {}) {
  const r = run(root);
  assert.equal(r.status, 1, r.out);
  const lines = blocked(r.out);
  const hit = lines.filter((l) => l.startsWith(`막음: ${file}: `) && (name === undefined || l.includes(name)) && has.every((h) => l.includes(h)));
  assert.ok(hit.length >= 1, `막은 줄에 ${file} ${name ?? ''} ${has.join(' ')}이 없다\n${r.out}`);
  if (only) assert.equal(lines.length, 1, `막은 줄이 하나여야 한다\n${r.out}`);
  return lines;
}
function assertExit2(root, why) {
  const r = run(root);
  assert.equal(r.status, 2, `${why}\n${r.out}`);
  assert.deepEqual(blocked(r.out), [], `${why}: 2는 막음 줄 없이 끝난다\n${r.out}`);
}

// ---------------------------------------------------------------------------
// V-T20 ① 짧은 창과 조회 창 ≥ 긁기 간격 × 4(docs/observability.md §4 간격 규칙 ①과 '검사 방법')
// ---------------------------------------------------------------------------

test('V-T20 ① 5초 긁기 지표에 10초 창을 쓰는 규칙을 막는다', (t) => {
  // 기준: 실제 규칙 파일(realtime-gw.yaml을 고친 뒤)은 통과한다
  assertPass(fixture(t), '실제 규칙 파일');

  // 5초 묶음(slo-onsale, 평가 5초 = slo-fast 긁기 5초)의 원천 지표: 4 × 5초 = 20초가 경계
  const raw10 = fixture(t);
  pushRule(raw10, ONSALE, 'slo-onsale', alert('vt20_raw_10s', 'sum(rate(http_server_errors_total[10s])) > 0'));
  assertBlocked(raw10, ONSALE, { name: 'vt20_raw_10s', has: ['10s'], only: true });
  const raw20 = fixture(t);
  pushRule(raw20, ONSALE, 'slo-onsale', alert('vt20_raw_20s', 'sum(rate(http_server_errors_total[20s])) > 0'));
  assertPass(raw20, '5초 묶음 원천 지표 20초 창(4×5)');

  // 30초 묶음(slo-28d)의 원천 지표: 그 밖의 긁기 15초로 보아 4 × 15초 = 1분이 경계
  const raw30 = fixture(t);
  pushRule(raw30, SLO28D, 'slo-28d', alert('vt20_raw_30s', 'sum(rate(http_server_errors_total[30s])) > 0'));
  assertBlocked(raw30, SLO28D, { name: 'vt20_raw_30s', has: ['30s'], only: true });
  const raw1m = fixture(t);
  pushRule(raw1m, SLO28D, 'slo-28d', alert('vt20_raw_1m', 'sum(rate(http_server_errors_total[1m])) > 0'));
  assertPass(raw1m, '30초 묶음 원천 지표 1분 창(4×15)');

  // 5초 묶음이 내는 기록 규칙 이름을 30초 묶음에서 읽으면 긁기 간격은 그 기록 규칙 묶음의 평가 5초: 20초가 경계
  const rec15 = fixture(t);
  pushRule(rec15, SLO28D, 'slo-28d', alert('vt20_record_15s', 'max_over_time(peaket:slo_error_ratio:rate20s{journey="hold"}[15s]) > 1'));
  assertBlocked(rec15, SLO28D, { name: 'vt20_record_15s', has: ['15s'], only: true });
  const rec20 = fixture(t);
  pushRule(rec20, SLO28D, 'slo-28d', alert('vt20_record_20s', 'max_over_time(peaket:slo_error_ratio:rate20s{journey="hold"}[20s]) > 1'));
  assertPass(rec20, '5초 기록 규칙을 30초 묶음에서 20초 창으로(원천 지표로 잘못 보면 1분이 경계라 막힌다)');

  // 부분 조회 [창:해상도]의 창도 같은 식으로 본다
  const sub10 = fixture(t);
  pushRule(sub10, ONSALE, 'slo-onsale', alert('vt20_subquery_10s', 'max_over_time(peaket:slo_error_ratio:rate20s{journey="hold"}[10s:5s]) > 1'));
  assertBlocked(sub10, ONSALE, { name: 'vt20_subquery_10s', has: ['10s'], only: true });
  const sub20 = fixture(t);
  pushRule(sub20, ONSALE, 'slo-onsale', alert('vt20_subquery_20s', 'max_over_time(peaket:slo_error_ratio:rate20s{journey="hold"}[20s:5s]) > 1'));
  assertPass(sub20, '부분 조회 20초 창');
});

test('V-T20 ① 규칙 묶음에 평가 간격이 없으면 막는다(CRD와 Mimir 규칙 파일 둘 다)', (t) => {
  const crd = fixture(t);
  editYaml(crd, AGG5M, (d) => delete groupOf(d, 'agg5m-service-signals').interval);
  assertBlocked(crd, AGG5M, { name: 'agg5m-service-signals' });

  const plain = fixture(t);
  editYaml(plain, MIMIR, (d) => delete groupOf(d, 'slo-budget28d').interval);
  assertBlocked(plain, MIMIR, { name: 'slo-budget28d' });
});

// ---------------------------------------------------------------------------
// V-T20 ② 제어 입력 없음 판정 ≥ 긁기 간격 × 3(§4 간격 규칙 ②)
// ---------------------------------------------------------------------------

test('V-T20 ② 입력 없음 판정을 10초로 바꾸면 막는다', (t) => {
  const real = fixture(t);
  // 정본: 입력 없음 판정 30초(§4 간격 규칙 ②)
  assert.match(readIn(real, PLAN_TS), /export const INPUT_STALE_MS = 30_000;/);
  assertPass(real, '실제 INPUT_STALE_MS 30초');

  // 자동 제어가 읽는 이름은 5초 묶음의 기록 규칙과 slo-fast 원천 지표라 가장 긴 간격이 5초: 3 × 5초 = 15초가 경계
  const ten = fixture(t);
  replaceOnce(ten, PLAN_TS, 'export const INPUT_STALE_MS = 30_000;', 'export const INPUT_STALE_MS = 10_000;');
  assertBlocked(ten, PLAN_TS, { name: 'INPUT_STALE_MS' });
  const fifteen = fixture(t);
  replaceOnce(fifteen, PLAN_TS, 'export const INPUT_STALE_MS = 30_000;', 'export const INPUT_STALE_MS = 15_000;');
  assertPass(fifteen, 'INPUT_STALE_MS 15초(3×5)');

  // 가장 긴 간격과 견준다: 읽는 이름 하나를 30초 묶음의 기록 규칙으로 바꾸면 3 × 30초 = 90초라 30초 판정을 막는다
  const slowName = fixture(t);
  replaceOnce(slowName, CONTROL_TS, "valueAndTime('seat_store_unavailable', BY_EVENT)", "valueAndTime('peaket:slo_error_ratio:rate30m', BY_EVENT)");
  const r = run(slowName);
  assert.equal(r.status, 1, r.out);
  assert.ok(blocked(r.out).some((l) => l.startsWith('막음: services/admission-ctrl/src/modules/leader/')), r.out);
});

test('V-T20 ② 입력 없음 상수나 자동 제어가 읽는 이름을 찾지 못하면 2다(통과로 보지 않는다)', (t) => {
  const noConst = fixture(t);
  replaceOnce(noConst, PLAN_TS, 'export const INPUT_STALE_MS = 30_000;\n', '');
  assertExit2(noConst, 'INPUT_STALE_MS 줄이 없다');

  const noQueries = fixture(t);
  replaceOnce(noQueries, CONTROL_TS, 'export const CONTROL_QUERIES = {', 'export const CONTROL_INPUTS = {');
  assertExit2(noQueries, 'CONTROL_QUERIES가 없다');
});

// ---------------------------------------------------------------------------
// V-T20 ③ 규칙 시험의 입력 간격·평가 간격 = 운영 값(§4 간격 규칙 ③, docs/verification.md §2.7 '시험 입력의 간격')
// ---------------------------------------------------------------------------

test('V-T20 ③ 규칙 시험의 입력 간격을 1초로 바꾼 시험 파일을 막고 예외는 까닭이 있는 둘뿐이다', (t) => {
  // 실제 설정: 그 밖의 긁기 15초(§4 표), 예외는 정확히 둘이고 까닭이 비지 않는다
  const cfg = parse(readFileSync(join(REPO, ALERT_CHECK), 'utf8'));
  assert.equal(cfg.otherScrapeInterval, '15s');
  const pairs = cfg.testIntervalExceptions.map((e) => [e.file, e.test]).sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(pairs, [
    [SLO28D_TEST, EXCEPTION_28D],
    [ONSALE_TEST, EXCEPTION_VT20_4],
  ]);
  for (const e of cfg.testIntervalExceptions) assert.ok(typeof e.reason === 'string' && e.reason.trim().length > 0, `${e.test}의 까닭이 비었다`);
  assertPass(fixture(t), '실제 규칙 시험 파일');

  // 입력 간격 1초
  const oneSec = fixture(t);
  editYaml(oneSec, ONSALE_TEST, (d) => (testGroup(d, VT51_1).interval = '1s'));
  assertBlocked(oneSec, ONSALE_TEST, { name: VT51_1 });

  // 평가 간격은 rule_files 묶음의 평가 간격 가운데 하나: slo-onsale만 읽는 파일에 10초는 막고, 5초·30초 묶음을 읽는 파일에 5초는 통과
  const eval10 = fixture(t);
  editYaml(eval10, ONSALE_TEST, (d) => (d.evaluation_interval = '10s'));
  assertBlocked(eval10, ONSALE_TEST, { has: ['10s'] });
  const eval5 = fixture(t);
  editYaml(eval5, SLO28D_TEST, (d) => (d.evaluation_interval = '5s'));
  assertPass(eval5, 'slo-28d 시험 파일의 평가 간격 5초(slo-onsale 묶음의 값)');

  // 입력이 기록 규칙 이름이면 그 묶음의 평가 간격(agg5m 5분)이어야 한다: 15초는 원천 지표 간격이라도 막는다
  const recordInput = fixture(t);
  editYaml(recordInput, BUDGET_TEST, (d) => (d.tests[0].interval = '15s'));
  assertBlocked(recordInput, BUDGET_TEST, { name: 'V-T51 ⑦' });
});

test('V-T20 ③ 낡거나 까닭 없는 예외, 지운 예외는 막고 예외 목록이 없으면 2다', (t) => {
  const exceptionOf = (d, testName) => {
    const e = d.testIntervalExceptions.filter((x) => x.test === testName);
    assert.equal(e.length, 1, `예외 ${testName}`);
    return e[0];
  };
  const emptyReason = fixture(t);
  editYaml(emptyReason, ALERT_CHECK, (d) => (exceptionOf(d, EXCEPTION_28D).reason = ''));
  assertBlocked(emptyReason, ALERT_CHECK, { has: [EXCEPTION_28D] });

  const stale = fixture(t);
  editYaml(stale, ALERT_CHECK, (d) => (exceptionOf(d, EXCEPTION_28D).test = 'V-T51 ⑥ 없어진 시험 묶음'));
  assertBlocked(stale, ALERT_CHECK, { name: 'V-T51 ⑥ 없어진 시험 묶음' });

  // V-T20 ④ 묶음(입력 1초)의 예외를 지우면 그 묶음의 입력 간격을 막는다
  const removed = fixture(t);
  editYaml(removed, ALERT_CHECK, (d) => (d.testIntervalExceptions = d.testIntervalExceptions.filter((x) => x.test !== EXCEPTION_VT20_4)));
  assertBlocked(removed, ONSALE_TEST, { name: EXCEPTION_VT20_4 });

  const missing = fixture(t);
  rmSync(join(missing, ALERT_CHECK));
  assertExit2(missing, 'alert-check.yaml이 없다');
});

// ---------------------------------------------------------------------------
// V-T16 지연 히스토그램 칸(docs/observability.md §8 '히스토그램 버킷 구성', docs/verification.md §2.7)
// ---------------------------------------------------------------------------

test('V-T16 표준 칸 목록에서 0.2를 빼거나 Envoy 설정에만 다른 칸을 두면 막는다', (t) => {
  // Envoy 설정이 아직 없으면 '없음'을 찍고 넘어간다(ADR-0382)
  const real = assertPass(fixture(t), '실제 저장소');
  assert.ok(real.out.includes('없음: Envoy 히스토그램 칸 설정'), real.out);

  // 서비스 템플릿 목록에서 0.2를 뺌·차례를 바꿈
  const noTwo = fixture(t);
  replaceOnce(noTwo, METRICS, '0.15, 0.2, 0.25', '0.15, 0.25');
  assertBlocked(noTwo, METRICS);
  const swapped = fixture(t);
  replaceOnce(swapped, METRICS, '0.15, 0.2, 0.25', '0.2, 0.15, 0.25');
  assertBlocked(swapped, METRICS);

  // 정본 목록 글에서만 0.2를 뺌(서비스 템플릿과 어긋난다)
  const docNoTwo = fixture(t);
  replaceOnce(docNoTwo, DOC, '0.1, 0.15, 0.2, 0.25, 0.3', '0.1, 0.15, 0.25, 0.3');
  const r = run(docNoTwo);
  assert.equal(r.status, 1, r.out);
  assert.ok(blocked(r.out).some((l) => l.startsWith(`막음: ${METRICS}: `) || l.startsWith(`막음: ${DOC}: `)), r.out);

  // 규칙의 le 값: _seconds_bucket은 초, _ms_bucket은 밀리초로 읽는다. 다른 단위는 보지 않는다
  const secOff = fixture(t);
  pushRule(secOff, SLO28D, 'slo-28d', alert('vt16_le_seconds_off', 'sum(rate(http_server_request_duration_seconds_bucket{le="0.21"}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m])) < 0.99'));
  assertBlocked(secOff, SLO28D, { name: 'vt16_le_seconds_off', has: ['0.21'], only: true });
  const secOn = fixture(t);
  pushRule(secOn, SLO28D, 'slo-28d', alert('vt16_le_seconds_on', 'sum(rate(http_server_request_duration_seconds_bucket{le="0.2"}[5m])) / sum(rate(http_server_request_duration_seconds_count[5m])) < 0.99'));
  assertPass(secOn, '초 칸 0.2');
  const msOn = fixture(t);
  pushRule(msOn, SLO28D, 'slo-28d', alert('vt16_le_ms_on', 'sum(rate(realtime_gw_batch_wait_ms_bucket{le="150"}[5m])) / sum(rate(realtime_gw_batch_wait_ms_count[5m])) < 0.99'));
  assertPass(msOn, '밀리초 칸 150(0.15초)');
  const msOff = fixture(t);
  pushRule(msOff, SLO28D, 'slo-28d', alert('vt16_le_ms_off', 'sum(rate(realtime_gw_batch_wait_ms_bucket{le="151"}[5m])) / sum(rate(realtime_gw_batch_wait_ms_count[5m])) < 0.99'));
  assertBlocked(msOff, SLO28D, { name: 'vt16_le_ms_off', has: ['151'], only: true });
  const bytes = fixture(t);
  pushRule(bytes, SLO28D, 'slo-28d', alert('vt16_le_bytes', 'sum(rate(http_response_size_bytes_bucket{le="1234"}[5m])) > 0'));
  assertPass(bytes, '바이트 히스토그램은 보지 않는다');

  // Envoy histogram_bucket_settings(밀리초): 표준 목록 × 1000과 같으면 통과, 7ms를 더하면 막는다
  const envoy = (buckets) => ({
    apiVersion: 'gateway.envoyproxy.io/v1alpha1',
    kind: 'EnvoyProxy',
    metadata: { name: 'peaket-proxy', namespace: 'envoy-gateway-system' },
    spec: {
      bootstrap: {
        type: 'JSONPatch',
        jsonPatches: [{ op: 'add', path: '/stats_config', value: { histogram_bucket_settings: [{ match: { safe_regex: { regex: '.*' } }, buckets }] } }],
      },
    },
  });
  const envoySame = fixture(t);
  writeIn(envoySame, ENVOY, stringify(envoy(STANDARD_BUCKETS_MS)));
  assertPass(envoySame, 'Envoy 칸이 표준 목록과 같다');
  const envoyExtra = fixture(t);
  writeIn(envoyExtra, ENVOY, stringify(envoy([5, 7, ...STANDARD_BUCKETS_MS.slice(1)])));
  assertBlocked(envoyExtra, ENVOY, { only: true });
});

test('V-T16 정본 표준 칸 목록 글을 읽지 못하면 2다', (t) => {
  const root = fixture(t);
  const text = readIn(root, DOC);
  const re = /목록\(초\)은 [^。]*?\(\+Inf\)이다/;
  assert.match(text, re);
  writeIn(root, DOC, text.replace(re, '목록은 따로 둔다'));
  assertExit2(root, '정본 목록 글이 없다');
});

// ---------------------------------------------------------------------------
// V-T54 ① 주석과 라벨 값(§5 '경보 규칙 검사'의 주석·라벨 값)
// ---------------------------------------------------------------------------

test('V-T54 ① 주석과 심각도·종류 값이 빠지거나 목록 밖이면 막는다', async (t) => {
  const real = fixture(t);
  // 실제 저장소에는 explore_url이 없는 kind cause 경보와 주석이 없는 기록 규칙이 있고, 둘 다 통과해야 한다
  const onsale = parse(readIn(real, ONSALE));
  const pgCause = alertOf(onsale, 'payment_confirm_pg_cause');
  assert.equal(pgCause.labels.kind, 'cause');
  assert.equal(pgCause.annotations.explore_url, undefined);
  assert.ok(groupOf(onsale, 'slo-onsale').rules.some((r) => r.record && r.annotations === undefined));
  assertPass(real, '실제 저장소');
  const { checkAlerts } = await import(pathToFileURL(SCRIPT).href);
  assert.deepEqual(checkAlerts(real), []);

  // 모든 경보에 summary·runbook_url·dashboard_url(비지 않은 글)
  for (const key of ['summary', 'runbook_url', 'dashboard_url']) {
    const root = fixture(t);
    editYaml(root, ONSALE, (d) => delete alertOf(d, 'payment_confirm_pg_cause').annotations[key]);
    assertBlocked(root, ONSALE, { name: 'payment_confirm_pg_cause', has: [key], only: true });
  }
  const emptyRunbook = fixture(t);
  editYaml(emptyRunbook, ONSALE, (d) => (alertOf(d, 'payment_confirm_pg_cause').annotations.runbook_url = ''));
  assertBlocked(emptyRunbook, ONSALE, { name: 'payment_confirm_pg_cause', has: ['runbook_url'], only: true });
  const violations = checkAlerts(emptyRunbook);
  assert.equal(violations.length, 1, violations.join('\n'));
  assert.ok(violations[0].includes('payment_confirm_pg_cause'), violations[0]);

  // kind slo 경보에는 explore_url도
  const noExplore = fixture(t);
  editYaml(noExplore, SLO28D, (d) => delete alertOf(d, 'slo_28d_burn_1h').annotations.explore_url);
  assertBlocked(noExplore, SLO28D, { name: 'slo_28d_burn_1h', has: ['explore_url'], only: true });

  // severity는 sev1·sev2·sev3(없음은 막는다), kind는 정본 목록(slo·cause·invariant·control·hygiene·legal·field·change·security·flow)
  const warning = fixture(t);
  editYaml(warning, RTGW, (d) => (alertOf(d, 'realtime_gw_degraded').labels.severity = 'warning'));
  assertBlocked(warning, RTGW, { name: 'realtime_gw_degraded', has: ['warning'], only: true });
  const noSeverity = fixture(t);
  editYaml(noSeverity, ONSALE, (d) => delete alertOf(d, 'payment_confirm_pg_cause').labels.severity);
  assertBlocked(noSeverity, ONSALE, { name: 'payment_confirm_pg_cause', only: true });
  const budget = fixture(t);
  editYaml(budget, ONSALE, (d) => (alertOf(d, 'payment_confirm_pg_cause').labels.kind = 'budget'));
  assertBlocked(budget, ONSALE, { name: 'payment_confirm_pg_cause', has: ['budget'], only: true });
});

test('V-T54 ① severity none은 Alertmanager에 그 경보 이름 경로가 있을 때만 통과한다', (t) => {
  const none = (name) => ({ ...alert(name, 'vector(1)'), labels: { severity: 'none', kind: 'hygiene' } });
  // F-01-6이 더한 실제 rules/watchdog.yaml의 Watchdog과 겹치지 않게, 이 사례의 임시 저장소에서는 그 파일을 뺀다
  const withoutRealWatchdog = (root) => {
    rmSync(join(root, OBS, 'rules', 'watchdog.yaml'), { force: true });
    return root;
  };
  const watchdog = withoutRealWatchdog(fixture(t));
  pushRule(watchdog, SLO28D, 'slo-28d', none('Watchdog'));
  assertPass(watchdog, '경로가 있는 Watchdog');

  const unrouted = fixture(t);
  pushRule(unrouted, SLO28D, 'slo-28d', none('vt54_unrouted_none'));
  assertBlocked(unrouted, SLO28D, { name: 'vt54_unrouted_none', only: true });

  // 경로를 지우면 같은 Watchdog도 막는다(이름이 아니라 경로로 판정한다)
  const routeRemoved = withoutRealWatchdog(fixture(t));
  pushRule(routeRemoved, SLO28D, 'slo-28d', none('Watchdog'));
  editYaml(routeRemoved, AM, (d) => (d.route.routes = d.route.routes.filter((r) => !r.matchers.includes('alertname="Watchdog"'))));
  assertBlocked(routeRemoved, SLO28D, { name: 'Watchdog', only: true });
});

test('V-T54 ① 모르는 인자·없는 폴더·규칙 파일 0개는 2다', async (t) => {
  assert.equal(cli('--bogus').status, 2);
  const gone = join(tmpdir(), `alert-check-none-${process.pid}`);
  assert.equal(existsSync(gone), false);
  assert.equal(cli('--root', gone).status, 2);

  const empty = fixture(t);
  for (const rel of [`${OBS}/rules`, `${OBS}/alerts`, `${OBS}/mimir/rules`]) rmSync(join(empty, rel), { recursive: true, force: true });
  assertExit2(empty, '규칙 파일 0개');
  const { checkAlerts } = await import(pathToFileURL(SCRIPT).href);
  assert.throws(() => checkAlerts(empty), Error);
});

// ---------------------------------------------------------------------------
// V-T54 ② 이용자 식별값(§5 '경보 규칙 검사'의 이용자 식별값, §8 허용 라벨, ADR-0139 결정 4)
// ---------------------------------------------------------------------------

test('V-T54 ② [ASVS v5.0.0-14.2.3] 경보 라벨·주석 틀·묶기 이름에 이용자 식별값을 쓰면 막는다', (t) => {
  // 30초 묶음(slo-28d)에 1분 창을 쓰는 경보를 하나씩 더한다. 한 곳만 어긋난다
  const expr = 'sum(rate(http_server_errors_total[1m])) > 0';
  const add = (rule) => {
    const root = fixture(t);
    pushRule(root, SLO28D, 'slo-28d', rule);
    return root;
  };

  // 통과: 허용 라벨(pod·event_id)만 읽는 주석, $value, 허용 이름(le·service)으로만 묶는 식
  assertPass(
    add(alert('vt54_allowed', 'sum by (le, service) (rate(http_server_request_duration_seconds_bucket{le="0.2"}[1m])) > 0', {
        annotations: { summary: '{{ $labels.pod }} 회차 {{ $labels.event_id }} 값 {{ $value }}' },
      }),
    ),
    'pod·event_id·$value와 by (le, service)',
  );

  // 라벨 이름
  assertBlocked(add(alert('vt54_label_key', expr, { labels: { account_id: 'a1' } })), SLO28D, { name: 'vt54_label_key', has: ['account_id'], only: true });
  // 라벨 값의 $labels.<이름>
  assertBlocked(add(alert('vt54_label_value', expr, { labels: { journey: '{{ $labels.account_id }}' } })), SLO28D, {
    name: 'vt54_label_value',
    has: ['account_id'],
    only: true,
  });
  // 주석 틀의 $labels.<이름>
  assertBlocked(add(alert('vt54_annotation_ref', expr, { annotations: { summary: '계정 {{ $labels.account_id }}' } })), SLO28D, {
    name: 'vt54_annotation_ref',
    has: ['account_id'],
    only: true,
  });
  // 라벨 전체를 싣는 틀
  assertBlocked(add(alert('vt54_range_labels', expr, { annotations: { summary: '{{ range $k, $v := $labels }}{{ $k }}={{ $v }} {{ end }}' } })), SLO28D, {
    name: 'vt54_range_labels',
    only: true,
  });
  assertBlocked(add(alert('vt54_all_labels', expr, { annotations: { summary: '라벨 {{ $labels }}' } })), SLO28D, { name: 'vt54_all_labels', only: true });
  // 규칙 식의 by (…)·without (…)
  assertBlocked(add(alert('vt54_by', 'sum by (account_id) (rate(http_server_errors_total[1m])) > 0')), SLO28D, { name: 'vt54_by', has: ['account_id'], only: true });
  assertBlocked(add(alert('vt54_without', 'sum without (account_id) (rate(http_server_errors_total[1m])) > 0')), SLO28D, {
    name: 'vt54_without',
    has: ['account_id'],
    only: true,
  });
  // 기록 규칙의 labels 이름도 본다
  assertBlocked(add({ record: 'peaket:vt54_fixture:rate1m', expr: 'sum(rate(http_server_errors_total[1m]))', labels: { account_id: 'a1' } }), SLO28D, {
    name: 'peaket:vt54_fixture:rate1m',
    has: ['account_id'],
    only: true,
  });
  // 주석 글의 2차 마스킹 꼴(pii-patterns.json): 이메일·전화번호를 따로
  assertBlocked(add(alert('vt54_email', expr, { annotations: { summary: '문의 kim@example.com' } })), SLO28D, { name: 'vt54_email', only: true });
  assertBlocked(add(alert('vt54_phone', expr, { annotations: { summary: '연락 010-1234-5678' } })), SLO28D, { name: 'vt54_phone', only: true });
});
