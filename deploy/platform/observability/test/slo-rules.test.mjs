// SLO 기록 규칙·번 레이트 경보 시험(F-01-5, OPS-090, 시험 V-T51 ①~⑧·V-T9·V-T20 ④).
// 정본: docs/observability.md §4 'SLO 기록 규칙과 원천'·'긁기·평가·알림 간격'·'다중 윈도우 멀티 번 레이트 알림 규칙', §5 주석·라벨,
// docs/verification.md §2.7·V-T9·V-T20·V-T51, ADR-0226 결정 5(자동 감축이 읽는 규칙 이름), 계획 docs/review/plans/F-01-5.md §5·§6.
// - 합성 시계열 시험(같은 폴더의 *.test.yaml)을 시험 ID마다 그 묶음만 골라 임시 저장소에서 실행기로 돌린다:
//   node tools/ci/prom-rules.mjs test --root <임시 저장소>. promtool은 실행기가 고정 이미지로 부른다(Docker가 없으면 실행기가 2를 내고 이 시험은 실패한다).
// - V-T9: 온세일 SEV1 배수를 10에서 11로 바꾼 규칙으로 V-T51 ① 시험이 실패하는지 본다.
// - V-T51 ⑧: 규칙 묶음·평가 간격·slo-fast 긁기를 YAML로 읽어 §4 표와 맞추고, admission-ctrl이 읽는 이름과 대조하며, 실제 저장소에서 check·test가 0인지 본다.
// 실행(저장소 뿌리): node --test "deploy/platform/observability/test/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments, stringify } from 'yaml';
import { tempDir } from '../../../../tools/ci/git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const RUNNER = join(REPO, 'tools', 'ci', 'prom-rules.mjs');
const OBS = 'deploy/platform/observability';
const TEST_DIR = `${OBS}/test`;
const ONSALE = `${OBS}/rules/slo-onsale.yaml`;
const R28D = `${OBS}/rules/slo-28d.yaml`;
const AGG = `${OBS}/rules/agg5m.yaml`;
const MIMIR = `${OBS}/mimir/rules/slo-budget28d.yaml`;
const SCRAPE = `${OBS}/prometheus/scrape-slo-fast.yaml`;
const LOCAL_OBS = 'deploy/local/observability.yaml';
const CONTROL_INPUTS = 'services/admission-ctrl/src/modules/leader/adapters/prometheus-control-inputs.ts';
const BUDGET = 'peaket:slo_error_budget:ratio';

const read = (root, rel) => {
  assert.ok(existsSync(join(root, rel)), `${rel}이 없다`);
  return readFileSync(join(root, rel), 'utf8');
};
const docsOf = (root, rel) =>
  parseAllDocuments(read(root, rel))
    .map((d) => d.toJS())
    .filter((x) => x !== null && x !== undefined);

/** 실행기를 바깥에서 부른다. 끝 코드와 합친 출력 */
function runner(...args) {
  const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', cwd: REPO });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const blocked = (out) => out.split(/\r?\n/).filter((l) => l.startsWith('막음:'));

/** 임시 저장소: 관측 폴더와 promtool 이미지가 적힌 로컬 관측 설정. 시험 폴더는 비운다 */
function fixture() {
  const root = tempDir('slo-rules-');
  cpSync(join(REPO, OBS), join(root, OBS), { recursive: true });
  mkdirSync(join(root, 'deploy/local'), { recursive: true });
  cpSync(join(REPO, LOCAL_OBS), join(root, LOCAL_OBS));
  rmSync(join(root, TEST_DIR), { recursive: true, force: true });
  mkdirSync(join(root, TEST_DIR), { recursive: true });
  return root;
}

/** 시험 파일에서 이름이 prefix로 시작하는 묶음만 남긴 사본을 임시 저장소에 쓴다. 고른 묶음 수를 돌려준다 */
function placeGroups(root, file, prefix) {
  const spec = parse(read(REPO, `${TEST_DIR}/${file}`));
  const tests = (spec.tests ?? []).filter((t) => typeof t.name === 'string' && t.name.startsWith(prefix));
  assert.ok(tests.length >= 1, `${file}에 '${prefix}'로 시작하는 시험 묶음이 없다(0개 실행을 통과로 내지 않는다)`);
  writeFileSync(join(root, TEST_DIR, file), stringify({ ...spec, tests }, { lineWidth: 0 }));
  return tests;
}

/** 시험 ID 하나의 합성 시계열 시험을 돌려 통과를 단언한다 */
function runGroups(file, prefix, { evaluation, interval }) {
  const spec = parse(read(REPO, `${TEST_DIR}/${file}`));
  // 시험 입력 간격 = 운영 간격(docs/verification.md §2.7 '시험 입력의 간격', V-T20 ③)
  assert.equal(spec.evaluation_interval, evaluation, `${file}의 evaluation_interval`);
  const root = fixture();
  const tests = placeGroups(root, file, prefix);
  tests.forEach((t, i) => assert.equal(t.interval, Array.isArray(interval) ? interval[i] : interval, `${t.name}의 interval`));
  const r = runner('test', '--root', root);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(blocked(r.out), []);
  return tests;
}

test('V-T51 ① 온세일 10배 경보는 2분·20초 두 창이 모두 넘을 때만 SEV1이다', () => {
  runGroups('slo-onsale.test.yaml', 'V-T51 ①', { evaluation: '5s', interval: '5s' });
});

test('V-T51 ② 3배 경보는 5분·25초 두 창이 모두 넘을 때만 SEV2이고 결제 확정에는 없다', () => {
  runGroups('slo-onsale.test.yaml', 'V-T51 ②', { evaluation: '5s', interval: '5s' });
});

test('V-T51 ③ 결제 확정 원인 넷은 결제사마다 SEV2를 울리고 진행 회차마다 pg_cause 1이다', () => {
  runGroups('slo-onsale.test.yaml', 'V-T51 ③', { evaluation: '5s', interval: '5s' });
});

test('V-T51 ④ 입장 제어 입력은 purchase-svc의 30초 p99·5xx 비율을 내고 요청이 없으면 0이다', () => {
  runGroups('slo-onsale.test.yaml', 'V-T51 ④', { evaluation: '5s', interval: '5s' });
});

test('V-T51 ⑤ 회차 상태는 진행 회차마다 여정별 0·1이고 원천이 없으면 값이 없다', () => {
  runGroups('slo-onsale.test.yaml', 'V-T51 ⑤', { evaluation: '5s', interval: '5s' });
});

test('V-T20 ④ 긁기 흔들림과 빠진 표본이 있어도 20초 창이 비지 않고 10배 경계를 지킨다', () => {
  // 1초 칸은 흔들림(±1초)을 놓을 자리다. 표본은 5초 ±1초마다 하나이고, 빠진 자리는 '_'다
  const [g] = runGroups('slo-onsale.test.yaml', 'V-T20 ④', { evaluation: '5s', interval: '1s' });
  const hold = g.input_series.find((s) => s.series.startsWith('http_server_request_duration_seconds_count') && s.series.includes('status_class="5xx"'));
  assert.ok(hold, '5xx 입력이 없다');
  const toks = hold.values.split(' ');
  assert.ok(toks.some((x) => /^_x\d+$/.test(x) && Number(x.slice(2)) >= 9), '빠진 표본(10초 가까운 빈자리)이 없다');
});

test('V-T51 ⑥ 28일 경보 세 단계는 긴 창·짧은 창이 모두 넘을 때만 울린다', () => {
  // 1배(3일 창) 묶음만 입력 30초: promtool은 한 조회가 시계열 하나에서 읽는 표본을 10,000개로 막는다(그 묶음 머리 주석)
  const groups = runGroups('slo-28d.test.yaml', 'V-T51 ⑥', { evaluation: '30s', interval: ['5s', '5s', '30s'] });
  assert.equal(groups.length, 3, '6배·14.4배·1배 묶음');
});

test('V-T51 ⑦ 28일 남은 예산은 1 − (실패 합 ÷ 전체 합) ÷ (1 − 목표)다', () => {
  runGroups('slo-budget28d.test.yaml', 'V-T51 ⑦', { evaluation: '5m', interval: '5m' });
});

/** PrometheusRule 문서 하나의 묶음 */
function crdGroups(root, rel) {
  const docs = docsOf(root, rel);
  assert.equal(docs.length, 1, `${rel}: 문서 하나`);
  const [d] = docs;
  assert.equal(d.apiVersion, 'monitoring.coreos.com/v1', rel);
  assert.equal(d.kind, 'PrometheusRule', rel);
  assert.ok(Array.isArray(d.spec?.groups), `${rel}: spec.groups`);
  return d.spec.groups;
}
const groupOf = (groups, name, rel) => {
  const hit = groups.filter((g) => g.name === name);
  assert.equal(hit.length, 1, `${rel}: 묶음 ${name}이 하나가 아니다(${hit.length})`);
  return hit[0];
};
const recordsOf = (g) => new Set((g.rules ?? []).filter((r) => r.record).map((r) => r.record));
const alertsOf = (g) => (g.rules ?? []).filter((r) => r.alert);

/** 관측 폴더의 모든 규칙(rules/·alerts/의 CRD, mimir/rules/의 규칙 파일): [{ rel, group, rule }] */
function allRules(root) {
  const out = [];
  for (const dir of ['rules', 'alerts', 'mimir/rules']) {
    const abs = join(root, OBS, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs).filter((x) => /\.ya?ml$/.test(x))) {
      const rel = `${OBS}/${dir}/${f}`;
      for (const d of docsOf(root, rel)) for (const g of d?.spec?.groups ?? d?.groups ?? []) for (const r of g.rules ?? []) out.push({ rel, group: g.name, rule: r });
    }
  }
  return out;
}

test('V-T51 ⑧ 규칙 묶음과 slo-fast 긁기 간격이 §4 표와 같다', () => {
  // §4 '긁기·평가·알림 간격': 온세일·자동 제어 규칙 5초 묶음, 그 밖 30초, agg5m 5분, Mimir 규칙 평가기 5분 [가정](§8 지표 출처 표)
  const onsale = groupOf(crdGroups(REPO, ONSALE), 'slo-onsale', ONSALE);
  assert.equal(onsale.interval, '5s');
  const d28 = groupOf(crdGroups(REPO, R28D), 'slo-28d', R28D);
  assert.equal(d28.interval, '30s');
  const aggGroups = crdGroups(REPO, AGG);
  const agg = groupOf(aggGroups, 'agg5m-slo-budget', AGG);
  assert.equal(agg.interval, '5m');
  // F-01-2의 기존 묶음은 그대로 남는다
  const signals = groupOf(aggGroups, 'agg5m-service-signals', AGG);
  assert.equal(signals.interval, '5m');
  assert.deepEqual([...recordsOf(signals)].sort(), ['agg5m:http_server_errors:ratio_rate5m', 'agg5m:http_server_request_duration_seconds:p99_success_5m', 'agg5m:http_server_requests:rate5m']);
  // Mimir 규칙 평가기 파일은 CRD가 아니라 최상위 groups다
  const mimirDocs = docsOf(REPO, MIMIR);
  assert.equal(mimirDocs.length, 1);
  assert.equal(mimirDocs[0].kind, undefined, 'Mimir 규칙 파일은 CRD가 아니다');
  const mimir = groupOf(mimirDocs[0].groups ?? [], 'slo-budget28d', MIMIR);
  assert.equal(mimir.interval, '5m');

  // 이름이 묶음에 있는지(§5 공개 인터페이스, docs/observability.md §4 세 층)
  const need = (g, names) => {
    const have = recordsOf(g);
    for (const n of names) assert.ok(have.has(n), `묶음 ${g.name}에 기록 규칙 ${n}이 없다`);
  };
  need(onsale, [BUDGET, ...['20s', '25s', '2m', '5m', '70m'].map((w) => `peaket:slo_error_ratio:rate${w}`), 'peaket:slo:budget_alert10x:state', 'peaket:slo:budget_burn50:state', 'peaket:payment:pg_cause:state', 'peaket:admission:downstream_p99_seconds:30s', 'peaket:admission:downstream_error_ratio:30s']);
  need(d28, ['30m', '1h', '6h', '3d'].map((w) => `peaket:slo_error_ratio:rate${w}`));
  need(agg, ['agg5m:slo_errors:increase5m', 'agg5m:slo_requests:increase5m']);
  need(mimir, ['slo:error_budget_remaining:ratio28d']);

  // 상태·입력·짧은 창은 5초 묶음에만, 긴 창은 30초 묶음에만 있다(admission-ctrl은 30초보다 낡은 표본을 입력 없음으로 본다)
  const where = new Map();
  for (const { rel, group, rule } of allRules(REPO)) {
    if (!rule.record) continue;
    const k = rule.record;
    where.set(k, new Set([...(where.get(k) ?? []), `${rel}#${group}`]));
  }
  const only = (name, place) => assert.deepEqual([...(where.get(name) ?? [])], [place], `${name}은 ${place}에만 있어야 한다`);
  for (const n of ['peaket:slo:budget_alert10x:state', 'peaket:slo:budget_burn50:state', 'peaket:payment:pg_cause:state', 'peaket:admission:downstream_p99_seconds:30s', 'peaket:admission:downstream_error_ratio:30s', ...['20s', '25s', '2m', '5m', '70m'].map((w) => `peaket:slo_error_ratio:rate${w}`)]) only(n, `${ONSALE}#slo-onsale`);
  for (const w of ['30m', '1h', '6h', '3d']) only(`peaket:slo_error_ratio:rate${w}`, `${R28D}#slo-28d`);

  // 경보: 이름·라벨(§5), for 없음(§4 표 '온세일 번 레이트 경보의 for', 3층), 주석(§5, SLO 경보는 explore_url도)
  const expected = [
    [onsale, 'slo_onsale_fast_burn', { severity: 'sev1', kind: 'slo' }],
    [onsale, 'slo_onsale_slow_burn', { severity: 'sev2', kind: 'slo' }],
    [onsale, 'payment_confirm_pg_cause', { severity: 'sev2', kind: 'cause', dependency: 'payment-gateway' }],
    [d28, 'slo_28d_burn_1h', { severity: 'sev1', kind: 'slo' }],
    [d28, 'slo_28d_burn_6h', { severity: 'sev1', kind: 'slo' }],
    [d28, 'slo_28d_burn_3d', { severity: 'sev3', kind: 'slo' }],
  ];
  const everyAlert = allRules(REPO).filter((x) => x.rule.alert);
  for (const [g, name, labels] of expected) {
    const rules = alertsOf(g).filter((r) => r.alert === name);
    assert.ok(rules.length >= 1, `묶음 ${g.name}에 경보 ${name}이 없다`);
    assert.equal(everyAlert.filter((x) => x.rule.alert === name).length, rules.length, `${name}이 다른 묶음에도 있다`);
    for (const r of rules) {
      assert.equal(r.for, undefined, `${name}: for를 두지 않는다`);
      for (const [k, v] of Object.entries(labels)) assert.equal(r.labels?.[k], v, `${name}: 라벨 ${k}`);
      const keys = ['summary', 'description', 'runbook_url', 'dashboard_url', ...(labels.kind === 'slo' ? ['explore_url'] : [])];
      for (const k of keys) assert.ok(typeof r.annotations?.[k] === 'string' && r.annotations[k].trim() !== '', `${name}: 주석 ${k}`);
    }
  }

  // slo-fast 긁기(§4 표 첫 줄, '긁기' 항목): PodMonitor, 간격 5초, 대상 다섯, app.kubernetes.io/name → app 하나
  const scrape = docsOf(REPO, SCRAPE);
  assert.equal(scrape.length, 1);
  const pm = scrape[0];
  assert.equal(pm.kind, 'PodMonitor');
  assert.equal(pm.metadata?.name, 'slo-fast');
  const eps = pm.spec?.podMetricsEndpoints ?? [];
  assert.ok(eps.length >= 1, 'podMetricsEndpoints');
  for (const ep of eps) {
    assert.equal(ep.interval, '5s');
    const toApp = (ep.relabelings ?? []).filter((r) => r.targetLabel === 'app');
    assert.equal(toApp.length, 1, 'app 라벨로 옮기는 relabeling 하나');
    assert.deepEqual(toApp[0].sourceLabels, ['__meta_kubernetes_pod_label_app_kubernetes_io_name']);
  }
  const sel = (pm.spec?.selector?.matchExpressions ?? []).filter((e) => e.key === 'app.kubernetes.io/name' && e.operator === 'In');
  assert.equal(sel.length, 1, 'app.kubernetes.io/name In 선택 하나');
  assert.deepEqual([...sel[0].values].sort(), ['admission-ctrl', 'payment-svc', 'purchase-svc', 'queue-svc', 'realtime-gw']);
});

test('V-T51 ⑧ 자동 감축이 읽는 기록 규칙 이름이 ADR-0226 결정 5와 admission-ctrl 쿼리와 같고 5초 묶음에 있다', () => {
  // ADR-0226 결정 5·docs/observability.md §4('규칙 이름은 ADR-0226 결정 5 그대로 확정')의 이름
  const canon = ['peaket:admission:downstream_error_ratio:30s', 'peaket:admission:downstream_p99_seconds:30s', 'peaket:payment:pg_cause:state', 'peaket:slo:budget_alert10x:state', 'peaket:slo:budget_burn50:state'];
  const source = read(REPO, CONTROL_INPUTS);
  const inSource = [...new Set(source.match(/peaket:[a-z0-9_:]+/g) ?? [])].sort();
  assert.deepEqual(inSource, canon, `admission-ctrl(${CONTROL_INPUTS})이 읽는 이름`);
  const onsale = groupOf(crdGroups(REPO, ONSALE), 'slo-onsale', ONSALE);
  const have = recordsOf(onsale);
  for (const n of canon) assert.ok(have.has(n), `slo-onsale 묶음에 ${n}이 없다`);
});

test('V-T51 ⑧ 실제 저장소에서 prom-rules.mjs check·test가 0이다', () => {
  const check = runner('check');
  assert.equal(check.status, 0, check.out);
  assert.deepEqual(blocked(check.out), []);
  const all = runner('test');
  assert.equal(all.status, 0, all.out);
  assert.deepEqual(blocked(all.out), []);
});

test('V-T9 온세일 SEV1 배수를 10에서 11로 바꾸면 규칙 시험이 실패한다', () => {
  // §5 '배수 적는 꼴': 식 안에 `10 * peaket:slo_error_budget:ratio`. 바꾸지 않은 사본은 통과해야 한다(같은 시험 안의 통과 경우)
  const TEN = `10 * ${BUDGET}`;
  const ELEVEN = `11 * ${BUDGET}`;
  const base = fixture();
  placeGroups(base, 'slo-onsale.test.yaml', 'V-T51 ①');
  const ok = runner('test', '--root', base);
  assert.equal(ok.status, 0, ok.out);

  const isTarget = { alert: (r) => r.alert === 'slo_onsale_fast_burn', state: (r) => r.record === 'peaket:slo:budget_alert10x:state' };
  for (const [what, pick] of Object.entries(isTarget)) {
    const root = fixture();
    placeGroups(root, 'slo-onsale.test.yaml', 'V-T51 ①');
    const doc = parse(read(root, ONSALE));
    const rules = groupOf(doc.spec.groups, 'slo-onsale', ONSALE).rules.filter(pick);
    assert.ok(rules.length >= 1, `${what} 규칙이 없다`);
    for (const r of rules) {
      assert.ok(String(r.expr).includes(TEN), `${what} 규칙 식에 '${TEN}'이 없다: ${r.expr}`);
      r.expr = String(r.expr).replaceAll(TEN, ELEVEN);
    }
    writeFileSync(join(root, ONSALE), stringify(doc, { lineWidth: 0 }));
    const r = runner('test', '--root', root);
    assert.equal(r.status, 1, `${what} 배수 11: ${r.out}`);
    assert.deepEqual(blocked(r.out).map((l) => l.split(': ')[1]), [`${TEST_DIR}/slo-onsale.test.yaml`]);
    assert.match(r.out, /V-T51 ①/, '실패한 시험 이름이 출력에 있다');
  }
});
