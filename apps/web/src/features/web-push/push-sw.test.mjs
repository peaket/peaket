// 웹 푸시 전용 워커 처리기 시험(BUILD_ORDER GAT-040, F-05-1, docs/frontend.md §6 FE-T48 ⑤·§5.4, docs/features/notify.md §3.4·§3.5, ADR-0363 결정 7).
// 워커 전역(ServiceWorkerGlobalScope)의 일부를 이벤트 대역으로 바꿔 installPushWorker를 싣고 push·notificationclick·pushsubscriptionchange를 보낸다.
// 기본 문구·허용한 앞부분은 정본(notify §3.5) 글에서 적는다. 처리기 코드(worker.ts)는 진짜다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { installPushWorker } from './worker.ts';

const ORIGIN = 'https://www.peaket.example';
/** notify §3.5: 풀지 못하면 "피켓 알림이 도착했습니다" */
const FALLBACK_TITLE = '피켓 알림이 도착했습니다';

/** 워커 전역 대역. 붙은 처리기와 부른 API를 기록한다 */
function scope() {
  const listeners = new Map();
  const shown = [];
  const opened = [];
  const pendingWrites = [];
  let skipped = 0;
  const s = {
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    skipWaiting: async () => {
      skipped += 1;
    },
    registration: {
      showNotification: async (title, o) => {
        shown.push({ title, ...o });
      },
      pushManager: { subscribe: async () => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/f051-resub', expirationTime: null, keys: { p256dh: 'BAA', auth: 'AAA' } }) }) },
    },
    clients: { openWindow: async (url) => (opened.push(url), null) },
    location: { origin: ORIGIN },
  };
  const pending = { read: async () => undefined, write: async (p) => pendingWrites.push(p), clear: async () => {} };
  installPushWorker(s, { pending, now: () => 1_763_900_123_456 });
  /** 처리기를 부르고 waitUntil에 넘긴 약속을 기다린다 */
  const fire = async (type, event) => {
    const waits = [];
    for (const fn of listeners.get(type) ?? []) fn({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { listeners, shown, opened, pendingWrites, fire, skipped: () => skipped };
}

const data = (v) => ({ json: () => (typeof v === 'string' ? JSON.parse(v) : v) });

test('FE-T48 ⑤ 풀 수 없는 푸시도 showNotification을 한 번 부른다(기본 문구), 정상 푸시는 그 제목·본문·주소로 한 번', async () => {
  for (const [label, d] of [
    ['본문 없음', null],
    ['JSON이 아님', { json: () => { throw new SyntaxError('bad'); } }],
    ['제목 없음', data({ body: '본문만' })],
    ['빈 제목', data({ title: '', body: 'x' })],
  ]) {
    const w = scope();
    await w.fire('push', { data: d });
    assert.equal(w.shown.length, 1, label);
    assert.equal(w.shown[0].title, FALLBACK_TITLE, label);
  }
  const w = scope();
  await w.fire('push', { data: data({ v: 1, kind: 'DEVICE_KEY_REISSUED', title: '티켓 입장 키를 새 휴대폰에 등록했습니다', body: '본문', url: '/my/tickets/tkt-f051', tag: 't1' }) });
  assert.equal(w.shown.length, 1);
  assert.deepEqual(w.shown[0], { title: '티켓 입장 키를 새 휴대폰에 등록했습니다', body: '본문', data: { url: '/my/tickets/tkt-f051' }, tag: 't1' });
});

test('FE-T48 ⑤ 알림을 누르면 허용한 앞부분(/events/·/productions/·/my/·/queue/·/help/)만 그 주소를 열고 밖은 홈을 연다', async () => {
  const inside = ['/events/evt-1', '/productions/p-1', '/my/tickets/tkt-1', '/queue/evt-1', '/help/faq'];
  const outside = ['/admin', '/', '/login?next=/my', 'https://evil.example/my/x', '//evil.example/my/x', '/\\evil.example', 'javascript:alert(1)', '/mypage', undefined, 42];
  for (const url of [...inside, ...outside]) {
    const w = scope();
    let closed = 0;
    await w.fire('notificationclick', { notification: { data: { url }, close: () => (closed += 1) } });
    assert.equal(closed, 1, String(url));
    assert.deepEqual(w.opened, [inside.includes(url) ? `${ORIGIN}${url}` : `${ORIGIN}/`], String(url));
  }
});

test('FE-T48 ⑤ 구독을 바꾸면(pushsubscriptionchange) peaket-push에 pending이 생기고 직접 등록하지 않는다', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => ((fetched += 1), new Response(null, { status: 599 }));
  try {
    const w = scope();
    const next = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/f051-changed', expirationTime: null, keys: { p256dh: 'BPk', auth: 'q1w' } }) };
    await w.fire('pushsubscriptionchange', { newSubscription: next, oldSubscription: null });
    assert.deepEqual(w.pendingWrites, [{ endpoint: 'https://fcm.googleapis.com/fcm/send/f051-changed', keys: { p256dh: 'BPk', auth: 'q1w' }, expirationTime: null, at: 1_763_900_123_456 }]);
    // 새 구독이 없으면 옛 구독의 설정으로 다시 구독해 적는다
    const w2 = scope();
    await w2.fire('pushsubscriptionchange', { newSubscription: null, oldSubscription: { options: { userVisibleOnly: true } } });
    assert.equal(w2.pendingWrites.length, 1);
    assert.equal(w2.pendingWrites[0].endpoint, 'https://fcm.googleapis.com/fcm/send/f051-resub');
    assert.equal(fetched, 0, '워커가 직접 등록했다');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FE-T48 ⑤ 웹 푸시 워커에는 fetch 처리기가 없고 처리기는 push·notificationclick·pushsubscriptionchange(와 설치)뿐이다', async () => {
  const w = scope();
  assert.deepEqual([...w.listeners.keys()].sort(), ['install', 'notificationclick', 'push', 'pushsubscriptionchange']);
  await w.fire('install', {});
  assert.equal(w.skipped(), 1);
  // 묶는 원본(app/push-sw.ts)도 처리기를 더하지 않는다
  const entry = readFileSync(new URL('../../../app/push-sw.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(entry, /addEventListener|caches\./);
  assert.match(entry, /installPushWorker\(self/);
});
