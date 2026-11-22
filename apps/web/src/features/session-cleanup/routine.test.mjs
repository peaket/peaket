// 소비자 웹 로그아웃 정리 루틴 시험(BUILD_ORDER GAT-040, F-05-1, docs/frontend.md §6 FE-T47·§5.14.4·§3.12, ADR-0363 결정 8, ASVS 14.3.1).
// 지울 값과 남길 값은 정본 §3.12 표의 '지우는 때'와 §5.14.4 2·3번 글에서 적는다(코드의 목록 상수를 가져오지 않는다).
// 바꿔 끼우는 것은 브라우저 경계(탭 저장소 둘·IndexedDB 지우기·Cache Storage·서비스 워커 등록·같은 출처 fetch·웹 푸시 해제)뿐이고 루틴은 진짜다.
// 다른 탭 알림은 node의 진짜 BroadcastChannel로 두 '탭'(같은 프로세스의 두 의존 묶음) 사이에 보낸다.
// 같은 흐름을 실제 core-svc(웹 푸시 해제)에 잇는 연결 시험은 services/core-svc/test-int/web-push-wiring.int.test.ts다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLogoutMessage, onSessionLogout, runLogoutCleanup } from './routine.ts';

const ORIGIN = 'https://www.peaket.example';

/** §3.12에서 지우는 때에 '로그아웃'이 있는 값과 §5.14.4 2번이 더한 값(peaket.staff.fragment·peaket.wallet.reauth, 결제 초안) */
const LOGOUT_LOCAL = ['peaket.queue.evt-f051', 'peaket.clock', 'peaket.autoassign.evt-f051', 'peaket.wishQueue'];
const LOGOUT_SESSION = [
  'peaket.admission.evt-f051',
  'peaket.withdraw.reauth',
  'peaket.providers.pending',
  'peaket.devices.reauth',
  'peaket.wallet.reauth',
  'peaket.verify.return',
  'peaket.staff.fragment',
  'peaket.hold.evt-f051',
  'peaket.checkout.hold-f051',
];
/** 로그아웃해도 남기는 값(기기 식별값·최근 검색어·흡수 표시) */
const KEEP_LOCAL = ['peaket.device', 'peaket.recentSearches'];
const KEEP_SESSION = ['peaket.providers.merged'];
const LOGOUT_DBS = ['peaket-purchase', 'peaket-push'];

/** key(i)·length가 있는 탭 저장소 */
function storage(keys) {
  const m = new Map(keys.map((k) => [k, `v:${k}`]));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

/** 한 탭의 브라우저 경계. log에 바깥으로 나간 일의 차례를 남긴다 */
function tab(log, o = {}) {
  const dbs = new Set(['peaket-purchase', 'peaket-push', 'peaket-wallet']);
  const cacheNames = new Set(['wallet-shell-10', `serwist-precache-v2-${ORIGIN}/`, 'other-app-cache']);
  const regs = new Map([
    [`${ORIGIN}/my/tickets`, true],
    [`${ORIGIN}/push/`, true],
  ]);
  const local = storage([...LOGOUT_LOCAL, ...KEEP_LOCAL]);
  const session = storage([...LOGOUT_SESSION, ...KEEP_SESSION]);
  const deps = {
    local,
    session,
    idb: {
      deleteDatabase: (name) => {
        log.push(`idb:${name}`);
        dbs.delete(name);
      },
    },
    caches: {
      keys: async () => [...cacheNames],
      delete: async (name) => (log.push(`cache:${name}`), cacheNames.delete(name)),
    },
    serviceWorker: {
      getRegistrations: async () => [...regs.keys()].map((scope) => ({ scope, unregister: async () => (log.push(`unregister:${new URL(scope).pathname}`), regs.delete(scope)) })),
    },
    ...(o.broadcast ? { broadcast: o.broadcast } : {}),
    ...(o.pushUnbind ? { pushUnbind: o.pushUnbind } : {}),
    fetch: async (url, init) => {
      log.push(`fetch:${init.method} ${url}:${local.m.size === KEEP_LOCAL.length ? 'cleared' : 'not-cleared'}`);
      if (o.server === 503) return { type: 'basic', status: 503, ok: false };
      if (o.server === 'down') throw new TypeError('Failed to fetch');
      return { type: 'opaqueredirect', status: 0, ok: false };
    },
  };
  return { deps, dbs, cacheNames, regs, local, session };
}

/** 웹 푸시 해제(DELETE) 대역. 결과를 log에 남긴다 */
const pushUnbind = (log, outcome = 'deleted') => async () => {
  log.push('push:DELETE');
  if (outcome === 'throws') throw new Error('503');
  return outcome === 'deleted' ? { kind: 'deleted', status: 204 } : { kind: 'failed' };
};

/** 정리 뒤 공통: 로그아웃 값이 없고 남길 값이 있다 */
function assertLogoutCleared(t, label) {
  assert.deepEqual([...t.local.m.keys()].sort(), [...KEEP_LOCAL].sort(), `${label}: localStorage`);
  assert.deepEqual([...t.session.m.keys()].sort(), [...KEEP_SESSION].sort(), `${label}: sessionStorage`);
  for (const db of LOGOUT_DBS) assert.equal(t.dbs.has(db), false, `${label}: ${db}`);
}

/** 다른 탭(같은 출처 탭 둘): 진짜 BroadcastChannel로 logout을 받으면 2번 저장물을 지우고 로그인 화면으로 간다 */
function otherTab() {
  const log = [];
  const t = tab(log);
  const ch = new BroadcastChannel('peaket.session');
  const done = new Promise((resolve) => {
    ch.onmessage = (e) => {
      if (!isLogoutMessage(e.data)) return;
      void onSessionLogout(t.deps, () => resolve('login'));
    };
  });
  return { t, log, done, close: () => ch.close() };
}
const broadcaster = (log) => (channel, message) => {
  log.push(`broadcast:${channel}:${message}`);
  const ch = new BroadcastChannel(channel);
  ch.postMessage(message);
  ch.close();
};

test('FE-T47 ① 체크 없이 로그아웃하면 로그아웃 값이 지워지고 기기 식별값·최근 검색어·peaket-wallet·월렛 워커·캐시는 남으며 웹 푸시 DELETE가 POST /logout보다 먼저다 [ASVS v5.0.0-14.3.1]', async () => {
  const log = [];
  const t = tab(log, { pushUnbind: pushUnbind(log), broadcast: broadcaster(log) });
  const other = otherTab();
  try {
    const r = await runLogoutCleanup(t.deps, { wallet: false, server: true });
    assert.deepEqual(r, { push: 'done', server: 'ok' });
    assertLogoutCleared(t, '이 탭');
    assert.equal(t.dbs.has('peaket-wallet'), true);
    assert.deepEqual([...t.regs.keys()].sort(), [`${ORIGIN}/my/tickets`, `${ORIGIN}/push/`]);
    assert.equal(t.cacheNames.has('wallet-shell-10'), true);
    // 차례: 웹 푸시 DELETE → 저장물 → 다른 탭 알림 → 서버 로그아웃(저장물은 이미 지웠다)
    const at = (p) => log.findIndex((l) => l.startsWith(p));
    assert.equal(at('push:DELETE'), 0);
    assert.ok(at('idb:peaket-purchase') > at('push:DELETE'));
    assert.ok(at('broadcast:peaket.session:logout') > at('idb:peaket-push'));
    assert.equal(log.at(-1), 'fetch:POST /logout:cleared');
    assert.equal(await other.done, 'login');
    assertLogoutCleared(other.t, '다른 탭');
    assert.equal(other.t.dbs.has('peaket-wallet'), true, '다른 탭은 월렛 키를 지우지 않는다');
    assert.equal(other.log.some((l) => l.startsWith('fetch:') || l === 'push:DELETE'), false, '다른 탭은 서버를 부르지 않는다');
  } finally {
    other.close();
  }
});

test('FE-T47 ② 체크하면 peaket-wallet·월렛 등록·wallet-shell- 캐시가 지워지고 /push/ 등록은 남는다 [ASVS v5.0.0-14.3.1]', async () => {
  const log = [];
  const t = tab(log, { pushUnbind: pushUnbind(log), broadcast: broadcaster(log) });
  const other = otherTab();
  try {
    const r = await runLogoutCleanup(t.deps, { wallet: true, server: true });
    assert.deepEqual(r, { push: 'done', server: 'ok' });
    assertLogoutCleared(t, '이 탭');
    assert.equal(t.dbs.has('peaket-wallet'), false);
    assert.deepEqual([...t.regs.keys()], [`${ORIGIN}/push/`]);
    assert.deepEqual([...t.cacheNames], ['other-app-cache']);
    assert.ok(log.indexOf('push:DELETE') < log.findIndex((l) => l.startsWith('fetch:')));
    // 다른 탭은 3번을 하지 않는다(그 탭이 고르지 않았다)
    await other.done;
    assert.equal(other.t.dbs.has('peaket-wallet'), true);
    assert.equal(other.t.regs.size, 2);
    assert.equal(other.t.cacheNames.has('wallet-shell-10'), true);
  } finally {
    other.close();
  }
});

test('FE-T47 ③ 웹 푸시 해제가 실패(503·던짐)해도 로그아웃은 이어 간다', async () => {
  for (const outcome of ['failed', 'throws']) {
    const log = [];
    const t = tab(log, { pushUnbind: pushUnbind(log, outcome) });
    const r = await runLogoutCleanup(t.deps, { wallet: false, server: true });
    assert.equal(r.server, 'ok', outcome);
    assertLogoutCleared(t, outcome);
    assert.equal(log[0], 'push:DELETE', outcome);
    assert.equal(log.at(-1), 'fetch:POST /logout:cleared', outcome);
  }
});

test('FE-T47 ④ 서버 로그아웃이 503·연결 실패면 다시 시도를 알리고 저장물은 이미 지워졌다', async () => {
  for (const server of [503, 'down']) {
    const log = [];
    const t = tab(log, { pushUnbind: pushUnbind(log), server });
    const r = await runLogoutCleanup(t.deps, { wallet: false, server: true });
    assert.equal(r.server, 'failed', String(server));
    assertLogoutCleared(t, String(server));
    assert.equal(log.at(-1), 'fetch:POST /logout:cleared', String(server));
  }
  // 셸 대화상자가 실패면 대화상자 안에서 다시 시도를 안내한다(홈으로 가지 않는다). 셸은 늦게 싣는 배선 모듈(widgets/app-shell/model/session-wiring.ts)로
  // 이 루틴을 부른다(첫 JS 예산, 커밋 0ed6e470a). 배선의 동작(차례·이동·다시 시도)은 widgets/app-shell/model/session-wiring.test.mjs가 본다.
  // 여기서는 배선이 대화상자의 '이 기기의 입장 키도 지우기'를 3번에 넘기고 서버 로그아웃까지 하는지(부르는 쪽이 결과를 쓰는가)만 본다
  const { readFileSync } = await import('node:fs');
  const wiring = readFileSync(new URL('../../widgets/app-shell/model/session-wiring.ts', import.meta.url), 'utf8');
  assert.match(wiring, /logoutCleanup\(\{ wallet: clearEntryKeys, server: true, pushUnbind: /);
});

test('FE-T47 ⑤ 탈퇴 204·계정 흡수는 대화상자 없이 ①과 같이 지우고 서버 로그아웃은 보내지 않으며 흡수 표시는 남는다', async () => {
  const log = [];
  const t = tab(log, { pushUnbind: pushUnbind(log), broadcast: broadcaster(log) });
  const other = otherTab();
  try {
    const r = await runLogoutCleanup(t.deps, { wallet: false, server: false });
    assert.equal(r.server, 'skipped');
    assertLogoutCleared(t, '탈퇴·흡수');
    assert.equal(t.session.m.has('peaket.providers.merged'), true);
    assert.equal(t.dbs.has('peaket-wallet'), true, '월렛 입장 키는 기본대로 남긴다');
    assert.equal(log.some((l) => l.startsWith('fetch:')), false, '서버 로그아웃을 보냈다');
    assert.equal(await other.done, 'login');
    assertLogoutCleared(other.t, '다른 탭');
  } finally {
    other.close();
  }
  // 부르는 두 자리: 탈퇴 완료(SettingsFlows)·흡수(LiveLoginMethods)는 월렛 키 남김·서버 로그아웃 없음으로 부른다
  const { readFileSync } = await import('node:fs');
  for (const f of ['../../_pages/settings/ui/SettingsFlows.tsx', '../../_pages/settings-providers/ui/LiveLoginMethods.tsx']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.match(src, /logoutCleanup\(\{ wallet: false, server: false/, f);
  }
});
