// F-05-2 SCR-041 양도 받기 실제 흐름 시험(계획 docs/review/plans/F-05-2.md §4 '웹 모듈'·§5 T9·T11·T12·T16).
// 시험 담당(lane2-f052-test)이 구현 전에 썼다(ADR-0372·0381). 대상 모듈 offer-flow.ts는 아직 없다(기준 트리에서 가져오기부터 실패한다).
// 정본: docs/design/d5-screen-blueprint.md §5.23(상태 표: 만료·철회·처리됨·입장 중·권한 없음, 회차 취소·연기 문장)·§9.2(수락 409)·§9.3,
//       docs/features/transfer-refund.md §4·§5·§11 R-T1·R-T17·R-T21 ③, docs/api/openapi.yaml(getTransfer·createTransferAcceptance, TransferOffer.withdrawReason).
// - 바꿔 끼우는 것은 팬 API 경계(주입한 fetch)와 시각(nowMs)뿐이다. 화면 상태 → 안내 띠 표(view.ts offerView)는 진짜이고, 그 글이 d5 문장과 같은지도 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptFailureStateOf, acceptOffer, loadOffer, offerStateOf } from './offer-flow.ts';
import { offerView } from './view.ts';

const API = 'https://api.f052.test';
const PROBLEM = 'https://peaket.example/problems/';
const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const OFFER = '5b1e6f0c-8d2a-4c3e-9f41-0f5205241001';
const KEY = '9e2d4b6f-1a3c-4e5f-8b7d-0f5205241002';
const EXPIRES = NOW + 31 * HOUR;

const offer = (o = {}) => ({ offerId: OFFER, ticketId: '0190f3a1-7c2e-7a00-8000-000000052041', role: 'RECIPIENT', status: 'OFFERED', expiresAt: new Date(EXPIRES).toISOString(), eventId: '0193f2c0-0000-7000-8000-00000052e001', ...o });
const json = (status, body, type = 'application/json') => new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });
const problem = (status, name) => json(status, { type: `${PROBLEM}${name}`, title: '서버 제목', status }, 'application/problem+json');
function fakeApi(...replies) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body === undefined ? undefined : String(init.body), credentials: init.credentials });
    const r = replies[calls.length - 1];
    return r ? r() : json(599, { title: '시험이 준비하지 않은 요청' });
  };
  return { calls, fetch };
}

test('F-05-2 T9 R-T1 ① 수락 기한 경계: 기한 − 1ms는 요청(받기·거절 자리), 기한 0ms·EXPIRED는 기한 만료이고 d5 문구 "기한이 지난 요청입니다"', () => {
  assert.equal(offerStateOf(offer(), EXPIRES - 1), '요청');
  assert.equal(offerView('요청').waiting, true);
  assert.equal(offerStateOf(offer(), EXPIRES), '기한 만료');
  assert.equal(offerStateOf(offer({ status: 'EXPIRED' }), NOW), '기한 만료');
  assert.equal(offerView('기한 만료').waiting, false);
  assert.equal(offerView('기한 만료').banner?.title, '기한이 지난 요청입니다');
  assert.equal(acceptFailureStateOf({ status: 409, type: `${PROBLEM}transfer-expired` }), '기한 만료');
});

test('F-05-2 T16 ① 철회 까닭(withdrawReason)으로 문장을 고른다: 공연 취소·일정 변경·보낸 분 철회, 그 밖·모르는 값은 일반 철회', () => {
  assert.equal(offerStateOf(offer({ status: 'WITHDRAWN', withdrawReason: 'EVENT_CANCELLED' }), NOW), '공연 취소로 철회됨');
  const cancelled = offerView('공연 취소로 철회됨').banner;
  assert.equal(cancelled?.title, '공연이 취소되어 철회된 요청입니다');
  assert.equal(cancelled?.body, '이 요청은 더 이상 받을 수 없습니다. 이 티켓은 결제하신 분(보낸 분)께 전액 환급됩니다. 티켓값을 미리 주고받으셨다면 보낸 분과 직접 정산해 주세요.');
  // 공연 취소 때는 '티켓은 보낸 분에게 그대로 있습니다'를 쓰지 않는다(d5 §5.23)
  assert.equal(cancelled?.body.includes('그대로 있습니다'), false);
  assert.equal(offerStateOf(offer({ status: 'WITHDRAWN', withdrawReason: 'EVENT_POSTPONED' }), NOW), '일정 변경으로 철회됨');
  assert.equal(offerView('일정 변경으로 철회됨').banner?.title, '공연 일정이 바뀌어 철회된 요청입니다');
  assert.equal(offerStateOf(offer({ status: 'WITHDRAWN', withdrawReason: 'SENDER' }), NOW), '철회됨');
  for (const reason of ['OTHER', 'FRAUD_LOCK', 'SOMETHING_NEW', undefined]) {
    const o = reason === undefined ? offer({ status: 'WITHDRAWN' }) : offer({ status: 'WITHDRAWN', withdrawReason: reason });
    assert.equal(offerStateOf(o, NOW), '철회됨', String(reason));
  }
});

test('F-05-2 T16 ② 처리된 요청(ACCEPTED·REJECTED·RECLAIMED)은 처리됨이고 d5 제목 "이미 처리된 요청입니다"', () => {
  for (const status of ['ACCEPTED', 'REJECTED', 'RECLAIMED']) assert.equal(offerStateOf(offer({ status }), NOW), '처리됨', status);
  assert.equal(offerView('처리됨').banner?.title, '이미 처리된 요청입니다');
  assert.equal(offerView('처리됨').banner?.body, '이미 받거나 거절한 요청이라 다시 처리할 수 없습니다. 받은 티켓은 마이 티켓에서 볼 수 있습니다.');
});

test('F-05-2 T11 R-T17 ① 수락 409 entry-started는 입장 시작이고 d5 문구 "입장이 시작되어 지금은 받을 수 없습니다"', () => {
  const st = acceptFailureStateOf({ status: 409, type: `${PROBLEM}entry-started` });
  assert.equal(st, '입장 시작');
  assert.equal(offerView(st).banner?.title, '입장이 시작되어 지금은 받을 수 없습니다');
  assert.equal(offerView(st).waiting, false);
});

test('F-05-2 T16 ③ 수락 실패를 상태로 가른다: 404는 권한 없음, 끝난 표·진행 중 아님은 처리됨, 그 밖은 받기 자리를 지킨다(성공으로 그리지 않는다)', () => {
  assert.equal(acceptFailureStateOf({ status: 404, type: `${PROBLEM}not-found` }), '권한 없음');
  assert.equal(offerView('권한 없음').denied, true);
  assert.equal(acceptFailureStateOf({ status: 409, type: `${PROBLEM}transfer-not-offered` }), '처리됨');
  assert.equal(acceptFailureStateOf({ status: 409, type: `${PROBLEM}ticket-ended` }), '처리됨');
  for (const p of [
    { status: 503, type: 'dependency-unavailable' },
    { status: 500, type: 'about:blank' },
    { status: 409, type: 'idempotency-request-in-progress' },
  ]) {
    const st = acceptFailureStateOf(p);
    assert.notEqual(st, '수락 완료', `${p.status} ${p.type}`);
  }
});

test('F-05-2 T12 R-T21 ③ [ASVS v5.0.0-3.3.2] 요청 읽기와 수락은 화면 스크립트가 팬 API로 쿠키를 실어 보내는 같은 사이트 요청이다', async () => {
  const api = fakeApi(
    () => json(200, offer()),
    () => json(200, offer({ status: 'ACCEPTED' })),
  );
  const o = { origin: API, fetch: api.fetch };
  assert.deepEqual(await loadOffer({ offerId: OFFER, ...o }), { kind: 'ok', body: offer() });
  assert.deepEqual(await acceptOffer({ offerId: OFFER, idempotencyKey: KEY, ...o }), { kind: 'ok', body: offer({ status: 'ACCEPTED' }) });
  const [read, accept] = api.calls;
  assert.deepEqual([read.method, read.url, read.credentials], ['GET', `${API}/v1/transfers/${OFFER}`, 'include']);
  assert.deepEqual([accept.method, accept.url, accept.credentials], ['POST', `${API}/v1/transfers/${OFFER}/acceptance`, 'include']);
  assert.equal(accept.headers['idempotency-key'], KEY);
  assert.equal(accept.headers['x-reauth-token'], undefined);
});

test('F-05-2 T16 ④ 장애 주입: 수락 응답을 잃으면 network이고, 같은 키로 다시 보내면 서버 재생 200이며 문제 응답은 problem으로 돌려준다', async () => {
  const api = fakeApi(
    () => {
      throw new TypeError('fetch failed');
    },
    () => json(200, offer({ status: 'ACCEPTED' })),
    () => problem(409, 'entry-started'),
    () => problem(404, 'not-found'),
  );
  const o = { origin: API, fetch: api.fetch };
  assert.deepEqual(await acceptOffer({ offerId: OFFER, idempotencyKey: KEY, ...o }), { kind: 'network' });
  assert.deepEqual(await acceptOffer({ offerId: OFFER, idempotencyKey: KEY, ...o }), { kind: 'ok', body: offer({ status: 'ACCEPTED' }) });
  assert.deepEqual(api.calls.map((c) => c.headers['idempotency-key']), [KEY, KEY]);
  assert.deepEqual(await acceptOffer({ offerId: OFFER, idempotencyKey: KEY, ...o }), { kind: 'problem', status: 409, type: 'entry-started' });
  assert.deepEqual(await loadOffer({ offerId: OFFER, ...o }), { kind: 'problem', status: 404, type: 'not-found' });
});
