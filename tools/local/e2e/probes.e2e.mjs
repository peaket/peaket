// D-T19 ③④의 kind 부분(docs/devops.md D-T19, docs/architecture.md §5 '프로브 규칙', ADR-0070 결정 2, ADR-0303, BUILD_ORDER BAS-080).
// example-svc 복제 2에 테스트 전용 ConfigMap의 막기 스크립트를 NODE_OPTIONS=--import로 넣어 이벤트 루프를 2,000ms씩 4,000ms [가정] 간격으로 막는다.
// ③ 공용 차트 값(준비 /ready 5초·시간 초과 3초·연속 6회)에서는 120초 [가정] 동안 준비 아님 끝점 0번, 재시작 0(판정).
// ④ 같은 무대에서 준비 프로브를 쿠버네티스 기본값(10초·1초·3회)으로 바꿔 120초 동안 빠진 횟수·처음 시각을 적는다(측정, 판정 아님).
//    결과는 docs/review/measurements 폴더의 새 파일 BAT-075-probes.md에 한 줄씩 더한다.
// 구현 전 차트(준비 2초·2회)로 ③이 실패하는 것을 보려면 PEAKET_E2E_READINESS=5,2,2로 돌린다(차트를 고치지 않고 배포 뒤 패치한다).
// 실행(저장소 뿌리): node tools/local/cluster.mjs up && node tools/local/cluster.mjs image && node --test --test-timeout=900000 tools/local/e2e/probes.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE, KUBECONFIG, kubectl } from '../cluster.mjs';
import { ensureTool } from '../tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const NS = 'probes-e2e';
const SERVICE = 'example-svc';
const WINDOW_MS = 120_000;
const BLOCK_MS = 2_000;
const EVERY_MS = 4_000;
const MEASUREMENTS = join(REPO, 'docs', 'review', 'measurements', 'BAT-075-probes.md');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 이벤트 루프를 BLOCK_MS 동안 바쁘게 막는다(동기 반복). 첫 막기는 시작 프로브가 끝난 뒤(30초)부터
const BLOCK_SCRIPT = `setTimeout(() => setInterval(() => { const end = Date.now() + ${BLOCK_MS}; while (Date.now() < end) {} }, ${EVERY_MS}).unref(), 30000).unref();\n`;

async function install() {
  const helm = await ensureTool('helm');
  execFileSync(helm, ['--kubeconfig', KUBECONFIG, 'uninstall', 'probes', '-n', NS, '--wait', '--ignore-not-found'], { stdio: 'inherit' });
  await kubectl(['create', 'namespace', NS]).catch(() => {});
  await kubectl(['-n', NS, 'delete', 'configmap', 'event-loop-block', '--ignore-not-found']);
  await kubectl(['-n', NS, 'create', 'configmap', 'event-loop-block', `--from-literal=block.mjs=${BLOCK_SCRIPT}`]);
  const [repo, tag] = IMAGE.split(':');
  execFileSync(
    helm,
    [
      '--kubeconfig', KUBECONFIG, 'upgrade', '--install', 'probes', join(REPO, 'deploy', 'charts', 'peaket-service'),
      '-n', NS, '--wait', '--timeout', '300s',
      '--set', `name=${SERVICE}`, '--set', `image.repository=${repo}`, '--set', `image.tag=${tag}`, '--set', 'image.pullPolicy=Never',
      '--set', 'env.PEAKET_ENV=local', '--set', 'service.replicas=2',
      '--set', 'service.env.PEAKET_DATABASE_URL=postgres://postgres:peaket-local@postgres.peaket-local.svc:5432/peaket',
      '--set', 'service.env.NODE_OPTIONS=--import=/etc/peaket/block/block.mjs',
      '--set', 'service.volumes[0].name=block', '--set', 'service.volumes[0].configMap.name=event-loop-block',
      '--set', 'service.volumeMounts[0].name=block', '--set', 'service.volumeMounts[0].mountPath=/etc/peaket/block', '--set', 'service.volumeMounts[0].readOnly=true',
    ],
    { stdio: 'inherit' },
  );
}

/** 준비 프로브를 바꿔 다시 굴린다(값: 주기·시간 초과·연속 실패) */
async function patchReadiness([period, timeout, failure]) {
  const patch = [
    { op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/periodSeconds', value: period },
    { op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/timeoutSeconds', value: timeout },
    { op: 'replace', path: '/spec/template/spec/containers/0/readinessProbe/failureThreshold', value: failure },
  ];
  await kubectl(['-n', NS, 'patch', 'deployment', SERVICE, '--type=json', '-p', JSON.stringify(patch)]);
  await kubectl(['-n', NS, 'rollout', 'status', `deploy/${SERVICE}`, '--timeout=300s']);
}

const readinessOf = async () => JSON.parse(await kubectl(['-n', NS, 'get', 'deploy', SERVICE, '-o', 'json'])).spec.template.spec.containers[0].readinessProbe;

/** WINDOW_MS 동안 1초마다 EndpointSlice의 준비 아님 끝점과 재시작 수를 센다 */
async function watch() {
  const pods = async () => JSON.parse(await kubectl(['-n', NS, 'get', 'pods', '-l', 'app.kubernetes.io/component=service', '-o', 'json'])).items.filter((p) => !p.metadata.deletionTimestamp);
  const restartSum = async () => (await pods()).reduce((n, p) => n + (p.status.containerStatuses?.[0]?.restartCount ?? 0), 0);
  const restarts0 = await restartSum();
  const started = Date.now();
  let notReady = 0;
  let firstAt;
  while (Date.now() - started < WINDOW_MS) {
    const slices = JSON.parse(await kubectl(['-n', NS, 'get', 'endpointslices', '-l', `kubernetes.io/service-name=${SERVICE}`, '-o', 'json'], { quiet: true }));
    const out = slices.items.flatMap((s) => s.endpoints ?? []).filter((e) => e.conditions?.ready === false).length;
    if (out > 0) {
      notReady += 1;
      firstAt ??= Date.now() - started;
    }
    await sleep(1_000);
  }
  return { notReady, firstAtMs: firstAt, restarts: (await restartSum()) - restarts0 };
}

function record(line) {
  mkdirSync(dirname(MEASUREMENTS), { recursive: true });
  if (!existsSync(MEASUREMENTS)) {
    appendFileSync(
      MEASUREMENTS,
      '# BAT-075 준비 프로브 값과 이벤트 루프 막기(D-T19 ③④)\n\n- **무엇**: tools/local/e2e/probes.e2e.mjs가 로컬 kind에서 잰 값이다. 검토 기록이고 규범이 아니다(정본은 docs/architecture.md §5 \'프로브 규칙\').\n\n| 날짜 | 준비 프로브(주기·시간 초과·연속) | 막기 | 창 | 준비 아님 관측 수(1초마다) | 처음 시각(ms) | 재시작 |\n| --- | --- | --- | --- | --- | --- | --- |\n',
    );
  }
  appendFileSync(MEASUREMENTS, `${line}\n`);
}

test('D-T19 ③_kind_이벤트루프를2초씩막아도_공용차트의준비프로브5·3·6에서는_Service에서빠지는파드0·재시작0이다', { timeout: 900_000 }, async () => {
  await install();
  const want = (process.env.PEAKET_E2E_READINESS ?? '').split(',').filter(Boolean).map(Number);
  if (want.length === 3) await patchReadiness(want);
  const p = await readinessOf();
  const r = await watch();
  record(`| ${new Date().toISOString().slice(0, 10)} | ${p.periodSeconds}·${p.timeoutSeconds}·${p.failureThreshold} | ${BLOCK_MS}ms/${EVERY_MS}ms | ${WINDOW_MS / 1000}초 | ${r.notReady} | ${r.firstAtMs ?? '—'} | ${r.restarts} |`);
  assert.deepEqual({ period: p.periodSeconds, timeout: p.timeoutSeconds, failure: p.failureThreshold }, want.length === 3 ? { period: want[0], timeout: want[1], failure: want[2] } : { period: 5, timeout: 3, failure: 6 });
  assert.equal(r.notReady, 0, `준비 아님 관측 ${r.notReady}번(처음 ${r.firstAtMs}ms)`);
  assert.equal(r.restarts, 0);
});

test('D-T19 ④_kind_같은무대를쿠버네티스기본값10·1·3으로돌려_빠진횟수·처음시각을적는다(측정)', { timeout: 900_000 }, async () => {
  await patchReadiness([10, 1, 3]);
  const r = await watch();
  const before = existsSync(MEASUREMENTS);
  record(`| ${new Date().toISOString().slice(0, 10)} | 10·1·3(쿠버네티스 기본값) | ${BLOCK_MS}ms/${EVERY_MS}ms | ${WINDOW_MS / 1000}초 | ${r.notReady} | ${r.firstAtMs ?? '—'} | ${r.restarts} |`);
  assert.ok(before || existsSync(MEASUREMENTS), '결과 줄이 써졌다');
  const helm = await ensureTool('helm');
  execFileSync(helm, ['--kubeconfig', KUBECONFIG, 'uninstall', 'probes', '-n', NS, '--wait', '--ignore-not-found'], { stdio: 'inherit' });
});
