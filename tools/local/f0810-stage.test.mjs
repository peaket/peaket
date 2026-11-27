// F-08-10 역할별 무대 준비 시험(F0810-8): tools/local/compare-stage.mjs.
// 정본: docs/verification.md §3.8 세 구성 비교(260~284행), 계획 docs/review/plans/F-08-10.md 2절 3·6.1·7.2.
// (가) 한 프로세스 합본과 (나) 역할별 배포의 CPU·메모리 합계가 같은지, 네 역할이 한 번씩인지, (다)를 로컬에서 거부하는지 본다.
// Docker·kind를 쓰지 않는다. 실행: node --test tools/local/f0810-stage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** 새 모듈을 읽고 공개 이름이 있는지 먼저 본다. 기준 트리에서는 모듈이 없어 여기서 실패한다(계획 9절). */
async function stage() {
  let m;
  try {
    m = await import('./compare-stage.mjs');
  } catch (e) {
    assert.fail(`tools/local/compare-stage.mjs를 읽지 못했다: ${e?.message ?? e}`);
  }
  for (const name of ['compareStagePlan', 'assertSameTotals', 'stageUrls', 'stageEnv']) assert.equal(typeof m[name], 'function', `${name} 공개 함수가 없다`);
  for (const name of ['LOCAL_ROLES', 'ROLE_RESOURCES']) assert.ok(m[name], `${name} 공개 상수가 없다`);
  return m;
}

const range = (fn) => assert.throws(fn, (e) => e instanceof RangeError, 'RangeError로 거부해야 한다');

test('F0810-8 ① (가) 합본과 (나) 역할별 배포는 네 역할을 한 번씩 두고 CPU 12·메모리 6GiB 합계가 같다', async () => {
  const { compareStagePlan, assertSameTotals, LOCAL_ROLES, ROLE_RESOURCES } = await stage();
  assert.deepEqual(LOCAL_ROLES, ['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc']);
  for (const role of LOCAL_ROLES) assert.deepEqual(ROLE_RESOURCES[role], { cpu: 1, memoryMi: 512 });

  const bundle = compareStagePlan({ config: 'bundle' });
  assert.equal(bundle.config, 'bundle');
  assert.equal(bundle.mode, 'single');
  assert.equal(bundle.replicas, 3);
  assert.equal(bundle.deployments.length, 1);
  const one = bundle.deployments[0];
  assert.equal(one.name, 'bundle');
  assert.equal(one.replicas, 3);
  assert.equal(one.cpu, 4, '합본 파드 CPU는 네 역할 몫의 합이다');
  assert.equal(one.memoryMi, 2048, '합본 파드 메모리는 네 역할 몫의 합이다');
  assert.deepEqual(one.services, LOCAL_ROLES);
  assert.deepEqual(bundle.totals, { cpu: 12, memoryMi: 6144 });

  const byRole = compareStagePlan({ config: 'by-role' });
  assert.equal(byRole.config, 'by-role');
  assert.equal(byRole.mode, 'single');
  assert.equal(byRole.replicas, 3);
  assert.equal(byRole.deployments.length, 4);
  assert.deepEqual(byRole.deployments.map((d) => d.name), LOCAL_ROLES);
  for (const d of byRole.deployments) {
    assert.equal(d.replicas, 3);
    assert.equal(d.cpu, 1);
    assert.equal(d.memoryMi, 512);
    assert.deepEqual(d.services, [d.name]);
  }
  assert.deepEqual(byRole.totals, { cpu: 12, memoryMi: 6144 });
  assert.doesNotThrow(() => assertSameTotals(bundle, byRole));
});

test('F0810-8 ② services·복제 0·역할 빠짐·모르는 역할·CPU/메모리 0 이하를 거부하고, 다른 합계를 거부한다', async () => {
  const { compareStagePlan, assertSameTotals } = await stage();
  range(() => compareStagePlan({ config: 'services' }));
  range(() => compareStagePlan({ config: 'bundle', replicas: 0 }));
  range(() => compareStagePlan({ config: 'by-role', roles: { 'payment-svc': { cpu: 1, memoryMi: 512 }, 'purchase-svc': { cpu: 1, memoryMi: 512 }, 'admission-ctrl': { cpu: 1, memoryMi: 512 } } }));
  range(() =>
    compareStagePlan({
      config: 'by-role',
      roles: {
        'payment-svc': { cpu: 1, memoryMi: 512 },
        'purchase-svc': { cpu: 1, memoryMi: 512 },
        'admission-ctrl': { cpu: 1, memoryMi: 512 },
        'queue-svc': { cpu: 1, memoryMi: 512 },
        'payment-svc-2': { cpu: 1, memoryMi: 512 },
      },
    }),
  );
  range(() => compareStagePlan({ config: 'bundle', roles: { 'payment-svc': { cpu: 0, memoryMi: 512 }, 'purchase-svc': { cpu: 1, memoryMi: 512 }, 'admission-ctrl': { cpu: 1, memoryMi: 512 }, 'queue-svc': { cpu: 1, memoryMi: 512 } } }));
  range(() => compareStagePlan({ config: 'bundle', roles: { 'payment-svc': { cpu: 1, memoryMi: 0 }, 'purchase-svc': { cpu: 1, memoryMi: 512 }, 'admission-ctrl': { cpu: 1, memoryMi: 512 }, 'queue-svc': { cpu: 1, memoryMi: 512 } } }));
  range(() => assertSameTotals({ totals: { cpu: 12, memoryMi: 6144 } }, { totals: { cpu: 12, memoryMi: 6145 } }));
});

test('F0810-8 ③ 구성별 k6·gRPC 주소와 gRPC 열림: 합본은 bundle·127.0.0.1, 역할별은 서비스 이름·0.0.0.0, services는 거부한다', async () => {
  const { stageUrls, stageEnv } = await stage();
  assert.deepEqual(stageUrls('bundle'), {
    queueUrl: 'http://bundle.v1.svc.cluster.local:8080',
    purchaseUrl: 'http://bundle.v1.svc.cluster.local:8081',
    holdUrl: 'http://bundle.v1.svc.cluster.local:8083',
    paymentGrpc: '127.0.0.1:50051',
  });
  assert.deepEqual(stageUrls('by-role'), {
    queueUrl: 'http://queue-svc.v1.svc.cluster.local:8080',
    purchaseUrl: 'http://purchase-svc.v1.svc.cluster.local:8081',
    holdUrl: 'http://purchase-svc.v1.svc.cluster.local:8083',
    paymentGrpc: 'payment-svc.v1.svc.cluster.local:50051',
  });
  assert.deepEqual(stageEnv('bundle'), { payment: { PEAKET_GRPC_HOST: '127.0.0.1' }, purchase: { PEAKET_PAYMENT_GRPC_ADDR: '127.0.0.1:50051' } });
  assert.deepEqual(stageEnv('by-role'), {
    payment: { PEAKET_GRPC_HOST: '0.0.0.0' },
    purchase: { PEAKET_PAYMENT_GRPC_ADDR: 'payment-svc.v1.svc.cluster.local:50051' },
  });
  range(() => stageUrls('services'));
  range(() => stageEnv('services'));
});
