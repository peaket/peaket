// 로컬·CI kind 덧씌우기(tools/local/gateway-objects.mjs localGatewayObjects)의 프록시 CPU 요청 시험(묶음 BAT-058 계획 docs/review/plans/BAT-058.md §7의 WL1~WL3, HOT-405, V-T43 ①).
// 정본: docs/infra.md §4.1 '프록시 일꾼 수와 파드 CPU' 끝(덧씌우기는 CPU 요청만 100m으로 낮추고 일꾼 수·메모리 요청은 그대로 둔다), ADR-0287 결정 4
// (CPU 한도를 새로 두지 않는다), ADR-0287 맥락(Envoy Gateway v1.10.0은 resources가 비었을 때만 기본 요청을 채우고, resources를 적으면 기본값이 통째로 바뀐다).
// 시험 값(100m, 일꾼 2, CPU 요청 2·메모리 512Mi)은 코드 상수(LOCAL_PROXY_CPU_REQUEST 등)를 가져오지 않고 정본 값을 적는다.
// 손으로 만든 입력은 운영 값과 다르게 고른다(일꾼 3, CPU 3, 메모리 768Mi): 덧씌우기가 상수 2로 덮는 결함이 숨지 않게.
// 실행(저장소 뿌리): node --test "tools/local/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localGatewayObjects, readGatewayObjects } from './gateway-objects.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATEWAY_DIR = join(REPO, 'deploy', 'gateways');

// ---- 정본 값 ----
/** 로컬·CI kind의 envoy 컨테이너 CPU 요청(ADR-0287 결정 4) */
const LOCAL_CPU = '100m';
/** 정의의 일꾼 수·CPU 요청·메모리 요청(docs/infra.md §4.1 '프록시 일꾼 수와 파드 CPU') */
const WORKERS = 2;
const CPU_REQUEST = '2';
const MEMORY_REQUEST = '512Mi';
const ENVOY_PROXIES = ['peaket-proxy', 'peaket-proxy-queue'];

const container = (p) => p?.spec?.provider?.kubernetes?.envoyDeployment?.container;
const resources = (p) => container(p)?.resources;
const envoyProxies = (objects) => objects.filter((o) => o.kind === 'EnvoyProxy');
/** 손으로 만든 EnvoyProxy(이름·spec 일부) */
const handProxy = (name, spec) => ({ apiVersion: 'gateway.envoyproxy.io/v1alpha1', kind: 'EnvoyProxy', metadata: { name, namespace: 'envoy-gateway-system' }, spec });

test('V-T43 ① HOT-405 WL1 저장소 정의를 덧씌우면 EnvoyProxy 둘 모두 CPU 요청만 100m이고 일꾼 수 2·메모리 요청 512Mi·한도 없음, 입력은 그대로다', () => {
  const defs = readGatewayObjects(GATEWAY_DIR);
  const before = JSON.stringify(defs);
  const out = localGatewayObjects(defs);
  for (const name of ENVOY_PROXIES) {
    const src = envoyProxies(defs).find((p) => p.metadata?.name === name);
    assert.ok(src, `deploy/gateways에 EnvoyProxy ${name}이 없다`);
    // 시험 바탕: 정의는 정본 값(덧씌우기 전)
    assert.equal(resources(src)?.requests?.cpu, CPU_REQUEST, `${name}: 정의의 CPU 요청`);
    const p = envoyProxies(out).find((x) => x.metadata?.name === name);
    assert.ok(p, `덧씌운 결과에 EnvoyProxy ${name}이 없다`);
    const res = resources(p);
    assert.equal(res?.requests?.cpu, LOCAL_CPU, `${name}: 덧씌운 CPU 요청 ${JSON.stringify(res?.requests?.cpu)}(다섯 파드 × CPU 2는 vCPU 4 러너에 들어가지 않는다)`);
    assert.equal(res?.requests?.memory, MEMORY_REQUEST, `${name}: 메모리 요청 ${JSON.stringify(res?.requests?.memory)}`);
    assert.equal(p.spec?.concurrency, WORKERS, `${name}: 일꾼 수 ${JSON.stringify(p.spec?.concurrency)}`);
    assert.equal(res?.limits, undefined, `${name}: 한도가 생겼다 ${JSON.stringify(res?.limits)}`);
    // 입력 객체는 바꾸지 않는다
    assert.equal(resources(src)?.requests?.cpu, CPU_REQUEST, `${name}: 입력 객체의 CPU 요청을 바꿨다`);
  }
  assert.equal(JSON.stringify(defs), before, '입력 객체 목록을 바꿨다');
});

test('V-T43 ① HOT-405 WL2 손으로 만든 EnvoyProxy(일꾼 3, CPU 3, 메모리 768Mi)는 일꾼 3·메모리 768Mi 그대로이고 CPU 요청만 100m이다', () => {
  const input = [
    handProxy('wl2-proxy', {
      concurrency: 3,
      provider: { type: 'Kubernetes', kubernetes: { envoyDeployment: { container: { resources: { requests: { cpu: '3', memory: '768Mi' } } } } } },
    }),
  ];
  const before = JSON.stringify(input);
  const [p] = envoyProxies(localGatewayObjects(input));
  assert.ok(p, '덧씌운 결과에 EnvoyProxy가 없다');
  assert.equal(p.spec?.concurrency, 3, `일꾼 수를 바꿨다(${JSON.stringify(p.spec?.concurrency)}): 입력 값 3 그대로여야 한다`);
  assert.deepEqual(resources(p), { requests: { cpu: LOCAL_CPU, memory: '768Mi' } }, `자원 칸 ${JSON.stringify(resources(p))}`);
  assert.equal(JSON.stringify(input), before, '입력 객체를 바꿨다');
});

test('V-T43 ① HOT-405 WL3 자원 칸·일꾼 수가 없는 EnvoyProxy에는 한도·일꾼 수·자원 칸을 지어 넣지 않는다', () => {
  const input = [handProxy('wl3-proxy', { provider: { type: 'Kubernetes', kubernetes: { envoyDeployment: { container: { env: [{ name: 'X', value: 'y' }] } } } } })];
  const [p] = envoyProxies(localGatewayObjects(input));
  assert.ok(p, '덧씌운 결과에 EnvoyProxy가 없다');
  assert.equal(Object.hasOwn(p.spec ?? {}, 'concurrency'), false, `일꾼 수 칸을 새로 만들었다(${JSON.stringify(p.spec?.concurrency)})`);
  const res = resources(p);
  assert.equal(res?.limits, undefined, `CPU 한도를 새로 만들었다 ${JSON.stringify(res)}`);
  // resources를 적으면 Envoy Gateway 기본 요청(CPU 100m·메모리 512Mi)이 통째로 바뀌어 메모리 요청이 빠진다(ADR-0287 맥락). 없던 칸은 그대로 없어야 한다
  assert.equal(res, undefined, `없던 resources를 새로 만들었다 ${JSON.stringify(res)}`);
  assert.deepEqual(container(p)?.env, [{ name: 'X', value: 'y' }], '다른 칸을 바꿨다');
  // spec 자체가 거의 빈 EnvoyProxy도 같다
  const [q] = envoyProxies(localGatewayObjects([handProxy('wl3-empty', {})]));
  assert.equal(Object.hasOwn(q.spec ?? {}, 'concurrency'), false, '빈 EnvoyProxy에 일꾼 수 칸을 만들었다');
  assert.equal(resources(q), undefined, `빈 EnvoyProxy에 resources를 만들었다 ${JSON.stringify(resources(q))}`);
});
