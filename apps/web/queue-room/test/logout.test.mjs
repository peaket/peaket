// 대기실 로그아웃(docs/frontend.md §5.14.4 2~4번, ADR-0208 결정 7): 서버 응답을 기다리지 않고 저장물을 지우고, 다른 탭에 알리고,
// 같은 출처 POST /logout을 fetch로 보낸다(A′ CSP form-action을 바꾸지 않는다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearForLogout, serverLogout } from '../src/live/logout.ts';
import { memory } from './harness.mjs';

function deps() {
  const local = memory();
  const session = memory();
  for (const k of ['peaket.queue.e1', 'peaket.queue.e2', 'peaket.clock', 'peaket.autoassign.e1', 'peaket.wishQueue', 'peaket.device', 'peaket.recentSearches']) local.setItem(k, 'v');
  for (const k of ['peaket.queue.e1.firstAhead', 'peaket.admission.e1', 'peaket.withdraw.reauth', 'peaket.providers.pending', 'peaket.verify.return', 'peaket.providers.merged']) session.setItem(k, 'v');
  const deleted = [];
  const unregistered = [];
  const cachesDeleted = [];
  const posted = [];
  return {
    d: {
      local,
      session,
      idb: { deleteDatabase: (n) => deleted.push(n) },
      caches: { keys: async () => ['wallet-shell-3', 'other-cache'], delete: async (n) => (cachesDeleted.push(n), true) },
      serviceWorker: {
        getRegistrations: async () => [
          { scope: 'https://www.peaket.example/my/tickets/', unregister: async () => (unregistered.push('wallet'), true) },
          { scope: 'https://www.peaket.example/push/', unregister: async () => (unregistered.push('push'), true) },
        ],
      },
      broadcast: (name, msg) => posted.push([name, msg]),
    },
    local,
    session,
    deleted,
    unregistered,
    cachesDeleted,
    posted,
  };
}

test('[ASVS v5.0.0-14.3.1] SCR-008 로그아웃 정리: 로그아웃 때 지우는 저장물만 지우고(기기 ID·최근 검색어·흡수 표시는 남김), 다른 탭에 logout을 알린다. 월렛은 고를 때만', async () => {
  const x = deps();
  await clearForLogout(x.d, { wallet: false });
  assert.deepEqual(x.local.keys().sort(), ['peaket.device', 'peaket.recentSearches']);
  assert.deepEqual(x.session.keys(), ['peaket.providers.merged']);
  assert.deepEqual(x.deleted.sort(), ['peaket-purchase', 'peaket-push']);
  assert.deepEqual([x.unregistered, x.cachesDeleted], [[], []], '월렛은 기본으로 남긴다');
  assert.deepEqual(x.posted, [['peaket.session', 'logout']]);

  const y = deps();
  await clearForLogout(y.d, { wallet: true });
  assert.ok(y.deleted.includes('peaket-wallet'));
  assert.deepEqual(y.unregistered, ['wallet'], '웹 푸시 서비스 워커(/push/)는 풀지 않는다');
  assert.deepEqual(y.cachesDeleted, ['wallet-shell-3']);
});

test('SCR-008 로그아웃 정리는 저장소를 못 써도(사생활 모드·없음) 멈추지 않는다', async () => {
  await clearForLogout({ local: null, session: null, idb: null, caches: null, serviceWorker: null, broadcast: () => { throw new Error('없음'); } }, { wallet: true });
});

test('SCR-008 서버 로그아웃: 같은 출처 POST를 redirect manual로 보낸다. 이동(opaqueredirect)·2xx면 끝, 503·연결 실패면 다시 시도 안내', async () => {
  const seen = [];
  const f = (res) => async (url, init) => {
    seen.push([url, init.method, init.credentials, init.redirect, init.mode]);
    if (res instanceof Error) throw res;
    return res;
  };
  assert.equal(await serverLogout(f({ type: 'opaqueredirect', status: 0, ok: false }), '/logout'), 'ok');
  assert.deepEqual(seen[0], ['/logout', 'POST', 'same-origin', 'manual', 'same-origin']);
  assert.equal(await serverLogout(f({ type: 'basic', status: 204, ok: true }), '/logout'), 'ok');
  assert.equal(await serverLogout(f({ type: 'basic', status: 503, ok: false }), '/logout'), 'failed');
  assert.equal(await serverLogout(f({ type: 'basic', status: 403, ok: false }), '/logout'), 'failed');
  assert.equal(await serverLogout(f(new TypeError('끊김')), '/logout'), 'failed');
});

// F-05-1(ADR-0363 결정 8, docs/frontend.md §5.14.4): 대기실 루틴과 소비자 웹 루틴은 같은 목록을 쓴다. 같은 저장물을 채운 두 탭에서 두 루틴을 돌려
// 남은 값이 같은지, 새로 더한 peaket.wallet.reauth·peaket.staff.fragment를 지우는지, 월렛 워커 범위 /my/tickets(끝 / 없음, ADR-0363 결정 5)를 푸는지 본다.
test('FE-T47 대기실과 소비자 웹 정리 루틴은 같은 값을 지우고 남기며 월렛 범위 /my/tickets를 풀고 /push/는 남긴다 [ASVS v5.0.0-14.3.1]', async () => {
  const { runLogoutCleanup } = await import('../../src/features/session-cleanup/routine.ts');
  const LOCAL = ['peaket.queue.e1', 'peaket.clock', 'peaket.autoassign.e1', 'peaket.wishQueue', 'peaket.device', 'peaket.recentSearches'];
  const SESSION = ['peaket.admission.e1', 'peaket.withdraw.reauth', 'peaket.providers.pending', 'peaket.devices.reauth', 'peaket.wallet.reauth', 'peaket.verify.return', 'peaket.staff.fragment', 'peaket.hold.e1', 'peaket.checkout.h1', 'peaket.providers.merged'];
  const one = () => {
    const local = memory();
    const session = memory();
    for (const k of LOCAL) local.setItem(k, 'v');
    for (const k of SESSION) session.setItem(k, 'v');
    const log = [];
    return {
      local,
      session,
      log,
      d: {
        local,
        session,
        idb: { deleteDatabase: (n) => log.push(`idb:${n}`) },
        caches: { keys: async () => ['wallet-shell-10', 'other-cache'], delete: async (n) => (log.push(`cache:${n}`), true) },
        serviceWorker: {
          getRegistrations: async () => [
            { scope: 'https://www.peaket.example/my/tickets', unregister: async () => (log.push('unregister:/my/tickets'), true) },
            { scope: 'https://www.peaket.example/push/', unregister: async () => (log.push('unregister:/push/'), true) },
          ],
        },
        broadcast: (name, msg) => log.push(`broadcast:${name}:${msg}`),
        pushUnbind: async () => {
          log.push('push:DELETE');
        },
      },
    };
  };
  const room = one();
  const web = one();
  await clearForLogout(room.d, { wallet: true });
  await runLogoutCleanup(web.d, { wallet: true, server: false });
  assert.deepEqual(room.local.keys().sort(), ['peaket.device', 'peaket.recentSearches']);
  assert.deepEqual(room.session.keys(), ['peaket.providers.merged']);
  assert.deepEqual([room.local.keys().sort(), room.session.keys().sort()], [web.local.keys().sort(), web.session.keys().sort()]);
  assert.deepEqual([...room.log].sort(), [...web.log].sort());
  assert.equal(room.log[0], 'push:DELETE', '대기실도 웹 푸시 해제를 맨 앞에 한다');
  assert.ok(room.log.includes('unregister:/my/tickets'));
  assert.equal(room.log.includes('unregister:/push/'), false);
  assert.deepEqual(room.log.filter((l) => l.startsWith('idb:')).sort(), ['idb:peaket-purchase', 'idb:peaket-push', 'idb:peaket-wallet']);
  assert.deepEqual(room.log.filter((l) => l.startsWith('cache:')), ['cache:wallet-shell-10']);
});
