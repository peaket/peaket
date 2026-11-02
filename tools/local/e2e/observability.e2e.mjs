// 로컬 관측 최소의 kind 확인(docs/observability.md §3 '로컬 관측 최소와 템플릿 대시보드', wbs 1.3.1, BUILD_ORDER BSL-070).
// 실제 클러스터에 Prometheus·Grafana를 올리고, 공용 차트로 띄운 example-svc의 관리 포트 지표를 긁는지,
// 템플릿 대시보드의 모든 조회 식이 Prometheus에서 도는지, Grafana가 익명 보기로 그 대시보드를 내주는지 본다.
// 실행(저장소 뿌리): node tools/local/cluster.mjs up && node tools/local/cluster.mjs image &&
//   node --test tools/local/e2e/relay-takeover.e2e.mjs && node --test tools/local/e2e/observability.e2e.mjs
// (example-svc는 relay-takeover가 올린 것을 쓴다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kubectl } from '../cluster.mjs';
import { serviceDashboard } from '../dashboards.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const raw = async (path) => JSON.parse(await kubectl(['get', '--raw', path], { quiet: true }));
const prom = (q) => raw(`/api/v1/namespaces/observability/services/prometheus:9090/proxy/api/v1/query?query=${encodeURIComponent(q)}`);
const grafana = (p) => raw(`/api/v1/namespaces/observability/services/grafana:3000/proxy${p}`);
const value = (r) => Number(r.data.result[0]?.value?.[1] ?? NaN);

async function until(what, cond, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`기다림 한도: ${what}`);
    await sleep(1000);
  }
}

test('NFR-011 kind: Prometheus가 example-svc 관리 포트를 긁고 템플릿 대시보드의 조회 식이 모두 돌며 Grafana가 익명으로 내준다', { timeout: 600_000 }, async () => {
  execFileSync(process.execPath, [join(REPO, 'tools', 'local', 'cluster.mjs'), 'observability'], { stdio: 'inherit' });
  // 수집 대상: 서비스 파드(component=service)가 떠 있다
  await until('수집 대상 up', async () => value(await prom('max(up{app="example-svc", component="service"})')) === 1, 120_000);
  // 요청을 흘려 서비스 템플릿 지표를 만든다(앱 포트, 맞는 경로가 없으면 route=unmatched)
  const pod = (await kubectl(['-n', 'example', 'get', 'pods', '-l', 'app.kubernetes.io/component=service', '-o', 'jsonpath={.items[0].metadata.name}'])).trim();
  await kubectl(['-n', 'example', 'exec', pod, '--', 'node', '-e',
    "(async()=>{for(let i=0;i<50;i++){await fetch('http://127.0.0.1:8080/no-such-route').catch(()=>{})}})()"], { quiet: true });
  await until('요청 지표', async () => value(await prom('sum(http_server_request_duration_seconds_count{service="example-svc"})')) > 0, 60_000);
  // Node 기본 지표는 service 라벨이 없고 수집 대상 라벨 app으로 고른다
  await until('이벤트 루프 지표', async () => (await prom('nodejs_eventloop_lag_p99_seconds{app="example-svc"}')).data.result.length > 0, 60_000);
  // 대시보드의 조회 식이 모두 Prometheus에서 문법 오류 없이 돈다(경로 변수는 전부로)
  const d = serviceDashboard('example-svc');
  const exprs = d.panels.flatMap((p) => p.targets ?? []).map((t) => t.expr.replaceAll('$route', '.*').replaceAll('$__rate_interval', '1m'));
  assert.ok(exprs.length >= 10);
  for (const e of exprs) assert.equal((await prom(e)).status, 'success', e);
  // Grafana: 익명 보기로 대시보드와 데이터 소스가 보인다(관리자 로그인 없이)
  const got = await until('Grafana 대시보드', async () => grafana('/api/dashboards/uid/peaket-svc-example-svc'), 120_000);
  assert.equal(got.dashboard.title, '서비스: example-svc');
  assert.deepEqual(got.dashboard.panels.filter((p) => p.type !== 'row').slice(0, 4).map((p) => p.title), ['지연', '트래픽', '오류', '포화도']);
  const health = await grafana('/api/health');
  assert.equal(health.database, 'ok');
});
