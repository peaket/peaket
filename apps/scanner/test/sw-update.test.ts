// F-05-10 새 앱 판 적용 시점·서비스 워커 메시지 경계 시험(계획 docs/review/plans/F-05-10.md §3·§5).
// 정본: docs/features/offline-gate.md §6.2 '앱 갱신'(새 판은 근무 준비 때만, minAppVersion보다 낮으면 시작을 막고 목록을 다시 받는다),
// docs/devops.md §6.6, ASVS offline-gate v5.0.0-3.5.5(같은 출처 자기 작업자의 정해진 모양 메시지만).
// 새 모듈은 동적으로 읽어 '함수가 없다' 단언에서 떨어진다. 시계는 쓰지 않는다(순수 함수).
import assert from 'node:assert/strict';
import { test } from 'node:test';

type GateModule = {
  appVersionGate(i: { appVersion: string; minAppVersion?: string }): { allowed: true } | { allowed: false; reason: 'UPDATE_REQUIRED'; required: string };
  shouldApplyUpdate(i: { phase: 'prep' | 'entry'; waiting: boolean; activeScans?: number }): boolean;
  packageRefetchAfterUpdate(i: { applied: boolean }): boolean;
};
type ProtocolModule = {
  parseServiceWorkerMessage(data: unknown): { type: string; accepted?: number } | undefined;
  isTrustedClientMessage(
    i: { origin?: string; source?: { url?: string } | null; data: unknown },
    o: { origin: string },
  ): boolean;
};

const GATE = '../src/sw/update-gate.ts';
const PROTOCOL = '../src/sw/protocol.ts';
const gateLoaded = (await import(GATE).catch(() => ({}))) as Partial<GateModule>;
const protocolLoaded = (await import(PROTOCOL).catch(() => ({}))) as Partial<ProtocolModule>;
function gate(): GateModule {
  for (const name of ['appVersionGate', 'shouldApplyUpdate', 'packageRefetchAfterUpdate'] as const) {
    assert.equal(typeof gateLoaded[name], 'function', `${GATE}의 ${name}가 없다`);
  }
  return gateLoaded as GateModule;
}
function protocol(): ProtocolModule {
  for (const name of ['parseServiceWorkerMessage', 'isTrustedClientMessage'] as const) {
    assert.equal(typeof protocolLoaded[name], 'function', `${PROTOCOL}의 ${name}가 없다`);
  }
  return protocolLoaded as ProtocolModule;
}

test('GAT-140 C1-15 새 앱 판은 근무 준비 때만 적용하고 입장 중에는 미룬다', () => {
  const g = gate();
  assert.equal(g.shouldApplyUpdate({ phase: 'entry', waiting: true }), false, '입장 중에는 적용하지 않는다');
  assert.equal(g.shouldApplyUpdate({ phase: 'prep', waiting: false }), false, '대기 중인 새 판이 없으면 보내지 않는다');
  assert.equal(g.shouldApplyUpdate({ phase: 'prep', waiting: true }), true, '근무 준비 중 대기 판은 적용한다');
  assert.equal(g.shouldApplyUpdate({ phase: 'prep', waiting: true, activeScans: 1 }), false, '스캔이 도는 중에는 적용하지 않는다');
  assert.equal(g.shouldApplyUpdate({ phase: 'entry', waiting: false }), false);
});

test('GAT-140 C1-15 앱 판이 최소 지원 판보다 낮으면 스캔 시작을 막고 새 판 적용 뒤 목록을 다시 받는다', () => {
  const g = gate();
  assert.deepEqual(g.appVersionGate({ appVersion: '1.3.2', minAppVersion: '1.4.0' }), {
    allowed: false,
    reason: 'UPDATE_REQUIRED',
    required: '1.4.0',
  });
  assert.deepEqual(g.appVersionGate({ appVersion: '1.4.0', minAppVersion: '1.4.0' }), { allowed: true });
  assert.deepEqual(g.appVersionGate({ appVersion: '1.4.1', minAppVersion: '1.4.0' }), { allowed: true });
  // 숫자 자리 비교: 1.10.0은 1.9.9보다 뒤다(글자 비교로는 앞이라 틀린다)
  assert.deepEqual(g.appVersionGate({ appVersion: '1.10.0', minAppVersion: '1.9.9' }), { allowed: true });
  assert.deepEqual(g.appVersionGate({ appVersion: '1.9.9', minAppVersion: '1.10.0' }), {
    allowed: false,
    reason: 'UPDATE_REQUIRED',
    required: '1.10.0',
  });
  assert.deepEqual(g.appVersionGate({ appVersion: '1.3.2' }), { allowed: true });
  assert.deepEqual(g.appVersionGate({ appVersion: '1.3.2', minAppVersion: '' }), { allowed: true });
  // 최소 판을 읽을 수 없으면 현장을 세우지 않는다(막지 않는다)
  assert.deepEqual(g.appVersionGate({ appVersion: '1.3.2', minAppVersion: 'not-a-version' }), { allowed: true });

  assert.equal(g.packageRefetchAfterUpdate({ applied: true }), true);
  assert.equal(g.packageRefetchAfterUpdate({ applied: false }), false);
});

test('[ASVS v5.0.0-3.5.5] 서비스 워커는 같은 출처 창의 정해진 모양 메시지만 받는다', () => {
  const p = protocol();
  const origin = 'https://scanner.peaket.example';
  const same = { origin, source: { url: `${origin}/scan?live=1` }, data: { type: 'SKIP_WAITING' } };
  assert.equal(p.isTrustedClientMessage(same, { origin }), true);

  assert.equal(p.isTrustedClientMessage({ ...same, origin: 'https://evil.example' }, { origin }), false, '이벤트 출처가 다르다');
  assert.equal(p.isTrustedClientMessage({ ...same, source: { url: 'https://evil.example/scan' } }, { origin }), false, '창 출처가 다르다');
  assert.equal(p.isTrustedClientMessage({ ...same, source: null }, { origin }), false, '창이 없다');
  assert.equal(p.isTrustedClientMessage({ ...same, source: { url: 'not a url' } }, { origin }), false, '창 주소를 읽을 수 없다');

  assert.deepEqual(p.parseServiceWorkerMessage({ type: 'SKIP_WAITING' }), { type: 'SKIP_WAITING' });
  assert.deepEqual(p.parseServiceWorkerMessage({ type: 'BACKGROUND_UPLOAD_DONE', accepted: 3 }), {
    type: 'BACKGROUND_UPLOAD_DONE',
    accepted: 3,
  });
  assert.equal(p.parseServiceWorkerMessage({ type: 'BACKGROUND_UPLOAD_DONE', accepted: -1 }), undefined);
  assert.equal(p.parseServiceWorkerMessage({ type: 'BACKGROUND_UPLOAD_DONE', accepted: '3' }), undefined);
  assert.equal(p.parseServiceWorkerMessage({ type: 'RUN_SCRIPT', code: 'x' }), undefined, '모르는 종류는 버린다');
  assert.equal(p.parseServiceWorkerMessage({ type: 'skip_waiting' }), undefined, '값의 대소문자도 맞아야 한다');
  assert.equal(p.parseServiceWorkerMessage('SKIP_WAITING'), undefined);
  assert.equal(p.parseServiceWorkerMessage(null), undefined);
  assert.equal(p.parseServiceWorkerMessage([]), undefined);
});
