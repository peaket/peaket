// 양도 도메인 규칙 시험(BUILD_ORDER GAT-050·GAT-055, docs/features/transfer-refund.md §3.1·§4·§4.1).
// 시험 이름에 장부 ID와 세부 번호를 단다(§8.6 7). 저장소·HTTP 없이 순수 판정만 본다.
import { describe, expect, it } from 'vitest';
import {
  acceptRejectionOf,
  createOfferRejectionOf,
  marketCloseAtMs,
  offerExpiryMs,
  rejectRejectionOf,
  returnRejectionOf,
  signRecipientRef,
  verifyRecipientRef,
  withdrawRejectionOf,
  type TransferOfferRecord,
  type TransferTicketSnapshot,
} from '../src/modules/ticket/domain/transfer.js';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const ticket = (o: Partial<TransferTicketSnapshot> = {}): TransferTicketSnapshot => ({
  ticketId: '0193f2c0-0000-7000-8000-000000000001',
  accountId: '0193f2c0-0000-7000-8000-0000000000a1',
  payerAccountId: '0193f2c0-0000-7000-8000-0000000000a1',
  eventId: '0193f2c0-0000-7000-8000-0000000000e1',
  status: 'ACTIVE',
  transferPending: false,
  eventStartsAtMs: NOW + 72 * HOUR,
  ...o,
});

const offer = (o: Partial<TransferOfferRecord> = {}): TransferOfferRecord => ({
  offerId: '0193f2c0-0000-7000-8000-0000000000f1',
  ticketId: ticket().ticketId,
  fromAccountId: ticket().payerAccountId,
  toAccountId: '0193f2c0-0000-7000-8000-0000000000b2',
  status: 'OFFERED',
  expiresAtMs: NOW + 48 * HOUR,
  createdAtMs: NOW,
  ...o,
});

describe('양도 마감·기한', () => {
  it('R-T1 양도 요청 뒤 48시간 경과 — 기한은 48시간과 양도 마감 가운데 이른 때다', () => {
    expect(offerExpiryMs(NOW, NOW + 72 * HOUR)).toBe(NOW + 48 * HOUR);
    // 양도 마감(공연 시작 2시간 전)이 48시간보다 이르면 그때 만료된다
    expect(offerExpiryMs(NOW, NOW + 10 * HOUR)).toBe(NOW + 10 * HOUR);
    expect(offerExpiryMs(NOW, undefined)).toBe(NOW + 48 * HOUR);
    expect(marketCloseAtMs(NOW + 5 * HOUR)).toBe(NOW + 3 * HOUR);
    expect(marketCloseAtMs(undefined)).toBeUndefined();
  });
});

describe('양도 요청 만들기', () => {
  it('R-T2 받은 사람이 다른 회원에게 양도 시도 — 보유자 ≠ 결제자는 409(재양도 금지)', () => {
    const t = ticket({ accountId: '0193f2c0-0000-7000-8000-0000000000b2' });
    expect(createOfferRejectionOf(t, { callerAccountId: t.accountId, nowMs: NOW, lockActive: false })).toBe('REOFFER');
    // 결제자가 보유자가 아닌 표를 다른 계정이 요청하면 찾을 수 없음으로 본다
    expect(createOfferRejectionOf(t, { callerAccountId: '0193f2c0-0000-7000-8000-0000000000c3', nowMs: NOW, lockActive: false })).toBe('NOT_HOLDER');
  });

  it('R-T17 입장 시작 뒤 양도 요청은 409 ENTRY_STARTED이고, 마감(2시간 전) 뒤는 409 TRANSFER_CLOSED다', () => {
    const t = ticket({ eventStartsAtMs: NOW - 1 });
    expect(createOfferRejectionOf(t, { callerAccountId: t.accountId, nowMs: NOW, lockActive: false })).toBe('ENTRY_STARTED');
    const closing = ticket({ eventStartsAtMs: NOW + HOUR });
    expect(createOfferRejectionOf(closing, { callerAccountId: closing.accountId, nowMs: NOW, lockActive: false })).toBe('TRANSFER_CLOSED');
    const before = ticket({ eventStartsAtMs: NOW + 3 * HOUR });
    expect(createOfferRejectionOf(before, { callerAccountId: before.accountId, nowMs: NOW, lockActive: false })).toBeUndefined();
  });

  it('R-T31 ② 잠긴 표의 양도 요청은 transfer-locked이고, 진행 중 양도·끝난 표도 거절한다', () => {
    const t = ticket();
    expect(createOfferRejectionOf(t, { callerAccountId: t.accountId, nowMs: NOW, lockActive: true })).toBe('TRANSFER_LOCKED');
    expect(createOfferRejectionOf(ticket({ transferPending: true }), { callerAccountId: t.accountId, nowMs: NOW, lockActive: false })).toBe('TRANSFER_PENDING');
    expect(createOfferRejectionOf(ticket({ status: 'REFUNDED' }), { callerAccountId: t.accountId, nowMs: NOW, lockActive: false })).toBe('ALREADY_ENDED');
  });
});

describe('받는 사람 처리', () => {
  it('R-T1 만료된 요청은 수락·거절할 수 없고, 수락한 요청은 다시 수락해도 처음 결과다', () => {
    const expired = offer({ expiresAtMs: NOW - 1 });
    expect(acceptRejectionOf(expired, { accountId: expired.toAccountId, nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR })).toBe('EXPIRED');
    expect(rejectRejectionOf(expired, { accountId: expired.toAccountId, nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR })).toBe('EXPIRED');
    const accepted = offer({ status: 'ACCEPTED' });
    expect(acceptRejectionOf(accepted, { accountId: accepted.toAccountId, nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR })).toBeUndefined();
  });

  it('R-T17 입장 시작 뒤 수락은 409 ENTRY_STARTED다', () => {
    expect(acceptRejectionOf(offer(), { accountId: offer().toAccountId, nowMs: NOW, eventStartsAtMs: NOW - 1 })).toBe('ENTRY_STARTED');
  });

  it('R-T21 ① 같은 키로 거절·철회를 두 번 해도 처음 결과를 돌려주고, 남의 요청은 404다', () => {
    const rejected = offer({ status: 'REJECTED' });
    expect(rejectRejectionOf(rejected, { accountId: rejected.toAccountId, nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR })).toBeUndefined();
    const withdrawn = offer({ status: 'WITHDRAWN' });
    expect(withdrawRejectionOf(withdrawn, { accountId: withdrawn.fromAccountId, nowMs: NOW })).toBeUndefined();
    expect(withdrawRejectionOf(offer(), { accountId: offer().toAccountId, nowMs: NOW })).toBe('NOT_SENDER');
    expect(acceptRejectionOf(offer(), { accountId: '0193f2c0-0000-7000-8000-0000000000c3', nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR })).toBe('NOT_RECIPIENT');
  });
});

describe('돌려주기', () => {
  it('R-T17 입장 시작 뒤 돌려주기는 409 ENTRY_STARTED이고, 입장 기록이 있으면 409 ENTRY_RECORDED다', () => {
    const received = ticket({ accountId: '0193f2c0-0000-7000-8000-0000000000b2' });
    expect(returnRejectionOf(received, { accountId: received.accountId, nowMs: NOW, eventStartsAtMs: NOW - 1, entryRecorded: false })).toBe('ENTRY_STARTED');
    expect(returnRejectionOf(received, { accountId: received.accountId, nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR, entryRecorded: true })).toBe('ENTRY_RECORDED');
    expect(returnRejectionOf(received, { accountId: received.accountId, nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR, entryRecorded: false })).toBeUndefined();
    expect(returnRejectionOf(ticket(), { accountId: ticket().accountId, nowMs: NOW, eventStartsAtMs: NOW + 72 * HOUR, entryRecorded: false })).toBe('PAYER_HOLDS');
  });
});

describe('받는 사람 참조(recipientRef)', () => {
  it('10분 안의 서명 참조만 받고, 만료·변조된 참조는 받지 않는다', () => {
    const ref = signRecipientRef({ secret: 'test-secret', accountId: '0193f2c0-0000-7000-8000-0000000000b2', expiresAtMs: NOW + 10 * 60_000 });
    expect(verifyRecipientRef(ref, { secret: 'test-secret', nowMs: NOW })).toBe('0193f2c0-0000-7000-8000-0000000000b2');
    expect(verifyRecipientRef(ref, { secret: 'test-secret', nowMs: NOW + 10 * 60_000 })).toBeUndefined();
    expect(verifyRecipientRef(ref, { secret: 'other', nowMs: NOW })).toBeUndefined();
    expect(verifyRecipientRef(ref.slice(0, -1) + (ref.endsWith('A') ? 'B' : 'A'), { secret: 'test-secret', nowMs: NOW })).toBeUndefined();
  });
});
