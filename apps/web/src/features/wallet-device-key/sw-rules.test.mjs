// 월렛 서비스 워커 규칙 시험(BAT-170 웨이브 7 T7, docs/frontend.md §5.4 '서비스 워커'·'갱신' ①⑤, docs/security/asvs/frontend.md 14.3.2).
// 시험 담당(l2w7-BAT170-test)이 구현 전에 썼다(ADR-0270 결정 3). 단언 값은 정본의 글을 옮겨 적었고 코드 상수를 가져오지 않는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNetworkOnlyPath, isSkipWaitingMessage, isWalletDocumentPath, rejectNoStore } from './sw-rules.ts';

test('[ASVS v5.0.0-14.3.2] 페이지 이동 캐시는 /my/tickets와 /my/tickets/{id}만이고 양도·취소·부가 상품은 뺀다', () => {
  // 두 꼴(끝 `/`는 같은 주소로 본다)
  for (const p of ['/my/tickets', '/my/tickets/', '/my/tickets/tkt-lumen-r1-0312', '/my/tickets/tkt-lumen-r1-0312/']) {
    assert.equal(isWalletDocumentPath(p), true, p);
  }
  // 그 밖의 /my/tickets/…(양도·취소·부가 상품)와 접두만 같은 주소는 모두 네트워크로만
  for (const p of [
    '/my/tickets/tkt-lumen-r1-0312/transfer',
    '/my/tickets/tkt-lumen-r1-0313/cancel',
    '/my/tickets/tkt-lumen-r1-0312/addons',
    '/my/tickets/tkt-lumen-r1-0312/transfer/',
    '/my/ticketsx',
    '/my/tickets-old',
    '/my',
    '/my/orders',
    '/',
    '/en/my/tickets/tkt-lumen-r1-0312/transfer',
  ]) {
    assert.equal(isWalletDocumentPath(p), false, p);
  }
});

test('[ASVS v5.0.0-14.3.2] no-store 응답은 캐시에 넣지 않는다(no-store가 다른 지시어 사이에 있어도)', async () => {
  const will = (cc) => {
    const response = new Response('<p>티켓</p>', { status: 200, headers: cc === undefined ? {} : { 'cache-control': cc } });
    return { response, result: rejectNoStore.cacheWillUpdate({ request: new Request('https://www.peaket.example/my/tickets'), response, event: undefined, state: undefined }) };
  };
  for (const cc of ['no-store', 'private, no-store, max-age=0', 'max-age=0,no-store', 'No-Store', 'private,  no-store']) {
    const { result } = will(cc);
    assert.equal(await result, null, cc);
  }
  // no-store가 없으면 그 응답을 그대로 돌려준다(같은 객체)
  for (const cc of [undefined, 'no-cache', 'private, max-age=60', 'public, s-maxage=300']) {
    const { response, result } = will(cc);
    assert.equal(await result, response, String(cc));
  }
});

test('HOT-390 SKIP_WAITING 메시지만 활성화를 부른다', () => {
  assert.equal(isSkipWaitingMessage({ type: 'SKIP_WAITING' }), true);
  for (const m of [undefined, null, 'SKIP_WAITING', {}, { type: 'skip_waiting' }, { type: 'SKIP_WAITING_NOW' }, { type: ['SKIP_WAITING'] }, { kind: 'SKIP_WAITING' }, 1, true]) {
    assert.equal(isSkipWaitingMessage(m), false, JSON.stringify(m) ?? String(m));
  }
});

test('HOT-390 API(/v1/)와 워커 자신(/serwist/)은 네트워크로만 받는다', () => {
  for (const p of ['/v1/', '/v1/tickets/me', '/serwist/sw.js', '/serwist/']) assert.equal(isNetworkOnlyPath(p), true, p);
  for (const p of ['/v10/tickets', '/v1', '/serwistx/sw.js', '/my/tickets', '/', '/_next/static/chunks/a.js']) assert.equal(isNetworkOnlyPath(p), false, p);
});
