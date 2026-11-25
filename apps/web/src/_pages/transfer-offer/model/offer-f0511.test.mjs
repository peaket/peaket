// F-05-11 SCR-041 [거절] 화면 시험(계획 docs/review/plans/F-05-11.md §4·§5 T12).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). rejectOffer·rejectFailureStateOf는 아직 없다(기준 트리에서 가져오기부터 실패한다).
// 정본: docs/design/d5-screen-blueprint.md §5.23(③ 받기·거절, 처리됨 제목·본문)·§9.2, docs/features/transfer-refund.md §4·§11 R-T21 ①②,
//       docs/api/openapi.yaml createTransferRejection(Idempotency-Key 필수), docs/api/guidelines.md §4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { offerStateOf, rejectFailureStateOf, rejectOffer } from './offer-flow.ts';
import { offerView } from './view.ts';

const API = 'https://api.f0511.test';
const PROBLEM = 'https://peaket.example/problems/';
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const OFFER = '5b1e6f0c-8d2a-4c3e-9f41-0f51110001';
const KEY = '9e2d4b6f-1a3c-4e5f-8b7d-0f51110002';
const EXPIRES = NOW + 31 * 3_600_000;
/** 실행부·목업·흐름 모듈을 합쳐 읽는다(문구·경로가 어느 파일에 있어도 본다) */
const readAll = (...files) => files.map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');

const offer = (o = {}) => ({ offerId: OFFER, ticketId: '0190f3a1-7c2e-7a00-8000-000000511041', role: 'RECIPIENT', status: 'OFFERED', expiresAt: new Date(EXPIRES).toISOString(), eventId: '0193f2c0-0000-7000-8000-000000511e01', ...o });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, name) => json(status, { type: `${PROBLEM}${name}`, title: '서버 제목', status });
function fakeApi(...replies) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), credentials: init.credentials });
    const r = replies[calls.length - 1];
    return r ? r() : json(599, { title: '시험이 준비하지 않은 요청' });
  };
  return { calls, fetch };
}

test('F-05-11 T12 ① 거절은 POST …/rejection에 Idempotency-Key를 실어 보내고 200이면 REJECTED를 준다', async () => {
  const api = fakeApi(() => json(200, offer({ status: 'REJECTED' })));
  const r = await rejectOffer({ offerId: OFFER, idempotencyKey: KEY, origin: API, fetch: api.fetch });
  assert.equal(r.kind, 'ok');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, 'POST');
  assert.equal(api.calls[0].url, `${API}/v1/transfers/${OFFER}/rejection`);
  assert.equal(api.calls[0].headers['idempotency-key'], KEY);
  assert.equal(api.calls[0].credentials, 'include');
  assert.equal(r.body.status, 'REJECTED');
});

test('F-05-11 T12 ② 거절 실패를 d5 상태로 가른다: 처리됨·기한 만료·입장 시작·권한 없음, 모르는 실패는 요청 자리', () => {
  assert.equal(rejectFailureStateOf({ status: 409, type: `${PROBLEM}transfer-not-offered` }), '처리됨');
  assert.equal(rejectFailureStateOf({ status: 409, type: 'transfer-not-offered' }), '처리됨');
  assert.equal(rejectFailureStateOf({ status: 409, type: `${PROBLEM}transfer-expired` }), '기한 만료');
  assert.equal(rejectFailureStateOf({ status: 409, type: `${PROBLEM}entry-started` }), '입장 시작');
  assert.equal(rejectFailureStateOf({ status: 404, type: `${PROBLEM}not-found` }), '권한 없음');
  assert.equal(rejectFailureStateOf({ status: 503, type: `${PROBLEM}dependency-unavailable` }), '요청');
  assert.equal(rejectFailureStateOf({ status: 0, type: 'network' }), '요청');
});

test('F-05-11 T12 ③ 거절한 요청은 처리됨이고 d5 §5.23 제목·본문을 보인다(받기·거절 버튼 없음)', () => {
  assert.equal(offerStateOf(offer({ status: 'REJECTED' }), NOW), '처리됨');
  assert.equal(offerView('처리됨').banner?.title, '이미 처리된 요청입니다');
  assert.equal(offerView('처리됨').banner?.body, '이미 받거나 거절한 요청이라 다시 처리할 수 없습니다. 받은 티켓은 마이 티켓에서 볼 수 있습니다');
  assert.equal(offerView('처리됨').waiting, false);
});

test('F-05-11 T12 ④ 실제 실행부: 고지 세 문장이 [받기]·[거절]보다 앞이고 거절 호출이 있다(응답을 잃으면 같은 키로 다시 보낸다)', () => {
  const src = readAll('../ui/TransferOfferLive.tsx', '../ui/TransferOfferPage.tsx', './offer-flow.ts');
  const flow = readAll('./offer-flow.ts');
  const notice1 = src.indexOf('이 티켓은 결제한 사람만 취소할 수 있고');
  const accept = src.indexOf('받기');
  const reject = src.indexOf('거절');
  assert.ok(notice1 >= 0, '첫 고지 문장이 실행부에 없다');
  assert.ok(notice1 < accept, '고지가 받기보다 뒤에 있다');
  assert.ok(notice1 < reject, '고지가 거절보다 뒤에 있다');
  assert.ok(src.includes('rejection'), '거절 경로를 부르지 않는다');
  assert.ok(/reject/i.test(src), '거절 흐름 이름이 없다');
  assert.ok(flow.includes('idempotencyKey'), '멱등 키를 다루지 않는다');
});
