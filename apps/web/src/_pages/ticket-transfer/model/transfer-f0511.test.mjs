// F-05-11 SCR-014 휴대폰 찾기·보낸 분 닉네임·잠금 화면 시험(계획 docs/review/plans/F-05-11.md §4·§5 T13~T15).
// 시험 담당이 구현 전에 썼다(ADR-0372·0381). 휴대폰 갈래·닉네임·소명 링크는 아직 없다(기준 트리에서 실패한다).
// 정본: docs/features/transfer-refund.md §4(휴대폰·닉네임), docs/design/d5 §5.14(잠김·소명 보기)·§5.23(보낸 분 닉네임), docs/frontend.md §4.2.4,
//       docs/api/openapi.yaml createTransferRecipientLookup(phoneNumber·memberCode), TransferOffer.counterpartNickname, Ticket.receivedFromNickname.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lookupRecipient, transferFailureOf, transferStateOf } from './transfer-flow.ts';

const API = 'https://api.f0511.test';
const PROBLEM = 'https://peaket.example/problems/';
const NOW = Date.parse('2026-11-23T01:00:00.000Z');
/** 실행부·목업·흐름 모듈을 합쳐 읽는다(문구·경로가 어느 파일에 있어도 본다) */
const readAll = (...files) => files.map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, name) => json(status, { type: `${PROBLEM}${name}`, title: '서버 제목', status });
function fakeApi(...replies) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()), body: init.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const r = replies[calls.length - 1];
    return r ? r() : json(599, { title: '시험이 준비하지 않은 요청' });
  };
  return { calls, fetch };
}

test('F-05-11 T13 ① 휴대폰 번호 갈래는 본문에 phoneNumber만 싣고, 입력 값은 주소·저장소에 두지 않는다', async () => {
  const api = fakeApi(() => json(200, { recipientRef: 'ref', nicknameMasked: '지*' }));
  const r = await lookupRecipient({ phoneNumber: '010-9371-2468', origin: API, fetch: api.fetch });
  assert.equal(r.kind, 'ok');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].method, 'POST');
  assert.equal(api.calls[0].url, `${API}/v1/transfer-recipient-lookups`);
  assert.deepEqual(api.calls[0].body, { phoneNumber: '010-9371-2468' });
  assert.equal(api.calls[0].url.includes('9371'), false);
});

test('F-05-11 T13 ② 회원 코드 갈래는 그대로이고, 휴대폰 400·404·429 문구를 d5 상태로 가른다', async () => {
  const code = fakeApi(() => json(200, { recipientRef: 'ref', nicknameMasked: '지*' }));
  await lookupRecipient({ memberCode: 'QZ7-4K2M', origin: API, fetch: code.fetch });
  assert.deepEqual(code.calls[0].body, { memberCode: 'QZ7-4K2M' });

  assert.equal(transferFailureOf('lookup', { status: 400, type: 'invalid-body' }).state, '받는 사람 확인');
  assert.equal(transferFailureOf('lookup', { status: 404, type: 'recipient-not-found' }).state, '비회원·본인확인 전');
  const limited = transferFailureOf('lookup', { status: 429, type: 'transfer-lookup-limited' });
  assert.equal(limited.state, '확인 시도 초과');
  assert.equal(limited.relookup, false);
});

test('F-05-11 T13 ③ 실제 실행부: 상대 닉네임(counterpartNickname)을 글자로만 그리고, 없으면 회원으로 둔다', () => {
  const src = readAll('../../transfer-offer/ui/TransferOfferLive.tsx', '../../transfer-offer/ui/TransferOfferPage.tsx', '../../transfer-offer/model/offer-flow.ts');
  assert.ok(src.includes('counterpartNickname'), '상대 닉네임을 읽지 않는다');
  assert.ok(src.includes('회원'), '닉네임이 없을 때의 대체 값이 없다');
  // 원문 닉네임을 따로 받는 칸은 계약에 없다(가린 값만 온다)
  assert.equal(src.includes('counterpartyNicknameRaw'), false);
});

test('F-05-11 T14 R-T31 ①~⑦ 잠금 화면: 기한 −1ms는 잠김·0ms는 풀림이고 받은 표에는 잠금이 없다', () => {
  const t = (o = {}) => ({ ticketId: 't', eventId: 'e', status: 'ACTIVE', transferable: true, transferLocked: false, transferLockExpiresAt: null, receivedFromNickname: null, pendingTransfer: null, ...o });
  const expires = new Date(NOW + 3_600_000).toISOString();
  assert.equal(transferStateOf(t({ transferLocked: true, transferLockExpiresAt: expires }), Date.parse(expires) - 1), '부정 예매 조사로 잠김');
  assert.equal(transferStateOf(t({ transferLocked: true, transferLockExpiresAt: expires }), Date.parse(expires)), '받는 사람 확인');
  assert.equal(transferStateOf(t({ transferLocked: true, transferLockExpiresAt: null }), NOW), '부정 예매 조사로 잠김');
  // 받은 표는 잠금 칸이 있어도 받은 티켓 상태가 먼저다(§4.1: 받은 사람에게 잠금 표시를 하지 않는다)
  assert.equal(transferStateOf(t({ receivedFromNickname: '지*', transferLocked: true, transferLockExpiresAt: expires }), NOW), '양도 불가 · 받은 티켓');
  const src = readAll('../ui/TicketTransferLive.tsx', '../ui/TicketTransferPage.tsx', './transfer-flow.ts', './view.ts');
  assert.ok(src.includes('/my/appeals'), '소명 보기(SCR-042) 링크가 없다');
  assert.ok(src.includes('부정 예매 조사가 끝날 때까지'), 'd5 §5.14 잠금 문구가 없다');
});

test('F-05-11 T15 받은 표 카드가 receivedFromNickname을 보이고, 없으면 회원이다', () => {
  const src = readAll('../../../widgets/ticket-wallet/ui/WalletLive.tsx', '../../../widgets/ticket-wallet/model/transfer-actions.ts', '../../../widgets/ticket-wallet/model/wallet.ts');
  assert.ok(src.includes('receivedFromNickname'), '받은 분 닉네임을 읽지 않는다');
  assert.ok(src.includes('회원'), '닉네임이 없을 때의 대체 값이 없다');
});
