// 월렛 워커 갱신 보류 시험(BAT-170 웨이브 7 T11·T12, docs/frontend.md §5.4 '갱신' ②③④, docs/design/d5-screen-blueprint.md §3.1).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 잠금은 Node 24의 실제 Web Locks(navigator.locks)를 쓴다.
// 한 프로세스의 LockManager를 탭 여럿이 나눠 쓰는 것으로 본다(브라우저도 출처마다 잠금 하나를 나눠 쓴다).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { applyWaitingUpdate, holdQrLock, isUpdateHoldScreen, QR_LOCK_NAME, shouldOfferUpdate } from './update-hold.ts';

/** docs/frontend.md §5.4 '갱신' ②의 잠금 이름 */
const LOCK = 'peaket.wallet.qr';

const releases = [];
const hold = (locks = navigator.locks) => {
  const release = holdQrLock(locks);
  releases.push(release);
  return release;
};
afterEach(async () => {
  for (const r of releases.splice(0)) r();
  // 놓은 잠금이 실제로 풀릴 때까지 한 박자 기다린다
  await new Promise((r) => setTimeout(r, 0));
});

const held = async () => (await navigator.locks.query()).held?.filter((l) => l.name === LOCK) ?? [];
/** waiting 워커 대역: 받은 메시지를 모은다 */
const waitingWorker = () => {
  const sent = [];
  return { sent, worker: { postMessage: (m) => sent.push(m) } };
};
const until = async (cond, ms = 500) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
};

test('HOT-390 QR 잠금 이름은 정본의 peaket.wallet.qr이다', () => {
  assert.equal(QR_LOCK_NAME, LOCK);
});

test('HOT-390 QR 잠금은 공유 모드로 쥐고, 놓는 함수를 부르면 풀린다(Web Locks가 없으면 아무것도 하지 않는다)', async () => {
  const release = hold();
  assert.ok(await until(async () => (await held()).length === 1), '잠금을 쥐지 않았다');
  assert.equal((await held())[0].mode, 'shared');
  release();
  assert.ok(await until(async () => (await held()).length === 0), '놓은 뒤에도 잠금이 남았다');
  // Web Locks 없음(④): 던지지 않고 놓는 함수도 던지지 않는다
  const noop = holdQrLock(undefined);
  assert.equal(typeof noop, 'function');
  noop();
});

test('HOT-390 갱신 보류: waiting 있음·잠금 없음·보류 화면 아님일 때만 토스트', () => {
  const ok = { hasWaiting: true, qrLockHeld: false, pathname: '/events/evt-lumen-1025' };
  assert.equal(shouldOfferUpdate(ok), true);
  // 세 칸을 하나씩 뒤집는다
  assert.equal(shouldOfferUpdate({ ...ok, hasWaiting: false }), false, 'waiting 없음');
  assert.equal(shouldOfferUpdate({ ...ok, qrLockHeld: true }), false, '잠금 있음');
  assert.equal(shouldOfferUpdate({ ...ok, qrLockHeld: null }), false, 'Web Locks 없음(④)');
  for (const pathname of ['/queue/evt-lumen-1025', '/booking/evt-lumen-1025/seats', '/booking/evt-lumen-1025/checkout', '/my/tickets', '/my/tickets/tkt-lumen-r1-0312']) {
    assert.equal(shouldOfferUpdate({ ...ok, pathname }), false, pathname);
  }
  // 보류 화면이 아닌 곳은 모두 띄운다
  for (const pathname of ['/', '/search', '/my/settings', '/my/orders', '/help']) assert.equal(shouldOfferUpdate({ ...ok, pathname }), true, pathname);
});

test('HOT-390 보류 화면은 대기실·좌석·결제·티켓 화면이다', () => {
  for (const p of [
    '/queue/evt-lumen-1025',
    '/shop/gds-lumen-lightstick/queue',
    '/booking/evt-lumen-1025/seats',
    '/booking/evt-lumen-1025/checkout',
    '/booking/evt-lumen-1025/checkout/return',
    '/shop/checkout',
    '/my/tickets',
    '/my/tickets/',
    '/my/tickets/tkt-lumen-r1-0312',
  ]) {
    assert.equal(isUpdateHoldScreen(p), true, p);
  }
  for (const p of ['/', '/events/evt-lumen-1025', '/search', '/my/settings', '/my/orders', '/help', '/shop', '/my/ticketsx', '/policy/privacy']) {
    assert.equal(isUpdateHoldScreen(p), false, p);
  }
});

test('HOT-390 새로고침은 잠금을 다시 보고 비었을 때만 SKIP_WAITING을 보낸다', async () => {
  // 잠금이 비어 있으면 waiting 워커에 정확히 한 번 보낸다
  {
    const { sent, worker } = waitingWorker();
    assert.equal(await applyWaitingUpdate({ registration: { waiting: worker }, locks: navigator.locks }), 'sent');
    assert.deepEqual(sent, [{ type: 'SKIP_WAITING' }]);
  }
  // 토스트를 띄운 뒤(그때는 잠금 없음) 다른 탭이 QR을 열어 잠금이 생겼다 → 보내지 않는다
  {
    const { sent, worker } = waitingWorker();
    assert.equal(shouldOfferUpdate({ hasWaiting: true, qrLockHeld: (await held()).length > 0, pathname: '/' }), true);
    hold();
    assert.ok(await until(async () => (await held()).length === 1));
    assert.equal(await applyWaitingUpdate({ registration: { waiting: worker }, locks: navigator.locks }), 'held');
    assert.deepEqual(sent, []);
  }
  // waiting 없음·등록 없음은 'none'
  assert.equal(await applyWaitingUpdate({ registration: { waiting: null }, locks: navigator.locks }), 'none');
  assert.equal(await applyWaitingUpdate({ registration: undefined, locks: navigator.locks }), 'none');
});

test('HOT-390 잠금을 쥔 탭 둘 가운데 하나가 놓아도 보류한다', async () => {
  const tabA = hold();
  const tabB = hold();
  assert.ok(await until(async () => (await held()).length === 2), '두 탭이 공유 잠금을 함께 쥐지 못했다');
  tabA();
  assert.ok(await until(async () => (await held()).length === 1));
  const { sent, worker } = waitingWorker();
  assert.equal(await applyWaitingUpdate({ registration: { waiting: worker }, locks: navigator.locks }), 'held');
  assert.deepEqual(sent, []);
  // 마지막 탭도 놓으면 보낸다
  tabB();
  assert.ok(await until(async () => (await held()).length === 0));
  assert.equal(await applyWaitingUpdate({ registration: { waiting: worker }, locks: navigator.locks }), 'sent');
  assert.deepEqual(sent, [{ type: 'SKIP_WAITING' }]);
});

// BAT-170 검증 뒤 시험(d02b8d19). 시험 담당(l2w7-BAT170-test)이 썼다.
// V170-34: 정본 docs/frontend.md §5.4 '갱신' ③은 'navigator.locks.query()의 쥔 목록'만 말한다. 막 쥐려는 탭(pending)도 보류로 보는 것은
// 지금 구현의 동작이고 정본이 정하지 않은 경계다(안전한 쪽). 이 시험은 그 동작을 묶는다.
test('HOT-390 V170-34 잠금을 막 쥐려는 탭(pending)이 있어도 SKIP_WAITING을 보내지 않는다', async () => {
  const fakeLocks = (q) => ({ query: async () => q, request: async () => undefined });
  const { sent, worker } = waitingWorker();
  assert.equal(await applyWaitingUpdate({ registration: { waiting: worker }, locks: fakeLocks({ held: [], pending: [{ name: LOCK, mode: 'shared' }] }) }), 'held');
  assert.deepEqual(sent, []);
  // 대조군: 다른 이름의 pending은 보류하지 않는다
  assert.equal(await applyWaitingUpdate({ registration: { waiting: worker }, locks: fakeLocks({ held: [], pending: [{ name: 'other.lock', mode: 'exclusive' }] }) }), 'sent');
  assert.deepEqual(sent, [{ type: 'SKIP_WAITING' }]);
});

// V170-35: 소비자 웹 en 화면은 주소 접두 /en(docs/frontend.md §5.12)이라 보류 화면(docs/design/d5-screen-blueprint.md §3.1)도 접두를 뗀 경로로 본다
test('HOT-390 V170-35 보류 화면 판정은 /en 접두를 떼고 본다', () => {
  for (const p of ['/en/queue/evt-1', '/en/booking/x/seats', '/en/booking/x/checkout', '/en/my/tickets', '/en/my/tickets/tkt-1', '/en/shop/checkout']) assert.equal(isUpdateHoldScreen(p), true, p);
  for (const p of ['/en', '/en/', '/en/events/x', '/en/search', '/enx/queue/evt-1', '/english/my/tickets']) assert.equal(isUpdateHoldScreen(p), false, p);
});
