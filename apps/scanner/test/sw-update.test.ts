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
  parseServiceWorkerWorkerMessage(data: unknown): { type: string; accepted?: number; resyncRequired?: boolean; stopped?: string } | undefined;
  isTrustedClientMessage(
    i: { origin?: string; source?: { url?: string } | null; data: unknown },
    o: { origin: string },
  ): boolean;
};
type RegisterModule = {
  registerServiceWorker(o: { container?: unknown; url?: string; scope?: string }): Promise<{ registered: boolean; registration?: unknown; error?: unknown }>;
  cacheAppShell(o: { caches?: unknown; cacheName?: string; shell?: readonly string[]; assets?: readonly string[] }): Promise<{ cached: number; failed: boolean }>;
  cleanupCaches(o: { caches?: unknown; keep?: string }): Promise<{ removed: number }>;
  applyWaitingUpdate(o: {
    registration?: {
      waiting?: { postMessage(m: unknown): void } | null;
      addEventListener?(type: 'controllerchange', fn: () => void): void;
    };
    phase: 'prep' | 'entry';
    activeScans?: number;
    post?: (m: { type: 'SKIP_WAITING' }) => void;
    onApplied?: () => void;
  }): boolean;
};
type ServiceWorkerModule = {
  createServiceWorkerHandler(deps: {
    origin: string;
    skipWaiting(): void;
    claim?(): void;
    upload?(): Promise<{ accepted: number; resyncRequired?: boolean; stopped?: 'device-revoked' | 'device-unregistered' }>;
    caches?: unknown;
    fetch?: typeof fetch;
    clients?: { matchAll(): Promise<{ postMessage(message: unknown): void }[]> };
  }): {
    onMessage(event: { origin?: string; source?: { url?: string } | null; data: unknown }): Promise<void>;
    onFetch?(event: { request: { method: string; url: string; mode?: string } }): Promise<Response | undefined>;
    onSync?(event: { tag?: string }): Promise<void>;
  };
};

const GATE = '../src/sw/update-gate.ts';
const PROTOCOL = '../src/sw/protocol.ts';
const REGISTER = '../src/sw/register.ts';
const SERVICE_WORKER = '../src/sw/service-worker.ts';
const gateLoaded = (await import(GATE).catch(() => ({}))) as Partial<GateModule>;
const protocolLoaded = (await import(PROTOCOL).catch(() => ({}))) as Partial<ProtocolModule>;
const registerLoaded = (await import(REGISTER).catch(() => ({}))) as Partial<RegisterModule>;
const swLoaded = (await import(SERVICE_WORKER).catch(() => ({}))) as Partial<ServiceWorkerModule>;
function gate(): GateModule {
  for (const name of ['appVersionGate', 'shouldApplyUpdate', 'packageRefetchAfterUpdate'] as const) {
    assert.equal(typeof gateLoaded[name], 'function', `${GATE}의 ${name}가 없다`);
  }
  return gateLoaded as GateModule;
}
function protocol(): ProtocolModule {
  for (const name of ['parseServiceWorkerMessage', 'parseServiceWorkerWorkerMessage', 'isTrustedClientMessage'] as const) {
    assert.equal(typeof protocolLoaded[name], 'function', `${PROTOCOL}의 ${name}가 없다`);
  }
  return protocolLoaded as ProtocolModule;
}
function register(): RegisterModule {
  for (const name of ['registerServiceWorker', 'cacheAppShell', 'cleanupCaches', 'applyWaitingUpdate'] as const) {
    assert.equal(typeof registerLoaded[name], 'function', `${REGISTER}의 ${name}가 없다`);
  }
  return registerLoaded as RegisterModule;
}
function sw(): ServiceWorkerModule {
  assert.equal(typeof swLoaded.createServiceWorkerHandler, 'function', `${SERVICE_WORKER}의 createServiceWorkerHandler가 없다`);
  return swLoaded as ServiceWorkerModule;
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

  // 서비스 워커 → 창 알림(IR-06): 정해진 모양만 받는다
  assert.deepEqual(p.parseServiceWorkerWorkerMessage({ type: 'BACKGROUND_UPLOAD_DONE', accepted: 2, resyncRequired: true }), {
    type: 'BACKGROUND_UPLOAD_DONE',
    accepted: 2,
    resyncRequired: true,
  });
  assert.deepEqual(p.parseServiceWorkerWorkerMessage({ type: 'BACKGROUND_UPLOAD_DONE', accepted: 0, stopped: 'device-revoked' }), {
    type: 'BACKGROUND_UPLOAD_DONE',
    accepted: 0,
    stopped: 'device-revoked',
  });
  assert.equal(p.parseServiceWorkerWorkerMessage({ type: 'BACKGROUND_UPLOAD_DONE', accepted: -1 }), undefined);
  assert.equal(p.parseServiceWorkerWorkerMessage({ type: 'RUN', code: 'x' }), undefined);
});

test('GAT-140 C1-15 서비스 워커 등록·앱 셸 캐시·적용 시점·적용 뒤 목록 재수신을 시험한다', async () => {
  const r = register();
  const origin = 'https://scanner.peaket.example';

  // 등록: /sw.js를 범위 /로 등록하고, 실패해도 앱을 막지 않는다
  const calls: { url: string; scope?: string }[] = [];
  const ok = await r.registerServiceWorker({
    container: {
      register: async (url: string, opts?: { scope?: string }) => {
        calls.push({ url, ...(opts?.scope ? { scope: opts.scope } : {}) });
        return { waiting: null, active: {} };
      },
    },
    url: '/sw.js',
    scope: '/',
  });
  assert.equal(ok.registered, true);
  assert.deepEqual(calls, [{ url: '/sw.js', scope: '/' }]);

  const failed = await r.registerServiceWorker({
    container: {
      register: async () => {
        throw new Error('등록 거부');
      },
    },
    url: '/sw.js',
    scope: '/',
  });
  assert.equal(failed.registered, false, '등록 실패는 던지지 않는다');
  assert.equal(failed.error instanceof Error, true);

  // 설치 캐시: 앱 셸을 캐시에 넣고, 실패는 failed로 알린다(앱은 온라인으로 계속)
  const added: string[][] = [];
  const cacheOk = await r.cacheAppShell({
    caches: { open: async () => ({ addAll: async (urls: string[]) => void added.push(urls) }) },
    cacheName: 'peaket-scanner-v1',
    shell: ['/', '/index.html', '/manifest.webmanifest'],
  });
  assert.deepEqual(cacheOk, { cached: 3, failed: false });
  assert.deepEqual(added, [['/', '/index.html', '/manifest.webmanifest']]);
  const cacheFailed = await r.cacheAppShell({
    caches: { open: async () => ({ addAll: async () => Promise.reject(new Error('저장소 없음')) }) },
    shell: ['/'],
  });
  assert.deepEqual(cacheFailed, { cached: 0, failed: true });

  // 적용: 입장 중에는 보내지 않고, 근무 준비에서만 SKIP_WAITING을 보낸다. controllerchange 뒤 onApplied 한 번
  const posted: unknown[] = [];
  const listeners: (() => void)[] = [];
  const registration = {
    waiting: { postMessage: (m: unknown) => void posted.push(m) },
    addEventListener: (type: string, fn: () => void) => {
      if (type === 'controllerchange') listeners.push(fn);
    },
  };
  let applied = 0;
  assert.equal(r.applyWaitingUpdate({ registration, phase: 'entry', post: (m) => void posted.push(m), onApplied: () => (applied += 1) }), false);
  assert.deepEqual(posted, []);
  assert.equal(r.applyWaitingUpdate({ registration, phase: 'prep', post: (m) => void posted.push(m), onApplied: () => (applied += 1) }), true);
  assert.deepEqual(posted, [{ type: 'SKIP_WAITING' }]);
  for (const fn of listeners) fn();
  assert.equal(applied, 1, 'controllerchange 뒤 목록을 다시 받는 고리가 한 번 돈다');
  assert.equal(r.applyWaitingUpdate({ registration, phase: 'prep', activeScans: 1, post: (m) => void posted.push(m) }), false, '스캔 중에는 적용하지 않는다');
});

test('GAT-140 IR-04 앱 셸의 해시 자산·Worker·wasm을 캐시하고 fetch 처리기로 꺼내며 옛 캐시를 지운다', async () => {
  const r = register();
  const added: string[][] = [];
  const assets = ['/assets/index-abc.js', '/assets/index-abc.css', '/assets/scan.worker-def.js', '/assets/zxing_reader-ghi.wasm'];
  const cacheOk = await r.cacheAppShell({
    caches: { open: async () => ({ addAll: async (urls: string[]) => void added.push(urls) }) },
    cacheName: 'peaket-scanner-v2',
    shell: ['/', '/index.html'],
    assets,
  });
  assert.deepEqual(cacheOk, { cached: 6, failed: false });
  assert.deepEqual(added[0], ['/', '/index.html', ...assets]);

  const removed: string[] = [];
  const cleanup = await r.cleanupCaches({
    caches: {
      keys: async () => ['peaket-scanner-v1', 'peaket-scanner-v2', 'other'],
      delete: async (k: string) => {
        removed.push(k);
        return true;
      },
    },
    keep: 'peaket-scanner-v2',
  });
  assert.deepEqual(cleanup, { removed: 1 });
  assert.deepEqual(removed, ['peaket-scanner-v1']);

  const cached = new Response('cached', { status: 200 });
  let fetched = 0;
  const handler = sw().createServiceWorkerHandler({
    origin: 'https://scanner.peaket.example',
    skipWaiting: () => undefined,
    caches: {
      match: async (request: unknown) => (String((request as { url?: string }).url ?? request).includes('index-abc') ? cached : undefined),
      open: async () => ({ addAll: async () => undefined }),
    },
    fetch: (async () => {
      fetched += 1;
      return new Response('network', { status: 200 });
    }) as typeof fetch,
  });
  assert.equal(typeof handler.onFetch, 'function', '서비스 워커 fetch 처리기가 없다');
  const got = await handler.onFetch!({ request: { method: 'GET', url: 'https://scanner.peaket.example/assets/index-abc.js', mode: 'cors' } });
  assert.equal(await got?.text(), 'cached');
  assert.equal(fetched, 0, '캐시에 있으면 네트워크를 부르지 않는다');
  const miss = await handler.onFetch!({ request: { method: 'GET', url: 'https://scanner.peaket.example/assets/miss.js', mode: 'cors' } });
  assert.equal(await miss?.text(), 'network');
  assert.equal(fetched, 1);
});

test('GAT-140 IR-04 서비스 워커 fetch 처리기는 API·비GET 요청을 가로채지 않는다', async () => {
  const cached = new Response('cached', { status: 200 });
  const handler = sw().createServiceWorkerHandler({
    origin: 'https://scanner.peaket.example',
    skipWaiting: () => undefined,
    caches: { match: async () => cached, open: async () => ({ addAll: async () => undefined }) },
  });
  assert.equal(await handler.onFetch?.({ request: { method: 'POST', url: 'https://scanner.peaket.example/scan', mode: 'cors' } }), undefined);
  assert.equal(await handler.onFetch?.({ request: { method: 'GET', url: 'https://scanner-api.peaket.example/v1/scanner/shift', mode: 'cors' } }), undefined);
});

test('GAT-140 IR-06 서비스 워커 sync 처리기는 업로드 결과를 창에 알린다', async () => {
  const posted: unknown[] = [];
  let uploads = 0;
  const handler = sw().createServiceWorkerHandler({
    origin: 'https://scanner.peaket.example',
    skipWaiting: () => undefined,
    upload: async () => {
      uploads += 1;
      return { accepted: 2, resyncRequired: true, stopped: 'device-revoked' as const };
    },
    clients: { matchAll: async () => [{ postMessage: (m: unknown) => void posted.push(m) }] },
  });
  assert.equal(typeof handler.onSync, 'function', '서비스 워커 sync 처리기가 없다');
  await handler.onSync!({ tag: 'peaket-scanner-scans' });
  assert.equal(uploads, 1);
  assert.deepEqual(posted, [{ type: 'BACKGROUND_UPLOAD_DONE', accepted: 2, resyncRequired: true, stopped: 'device-revoked' }]);
  await handler.onSync!({ tag: 'other' });
  assert.equal(uploads, 1, '다른 태그는 업로드하지 않는다');
});

test('[ASVS v5.0.0-3.5.5] 서비스 워커 처리기는 같은 출처의 정해진 메시지만 실제로 실행한다', async () => {
  const s = sw();
  const origin = 'https://scanner.peaket.example';
  let skipped = 0;
  let claimed = 0;
  let uploaded = 0;
  const handler = s.createServiceWorkerHandler({
    origin,
    skipWaiting: () => (skipped += 1),
    claim: () => (claimed += 1),
    upload: async () => {
      uploaded += 1;
      return { accepted: 1 };
    },
  });
  const same = { origin, source: { url: `${origin}/setup` }, data: { type: 'SKIP_WAITING' } };
  await handler.onMessage(same);
  assert.equal(skipped, 1, '같은 출처의 SKIP_WAITING은 실행한다');
  await handler.onMessage({ origin: 'https://evil.example', source: { url: 'https://evil.example/setup' }, data: { type: 'SKIP_WAITING' } });
  await handler.onMessage({ origin, source: null, data: { type: 'SKIP_WAITING' } });
  await handler.onMessage({ origin, source: { url: `${origin}/setup` }, data: { type: 'RUN_SCRIPT', code: 'x' } });
  await handler.onMessage({ origin, source: { url: `${origin}/setup` }, data: 'SKIP_WAITING' });
  assert.equal(skipped, 1, '다른 출처·창 없음·모르는 모양은 실행하지 않는다');
  assert.equal(claimed, 0);
  assert.equal(uploaded, 0);
});
