// 로컬 관측 최소 시험(docs/observability.md §3 '로컬 관측 최소와 템플릿 대시보드', wbs 1.3.1, BUILD_ORDER BSL-070).
// 템플릿 대시보드 생성기, Prometheus·Grafana 매니페스트, 공용 차트의 수집 주석, cluster.mjs의 관측 명령 인자를 본다.
// 실제 클러스터에 올려 보는 것은 tools/local/e2e/observability.e2e.mjs다.
// 실행: node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';
import { DASHBOARD_SERVICES, serviceDashboard } from './dashboards.mjs';
import { grafanaAdminSecret, grafanaForwardArgs, prometheusForwardArgs } from './cluster.mjs';
import { ensureTool } from './tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const exprs = (panel) => panel.targets.map((t) => t.expr);
const firstRow = (d) => {
  const rows = d.panels.filter((p) => p.type === 'row');
  const second = d.panels.indexOf(rows[1]);
  return d.panels.slice(d.panels.indexOf(rows[0]) + 1, second < 0 ? undefined : second);
};

test('NFR-011 템플릿 대시보드의 첫 행은 지연·트래픽·오류·포화도 네 신호이고 서비스 지표만 고른다', () => {
  const d = serviceDashboard('v0-monolith');
  assert.equal(d.uid, 'peaket-svc-v0-monolith');
  const row = firstRow(d);
  assert.deepEqual(row.map((p) => p.title), ['지연', '트래픽', '오류', '포화도']);
  for (const p of row) {
    assert.equal(p.datasource.uid, 'prometheus', p.title);
    for (const e of exprs(p)) assert.match(e, /service="v0-monolith"|app="v0-monolith"/, `${p.title}: ${e}`);
  }
  const [lat, traffic, errors, sat] = row;
  // 지연: 성공(5xx 아님)과 실패(5xx)를 나눈 p50·p99·p99.9(docs/observability.md §2 '레이턴시 히스토그램')
  for (const q of ['0.5', '0.99', '0.999']) {
    assert.ok(exprs(lat).some((e) => e.includes(`histogram_quantile(${q},`) && e.includes('status_class!="5xx"')), `성공 p${q}`);
    assert.ok(exprs(lat).some((e) => e.includes(`histogram_quantile(${q},`) && e.includes('status_class="5xx"')), `실패 p${q}`);
  }
  assert.ok(exprs(lat).every((e) => e.includes('http_server_request_duration_seconds_bucket') && e.includes('route=~"$route"')));
  assert.ok(exprs(traffic).some((e) => /sum by \(route\) \(rate\(http_server_request_duration_seconds_count\{/.test(e)));
  // 오류: 5xx 비율과 정상 분기 거절 비율을 따로(같은 409라도 정상 분기는 오류에 넣지 않는다)
  assert.ok(exprs(errors).some((e) => e.includes('http_server_errors_total') && !e.includes('business_rejections')));
  assert.ok(exprs(errors).some((e) => e.includes('http_server_business_rejections_total') && !e.includes('http_server_errors_total')));
  // 포화도: 처리 중 요청 수(ADR-0077)와 이벤트 루프 지연 p99(Node 기본 지표는 service 라벨이 없어 app으로 고른다)
  assert.ok(exprs(sat).some((e) => e.includes('http_server_active_requests')));
  assert.ok(exprs(sat).some((e) => e.includes('nodejs_eventloop_lag_p99_seconds{app="v0-monolith"}')));
  assert.equal(d.templating.list.find((v) => v.name === 'route').query.query, 'label_values(http_server_request_duration_seconds_count{service="v0-monolith"}, route)');
  assert.deepEqual(serviceDashboard('v0-monolith'), d, '같은 입력이면 같은 JSON');
});

test('NFR-011 대시보드: 오류가 한 번도 없어도 오류 패널이 0을 보이고, 창은 수집 간격에 맞추며, 단위가 다른 선은 따로 그린다', () => {
  const d = serviceDashboard('v0-monolith');
  const [, , errors, sat] = firstRow(d);
  // 라벨 있는 카운터는 처음 오를 때까지 시계열이 없다. 분자가 비면 식 전체가 비어 'No data'가 되므로 0으로 메운다
  for (const e of exprs(errors)) assert.match(e, / or 0 \* sum\(rate\(http_server_request_duration_seconds_count\{/, e);
  for (const p of firstRow(d)) for (const e of exprs(p)) if (e.includes('rate(')) assert.match(e, /\[\$__rate_interval\]/, e);
  const lag = sat.fieldConfig.overrides.find((o) => o.matcher.options.startsWith('이벤트 루프'));
  assert.ok(lag, '이벤트 루프 지연 선 덮어쓰기');
  assert.deepEqual(lag.properties.map((x) => x.id).sort(), ['custom.axisPlacement', 'unit']);
  assert.equal(lag.properties.find((x) => x.id === 'unit').value, 's');
  const table = d.panels.find((p) => p.type === 'table');
  const organize = table.transformations.find((t) => t.id === 'organize');
  assert.deepEqual(organize.options.renameByName, { 'Value #A': 'p99(초)', 'Value #B': '요청 수(5분)' });
});

test('NFR-011 대시보드 uid는 Grafana 한도(40자) 안이고, 그보다 긴 서비스 이름은 거부한다', () => {
  assert.ok(serviceDashboard('a'.repeat(28)).uid.length <= 40);
  assert.throws(() => serviceDashboard('a'.repeat(30)));
});

test('NFR-011 커밋된 대시보드 파일은 생성기 결과와 같고, 다르면 --check가 실패한다', () => {
  assert.ok(DASHBOARD_SERVICES.includes('v0-monolith') && DASHBOARD_SERVICES.includes('example-svc'));
  const ok = spawnSync(process.execPath, [join(REPO, 'tools', 'local', 'dashboards.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const dir = mkdtempSync(join(tmpdir(), 'dash-'));
  cpSync(join(REPO, 'deploy', 'local', 'dashboards'), dir, { recursive: true });
  const f = join(dir, 'v0-monolith.json');
  writeFileSync(f, readFileSync(f, 'utf8').replace('"지연"', '"지연(손으로 고침)"'));
  const bad = spawnSync(process.execPath, [join(REPO, 'tools', 'local', 'dashboards.mjs'), '--check', '--dir', dir], { encoding: 'utf8' });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout + bad.stderr, /v0-monolith\.json/);
  // 목록에 없는 서비스의 파일이 남아 있으면(지운 서비스) Grafana에 실리므로 --check가 실패한다
  const dir2 = mkdtempSync(join(tmpdir(), 'dash-'));
  cpSync(join(REPO, 'deploy', 'local', 'dashboards'), dir2, { recursive: true });
  writeFileSync(join(dir2, 'gone-svc.json'), '{}');
  const stray = spawnSync(process.execPath, [join(REPO, 'tools', 'local', 'dashboards.mjs'), '--check', '--dir', dir2], { encoding: 'utf8' });
  assert.equal(stray.status, 1, stray.stdout + stray.stderr);
  assert.match(stray.stdout + stray.stderr, /gone-svc\.json/);
});

const obs = parseAllDocuments(readFileSync(join(REPO, 'deploy', 'local', 'observability.yaml'), 'utf8')).map((d) => d.toJS()).filter(Boolean);
const of = (kind, name) => obs.find((o) => o.kind === kind && o.metadata.name === name);
const containers = obs.filter((o) => o.kind === 'Deployment').flatMap((d) => d.spec.template.spec.containers);

test('[ASVS v5.0.0-13.4.5] 로컬 Prometheus·Grafana는 다이제스트로 고정하고 클러스터 안 주소만 연다', () => {
  assert.ok(containers.length >= 2);
  for (const c of containers) assert.match(c.image, /@sha256:[0-9a-f]{64}$/, c.image);
  for (const s of obs.filter((o) => o.kind === 'Service')) assert.ok(!s.spec.type || s.spec.type === 'ClusterIP', s.metadata.name);
  const fwd = grafanaForwardArgs();
  assert.equal(fwd[fwd.indexOf('--address') + 1], '127.0.0.1');
  assert.ok(fwd.includes('svc/grafana') && fwd.includes('observability'));
  const pf = prometheusForwardArgs();
  assert.equal(pf[pf.indexOf('--address') + 1], '127.0.0.1');
  assert.ok(pf.includes('svc/prometheus') && pf.includes('9090:9090'));
});

test('ADR-0077 Prometheus는 주석을 단 파드만 긁고 app·component 라벨을 옮기며 exemplar 저장과 2일 보존을 켠다', () => {
  const prom = of('Deployment', 'prometheus').spec.template.spec.containers[0];
  assert.ok(prom.args.includes('--enable-feature=exemplar-storage'));
  assert.ok(prom.args.includes('--storage.tsdb.retention.time=2d'));
  // 설정(ConfigMap)을 고쳐 다시 올리면 재시작 없이(2일치 자료를 지우지 않고) 다시 읽는다
  assert.ok(prom.args.includes('--enable-feature=auto-reload-config'));
  assert.ok(prom.args.some((a) => a.startsWith('--config.auto-reload-interval=')));
  const cfg = of("ConfigMap", "prometheus-config").data["prometheus.yml"];
  const [scrape] = parseAllDocuments(cfg)[0].toJS().scrape_configs;
  assert.equal(scrape.kubernetes_sd_configs[0].role, 'pod');
  assert.equal(scrape.scrape_interval, '5s');
  const rl = scrape.relabel_configs;
  assert.ok(rl.some((r) => r.action === 'keep' && r.source_labels?.[0] === '__meta_kubernetes_pod_annotation_prometheus_io_scrape' && r.regex === 'true'));
  assert.ok(rl.some((r) => r.target_label === 'app' && r.source_labels?.[0] === '__meta_kubernetes_pod_label_app_kubernetes_io_name'));
  assert.ok(rl.some((r) => r.target_label === 'component' && r.source_labels?.[0] === '__meta_kubernetes_pod_label_app_kubernetes_io_component'));
  assert.ok(!rl.some((r) => r.target_label === 'service'), '지표의 service 라벨을 덮지 않는다');
});

test('[ASVS v5.0.0-13.2.2] Prometheus 권한은 파드 읽기뿐이고 Grafana는 토큰을 싣지 않는다', () => {
  const role = of('ClusterRole', 'prometheus-pods');
  assert.deepEqual(role.rules, [{ apiGroups: [''], resources: ['pods'], verbs: ['get', 'list', 'watch'] }]);
  assert.equal(of('Deployment', 'grafana').spec.template.spec.automountServiceAccountToken, false);
});

test('[ASVS v5.0.0-13.3.1] [ASVS v5.0.0-8.2.1] Grafana는 익명 보기만 열고 관리자 비밀번호는 Secret에서만 받으며 그 값은 매번 무작위다', () => {
  const g = of('Deployment', 'grafana').spec.template.spec.containers[0];
  const env = Object.fromEntries(g.env.map((e) => [e.name, e.value ?? e.valueFrom]));
  assert.equal(env.GF_AUTH_ANONYMOUS_ENABLED, 'true');
  assert.equal(env.GF_AUTH_ANONYMOUS_ORG_ROLE, 'Viewer');
  assert.equal(env.GF_AUTH_DISABLE_LOGIN_FORM, 'true');
  assert.deepEqual(env.GF_SECURITY_ADMIN_PASSWORD, { secretKeyRef: { name: 'grafana-admin', key: 'password' } });
  assert.ok(!obs.some((o) => o.kind === 'Secret'), '저장소의 매니페스트에 Secret 값을 두지 않는다');
  const a = grafanaAdminSecret();
  const b = grafanaAdminSecret();
  assert.equal(a.kind, 'Secret');
  assert.notEqual(a.stringData.password, b.stringData.password);
  assert.ok(a.stringData.password.length >= 32);
  const ds = parseAllDocuments(of('ConfigMap', 'grafana-provisioning').data['datasources.yaml'])[0].toJS();
  assert.deepEqual(ds.datasources.map((x) => [x.uid, x.url]), [['prometheus', 'http://prometheus.observability.svc:9090']]);
});

test('NFR-011 공용 차트는 서비스·릴레이 파드의 관리 포트 /metrics에 수집 주석을 단다', async () => {
  const helm = await ensureTool('helm');
  const r = spawnSync(helm, ['template', 'rel', join(REPO, 'deploy', 'charts', 'peaket-service'), '--namespace', 'example',
    ...['name=example-svc', 'image.repository=peaket/example-svc', 'image.tag=local', 'env.PEAKET_ENV=local', 'outboxRelay.enabled=true'].flatMap((s) => ['--set', s])], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const objs = parseAllDocuments(r.stdout).map((d) => d.toJS()).filter(Boolean);
  const deps = objs.filter((o) => o.kind === 'Deployment');
  assert.ok(deps.length >= 1);
  for (const d of deps) {
    const ann = d.spec.template.metadata.annotations ?? {};
    const mgmt = d.spec.template.spec.containers[0].ports.find((p) => p.name === 'management').containerPort;
    assert.deepEqual([ann['prometheus.io/scrape'], ann['prometheus.io/port'], ann['prometheus.io/path']], ['true', String(mgmt), '/metrics'], d.metadata.name);
  }
});
