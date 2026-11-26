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
const find = (objs, kind, name) => objs.find((o) => o.kind === kind && o.metadata?.name === name);
const BASE = ['name=example-svc', 'image.repository=peaket/example-svc', 'image.tag=local', 'env.PEAKET_ENV=local'];

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

/** D-T6·D-T7 판정기. Argo Rollouts 질의가 내는 0(통과)·1(실패)·2(판정 불가)와 같은 규칙이다 */
function judgeError(o) {
  if (o.canaryRequests < POLICY.error.minRequests) return 'inconclusive';
  const canary = o.canaryErrors / o.canaryRequests;
  const stable = o.stableRequests > 0 ? o.stableErrors / o.stableRequests : 0;
  const fail =
    canary > POLICY.error.multiple * stable &&
    canary - stable >= POLICY.error.delta &&
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

function metric(templateName) {
  const docs = yamlDocs(TEMPLATES);
  const t = docs.find((o) => o.kind === 'ClusterAnalysisTemplate' && o.metadata?.name === templateName);
  assert.ok(t, `${TEMPLATES}: ClusterAnalysisTemplate ${templateName}`);
  assert.equal(t.apiVersion, 'argoproj.io/v1alpha1', `${templateName}: apiVersion`);
  assert.equal(t.spec.metrics?.length, 1, `${templateName}: metric 하나`);
  return t.spec.metrics[0];
}
const flat = (s) => s.replace(/\s+/g, ' ').trim();

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
  const m = metric('peaket-canary-error-ratio');
  const q = flat(m.provider.prometheus.query);
  assert.match(q, /http_server_errors_total/, '5xx 오류 카운터를 센다');
  assert.match(q, /status_class!="4xx"/, '분모에서 4xx를 뺀다(docs/devops.md:530)');
  assert.match(q, /> bool 2 \*/, '안정판의 2배를 넘는가');
  assert.match(q, />= bool 0\.005/, '0.5%p 이상 높은가');
  assert.match(q, />= bool 5\b/, '카나리 오류 5건 이상인가');
  assert.match(q, /< bool 200\b/, '카나리 요청 200건 미만은 판정 불가');
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
  const q = flat(metric('peaket-canary-error-ratio').provider.prometheus.query);
  assert.match(q, />= bool 5\b/, '오류 5건 하한이 질의에 있다');
  assert.match(q, />= bool 200\b/, '요청 200건 경계가 질의에 있다');
});

// --- D-T7: 최소 표본·p95 대체·5% 지연 제외 ---

test('D-T7 ① 분석 구간 카나리 요청 200건 미만이면 판정 불가로 멈춘다', () => {
  assert.equal(judgeError({ canaryRequests: 199, canaryErrors: 0, stableRequests: 1000, stableErrors: 0 }), 'inconclusive');
  assert.equal(judgeError({ canaryRequests: 200, canaryErrors: 0, stableRequests: 1000, stableErrors: 0 }), 'pass');
  const m = metric('peaket-canary-error-ratio');
  const q = flat(m.provider.prometheus.query);
  assert.match(q, /< bool 200\b/, '200건 미만 가지');
  assert.match(q, /\* 2\b|\* 2 \b/, '판정 불가 값 2');
  // 2는 성공(0)·실패(1) 어느 조건도 만족하지 않아 Inconclusive가 된다(Argo Rollouts 분석 문서)
  assert.doesNotMatch(m.successCondition, /==\s*2/, '성공 조건이 2를 통과로 보지 않는다');
  assert.doesNotMatch(m.failureCondition, /==\s*2/, '실패 조건이 2를 실패로 보지 않는다');
  const a = alert('peaket_canary_analysis_inconclusive');
  assert.match(a.expr, /analysis_run_phase\{phase="Inconclusive"\}\s*==\s*1/, '판정 불가 상태를 본다');
  assert.equal(a.labels.severity, 'sev3', '사람이 결정하도록 SEV3');
  assert.match(a.annotations.runbook_url, /rb-23/i, 'RB-23 링크');
});

test('D-T7 ② 200~999건이면 p99 대신 p95로 지연을 비교하고 5% 단계에서는 지연을 보지 않는다', () => {
  // 500건: p99만 나쁘면 p95로 보아 통과, p95가 나쁘면 실패
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 500, canaryP99: 1.0, stableP99: 0.1, canaryP95: 0.1, stableP95: 0.1 }), 'pass');
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 500, canaryP99: 0.1, stableP99: 0.1, canaryP95: 0.2, stableP95: 0.1 }), 'fail');
  // 1,000건 이상은 p99, 200건 미만은 판정 불가, 5% 단계는 지연을 보지 않는다
  assert.equal(judgeLatency({ weight: 25, canaryRequests: 1000, canaryP99: 0.2, stableP99: 0.1, canaryP95: 0.1, stableP95: 0.1 }), 'fail');
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
  assert.match(q, /histogram_quantile\(0\.99/, 'p99 경로');
  assert.match(q, /histogram_quantile\(0\.95/, 'p95 경로');
  assert.match(q, /< bool 200\b/, '200건 미만 판정 불가');
  assert.match(q, />= bool 200\b/, 'p95 경로 시작');
  assert.match(q, /< bool 1000\b/, 'p95 경로 끝');
  assert.match(q, />= bool 1000\b/, 'p99 경로 시작');
  assert.match(q, /1\.2/, '안정판 × 1.2');
  assert.match(q, /0\.005/, '+5ms');
  assert.match(q, /status_class!="5xx"/, '성공한 요청만');
});

// --- OPS-440: 생성 파일·배포 값·경보 ---

test('OPS-440 ① 카나리 분석 템플릿은 정본 임계값·최소 표본·0/1/2 판정을 담고 생성 파일과 같다', () => {
  const check = spawnSync(process.execPath, ['tools/ci/canary-analysis.mjs', '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(check.status, 0, `canary-analysis --check: ${check.stderr || check.stdout}`);
  const docs = yamlDocs(TEMPLATES);
  const names = docs.filter((o) => o.kind === 'ClusterAnalysisTemplate').map((o) => o.metadata.name).sort();
  assert.deepEqual(names, ['peaket-canary-error-ratio', 'peaket-canary-event-loop', 'peaket-canary-latency'], '템플릿 셋');
  for (const name of names) {
    const m = metric(name);
    assert.deepEqual(m.provider.prometheus.timeout, '30s', `${name}: 질의 시간 한도`);
    assert.equal(m.successCondition, 'len(result) > 0 && result[0] == 0', `${name}: 성공 0`);
    assert.equal(m.failureCondition, 'len(result) > 0 && result[0] == 1', `${name}: 실패 1`);
  }
  const loop = flat(metric('peaket-canary-event-loop').provider.prometheus.query);
  assert.match(loop, /nodejs_eventloop_lag_p99_seconds/, '이벤트 루프 p99');
  assert.match(loop, /> bool 1\.5 \*/, '안정판 × 1.5');
});

test('OPS-440 ② 롤아웃은 5%에 오류·이벤트루프, 25·50%에 오류·지연·이벤트루프 분석을 붙이고 100%에는 붙이지 않는다', () => {
  const r = render([...BASE, 'service.rollout.enabled=true', 'service.rollout.analysis.enabled=true']);
  assert.equal(r.error, undefined, r.error);
  const rollout = find(r.objects, 'Rollout', 'example-svc');
  const steps = rollout.spec.strategy.canary.steps;
  assert.deepEqual(steps.filter((s) => s.setWeight !== undefined).map((s) => s.setWeight), POLICY.weights, '단계 가중치');
  for (const s of steps.filter((x) => x.pause)) assert.equal(s.pause.duration, `${POLICY.pauseSeconds}s`, '측정 창 5분');
  const a5 = steps[steps.findIndex((s) => s.setWeight === 5) + 2];
  assert.deepEqual(analysisTemplates(a5), ['peaket-canary-error-ratio', 'peaket-canary-event-loop']);
  assert.equal(analysisArg(a5, 'service'), 'example-svc', '서비스 인자');
  assert.deepEqual(analysisArg(a5, 'canary-hash'), { podTemplateHashValue: 'Latest' }, '카나리 해시');
  assert.deepEqual(analysisArg(a5, 'stable-hash'), { podTemplateHashValue: 'Stable' }, '안정판 해시');
  assert.ok((a5.analysis.templates ?? []).every((t) => t.clusterScope === true), '클러스터 범위 템플릿');
  const after100 = steps[steps.findIndex((s) => s.setWeight === 100) + 1];
  assert.equal(after100, undefined, '100% 뒤에는 분석·대기가 없다');
  // 분석을 켜지 않으면 분석 단계가 없다
  const off = render([...BASE, 'service.rollout.enabled=true']);
  assert.equal(off.error, undefined, off.error);
  assert.equal(analysisTemplates(find(off.objects, 'Rollout', 'example-svc').spec.strategy.canary.steps[2]), null, '기본값은 분석 없음');
});

test('OPS-440 ③ 리더 인지 롤링은 복제 3·maxUnavailable 1·maxSurge 0·PDB minAvailable 2를 내고 잘못된 값을 막는다', () => {
  const good = render([
    ...BASE,
    'service.replicas=3',
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
  // 둘 다 0이면 롤링이 멈춘다
  assert.match(render([...BASE, 'service.rollingUpdate.maxUnavailable=0', 'service.rollingUpdate.maxSurge=0']).error, /maxUnavailable|maxSurge/);
  // PDB는 minAvailable과 maxUnavailable 가운데 하나만 받는다
  assert.match(render([...BASE, 'service.pdb.enabled=true', 'service.pdb.minAvailable=2', 'service.pdb.maxUnavailable=1']).error, /minAvailable|maxUnavailable/);
  // minAvailable은 1 이상이다
  assert.match(render([...BASE, 'service.pdb.enabled=true', 'service.pdb.minAvailable=0']).error, /minAvailable/);
});

test('OPS-440 ④ admission-ctrl 배포 값은 3복제·순차 롤링·정족수 2·Lease·제어 포트를 갖는다', () => {
  const v = yamlFile('deploy/workloads/admission-ctrl/values.yaml');
  assert.equal(v.name, 'admission-ctrl');
  assert.equal(v.managementPort, 9464);
  assert.equal(v.service?.replicas, 3, '복제 3(활성 1·대기 2)');
  assert.deepEqual(v.service?.rollingUpdate, { maxUnavailable: 1, maxSurge: 0 }, '순차 롤링');
  assert.equal(v.service?.pdb?.enabled, true);
  assert.equal(v.service?.pdb?.minAvailable, 2, '정족수 2');
  assert.equal(v.service?.leaderLease, 'admission-ctrl', 'Lease');
  assert.ok((v.service?.extraPorts ?? []).some((p) => p.name === 'control' && p.port === 50061), '제어 gRPC 50061');
  assert.equal(v.service?.rollout?.enabled ?? false, false, 'Rollout을 쓰지 않는다');
  assert.equal(v.service?.autoscaling?.enabled ?? false, false, 'HPA를 쓰지 않는다');
  assert.equal(v.service?.keda?.enabled ?? false, false, 'KEDA를 쓰지 않는다');
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
  assert.ok(internal.some((e) => (e.ports ?? []).includes(6379)), 'Redis로 나가는 egress');
  assert.ok(internal.some((e) => (e.ports ?? []).includes(9090)), 'Prometheus로 나가는 egress');
});

test('OPS-440 ⑦ 분석 실패·판정 불가·그림자 불일치 경보와 롤아웃 지표 긁기가 있다', () => {
  const failed = alert('peaket_canary_analysis_failed');
  assert.equal(failed.labels.kind, 'cause');
  const inconclusive = alert('peaket_canary_analysis_inconclusive');
  assert.equal(inconclusive.labels.kind, 'cause');
  const shadow = alert('admission_shadow_diverged');
  assert.match(shadow.expr, /admission_shadow_diff\s*>\s*0/, '그림자 차이');
  assert.equal(shadow.for, '10m');
  assert.equal(shadow.labels.severity, 'sev3');
  assert.equal(shadow.labels.kind, 'cause');
  const values = yamlFile('deploy/platform/argo-rollouts/values.yaml');
  assert.equal(values.controller?.metrics?.enabled, true, '컨트롤러 지표');
  assert.equal(values.controller?.metrics?.serviceMonitor?.enabled, true, '지표 긁기(ServiceMonitor)');
});
