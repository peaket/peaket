// F-09-11(OPS-440) 카나리 분석·리더 인지 롤링·그림자 계획의 정적 시험.
// 클러스터·Docker·AWS 없이 YAML과 helm 렌더만 본다. Argo Rollouts 분석 실행·자동 중단·그림자 트래픽은 미실행이다.
// 정본: docs/devops.md §6.2(카나리 분석·최소 표본)·§6.3(리더 롤링·그림자)·D-T6·D-T7·G-18,
// docs/observability.md §8(서비스 지표 이름·라벨), docs/infra.md §8(리더 선출).
// 실행(저장소 뿌리): node --test deploy/platform/test/f0911-canary.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, parse } from 'yaml';
import { ensureTool } from '../../../tools/local/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const TEMPLATES = 'deploy/platform/argo-rollouts/analysis-templates.yaml';
const ANALYSIS_APP = 'deploy/platform/argo-rollouts/analysis-application.yaml';
const ALERTS = 'deploy/platform/observability/alerts/argo-rollouts.yaml';
const CHART = join(REPO, 'deploy', 'charts', 'peaket-service');
const helm = await ensureTool('helm');

function file(rel) {
  const p = join(REPO, rel);
  assert.ok(existsSync(p), `파일이 없다: ${rel}`);
  return p;
}
function text(rel) {
  return readFileSync(file(rel), 'utf8');
}
function yamlFile(rel) {
  return parse(text(rel));
}
function yamlDocs(rel) {
  return parseAllDocuments(text(rel)).map((d) => d.toJS()).filter(Boolean);
}
function render(sets, ns = 'example') {
  const r = spawnSync(helm, ['template', 'rel', CHART, '--namespace', ns, ...sets.flatMap((s) => ['--set', s])], { encoding: 'utf8' });
  if (r.status !== 0) return { error: r.stderr };
  return { objects: parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean) };
}
function renderValues(rel, sets = [], ns = 'queue') {
  const r = spawnSync(helm, ['template', 'rel', CHART, '--namespace', ns, '-f', join(REPO, rel), ...sets.flatMap((s) => ['--set', s])], { encoding: 'utf8' });
  if (r.status !== 0) return { error: r.stderr };
  return { objects: parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean) };
}
const find = (objs, kind, name) => objs.find((o) => o.kind === kind && o.metadata?.name === name);
const all = (objs, kind) => objs.filter((o) => o.kind === kind);
const BASE = ['name=example-svc', 'image.repository=peaket/example-svc', 'image.tag=local', 'env.PEAKET_ENV=local'];
const IMAGE = ['image.repository=peaket/example-svc', 'image.tag=local', 'env.PEAKET_ENV=local'];

/** 정본 값(옮겨 적지 않고 시험의 기대값으로만 쓴다). docs/devops.md §6.2·D-T6·D-T7 */
const POLICY = {
  weights: [5, 25, 50, 100],
  pauseSeconds: 300,
  interval: '1m',
  count: 2,
  failureLimit: 1,
  error: { multiple: 2, delta: 0.005, minErrors: 5, minRequests: 200 },
  latency: { factor: 1.2, addSeconds: 0.005, p99MinRequests: 1000, p95MinRequests: 200, fromWeight: 25 },
  eventLoop: { factor: 1.5 },
};

/** D-T6·D-T7 판정기. Argo Rollouts 질의가 내는 0(통과)·1(실패)·2(판정 불가)와 같은 규칙이다.
 *  0.9%−0.4% 같은 0.5%p 경계는 IEEE754에서 0.004999999999999999가 될 수 있어, 정본의 "이상"을
 *  그대로 재려면 작은 엡실론을 둔다(PromQL `>= bool 0.005`의 의도, RV0911-25). */
const DELTA_EPSILON = 1e-12;
function judgeError(o) {
  if (o.canaryRequests < POLICY.error.minRequests) return 'inconclusive';
  const canary = o.canaryErrors / o.canaryRequests;
  const stable = o.stableRequests > 0 ? o.stableErrors / o.stableRequests : 0;
  const fail =
    canary > POLICY.error.multiple * stable &&
    canary - stable >= POLICY.error.delta - DELTA_EPSILON &&
    o.canaryErrors >= POLICY.error.minErrors;
  return fail ? 'fail' : 'pass';
}
function judgeLatency(o) {
  if (o.weight < POLICY.latency.fromWeight) return 'skip';
  if (o.canaryRequests < POLICY.latency.p95MinRequests) return 'inconclusive';
  const limit = (base) => base * POLICY.latency.factor + POLICY.latency.addSeconds;
  if (o.canaryRequests >= POLICY.latency.p99MinRequests) {
    return o.canaryP99 > limit(o.stableP99) ? 'fail' : 'pass';
  }
  return o.canaryP95 > limit(o.stableP95) ? 'fail' : 'pass';
}

const NAMES = ['peaket-canary-error-ratio', 'peaket-canary-event-loop', 'peaket-canary-latency'];
function template(name) {
  const t = yamlDocs(TEMPLATES).find((o) => o.kind === 'ClusterAnalysisTemplate' && o.metadata?.name === name);
  assert.ok(t, `${TEMPLATES}: ClusterAnalysisTemplate ${name}`);
  assert.equal(t.apiVersion, 'argoproj.io/v1alpha1', `${name}: apiVersion`);
  assert.equal(t.spec.metrics?.length, 1, `${name}: metric 하나`);
  return t;
}
function metric(name) {
  return template(name).spec.metrics[0];
}
const flat = (s) => s.replace(/\s+/g, ' ').trim();
/** 인자 선언과 질의가 그 인자를 실제로 쓰는지(RV0911-06) */
function assertArgs(name, query, { stable = true } = {}) {
  const t = template(name);
  assert.deepEqual((t.spec.args ?? []).map((a) => a.name).sort(), ['canary-hash', 'service', 'stable-hash'], `${name}: args`);
  assert.match(query, /\{\{args\.service\}\}/, `${name}: service 인자`);
  assert.match(query, /\{\{args\.canary-hash\}\}/, `${name}: canary-hash 인자`);
  assert.match(query, /pod=~"\{\{args\.service\}\}-\{\{args\.canary-hash\}\}-\.\*"/, `${name}: 카나리 파드 선택`);
  if (stable) {
    assert.match(query, /\{\{args\.stable-hash\}\}/, `${name}: stable-hash 인자`);
    assert.match(query, /pod=~"\{\{args\.service\}\}-\{\{args\.stable-hash\}\}-\.\*"/, `${name}: 안정판 파드 선택`);
  }
}

function rules() {
  return yamlDocs(ALERTS)
    .filter((o) => o.kind === 'PrometheusRule')
    .flatMap((o) => o.spec.groups ?? [])
    .flatMap((g) => g.rules ?? []);
}
function alert(name) {
  const r = rules().find((x) => x.alert === name);
  assert.ok(r, `${ALERTS}: 경보 ${name}`);
  return r;
}
function analysisTemplates(step) {
  return step?.analysis?.templates?.map((t) => t.templateName) ?? null;
}
function analysisArg(step, name) {
  const a = (step?.analysis?.args ?? []).find((x) => x.name === name);
  assert.ok(a, `analysis 인자 ${name}`);
  return a.value ?? a.valueFrom;
}

// --- D-T6: 오류 비율과 최소 표본 ---

test('D-T6 ① 오류 2% 카나리(1,000건·20건)는 세 조건을 모두 넘어 분석이 실패하고 자동 중단된다', () => {
  // 정본 시나리오: 1,000건 가운데 20건(2%). 안정판은 같은 구간 0건으로 둔다
  assert.equal(judgeError({ canaryRequests: 1000, canaryErrors: 20, stableRequests: 1000, stableErrors: 0 }), 'fail');
  // 롤아웃에 분석 단계가 붙고 dryRun이 아니어야 실패가 자동 중단으로 이어진다(실제 중단은 미실행)
  const r = render([...BASE, 'service.rollout.enabled=true', 'service.rollout.analysis.enabled=true']);
  assert.equal(r.error, undefined, r.error);
  const rollout = find(r.objects, 'Rollout', 'example-svc');
  const analysis = rollout.spec.strategy.canary.steps.find((s) => s.analysis);
  assert.ok(analysis, '롤아웃 분석 단계');
  assert.equal(analysis.analysis.dryRun, undefined, 'dryRun이면 실패해도 중단하지 않는다');

  const m = metric('peaket-canary-error-ratio');
  const q = flat(m.provider.prometheus.query);
  assertArgs('peaket-canary-error-ratio', q);
  assert.match(q, /http_server_errors_total/, '5xx 오류 카운터를 센다');
  assert.match(q, /status_class!="4xx"/, '분모에서 4xx를 뺀다(docs/devops.md:530)');
  // 세 조건은 OR가 아니라 곱(AND)으로 이어져야 한다. 2배·0.5%p·5건 순서를 고정한다
  assert.match(q, />= bool 200\) \* /, '요청 200건 이상일 때만 판정한다');
  assert.match(q, /> bool 2 \*/, '안정판의 2배를 넘는가');
  assert.match(q, />= bool 0\.005/, '0.5%p 이상 높은가');
  assert.match(q, />= bool 5\b/, '카나리 오류 5건 이상인가');
  const i2 = q.indexOf('> bool 2 *');
  const iDelta = q.indexOf('>= bool 0.005');
  const i5 = q.indexOf('>= bool 5');
  assert.ok(i2 >= 0 && i2 < iDelta && iDelta < i5, '세 조건의 순서');
  assert.match(q.slice(i2, i5), /\*/, '조건 사이가 AND(*)다');
  assert.doesNotMatch(q, /\bor\b/, 'OR로 바꾸면 세 조건이 따로 실패한다');
  assert.equal(m.interval, POLICY.interval, '분석 간격');
  assert.equal(m.count, POLICY.count, '분석 횟수');
  assert.equal(m.failureLimit, POLICY.failureLimit, '실패 허용');
  assert.equal(m.successCondition, 'len(result) > 0 && result[0] == 0', '통과 조건(0)');
  assert.equal(m.failureCondition, 'len(result) > 0 && result[0] == 1', '실패 조건(1)');
  assert.equal(m.provider.prometheus.address, 'http://prometheus.observability.svc:9090', '클러스터 Prometheus');
  // 실패하면 Argo Rollouts가 자동 중단하고 SEV2 경보가 RB-23을 가리킨다(docs/devops.md:538, D-T6)
  const a = alert('peaket_canary_analysis_failed');
  assert.match(a.expr, /analysis_run_phase\{phase="Failed"\}\s*==\s*1/, '분석 실패 상태를 본다');
  assert.equal(a.for, '0m', '즉시');
  assert.equal(a.labels.severity, 'sev2', 'SEV2');
  assert.match(a.annotations.runbook_url, /rb-23/i, 'RB-23 링크');
  assert.equal(a.annotations.game_day, 'G-18', 'G-18');
});

test('D-T6 ② 오류 0.5%(200건·1건) 카나리는 오류 5건 미만이라 실패로 보지 않는다', () => {
  assert.equal(judgeError({ canaryRequests: 200, canaryErrors: 1, stableRequests: 200, stableErrors: 0 }), 'pass');
  // 200~999건에서 2배·0.5%p를 넘어도 5건 하한에 못 미치면 통과다
  assert.equal(judgeError({ canaryRequests: 400, canaryErrors: 4, stableRequests: 400, stableErrors: 0 }), 'pass');
  assert.equal(judgeError({ canaryRequests: 400, canaryErrors: 5, stableRequests: 400, stableErrors: 0 }), 'fail');
  // 경계: 정확히 2배(1.0% 대 0.5%)는 '넘는다'가 아니므로 통과, 0.5%p 경계(0.9% 대 0.4%)는 '이상'이라 실패.
  // 부동소수점 오차는 엡실론으로 흡수하고, 확실히 넘는 1.0% 대 0.4%도 함께 둔다(RV0911-25)
  assert.equal(judgeError({ canaryRequests: 1000, canaryErrors: 10, stableRequests: 1000, stableErrors: 5 }), 'pass');
  assert.equal(judgeError({ canaryRequests: 1000, canaryErrors: 9, stableRequests: 1000, stableErrors: 4 }), 'fail');
  assert.equal(judgeError({ canaryRequests: 1000, canaryErrors: 10, stableRequests: 1000, stableErrors: 4 }), 'fail');
  const q = flat(metric('peaket-canary-error-ratio').provider.prometheus.query);
  assert.match(q, />= bool 5\b/, '오류 5건 하한이 질의에 있다');
  assert.match(q, />= bool 200\b/, '요청 200건 경계가 질의에 있다');
  assert.match(q, />= bool 0\.005/, '0.5%p는 이상(>=)이다');
});

// --- D-T7: 최소 표본·p95 대체·5% 지연 제외 ---

test('D-T7 ① 분석 구간 카나리 요청 200건 미만이면 판정 불가로 멈춘다', () => {
  assert.equal(judgeError({ canaryRequests: 199, canaryErrors: 0, stableRequests: 1000, stableErrors: 0 }), 'inconclusive');
  assert.equal(judgeError({ canaryRequests: 200, canaryErrors: 0, stableRequests: 1000, stableErrors: 0 }), 'pass');
  const m = metric('peaket-canary-error-ratio');
  const q = flat(m.provider.prometheus.query);
  // 200건 미만 가지가 정확히 2를 내야 한다. 다른 곳의 '* 2'(오류 2배)와 구분해 카운트 식 전체를 고정한다
  assert.match(q, /\(sum\(increase\(http_server_request_duration_seconds_count\{[^}]+\}\)\) < bool 200\) \* 2/, '200건 미만은 2');
  assert.match(q, /\+ \(sum\(increase\(http_server_request_duration_seconds_count\{[^}]+\}\)\) >= bool 200\) \* /, '200건 이상 가지와 +로 결합');
  // 2는 성공(0)·실패(1) 어느 조건도 만족하지 않아 Inconclusive가 된다(Argo Rollouts 분석 문서)
  assert.doesNotMatch(m.successCondition, /==\s*2/, '성공 조건이 2를 통과로 보지 않는다');
  assert.doesNotMatch(m.failureCondition, /==\s*2/, '실패 조건이 2를 실패로 보지 않는다');
  const a = alert('peaket_canary_analysis_inconclusive');
  assert.match(a.expr, /analysis_run_phase\{phase="Inconclusive"\}\s*==\s*1/, '판정 불가 상태를 본다');
  assert.equal(a.for, '5m', '사람이 결정할 시간을 준다');
  assert.equal(a.labels.severity, 'sev3', '사람이 결정하도록 SEV3');
  assert.match(a.annotations.runbook_url, /rb-23/i, 'RB-23 링크');
});

test('D-T7 ② 200~999건이면 p99 대신 p95로 지연을 비교하고 5% 단계에서는 지연을 보지 않는다', () => {
  // 500건: p99만 나쁘면 p95로 보아 통과, p95가 나쁘면 실패
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 500, canaryP99: 1.0, stableP99: 0.1, canaryP95: 0.1, stableP95: 0.1 }), 'pass');
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 500, canaryP99: 0.1, stableP99: 0.1, canaryP95: 0.2, stableP95: 0.1 }), 'fail');
  // 경계: 999건은 p95, 1,000건은 p99. 한계(0.1×1.2+0.005=0.125)와 같으면 통과, 넘으면 실패
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 999, canaryP99: 1.0, stableP99: 0.1, canaryP95: 0.1, stableP95: 0.1 }), 'pass');
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 1000, canaryP99: 0.2, stableP99: 0.1, canaryP95: 0.1, stableP95: 0.1 }), 'fail');
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 1000, canaryP99: 0.125, stableP99: 0.1, canaryP95: 1.0, stableP95: 0.1 }), 'pass');
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 1000, canaryP99: 0.126, stableP99: 0.1, canaryP95: 1.0, stableP95: 0.1 }), 'fail');
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 199, canaryP99: 1.0, stableP99: 0.1, canaryP95: 1.0, stableP95: 0.1 }), 'inconclusive');
  assert.equal(judgeLatency({ weight: 5, canaryRequests: 1000, canaryP99: 1.0, stableP99: 0.1, canaryP95: 1.0, stableP95: 0.1 }), 'skip');

  // 롤아웃 단계: 5%에는 지연 템플릿이 없고 25%·50%에 있다. 차트가 분석을 내지 않으면 먼저 여기서 실패한다
  const r = render([...BASE, 'service.rollout.enabled=true', 'service.rollout.analysis.enabled=true']);
  assert.equal(r.error, undefined, r.error);
  const rollout = find(r.objects, 'Rollout', 'example-svc');
  assert.ok(rollout, 'Rollout example-svc');
  const steps = rollout.spec.strategy.canary.steps;
  const at = (w) => steps[steps.findIndex((s) => s.setWeight === w) + 2];
  assert.deepEqual(analysisTemplates(at(5)), ['peaket-canary-error-ratio', 'peaket-canary-event-loop'], '5%에는 지연 분석이 없다');
  assert.deepEqual(analysisTemplates(at(25)), ['peaket-canary-error-ratio', 'peaket-canary-latency', 'peaket-canary-event-loop'], '25%부터 지연을 본다');
  assert.deepEqual(analysisTemplates(at(50)), ['peaket-canary-error-ratio', 'peaket-canary-latency', 'peaket-canary-event-loop'], '50%에도 지연을 본다');

  const m = metric('peaket-canary-latency');
  const q = flat(m.provider.prometheus.query);
  assertArgs('peaket-canary-latency', q);
  assert.match(q, /histogram_quantile\(0\.99/, 'p99 경로');
  assert.match(q, /histogram_quantile\(0\.95/, 'p95 경로');
  assert.match(q, /\(sum\(increase\(http_server_request_duration_seconds_count\{[^}]+\}\)\) < bool 200\) \* 2/, '200건 미만은 2');
  assert.match(q, />= bool 200\b/, 'p95 경로 시작');
  assert.match(q, /< bool 1000\b/, 'p95 경로 끝');
  assert.match(q, />= bool 1000\b/, 'p99 경로 시작');
  assert.match(q, /1\.2/, '안정판 × 1.2');
  assert.match(q, /0\.005/, '+5ms');
  assert.match(q, /status_class!="5xx"/, '성공한 요청만');
  assert.doesNotMatch(q, /\bor\b/, '지연 경로는 OR로 겹치지 않는다');
});

// --- OPS-440: 생성 파일·배포 값·경보 ---

test('OPS-440 ① 카나리 분석 템플릿은 정본 임계값·최소 표본·0/1/2 판정을 담고 생성 파일과 같다', () => {
  const check = spawnSync(process.execPath, ['tools/ci/canary-analysis.mjs', '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(check.status, 0, `canary-analysis --check: ${check.stderr || check.stdout}`);
  const docs = yamlDocs(TEMPLATES);
  const names = docs.filter((o) => o.kind === 'ClusterAnalysisTemplate').map((o) => o.metadata.name).sort();
  assert.deepEqual(names, NAMES, '템플릿 셋');
  for (const name of names) {
    const m = metric(name);
    assert.deepEqual(m.provider.prometheus.timeout, '30s', `${name}: 질의 시간 한도`);
    assert.equal(m.interval, POLICY.interval, `${name}: 분석 간격`);
    assert.equal(m.count, POLICY.count, `${name}: 분석 횟수`);
    assert.equal(m.failureLimit, POLICY.failureLimit, `${name}: 실패 허용`);
    assert.equal(m.successCondition, 'len(result) > 0 && result[0] == 0', `${name}: 성공 0`);
    assert.equal(m.failureCondition, 'len(result) > 0 && result[0] == 1', `${name}: 실패 1`);
    assertArgs(name, flat(m.provider.prometheus.query));
  }
  const loop = flat(metric('peaket-canary-event-loop').provider.prometheus.query);
  assert.match(loop, /nodejs_eventloop_lag_p99_seconds/, '이벤트 루프 p99');
  assert.match(loop, /> bool 1\.5 \*/, '안정판 × 1.5');
  // 생성 템플릿을 실제로 적용하는 ArgoCD Application이 있어야 롤아웃이 참조할 수 있다(RV0911-07)
  const app = yamlFile(ANALYSIS_APP);
  assert.equal(app.kind, 'Application');
  assert.equal(app.metadata?.namespace, 'argocd');
  assert.equal(app.spec?.project, 'peaket-platform');
  assert.equal(app.spec?.source?.repoURL, 'https://github.com/peaket/peaket');
  assert.equal(app.spec?.source?.targetRevision, 'develop');
  assert.equal(app.spec?.source?.path, 'deploy/platform/argo-rollouts');
  assert.equal(app.spec?.source?.directory?.include, 'analysis-templates.yaml');
  assert.equal(app.spec?.destination?.server, 'https://kubernetes.default.svc');
  assert.equal(app.spec?.destination?.namespace, 'argo-rollouts');
  assert.deepEqual(app.spec?.syncPolicy?.automated, { prune: true, selfHeal: true });
  assert.ok((app.spec?.syncPolicy?.syncOptions ?? []).includes('CreateNamespace=true'));
});

test('OPS-440 ② 롤아웃은 5%에 오류·이벤트루프, 25·50%에 오류·지연·이벤트루프 분석을 붙이고 100%에는 붙이지 않는다', () => {
  const r = render([...BASE, 'service.rollout.enabled=true', 'service.rollout.analysis.enabled=true']);
  assert.equal(r.error, undefined, r.error);
  const rollout = find(r.objects, 'Rollout', 'example-svc');
  const steps = rollout.spec.strategy.canary.steps;
  assert.deepEqual(steps.filter((s) => s.setWeight !== undefined).map((s) => s.setWeight), POLICY.weights, '단계 가중치');
  for (const s of steps.filter((x) => x.pause)) assert.equal(s.pause.duration, `${POLICY.pauseSeconds}s`, '측정 창 5분');
  for (const weight of [5, 25, 50]) {
    const a = steps[steps.findIndex((s) => s.setWeight === weight) + 2];
    assert.equal(analysisArg(a, 'service'), 'example-svc', `${weight}%: 서비스 인자`);
    assert.deepEqual(analysisArg(a, 'canary-hash'), { podTemplateHashValue: 'Latest' }, `${weight}%: 카나리 해시`);
    assert.deepEqual(analysisArg(a, 'stable-hash'), { podTemplateHashValue: 'Stable' }, `${weight}%: 안정판 해시`);
    assert.ok((a.analysis.templates ?? []).every((t) => t.clusterScope === true), `${weight}%: 클러스터 범위 템플릿`);
  }
  const a5 = steps[steps.findIndex((s) => s.setWeight === 5) + 2];
  assert.deepEqual(analysisTemplates(a5), ['peaket-canary-error-ratio', 'peaket-canary-event-loop']);
  const at100 = steps.find((s) => s.setWeight === 100);
  assert.equal(at100.analysis, undefined, '100% 단계 자체에 분석이 없다');
  assert.equal(steps[steps.findIndex((s) => s.setWeight === 100) + 1], undefined, '100% 뒤에는 단계가 없다');
  // 분석을 켜지 않으면 분석 단계가 없다
  const off = render([...BASE, 'service.rollout.enabled=true']);
  assert.equal(off.error, undefined, off.error);
  assert.equal(analysisTemplates(find(off.objects, 'Rollout', 'example-svc').spec.strategy.canary.steps[2]), null, '기본값은 분석 없음');
  // analysis만 켜고 Rollout을 끄면 조용히 무시하지 않고 렌더를 멈춘다
  assert.match(render([...BASE, 'service.rollout.analysis.enabled=true']).error, /rollout/);
});

test('OPS-440 ③ 리더 인지 롤링은 복제 3·maxUnavailable 1·maxSurge 0·PDB minAvailable 2를 내고 잘못된 값을 막는다', () => {
  // 기본값: 전략을 내지 않아 기존 서비스 렌더가 바뀌지 않는다
  const base = render(BASE);
  assert.equal(base.error, undefined, base.error);
  assert.equal(find(base.objects, 'Deployment', 'example-svc').spec.strategy, undefined, '기본 Deployment 전략 없음');
  const good = render([
    ...BASE,
    'service.replicas=3',
    'service.rollingUpdate.enabled=true',
    'service.rollingUpdate.maxUnavailable=1',
    'service.rollingUpdate.maxSurge=0',
    'service.pdb.enabled=true',
    'service.pdb.minAvailable=2',
  ]);
  assert.equal(good.error, undefined, good.error);
  const dep = find(good.objects, 'Deployment', 'example-svc');
  assert.deepEqual(dep.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } }, '순차 롤링');
  const pdb = find(good.objects, 'PodDisruptionBudget', 'example-svc');
  assert.equal(pdb.spec.minAvailable, 2, '정족수 2');
  assert.equal(pdb.spec.maxUnavailable, undefined, 'minAvailable과 maxUnavailable을 함께 두지 않는다');
  // opt-in이 꺼져 있으면 값을 줘도 전략을 내지 않는다
  const off = render([...BASE, 'service.rollingUpdate.enabled=false', 'service.rollingUpdate.maxUnavailable=1', 'service.rollingUpdate.maxSurge=0']);
  assert.equal(off.error, undefined, off.error);
  assert.equal(find(off.objects, 'Deployment', 'example-svc').spec.strategy, undefined, '꺼진 opt-in');
  // 둘 다 0이면 롤링이 멈춘다
  assert.match(render([...BASE, 'service.rollingUpdate.enabled=true', 'service.rollingUpdate.maxUnavailable=0', 'service.rollingUpdate.maxSurge=0']).error, /maxUnavailable|maxSurge/);
  // 기존 PDB 기본값: minAvailable·maxUnavailable을 주지 않으면 maxUnavailable 1
  const pdbDefault = find(render([...BASE, 'service.pdb.enabled=true']).objects, 'PodDisruptionBudget', 'example-svc');
  assert.equal(pdbDefault.spec.maxUnavailable, 1, 'PDB 기본 1');
  // PDB는 minAvailable과 maxUnavailable 가운데 하나만 받는다
  assert.match(render([...BASE, 'service.pdb.enabled=true', 'service.pdb.minAvailable=2', 'service.pdb.maxUnavailable=1']).error, /minAvailable|maxUnavailable/);
  // minAvailable은 1 이상이고 복제 수보다 작아야 한다
  assert.match(render([...BASE, 'service.pdb.enabled=true', 'service.pdb.minAvailable=0']).error, /minAvailable/);
  assert.match(render([...BASE, 'service.replicas=3', 'service.pdb.enabled=true', 'service.pdb.minAvailable=3']).error, /minAvailable/);
});

test('OPS-440 ④ admission-ctrl 배포 값은 3복제·순차 롤링·정족수 2를 갖고 제어 포트·Lease는 F-09-8로 넘긴다', () => {
  const v = yamlFile('deploy/workloads/admission-ctrl/values.yaml');
  assert.equal(v.name, 'admission-ctrl');
  assert.equal(v.managementPort, 9464);
  assert.equal(v.service?.replicas, 3, '복제 3(활성 1·대기 2)');
  assert.deepEqual(v.service?.rollingUpdate, { enabled: true, maxUnavailable: 1, maxSurge: 0 }, '순차 롤링 opt-in');
  assert.equal(v.service?.pdb?.enabled, true);
  assert.equal(v.service?.pdb?.minAvailable, 2, '정족수 2');
  // 제어 gRPC·Lease RBAC·리더 전용 Service는 F-09-8(OPS-300) 몫이다. 일반 Service에 제어 포트를 열지 않는다
  assert.equal((v.service?.extraPorts ?? []).some((p) => p.name === 'control' || p.port === 50061), false, '제어 포트 없음');
  assert.equal(v.service?.leaderLease ?? '', '', 'Lease는 F-09-8');
  assert.equal(v.service?.rollout?.enabled ?? false, false, 'Rollout을 쓰지 않는다');
  assert.equal(v.service?.autoscaling?.enabled ?? false, false, 'HPA를 쓰지 않는다');
  assert.equal(v.service?.keda?.enabled ?? false, false, 'KEDA를 쓰지 않는다');
  // 값 파일이 차트 스키마와 맞는지 helm으로 렌더한다
  const r = renderValues('deploy/workloads/admission-ctrl/values.yaml', IMAGE);
  assert.equal(r.error, undefined, r.error);
  const dep = find(r.objects, 'Deployment', 'admission-ctrl');
  assert.equal(dep.spec.replicas, 3);
  assert.deepEqual(dep.spec.strategy, { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 1, maxSurge: 0 } });
  assert.equal(find(r.objects, 'PodDisruptionBudget', 'admission-ctrl').spec.minAvailable, 2);
  assert.equal(all(r.objects, 'Lease').length, 0, '차트가 Lease를 만들지 않는다');
  assert.equal(all(r.objects, 'Role').some((x) => x.metadata?.name?.includes('leader-lease')), false, 'Lease RBAC 없음');
  const svc = find(r.objects, 'Service', 'admission-ctrl');
  assert.equal((svc.spec.ports ?? []).some((p) => p.port === 50061), false, '일반 Service에 제어 포트 없음');
});

test('OPS-440 ⑤ 그림자 배포 값은 작업자 모드·1복제·Lease 없음·다른 Secret·Prometheus 주소를 갖는다', () => {
  const v = yamlFile('deploy/workloads/admission-ctrl-shadow/values.yaml');
  assert.equal(v.name, 'admission-ctrl-shadow');
  assert.equal(v.worker?.enabled, true, '앱 포트·Service 없는 작업자 모드');
  assert.equal(v.service?.replicas, 1);
  assert.equal(v.service?.leaderLease ?? '', '', 'Lease에 참여하지 않는다');
  assert.equal(v.secretEnvFrom, 'admission-ctrl-shadow-secrets');
  assert.notEqual(v.secretEnvFrom, 'admission-ctrl-secrets', '리더의 쓰기 Secret을 쓰지 않는다');
  assert.equal(v.service?.env?.PEAKET_ADMISSION_SHADOW, '1');
  assert.equal(v.service?.env?.PEAKET_PROMETHEUS_URL, 'http://prometheus.observability.svc:9090');
  const internal = v.service?.networkPolicy?.egress?.internal ?? [];
  const redis = internal.find((e) => (e.ports ?? []).includes(6379));
  const prom = internal.find((e) => (e.ports ?? []).includes(9090));
  assert.ok(redis, 'Redis로 나가는 egress');
  assert.ok(prom, 'Prometheus로 나가는 egress');
  // 목적지가 있어야 한다. 넓은 CIDR만 열거나 목적지가 비면 안 된다
  for (const [name, e] of [['Redis', redis], ['Prometheus', prom]]) {
    const kinds = ['namespaces', 'podLabels', 'cidrs'].filter((k) => e[k] !== undefined);
    assert.equal(kinds.length, 1, `${name} egress 목적지 하나`);
    assert.doesNotMatch(JSON.stringify(e), /0\.0\.0\.0\/0|::\/0/, `${name} egress 전체 대역`);
  }
  // 값 파일이 차트 스키마와 맞는지 helm으로 렌더한다(작업자 모드: Service 없음, Lease 없음)
  const r = renderValues('deploy/workloads/admission-ctrl-shadow/values.yaml', IMAGE);
  assert.equal(r.error, undefined, r.error);
  assert.equal(all(r.objects, 'Service').length, 0, '작업자 모드는 Service를 만들지 않는다');
  assert.equal(all(r.objects, 'Lease').length, 0, '그림자는 Lease를 만들지 않는다');
  const dep = find(r.objects, 'Deployment', 'admission-ctrl-shadow');
  assert.equal(dep.spec.replicas, 1);
  const env = Object.fromEntries((dep.spec.template.spec.containers[0].env ?? []).map((e) => [e.name, e.value]));
  assert.equal(env.PEAKET_ADMISSION_SHADOW, '1');
  assert.equal(env.PEAKET_PROMETHEUS_URL, 'http://prometheus.observability.svc:9090');
});

test('OPS-440 ⑦ 분석 실패·판정 불가·그림자 불일치 경보와 롤아웃 지표 긁기가 있다', () => {
  const groups = yamlDocs(ALERTS)
    .filter((o) => o.kind === 'PrometheusRule')
    .flatMap((o) => o.spec.groups ?? []);
  assert.ok(groups.length > 0, '경보 묶음');
  for (const g of groups) assert.ok(g.interval, `${g.name}: 평가 간격`);
  const failed = alert('peaket_canary_analysis_failed');
  assert.equal(failed.labels.kind, 'cause');
  assert.equal(failed.for, '0m');
  assert.equal(failed.labels.severity, 'sev2');
  const inconclusive = alert('peaket_canary_analysis_inconclusive');
  assert.equal(inconclusive.labels.kind, 'cause');
  assert.equal(inconclusive.for, '5m');
  assert.equal(inconclusive.labels.severity, 'sev3');
  const shadow = alert('admission_shadow_diverged');
  assert.match(shadow.expr, /admission_shadow_diff\s*>\s*0/, '그림자 차이');
  assert.equal(shadow.for, '10m');
  assert.equal(shadow.labels.severity, 'sev3');
  assert.equal(shadow.labels.kind, 'cause');
  for (const r of [failed, inconclusive, shadow]) {
    assert.ok(r.annotations?.summary, `${r.alert}: summary`);
    assert.ok(r.annotations?.dashboard_url, `${r.alert}: dashboard_url`);
    assert.ok(r.annotations?.runbook_url, `${r.alert}: runbook_url`);
  }
  const values = yamlFile('deploy/platform/argo-rollouts/values.yaml');
  assert.equal(values.controller?.metrics?.enabled, true, '컨트롤러 지표');
  assert.equal(values.controller?.metrics?.serviceMonitor?.enabled, true, '지표 긁기(ServiceMonitor)');
});
